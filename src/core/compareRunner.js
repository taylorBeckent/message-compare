/**
 * 批量比对调度器
 *
 * 旧版的问题：几百条数据一次性 map 成几百个 <Collapse>，每个里面挂一个 Monaco DiffEditor。
 * Monaco 单实例初始化约 20~40ms 且吃内存，300 个实例直接把标签页干到假死。
 *
 * 这一版把「算」和「渲染」彻底分开：
 *   - 算：分片调度，每片跑满一个时间预算就让出主线程，浏览器有机会绘制进度、响应点击
 *   - 渲染：全局只有一个 Monaco 实例，谁被选中就把 model 换上去
 *   - 内存：批处理阶段只保留统计和归一化文本，昂贵的 rows 走 LRU 懒计算
 */

import { normalizePair, monacoLanguage } from './normalize';
import { computeDiff } from './diffEngine';

export const STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  IDENTICAL: 'identical',
  CHANGED: 'changed',
  MISSING: 'missing',
  ERROR: 'error'
};

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

// ---------------------------------------------------------------------------
// rows 的 LRU 缓存
// ---------------------------------------------------------------------------

const ROWS_CACHE_LIMIT = 24;
const rowsCache = new Map(); //. id -> rows（Map 天然保持插入顺序，用来做 LRU）

function rowsCacheGet(id) {
  if (!rowsCache.has(id)) return null;
  const v = rowsCache.get(id);
  //. 命中后移到末尾，最近使用的最后被淘汰
  rowsCache.delete(id);
  rowsCache.set(id, v);
  return v;
}

function rowsCacheSet(id, rows) {
  if (rowsCache.has(id)) rowsCache.delete(id);
  rowsCache.set(id, rows);
  while (rowsCache.size > ROWS_CACHE_LIMIT) {
    const oldest = rowsCache.keys().next().value;
    rowsCache.delete(oldest);
  }
}

export function clearRowsCache() {
  rowsCache.clear();
}

/**
 * 取某条记录的完整行级差异结果（懒计算 + LRU）。
 * 切换选中项时调用，单条重算通常在个位数毫秒。
 */
export function getRows(record) {
  if (!record) return [];
  const hit = rowsCacheGet(record.id);
  if (hit) return hit;

  let rows = [];
  try {
    rows = computeDiff(record.leftText || '', record.rightText || '').rows;
  } catch (e) {
    rows = [];
  }
  rowsCacheSet(record.id, rows);
  return rows;
}

// ---------------------------------------------------------------------------
// 单条比对
// ---------------------------------------------------------------------------

/**
 * 比对一条记录。直接就地写入 record —— 几百条数据的场景下，
 * 每条都新建对象再 setState 会造成大量 GC 压力，这里用「可变数据 + 版本号触发渲染」。
 */
export function compareRecord(record) {
  const t0 = now();
  record.status = STATUS.RUNNING;

  try {
    const norm = normalizePair(record);
    record.leftText = norm.leftText;
    record.rightText = norm.rightText;
    record.format = norm.format;
    record.language = monacoLanguage(norm.format);
    record.ordered = norm.ordered;
    record.notes = norm.notes;

    const result = computeDiff(norm.leftText, norm.rightText);

    //. rows 不留在记录上，只留统计与签名；需要看细节时再懒计算
    record.stats = result.stats;
    record.spark = result.spark;
    record.truncated = result.truncated;
    rowsCacheDelete(record.id);

    if (result.stats.identical) record.status = STATUS.IDENTICAL;
    else if (result.stats.oneSidedEmpty) record.status = STATUS.MISSING;
    else record.status = STATUS.CHANGED;

    record.error = null;
  } catch (e) {
    record.status = STATUS.ERROR;
    record.error = e && e.message ? e.message : String(e);
    record.stats = record.stats || { severity: 0, added: 0, removed: 0, changed: 0, leftLines: 0, rightLines: 0 };
    record.spark = '';
  }

  record.durationMs = Math.max(0, now() - t0);
  return record;
}

function rowsCacheDelete(id) {
  if (rowsCache.has(id)) rowsCache.delete(id);
}

// ---------------------------------------------------------------------------
// 分片调度
// ---------------------------------------------------------------------------

function scheduleNext(fn) {
  //. rAF 保证「绘制一帧」，setTimeout 保证「让出宏任务队列、跑掉待处理的事件」，
  //. 两个叠加才不会把进度条卡成静止画面。
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => { setTimeout(fn, 0); });
  } else {
    setTimeout(fn, 0);
  }
}

/**
 * 启动批量比对。
 *
 * @param {object}   cfg
 * @param {Array}    cfg.records     待比对记录（会被就地写入结果）
 * @param {Function} cfg.onBatch     (processedCount, total, batchRecords) => void
 * @param {Function} cfg.onComplete  ({cancelled, processed, total, elapsedMs}) => void
 * @param {number}   [cfg.frameBudget=10] 单片时间预算（毫秒）
 * @param {number}   [cfg.minBatch=1]
 * @param {number}   [cfg.maxBatch=64]
 * @returns {{cancel: Function, pause: Function, resume: Function, isPaused: Function}}
 */
export function startBatchCompare(cfg) {
  const records = cfg.records || [];
  const total = records.length;
  const budget = cfg.frameBudget == null ? 10 : cfg.frameBudget;
  const minBatch = cfg.minBatch || 1;
  const maxBatch = cfg.maxBatch || 64;

  let index = 0;
  let cancelled = false;
  let paused = false;
  let waiters = [];
  const startedAt = now();

  const api = {
    cancel() {
      cancelled = true;
    },
    pause() {
      paused = true;
    },
    resume() {
      if (!paused) return;
      paused = false;
      const w = waiters;
      waiters = [];
      w.forEach((fn) => fn());
    },
    isPaused() {
      return paused;
    },
    get processed() {
      return index;
    }
  };

  function runChunk() {
    if (cancelled) return finish(true);
    if (paused) {
      waiters.push(() => scheduleNext(runChunk));
      return;
    }

    const t0 = now();
    const batch = [];
    let count = 0;

    while (index < total) {
      const rec = records[index];
      index += 1;
      count += 1;
      try {
        compareRecord(rec);
      } catch (e) {
        rec.status = STATUS.ERROR;
        rec.error = e && e.message ? e.message : String(e);
      }
      batch.push(rec);

      //. 至少跑 minBatch 条，最多跑 maxBatch 条，或者跑满时间预算就收手
      if (count >= maxBatch) break;
      if (count >= minBatch && now() - t0 >= budget) break;
    }

    if (cfg.onBatch) cfg.onBatch(index, total, batch);

    if (index >= total) return finish(false);
    scheduleNext(runChunk);
    return undefined;
  }

  function finish(wasCancelled) {
    if (cfg.onComplete) {
      cfg.onComplete({
        cancelled: wasCancelled,
        processed: index,
        total,
        elapsedMs: now() - startedAt
      });
    }
  }

  if (total === 0) {
    finish(false);
    return api;
  }
  scheduleNext(runChunk);
  return api;
}

// ---------------------------------------------------------------------------
// 汇总统计
// ---------------------------------------------------------------------------

export function summarize(records) {
  const out = {
    total: records.length,
    identical: 0,
    changed: 0,
    missing: 0,
    error: 0,
    pending: 0,
    running: 0,
    totalAdded: 0,
    totalRemoved: 0,
    totalChangedLines: 0,
    maxSeverity: 0,
    avgDurationMs: 0
  };

  let durSum = 0;
  let durCount = 0;

  for (let i = 0; i < records.length; i += 1) {
    const r = records[i];
    switch (r.status) {
      case STATUS.IDENTICAL: out.identical += 1; break;
      case STATUS.CHANGED: out.changed += 1; break;
      case STATUS.MISSING: out.missing += 1; break;
      case STATUS.ERROR: out.error += 1; break;
      case STATUS.RUNNING: out.running += 1; break;
      default: out.pending += 1;
    }
    const s = r.stats;
    if (s) {
      out.totalAdded += s.added || 0;
      out.totalRemoved += s.removed || 0;
      out.totalChangedLines += s.changed || 0;
      if ((s.severity || 0) > out.maxSeverity) out.maxSeverity = s.severity;
    }
    if (typeof r.durationMs === 'number') {
      durSum += r.durationMs;
      durCount += 1;
    }
  }
  out.avgDurationMs = durCount > 0 ? durSum / durCount : 0;
  return out;
}
