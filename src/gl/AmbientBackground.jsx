/**
 * WebGL 氛围背景
 *
 * 三个决定它「不出事」的工程细节：
 *
 * 1) 降分辨率渲染。背景是大尺度软渐变，没有任何高频细节，
 *    所以画布只按 CSS 尺寸的 45% 分配像素，再用 CSS 拉伸铺满。
 *    填充率直接省掉 80%，在集显 / 远程桌面机器上才跑得动。
 *
 * 2) 离屏即停。document.hidden 时取消 rAF —— 用户切到别的标签页去核对数据，
 *    不该还在后台烧 GPU。这一条对挂着几十个标签页排查问题的人很关键。
 *
 * 3) 有降级。拿不到 WebGL2 就退回纯 CSS 径向渐变（一个 class 的事），
 *    不加载任何着色器、不占用 GPU 上下文。老内网机器上功能完全不受影响。
 *
 * 结构上拆成两个 effect：一个只负责「建好 GL 上下文和 program」，
 * 一个只负责「什么时候跑循环」。这样可见性变化时不会重建上下文，
 * 也不会出现「循环还在跑但 uniform 没人更新」导致画面定格的坑。
 */

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { AMBIENT_FS, FULLSCREEN_VS, detectGlSupport } from './shaders';
import { usePrefersReducedMotion, usePageVisible } from '../canvas/canvasUtils';

const RENDER_SCALE = 0.45;
const MAX_DIM = 1600; //. 再大的屏幕也不给更多像素，避免 4K 上填充率失控
const STATIC_TIME = 18.0; //. 减少动效时定格在这一帧，构图已经完全展开

const DEEP = [0.035, 0.047, 0.066];   //. 谷底：接近 theme 里的 --bg-void
const GLOW_A = [0.075, 0.20, 0.185];  //. 主流动：墨绿，和「一致」色标同族
const GLOW_B = [0.24, 0.155, 0.075];  //. 次流动：暗琥珀，和「差异」色标同族

function compile(gl, type, source) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('着色器编译失败: ' + log);
  }
  return sh;
}

const AmbientBackground = () => {
  const canvasRef = useRef(null);
  const glRef = useRef(null);
  const programRef = useRef(null);
  const uniformsRef = useRef({});
  const startRef = useRef(0);
  const intensityRef = useRef(0);

  const reduced = usePrefersReducedMotion();
  const visible = usePageVisible();
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  // ---- 建上下文 -----------------------------------------------------------

  useEffect(() => {
    if (detectGlSupport() === 'none') {
      setFailed(true);
      return undefined;
    }

    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    //. alpha:false + 不透明底色，省掉一次合成；背景本来就在最底层
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'low-power'
    });

    if (!gl) {
      setFailed(true);
      return undefined;
    }

    let program = null;
    let vao = null;
    let disposed = false;

    try {
      //. trim() 是必须的：#version 300 es 前面多一个字符都会编译失败
      const vs = compile(gl, gl.VERTEX_SHADER, FULLSCREEN_VS.trim());
      const fs = compile(gl, gl.FRAGMENT_SHADER, AMBIENT_FS.trim());
      program = gl.createProgram();
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);

      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error('着色器链接失败: ' + gl.getProgramInfoLog(program));
      }

      gl.useProgram(program);
      const u = {};
      ['iResolution', 'iTime', 'iIntensity', 'uDeep', 'uGlowA', 'uGlowB'].forEach((name) => {
        u[name] = gl.getUniformLocation(program, name);
      });

      //. 顶点位置由 gl_VertexID 在着色器里算出来，只需要一个空 VAO
      vao = gl.createVertexArray();
      gl.bindVertexArray(vao);

      gl.uniform3fv(u.uDeep, DEEP);
      gl.uniform3fv(u.uGlowA, GLOW_A);
      gl.uniform3fv(u.uGlowB, GLOW_B);

      glRef.current = gl;
      programRef.current = program;
      uniformsRef.current = u;
      startRef.current = performance.now();
      intensityRef.current = reduced ? 1 : 0;
    } catch (err) {
      //. 着色器出问题绝不能白屏，静默降级到 CSS
      if (typeof console !== 'undefined') console.warn('[AmbientBackground] 已降级到 CSS 背景：', err);
      setFailed(true);
      return undefined;
    }

    const resize = () => {
      if (disposed) return;
      const w = window.innerWidth;
      const h = window.innerHeight;
      const scale = Math.min(RENDER_SCALE, MAX_DIM / Math.max(w, h, 1));
      const bw = Math.max(2, Math.round(w * scale));
      const bh = Math.max(2, Math.round(h * scale));
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      gl.viewport(0, 0, bw, bh);
      gl.uniform2f(uniformsRef.current.iResolution, bw, bh);
    };

    resize();
    window.addEventListener('resize', resize);
    setReady(true);

    return () => {
      disposed = true;
      setReady(false);
      window.removeEventListener('resize', resize);
      if (vao) gl.deleteVertexArray(vao);
      if (program) gl.deleteProgram(program);
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      glRef.current = null;
      programRef.current = null;
    };
    //. reduced 变化时会重建一次，让淡入 / 定格两种模式各自初始化
  }, [reduced]);

  // ---- 循环控制 -----------------------------------------------------------

  const paintOnce = useCallback(() => {
    const gl = glRef.current;
    const u = uniformsRef.current;
    if (!gl || !u.iTime) return;
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }, []);

  useEffect(() => {
    if (!ready || failed) return undefined;
    const gl = glRef.current;
    const u = uniformsRef.current;
    if (!gl) return undefined;

    if (reduced) {
      //. 减少动效：定格一帧就结束，不进入循环
      gl.uniform1f(u.iTime, STATIC_TIME);
      gl.uniform1f(u.iIntensity, 1);
      paintOnce();
      return undefined;
    }

    if (!visible) return undefined;

    let raf = 0;
    let disposed = false;

    const frame = () => {
      if (disposed) return;
      const elapsed = (performance.now() - startRef.current) / 1000;

      //. 淡入约 1.6s，避免页面一打开就有一大块颜色糊上来
      intensityRef.current += (1 - intensityRef.current) * 0.035;
      if (intensityRef.current > 0.999) intensityRef.current = 1;

      gl.uniform1f(u.iTime, elapsed);
      gl.uniform1f(u.iIntensity, intensityRef.current);
      paintOnce();
      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
    };
  }, [ready, failed, visible, reduced, paintOnce]);

  if (failed) {
    //. CSS 降级：三层径向渐变近似同一套配色，纯合成器绘制，零 GPU 计算
    return <div className="mc-ambient mc-ambient--css" aria-hidden="true" />;
  }

  return (
    <div className="mc-ambient" aria-hidden="true">
      <canvas ref={canvasRef} className="mc-ambient__canvas" />
    </div>
  );
};

export default React.memo(AmbientBackground);
