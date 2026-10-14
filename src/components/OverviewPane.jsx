/**
 * OverviewPane —— 左栏热力总览
 *
 * 这一栏回答的是「几百条里，问题在哪、有多严重」，而不是「某一条差在哪」。
 *
 * 为什么是热力矩阵而不是列表 / 饼图：
 *   · 800 个色块铺成矩阵，一屏就能看完，人眼对「一片绿里几点红」的检出速度极快；
 *   · 色块位置 = 记录序号，所以异常在批次里的分布规律也能看出来
 *     （集中在开头通常是初始化问题，均匀散布通常是链路抖动，这个信息列表给不了）；
 *   · 饼图只能给比例，给不了位置。
 *
 * 色标走感知曲线 severity^0.4：真实报文的差异率大量落在 0.02~0.06，
 * 线性映射会让整张图都是深绿，红的那几个反而不突出。
 */

import React, { useMemo } from 'react';
import { Tooltip } from 'antd';
import HeatmapMatrix from '../canvas/HeatmapMatrix';
import RampLegend from '../gl/RampLegend';
import { STATUS_COLOR, STATUS_LABEL } from '../core/palette';

const DIST_ORDER = ['changed', 'identical', 'missing', 'error', 'pending'];

const OverviewPane = (props) => {
  const {
    records,
    version,
    visibleMap,
    selectedIndex,
    running,
    summary,
    onPickRecord,
    statusFilter,
    onStatusFilter
  } = props;

  const total = records ? records.length : 0;

  //. 分布条的分段：pending 和 running 合成一段，比对进行中时它们是一回事
  const dist = useMemo(() => {
    const s = summary || { total: 0 };
    const pending = (s.pending || 0) + (s.running || 0);
    return DIST_ORDER.map((k) => {
      const n = k === 'pending' ? pending : s[k] || 0;
      return {
        key: k,
        //. 「有差异」这一桶对外的筛选口径统一叫 'diff'，和顶栏统计条一致，
        //. 否则两处高亮会各说各话（一个认 'changed'、一个认 'diff'）
        filterKey: k === 'changed' ? 'diff' : k,
        n,
        pct: total > 0 ? (n / total) * 100 : 0,
        color: STATUS_COLOR[k],
        label: k === 'pending' ? '待比对' : STATUS_LABEL[k]
      };
    });
  }, [summary, total, version]); //. eslint-disable-line react-hooks/exhaustive-deps

  const maxSeverity = summary ? summary.maxSeverity || 0 : 0;

  return (
    <div className="mc-pane mc-pane--overview">
      <div className="mc-pane__head">
        <div className="mc-pane__title">
          <span>热力总览</span>
          <span className="mc-num" style={{ color: 'var(--mc-text-mid)' }}>
            {total}
          </span>
        </div>
      </div>

      <div className="mc-pane__body">
        <div className="mc-overview mc-scroll">
          <HeatmapMatrix
            records={records || []}
            version={version}
            visibleMap={visibleMap}
            selectedIndex={selectedIndex}
            running={running}
            onSelect={onPickRecord}
          />

          <div className="mc-legend">
            <div className="mc-legend__title">差异严重度</div>
            <div className="mc-ramp">
              <RampLegend width={232} />
            </div>
            <div className="mc-legend__row">
              <span>一致</span>
              <span>峰值 {(maxSeverity * 100).toFixed(1)}%</span>
              <span>面目全非</span>
            </div>
          </div>

          <div className="mc-dist">
            <div className="mc-dist__title">状态分布</div>
            <div className="mc-dist__bar" role="img" aria-label="状态分布条">
              {dist.map((d) =>
                d.n > 0 ? (
                  <Tooltip key={d.key} title={d.label + ' ' + d.n + ' 条'} mouseEnterDelay={0.2}>
                    <div
                      className="mc-dist__seg"
                      style={{ width: d.pct + '%', background: d.color }}
                    />
                  </Tooltip>
                ) : null
              )}
            </div>
            <div className="mc-dist__list">
              {dist.map((d) => {
                //. 左栏用「待比对」这一个桶（pending + running），中栏的筛选项里
                //. 'pending' 的口径也是「pending 或 running」，两边对得上
                const active = statusFilter === d.filterKey;
                return (
                  <button
                    key={d.key}
                    type="button"
                    className="mc-dist__item"
                    onClick={() => onStatusFilter(statusFilter === d.filterKey ? 'all' : d.filterKey)}
                    style={active ? { background: 'rgba(255,255,255,0.06)', color: 'var(--mc-text-hi)' } : undefined}
                    aria-pressed={active ? 'true' : 'false'}
                  >
                    <span className="mc-dist__dot" style={{ background: d.color }} />
                    {d.label}
                    <span className="mc-dist__n">{d.n}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mc-hint">
            点击色块直接定位记录；灰色 = 被中栏筛选条件排除。
            <br />
            空心 = 单侧报文为空，斜纹 = 解析异常。
          </div>
        </div>
      </div>
    </div>
  );
};

export default React.memo(OverviewPane);
