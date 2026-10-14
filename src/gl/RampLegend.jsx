/**
 * 色标图例（WebGL2 + Canvas2D 双通道）
 *
 * 这个组件存在的意义不只是「画个渐变条」。
 *
 * 它用的是 palette.js 里 buildRampGlsl(SEVERITY_STOPS) 生成的 GLSL 函数，
 * 而热力矩阵用的是同一份 SEVERITY_STOPS 走 severityRgb() 的 JS 插值。
 * 两边是同一个色标的两种编译产物 —— 所以图例可以直接拿来核对热力图的颜色，
 * 不会出现「图例是渐变、画布是另一套渐变」这种慢慢烂掉的不一致。
 *
 * 降级为什么要用两个 canvas 节点：
 * 一个 canvas 一旦 getContext('webgl2') 成功，之后再调 getContext('2d') 会返回 null
 * （HTMLCanvasElement 的上下文类型一旦确定就不可更改）。
 * 所以「GL 初始化中途失败再退回 2D」在同一个节点上根本做不到，
 * 必须让 React 换一个全新的 canvas 元素挂载。
 */

import React, { useRef, useEffect, useState } from 'react';
import { FULLSCREEN_VS, buildRampFs, detectGlSupport } from './shaders';
import { SEVERITY_STOPS, severityRgb } from '../core/palette';

const HEIGHT = 10;

function compile(gl, type, source) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(log);
  }
  return sh;
}

const RampLegend = (props) => {
  const { width } = props;
  const wrapRef = useRef(null);
  const glCanvasRef = useRef(null);
  const ctx2dCanvasRef = useRef(null);

  //. 'gl' | '2d'，决定挂哪一个 canvas 节点
  const [mode, setMode] = useState(() => (detectGlSupport() === 'webgl2' ? 'gl' : '2d'));

  const cssWidth = () => {
    if (width) return width;
    const wrap = wrapRef.current;
    return Math.max(60, wrap ? wrap.clientWidth || 200 : 200);
  };

  // ---- WebGL 通道 ---------------------------------------------------------

  useEffect(() => {
    if (mode !== 'gl') return undefined;
    const canvas = glCanvasRef.current;
    if (!canvas) return undefined;

    const w = cssWidth();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.style.width = w + 'px';
    canvas.style.height = HEIGHT + 'px';
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(HEIGHT * dpr);

    let gl = null;
    let vao = null;
    let program = null;

    try {
      gl = canvas.getContext('webgl2', { alpha: true, antialias: false, depth: false, stencil: false });
      if (!gl) throw new Error('拿不到 webgl2 上下文');

      //. trim() 是必须的：#version 300 es 前面多一个字符都会编译失败
      const vs = compile(gl, gl.VERTEX_SHADER, FULLSCREEN_VS.trim());
      const fs = compile(gl, gl.FRAGMENT_SHADER, buildRampFs().trim());
      program = gl.createProgram();
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(program) || '链接失败');
      }

      vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.useProgram(program);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform1f(gl.getUniformLocation(program, 'uPad'), 0.32);
      //. 静态渐变，画一帧就够，不进 rAF 循环
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } catch (err) {
      if (typeof console !== 'undefined') console.warn('[RampLegend] WebGL 通道失败，切 Canvas2D：', err);
      setMode('2d');
    }

    return () => {
      if (gl) {
        if (vao) gl.deleteVertexArray(vao);
        if (program) gl.deleteProgram(program);
        const lose = gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      }
    };
  }, [mode, width]);

  // ---- Canvas2D 通道 ------------------------------------------------------

  useEffect(() => {
    if (mode !== '2d') return;
    const canvas = ctx2dCanvasRef.current;
    if (!canvas) return;

    const w = cssWidth();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.style.width = w + 'px';
    canvas.style.height = HEIGHT + 'px';
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(HEIGHT * dpr);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    //. 同一份 stops 生成线性渐变色标，与 GLSL 阶梯视觉一致
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    SEVERITY_STOPS.forEach((stop) => {
      const c = severityRgb(stop.t);
      grad.addColorStop(stop.t, 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')');
    });
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, HEIGHT);
  }, [mode, width]);

  return (
    <div className="mc-ramp" ref={wrapRef} data-mode={mode}>
      {mode === 'gl' ? <canvas ref={glCanvasRef} aria-hidden="true" /> : null}
      {mode === '2d' ? <canvas ref={ctx2dCanvasRef} aria-hidden="true" /> : null}
    </div>
  );
};

export default React.memo(RampLegend);
