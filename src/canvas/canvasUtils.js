/**
 * Canvas 通用工具
 *
 * 所有自绘画布共用：高分屏适配、容器尺寸监听、动效偏好、缓动函数。
 */

import { useEffect, useRef, useState, useCallback } from 'react';

/**
 * 按 devicePixelRatio 配置画布，返回已经 scale 好的 2d 上下文。
 * 之后所有绘制都用 CSS 像素坐标，不用自己乘 dpr。
 *
 * dpr 上限压到 2：4K 屏上 dpr=3 会让填充率翻 9 倍，
 * 而热力矩阵这种密集小色块在 dpr>2 之后肉眼已经分不出差别。
 */
export function setupHiDpi(canvas, cssWidth, cssHeight) {
  const dpr = Math.min(typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1, 2);
  const w = Math.max(1, Math.round(cssWidth));
  const h = Math.max(1, Math.round(cssHeight));

  //. 尺寸没变时不要重设 width/height —— 重设会清空画布并触发重新分配显存
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/** 监听元素尺寸变化，返回 [width, height]。优先 ResizeObserver，老浏览器退回 window.resize */
export function useElementSize(ref) {
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = ref && ref.current;
    if (!el) return undefined;

    let raf = 0;
    const read = () => {
      raf = 0;
      const rect = el.getBoundingClientRect();
      setSize((prev) => {
        if (Math.abs(prev.width - rect.width) < 0.5 && Math.abs(prev.height - rect.height) < 0.5) return prev;
        return { width: rect.width, height: rect.height };
      });
    };
    const schedule = () => {
      //. 合并同一帧内的多次回调，resize 时不至于每像素都重排
      if (!raf) raf = requestAnimationFrame(read);
    };

    read();

    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(schedule);
      ro.observe(el);
      window.addEventListener('resize', schedule);
      return () => {
        if (raf) cancelAnimationFrame(raf);
        ro.disconnect();
        window.removeEventListener('resize', schedule);
      };
    }

    window.addEventListener('resize', schedule);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', schedule);
    };
  }, [ref]);

  return size;
}

/** 用户是否要求减少动效（系统级设置） */
export function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(mq.matches);
    //. Safari 13 及更早只有 addListener
    if (mq.addEventListener) {
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }
    mq.addListener(onChange);
    return () => mq.removeListener(onChange);
  }, []);

  return reduced;
}

/** 页面是否可见，用于暂停离屏的 rAF 循环 */
export function usePageVisible() {
  const [visible, setVisible] = useState(typeof document === 'undefined' ? true : !document.hidden);
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const onChange = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return visible;
}

export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 圆角矩形。
 * 手写而不用 ctx.roundRect —— 后者是 2023 年才进标准的，
 * 内网机器上的老 Chrome 根本没有。
 */
export function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

/** 稳定的 rAF 循环封装，自动处理卸载与页面不可见 */
export function useAnimationLoop(active, onFrame) {
  const cbRef = useRef(onFrame);
  cbRef.current = onFrame;

  const tick = useCallback(
    (ts) => {
      cbRef.current(ts);
    },
    []
  );

  useEffect(() => {
    if (!active) return undefined;
    let raf = 0;
    let running = true;
    const loop = (ts) => {
      if (!running) return;
      tick(ts);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
    };
  }, [active, tick]);
}
