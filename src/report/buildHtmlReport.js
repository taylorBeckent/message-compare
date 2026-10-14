/**
 * 单文件自包含 HTML 报告生成器
 *
 * 旧版下载走的是「拼一段 HTML + 从内网 CDN 加载 Monaco」，
 * 一旦离开那张内网，报告打开就是一片空白 —— 归档文件失去意义。
 * 这一版的要求是：产出的 .html 拷到任何一台机器、断网双击，都能看。
 *
 * 为此报告里内联了三样东西：
 *   1) lz-string        —— 解压数据（几百条报文的原文，压完能小 3~5 倍）
 *   2) diff 5.1.0 UMD   —— 行级 / 词级差异算法
 *   3) diffEngine.js    —— 和控制台**同一份**源码，构建时原样内联
 *
 * 第 3 点是关键取舍。报告完全可以只带一份预计算好的差异结果，
 * 但那样文件会大好几倍，而且报告里的 diff 逻辑就成了控制台的第二份实现，迟早对不上。
 * 这里改成只带「归一化后的原文」，打开报告时按需现算：
 * 用户一次只看一条，现算的成本是几毫秒，换来的是体积可控 + 逻辑唯一。
 *
 * 为了让 diffEngine.js 能在没有打包器的环境里跑，构建时用 DefinePlugin
 * 把它的源码作为字符串常量注入，这里再做一次极小的语法降级
 * （去掉 import、export 改成 var/function）。转换失败会直接抛错，不会静默产出坏报告。
 */

/* global __VENDOR_DIFF_JS__, __VENDOR_LZSTRING_JS__, __SRC_DIFF_ENGINE_JS__ */

import LZString from 'lz-string';

// ---------------------------------------------------------------------------
// 源码内联与降级
// ---------------------------------------------------------------------------

const IMPORT_RE = /^[ \t]*import\s*\{[^}]*\}\s*from\s*['"]diff['"];?[ \t]*$/m;

function escapeScript(src) {
  //. 内联进 <script> 的源码里只要出现 </script 就会提前闭合标签
  return src.replace(/<\/script/gi, '<\\/script');
}

/**
 * 把 diffEngine.js 的 ESM 源码降级成浏览器可直接执行的脚本。
 * 只做三件事：换掉 import、去掉 export 前缀、挂到全局。
 */
export function inlineEngineSource(src) {
  if (typeof src !== 'string' || src.indexOf('export function computeDiff') < 0) {
    throw new Error('diffEngine 源码不符合预期，无法内联到报告');
  }
  if (!IMPORT_RE.test(src)) {
    throw new Error('diffEngine 的 import 语句未被识别，内联会残留 ESM 语法');
  }

  const out = src
    .replace(
      IMPORT_RE,
      'var diffLines = Diff.diffLines;\nvar diffWordsWithSpace = Diff.diffWordsWithSpace;'
    )
    .replace(/^export\s+function\s+/gm, 'function ')
    .replace(/^export\s+const\s+/gm, 'var ');

  if (/^export\s/m.test(out)) {
    throw new Error('diffEngine 降级后仍残留 export 语句');
  }

  return (
    out +
    '\nwindow.MCDiff = {' +
    'computeDiff: computeDiff,' +
    'buildHunkViewWithGaps: buildHunkViewWithGaps,' +
    'changeIndices: changeIndices,' +
    'ROW_CTX: ROW_CTX' +
    '};\n'
  );
}

// ---------------------------------------------------------------------------
// 数据打包
// ---------------------------------------------------------------------------

/**
 * 把控制台里的记录压成报告用的紧凑结构。
 * 键名刻意压到 1~2 个字符：800 条记录下，光是键名就能省下几十 KB。
 */
export function buildReportPayload(cfg) {
  const records = (cfg.records || []).map((r, i) => {
    const st = r.stats || {};
    return {
      i: i,
      q: r.seq,
      ln: r.left_name || '',
      rn: r.right_name || '',
      s: r.status || 'pending',
      a: st.added || 0,
      d: st.removed || 0,
      v: st.severity || 0,
      ll: st.leftLines || 0,
      rl: st.rightLines || 0,
      m: r.mutation || '',
      b: r.bizLabel || '',
      n: r.notes && r.notes.length ? r.notes : null,
      e: r.error || null,
      L: r.leftText == null ? '' : r.leftText,
      R: r.rightText == null ? '' : r.rightText
    };
  });

  const summary = cfg.summary || {};

  return {
    v: 1,
    title: cfg.title || '报文批量比对报告',
    group: cfg.groupName || '',
    desc: cfg.groupDesc || '',
    at: cfg.generatedAt || new Date().toLocaleString('zh-CN'),
    scope: cfg.scopeLabel || '',
    sum: {
      total: records.length,
      identical: summary.identical || 0,
      changed: summary.changed || 0,
      missing: summary.missing || 0,
      error: summary.error || 0,
      added: summary.totalAdded || 0,
      removed: summary.totalRemoved || 0,
      maxSev: summary.maxSeverity || 0,
      elapsed: cfg.elapsedMs || 0
    },
    recs: records
  };
}

/** 估算产物大小。导出前先给用户看，避免「等了半天下了个 40MB」 */
export function estimateReportSize(payload) {
  const json = JSON.stringify(payload);
  const compressed = LZString.compressToBase64(json);
  const overhead =
    (typeof __VENDOR_DIFF_JS__ === 'string' ? __VENDOR_DIFF_JS__.length : 0) +
    (typeof __VENDOR_LZSTRING_JS__ === 'string' ? __VENDOR_LZSTRING_JS__.length : 0) +
    (typeof __SRC_DIFF_ENGINE_JS__ === 'string' ? __SRC_DIFF_ENGINE_JS__.length : 0) +
    26000; //. CSS + 报告自身的 JS
  return { rawJson: json.length, compressed: compressed.length, total: compressed.length + overhead, compressed };
}

export function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

// ---------------------------------------------------------------------------
// 报告样式（与控制台同一套配色，深色仪表盘 + 19px 等宽行）
// ---------------------------------------------------------------------------

const REPORT_CSS = [
  '*{box-sizing:border-box}',
  'html,body{margin:0;padding:0;height:100%}',
  'body{background:#0b0e13;color:#e8edf4;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-size:13px;line-height:1.55;overflow:hidden}',
  '.mono{font-family:"JetBrains Mono","SFMono-Regular",Menlo,Consolas,"Liberation Mono",monospace;font-variant-numeric:tabular-nums}',
  '#app{height:100%;display:grid;grid-template-rows:auto auto minmax(0,1fr)}',
  'button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid #35c2a5;outline-offset:1px}',

  '.rp-top{padding:14px 18px 12px;border-bottom:1px solid rgba(255,255,255,.065);background:rgba(19,25,34,.6)}',
  '.rp-title{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}',
  '.rp-title h1{margin:0;font-size:16px;font-weight:600;letter-spacing:.01em}',
  '.rp-title .tag{font-size:11px;color:#616d7c}',
  '.rp-sub{margin-top:4px;font-size:11px;color:#616d7c;display:flex;gap:14px;flex-wrap:wrap}',
  '.rp-tools{display:flex;gap:8px;margin-top:11px;align-items:center;flex-wrap:wrap}',
  '.rp-chips{display:flex;gap:6px;align-items:center;flex-wrap:wrap}',
  '.rp-chip{display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:4px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);font-size:11px;color:#98a5b6;cursor:pointer;font-family:inherit}',
  '.rp-chip:hover{background:rgba(255,255,255,.08);color:#e8edf4}',
  '.rp-chip.on{border-color:rgba(53,194,165,.5);background:rgba(53,194,165,.12);color:#e8edf4}',
  '.rp-chip b{font-family:"JetBrains Mono",Menlo,monospace;font-size:13px;font-weight:600}',
  '.rp-chip i{width:6px;height:6px;border-radius:50%;display:inline-block}',
  '.rp-chip.plain{cursor:default}',
  '.rp-search{flex:1 1 180px;min-width:150px;max-width:280px;margin-left:auto;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.09);border-radius:4px;color:#e8edf4;font-size:12px;padding:4px 9px;font-family:inherit}',

  '.rp-heat{padding:10px 18px;border-bottom:1px solid rgba(255,255,255,.065);background:rgba(14,18,24,.5);display:flex;gap:14px;align-items:center}',
  '.rp-heat canvas{display:block;cursor:crosshair;border-radius:4px;background:rgba(0,0,0,.28);flex:1 1 auto}',
  '.rp-heat .cap{flex:0 0 auto;font-size:10px;color:#454f5c;letter-spacing:.09em;text-transform:uppercase}',
  '.rp-ramp{flex:0 0 140px}',
  '.rp-ramp canvas{display:block;border-radius:2px;cursor:default}',
  '.rp-ramp .lb{display:flex;justify-content:space-between;font-size:9px;color:#454f5c;font-family:"JetBrains Mono",Menlo,monospace;margin-top:3px}',

  '.rp-body{display:grid;grid-template-columns:330px minmax(0,1fr);min-height:0}',
  '.rp-lcol{display:flex;flex-direction:column;min-height:0;border-right:1px solid rgba(255,255,255,.065);background:rgba(19,25,34,.42)}',
  '.rp-lhead{flex:0 0 auto;padding:7px 12px;border-bottom:1px solid rgba(255,255,255,.065);font-size:10px;letter-spacing:.11em;text-transform:uppercase;color:#616d7c;display:flex;justify-content:space-between}',
  '.rp-list{flex:1 1 auto;overflow:auto}',
  '.rp-item{display:flex;align-items:center;gap:9px;padding:7px 10px 7px 12px;border-bottom:1px solid rgba(255,255,255,.035);cursor:pointer;position:relative}',
  '.rp-item:hover{background:rgba(255,255,255,.035)}',
  '.rp-item.on{background:rgba(53,194,165,.1)}',
  '.rp-item.on:before{content:"";position:absolute;left:0;top:0;bottom:0;width:2px;background:#35c2a5}',
  '.rp-item .q{flex:0 0 34px;text-align:right;font-size:11px;color:#454f5c}',
  '.rp-item .mid{flex:1 1 auto;min-width:0}',
  '.rp-item .nm{font-size:11px;color:#98a5b6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.rp-item .mt{font-size:10px;color:#616d7c;display:flex;gap:7px;margin-top:2px;white-space:nowrap}',
  '.rp-item .bar{flex:0 0 46px;height:11px;position:relative;background:rgba(255,255,255,.04);border-radius:2px;overflow:hidden}',
  '.rp-item .bar u{position:absolute;top:0;bottom:0;display:block}',
  '.rp-empty{padding:40px 20px;text-align:center;color:#616d7c;font-size:12px;line-height:1.9}',

  '.rp-view{display:flex;flex-direction:column;min-width:0;min-height:0}',
  '.rp-vhead{flex:0 0 auto;display:flex;align-items:center;gap:12px;padding:8px 14px;border-bottom:1px solid rgba(255,255,255,.065);background:rgba(24,32,43,.4);min-height:42px;flex-wrap:wrap}',
  '.rp-vhead .seq{font-size:15px;font-weight:600;color:#35c2a5}',
  '.rp-vhead .names{font-size:12px;color:#98a5b6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:38ch}',
  '.rp-vhead .names em{font-style:normal;color:#454f5c;margin:0 6px;font-size:10px}',
  '.rp-sp{flex:1 1 auto}',
  '.rp-kv{font-size:11px;color:#616d7c;display:flex;gap:5px;align-items:center}',
  '.rp-kv b{font-weight:500;color:#98a5b6}',
  '.rp-btn{background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.09);color:#98a5b6;font-size:11px;padding:3px 9px;border-radius:3px;cursor:pointer;font-family:inherit}',
  '.rp-btn:hover{color:#e8edf4;border-color:rgba(255,255,255,.16)}',
  '.rp-btn.on{color:#35c2a5;border-color:rgba(53,194,165,.45);background:rgba(53,194,165,.1)}',
  '.rp-notes{flex:0 0 auto;padding:6px 14px;font-size:11px;color:#8b95a5;background:rgba(91,141,184,.08);border-bottom:1px solid rgba(255,255,255,.05)}',
  '.rp-notes.bad{color:#f0938c;background:rgba(224,87,79,.09)}',

  '.rp-diff{flex:1 1 auto;overflow:auto;font-family:"JetBrains Mono","SFMono-Regular",Menlo,Consolas,monospace;font-size:12px;line-height:19px;background:rgba(11,14,19,.34)}',
  '.rp-diff .in{min-width:100%;width:max-content;padding-bottom:30vh}',
  '.rp-r{display:flex;align-items:stretch;min-width:100%;white-space:pre}',
  '.rp-r:hover{filter:brightness(1.16)}',
  '.rp-r.add{background:rgba(79,157,105,.13)}',
  '.rp-r.add .sg{color:#4f9d69}',
  '.rp-r.add .cd{color:#8ed7a6}',
  '.rp-r.del{background:rgba(224,87,79,.12)}',
  '.rp-r.del .sg{color:#e0574f}',
  '.rp-r.del .cd{color:#f0938c;opacity:.9}',
  '.rp-no{flex:0 0 auto;width:46px;padding-right:7px;text-align:right;color:#454f5c;font-size:11px;user-select:none;background:rgba(0,0,0,.2);border-right:1px solid rgba(255,255,255,.04)}',
  '.rp-sg{flex:0 0 auto;width:16px;text-align:center;color:#454f5c;user-select:none}',
  '.rp-cd{flex:1 1 auto;padding:0 12px 0 6px;color:#98a5b6;white-space:pre}',
  '.rp-mk{background:rgba(79,157,105,.34);border-radius:2px;box-shadow:0 0 0 1px rgba(255,255,255,.06)}',
  '.rp-r.del .rp-mk{background:rgba(224,87,79,.32)}',
  '.rp-gap{display:flex;align-items:center;gap:8px;height:19px;padding:0 12px;color:#454f5c;font-size:11px;background:rgba(255,255,255,.022);border-top:1px dashed rgba(255,255,255,.07);border-bottom:1px dashed rgba(255,255,255,.07);cursor:pointer;user-select:none;white-space:nowrap}',
  '.rp-gap:hover{color:#98a5b6;background:rgba(53,194,165,.07)}',
  '.rp-gap:after{content:"";flex:1 1 auto;height:1px;background:repeating-linear-gradient(90deg,rgba(255,255,255,.09) 0 3px,transparent 3px 6px)}',
  '.rp-more{padding:12px;text-align:center}',
  '.rp-state{flex:1 1 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:#616d7c;text-align:center;padding:40px}',
  '.rp-state .t{font-size:14px;color:#98a5b6}',
  '.rp-state .d{font-size:12px;line-height:1.8;max-width:46ch}',

  '.rp-list,.rp-diff{scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.16) transparent}',
  '.rp-list::-webkit-scrollbar,.rp-diff::-webkit-scrollbar{width:9px;height:9px}',
  '.rp-list::-webkit-scrollbar-thumb,.rp-diff::-webkit-scrollbar-thumb{background:rgba(255,255,255,.14);border-radius:5px;border:2px solid transparent;background-clip:content-box}',

  //. 打印 / 另存 PDF：只打当前这条记录，浅色化保证纸面可读
  '@media print{body{overflow:visible;background:#fff;color:#111}',
  '#app{display:block;height:auto}.rp-list,.rp-heat,.rp-tools,.rp-lcol{display:none}',
  '.rp-body{display:block}.rp-view{height:auto}.rp-diff{overflow:visible;background:#fff}',
  '.rp-r.add{background:#e6f4ea}.rp-r.del{background:#fdecea}',
  '.rp-r.add .cd{color:#116329}.rp-r.del .cd{color:#a02318}',
  '.rp-cd,.rp-no,.rp-sg{color:#333}.rp-top{background:#fff;border-color:#ccc}}'
].join('\n');

// ---------------------------------------------------------------------------
// 报告脚本（ES5，不用箭头函数 / 模板字符串：内网老 Chrome 也能跑）
// ---------------------------------------------------------------------------

const REPORT_JS = [
  '(function () {',
  '  "use strict";',
  '',
  '  var PAYLOAD = JSON.parse(LZString.decompressFromBase64(window.__MC_DATA__));',
  '  var RECS = PAYLOAD.recs;',
  '  var SUM = PAYLOAD.sum;',
  '',
  '  var STATUS = {',
  '    pending: { c: "#2a323d", t: "待比对" },',
  '    running: { c: "#35c2a5", t: "比对中" },',
  '    identical: { c: "#2e5a4e", t: "一致" },',
  '    changed: { c: "#d9a441", t: "有差异" },',
  '    missing: { c: "#5b8db8", t: "单侧为空" },',
  '    error: { c: "#8b95a5", t: "异常" }',
  '  };',
  '',
  '  //. 与控制台 palette.js 的 SEVERITY_STOPS 完全一致。',
  '  //. 两边共用同一组数字，同一条记录在界面和报告里才是同一个颜色。',
  '  var STOPS = [',
  '    [0.0, 46, 90, 78], [0.1, 63, 122, 94], [0.3, 138, 154, 74],',
  '    [0.5, 217, 164, 65], [0.72, 224, 122, 69], [1.0, 224, 87, 79]',
  '  ];',
  '',
  '  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }',
  '  function smooth(a, b, x) { var t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); }',
  '  function ramp(t) {',
  '    t = clamp01(t);',
  '    for (var i = 0; i < STOPS.length - 1; i++) {',
  '      var A = STOPS[i], B = STOPS[i + 1];',
  '      if (t >= A[0] && t <= B[0]) {',
  '        var k = smooth(A[0], B[0], t);',
  '        return [Math.round(A[1] + (B[1] - A[1]) * k), Math.round(A[2] + (B[2] - A[2]) * k), Math.round(A[3] + (B[3] - A[3]) * k)];',
  '      }',
  '    }',
  '    var L = STOPS[STOPS.length - 1];',
  '    return [L[1], L[2], L[3]];',
  '  }',
  '  function css(t, a) { var c = ramp(t); return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + (a == null ? 1 : a) + ")"; }',
  '  //. 感知曲线：真实报文的差异率集中在低位，线性映射会让整张图一片深绿',
  '  function sevT(ratio) { return Math.pow(clamp01(ratio), 0.4); }',
  '',
  '  function $(id) { return document.getElementById(id); }',
  '  function el(tag, cls, txt) {',
  '    var n = document.createElement(tag);',
  '    if (cls) n.className = cls;',
  '    if (txt != null) n.textContent = txt;',
  '    return n;',
  '  }',
  '',
  '  // ---- 状态 ----------------------------------------------------------',
  '  var filter = "all";',
  '  var query = "";',
  '  var expandAll = false;',
  '  var context = 3;',
  '  var selI = -1;          //. 选中记录在 RECS 里的下标（跨筛选稳定，用视图下标会漂）',
  '  var view = [];          //. 当前筛选后的记录',
  '  var rowNodes = [];      //. 列表行 DOM，用于只改 class 就完成选中态切换',
  '  var diffCache = {};     //. 报告通常只看一遍，缓存不做淘汰',
  '  var openGaps = {};',
  '  var PAGE = 1200;',
  '  var limit = PAGE;',
  '  var heatGeom = null;',
  '',
  '  function viewIndexOfSel() {',
  '    for (var i = 0; i < view.length; i++) if (view[i].i === selI) return i;',
  '    return -1;',
  '  }',
  '',
  '  function matches(r) {',
  '    if (filter !== "all") {',
  '      if (filter === "diff") { if (r.s !== "changed") return false; }',
  '      else if (r.s !== filter) return false;',
  '    }',
  '    if (query) {',
  '      var hay = (r.q + " " + r.ln + " " + r.rn + " " + (r.b || "")).toLowerCase();',
  '      if (hay.indexOf(query) < 0) return false;',
  '    }',
  '    return true;',
  '  }',
  '',
  '  function applyFilter() {',
  '    view = [];',
  '    for (var i = 0; i < RECS.length; i++) if (matches(RECS[i])) view.push(RECS[i]);',
  '    //. 选中的记录被筛掉了就落到第一条，否则右侧会显示一个不在列表里的东西',
  '    if (viewIndexOfSel() < 0) selI = view.length ? view[0].i : -1;',
  '    openGaps = {};',
  '    limit = PAGE;',
  '    renderHead();',
  '    renderList();',
  '    renderHeat();',
  '    renderView();',
  '  }',
  '',
  '  // ---- 报头 ----------------------------------------------------------',
  '  function renderHead() {',
  '    $("t-title").textContent = PAYLOAD.title;',
  '    $("t-group").textContent = PAYLOAD.group;',
  '    $("t-at").textContent = "生成于 " + PAYLOAD.at;',
  '    $("t-scope").textContent = PAYLOAD.scope ? "范围：" + PAYLOAD.scope : "";',
  '    $("t-meta").textContent = SUM.total + " 条 · 增 " + SUM.added + " 行 / 删 " + SUM.removed +',
  '      " 行 · 峰值严重度 " + (SUM.maxSev * 100).toFixed(1) + "%";',
  '',
  '    var box = $("chips");',
  '    box.innerHTML = "";',
  '    var defs = [',
  '      { k: "all", n: SUM.total, t: "全部", c: null },',
  '      { k: "diff", n: SUM.changed, t: "有差异", c: STATUS.changed.c },',
  '      { k: "identical", n: SUM.identical, t: "一致", c: STATUS.identical.c },',
  '      { k: "missing", n: SUM.missing, t: "单侧空", c: STATUS.missing.c },',
  '      { k: "error", n: SUM.error, t: "异常", c: STATUS.error.c }',
  '    ];',
  '    for (var i = 0; i < defs.length; i++) {',
  '      (function (d) {',
  '        var b = el("button", "rp-chip" + (filter === d.k ? " on" : ""));',
  '        b.type = "button";',
  '        if (d.c) { var dot = el("i"); dot.style.background = d.c; b.appendChild(dot); }',
  '        var num = el("b", null, String(d.n));',
  '        if (d.c) num.style.color = d.c;',
  '        b.appendChild(num);',
  '        b.appendChild(el("span", null, d.t));',
  '        b.onclick = function () { filter = (filter === d.k && d.k !== "all") ? "all" : d.k; applyFilter(); };',
  '        box.appendChild(b);',
  '      })(defs[i]);',
  '    }',
  '    var cnt = el("span", "rp-chip plain");',
  '    cnt.appendChild(el("b", null, String(view.length)));',
  '    cnt.appendChild(el("span", null, "当前显示"));',
  '    box.appendChild(cnt);',
  '  }',
  '',
  '  // ---- 热力矩阵 ------------------------------------------------------',
  '  function renderHeat() {',
  '    var cv = $("heat");',
  '    var host = cv.parentNode;',
  '    var w = Math.max(120, host.clientWidth - 4);',
  '    var h = 62;',
  '    var dpr = Math.min(window.devicePixelRatio || 1, 2);',
  '    cv.width = Math.round(w * dpr);',
  '    cv.height = Math.round(h * dpr);',
  '    cv.style.width = w + "px";',
  '    cv.style.height = h + "px";',
  '    var ctx = cv.getContext("2d");',
  '    if (!ctx) return;',
  '    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);',
  '    ctx.clearRect(0, 0, w, h);',
  '    heatGeom = null;',
  '',
  '    var n = view.length;',
  '    if (n === 0) return;',
  '',
  '    //. 自动算格子边长：24 条和 800 条都要铺满一屏，不出滚动条',
  '    var pitch = Math.sqrt((w * h) / n);',
  '    pitch = Math.max(4.5, Math.min(15, pitch));',
  '    var cols = Math.max(1, Math.floor(w / pitch));',
  '    var cell = Math.max(2, pitch - 1);',
  '    var rowCount = Math.ceil(n / cols);',
  '    var oy = Math.max(0, (h - rowCount * pitch) / 2);',
  '    heatGeom = { pitch: pitch, cols: cols, oy: oy };',
  '',
  '    var selPos = viewIndexOfSel();',
  '    for (var i = 0; i < n; i++) {',
  '      var r = view[i];',
  '      var x = (i % cols) * pitch;',
  '      var y = oy + Math.floor(i / cols) * pitch;',
  '      var col;',
  '      if (r.s === "changed") col = css(sevT(r.v));',
  '      else if (r.s === "identical") col = "rgba(46,90,78,.55)";',
  '      else if (r.s === "missing") col = "rgba(91,141,184,.7)";',
  '      else if (r.s === "error") col = "rgba(139,149,165,.75)";',
  '      else col = "rgba(255,255,255,.07)";',
  '      ctx.fillStyle = col;',
  '      ctx.fillRect(x, y, cell, cell);',
  '      if (i === selPos) {',
  '        ctx.strokeStyle = "#e8edf4";',
  '        ctx.lineWidth = 1.5;',
  '        ctx.strokeRect(x - 1, y - 1, cell + 2, cell + 2);',
  '      }',
  '    }',
  '  }',
  '',
  '  function onHeatClick(e) {',
  '    if (!heatGeom) return;',
  '    var rect = e.currentTarget.getBoundingClientRect();',
  '    var c = Math.floor((e.clientX - rect.left) / heatGeom.pitch);',
  '    var rr = Math.floor((e.clientY - rect.top - heatGeom.oy) / heatGeom.pitch);',
  '    if (c < 0 || c >= heatGeom.cols || rr < 0) return;',
  '    var idx = rr * heatGeom.cols + c;',
  '    if (idx < 0 || idx >= view.length) return;',
  '    selectView(idx, true);',
  '  }',
  '',
  '  function renderRamp() {',
  '    var cv = $("ramp");',
  '    var w = 140, h = 8;',
  '    var dpr = Math.min(window.devicePixelRatio || 1, 2);',
  '    cv.width = Math.round(w * dpr);',
  '    cv.height = Math.round(h * dpr);',
  '    cv.style.width = w + "px";',
  '    cv.style.height = h + "px";',
  '    var ctx = cv.getContext("2d");',
  '    if (!ctx) return;',
  '    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);',
  '    var g = ctx.createLinearGradient(0, 0, w, 0);',
  '    for (var i = 0; i < STOPS.length; i++) {',
  '      g.addColorStop(STOPS[i][0], "rgb(" + STOPS[i][1] + "," + STOPS[i][2] + "," + STOPS[i][3] + ")");',
  '    }',
  '    ctx.fillStyle = g;',
  '    ctx.fillRect(0, 0, w, h);',
  '  }',
  '',
  '  // ---- 列表 ----------------------------------------------------------',
  '  function renderList() {',
  '    var box = $("list");',
  '    box.innerHTML = "";',
  '    rowNodes = [];',
  '    $("lcount").textContent = view.length + " / " + RECS.length;',
  '',
  '    if (view.length === 0) {',
  '      var e = el("div", "rp-empty");',
  '      e.appendChild(el("div", null, "没有匹配的记录"));',
  '      var b = el("button", "rp-btn", "清除筛选");',
  '      b.type = "button";',
  '      b.style.marginTop = "10px";',
  '      b.onclick = function () { filter = "all"; query = ""; $("q").value = ""; applyFilter(); };',
  '      e.appendChild(b);',
  '      box.appendChild(e);',
  '      return;',
  '    }',
  '',
  '    var selPos = viewIndexOfSel();',
  '    //. DocumentFragment 一次插入：800 条逐个 appendChild 会触发 800 次重排',
  '    var frag = document.createDocumentFragment();',
  '    for (var i = 0; i < view.length; i++) {',
  '      frag.appendChild(buildItem(i, i === selPos));',
  '    }',
  '    box.appendChild(frag);',
  '  }',
  '',
  '  function buildItem(idx, on) {',
  '    var r = view[idx];',
  '    var st = STATUS[r.s] || STATUS.pending;',
  '    var node = el("div", "rp-item" + (on ? " on" : ""));',
  '    node.setAttribute("role", "option");',
  '    node.setAttribute("aria-selected", on ? "true" : "false");',
  '    node.appendChild(el("span", "q mono", String(r.q)));',
  '',
  '    var mid = el("div", "mid");',
  '    mid.appendChild(el("div", "nm mono", r.ln + " → " + r.rn));',
  '    var mt = el("div", "mt mono");',
  '    mt.appendChild(el("span", null, st.t));',
  '    if (r.s === "changed") {',
  '      mt.appendChild(el("span", null, "+" + r.a + " / -" + r.d));',
  '      mt.appendChild(el("span", null, (r.v * 100).toFixed(1) + "%"));',
  '    }',
  '    mid.appendChild(mt);',
  '    node.appendChild(mid);',
  '',
  '    //. 增删占比条：一眼看出这条是「加字段」还是「删字段」',
  '    var bar = el("div", "bar");',
  '    var tot = r.a + r.d;',
  '    var addW = tot > 0 ? Math.round((r.a / tot) * 100) : 50;',
  '    var u1 = el("u");',
  '    u1.style.background = "#4f9d69";',
  '    u1.style.left = "0";',
  '    u1.style.width = addW + "%";',
  '    var u2 = el("u");',
  '    u2.style.background = "#e0574f";',
  '    u2.style.left = addW + "%";',
  '    u2.style.right = "0";',
  '    bar.appendChild(u1);',
  '    bar.appendChild(u2);',
  '    node.appendChild(bar);',
  '',
  '    node.onclick = function () { selectView(idx, false); };',
  '    rowNodes[idx] = node;',
  '    return node;',
  '  }',
  '',
  '  //. 只改两行的 class，不重建整个列表 —— 键盘连按时差别很明显',
  '  function paintSelection(prevIdx, nextIdx) {',
  '    if (prevIdx >= 0 && rowNodes[prevIdx]) {',
  '      rowNodes[prevIdx].className = "rp-item";',
  '      rowNodes[prevIdx].setAttribute("aria-selected", "false");',
  '    }',
  '    if (nextIdx >= 0 && rowNodes[nextIdx]) {',
  '      rowNodes[nextIdx].className = "rp-item on";',
  '      rowNodes[nextIdx].setAttribute("aria-selected", "true");',
  '    }',
  '  }',
  '',
  '  function selectView(idx, scrollList) {',
  '    if (idx < 0 || idx >= view.length) return;',
  '    var prev = viewIndexOfSel();',
  '    selI = view[idx].i;',
  '    openGaps = {};',
  '    limit = PAGE;',
  '    paintSelection(prev, idx);',
  '    renderHeat();',
  '    renderView();',
  '    if (scrollList !== false && rowNodes[idx] && rowNodes[idx].scrollIntoView) {',
  '      rowNodes[idx].scrollIntoView({ block: "nearest" });',
  '    }',
  '  }',
  '',
  '  // ---- 差异视图 ------------------------------------------------------',
  '  function diffOf(r) {',
  '    if (!diffCache[r.i]) diffCache[r.i] = window.MCDiff.computeDiff(r.L, r.R);',
  '    return diffCache[r.i];',
  '  }',
  '',
  '  function kv(k, v, color) {',
  '    var n = el("span", "rp-kv");',
  '    n.appendChild(document.createTextNode(k));',
  '    var b = el("b", "mono", v);',
  '    if (color) b.style.color = color;',
  '    n.appendChild(b);',
  '    return n;',
  '  }',
  '',
  '  function firstChangeIndex(rows) {',
  '    for (var i = 0; i < rows.length; i++) {',
  '      var t = rows[i].t;',
  '      if (t !== "c" && t !== "gap") return i;',
  '    }',
  '    return -1;',
  '  }',
  '',
  '  function rowNode(row) {',
  '    if (row.t === "gap") {',
  '      var g = el("div", "rp-gap", (openGaps[row.key] ? "收起 " : "展开 ") + row.n + " 行未变更内容");',
  '      g.setAttribute("role", "button");',
  '      g.tabIndex = 0;',
  '      var toggle = function () {',
  '        if (openGaps[row.key]) delete openGaps[row.key];',
  '        else openGaps[row.key] = true;',
  '        //. 展开折叠区后行数会暴涨，顺手把闸门抬高，免得用户还得再点一次「继续加载」',
  '        limit = PAGE * 8;',
  '        renderView();',
  '      };',
  '      g.onclick = toggle;',
  '      g.onkeydown = function (e) {',
  '        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }',
  '      };',
  '      return g;',
  '    }',
  '    var cls = "rp-r" + (row.t === "+" ? " add" : row.t === "-" ? " del" : "");',
  '    var n = el("div", cls);',
  '    n.appendChild(el("span", "rp-no", row.l == null ? "" : String(row.l)));',
  '    n.appendChild(el("span", "rp-no", row.r == null ? "" : String(row.r)));',
  '    n.appendChild(el("span", "rp-sg", row.t === "+" ? "+" : row.t === "-" ? "-" : " "));',
  '    var cd = el("span", "rp-cd");',
  '    if (row.g && row.g.length) {',
  '      for (var i = 0; i < row.g.length; i++) {',
  '        if (row.g[i][1]) cd.appendChild(el("span", "rp-mk", row.g[i][0]));',
  '        else cd.appendChild(document.createTextNode(row.g[i][0]));',
  '      }',
  '    } else {',
  '      cd.textContent = row.s;',
  '    }',
  '    n.appendChild(cd);',
  '    return n;',
  '  }',
  '',
  '  function renderView() {',
  '    var body = $("vbody");',
  '    body.innerHTML = "";',
  '',
  '    var selPos = viewIndexOfSel();',
  '    if (selPos < 0) {',
  '      var s = el("div", "rp-state");',
  '      s.appendChild(el("div", "t", "没有可显示的记录"));',
  '      s.appendChild(el("div", "d", "调整上方的筛选条件，或在左侧列表里选择一条记录。"));',
  '      body.appendChild(s);',
  '      return;',
  '    }',
  '',
  '    var r = view[selPos];',
  '    var st = STATUS[r.s] || STATUS.pending;',
  '    var d = diffOf(r);',
  '    var stats = d.stats;',
  '',
  '    var head = el("div", "rp-vhead");',
  '    head.appendChild(el("span", "seq mono", "#" + r.q));',
  '    var nm = el("span", "names mono");',
  '    nm.appendChild(document.createTextNode(r.ln));',
  '    nm.appendChild(el("em", null, "VS"));',
  '    nm.appendChild(document.createTextNode(r.rn));',
  '    head.appendChild(nm);',
  '    head.appendChild(el("span", "rp-sp"));',
  '    head.appendChild(kv("状态", st.t, st.c));',
  '    if (stats) {',
  '      head.appendChild(kv("严重度", (stats.severity * 100).toFixed(1) + "%", css(sevT(stats.severity))));',
  '      head.appendChild(kv("增", String(stats.added), "#8ed7a6"));',
  '      head.appendChild(kv("删", String(stats.removed), "#f0938c"));',
  '      head.appendChild(kv("行数", stats.leftLines + " → " + stats.rightLines));',
  '    }',
  '',
  '    var btnExp = el("button", "rp-btn" + (expandAll ? " on" : ""), expandAll ? "折叠未变更区" : "展开全部行");',
  '    btnExp.type = "button";',
  '    btnExp.onclick = function () { expandAll = !expandAll; openGaps = {}; limit = PAGE; renderView(); };',
  '    head.appendChild(btnExp);',
  '',
  '    var sel = el("select", "rp-btn");',
  '    sel.setAttribute("aria-label", "上下文行数");',
  '    var opts = [0, 1, 3, 6, 12];',
  '    for (var oi = 0; oi < opts.length; oi++) {',
  '      var o = el("option", null, "上下文 " + opts[oi]);',
  '      o.value = String(opts[oi]);',
  '      if (opts[oi] === context) o.selected = true;',
  '      sel.appendChild(o);',
  '    }',
  '    sel.onchange = function () { context = parseInt(sel.value, 10); openGaps = {}; limit = PAGE; renderView(); };',
  '    head.appendChild(sel);',
  '    head.appendChild(kv("", (selPos + 1) + " / " + view.length));',
  '    body.appendChild(head);',
  '',
  '    if (r.n && r.n.length) body.appendChild(el("div", "rp-notes", "归一化：" + r.n.join(" · ")));',
  '    if (r.e) body.appendChild(el("div", "rp-notes bad", "解析异常：" + r.e));',
  '',
  '    var wrap = el("div", "rp-diff");',
  '    var inner = el("div", "in");',
  '    var rows = window.MCDiff.buildHunkViewWithGaps(d.rows, context, expandAll, openGaps);',
  '    var shown = rows.length > limit ? rows.slice(0, limit) : rows;',
  '    var frag = document.createDocumentFragment();',
  '    for (var i = 0; i < shown.length; i++) frag.appendChild(rowNode(shown[i]));',
  '    inner.appendChild(frag);',
  '',
  '    var rest = rows.length - shown.length;',
  '    if (rest > 0) {',
  '      var more = el("div", "rp-more");',
  '      var mb = el("button", "rp-btn", "继续加载 " + Math.min(PAGE, rest) + " 行 · 剩余 " + rest + " 行");',
  '      mb.type = "button";',
  '      mb.onclick = function () { limit += PAGE; renderView(); };',
  '      more.appendChild(mb);',
  '      inner.appendChild(more);',
  '    }',
  '    wrap.appendChild(inner);',
  '    body.appendChild(wrap);',
  '',
  '    //. 自动滚到第一处差异：报告打开后用户想看的就是「到底改了什么」',
  '    var first = firstChangeIndex(rows);',
  '    if (first > 0) wrap.scrollTop = Math.max(0, first * 19 - wrap.clientHeight * 0.3);',
  '  }',
  '',
  '  // ---- 事件 ----------------------------------------------------------',
  '  function bind() {',
  '    var q = $("q");',
  '    var tid = 0;',
  '    q.oninput = function () {',
  '      if (tid) clearTimeout(tid);',
  '      //. 输入防抖：800 条时每敲一个字就全量重筛会明显掉字',
  '      tid = setTimeout(function () {',
  '        tid = 0;',
  '        query = q.value.trim().toLowerCase();',
  '        selI = -1;',
  '        applyFilter();',
  '      }, 160);',
  '    };',
  '',
  '    $("heat").onclick = onHeatClick;',
  '',
  '    document.addEventListener("keydown", function (e) {',
  '      var tag = e.target && e.target.tagName;',
  '      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;',
  '      var cur = viewIndexOfSel();',
  '      if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); selectView(Math.min(view.length - 1, cur + 1)); }',
  '      else if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); selectView(Math.max(0, cur - 1)); }',
  '      else if (e.key === "Home") { e.preventDefault(); selectView(0); }',
  '      else if (e.key === "End") { e.preventDefault(); selectView(view.length - 1); }',
  '    });',
  '',
  '    var rz = 0;',
  '    window.addEventListener("resize", function () {',
  '      if (rz) clearTimeout(rz);',
  '      rz = setTimeout(function () { rz = 0; renderHeat(); }, 120);',
  '    });',
  '  }',
  '',
  '  function boot() {',
  '    renderRamp();',
  '    bind();',
  '    selI = RECS.length ? RECS[0].i : -1;',
  '    applyFilter();',
  '  }',
  '',
  '  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);',
  '  else boot();',
  '})();'
].join('\n');

// ---------------------------------------------------------------------------
// HTML 骨架
// ---------------------------------------------------------------------------

const REPORT_HTML = [
  '<!DOCTYPE html>',
  '<html lang="zh-CN">',
  '<head>',
  '<meta charset="utf-8" />',
  '<meta name="viewport" content="width=device-width,initial-scale=1" />',
  '<title>__TITLE__</title>',
  '<style>__CSS__</style>',
  '</head>',
  '<body>',
  '<div id="app">',
  '  <div class="rp-top">',
  '    <div class="rp-title">',
  '      <h1 id="t-title"></h1>',
  '      <span class="tag mono" id="t-group"></span>',
  '    </div>',
  '    <div class="rp-sub">',
  '      <span id="t-at"></span>',
  '      <span id="t-scope"></span>',
  '      <span id="t-meta" class="mono"></span>',
  '      <span style="margin-left:auto">↑↓ 切换记录 · 点击色块定位 · 本文件可离线打开</span>',
  '    </div>',
  '    <div class="rp-tools">',
  '      <div class="rp-chips" id="chips"></div>',
  '      <input class="rp-search" id="q" type="search" placeholder="搜索序号 / 报文名 / 业务" aria-label="搜索记录" />',
  '    </div>',
  '  </div>',
  '  <div class="rp-heat">',
  '    <span class="cap">严重度矩阵</span>',
  '    <canvas id="heat" role="img" aria-label="差异严重度矩阵"></canvas>',
  '    <div class="rp-ramp">',
  '      <canvas id="ramp" role="img" aria-label="严重度色标"></canvas>',
  '      <div class="lb mono"><span>一致</span><span>面目全非</span></div>',
  '    </div>',
  '  </div>',
  '  <div class="rp-body">',
  '    <div class="rp-lcol">',
  '      <div class="rp-lhead"><span>记录</span><span class="mono" id="lcount"></span></div>',
  '      <div class="rp-list" id="list" role="listbox" aria-label="比对记录"></div>',
  '    </div>',
  '    <div class="rp-view" id="vbody"></div>',
  '  </div>',
  '</div>',
  '<script>__LZ__</script>',
  '<script>__DIFF__</script>',
  '<script>__ENGINE__</script>',
  '<script>window.__MC_DATA__ = "__DATA__";</script>',
  '<script>__APP__</script>',
  '</body>',
  '</html>'
].join('\n');

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 生成完整报告 HTML。
 * @param {object} payload buildReportPayload 的产物
 * @param {object} [sources] 覆盖内联源码（仅测试用）
 * @param {string} [precompressed] estimateReportSize 已经算好的压缩串，避免重复压一遍
 * @returns {{html: string, bytes: number, compressed: number}}
 */
export function buildReportHtml(payload, sources, precompressed) {
  const src = sources || {
    lz: __VENDOR_LZSTRING_JS__,
    diff: __VENDOR_DIFF_JS__,
    engine: __SRC_DIFF_ENGINE_JS__
  };

  const est = precompressed
    ? { compressed: precompressed }
    : estimateReportSize(payload);
  const engine = inlineEngineSource(src.engine);
  const title = (payload.title || '报文批量比对报告') + (payload.group ? ' · ' + payload.group : '');

  //. 全部用函数式替换：字符串替换会把 $& / $1 之类当成特殊模式，
  //. 而压缩后的 base64、压缩过的 JS 源码里都可能出现这些序列，直接替换会静默产出坏文件。
  const html = REPORT_HTML.replace('__TITLE__', () => escapeHtml(title))
    .replace('__CSS__', () => REPORT_CSS)
    .replace('__LZ__', () => escapeScript(src.lz))
    .replace('__DIFF__', () => escapeScript(src.diff))
    .replace('__ENGINE__', () => escapeScript(engine))
    .replace('__DATA__', () => est.compressed)
    .replace('__APP__', () => escapeScript(REPORT_JS));

  return { html, bytes: html.length, compressed: est.compressed.length };
}

/**
 * 触发浏览器下载。
 * 用 Blob + createObjectURL 而不是 data URL：
 * 几百条报文的报告动辄几 MB，data URL 会把整份内容塞进一个 DOM 属性里，
 * 部分浏览器直接截断甚至崩掉。
 */
export function downloadReport(html, filename) {
  const blob = new Blob(['\ufeff', html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'diff-report-' + Date.now() + '.html';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  //. 立刻 revoke 会让部分浏览器中断下载，留一拍再释放
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export default buildReportHtml;
