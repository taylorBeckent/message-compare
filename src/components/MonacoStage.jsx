/**
 * Monaco 比对舞台（全局单实例复用）
 *
 * 旧版每条数据挂一个 <DiffEditor>，300 条就是 300 个 Monaco 实例：
 * 每个实例带自己的 DOM 树、worker 通信、model 和 view zone，
 * 内存和初始化时间都是线性叠加，标签页必然假死。
 *
 * 这一版整个应用只有一个 DiffEditor：
 *   - 组件挂载时 createDiffEditor 一次
 *   - 切换记录时只换 model（createModel + setModel + 释放旧的）
 *   - 卸载时才 dispose
 * 换 model 的开销是毫秒级，切换手感比销毁重建实例好一个数量级。
 *
 * 注意 model 必须手动 dispose。Monaco 的 model 是注册在全局 model service 里的，
 * 不释放会一直累积，几百次切换之后内存能涨到几百 MB。
 */

import React, { useRef, useEffect, useState, useCallback, forwardRef, useImperativeHandle } from 'react';
import { loadMonaco } from '../core/monacoLoader';
import { LoadingOutlined, WarningOutlined } from '@ant-design/icons';

const MonacoStage = forwardRef((props, ref) => {
  const { record, sideBySide, wordWrap, ignoreTrimWhitespace, fontSize } = props;

  const hostRef = useRef(null);
  const editorRef = useRef(null);
  const monacoRef = useRef(null);
  const modelsRef = useRef(null);
  const changesRef = useRef([]);
  const changeIdxRef = useRef(-1);

  const [phase, setPhase] = useState('loading'); //. loading | ready | error
  const [errMsg, setErrMsg] = useState('');

  // ---- 建实例（只做一次） -------------------------------------------------

  useEffect(() => {
    let disposed = false;

    loadMonaco()
      .then((monaco) => {
        if (disposed || !hostRef.current) return;
        monacoRef.current = monaco;

        const editor = monaco.editor.createDiffEditor(hostRef.current, {
          theme: 'mc-dark',
          readOnly: true,
          originalEditable: false,
          renderSideBySide: !!sideBySide,
          enableSplitViewResizing: true,
          wordWrap: wordWrap ? 'on' : 'off',
          ignoreTrimWhitespace: !!ignoreTrimWhitespace,
          fontSize: fontSize || 12,
          fontFamily: '"JetBrains Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace',
          lineHeight: 19,
          minimap: { enabled: false },
          renderOverviewRuler: true,
          overviewRulerLanes: 2,
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          automaticLayout: false, //. 自己用 ResizeObserver 控制，避免 Monaco 内部轮询
          glyphMargin: false,
          folding: true,
          renderIndicators: true,
          scrollbar: {
            vertical: 'auto',
            horizontal: 'auto',
            useShadows: false,
            //. 编辑器滚到底时把滚轮事件让给外层容器，否则会「吞掉」页面滚动
            alwaysConsumeMouseWheel: false
          },
          padding: { top: 8, bottom: 24 }
        });

        editorRef.current = editor;

        //. diff 是异步算的，算完才能拿到变更块，用来做「跳到下一处差异」
        editor.onDidUpdateDiff(() => {
          const changes = editor.getLineChanges() || [];
          changesRef.current = changes;
          changeIdxRef.current = -1;
          if (props.onChangesReady) props.onChangesReady(changes.length);
          //. 切到新记录后自动落到第一处差异，省掉用户手动往下找
          if (changes.length > 0) {
            const target = changes[0].modifiedStartLineNumber || changes[0].originalStartLineNumber;
            const modified = editor.getModifiedEditor();
            if (modified && target) modified.revealLineInCenter(Math.max(1, target - 2));
          }
        });

        setPhase('ready');
        //. 上层据此决定「精确」按钮是否可用，以及是否要把默认引擎切过来
        if (props.onReady) props.onReady();
      })
      .catch((err) => {
        if (disposed) return;
        setErrMsg(err && err.message ? err.message : String(err));
        setPhase('error');
        if (props.onFail) props.onFail(err);
      });

    return () => {
      disposed = true;
      if (modelsRef.current) {
        if (modelsRef.current.original) modelsRef.current.original.dispose();
        if (modelsRef.current.modified) modelsRef.current.modified.dispose();
        modelsRef.current = null;
      }
      if (editorRef.current) {
        editorRef.current.dispose();
        editorRef.current = null;
      }
    };
    //. 只依赖挂载，其余选项变化走下面的 effect 用 updateOptions 热更新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- 选项热更新（不重建实例） -------------------------------------------

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || phase !== 'ready') return;
    editor.updateOptions({
      renderSideBySide: !!sideBySide,
      wordWrap: wordWrap ? 'on' : 'off',
      ignoreTrimWhitespace: !!ignoreTrimWhitespace,
      fontSize: fontSize || 12
    });
    editor.layout();
  }, [sideBySide, wordWrap, ignoreTrimWhitespace, fontSize, phase]);

  // ---- 换记录：只换 model -------------------------------------------------

  const recordId = record ? record.id : null;
  const leftText = record ? record.leftText || '' : '';
  const rightText = record ? record.rightText || '' : '';
  const language = record ? record.language || 'plaintext' : 'plaintext';

  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco || phase !== 'ready') return;

    //. 先释放上一对 model，再建新的 —— 顺序反了会因为 URI 冲突报错
    if (modelsRef.current) {
      if (modelsRef.current.original) modelsRef.current.original.dispose();
      if (modelsRef.current.modified) modelsRef.current.modified.dispose();
      modelsRef.current = null;
    }

    if (!record) {
      editor.setModel(null);
      changesRef.current = [];
      return;
    }

    //. 用随机 URI，避免同语言 model 复用带来的脏状态
    const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const original = monaco.editor.createModel(leftText, language, monaco.Uri.parse('inmemory://mc/' + stamp + '/left.' + language));
    const modified = monaco.editor.createModel(rightText, language, monaco.Uri.parse('inmemory://mc/' + stamp + '/right.' + language));

    modelsRef.current = { original, modified };
    editor.setModel({ original, modified });
  }, [recordId, leftText, rightText, language, phase, record]);

  // ---- 尺寸自适应 ---------------------------------------------------------

  useEffect(() => {
    const host = hostRef.current;
    const editor = editorRef.current;
    if (!host || !editor || phase !== 'ready') return undefined;

    let raf = 0;
    const doLayout = () => {
      raf = 0;
      if (editorRef.current) editorRef.current.layout();
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(doLayout);
    };

    schedule();

    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(schedule);
      ro.observe(host);
      window.addEventListener('resize', schedule);
      return () => {
        if (raf) cancelAnimationFrame(raf);
        ro.disconnect();
        window.removeEventListener('resize', schedule);
      };
    }
    window.addEventListener('resize', schedule);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', schedule);
    };
  }, [phase]);

  // ---- 差异导航 -----------------------------------------------------------

  const gotoChange = useCallback((dir) => {
    const editor = editorRef.current;
    const changes = changesRef.current;
    if (!editor || !changes.length) return 0;

    let i = changeIdxRef.current + dir;
    if (i < 0) i = changes.length - 1;
    if (i >= changes.length) i = 0;
    changeIdxRef.current = i;

    const c = changes[i];
    const modified = editor.getModifiedEditor();
    const line = c.modifiedStartLineNumber || c.originalStartLineNumber || 1;
    if (modified) modified.revealLineInCenter(Math.max(1, line - 2));
    return i + 1;
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      nextChange: () => gotoChange(1),
      prevChange: () => gotoChange(-1),
      changeCount: () => changesRef.current.length,
      getEditor: () => editorRef.current
    }),
    [gotoChange]
  );

  return (
    <div className="mc-monaco">
      <div className="mc-monaco__host" ref={hostRef} />
      {phase === 'loading' ? (
        <div className="mc-monaco__boot">
          <LoadingOutlined spin />
          <span>正在加载编辑器内核…</span>
        </div>
      ) : null}
      {phase === 'error' ? (
        <div className="mc-monaco__boot">
          <WarningOutlined style={{ color: 'var(--mc-bad)' }} />
          <span style={{ maxWidth: '70%', textAlign: 'left', lineHeight: 1.7 }}>{errMsg}</span>
        </div>
      ) : null}
    </div>
  );
});

MonacoStage.displayName = 'MonacoStage';

export default MonacoStage;
