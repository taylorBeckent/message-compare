/**
 * 进度环（Canvas2D）
 *
 * 用在两个地方：比对进行中（header）、报告生成中（下载弹窗）。
 * 数值不是直接画到目标值，而是每帧向目标缓动 —— 分片调度的进度是跳跃式的
 * （一批一批往上蹦），直接画会显得卡顿；缓动之后视觉上是一条连续生长的弧。
 *
 * 绘制逻辑挂在 ref 上由 rAF 直接调用，而不是「setState 触发 effect 再画」：
 * 不定量模式需要每帧重绘，走 state 会因为值没变化被 React bail out，动画直接僵住。
 */

import React, { useRef, useEffect, useCallback } from 'react';
import { usePrefersReducedMotion } from './canvasUtils';

const ProgressRing = (props) => {
    const { progress, size, stroke, color, indeterminate, label, sublabel } = props;
    const s = size || 44;
    const sw = stroke || 3.5;
    const reduced = usePrefersReducedMotion();

    const canvasRef = useRef(null);
    const displayRef = useRef(0);
    const labelRef = useRef(null);

    const target = Math.max(0, Math.min(1, progress || 0));

    const paint = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const px = Math.round(s * dpr);
        if (canvas.width !== px) {
            canvas.width = px;
            canvas.height = px;
        }
        canvas.style.width = s + 'px';
        canvas.style.height = s + 'px';

        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, s, s);

        const cx = s / 2;
        const cy = s / 2;
        const r = s / 2 - sw / 2 - 1;
        const START = -Math.PI / 2;
        const accent = color || '#35c2a5';

        //. 轨道
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.07)';
        ctx.lineWidth = sw;
        ctx.stroke();

        if (indeterminate) {
            //. 不定量：一段 100° 的弧匀速转圈
            const t = (Date.now() % 1400) / 1400;
            ctx.beginPath();
            ctx.arc(cx, cy, r, START + t * Math.PI * 2, START + t * Math.PI * 2 + 1.75);
            ctx.strokeStyle = accent;
            ctx.lineWidth = sw;
            ctx.lineCap = 'round';
            ctx.stroke();
            return;
        }

        const p = Math.max(0, Math.min(1, displayRef.current));
        if (p > 0.0005) {
            ctx.save();
            ctx.shadowColor = accent;
            ctx.shadowBlur = 7;
            ctx.beginPath();
            ctx.arc(cx, cy, r, START, START + p * Math.PI * 2);
            ctx.strokeStyle = accent;
            ctx.lineWidth = sw;
            ctx.lineCap = 'round';
            ctx.stroke();
            ctx.restore();

            //. 弧端亮点
            const ang = START + p * Math.PI * 2;
            ctx.beginPath();
            ctx.arc(cx + Math.cos(ang) * r, cy + Math.sin(ang) * r, Math.max(0.8, sw * 0.42), 0, Math.PI * 2);
            ctx.fillStyle = '#ffffff';
            ctx.globalAlpha = 0.85;
            ctx.fill();
            ctx.globalAlpha = 1;
        }

        if (labelRef.current) {
            labelRef.current.textContent = label != null ? label : Math.round(p * 100) + '%';
        }
    }, [s, sw, color, indeterminate, label]);

    const paintRef = useRef(paint);
    paintRef.current = paint;

    //. 数值缓动
    useEffect(() => {
        if (reduced) {
            displayRef.current = target;
            paintRef.current();
            return undefined;
        }
        let raf = 0;
        let running = true;
        const step = () => {
            if (!running) return;
            const cur = displayRef.current;
            const diff = target - cur;
            if (Math.abs(diff) < 0.0015) {
                displayRef.current = target;
                paintRef.current();
                return;
            }
            //. 指数缓动：距离越远追得越快，接近时无声落位
            displayRef.current = cur + diff * 0.18;
            paintRef.current();
            raf = requestAnimationFrame(step);
        };
        raf = requestAnimationFrame(step);
        return () => {
            running = false;
            cancelAnimationFrame(raf);
        };
    }, [target, reduced]);

    //. 尺寸 / 配色变化后补画一次；不定量模式则持续转
    useEffect(() => {
        paint();
        if (!indeterminate) return undefined;
        let raf = 0;
        let running = true;
        const loop = () => {
            if (!running) return;
            paintRef.current();
            raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
        return () => {
            running = false;
            cancelAnimationFrame(raf);
        };
    }, [paint, indeterminate]);

    return (
        <span className="mc-ring" style={{ width: `${s + 70}px`, height: s }}>
            <span className="mc-ring__text">
                <b ref={labelRef}>{label != null ? label : '0%'}</b>
                {sublabel ? <i>{sublabel}</i> : null}
            </span>
            <canvas ref={canvasRef} width={s} height={s} aria-hidden="true" />
        </span>
    );
};

export default React.memo(ProgressRing);
