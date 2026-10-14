/**
 * ExportCenter —— 导出中心
 *
 * 旧版只能下载单条，几百条时用户要么点几百次，要么放弃归档。
 * 这一版把「下载」变成一个有范围的批处理动作，并且明确告诉用户三件事：
 *   导多少条、大概多大、导出来的东西在没网的环境能不能打开。
 *
 * 分四步且每步都让出主线程，是因为 800 条报文的压缩 + 序列化能跑到一秒以上。
 * 如果一口气同步做完，用户看到的是一个完全静止的弹窗 —— 那比慢更让人不安。
 *
 * 报告生成器走动态 import：它内联了 diff 库、lz-string 和自己的 diffEngine 源码，
 * 加起来几十 KB。用户可能整个会话都不导出一次，没必要让主包替他背着。
 */

import React, { useState, useCallback, useRef } from 'react';
import { Modal, Button, Radio, message } from 'antd';
import { CheckOutlined, LoadingOutlined, DownloadOutlined, FileTextOutlined } from '@ant-design/icons';
import ProgressRing from '../canvas/ProgressRing';

const STEPS = [
  { key: 'collect', label: '采集记录', note: '' },
  { key: 'compress', label: '压缩数据', note: '' },
  { key: 'serialize', label: '生成 HTML', note: '' },
  { key: 'save', label: '写入文件', note: '' }
];

const SCOPES = [
  { value: 'filtered', label: '当前筛选结果' },
  { value: 'diff', label: '仅差异记录' },
  { value: 'all', label: '全部记录' }
];

function formatBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function nextFrame() {
  //. 让浏览器有机会把进度画出来，否则四步会在同一帧里跑完，进度环纹丝不动
  return new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });
}

const ExportCenter = (props) => {
  const {
    visible,
    onClose,
    allRecords,
    filteredRecords,
    summary,
    groupName,
    groupDesc,
    scopeLabelOfFilter,
    elapsedMs
  } = props;

  const [scope, setScope] = useState('filtered');
  const [step, setStep] = useState(-1); //. -1 未开始，0~3 进行中，4 完成
  const [notes, setNotes] = useState({});
  const [error, setError] = useState('');
  const [size, setSize] = useState(null);
  //. runningRef 用来在 Promise 链里挡重入；但渲染时的 disabled 绝不能读它 ——
  //. ref 变化不触发重绘，按钮状态会停在上一帧。所以「忙」这件事用 step 派生。
  const runningRef = useRef(false);

  const busy = step >= 0 && step < 4;
  const progress = step < 0 ? 0 : Math.min(1, (step + 1) / STEPS.length);

  const scopeRecords = useCallback(() => {
    if (scope === 'all') return allRecords || [];
    if (scope === 'diff') return (allRecords || []).filter((r) => r.status === 'changed');
    return filteredRecords || [];
  }, [scope, allRecords, filteredRecords]);

  const preview = scopeRecords();
  const scopeLabel =
    scope === 'all' ? '全部记录' : scope === 'diff' ? '仅有差异的记录' : scopeLabelOfFilter || '当前筛选结果';

  const canExport = visible && preview.length > 0 && !busy && step !== 4;

  const reset = useCallback(() => {
    setStep(-1);
    setNotes({});
    setError('');
    setSize(null);
  }, []);

  const handleClose = useCallback(() => {
    if (runningRef.current) return;
    reset();
    onClose();
  }, [onClose, reset]);

  /**
   * 整条流水线刻意写成 .then() 链而不是 async/await。
   *
   * 项目锁在 node 12.20.1，babel targets 里带着 ie 11，而 useBuiltIns 是 false、
   * regenerator-runtime 没有安装。async/await 会被降级成引用 regeneratorRuntime 的
   * 生成器代码，运行时直接 ReferenceError 白屏。用 Promise 链在 ES5 目标是原生可跑的。
   */
  const run = useCallback(() => {
    if (runningRef.current) return;

    const recs = scopeRecords();
    if (recs.length === 0) {
      setError('当前范围没有可导出的记录');
      return;
    }

    runningRef.current = true;
    setError('');
    setSize(null);
    setNotes({});
    setStep(0);

    let mod = null;
    let t0 = 0;
    let outBytes = 0;
    //. 跨 then 传递中间产物。estimateReportSize 已经把 base64 算出来了，
    //. 交给 buildReportHtml 复用，几百条报文没必要压两遍。
    let keepPayload = null;
    let keepPre = '';
    let keepHtml = '';

    const fail = (e) => {
      runningRef.current = false;
      setError(e && e.message ? e.message : String(e));
      setStep(-1);
    };

    nextFrame()
      .then(() => import('../report/buildHtmlReport'))
      .then((m) => {
        mod = m;
        t0 = Date.now();
        //. 步骤 0：采集
        setNotes({ collect: recs.length + ' 条' });
        return nextFrame();
      })
      .then(() => {
        keepPayload = mod.buildReportPayload({
          records: recs,
          summary,
          title: '报文批量比对报告',
          groupName,
          groupDesc,
          scopeLabel,
          generatedAt: new Date().toLocaleString('zh-CN'),
          elapsedMs
        });
        //. 步骤 1：压缩
        setStep(1);
        return nextFrame();
      })
      .then(() => {
        const est = mod.estimateReportSize(keepPayload);
        keepPre = est.compressed;
        setSize(est.total);
        setNotes((n) =>
          Object.assign({}, n, {
            compress: formatBytes(est.rawJson) + ' → ' + formatBytes(est.compressed.length)
          })
        );
        //. 步骤 2：序列化
        setStep(2);
        return nextFrame();
      })
      .then(() => {
        const out = mod.buildReportHtml(keepPayload, null, keepPre);
        keepHtml = out.html;
        outBytes = out.bytes;
        keepPayload = null; //. 释放，几百条报文的 payload 不小
        setNotes((n) =>
          Object.assign({}, n, { serialize: formatBytes(out.bytes) + ' · ' + (Date.now() - t0) + 'ms' })
        );
        //. 步骤 3：落盘
        setStep(3);
        return nextFrame();
      })
      .then(() => {
        const stamp = new Date();
        const p2 = (v) => (v < 10 ? '0' + v : '' + v);
        const fname =
          'diff-report_' +
          (groupName || 'group').replace(/[^\w\u4e00-\u9fa5-]+/g, '') +
          '_' +
          stamp.getFullYear() +
          p2(stamp.getMonth() + 1) +
          p2(stamp.getDate()) +
          '-' +
          p2(stamp.getHours()) +
          p2(stamp.getMinutes()) +
          '.html';

        mod.downloadReport(keepHtml, fname);
        keepHtml = '';
        setNotes((n) => Object.assign({}, n, { save: fname }));
        setStep(4);
        setSize(outBytes);
        message.success('已导出 ' + recs.length + ' 条比对结果');
        runningRef.current = false;
      })
      .catch(fail);
  }, [scopeRecords, summary, groupName, groupDesc, scopeLabel, elapsedMs]);

  return (
    <Modal
      title={
        <span>
          <DownloadOutlined style={{ marginRight: 8, color: 'var(--mc-accent)' }} />
          导出比对报告
        </span>
      }
      visible={visible}
      onCancel={handleClose}
      width={560}
      maskClosable={false}
      destroyOnClose
      footer={
        step === 4
          ? [
              <Button key="again" onClick={reset}>
                再导一份
              </Button>,
              <Button key="close" type="primary" onClick={handleClose}>
                完成
              </Button>
            ]
          : [
              <Button key="cancel" onClick={handleClose} disabled={busy}>
                取消
              </Button>,
              <Button key="ok" type="primary" icon={<DownloadOutlined />} onClick={run} disabled={!canExport} loading={busy}>
                生成并下载
              </Button>
            ]
      }
    >
      <div className="mc-export">
        <div className="mc-export__summary">
          <div className="mc-export__cell">
            <dt>导出范围</dt>
            <dd>{preview.length}</dd>
          </div>
          <div className="mc-export__cell">
            <dt>其中有差异</dt>
            <dd style={{ color: 'var(--mc-warn)' }}>
              {preview.filter((r) => r.status === 'changed').length}
            </dd>
          </div>
          <div className="mc-export__cell">
            <dt>预计体积</dt>
            <dd>{formatBytes(size)}</dd>
          </div>
        </div>

        <Radio.Group
          value={scope}
          onChange={(e) => {
            setScope(e.target.value);
            reset();
          }}
          disabled={busy || step === 4}
          style={{ marginBottom: 14 }}
        >
          {SCOPES.map((s) => (
            <Radio.Button key={s.value} value={s.value}>
              {s.label}
            </Radio.Button>
          ))}
        </Radio.Group>

        <div className="mc-export__steps">
          {STEPS.map((s, i) => {
            const state = step > i ? 'done' : step === i ? 'on' : '';
            return (
              <div key={s.key} className={'mc-export__step' + (state ? ' mc-export__step--' + state : '')}>
                <span className={'mc-export__tick' + (state ? ' mc-export__tick--' + state : '')}>
                  {state === 'done' ? (
                    <CheckOutlined />
                  ) : state === 'on' ? (
                    <LoadingOutlined spin />
                  ) : (
                    i + 1
                  )}
                </span>
                <span>{s.label}</span>
                {notes[s.key] ? <span className="mc-export__note">{notes[s.key]}</span> : null}
              </div>
            );
          })}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 14 }}>
          <ProgressRing
            progress={progress}
            size={44}
            stroke={3.5}
            indeterminate={busy}
            label={step === 4 ? '完成' : busy ? Math.round(progress * 100) + '%' : '待开始'}
          />
          <div className="mc-export__hint">
            <div>
              <FileTextOutlined style={{ marginRight: 6 }} />
              单个自包含 HTML 文件，
              <b style={{ color: 'var(--mc-text-hi)' }}>不依赖任何 CDN 或内网服务</b>
              ，拷到别的机器断网双击也能打开。
            </div>
            <div style={{ marginTop: 5 }}>
              报告内置与控制台同一份差异算法与配色，打开即按需现算，支持筛选、搜索、折叠展开，
              浏览器打印可另存为 PDF。
            </div>
          </div>
        </div>

        {error ? <div className="mc-export__error">{error}</div> : null}
      </div>
    </Modal>
  );
};

export default ExportCenter;
