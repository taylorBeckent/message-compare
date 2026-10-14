/**
 * DiffLite —— 不依赖 Monaco 的行级差异渲染器
 *
 * 存在的理由有两个：
 * 1) Monaco 精确视图很强，但它是「一次只看一条」的重型组件。
 *    列表内联预览、离线报告这类场景需要的是轻到可以铺开的行级渲染。
 * 2) 导出的 HTML 报告必须在没有 Monaco、没有任何 CDN 的环境里打开。
 *    DiffLite 的视觉规范（19px 行高、双行号、增删底色、行内高亮块）就是报告的视觉基准，
 *    两边看起来一致，用户在控制台和报告之间来回切才不会有割裂感。
 *
 * 渲染策略：hunk 折叠 + 行数闸门。
 * 报文动辄几千行但只有几处改动，折叠后通常只剩几十行；
 * 用户点「展开全部」时行数可能上万，所以再加一道分页闸门，避免一次性造出十万个 DOM 节点。
 *
 * 定位策略：所有行（含折叠条）统一 19px 定高，因此「跳到第 N 行」是纯算术，
 * 不需要为每一行挂 ref —— 上万行时挂 ref 本身就是可观的开销。
 */

import React, { useState, useEffect, useRef, useCallback, useMemo, forwardRef, useImperativeHandle } from 'react';
import { buildHunkViewWithGaps, ROW_CTX } from '../core/diffEngine';

/** 统一行高，必须与 app.less 里 .mc-diff 的 line-height 保持一致 */
export const LITE_ROW_H = 19;
/** 单次渲染的行数上限，超出部分点「继续加载」 */
const PAGE_ROWS = 1200;

/** 行内高亮片段。g 形如 [['<Amount>', 0], ['100.50', 1]] */
function CodeBody(props) {
  const row = props.row;
  if (!row.g || row.g.length === 0) return row.s;

  const out = [];
  for (let i = 0; i < row.g.length; i += 1) {
    const seg = row.g[i];
    if (seg[1]) out.push(<span className="mc-diff__mark" key={i}>{seg[0]}</span>);
    else out.push(seg[0]);
  }
  return out;
}

const DiffRow = React.memo(function DiffRow(props) {
  const row = props.row;
  const mod = row.t === '+' ? ' mc-diff__row--add' : row.t === '-' ? ' mc-diff__row--del' : '';
  const sign = row.t === '+' ? '+' : row.t === '-' ? '-' : ' ';

  return (
    <div className={'mc-diff__row' + mod}>
      <span className="mc-diff__no">{row.l == null ? '' : row.l}</span>
      <span className="mc-diff__no">{row.r == null ? '' : row.r}</span>
      <span className="mc-diff__sign">{sign}</span>
      <span className="mc-diff__code">
        <CodeBody row={row} />
      </span>
    </div>
  );
});

const DiffLite = forwardRef(function DiffLite(props, ref) {
  const {
    rows,
    context,
    expandAll,
    openGaps,
    onToggleGap,
    wrap,
    statusText,
    onFirstChangeReady
  } = props;

  const [limit, setLimit] = useState(PAGE_ROWS);
  const scrollRef = useRef(null);

  const rowCount = rows ? rows.length : 0;

  //. 换了记录 / 换了折叠口径，分页要重来，否则用户会停在一个莫名其妙的深处
  useEffect(() => {
    setLimit(PAGE_ROWS);
  }, [rowCount, expandAll, context]);

  const view = useMemo(
    () => buildHunkViewWithGaps(rows || [], context == null ? 3 : context, !!expandAll, openGaps),
    [rows, context, expandAll, openGaps]
  );

  //. 第一处差异的位置：切记录时自动滚过去，省掉用户自己找的动作
  const firstChange = useMemo(() => {
    for (let i = 0; i < view.length; i += 1) {
      const t = view[i].t;
      if (t !== ROW_CTX && t !== 'gap') return i;
    }
    return -1;
  }, [view]);

  useEffect(() => {
    if (onFirstChangeReady) onFirstChangeReady(firstChange);
  }, [firstChange, onFirstChangeReady]);

  const shown = view.length > limit ? view.slice(0, limit) : view;
  const rest = view.length - shown.length;

  const scrollToViewIndex = useCallback((idx) => {
    const el = scrollRef.current;
    if (!el || idx < 0) return;
    const top = idx * LITE_ROW_H;
    const h = el.clientHeight;
    if (top < el.scrollTop || top + LITE_ROW_H > el.scrollTop + h) {
      el.scrollTop = Math.max(0, top - Math.round(h * 0.3));
    }
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      scrollToViewIndex,
      scrollToFirstChange() {
        scrollToViewIndex(firstChange);
      },
      firstChangeIndex() {
        return firstChange;
      },
      viewLength() {
        return view.length;
      },
      loadMore() {
        setLimit((v) => v + PAGE_ROWS);
      },
      getScrollEl() {
        return scrollRef.current;
      }
    }),
    [scrollToViewIndex, firstChange, view.length]
  );

  const handleGapKey = (e, key) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onToggleGap(key);
    }
  };

  const items = [];
  for (let i = 0; i < shown.length; i += 1) {
    const row = shown[i];
    if (row.t === 'gap') {
      items.push(
        <div
          key={'g' + row.key}
          className={'mc-diff__gap' + (row.open ? ' mc-diff__gap--open' : '')}
          role="button"
          tabIndex={0}
          aria-expanded={row.open ? 'true' : 'false'}
          onClick={onToggleGap ? () => onToggleGap(row.key) : undefined}
          onKeyDown={onToggleGap ? (e) => handleGapKey(e, row.key) : undefined}
        >
          <span>{row.open ? '收起 ' + row.n + ' 行未变更内容' : '展开 ' + row.n + ' 行未变更内容'}</span>
        </div>
      );
    } else {
      items.push(<DiffRow key={i} row={row} />);
    }
  }

  return (
    <div className="mc-diff" ref={scrollRef} role="region" aria-label="报文差异明细">
      <div className={'mc-diff__inner' + (wrap ? ' mc-diff__inner--wrap' : '')}>{items}</div>

      {rest > 0 && (
        <div className="mc-diff__more">
          <button type="button" onClick={() => setLimit(limit + PAGE_ROWS)}>
            继续加载 {rest > PAGE_ROWS ? PAGE_ROWS : rest} 行 · 剩余 {rest} 行
          </button>
        </div>
      )}

      {statusText && <div className="mc-diff__status">{statusText}</div>}
    </div>
  );
});

export default DiffLite;
