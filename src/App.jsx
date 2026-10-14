/**
 * App —— 三栏主控台的装配层
 *
 * 这一层只干两件事：持有全局状态、把状态分发给三栏。所有重活都在下层：
 *   · 算差异在 core/compareRunner（分片调度，就地改记录，靠 version 触发重渲染）
 *   · 筛选排序在 hooks/useRecordFilter（三栏共用同一份结果，口径不会打架）
 *   · 渲染在 canvas / gl / components
 *
 * 为什么记录用「可变数组 + version」而不是每次都 setState 新数组：
 * 800 条记录批处理时会 bump 上百次 version，每次都复制整个数组再 diff，
 * GC 和 reconciliation 开销都很大。就地改 + 一个自增整数，是最省的刷新方式。
 */

import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import AmbientBackground from './gl/AmbientBackground';
import ConsoleHeader from './components/ConsoleHeader';
import OverviewPane from './components/OverviewPane';
import RecordRail from './components/RecordRail';
import DiffStage from './components/DiffStage';
import ExportCenter from './components/ExportCenter';
import { getGroupDefs, getGroupDef, buildGroup } from './mock/dataset';
import { startBatchCompare, summarize, clearRowsCache, STATUS } from './core/compareRunner';
import { useRecordFilter, SORT_KEYS } from './hooks/useRecordFilter';

const DEFAULT_GROUP = 'pay-clearing';

function freshRecords(groupId) {
    const def = getGroupDef(groupId);
    console.log("groupId", groupId);
    console.log("def", def);
    
    //. buildGroup 每次产出全新的 pending 记录，不复用缓存 ——
    //. 缓存里的记录带着上一轮的 status，重置时会看到「一半已完成」的脏状态
    return def ? buildGroup(def) : [];
}

const App = () => {
    const groupDefs = useMemo(() => getGroupDefs(), []);

    const [groupId, setGroupId] = useState(DEFAULT_GROUP);
    const [records, setRecords] = useState(() => freshRecords(DEFAULT_GROUP));
    const [version, setVersion] = useState(0);

    const [running, setRunning] = useState(false);
    const [paused, setPaused] = useState(false);
    const [processed, setProcessed] = useState(0);
    const [elapsedMs, setElapsedMs] = useState(0);

    const [query, setQuery] = useState('');
    const [statusFilter, setStatusFilter] = useState('all');
    const [sortKey, setSortKey] = useState(SORT_KEYS.SEQ);
    const [sortDesc, setSortDesc] = useState(false);
    const [selectedId, setSelectedId] = useState(null);
    const [exportVisible, setExportVisible] = useState(false);

    const runnerRef = useRef(null);

    const total = records.length;
    const progress = total > 0 ? processed / total : 0;

    const summary = useMemo(() => summarize(records), [records, version]); //. eslint-disable-line react-hooks/exhaustive-deps

    console.log('freshRecords(DEFAULT_GROUP)', freshRecords(DEFAULT_GROUP));

    const filtered = useRecordFilter(records, {
        query,
        statusFilter,
        sortKey,
        sortDesc,
        version
    });
    const list = filtered.list;

    //. 热力图靠这张表决定谁变暗：不在当前筛选结果里的记录淡出
    const visibleMap = useMemo(() => {
        const m = {};
        for (let i = 0; i < list.length; i += 1) m[list[i].id] = true;
        return m;
    }, [list, version]); //. eslint-disable-line react-hooks/exhaustive-deps

    const selectedRecord = useMemo(() => {
        if (!selectedId) return null;
        for (let i = 0; i < records.length; i += 1) {
            if (records[i].id === selectedId) return records[i];
        }
        return null;
    }, [records, selectedId, version]); //. eslint-disable-line react-hooks/exhaustive-deps

    //. 选中项在当前筛选结果里的位置 —— 右栏「上一条 / 下一条」和 x/y 计数都吃这个
    const selectedListIndex = useMemo(() => {
        if (!selectedId) return -1;
        for (let i = 0; i < list.length; i += 1) {
            if (list[i].id === selectedId) return i;
        }
        return -1;
    }, [list, selectedId]);

    //. 热力图要的是选中项在全量 records 里的下标（色块位置 = 全量序号）
    const selectedHeatmapIndex = useMemo(() => {
        if (!selectedId) return -1;
        for (let i = 0; i < records.length; i += 1) {
            if (records[i].id === selectedId) return i;
        }
        return -1;
    }, [records, selectedId]);

    const activeDef = useMemo(() => getGroupDef(groupId), [groupId]);

    // ---- 生命周期：卸载时掐掉可能还在跑的批处理 ------------------------------
    useEffect(
        () => () => {
            if (runnerRef.current) runnerRef.current.cancel();
        },
        []
    );

    // ---- 数据组切换 ----------------------------------------------------------
    const handleGroupChange = useCallback(
        (id) => {
            if (runnerRef.current) runnerRef.current.cancel();
            runnerRef.current = null;
            clearRowsCache();
            setGroupId(id);
            setRecords(freshRecords(id));
            setVersion(0);
            setRunning(false);
            setPaused(false);
            setProcessed(0);
            setElapsedMs(0);
            setSelectedId(null);
            setExportVisible(false);
            setStatusFilter('all');
            setQuery('');
        },
        []
    );

    // ---- 批量比对 ------------------------------------------------------------
    const handleRun = useCallback(() => {
        if (running || records.length === 0) return;
        clearRowsCache();
        setRunning(true);
        setPaused(false);
        setProcessed(0);
        setElapsedMs(0);

        runnerRef.current = startBatchCompare({
            records,
            frameBudget: 12,
            onBatch: (p) => {
                setProcessed(p);
                setVersion((v) => v + 1);
            },
            onComplete: (res) => {
                setRunning(false);
                setPaused(false);
                setProcessed(res.processed);
                setElapsedMs(res.elapsedMs);
                setVersion((v) => v + 1);
                runnerRef.current = null;
            }
        });
    }, [running, records]);

    const handlePause = useCallback(() => {
        if (runnerRef.current) runnerRef.current.pause();
        setPaused(true);
    }, []);

    const handleResume = useCallback(() => {
        if (runnerRef.current) runnerRef.current.resume();
        setPaused(false);
    }, []);

    const handleCancel = useCallback(() => {
        if (runnerRef.current) runnerRef.current.cancel();
    }, []);

    const handleReset = useCallback(() => {
        if (runnerRef.current) runnerRef.current.cancel();
        runnerRef.current = null;
        clearRowsCache();
        setRecords(freshRecords(groupId));
        setVersion(0);
        setRunning(false);
        setPaused(false);
        setProcessed(0);
        setElapsedMs(0);
        setSelectedId(null);
    }, [groupId]);

    // ---- 筛选 / 排序 ---------------------------------------------------------
    const handleStatusFilter = useCallback((k) => setStatusFilter(k), []);
    const handleQuery = useCallback((q) => setQuery(q), []);

    const handleSort = useCallback(
        (key) => {
            if (key === sortKey) {
                setSortDesc((d) => !d);
            } else {
                setSortKey(key);
                //. 序号默认升序（自然阅读顺序），其余指标默认降序（最严重的排最前）
                setSortDesc(key !== SORT_KEYS.SEQ);
            }
        },
        [sortKey]
    );

    const handleSelectId = useCallback((id) => setSelectedId(id), []);

    const handlePickRecord = useCallback((rec) => {
        if (rec) setSelectedId(rec.id);
    }, []);

    // ---- 右栏「上一条 / 下一条」：在当前筛选结果里前后移动 ---------------------
    const stepSelection = useCallback(
        (dir) => {
            if (list.length === 0) return;
            let next = selectedListIndex + dir;
            if (selectedListIndex < 0) next = dir > 0 ? 0 : list.length - 1;
            if (next < 0) next = 0;
            if (next >= list.length) next = list.length - 1;
            setSelectedId(list[next].id);
        },
        [list, selectedListIndex]
    );

    const handlePrev = useCallback(() => stepSelection(-1), [stepSelection]);
    const handleNext = useCallback(() => stepSelection(1), [stepSelection]);

    // ---- 全局键盘：左右方向键切记录（焦点不在输入框时）------------------------
    useEffect(() => {
        const onKey = (e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            const t = e.target;
            const tag = t && t.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return;
            //. 中栏列表自己用上下键导航，这里只接管左右键，避免和它抢
            if (e.key === 'ArrowLeft') handlePrev();
            else handleNext();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [handlePrev, handleNext]);

    // ---- 导出 ----------------------------------------------------------------
    const handleExport = useCallback(() => setExportVisible(true), []);
    const handleCloseExport = useCallback(() => setExportVisible(false), []);

    const canRun = !running && total > 0;
    const canExport = processed > 0 && !running;

    const scopeLabelOfFilter = useMemo(() => {
        const parts = [];
        const labelMap = {
            diff: '有差异',
            identical: '一致',
            missing: '单侧为空',
            error: '异常',
            pending: '待比对'
        };
        if (statusFilter !== 'all' && labelMap[statusFilter]) parts.push(labelMap[statusFilter]);
        if (query.trim()) parts.push('关键词“' + query.trim() + '”');
        return parts.length ? parts.join(' · ') + '（' + list.length + ' 条）' : '全部记录（' + list.length + ' 条）';
    }, [statusFilter, query, list.length]);

    const groupName = activeDef ? activeDef.name : '';
    const groupDesc = activeDef ? activeDef.desc : '';

    console.log("list", list);

    return (
        <React.Fragment>
            {/* <AmbientBackground /> */}
            <div className="mc-app">
                <ConsoleHeader
                    groupDefs={groupDefs}
                    groupId={groupId}
                    groupDesc={groupDesc}
                    onGroupChange={handleGroupChange}
                    running={running}
                    paused={paused}
                    progress={progress}
                    processed={processed}
                    total={total}
                    summary={summary}
                    statusFilter={statusFilter}
                    onStatusFilter={handleStatusFilter}
                    onRun={handleRun}
                    onPause={handlePause}
                    onResume={handleResume}
                    onCancel={handleCancel}
                    onExport={handleExport}
                    onReset={handleReset}
                    canExport={canExport}
                    canRun={canRun}
                />

                <div className="mc-body">
                    <OverviewPane
                        records={records}
                        version={version}
                        visibleMap={visibleMap}
                        selectedIndex={selectedHeatmapIndex}
                        running={running}
                        summary={summary}
                        onPickRecord={handlePickRecord}
                        statusFilter={statusFilter}
                        onStatusFilter={handleStatusFilter}
                    />

                    <RecordRail
                        list={list}
                        total={total}
                        version={version}
                        selectedId={selectedId}
                        onSelectId={handleSelectId}
                        running={running}
                        query={query}
                        onQuery={handleQuery}
                        statusFilter={statusFilter}
                        onStatusFilter={handleStatusFilter}
                        sortKey={sortKey}
                        sortDesc={sortDesc}
                        onSort={handleSort}
                    />

                    <DiffStage
                        record={selectedRecord}
                        version={version}
                        index={selectedListIndex}
                        total={list.length}
                        onPrev={handlePrev}
                        onNext={handleNext}
                    />
                </div>
            </div>

            <ExportCenter
                visible={exportVisible}
                onClose={handleCloseExport}
                allRecords={records}
                filteredRecords={list}
                summary={summary}
                groupName={groupName}
                groupDesc={groupDesc}
                scopeLabelOfFilter={scopeLabelOfFilter}
                elapsedMs={elapsedMs}
            />
        </React.Fragment>
    );
};

export default App;
