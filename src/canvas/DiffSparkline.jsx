/**
 * 单条记录的差异分布条带（Canvas2D）
 *
 * 借鉴 GitHub PR 文件列表里那根 diff bar：新增往上、删除往下，从中心轴向两侧生长。
 * 它回答的问题是「差异集中在报文的哪个部位」——
 * 头部字段变了和明细区大面积变了，是完全不同的排查路径，光看「差异 12 行」这个数字看不出来。
 *
 * 每行列表项一个小画布，30 个可见行 = 30 次微型重绘，单次约 0.1ms，滚动不会掉帧。
 */

import React, { useRef, useEffect } from 'react';
import { severityRgb, severityToRampT } from '../core/palette';

const ADD_COLOR = '#4f9d69';
const DEL_COLOR = '#e0574f';

const DiffSparkline = (props) => {
  const { spark, status, severity, width, height, active } = props;
  const w = width || 54;
  const h = height || 13;
  const ref = useRef(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const mid = Math.round(h / 2) + 0.5;
    const half = (h - 3) / 2;

    //. 中心轴
    ctx.fillStyle = active ? 'rgba(232,237,244,0.28)' : 'rgba(232,237,244,0.10)';
    ctx.fillRect(0, mid - 0.5, w, 1);

    if (status === 'pending') return;

    //. 一致：一条安静的绿线，不抢视线
    if (status === 'identical') {
      ctx.fillStyle = active ? 'rgba(79,157,105,0.75)' : 'rgba(79,157,105,0.35)';
      ctx.fillRect(0, mid - 1.5, w, 1);
      return;
    }

    if (status === 'error') {
      ctx.strokeStyle = 'rgba(139,149,165,0.7)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = -h; x < w; x += 4) {
        ctx.moveTo(x, h);
        ctx.lineTo(x + h, 0);
      }
      ctx.stroke();
      return;
    }

    const s = spark || '';
    const len = s.length;
    if (len === 0) return;

    //. 按像素列聚合：一列可能对应多行，先统计再画，避免重复覆盖同一像素
    const addPerCol = new Float32Array(w);
    const delPerCol = new Float32Array(w);
    for (let i = 0; i < len; i += 1) {
      const ch = s.charCodeAt(i);
      if (ch === 43) addPerCol[Math.min(w - 1, (i / len * w) | 0)] += 1;       // '+'
      else if (ch === 45) delPerCol[Math.min(w - 1, (i / len * w) | 0)] += 1;   // '-'
    }

    //. 每列最多几行，用来归一化条形高度
    let peak = 1;
    for (let x = 0; x < w; x += 1) {
      if (addPerCol[x] > peak) peak = addPerCol[x];
      if (delPerCol[x] > peak) peak = delPerCol[x];
    }

    const tint = severityRgb(severityToRampT(severity || 0));
    const tintCss = 'rgb(' + tint[0] + ',' + tint[1] + ',' + tint[2] + ')';

    for (let x = 0; x < w; x += 1) {
      const a = addPerCol[x];
      const d = delPerCol[x];
      if (a > 0) {
        const hh = Math.max(1.5, (a / peak) * half);
        ctx.fillStyle = a / peak > 0.35 ? tintCss : ADD_COLOR;
        ctx.globalAlpha = active ? 1 : 0.85;
        ctx.fillRect(x, mid - 1 - hh, 1, hh);
      }
      if (d > 0) {
        const hh = Math.max(1.5, (d / peak) * half);
        ctx.fillStyle = d / peak > 0.35 ? tintCss : DEL_COLOR;
        ctx.globalAlpha = active ? 1 : 0.85;
        ctx.fillRect(x, mid + 1, 1, hh);
      }
    }
    ctx.globalAlpha = 1;
  }, [spark, status, severity, w, h, active]);

  return (
    <canvas
      ref={ref}
      className="mc-spark"
      aria-hidden="true"
      width={w}
      height={h}
      style={{ width: w, height: h }}
    />
  );
};

export default React.memo(DiffSparkline);
