/**
 * 全局热力总览（Canvas2D）
 *
 * 这是整个控制台的第一视觉入口：几百条记录铺成一张密集色块矩阵，
 * 差异越大颜色越暖。用户不需要读任何文字就能看出「这批数据大概哪儿出问题了」，
 * 点一下直接跳到那条。
 *
 * 为什么用 Canvas 而不是 DOM：
 * 800 条记录如果用 div 渲染，就是 800 个节点 + 800 次样式计算，
 * 滚动和 hover 都会掉帧；画布上是一次 fillRect 循环，重绘在 1ms 量级，
 * 而且能做扫光、呼吸这些 DOM 做不动的效果。
 *
 * 无障碍：画布本身对读屏软件不可见，所以外层给了 role/aria-label，
 * 真正的键盘可达路径是中间的记录列表（可 Tab、可方向键）。
 */

import React, { useRef, useEffect, useState, useCallback } from 'react';
import {
  setupHiDpi,
  useElementSize,
  usePrefersReducedMotion,
  clamp,
  roundRectPath
} from './canvasUtils';
import { severityRgb, severityToRampT, STATUS_COLOR } from '../core/palette';

const PITCH_MIN = 4.5;
const PITCH_MAX = 15;

function cellColor(rec) {
  switch (rec.status) {
    case 'identical':
      return severityRgb(0);
    case 'changed':
      return severityRgb(severityToRampT(rec.stats ? rec.stats.severity : 0));
    case 'missing':
      return severityRgb(1);
    case 'error':
      return [139, 149, 165];
    case 'running':
      return [53, 194, 165];
    default:
      return [42, 50, 61];
  }
}

const HeatmapMatrix = (props) => {
  const { records, version, visibleMap, selectedIndex, running, onSelect } = props;

  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const tipRef = useRef(null);
  const size = useElementSize(wrapRef);

  const reduced = usePrefersReducedMotion();
  const geoRef = useRef({ cols: 0, pitch: 0, cell: 0, ox: 0, oy: 0, rows: 0 });
  const hoverRef = useRef(-1);
  const revealRef = useRef({ active: false, start: 0, front: 0 });

  const [hoverIndex, setHoverIndex] = useState(-1);

  // ---- 绘制 ---------------------------------------------------------------

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.width < 2 || size.height < 2) return;

    const ctx = setupHiDpi(canvas, size.width, size.height);
    if (!ctx) return;

    const n = records.length;
    ctx.clearRect(0, 0, size.width, size.height);
    if (n === 0) return;

    //. 自动算格子间距：让整张矩阵刚好铺满可用区域，
    //. 150 条和 800 条都不需要滚动，「一眼看全局」才算成立。
    const pitch = clamp(Math.sqrt((size.width * size.height) / n), PITCH_MIN, PITCH_MAX);
    const cols = Math.max(1, Math.floor(size.width / pitch));
    const rows = Math.ceil(n / cols);
    const cell = Math.max(1.5, pitch - Math.max(1, pitch * 0.2));
    const ox = (size.width - cols * pitch) / 2;
    const oy = (size.height - rows * pitch) / 2;
    geoRef.current = { cols, pitch, cell, ox, oy, rows };

    const reveal = revealRef.current;
    const front = reveal.active ? reveal.front : n + 1;

    for (let i = 0; i < n; i += 1) {
      const rec = records[i];
      const col = i % cols;
      const row = (i / cols) | 0;
      const x = ox + col * pitch;
      const y = oy + row * pitch;

      //. 扫光揭示：数据刚载入时色块从左到右依次亮起
      let alpha = 1;
      if (reveal.active) alpha = clamp(front - i, 0, 1);
      if (alpha <= 0.01) continue;

      //. 被筛选掉的记录压暗，但不隐藏 —— 保留「它在整批里的位置」这个信息
      const dimmed = visibleMap ? !visibleMap[rec.id] : false;
      const a = alpha * (dimmed ? 0.13 : 1);

      const c = cellColor(rec);
      ctx.fillStyle = 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';

      if (rec.status === 'pending' && !running) {
        //. 未比对：只描边不填充，和「已比对但完全一致」区分开
        ctx.strokeStyle = 'rgba(120,132,148,' + a * 0.5 + ')';
        ctx.lineWidth = 1;
        roundRectPath(ctx, x + 0.5, y + 0.5, cell - 1, cell - 1, cell > 7 ? 2 : 0);
        ctx.stroke();
      } else if (cell > 7) {
        roundRectPath(ctx, x, y, cell, cell, 2);
        ctx.fill();
      } else {
        ctx.fillRect(x, y, cell, cell);
      }

      //. 单侧为空：中心镂空，区别于「整份报文都不一样」
      if (rec.status === 'missing' && cell > 5) {
        ctx.fillStyle = 'rgba(14,18,24,' + a * 0.85 + ')';
        const inset = cell * 0.32;
        ctx.fillRect(x + inset, y + inset, cell - inset * 2, cell - inset * 2);
      }

      //. 异常：斜纹覆盖，不占用色相通道（红已经被「重大差异」占了）
      if (rec.status === 'error' && cell > 5) {
        ctx.save();
        roundRectPath(ctx, x, y, cell, cell, 2);
        ctx.clip();
        ctx.strokeStyle = 'rgba(224,87,79,' + a * 0.9 + ')';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let k = -cell; k < cell * 2; k += 3) {
          ctx.moveTo(x + k, y);
          ctx.lineTo(x + k - cell, y + cell);
        }
        ctx.stroke();
        ctx.restore();
      }

      //. 比对进行中：正在处理的那条呼吸一下
      if (rec.status === 'running' && cell > 4) {
        ctx.strokeStyle = 'rgba(53,194,165,' + a * 0.9 + ')';
        ctx.lineWidth = 1;
        roundRectPath(ctx, x - 0.5, y - 0.5, cell + 1, cell + 1, cell > 7 ? 2.5 : 0);
        ctx.stroke();
      }
    }

    // ---- 选中 / 悬停描边（画在所有色块之上，避免被后画的盖住） ----
    const markRing = (index, color, width, pad) => {
      if (index < 0 || index >= n) return;
      const col = index % cols;
      const row = (index / cols) | 0;
      const x = ox + col * pitch - pad;
      const y = oy + row * pitch - pad;
      const s = cell + pad * 2;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      roundRectPath(ctx, x, y, s, s, s > 9 ? 3 : 1);
      ctx.stroke();
    };

    const hoverIdx = hoverRef.current;
    const selIdx = typeof selectedIndex === 'number' ? selectedIndex : -1;
    if (hoverIdx >= 0 && hoverIdx !== selIdx) markRing(hoverIdx, 'rgba(232,237,244,0.55)', 1, 1.5);

    if (selIdx >= 0) {
      //. 外发光 + 实线双描边，让选中项在密集色块里绝对不会看丢
      ctx.save();
      ctx.shadowColor = 'rgba(53,194,165,0.85)';
      ctx.shadowBlur = 8;
      markRing(selIdx, '#35c2a5', 1.6, 2);
      ctx.restore();
      markRing(selIdx, 'rgba(255,255,255,0.75)', 0.8, 2);
    }
  }, [records, size.width, size.height, visibleMap, selectedIndex, running]);

  //. 动画循环里用 ref 取最新的 draw，避免闭包捕获到旧版本
  const drawRef = useRef(draw);
  drawRef.current = draw;

  // ---- 扫光动画 -----------------------------------------------------------

  const total = records.length;
  useEffect(() => {
    if (reduced || total === 0) {
      revealRef.current = { active: false, start: 0, front: total + 1 };
      return undefined;
    }
    const state = { active: true, start: 0, front: 0 };
    revealRef.current = state;

    let raf = 0;
    const DURATION = 720;
    const step = (ts) => {
      if (!state.start) state.start = ts;
      const p = clamp((ts - state.start) / DURATION, 0, 1);
      //. 缓出：开头快、结尾慢，扫光尾部自然消散
      const eased = 1 - Math.pow(1 - p, 3);
      state.front = eased * (total + 40);
      revealRef.current = state;
      drawRef.current();
      if (p < 1) {
        raf = requestAnimationFrame(step);
      } else {
        state.active = false;
        revealRef.current = state;
        drawRef.current();
      }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    //. 只在数据条数变化时重放扫光；比对进度的重绘走下面那个 effect
  }, [total, reduced]);

  useEffect(() => {
    draw();
  }, [draw, version]);

  // ---- 交互 ---------------------------------------------------------------

  const hitTest = useCallback((clientX, clientY) => {
    const canvas = canvasRef.current;
    if (!canvas) return -1;
    const rect = canvas.getBoundingClientRect();
    const g = geoRef.current;
    if (!g.cols) return -1;

    const col = Math.floor((clientX - rect.left - g.ox) / g.pitch);
    const row = Math.floor((clientY - rect.top - g.oy) / g.pitch);
    if (col < 0 || col >= g.cols || row < 0 || row >= g.rows) return -1;

    const idx = row * g.cols + col;
    return idx >= 0 && idx < records.length ? idx : -1;
  }, [records]);

  /**
   * 提示框跟随鼠标用直接改 DOM 的方式，不走 setState。
   * mousemove 一秒能触发上百次，如果每次都重渲染，
   * 画布重绘 + React 协调叠加起来就能感觉到粘滞。
   */
  const moveTip = (clientX, clientY) => {
    const tip = tipRef.current;
    const wrap = wrapRef.current;
    if (!tip || !wrap) return;
    const rect = wrap.getBoundingClientRect();
    const x = clamp(clientX - rect.left + 14, 6, Math.max(6, rect.width - 196));
    const y = clamp(clientY - rect.top - 12, 4, Math.max(4, rect.height - 80));
    tip.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
  };

  const handleMove = useCallback(
    (e) => {
      const idx = hitTest(e.clientX, e.clientY);
      if (idx !== hoverRef.current) {
        hoverRef.current = idx;
        setHoverIndex(idx);
        drawRef.current();
      }
      if (idx >= 0) moveTip(e.clientX, e.clientY);
    },
    [hitTest]
  );

  const handleLeave = useCallback(() => {
    if (hoverRef.current !== -1) {
      hoverRef.current = -1;
      setHoverIndex(-1);
      drawRef.current();
    }
  }, []);

  const handleClick = useCallback(
    (e) => {
      const idx = hitTest(e.clientX, e.clientY);
      if (idx >= 0 && onSelect) onSelect(records[idx], idx);
    },
    [hitTest, onSelect, records]
  );

  const hoverRec = hoverIndex >= 0 ? records[hoverIndex] : null;

  return (
    <div className="mc-heatmap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="mc-heatmap__canvas"
        role="img"
        aria-label={'差异热力总览，共 ' + total + ' 条记录，颜色越暖代表差异越大'}
        onMouseMove={handleMove}
        onMouseLeave={handleLeave}
        onClick={handleClick}
      />
      <div
        ref={tipRef}
        className="mc-heatmap__tip"
        style={{ visibility: hoverRec ? 'visible' : 'hidden' }}
      >
        {hoverRec ? (
          <React.Fragment>
            <div className="mc-heatmap__tip-title">
              <span className="mc-heatmap__tip-seq">#{hoverRec.seq}</span>
              {hoverRec.bizLabel}
            </div>
            <div className="mc-heatmap__tip-row">
              <span>{hoverRec.left_name}</span>
              <em>vs</em>
              <span>{hoverRec.right_name}</span>
            </div>
            <div className="mc-heatmap__tip-row mc-heatmap__tip-row--sub">
              {hoverRec.status === 'pending'
                ? '待比对'
                : hoverRec.stats
                  ? hoverRec.stats.identical
                    ? '完全一致'
                    : '差异 ' + (hoverRec.stats.added + hoverRec.stats.removed) + ' 行 · ' + (hoverRec.stats.severity * 100).toFixed(1) + '%'
                  : '—'}
            </div>
          </React.Fragment>
        ) : null}
      </div>
    </div>
  );
};

export default React.memo(HeatmapMatrix);
