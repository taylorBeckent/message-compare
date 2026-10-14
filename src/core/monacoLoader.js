/**
 * Monaco 加载器 + 主题
 *
 * 和旧版的两个关键区别：
 *
 * 1) 旧版把 monaco 的静态资源地址写死成 `window.location.origin + '/min/vs'`，
 *    下载出去的 HTML 报告又写死了 `http://10.208.24.12:8518/...`。
 *    一旦换环境（本地调试、另一台内网机、把报告发给同事）就是一片空白。
 *    这里改成可配置的 baseUrl，默认取当前页面同源的 /monaco/，
 *    webpack 构建时把 monaco-editor/min/vs 整个拷进产物目录，
 *    部署即离线可用，不依赖任何 CDN。
 *
 * 2) Worker 用 Blob URL 而不是 data URL。
 *    Chrome 从 60 起禁止 data: URL 创建 Worker，用 data 会静默失败，
 *    表现是编辑器能显示但没有语法高亮和 diff 计算。
 *    Blob Worker 里必须用绝对地址 importScripts，因为 blob 是 opaque origin。
 */

let baseUrlOverride = null;
let loadPromise = null;

export function setMonacoBaseUrl(url) {
  baseUrlOverride = url;
  //. 换地址后必须重新加载，否则缓存的还是旧地址的 promise
  loadPromise = null;
}

export function getMonacoBaseUrl() {
  if (baseUrlOverride) return baseUrlOverride;
  if (typeof window === 'undefined') return '/monaco/';
  //. 用当前页面的 origin 拼绝对地址，worker 里 importScripts 需要绝对 URL
  return window.location.origin + '/monaco/';
}

/**
 * 加载 Monaco，返回全局 monaco 对象。多次调用共享同一个 promise。
 * @returns {Promise<object>}
 */
export function loadMonaco() {
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve, reject) => {
    if (typeof window === 'undefined') {
      reject(new Error('非浏览器环境'));
      return;
    }
    if (window.monaco) {
      resolve(window.monaco);
      return;
    }

    const base = getMonacoBaseUrl();
    const loaderUrl = base + 'vs/loader.js';

    const script = document.createElement('script');
    script.src = loaderUrl;
    script.async = true;

    script.onload = () => {
      try {
        //. 用 window.require 而不是裸 require：
        //. 后者会被 webpack 当成 CommonJS 依赖在编译期解析掉
        window.require.config({ paths: { vs: base + 'vs' } });

        const workerCode =
          "self.MonacoEnvironment = { baseUrl: '" + base + "' };" +
          "importScripts('" + base + "vs/base/worker/workerMain.js');";

        window.MonacoEnvironment = {
          getWorkerUrl: function getWorkerUrl() {
            const blob = new Blob([workerCode], { type: 'application/javascript' });
            return URL.createObjectURL(blob);
          }
        };

        window.require(
          ['vs/editor/editor.main'],
          () => {
            if (window.monaco) {
              defineTheme(window.monaco);
              resolve(window.monaco);
            } else {
              reject(new Error('Monaco 加载完成但全局对象缺失'));
            }
          },
          (err) => reject(new Error('Monaco 模块加载失败: ' + (err && err.message ? err.message : err)))
        );
      } catch (e) {
        reject(e);
      }
    };

    script.onerror = () => {
      loadPromise = null;
      reject(new Error('无法加载 Monaco 资源：' + loaderUrl + '（请确认构建产物里包含 monaco/vs 目录）'));
    };

    document.head.appendChild(script);
  });

  return loadPromise;
}

/**
 * 自定义深色主题。
 *
 * 不用自带的 vs-dark：它的底色是 #1e1e1e，和这套界面的 #0e1218 放在一起
 * 会形成一个明显更亮的方块，视觉上像「嵌了个别人的组件」。
 * diff 的增删底色也一并调过，和 DiffLite 用的是同一组语义色。
 */
export function defineTheme(monaco) {
  if (!monaco || !monaco.editor || !monaco.editor.defineTheme) return;

  monaco.editor.defineTheme('mc-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: '98a5b6', background: '0e1218' },
      { token: 'comment', foreground: '4d5a68', fontStyle: 'italic' },
      { token: 'string', foreground: '8ed7a6' },
      { token: 'string.key.json', foreground: '7fb8d8' },
      { token: 'string.value.json', foreground: 'd9c08a' },
      { token: 'number', foreground: 'd9a441' },
      { token: 'keyword', foreground: '35c2a5' },
      { token: 'tag', foreground: '7fb8d8' },
      { token: 'tag.xml', foreground: '7fb8d8' },
      { token: 'attribute.name', foreground: 'b58fd6' },
      { token: 'attribute.value', foreground: '8ed7a6' },
      { token: 'delimiter', foreground: '616d7c' },
      { token: 'delimiter.bracket', foreground: '8b98a9' }
    ],
    colors: {
      'editor.background': '#0e1218',
      'editor.foreground': '#98a5b6',
      'editorLineNumber.foreground': '#3c4653',
      'editorLineNumber.activeForeground': '#98a5b6',
      'editor.lineHighlightBackground': '#161d27',
      'editor.selectionBackground': '#24404a',
      'editor.inactiveSelectionBackground': '#1b2731',
      'editorGutter.background': '#0e1218',
      'editorWidget.background': '#18202b',
      'editorWidget.border': '#2a3441',
      'editorSuggestWidget.background': '#18202b',
      'editorSuggestWidget.border': '#2a3441',
      'scrollbarSlider.background': '#ffffff14',
      'scrollbarSlider.hoverBackground': '#ffffff22',
      'scrollbarSlider.activeBackground': '#ffffff2e',

      //. diff 专用配色：和 DiffLite 的 --mc-add-* / --mc-del-* 同源
      'diffEditor.insertedTextBackground': '#4f9d6921',
      'diffEditor.removedTextBackground': '#e0574f1f',
      'diffEditor.insertedLineBackground': '#4f9d6914',
      'diffEditor.removedLineBackground': '#e0574f12',
      'diffEditor.diagonalFill': '#ffffff0f',
      'diffEditorOverview.insertedForeground': '#4f9d6980',
      'diffEditorOverview.removedForeground': '#e0574f80'
    }
  });
}
