/**
 * 报文归一化层
 *
 * 从旧版 MessageCompare/CollapseComponent/DiffPatchMonaco.jsx 里提炼出来的纯函数集合。
 * 旧实现把这些逻辑和 React 组件、setState 混在一起（validData 里直接 setOriginVal），
 * 导致三个后果：无法单测、无法在 Web Worker / 报告生成器里复用、几百条数据时
 * 每条都要走一轮 setState 触发重渲染。
 *
 * 现在全部改成「字符串进、字符串出」的纯函数，比对引擎和离线报告共用同一套。
 */

const XML_DECL_RE = /^\uFEFF?\s*<\?xml[\s\S]*?\?>/;

// ---------------------------------------------------------------------------
// 格式识别
// ---------------------------------------------------------------------------

/** 是否为合法 XML（用 DOMParser 的 parsererror 判定，和浏览器行为一致） */
export function isXmlString(str) {
  if (typeof str !== 'string') return false;
  const s = str.trim();
  if (!s || s[0] !== '<') return false;
  try {
    const doc = new DOMParser().parseFromString(str, 'text/xml');
    if (doc.getElementsByTagName('parsererror').length > 0) return false;
    const root = doc.documentElement;
    return !!root && root.nodeType === 1;
  } catch (e) {
    return false;
  }
}

/** 是否为 JSON 对象 / 数组（标量不算，避免 "123" 被当成结构化报文） */
export function isJsonString(str) {
  if (typeof str !== 'string') return false;
  const s = str.trim();
  if (!s) return false;
  if (s[0] !== '{' && s[0] !== '[') return false;
  try {
    const parsed = JSON.parse(s);
    return parsed !== null && typeof parsed === 'object';
  } catch (e) {
    return false;
  }
}

/**
 * @returns {'xml'|'json'|'text'}
 */
export function detectFormat(str) {
  if (isXmlString(str)) return 'xml';
  if (isJsonString(str)) return 'json';
  return 'text';
}

// ---------------------------------------------------------------------------
// XML 序列化
// ---------------------------------------------------------------------------

function escapeText(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '&#10;')
    .replace(/\t/g, '&#9;');
}

function attrsToString(node, sortAttrs) {
  if (!node.attributes || node.attributes.length === 0) return '';
  const list = Array.prototype.slice.call(node.attributes);
  if (sortAttrs) list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return list.map((a) => ' ' + a.name + '="' + escapeAttr(a.value || '') + '"').join('');
}

/** 元素是否只包含纯文本（可以内联成 <Tag>text</Tag>，不必展开成三行） */
function isTextOnly(node) {
  const kids = node.childNodes;
  if (!kids || kids.length === 0) return true;
  for (let i = 0; i < kids.length; i += 1) {
    const t = kids[i].nodeType;
    if (t !== 3 && t !== 4) return false;
  }
  return true;
}

function serializeNode(node, indent, unit, opts, out) {
  const type = node.nodeType;

  // 文本节点：只有在和元素混排时才会走到这里
  if (type === 3) {
    const text = (node.textContent || '').trim();
    if (text) out.push(indent + escapeText(text));
    return;
  }
  if (type === 4) {
    // CDATA
    const text = node.textContent || node.data || '';
    if (text) out.push(indent + '<![CDATA[' + text + ']]>');
    return;
  }
  if (type === 8) {
    out.push(indent + '<!--' + (node.data || '') + '-->');
    return;
  }
  if (type === 7) {
    out.push(indent + '<?' + node.target + ' ' + (node.data || '') + '?>');
    return;
  }
  if (type === 10) {
    out.push(indent + '<!' + (node.name || 'DOCTYPE') + ' ' + (node.value || '') + '>');
    return;
  }
  if (type !== 1) return;

  const open = '<' + node.tagName + attrsToString(node, opts.sortAttrs);

  if (isTextOnly(node)) {
    const inner = (node.textContent || '').replace(/\s+/g, ' ').trim();
    out.push(inner ? indent + open + '>' + escapeText(inner) + '</' + node.tagName + '>' : indent + open + ' />');
    return;
  }

  out.push(indent + open + '>');
  const kids = node.childNodes;
  for (let i = 0; i < kids.length; i += 1) {
    serializeNode(kids[i], indent + unit, unit, opts, out);
  }
  out.push(indent + '</' + node.tagName + '>');
}

/**
 * XML 美化。
 * 旧版用 xml-formatter 且缩进写成了 7 个空格（大概是手滑），这里改成 2 空格，
 * 并且去掉第三方依赖 —— 少一个包，内网离线部署少一份风险。
 */
export function formatXml(xmlString, options) {
  const opts = Object.assign({ indentation: '  ', sortAttrs: false, keepDecl: true }, options || {});

  const decl = opts.keepDecl ? extractXmlDecl(xmlString) : '';
  const doc = new DOMParser().parseFromString(xmlString, 'text/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('XML 解析失败');
  }

  const out = [];
  if (decl) out.push(decl);
  serializeNode(doc.documentElement, '', opts.indentation, opts, out);
  return out.join('\n');
}

/** 提取 <?xml ... ?> 声明（含 BOM 清理），重排后需要把它拼回去 */
export function extractXmlDecl(str) {
  if (typeof str !== 'string') return '';
  const s = str.replace(/^\uFEFF/, '').trim();
  if (s.indexOf('<?xml') !== 0) return '';
  const end = s.indexOf('?>');
  return end === -1 ? '' : s.substring(0, end + 2);
}

// ---------------------------------------------------------------------------
// JSON 序列化
// ---------------------------------------------------------------------------

export function formatJson(jsonString) {
  return JSON.stringify(JSON.parse(jsonString), null, 2);
}

// ---------------------------------------------------------------------------
// 忽略顺序：把 source 的结构重排成 template 的顺序
// ---------------------------------------------------------------------------

/**
 * 将 source 对象的键顺序 / 数组元素顺序重排为与 template 一致。
 * 「忽略顺序」比对模式下使用 —— 否则 key 顺序不同会造成满屏假差异。
 */
export function reorderJsonToMatch(source, template) {
  if (source === null || typeof source !== 'object') return source;

  if (Array.isArray(source)) {
    if (!Array.isArray(template)) return source;

    //. 数组元素重排：优先按「与某个模板元素最相似」来配对，
    //. 旧实现是按下标硬对（source[i] 对 template[i]），元素一旦错位就会整段飘红。
    const used = new Array(source.length).fill(false);
    const result = new Array(template.length);

    for (let t = 0; t < template.length; t += 1) {
      let bestIdx = -1;
      let bestScore = -1;
      for (let s = 0; s < source.length; s += 1) {
        if (used[s]) continue;
        const score = similarity(source[s], template[t]);
        if (score > bestScore) {
          bestScore = score;
          bestIdx = s;
        }
      }
      if (bestIdx >= 0 && bestScore > 0) {
        used[bestIdx] = true;
        result[t] = reorderJsonToMatch(source[bestIdx], template[t]);
      } else {
        result[t] = undefined; //. 模板里有、源里没有 → 留空位，由后续 diff 体现为缺失
      }
    }

    //. 源里多出来的元素追加在末尾
    for (let s = 0; s < source.length; s += 1) {
      if (!used[s]) result.push(source[s]);
    }
    return result.filter((v) => v !== undefined);
  }

  if (template === null || typeof template !== 'object' || Array.isArray(template)) return source;

  const out = {};
  //. 先按模板顺序输出
  Object.keys(template).forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      out[key] = reorderJsonToMatch(source[key], template[key]);
    }
  });
  //. 再补模板里没有的键
  Object.keys(source).forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = source[key];
  });
  return out;
}

/** 粗略结构相似度：用于数组元素配对，0~1 */
function similarity(a, b) {
  if (a === b) return 1;
  if (a === null || b === null) return 0;
  if (typeof a !== typeof b) return 0;
  if (typeof a !== 'object') return 0;

  const aIsArr = Array.isArray(a);
  const bIsArr = Array.isArray(b);
  if (aIsArr !== bIsArr) return 0;

  if (aIsArr) {
    const len = Math.max(a.length, b.length) || 1;
    return 1 - Math.abs(a.length - b.length) / len;
  }

  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length === 0 && kb.length === 0) return 1;

  const setB = {};
  kb.forEach((k) => { setB[k] = true; });
  let shared = 0;
  ka.forEach((k) => { if (setB[k]) shared += 1; });

  //. Jaccard 相似度 + 主键加权：报文数组通常有 id / seq 之类的主键，
  //. 主键相同基本就能确定是「同一条」，只是字段变了。
  const jaccard = shared / (ka.length + kb.length - shared || 1);
  const keyHints = ['id', 'Id', 'ID', 'seq', 'Seq', 'no', 'No', 'code', 'Code', 'key'];
  for (let i = 0; i < keyHints.length; i += 1) {
    const k = keyHints[i];
    if (Object.prototype.hasOwnProperty.call(a, k) && Object.prototype.hasOwnProperty.call(b, k)) {
      return a[k] === b[k] ? 1 : Math.max(jaccard, 0.2);
    }
  }
  return jaccard;
}

/** 将 source XML 的子元素顺序重排为与 template 一致 */
export function reorderXmlToMatch(sourceStr, templateStr, options) {
  const opts = Object.assign({ sortAttrs: true }, options || {});
  try {
    const decl = extractXmlDecl(sourceStr);
    const sourceDoc = new DOMParser().parseFromString(sourceStr, 'text/xml');
    const templateDoc = new DOMParser().parseFromString(templateStr, 'text/xml');
    if (sourceDoc.getElementsByTagName('parsererror').length) return sourceStr;
    if (templateDoc.getElementsByTagName('parsererror').length) return sourceStr;

    const elementsOf = (node) =>
      Array.prototype.filter.call(node.childNodes, (c) => c.nodeType === 1);

    const reorderChildren = (sourceNode, templateNode) => {
      if (sourceNode.nodeType !== 1 || templateNode.nodeType !== 1) return;

      const tplKids = elementsOf(templateNode);
      const srcKids = elementsOf(sourceNode);
      if (tplKids.length === 0 || srcKids.length === 0) return;

      const used = {};
      const reordered = [];

      //. 按模板顺序，从源里挑同名元素
      tplKids.forEach((tplEl) => {
        for (let s = 0; s < srcKids.length; s += 1) {
          if (!used[s] && srcKids[s].tagName === tplEl.tagName) {
            used[s] = true;
            reordered.push(srcKids[s]);
            break;
          }
        }
      });
      //. 模板里没有的，保持原相对顺序追加
      srcKids.forEach((el, s) => { if (!used[s]) reordered.push(el); });

      reordered.forEach((el) => {
        if (el.parentNode) el.parentNode.removeChild(el);
        sourceNode.appendChild(el);
      });

      //. 递归：用「当前源里的第 n 个同名元素」对「模板里的第 n 个同名元素」
      const srcNow = elementsOf(sourceNode);
      tplKids.forEach((tplEl) => {
        let seen = 0;
        for (let s = 0; s < srcNow.length; s += 1) {
          if (srcNow[s].tagName !== tplEl.tagName) continue;
          let tplSeen = 0;
          let tplTarget = null;
          for (let t = 0; t < tplKids.length; t += 1) {
            if (tplKids[t].tagName !== tplEl.tagName) continue;
            if (tplSeen === seen) { tplTarget = tplKids[t]; break; }
            tplSeen += 1;
          }
          if (tplTarget) reorderChildren(srcNow[s], tplTarget);
          seen += 1;
        }
      });
    };

    reorderChildren(sourceDoc.documentElement, templateDoc.documentElement);

    const out = [];
    if (decl) out.push(decl);
    serializeNode(sourceDoc.documentElement, '', '  ', opts, out);
    return out.join('\n');
  } catch (e) {
    return sourceStr;
  }
}

// ---------------------------------------------------------------------------
// 归一化入口
// ---------------------------------------------------------------------------

/**
 * 归一化一对报文，产出可直接进 diff 的两段文本。
 *
 * @param {object} record 原始记录，需含 left_text / right_text / datagram_field_ordered
 * @returns {{leftText:string, rightText:string, format:string, ordered:boolean, notes:string[]}}
 */
export function normalizePair(record) {
  const notes = [];
  const rawLeft = record && record.left_text != null ? String(record.left_text) : '';
  const rawRight = record && record.right_text != null ? String(record.right_text) : '';
  //. datagram_field_ordered: 0 = 忽略顺序，非 0 = 顺序敏感（沿用旧接口字段语义）
  const ordered = !(record && Number(record.datagram_field_ordered) === 0);

  const fmtLeft = detectFormat(rawLeft);
  const fmtRight = detectFormat(rawRight);

  //. 两侧格式不一致时，不做任何美化，直接按原文比对 —— 强行格式化只会制造更多假差异
  if (fmtLeft !== fmtRight) {
    if (rawLeft && rawRight) notes.push('左右两侧报文格式不一致（' + fmtLeft + ' / ' + fmtRight + '），已按原文比对');
    return { leftText: rawLeft, rightText: rawRight, format: fmtLeft === 'text' ? fmtRight : fmtLeft, ordered, notes };
  }

  if (fmtLeft === 'xml') {
    let l;
    let r;
    try {
      l = formatXml(rawLeft, { sortAttrs: !ordered });
      r = ordered
        ? formatXml(rawRight, { sortAttrs: false })
        : reorderXmlToMatch(rawRight, rawLeft, { sortAttrs: true });
    } catch (e) {
      notes.push('XML 格式化失败，已回退原文比对：' + (e && e.message ? e.message : e));
      return { leftText: rawLeft, rightText: rawRight, format: 'xml', ordered, notes };
    }
    if (!ordered) notes.push('忽略顺序：已按左侧报文重排右侧元素与属性');
    return { leftText: l, rightText: r, format: 'xml', ordered, notes };
  }

  if (fmtLeft === 'json') {
    let l;
    let r;
    try {
      const lp = JSON.parse(rawLeft);
      const rp = JSON.parse(rawRight);
      l = JSON.stringify(lp, null, 2);
      r = ordered ? JSON.stringify(rp, null, 2) : JSON.stringify(reorderJsonToMatch(rp, lp), null, 2);
    } catch (e) {
      notes.push('JSON 解析失败，已回退原文比对');
      return { leftText: rawLeft, rightText: rawRight, format: 'json', ordered, notes };
    }
    if (!ordered) notes.push('忽略顺序：已按左侧报文重排右侧键序与数组元素');
    return { leftText: l, rightText: r, format: 'json', ordered, notes };
  }

  return { leftText: rawLeft, rightText: rawRight, format: 'text', ordered, notes };
}

/** Monaco / 报告里的语言标识 */
export function monacoLanguage(format) {
  if (format === 'xml') return 'xml';
  if (format === 'json') return 'json';
  return 'plaintext';
}
