/**
 * DiffStage —— 右栏比对舞台
 *
 * 整个应用只有这一个「重」视图。左栏热力图和中栏列表负责回答「哪几条有问题」，
 * 这一栏负责回答「这一条到底差在哪」。
 *
 * 两套渲染引擎并存，是刻意的取舍：
 *   · Monaco 精确 —— 语法高亮、词级差异、可折叠、行内导航，看单条最舒服，
 *                     但它是全局唯一实例，切记录靠换 model，无法同时铺开多条。
 *   · DiffLite 轻量 —— 纯 DOM 行级渲染，秒开、可复制、和离线报告视觉一致。
 *
 * Monaco 首次加载要取几 MB 静态资源，所以默认先用 DiffLite 顶上，
 * Monaco 就绪后再让用户切过去；加载失败就永久停在 DiffLite，不弹错误打扰用户。
 */

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Tooltip, message } from 'antd';
import {
  SwapOutlined,
  ColumnWidthOutlined,
  ExpandAltOutlined,
  CompressOutlined,
  DownOutlined,
  UpOutlined,
  CodeOutlined,
  UnorderedListOutlined,
  WarningOutlined
} from '@ant-design/icons';
import DiffLite from './DiffLite';
import MonacoStage from './MonacoStage';
import { getRows } from '../core/compareRunner';
import { changeIndices } from '../core/diffEngine';
import { STATUS_LABEL, STATUS_COLOR, severityToRampT, severityCss } from '../core/palette';
import { MUTATION_LABEL } from '../mock/dataset';

function IconBtn(props) {
  return (
    <Tooltip title={props.tip} mouseEnterDelay={0.35}>
      <button
        type="button"
        className="mc-icobtn"
        onClick={props.onClick}
        disabled={props.disabled}
        aria-label={props.tip}
      >
        {props.children}
      </button>
    </Tooltip>
  );
}

const DiffStage = (props) => {
  const { record, version, index, total, onPrev, onNext } = props;

  //. 默认轻量：Monaco 还没加载完时界面就是可用的
  const [engine, setEngine] = useState('lite');
  const [monacoState, setMonacoState] = useState('idle'); //. idle | ready | failed
  const [sideBySide, setSideBySide] = useState(true);
  const [wordWrap, setWordWrap] = useState(false);
  const [expandAll, setExpandAll] = useState(false);
  const [context, setContext] = useState(3);
  const [openGaps, setOpenGaps] = useState({});

  const liteRef = useRef(null);
  const monacoRef = useRef(null);
  const changeCursorRef = useRef(-1);

  const done = record && record.status && record.status !== 'pending' && record.status !== 'running';

  //. rows 走 LRU 懒计算：切到哪条才算哪条
  const rows = useMemo(() => {
    if (!done) return [];
    return getRows(record);
    //. version 参与依赖：批处理是就地改记录的，靠版本号触发重算
  }, [record, done, version]);

  //. 换记录时清掉上一条的折叠状态，否则会带着别的记录的 gap key
  useEffect(() => {
    setOpenGaps({});
    changeCursorRef.current = -1;
  }, [record && record.id]);

  const stats = record ? record.stats : null;
  const status = record ? record.status : 'pending';

  const handleMonacoReady = useCallback(() => {
    setMonacoState('ready');
  }, []);

  const handleMonacoFail = useCallback(() => {
    setMonacoState('failed');
    setEngine('lite');
    message.warning('Monaco 编辑器加载失败，已切换到轻量渲染');
  }, []);

  const onFirstChangeReady = useCallback((idx) => {
    //. 首次进入某条记录时，自动把第一处差异滚进视野
    if (idx >= 0 && changeCursorRef.current === -1) {
      changeCursorRef.current = idx;
      const api = liteRef.current;
      if (api) api.scrollToFirstChange();
    }
  }, []);

  const toggleGap = useCallback((key) => {
    setOpenGaps((prev) => {
      const next = Object.assign({}, prev);
      if (next[key]) delete next[key];
      else next[key] = true;
      return next;
    });
  }, []);

  const jumps = useMemo(() => (done ? changeIndices(rows) : []), [rows, done]);

  const jump = useCallback(
    (dir) => {
      if (engine === 'monaco' && monacoRef.current) {
        if (dir > 0) monacoRef.current.nextChange();
        else monacoRef.current.prevChange();
        return;
      }
      if (jumps.length === 0) return;
      let cur = changeCursorRef.current;
      //. DiffLite 的视图下标与 rows 下标不一致（有 gap 占位），
      //. 这里用「第几处变更」来推进，再让 DiffLite 自己在视图里找位置
      cur = cur + dir;
      if (cur < 0) cur = jumps.length - 1;
      if (cur >= jumps.length) cur = 0;
      changeCursorRef.current = cur;
      const api = liteRef.current;
      if (!api) return;
      const view = api.getView ? api.getView() : null;
      if (!view) return;
      //. 在视图里数第 cur 个变更行
      let seen = -1;
      for (let i = 0; i < view.length; i += 1) {
        const t = view[i].t;
        if (t !== 'c' && t !== 'gap') {
          seen += 1;
          if (seen === cur) {
            api.scrollToViewIndex(i);
            return;
          }
        }
      }
    },
    [engine, jumps.length]
  );

  if (!record) {
    return (
      <div className="mc-stage">
        <div className="mc-state">
          <div className="mc-state__icon">
            <CodeOutlined />
          </div>
          <div className="mc-state__title">未选择记录</div>
          <div className="mc-state__desc">在左侧热力图或中间列表里点一条记录，这里会显示它的逐行差异。</div>
        </div>
      </div>
    );
  }

  const severityT = stats ? severityToRampT(stats.severity || 0) : 0;

  return (
    <div className="mc-stage">
      <div className="mc-stage__bar">
        <div className="mc-stage__id">
          <span className="mc-stage__seq">#{record.seq}</span>
          <span className="mc-stage__names">
            {record.left_name}
            <i>VS</i>
            {record.right_name}
          </span>
        </div>

        <div className="mc-stage__tools">
          <div className="mc-seg" style={{ flex: '0 0 auto' }}>
            <button
              type="button"
              className={'mc-seg__btn' + (engine === 'lite' ? ' mc-seg__btn--on' : '')}
              onClick={() => setEngine('lite')}
            >
              <UnorderedListOutlined /> 轻量
            </button>
            <button
              type="button"
              className={'mc-seg__btn' + (engine === 'monaco' ? ' mc-seg__btn--on' : '')}
              onClick={() => setEngine('monaco')}
              disabled={monacoState === 'failed'}
            >
              <CodeOutlined /> 精确
            </button>
          </div>

          <span className="mc-header__sep" />

          <IconBtn tip={sideBySide ? '切换为行内视图' : '切换为左右并排'} onClick={() => setSideBySide(!sideBySide)}>
            <SwapOutlined />
          </IconBtn>
          <IconBtn tip={wordWrap ? '关闭自动换行' : '开启自动换行'} onClick={() => setWordWrap(!wordWrap)}>
            <ColumnWidthOutlined />
          </IconBtn>
          <IconBtn tip={expandAll ? '折叠未变更区域' : '展开全部行'} onClick={() => setExpandAll(!expandAll)}>
            {expandAll ? <CompressOutlined /> : <ExpandAltOutlined />}
          </IconBtn>

          <span className="mc-header__sep" />

          <IconBtn tip="上一处差异" onClick={() => jump(-1)}>
            <UpOutlined />
          </IconBtn>
          <IconBtn tip="下一处差异" onClick={() => jump(1)}>
            <DownOutlined />
          </IconBtn>

          <span className="mc-header__sep" />

          <IconBtn tip="上一条记录" onClick={onPrev} disabled={index <= 0}>
            ‹
          </IconBtn>
          <span className="mc-num mc-stage__pos">
            {index + 1}/{total}
          </span>
          <IconBtn tip="下一条记录" onClick={onNext} disabled={index >= total - 1}>
            ›
          </IconBtn>
        </div>
      </div>

      <div className="mc-stage__view">
        {!done ? (
          <div className="mc-state">
            <div className="mc-state__icon">
              <WarningOutlined />
            </div>
            <div className="mc-state__title">{status === 'running' ? '正在比对这条记录…' : '尚未比对'}</div>
            <div className="mc-state__desc">点击右上角「开始比对」，批量结果会实时刷新到左侧热力图。</div>
          </div>
        ) : engine === 'monaco' && monacoState !== 'failed' ? (
          <MonacoStage
            ref={monacoRef}
            record={record}
            sideBySide={sideBySide}
            wordWrap={wordWrap}
            ignoreTrimWhitespace={false}
            fontSize={12}
            onReady={handleMonacoReady}
            onFail={handleMonacoFail}
          />
        ) : (
          <DiffLite
            ref={liteRef}
            rows={rows}
            context={context}
            expandAll={expandAll}
            openGaps={openGaps}
            onToggleGap={toggleGap}
            wrap={wordWrap}
            onFirstChangeReady={onFirstChangeReady}
            statusText={
              record.error
                ? '比对异常：' + record.error
                : record.truncated
                ? '报文过长，仅比对前 20000 行'
                : record.notes && record.notes.length
                ? record.notes.join(' · ')
                : ''
            }
          />
        )}
      </div>

      <div className="mc-stage__meta">
        <span className="mc-stage__metakv">
          状态
          <b style={{ color: STATUS_COLOR[status] }}>{STATUS_LABEL[status] || status}</b>
        </span>
        {stats ? (
          <React.Fragment>
            <span className="mc-stage__metakv">
              严重度
              <b>
                <span
                  style={{
                    display: 'inline-block',
                    width: 8,
                    height: 8,
                    borderRadius: 2,
                    background: severityCss(severityT),
                    marginRight: 5
                  }}
                />
                {((stats.severity || 0) * 100).toFixed(1)}%
              </b>
            </span>
            <span className="mc-stage__metakv">
              增
              <b style={{ color: 'var(--mc-add-fg)' }}>{stats.added}</b>
            </span>
            <span className="mc-stage__metakv">
              删
              <b style={{ color: 'var(--mc-del-fg)' }}>{stats.removed}</b>
            </span>
            <span className="mc-stage__metakv">
              行
              <b>
                {stats.leftLines} → {stats.rightLines}
              </b>
            </span>
            <span className="mc-stage__metakv">
              变更行
              <b>{jumps.length}</b>
            </span>
            <span className="mc-stage__metakv">
              耗时
              <b>{record.durationMs.toFixed(1)}ms</b>
            </span>
          </React.Fragment>
        ) : null}
        <span className="mc-stage__spacer" />
        <span className="mc-stage__metakv">
          格式
          <b>{(record.format || '-').toUpperCase()}</b>
        </span>
        <span className="mc-stage__metakv">
          顺序
          <b>{record.ordered ? '敏感' : '忽略'}</b>
        </span>
        {record.mutation ? (
          <span className="mc-stage__metakv">
            注入
            <b>{MUTATION_LABEL[record.mutation] || record.mutation}</b>
          </span>
        ) : null}
        {engine === 'lite' ? (
          <span className="mc-stage__metakv">
            上下文
            <select
              className="mc-ctxsel"
              value={context}
              onChange={(e) => setContext(parseInt(e.target.value, 10))}
              aria-label="上下文行数"
            >
              <option value={0}>0</option>
              <option value={1}>1</option>
              <option value={3}>3</option>
              <option value={6}>6</option>
              <option value={12}>12</option>
            </select>
          </span>
        ) : null}
      </div>
    </div>
  );
};

export default DiffStage;
