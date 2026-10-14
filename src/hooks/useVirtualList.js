/**
 * 定高虚拟滚动
 *
 * 为什么自己写而不用 react-window / rc-virtual-list：
 * 1) 工程锁在 Node 12.20.1 + webpack 4，能少一个带现代语法的依赖就少一个坑；
 * 2) 需求极其收敛 —— 定高行、单向滚动、要能 scrollToIndex，百来行就够；
 * 3) 800 条数据时真正的开销不在「渲染多少 DOM」而在「滚动时重算多少」，
 *    自己写可以把 state 压到两个数字（scrollTop / viewportH），配合 rAF 合并。
 *
 * 结构约定（与 .mc-vlist 的样式对应）：
 *   <div ref={containerRef}>        滚动容器，overflow: auto
 *     <div style={sizerStyle}>      撑出总高度的占位
 *       <div style={windowStyle}>   绝对定位 + translateY，只放可视区那几行
 */

import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { useElementSize } from '../canvas/canvasUtils';

/**
 * @param {object} opts
 * @param {number} opts.count      总行数
 * @param {number} opts.rowHeight  行高（px，定高）
 * @param {number} [opts.overscan] 视口上下各多渲染几行，默认 6
 * @param {number} [opts.viewportH] 强制指定视口高度，默认从容器量
 */
export function useVirtualList(opts) {
  const count = opts.count || 0;
  const rowHeight = opts.rowHeight || 46;
  const overscan = opts.overscan == null ? 6 : opts.overscan;

  const containerRef = useRef(null);
  const { height: measuredH } = useElementSize(containerRef);
  const viewportH = opts.viewportH || measuredH || 0;

  const [scrollTop, setScrollTop] = useState(0);
  const rafRef = useRef(0);

  const totalHeight = count * rowHeight;

  const onScroll = useCallback(() => {
    //. 滚动事件在一帧内可能触发多次，合并到一次 rAF，避免每像素都 setState
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const el = containerRef.current;
      if (el) setScrollTop(el.scrollTop);
    });
  }, []);

  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    },
    []
  );

  const win = useMemo(() => {
    if (count === 0 || viewportH <= 0) {
      return { start: 0, end: 0, offsetY: 0, visible: 0 };
    }
    const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
    const visible = Math.ceil(viewportH / rowHeight);
    const end = Math.min(count, Math.floor(scrollTop / rowHeight) + visible + overscan + 1);
    return { start, end, offsetY: start * rowHeight, visible };
  }, [count, viewportH, scrollTop, rowHeight, overscan]);

  /** 滚动到第 index 行，align: 'auto' | 'center' | 'start' */
  const scrollToIndex = useCallback(
    (index, align) => {
      const el = containerRef.current;
      if (!el || count === 0) return;
      const i = Math.max(0, Math.min(count - 1, index));
      const rowTop = i * rowHeight;
      const h = el.clientHeight;
      let target;
      if (align === 'center') target = rowTop - (h - rowHeight) / 2;
      else if (align === 'start') target = rowTop;
      else {
        //. auto：已经在视野里就不动，减少「点一下列表跳一下」的抖动感
        if (rowTop >= el.scrollTop && rowTop + rowHeight <= el.scrollTop + h) return;
        target = rowTop < el.scrollTop ? rowTop - rowHeight : rowTop - h + rowHeight * 2;
      }
      el.scrollTop = Math.max(0, target);
      setScrollTop(el.scrollTop);
    },
    [count, rowHeight]
  );

  const sizerStyle = useMemo(() => ({ height: totalHeight }), [totalHeight]);
  const windowStyle = useMemo(
    () => ({ transform: 'translate3d(0,' + win.offsetY + 'px,0)' }),
    [win.offsetY]
  );

  return {
    containerRef,
    onScroll,
    totalHeight,
    start: win.start,
    end: win.end,
    sizerStyle,
    windowStyle,
    scrollToIndex,
    viewportH,
    scrollTop
  };
}

export default useVirtualList;
