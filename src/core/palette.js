/**
 * 全局色标 / 设计令牌的唯一数据源。
 *
 * 这里刻意把「颜色」从组件里抽出来：Canvas2D 的热力矩阵、GLSL 图例渐变条、
 * DOM 里的差异高亮、离线 HTML 报告，全部从这一份 stops 取色。
 * 好处是改一处，四个渲染通道的视觉语言同步变化，不会出现
 * 「画布上是橙色、DOM 里是黄色」这种慢慢烂掉的细节。
 */

// ---------------------------------------------------------------------------
// 基础令牌（与 styles/theme.less 中的 CSS 变量保持一一对应）
// ---------------------------------------------------------------------------

export const TOKENS = {
  bgVoid: '#0b0e13',
  bgBase: '#0e1218',
  bgSurface: '#141a22',
  bgElevated: '#1a222c',

  lineHair: 'rgba(255,255,255,0.06)',
  lineSoft: 'rgba(255,255,255,0.11)',

  textHi: '#e8edf4',
  textMid: '#9aa7b8',
  textLo: '#626e7d',

  accent: '#35c2a5',
  ok: '#4f9d69',
  warn: '#d9a441',
  bad: '#e0574f',
  info: '#5b8db8',

  //. 差异语义色：新增 / 删除 / 修改
  addBg: 'rgba(79,157,105,0.14)',
  addFg: '#7fd39b',
  addMark: '#4f9d69',
  delBg: 'rgba(224,87,79,0.13)',
  delFg: '#f0938c',
  delMark: '#e0574f',
  chgBg: 'rgba(217,164,65,0.16)'
};

// ---------------------------------------------------------------------------
// 差异严重度色标
// ---------------------------------------------------------------------------

/**
 * t = 0 → 完全一致；t = 1 → 整份报文面目全非。
 * 走「沉静墨绿 → 苔黄 → 琥珀 → 橙 → 砖红」的暖向渐变，
 * 目的是让几百个色块铺在一起时，出问题的记录会自己「跳」出来。
 */
export const SEVERITY_STOPS = [
  { t: 0.0, c: [46, 90, 78] },
  { t: 0.1, c: [63, 122, 94] },
  { t: 0.3, c: [138, 154, 74] },
  { t: 0.5, c: [217, 164, 65] },
  { t: 0.72, c: [224, 122, 69] },
  { t: 1.0, c: [224, 87, 79] }
];

export const STATUS_COLOR = {
  pending: '#2a323d',
  running: '#35c2a5',
  identical: '#2e5a4e',
  changed: '#d9a441',
  missing: '#5b8db8',
  error: '#8b95a5'
};

export const STATUS_LABEL = {
  pending: '待比对',
  running: '比对中',
  identical: '一致',
  changed: '有差异',
  missing: '单侧为空',
  error: '异常'
};

// ---------------------------------------------------------------------------
// JS 侧插值
// ---------------------------------------------------------------------------

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * 在色标上取色，返回 [r, g, b]（0-255 整数）。
 * @param {number} t 0~1
 * @param {number} [alpha] 0~1，传入时返回第四位
 */
export function severityRgb(t, stops) {
  const ramp = stops || SEVERITY_STOPS;
  const x = clamp01(t);

  for (let i = 0; i < ramp.length - 1; i += 1) {
    const a = ramp[i];
    const b = ramp[i + 1];
    if (x >= a.t && x <= b.t) {
      const span = b.t - a.t || 1;
      //. 用 smoothstep 代替线性插值，色带衔接处不会出现肉眼可见的「折点」
      const k = (x - a.t) / span;
      const s = k * k * (3 - 2 * k);
      return [
        Math.round(a.c[0] + (b.c[0] - a.c[0]) * s),
        Math.round(a.c[1] + (b.c[1] - a.c[1]) * s),
        Math.round(a.c[2] + (b.c[2] - a.c[2]) * s)
      ];
    }
  }
  return ramp[ramp.length - 1].c.slice();
}

export function severityCss(t, alpha) {
  const c = severityRgb(t);
  return alpha == null
    ? 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')'
    : 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + alpha + ')';
}

/**
 * 差异率 → 色标位置。
 *
 * 实测 1774 条报文：绝大多数的 changeRatio 落在 0.02~0.06，只有「整份报文重写」
 * 才会到 0.5 以上。如果直接把 ratio 当 t 用，热力图会是一片分辨不出的暗绿，
 * 恰恰把最需要看的「改了两个字段」淹没了。
 *
 * 这里用 pow(ratio, 0.4) 把低段拉开：
 *   0.00 → 0.00（一致，仍然是纯暗绿）
 *   0.03 → 0.25（改几个字段，苔绿转黄绿，一眼能挑出来）
 *   0.30 → 0.62（结构性差异，橙）
 *   1.00 → 1.00（完全不同，砖红）
 * 指数 0.4 是试出来的，够敏感又不会让轻微波动也变红。
 */
export function severityToRampT(ratio) {
  const r = ratio == null ? 0 : clamp01(ratio);
  return Math.pow(r, 0.4);
}

// ---------------------------------------------------------------------------
// GLSL 侧：由同一份 stops 生成着色器代码
// ---------------------------------------------------------------------------

/**
 * 把 stops 编译成一段 GLSL 函数源码。
 *
 * 为什么不用 cosine palette？cosine palette 好看但不可控，
 * 没法保证「画布上的 t=0.5」和「图例上的 t=0.5」是同一个颜色。
 * 直接生成 if/mix 阶梯虽然朴素，但和 JS 侧逐段对应，两边永远一致。
 *
 * @param {string} fnName 生成的函数名
 * @returns {string} GLSL 源码片段
 */
export function buildRampGlsl(fnName, stops) {
  const ramp = stops || SEVERITY_STOPS;
  const v = (arr) => 'vec3(' + arr.map((n) => (n / 255).toFixed(5)).join(', ') + ')';

  const lines = [];
  lines.push('vec3 ' + fnName + '(float t) {');
  lines.push('  float x = clamp(t, 0.0, 1.0);');
  lines.push('  vec3 col = ' + v(ramp[0].c) + ';');

  for (let i = 0; i < ramp.length - 1; i += 1) {
    const a = ramp[i];
    const b = ramp[i + 1];
    const span = (b.t - a.t || 1).toFixed(5);
    //. 与 JS 侧同一个 smoothstep，保证像素级一致
    lines.push('  if (x > ' + a.t.toFixed(5) + ') {');
    lines.push('    float k' + i + ' = clamp((x - ' + a.t.toFixed(5) + ') / ' + span + ', 0.0, 1.0);');
    lines.push('    col = mix(col, ' + v(b.c) + ', k' + i + ' * k' + i + ' * (3.0 - 2.0 * k' + i + '));');
    lines.push('  }');
  }

  lines.push('  return col;');
  lines.push('}');
  return lines.join('\n');
}
