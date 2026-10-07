// Keep the VS Code API private. No local network listener is needed.
export function createVSCodeHost(vscode, target) {
  let state = vscode.getState() || {};
  const pending = new Map();
  let sequence = 0;
  let importHandler;
  let experimentHandler;
  let sourceChangedHandler;
  let sourceUnavailableHandler;
  let queuedSourceStatus;
  let queuedContent;
  function request(type, payload, timeoutMessage, timeout = 45000) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(timeoutMessage));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      try { vscode.postMessage({ type, id, ...payload }); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  }
  target.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'tensorv:response') {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.ok) request.resolve(message.data);
      else request.reject(Object.assign(new Error(message.message || '本地 Python 执行失败。'), { code: message.code }));
    } else if (message.type === 'tensorv:import' && typeof message.code === 'string' && message.code.length <= 20000) {
      queuedContent = null;
      if (importHandler) importHandler(message);
      else queuedContent = message;
    } else if (message.type === 'tensorv:experiment' && typeof message.text === 'string' && new TextEncoder().encode(message.text).byteLength <= 128 * 1024) {
      queuedContent = null;
      if (experimentHandler) experimentHandler(message);
      else queuedContent = message;
    } else if (message.type === 'tensorv:sourceChanged' && typeof message.source?.id === 'string' && typeof message.code === 'string' && message.code.length <= 20000) {
      queuedSourceStatus = null;
      if (sourceChangedHandler) sourceChangedHandler(message);
      else queuedSourceStatus = message;
    } else if (message.type === 'tensorv:sourceUnavailable' && typeof message.source?.id === 'string') {
      queuedSourceStatus = null;
      if (sourceUnavailableHandler) sourceUnavailableHandler(message);
      else queuedSourceStatus = message;
    }
  });
  return {
    getItem(key) { return state.storage?.[key] ?? null; },
    setItem(key, value) {
      const next = { ...state, storage: { ...state.storage, [key]: value } };
      vscode.setState(next);
      state = next;
    },
    request(action, payload) {
      return request('tensorv:request', { action, payload }, '本地执行未响应，请使用“TensorV: 重启执行环境”后重试。');
    },
    copy(text) {
      if (typeof text !== 'string') return Promise.reject(new Error('复制内容必须是文本。'));
      return request('tensorv:copy', { text }, '剪贴板未响应，请重试复制。', 10000);
    },
    onImport(handler) {
      importHandler = handler;
      if (queuedContent?.type === 'tensorv:import') { const message = queuedContent; queuedContent = null; handler(message); }
    },
    onExperiment(handler) {
      experimentHandler = handler;
      if (queuedContent?.type === 'tensorv:experiment') { const message = queuedContent; queuedContent = null; handler(message); }
    },
    onSourceChanged(handler) {
      sourceChangedHandler = handler;
      if (queuedSourceStatus?.type === 'tensorv:sourceChanged') { const message = queuedSourceStatus; queuedSourceStatus = null; handler(message); }
    },
    onSourceUnavailable(handler) {
      sourceUnavailableHandler = handler;
      if (queuedSourceStatus?.type === 'tensorv:sourceUnavailable') { const message = queuedSourceStatus; queuedSourceStatus = null; handler(message); }
    },
    bindSource(sourceId) { vscode.postMessage({ type: 'tensorv:bindSource', sourceId }); },
    editSource(sourceId) { vscode.postMessage({ type: 'tensorv:editSource', sourceId }); },
    getSource(sourceId) {
      return request('tensorv:request', { action: 'getSource', payload: { sourceId } }, '源文件同步未响应，请重新从 Python 编辑器运行。', 10000);
    },
    openExperiment() { vscode.postMessage({ type: 'tensorv:openExperiment' }); },
    ready() { vscode.postMessage({ type: 'tensorv:ready' }); },
    revealLine(line) { vscode.postMessage({ type: 'tensorv:revealLine', line }); },
    save(filename, content) { vscode.postMessage({ type: 'tensorv:save', filename, content }); },
  };
}

export const host = typeof globalThis.acquireVsCodeApi === 'function'
  ? createVSCodeHost(globalThis.acquireVsCodeApi(), globalThis.window) : null;
