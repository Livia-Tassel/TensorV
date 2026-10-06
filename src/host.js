// Keep the VS Code API private. No local network listener is needed.
export function createVSCodeHost(vscode, target) {
  let state = vscode.getState() || {};
  const pending = new Map();
  let sequence = 0;
  let importHandler;
  let queuedImport;
  target.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'tensorv:response') {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.ok) request.resolve(message.data);
      else request.reject(new Error(message.message || '本地 Python 执行失败。'));
    } else if (message.type === 'tensorv:import' && typeof message.code === 'string' && message.code.length <= 20000) {
      if (importHandler) importHandler(message);
      else queuedImport = message;
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
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('本地执行未响应，请使用“TensorV: 重启执行环境”后重试。'));
        }, 45000);
        pending.set(id, { resolve, reject, timer });
        try { vscode.postMessage({ type: 'tensorv:request', id, action, payload }); }
        catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
      });
    },
    onImport(handler) {
      importHandler = handler;
      if (queuedImport) { const message = queuedImport; queuedImport = null; handler(message); }
    },
    ready() { vscode.postMessage({ type: 'tensorv:ready' }); },
    revealLine(line) { vscode.postMessage({ type: 'tensorv:revealLine', line }); },
    save(filename, content) { vscode.postMessage({ type: 'tensorv:save', filename, content }); },
  };
}

export const host = typeof globalThis.acquireVsCodeApi === 'function'
  ? createVSCodeHost(globalThis.acquireVsCodeApi(), globalThis.window) : null;
