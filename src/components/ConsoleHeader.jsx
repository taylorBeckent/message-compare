/**
 * ConsoleHeader —— 顶部控制台条
 *
 * 一条 58px 的横条里塞了四件事：数据组选择、批量比对控制、实时统计、导出入口。
 *
 * 统计数字全部做成可点击的筛选器 —— 看到「有差异 137」，
 * 下一个动作几乎必然是「只看这 137 条」。把这个动作做成一次点击，
 * 比让用户去中栏找筛选控件再点一遍要顺得多。
 *
 * 进度环放在按钮旁边而不是页面顶部：批量比对是这一屏的主操作，
 * 进度应该和操作它的控件在一起，视线不用来回扫。
 */

import React from 'react';
import { Select, Button, Tooltip } from 'antd';
import {
  PlayCircleOutlined,
  PauseCircleOutlined,
  CloseCircleOutlined,
  DownloadOutlined,
  ReloadOutlined
} from '@ant-design/icons';
import ProgressRing from '../canvas/ProgressRing';
import { STATUS_COLOR } from '../core/palette';

function StatItem(props) {
  const { n, label, color, active, onClick } = props;
  return (
    <button
      type="button"
      className={'mc-stats__item' + (active ? ' mc-stats__item--active' : '')}
      onClick={onClick}
      aria-pressed={active ? 'true' : 'false'}
      title={'点击' + (active ? '取消' : '') + '筛选：' + label}
    >
      {color ? <span className="mc-stats__dot" style={{ background: color }} /> : null}
      <span className="mc-stats__n" style={color ? { color } : undefined}>
        {n}
      </span>
      <span className="mc-stats__k">{label}</span>
    </button>
  );
}

const ConsoleHeader = (props) => {
  const {
    groupDefs,
    groupId,
    groupDesc,
    onGroupChange,
    running,
    paused,
    progress,
    processed,
    total,
    summary,
    statusFilter,
    onStatusFilter,
    onRun,
    onPause,
    onResume,
    onCancel,
    onExport,
    onReset,
    canExport,
    canRun
  } = props;

  const s = summary || {};

  return (
    <header className="mc-header">
      <div className="mc-header__brand">
        <span className="mc-header__mark" aria-hidden="true" />
        <span>
          <div className="mc-header__title">报文批量比对控制台</div>
          <div className="mc-header__sub">Message Compare Studio</div>
        </span>
      </div>

      <span className="mc-header__sep" />

      <div className="mc-header__group">
        <span className="mc-header__label">数据组</span>
        <Select
          size="small"
          value={groupId}
          onChange={onGroupChange}
          disabled={running}
          style={{ width: '100%' }}
          optionLabelProp="label"
          aria-label="选择数据组"
        >
          {groupDefs.map((g) => (
            <Select.Option key={g.id} value={g.id} label={g.name}>
              <div style={{ lineHeight: 1.4 }}>
                <div>{g.name}</div>
                <div style={{ fontSize: 11, color: '#8b95a5' }}>
                  {g.count} 条 · {g.format} · {g.ordered ? '顺序敏感' : '忽略顺序'}
                </div>
              </div>
            </Select.Option>
          ))}
        </Select>
      </div>

      <div className="mc-stats" role="group" aria-label="比对结果统计">
        <StatItem
          n={s.total || 0}
          label="总计"
          active={statusFilter === 'all'}
          onClick={() => onStatusFilter('all')}
        />
        <StatItem
          n={s.changed || 0}
          label="有差异"
          color={STATUS_COLOR.changed}
          active={statusFilter === 'diff'}
          onClick={() => onStatusFilter(statusFilter === 'diff' ? 'all' : 'diff')}
        />
        <StatItem
          n={s.identical || 0}
          label="一致"
          color={STATUS_COLOR.identical}
          active={statusFilter === 'identical'}
          onClick={() => onStatusFilter(statusFilter === 'identical' ? 'all' : 'identical')}
        />
        <StatItem
          n={s.missing || 0}
          label="单侧空"
          color={STATUS_COLOR.missing}
          active={statusFilter === 'missing'}
          onClick={() => onStatusFilter(statusFilter === 'missing' ? 'all' : 'missing')}
        />
        <StatItem
          n={s.error || 0}
          label="异常"
          color="#8b95a5"
          active={statusFilter === 'error'}
          onClick={() => onStatusFilter(statusFilter === 'error' ? 'all' : 'error')}
        />
      </div>

      <span className="mc-header__spacer" />

      <div className="mc-header__run">
        {running || processed > 0 ? (
          <ProgressRing
            progress={running ? progress : 1}
            size={30}
            stroke={2.5}
            indeterminate={running && paused}
            label={running ? Math.round(progress * 100) + '%' : '100%'}
            // label={running ? Math.round(progress * 100) + '%' : '完成'}
            sublabel={processed + '/' + total}
          />
        ) : null}

        {running ? (
          <React.Fragment>
            <Button size="small" icon={paused ? <PlayCircleOutlined /> : <PauseCircleOutlined />} onClick={paused ? onResume : onPause}>
              {paused ? '继续' : '暂停'}
            </Button>
            <Button size="small" danger icon={<CloseCircleOutlined />} onClick={onCancel}>
              终止
            </Button>
          </React.Fragment>
        ) : (
          <React.Fragment>
            {processed > 0 ? (
              <Tooltip title="清空结果，重新比对" mouseEnterDelay={0.35}>
                <Button size="small" icon={<ReloadOutlined />} onClick={onReset} />
              </Tooltip>
            ) : null}
            <Button
              type="primary"
              size="small"
              icon={<PlayCircleOutlined />}
              onClick={onRun}
              disabled={!canRun}
            >
              开始比对 {total > 0 ? total + ' 条' : ''}
            </Button>
          </React.Fragment>
        )}

        <Tooltip
          title={canExport ? '导出为单文件 HTML 报告，可离线打开' : '需要先完成一次比对'}
          mouseEnterDelay={0.35}
        >
          <Button size="small" icon={<DownloadOutlined />} onClick={onExport} disabled={!canExport}>
            导出报告
          </Button>
        </Tooltip>
      </div>
    </header>
  );
};

export default React.memo(ConsoleHeader);
