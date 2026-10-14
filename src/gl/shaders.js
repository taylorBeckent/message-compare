/**
 * GLSL 着色器源码
 *
 * 全部按 WebGL2 / GLSL ES 3.00 写：
 *   - `#version 300 es` 必须是源码第一个字符（前面不能有空行或注释）
 *   - 用 gl_FragCoord.xy，WebGL2 没有 ShaderToy 的 fragCoord 内置变量
 *   - 片元着色器显式声明 `out vec4 fragColor`，不用已废弃的 gl_FragColor
 *   - 函数先声明后使用，GLSL 不做前向引用
 *   - 含函数调用的常量用 const 而不是 #define（宏不做类型检查，很容易埋雷）
 */

import { buildRampGlsl, SEVERITY_STOPS } from '../core/palette';

// ---------------------------------------------------------------------------
// 顶点着色器：全屏三角形
// ---------------------------------------------------------------------------

/**
 * 用一个覆盖视口的三角形代替两个三角形组成的四边形：
 * 对角线上不会有插值接缝，顶点数还少一半。
 * 顶点位置直接在着色器里由 gl_VertexID 算出来，不需要 VBO。
 */
export const FULLSCREEN_VS = `#version 300 es
precision highp float;

out vec2 vUv;

void main() {
  //. (0,0) (2,0) (0,2) —— 裁剪空间里的大三角形，覆盖整个视口
  vec2 pos = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = pos;
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}
`;

// ---------------------------------------------------------------------------
// 氛围背景：域扭曲 FBM
// ---------------------------------------------------------------------------

/**
 * 页面最底层的环境光。
 *
 * 用域扭曲（domain warping）而不是普通的噪声渐变：
 * `fbm(p + fbm(p))` 会让等值线自己卷起来，产生类似液体 / 烟的有机流动，
 * 而单层 fbm 只是模糊的斑块，一眼就能看出是「加了个背景」。
 *
 * 刻意压得很暗（整体亮度 < 0.18）：它是氛围，不是主角。
 * 内容层要压在上面读几百行报文，背景一旦抢视线就是灾难。
 */
export const AMBIENT_FS = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform vec2  iResolution;
uniform float iTime;
uniform float iIntensity;   //. 0~1，配合「减少动态效果」做淡出
uniform vec3  uDeep;        //. 谷底色
uniform vec3  uGlowA;       //. 主流动色
uniform vec3  uGlowB;       //. 次流动色

//. 去相关旋转矩阵，约 36.87°。FBM 每层都用它旋转一次，
//. 否则各层噪声的网格方向一致，会出现明显的十字伪影。
const mat2 M = mat2(0.80, 0.60, -0.60, 0.80);

float hash(vec2 p) {
  //. 不用 fract(sin(dot(...))) 那个经典写法：
  //. 部分移动 GPU 的 mediump sin 精度不足，会出现块状斑纹
  p = fract(p * 0.6180339887);
  p *= 25.0;
  return fract(p.x * p.y * (p.x + p.y));
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  //. Hermite 平滑插值，去掉线性插值的菱形棱
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float f = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  //. 5 层。再往上加对这种大尺度背景没有可见收益，纯粹烧填充率
  for (int i = 0; i < 5; i++) {
    f += amp * noise(p);
    norm += amp;
    p = M * p * 2.02;
    amp *= 0.5;
  }
  return f / norm;
}

void main() {
  //. 用 vUv（0~2 范围）而不是 gl_FragCoord，省一次除法，且与分辨率无关
  vec2 uv = (vUv * iResolution - 0.5 * iResolution) / max(iResolution.y, 1.0);

  float t = iTime * 0.035;

  //. 两层域扭曲：内层决定大尺度卷曲，外层加细节
  vec2 q = uv * 1.35 + vec2(t * 0.6, -t * 0.4);
  float warp = fbm(q);
  float shade = fbm(q + vec2(warp * 1.6 + t, warp * 1.2 - t * 0.7));

  //. 脊线：把噪声折一下，得到细丝状的高光，比纯斑块更有「流动」的读感
  float ridge = 1.0 - abs(shade * 2.0 - 1.0);
  ridge = pow(clamp(ridge, 0.0, 1.0), 3.0);

  vec3 col = uDeep;
  col = mix(col, uGlowA, smoothstep(0.28, 0.92, shade) * 0.85);
  col = mix(col, uGlowB, ridge * 0.30);

  //. 顶部略亮、底部沉下去，给页面一点纵深
  col *= 0.82 + 0.30 * (1.0 - vUv.y * 0.5);

  //. 暗角，把视线往中间内容区收（vUv 中心是 0.5，不是 1.0）
  vec2 vg = vUv - 0.5;
  col *= 1.0 - 0.42 * dot(vg, vg) * 2.0;

  //. 轻微色调映射，防止高光处硬截断成色块
  col = col / (1.0 + col * 0.35);

  fragColor = vec4(col * iIntensity, 1.0);
}
`;

// ---------------------------------------------------------------------------
// 色标图例：与 Canvas2D 共用同一份 stops
// ---------------------------------------------------------------------------

/**
 * 图例渐变条的片元着色器。
 *
 * 关键点是 `buildRampGlsl` —— 它直接读取 palette.js 里的 SEVERITY_STOPS
 * 生成 GLSL 阶梯函数，和 Canvas2D 走的是同一份数据、同一个 smoothstep 公式。
 *
 * 这就是为什么图例能拿来「验证」热力矩阵的颜色：
 * 它们不是两套各调各的渐变色，而是同一段色标的两种编译产物。
 */
export function buildRampFs() {
    return `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform float uPad;

${buildRampGlsl('severityRamp', SEVERITY_STOPS)}

void main() {
  float t = clamp(vUv.x, 0.0, 1.0);
  vec3 col = severityRamp(t);

  //. 上下边缘压一点暗，让渐变条在深色面板里有个干净的收尾
  float edge = smoothstep(0.0, 0.18, vUv.y) * smoothstep(1.0, 0.82, vUv.y);
  col *= mix(1.0 - uPad, 1.0, edge);

  fragColor = vec4(col, 1.0);
}
`;
}

/**
 * 判断当前环境能用哪种渲染通道。结果做模块级缓存：
 * 每次调用都会新建一个 canvas 并申请 GL 上下文，
 * 而浏览器对同时存活的 WebGL 上下文数量是有上限的（通常 8~16 个），
 * 探测用的上下文如果不缓存复用，反复挂载组件时可能把配额吃光。
 *
 * @returns {'webgl2'|'none'}
 */
let glSupportCache = null;

export function detectGlSupport() {
    if (glSupportCache !== null) return glSupportCache;
    if (typeof document === 'undefined') return 'none';
    try {
        const probe = document.createElement('canvas');
        const gl = probe.getContext('webgl2');
        if (gl) {
            //. 主动释放，探测用的上下文不该占着 GPU 资源不放
            const lose = gl.getExtension('WEBGL_lose_context');
            if (lose) lose.loseContext();
            glSupportCache = 'webgl2';
            return glSupportCache;
        }
    } catch (e) {
        glSupportCache = 'none';
        return glSupportCache;
    }
    glSupportCache = 'none';
    return glSupportCache;
}
