/**
 * RecordRail —— 中栏记录轨道
 *
 * 这一栏是「几百条数据」真正被人翻的地方，所以设计上有三个硬约束：
 *
 * 1) 必须是虚拟滚动。800 条 × 每条一个 canvas 迷你条带 = 800 个画布，
 *    直接渲染会让首次比对结束后的那一帧卡住几百毫秒。这里只渲染视口内 ~30 行。
 *
 * 2) 必须是密集行而不是卡片。frontend-dev 的密度规则说得直白：
 *    密度 > 7 的场景不要用卡片，用发丝线分隔。800 条数据配卡片，
 *    一屏只能看 6 条，翻完一遍要滚 130 屏 —— 那是设计失败，不是设计精致。
 *
 * 3) 每行要能「不点开就判断」。所以行里塞了四样东西：
 *    序号、左右名称、状态徽标 + 增删数字、以及一根差异分布条带。
 *    条带回答「差异集中在报文哪个部位」，这是纯数字给不了的信息。
 */

import React, { useMemo, useCallback, useEffect, useRef } from 'react';
import { Input } from 'antd';
import { SearchOutlined, CloseCircleFilled } from '@ant-design/icons';
import { useVirtualList } from '../hooks/useVirtualList';
import DiffSparkline from '../canvas/DiffSparkline';
import { STATUS_COLOR, STATUS_LABEL, severityToRampT } from '../core/palette';
import { MUTATION_LABEL } from '../mock/dataset';

const ROW_H = 46; //. 与 --mc-row-h 对应

const STATUS_TABS = [
    { key: 'all', label: '全部' },
    { key: 'diff', label: '有差异' },
    { key: 'identical', label: '一致' },
    { key: 'missing', label: '单侧空' },
    { key: 'error', label: '异常' }
];

const SORT_TABS = [
    { key: 'seq', label: '序号' },
    { key: 'severity', label: '严重度' },
    { key: 'changes', label: '变更量' },
    { key: 'duration', label: '耗时' }
];

/**
 * 单行。React.memo 是这里最关键的一句：
 * 批处理每推进一片就会 bump version，父组件重渲染 → 视口内 30 行全部重渲染。
 * memo 之后只有真正变化的那几行会重画。
 *
 * 注意记录是「就地改」的可变对象，靠 rec 引用比较永远相等，所以额外传一个 sig：
 * 把会影响这一行外观的字段拼成短字符串，让 memo 有的比。
 * onPick 必须是父层的稳定引用，否则每次渲染都换 identity，memo 直接失效。
 */
const RailRow = React.memo(function RailRow(props) {
    const { rec, selected, onPick, sig } = props;
    const st = rec.stats;
    const status = rec.status || 'pending';
    const isPending = status === 'pending' || status === 'running';
    const sev = st ? severityToRampT(st.severity || 0) : 0;

    const cls = 'mc-row' + (selected ? ' mc-row--on' : '');

    const pick = useCallback(() => onPick(rec.id), [onPick, rec.id]);

    return (
        <div
            className={cls}
            role="option"
            aria-selected={selected ? 'true' : 'false'}
            tabIndex={-1}
            data-id={rec.id}
            onClick={pick}
        >
            <span className="mc-row__seq">{rec.seq}</span>

            <span className="mc-row__body">
                <span className="mc-row__names">
                    <span>{rec.left_name}</span>
                    <i>VS</i>
                    <span>{rec.right_name}</span>
                </span>
                <span className="mc-row__meta">
                    {isPending ? (
                        <span className="mc-skel" style={{ width: 74, height: 9, display: 'inline-block' }} />
                    ) : (
                        <React.Fragment>
                            <span
                                className="mc-row__badge"
                                style={{
                                    color: STATUS_COLOR[status],
                                    background: 'rgba(255,255,255,0.05)',
                                    border: '1px solid ' + STATUS_COLOR[status] + '55'
                                }}
                            >
                                {STATUS_LABEL[status] || status}
                            </span>
                            {status === 'changed' && st ? (
                                <React.Fragment>
                                    <span style={{ color: 'var(--mc-add-fg)' }}>+{st.added}</span>
                                    <span style={{ color: 'var(--mc-del-fg)' }}>−{st.removed}</span>
                                    <span style={{ color: 'rgba(232,237,244,0.55)' }}>
                                        {((st.severity || 0) * 100).toFixed(1)}%
                                    </span>
                                </React.Fragment>
                            ) : null}
                            {rec.mutation ? <span style={{ color: 'var(--mc-text-faint)' }}>{MUTATION_LABEL[rec.mutation]}</span> : null}
                        </React.Fragment>
                    )}
                </span>
            </span>

            <span className="mc-row__right">
                <DiffSparkline
                    spark={rec.spark}
                    status={status}
                    severity={sev}
                    width={54}
                    height={13}
                    active={selected}
                />
                <span className="mc-num" style={{ fontSize: 10, color: 'var(--mc-text-faint)' }}>
                    {isPending ? '—' : st ? st.leftLines + '→' + st.rightLines + ' 行' : ''}
                </span>
            </span>

            <span style={{ display: 'none' }}>{sig}</span>
        </div>
    );
});

const RecordRail = (props) => {
    const {
        list,
        total,
        version,
        selectedId,
        onSelectId,
        running,
        query,
        onQuery,
        statusFilter,
        onStatusFilter,
        sortKey,
        sortDesc,
        onSort
    } = props;

    const vlist = useVirtualList({ count: list.length, rowHeight: ROW_H, overscan: 8 });

    // console.log("list", list);
    // console.log("vlist", vlist);

    //. 选中项变化时把它滚进视野（键盘上下键导航依赖这个）
    const selectedIndex = useMemo(() => {
        for (let i = 0; i < list.length; i += 1) {
            if (list[i].id === selectedId) return i;
        }
        return -1;
    }, [list, selectedId]);

    const firstRenderRef = useRef(true);
    useEffect(() => {
        if (selectedIndex < 0) return;
        //. 首次挂载不要跳滚动位置，否则一进来列表就停在中间，用户会以为数据被截断了
        if (firstRenderRef.current) {
            firstRenderRef.current = false;
            return;
        }
        vlist.scrollToIndex(selectedIndex);
    }, [selectedIndex]); //. eslint-disable-line react-hooks/exhaustive-deps

    const handleKey = useCallback(
        (e) => {
            if (list.length === 0) return;
            let next = -1;
            if (e.key === 'ArrowDown') next = selectedIndex < 0 ? 0 : Math.min(list.length - 1, selectedIndex + 1);
            else if (e.key === 'ArrowUp') next = selectedIndex < 0 ? 0 : Math.max(0, selectedIndex - 1);
            else if (e.key === 'Home') next = 0;
            else if (e.key === 'End') next = list.length - 1;
            else return;

            e.preventDefault();
            onSelectId(list[next].id);
            vlist.scrollToIndex(next);
        },
        [list, selectedIndex, onSelectId, vlist]
    );

    const rows = [];
    for (let i = vlist.start; i < vlist.end; i += 1) {
        const rec = list[i];
        if (!rec) continue;
        const st = rec.stats;
        //. sig 只收「会影响这一行外观」的字段，批处理推进时只有真正变了的行才重画
        const sig =
            rec.status +
            '|' +
            (st ? st.added + ',' + st.removed + ',' + st.leftLines + ',' + st.rightLines : '') +
            '|' +
            (rec.spark ? rec.spark.length : 0);

        rows.push(
            <RailRow
                key={rec.id}
                rec={rec}
                selected={rec.id === selectedId}
                onPick={onSelectId}
                sig={sig}
            />
        );
    };

    // console.log("rows", rows);

    return (
        <div className="mc-pane mc-pane--rail">
            <div className="mc-pane__head">
                <div className="mc-pane__title">
                    <span>记录轨道</span>
                    <span className="mc-num" style={{ color: 'var(--mc-text-mid)' }}>
                        {list.length}
                        <span style={{ color: 'var(--mc-text-faint)' }}> / {total}</span>
                    </span>
                </div>
            </div>

            <div className="mc-railtools">
                <div className="mc-railtools__row">
                    <Input
                        size="small"
                        allowClear
                        prefix={<SearchOutlined style={{ color: 'var(--mc-text-faint)' }} />}
                        placeholder="搜索序号 / 报文名 / 业务"
                        value={query}
                        onChange={(e) => onQuery(e.target.value)}
                        aria-label="搜索记录"
                    />
                </div>
                <div className="mc-railtools__row">
                    <div className="mc-seg" role="tablist" aria-label="状态筛选">
                        {STATUS_TABS.map((t) => (
                            <button
                                key={t.key}
                                type="button"
                                role="tab"
                                aria-selected={statusFilter === t.key}
                                className={'mc-seg__btn' + (statusFilter === t.key ? ' mc-seg__btn--on' : '')}
                                onClick={() => onStatusFilter(t.key)}
                            >
                                {t.label}
                            </button>
                        ))}
                    </div>
                </div>
                <div className="mc-railtools__row">
                    <span className="mc-header__label" style={{ flex: '0 0 auto' }}>
                        排序
                    </span>
                    <div className="mc-seg" role="tablist" aria-label="排序方式">
                        {SORT_TABS.map((t) => (
                            <button
                                key={t.key}
                                type="button"
                                role="tab"
                                aria-selected={sortKey === t.key}
                                className={'mc-seg__btn' + (sortKey === t.key ? ' mc-seg__btn--on' : '')}
                                onClick={() => onSort(t.key)}
                            >
                                {t.label}
                                {sortKey === t.key && sortDesc ? ' ↓' : ''}
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            {list.length === 0 ? (
                <div className="mc-vlist__empty">
                    {total === 0 ? (
                        <React.Fragment>
                            当前数据组没有记录
                            <br />
                            换一个数据组试试
                        </React.Fragment>
                    ) : (
                        <React.Fragment>
                            没有匹配的记录
                            <br />
                            <button
                                type="button"
                                className="mc-linkbtn"
                                onClick={() => {
                                    onQuery('');
                                    onStatusFilter('all');
                                }}
                            >
                                <CloseCircleFilled /> 清除筛选条件
                            </button>
                        </React.Fragment>
                    )}
                </div>
            ) : (
                <div
                    className="mc-vlist mc-scroll"
                    ref={vlist.containerRef}
                    onScroll={vlist.onScroll}
                    role="listbox"
                    aria-label="比对记录列表"
                    aria-activedescendant={selectedId}
                    tabIndex={0}
                    onKeyDown={handleKey}
                >
                    <div className="mc-vlist__sizer" style={vlist.sizerStyle}>
                        <div className="mc-vlist__window" style={vlist.windowStyle}>
                            {rows}
                        </div>
                    </div>
                </div>
            )}

            <div className="mc-hint" style={{ margin: '0 12px 10px' }}>
                {running
                    ? '比对进行中，结果实时刷新；此时点击任意记录都能立刻查看已算出的部分。'
                    : '↑ ↓ 键在列表内移动选中项，Enter 或点击打开右侧比对视图。'}
            </div>
        </div>
    );
};

export default React.memo(RecordRail);
