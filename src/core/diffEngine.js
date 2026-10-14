/**
 * 差异计算引擎
 *
 * 设计目标：几百条报文在主线程上分批算完，且不把浏览器卡死。
 *
 * 三个关键决策：
 * 1) 一致短路 —— 完全相同的报文直接返回空 rows，不做任何 diff 运算。
 *    真实场景里一致的比例往往过半，这一条就能省掉大部分开销。
 * 2) 行级 diff + 成对行内 diff —— 报文是结构化的，
 *    `<Amount>100.00</Amount>` 和 `<Amount>100.50</Amount>` 如果只标「整行变了」，
 *    用户还得自己拿眼睛去找哪个字符不同。所以删除/新增行会先配对，
 *    再对配对成功的行做一次词级 diff，把真正变化的片段高亮出来。
 * 3) 交错输出 —— git 默认「先所有删除行、再所有新增行」，
 *    但报文比对里字段是成对出现的，交错输出（删一行紧跟增一行）
 *    阅读时视线不用来回跳。这是刻意偏离 git 习惯的选择。
 */

import { diffLines, diffWordsWithSpace } from 'diff';

export const ROW_CTX = 'c';
export const ROW_ADD = '+';
export const ROW_DEL = '-';

/** 超过这个行数就不再做词级 diff，避免 O(N*D) 爆炸 */
const WORD_DIFF_MAX_LINE_LEN = 400;
/** 超过这个总行数，只保留行级结果 */
const WORD_DIFF_MAX_ROWS = 6000;
/** 单侧行数上限，超出直接截断并标记（防御异常报文） */
const HARD_LINE_LIMIT = 20000;

/**
 * 计算差异。
 *
 * @param {string} leftText  已归一化的左侧文本
 * @param {string} rightText 已归一化的右侧文本
 * @returns {{
 *   rows: Array<{t:string, l:number|null, r:number|null, s:string, g?:Array}>,
 *   stats: object,
 *   spark: string,
 *   truncated: boolean
 * }}
 */
export function computeDiff(leftText, rightText) {
  const left = leftText == null ? '' : leftText;
  const right = rightText == null ? '' : rightText;

  const leftLines = splitLines(left);
  const rightLines = splitLines(right);

  let truncated = false;
  let ls = leftLines;
  let rs = rightLines;
  if (ls.length > HARD_LINE_LIMIT || rs.length > HARD_LINE_LIMIT) {
    truncated = true;
    ls = ls.slice(0, HARD_LINE_LIMIT);
    rs = rs.slice(0, HARD_LINE_LIMIT);
  }

  const base = {
    leftLines: ls.length,
    rightLines: rs.length,
    truncated
  };

  // ---- 一致短路 -----------------------------------------------------------
  if (left === right) {
    const rows = ls.map((s, i) => ({ t: ROW_CTX, l: i + 1, r: i + 1, s }));
    return {
      rows,
      stats: Object.assign(base, {
        added: 0,
        removed: 0,
        changed: 0,
        context: ls.length,
        severity: 0,
        identical: true
      }),
      spark: repeat('0', Math.min(ls.length, 4000)),
      truncated
    };
  }

  // ---- 单侧为空 -----------------------------------------------------------
  if (ls.length === 0 || rs.length === 0) {
    const rows = [];
    const side = ls.length === 0 ? ROW_ADD : ROW_DEL;
    const arr = ls.length === 0 ? rs : ls;
    for (let i = 0; i < arr.length; i += 1) {
      rows.push(
        side === ROW_ADD
          ? { t: ROW_ADD, l: null, r: i + 1, s: arr[i] }
          : { t: ROW_DEL, l: i + 1, r: null, s: arr[i] }
      );
    }
    return {
      rows,
      stats: Object.assign(base, {
        added: side === ROW_ADD ? rs.length : 0,
        removed: side === ROW_DEL ? ls.length : 0,
        changed: 0,
        context: 0,
        severity: 1,
        identical: false,
        oneSidedEmpty: true
      }),
      spark: repeat(side === ROW_ADD ? '+' : '-', Math.min(rows.length, 4000)),
      truncated
    };
  }

  // ---- 主体：行级 diff ----------------------------------------------------
  const parts = diffLines(left, right, { newlineIsToken: false });

  const rows = [];
  let lNo = 0;
  let rNo = 0;
  let added = 0;
  let removed = 0;
  let changedPairs = 0;
  let context = 0;

  //. 暂存待配对的删除行 / 新增行
  let pendingDel = [];
  let pendingAdd = [];

  const flush = () => {
    if (pendingDel.length === 0 && pendingAdd.length === 0) return;

    const paired = Math.min(pendingDel.length, pendingAdd.length);
    const allowWordDiff =
      paired > 0 &&
      rows.length < WORD_DIFF_MAX_ROWS &&
      pendingDel.every((s) => s.length <= WORD_DIFF_MAX_LINE_LEN) &&
      pendingAdd.every((s) => s.length <= WORD_DIFF_MAX_LINE_LEN);

    for (let i = 0; i < Math.max(pendingDel.length, pendingAdd.length); i += 1) {
      const d = i < pendingDel.length ? pendingDel[i] : null;
      const a = i < pendingAdd.length ? pendingAdd[i] : null;

      //. 交错输出：删一行紧跟增一行，成对出现时视线不用来回跳
      if (d !== null) {
        lNo += 1;
        removed += 1;
        const row = { t: ROW_DEL, l: lNo, r: null, s: d };
        if (allowWordDiff && i < paired) row.g = intraSegments(d, a, ROW_DEL);
        rows.push(row);
      }
      if (a !== null) {
        rNo += 1;
        added += 1;
        const row = { t: ROW_ADD, l: null, r: rNo, s: a };
        if (allowWordDiff && i < paired) row.g = intraSegments(a, d, ROW_ADD);
        rows.push(row);
      }
      if (i < paired) changedPairs += 1;
    }

    pendingDel = [];
    pendingAdd = [];
  };

  for (let p = 0; p < parts.length; p += 1) {
    const part = parts[p];
    const lines = splitLines(part.value);

    if (part.added) {
      for (let i = 0; i < lines.length; i += 1) pendingAdd.push(lines[i]);
    } else if (part.removed) {
      for (let i = 0; i < lines.length; i += 1) pendingDel.push(lines[i]);
    } else {
      flush();
      for (let i = 0; i < lines.length; i += 1) {
        lNo += 1;
        rNo += 1;
        context += 1;
        rows.push({ t: ROW_CTX, l: lNo, r: rNo, s: lines[i] });
      }
    }
  }
  flush();

  //. 严重度：(增 + 删) / (左行数 + 右行数)，完全不相干时为 1，完全一致时为 0
  const denom = ls.length + rs.length;
  const severity = denom > 0 ? clamp01((added + removed) / denom) : 0;

  return {
    rows,
    stats: {
      leftLines: ls.length,
      rightLines: rs.length,
      added,
      removed,
      changed: changedPairs,
      context,
      severity,
      identical: false,
      truncated
    },
    spark: buildSpark(rows),
    truncated
  };
}

function splitLines(text) {
  if (!text) return [];
  //. 报文里常见 \r\n，统一掉，否则 diff 会把每一行都判成不同
  const arr = text.replace(/\r\n?/g, '\n').split('\n');
  //. diffLines 给出的 part.value 通常以 \n 结尾（"a\nb\n"），
  //. 直接 split 会多出一个尾部空串，凭空造出一对「空行差异」，
  //. 统计上也会让 context + removed != leftLines。这里把这个哨兵位去掉，
  //. 而中间真实的空行（"a\n\nb"）会被完整保留。
  if (arr.length > 1 && arr[arr.length - 1] === '') arr.pop();
  return arr;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function repeat(ch, n) {
  if (n <= 0) return '';
  let out = '';
  for (let i = 0; i < n; i += 1) out += ch;
  return out;
}

/**
 * 行内片段高亮。
 * @param {string} target 当前行
 * @param {string} other  配对的另一侧行
 * @param {string} side   当前行属于哪一侧（决定取 added 还是 removed 片段）
 * @returns {Array<[string, 0|1]>} [文本, 是否变化]
 */
function intraSegments(target, other, side) {
  try {
    //. 顺序固定为 (左, 右)，这样两侧的片段划分是同一套坐标系
    const a = side === ROW_DEL ? target : other;
    const b = side === ROW_DEL ? other : target;
    const parts = diffWordsWithSpace(a, b);
    const out = [];
    for (let i = 0; i < parts.length; i += 1) {
      const p = parts[i];
      const isMine = side === ROW_DEL ? !!p.removed : !!p.added;
      const isOther = side === ROW_DEL ? !!p.added : !!p.removed;
      //. 未变化的片段属于双方；变化的片段只属于对应的一侧
      if (!isMine && !isOther) {
        out.push([p.value, 0]);
      } else if (isMine) {
        out.push([p.value, 1]);
      }
    }
    return out.length > 0 ? out : null;
  } catch (e) {
    return null;
  }
}

/** 生成迷你条带签名：'0' 一致 / '+' 新增 / '-' 删除 */
function buildSpark(rows) {
  const cap = 4000;
  let out = '';
  for (let i = 0; i < rows.length && i < cap; i += 1) {
    const t = rows[i].t;
    out += t === ROW_CTX ? '0' : t === ROW_ADD ? '+' : '-';
  }
  return out;
}

// ---------------------------------------------------------------------------
// 视图辅助
// ---------------------------------------------------------------------------

/**
 * 把完整 rows 折叠成「变更块 + 上下文」的显示序列。
 *
 * 几百条报文里，一条可能有几千行但只有 3 处改动。
 * 全量渲染既慢又找不到重点，所以按 hunk 折叠，中间用 gap 占位。
 *
 * @param {Array} rows computeDiff 产出的行
 * @param {number} context 每个变更块上下保留的行数
 * @param {boolean} expandAll true 时不折叠（Monaco 精确模式下用）
 */
export function buildHunkView(rows, context, expandAll) {
  const ctx = context == null ? 3 : context;
  if (expandAll || rows.length === 0) return rows.slice();

  const keep = new Uint8Array(rows.length);
  let hasChange = false;

  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].t === ROW_CTX) continue;
    hasChange = true;
    const from = Math.max(0, i - ctx);
    const to = Math.min(rows.length - 1, i + ctx);
    for (let k = from; k <= to; k += 1) keep[k] = 1;
  }

  //. 全一致的报文：只展示前若干行，剩下的折叠掉
  if (!hasChange) {
    const head = Math.min(rows.length, 12);
    const view = rows.slice(0, head);
    if (rows.length > head) view.push({ t: 'gap', n: rows.length - head });
    return view;
  }

  const view = [];
  let skipped = 0;
  for (let i = 0; i < rows.length; i += 1) {
    if (keep[i]) {
      if (skipped > 0) {
        view.push({ t: 'gap', n: skipped });
        skipped = 0;
      }
      view.push(rows[i]);
    } else {
      skipped += 1;
    }
  }
  if (skipped > 0) view.push({ t: 'gap', n: skipped });
  return view;
}

/**
 * buildHunkView 的「带位置」版本。
 *
 * buildHunkView 产出的 gap 只有一个行数 n，看不到它盖住了 rows 的哪一段，
 * 所以没法做「点开某一处折叠」的交互。这里让 gap 自己带上 [from, to)，
 * 渲染层就能按需把某一段展开，而不用重算整个视图。
 *
 * @param {Array} rows
 * @param {number} context
 * @param {boolean} expandAll
 * @param {Object} [openGaps] 形如 { '3-17': true }，键由 gap 的 from-to 组成
 * @returns {Array} 元素要么是 rows 里的行，要么是 {t:'gap', n, from, to, key}
 */
export function buildHunkViewWithGaps(rows, context, expandAll, openGaps) {
  const ctx = context == null ? 3 : context;
  const total = rows.length;
  if (total === 0) return [];
  if (expandAll) return rows.slice();

  const keep = new Uint8Array(total);
  let hasChange = false;
  for (let i = 0; i < total; i += 1) {
    if (rows[i].t === ROW_CTX) continue;
    hasChange = true;
    const from = i - ctx < 0 ? 0 : i - ctx;
    const to = i + ctx > total - 1 ? total - 1 : i + ctx;
    for (let k = from; k <= to; k += 1) keep[k] = 1;
  }

  //. 全一致：保留开头一段，其余折成一个 gap（依然可展开）
  if (!hasChange) {
    const head = total < 12 ? total : 12;
    const view = rows.slice(0, head);
    if (total > head) {
      view.push(makeGap(rows, head, total, openGaps));
    }
    return flattenGap(rows, view, openGaps);
  }

  const view = [];
  let skippedFrom = -1;
  for (let i = 0; i < total; i += 1) {
    if (keep[i]) {
      if (skippedFrom >= 0) {
        view.push(makeGap(rows, skippedFrom, i, openGaps));
        skippedFrom = -1;
      }
      view.push(rows[i]);
    } else if (skippedFrom < 0) {
      skippedFrom = i;
    }
  }
  if (skippedFrom >= 0) view.push(makeGap(rows, skippedFrom, total, openGaps));

  return flattenGap(rows, view, openGaps);
}

function makeGap(rows, from, to, openGaps) {
  const key = from + '-' + to;
  return { t: 'gap', n: to - from, from, to, key, open: !!(openGaps && openGaps[key]) };
}

/** 把标记为 open 的 gap 就地换成它盖住的真实行 */
function flattenGap(rows, view, openGaps) {
  if (!openGaps) return view;
  const out = [];
  for (let i = 0; i < view.length; i += 1) {
    const it = view[i];
    if (it.t === 'gap' && it.open) {
      for (let k = it.from; k < it.to; k += 1) out.push(rows[k]);
    } else {
      out.push(it);
    }
  }
  return out;
}

/** 所有变更行的下标，用于「跳到下一处差异」 */
export function changeIndices(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].t !== ROW_CTX) out.push(i);
  }
  return out;
}
