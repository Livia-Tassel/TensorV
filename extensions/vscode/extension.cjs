'use strict';

const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const { BridgeClient } = require('./lib/bridge-client.cjs');
const { webviewHtml, ImportQueue } = require('./lib/webview.cjs');
const { readExperimentText, MAX_EXPERIMENT_BYTES } = require('./lib/experiments.cjs');
const { SourceBinding, sourceError } = require('./lib/source-binding.cjs');

let controller;

class TensorVController {
  constructor(context) {
    this.context = context;
    this.output = vscode.window.createOutputChannel('TensorV');
    this.panel = null;
    this.bridge = null;
    this.bridgeKey = null;
    this.source = null;
    this.generation = 0;
    this.requestChain = Promise.resolve();
    this.bindings = new SourceBinding(message => {
      if (message.type === 'tensorv:sourceUnavailable' && this.source?.id === message.source.id) this.source = null;
      if (!this.bindings.record) { this.sourceFileWatcher?.dispose(); this.sourceFileWatcher = null; }
      if (this.panel) void Promise.resolve(this.panel.webview.postMessage(message)).catch(error => this.output.appendLine(error.message));
    });
    context.subscriptions.push(this.output);
  }

  trusted() {
    if (!vscode.workspace.isTrusted) throw new Error('请先在 VS Code 中信任此工作区，再运行 TensorV Python 代码。');
  }

  resource() {
    return this.source?.uri || vscode.window.activeTextEditor?.document.uri || vscode.workspace.workspaceFolders?.[0]?.uri;
  }

  folder(resource = this.resource()) {
    return (resource && vscode.workspace.getWorkspaceFolder(resource)) || vscode.workspace.workspaceFolders?.[0];
  }

  readSource(id, expectedVersion) {
    const document = this.bindings.document(id);
    // File watcher notifications can lag behind an execution click. A deleted
    // file must not remain executable merely because its editor buffer exists.
    if (document.uri.scheme === 'file' && !fs.existsSync(document.uri.fsPath)) {
      this.bindings.removed(document.uri);
      throw sourceError('源文件已删除，请选择其他 Python 文件。');
    }
    return this.bindings.read(id, expectedVersion);
  }

  async interpreter(resource) {
    const folder = this.folder(resource);
    const configured = vscode.workspace.getConfiguration('tensorv', resource).get('pythonPath', '').trim();
    if (configured) {
      const expanded = configured.replaceAll('${workspaceFolder}', folder?.uri.fsPath || '');
      return !path.isAbsolute(expanded) && /[\\/]/.test(expanded) && folder
        ? path.resolve(folder.uri.fsPath, expanded) : expanded;
    }
    if (folder) {
      const venv = path.join(folder.uri.fsPath, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
      if (fs.existsSync(venv)) return venv;
    }
    const extension = vscode.extensions.getExtension('ms-python.python');
    if (extension) {
      try {
        const api = extension.isActive ? extension.exports : await extension.activate();
        const environments = api?.environments;
        if (environments?.getActiveEnvironmentPath && environments?.resolveEnvironment) {
          const active = environments.getActiveEnvironmentPath(resource);
          const environment = await environments.resolveEnvironment(active);
          if (environment?.executable?.uri) return environment.executable.uri.fsPath;
        }
      } catch (error) { this.output.appendLine(`Python 扩展解释器读取失败：${error.message}`); }
    }
    return 'python';
  }

  async getBridge(resource = this.resource()) {
    this.trusted();
    const generation = this.generation;
    const python = await this.interpreter(resource);
    if (generation !== this.generation) throw new Error('执行环境已重置，请重新运行。');
    // Import from packaged runtime, with no dependency on this source checkout.
    const runtime = path.join(this.context.extensionPath, 'runtime');
    const cwd = this.folder(resource)?.uri.fsPath || runtime;
    const key = JSON.stringify([python, cwd]);
    if (this.bridge?.closed || key !== this.bridgeKey) {
      if (this.bridge) await this.bridge.close();
      if (generation !== this.generation) throw new Error('执行环境已重置，请重新运行。');
      this.bridge = null;
    }
    if (!this.bridge) {
      this.output.appendLine(`Python: ${python}\n工作目录: ${cwd}`);
      this.bridge = new BridgeClient({ python, runtime, cwd, log: text => this.output.append(text) });
      this.bridgeKey = key;
    }
    return this.bridge;
  }

  open() {
    if (this.panel) { this.panel.reveal(vscode.ViewColumn.Beside); return this.panel; }
    const dist = vscode.Uri.joinPath(this.context.extensionUri, 'runtime', 'dist');
    const panel = vscode.window.createWebviewPanel('tensorv.inspector', 'TensorV', vscode.ViewColumn.Beside, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [dist],
    });
    this.panel = panel;
    this.imports = new ImportQueue(async message => {
      // Source mapping changes atomically with the delivered import, never
      // merely because another editor command was queued before readiness.
      const record = this.importRecords.get(message) || null;
      const previous = this.source;
      this.source = record;
      const delivered = await panel.webview.postMessage(message);
      if (!delivered && this.source === record) this.source = previous;
      return delivered;
    });
    this.importRecords = new WeakMap();
    const sourceSubscriptions = [
      vscode.workspace.onDidChangeTextDocument(event => {
        if (event.contentChanges.length) this.bindings.changed(event.document);
      }),
      vscode.workspace.onDidCloseTextDocument(document => this.bindings.closed(document)),
      vscode.window.tabGroups.onDidChangeTabs(event => this.bindings.tabsChanged(event, vscode.window.tabGroups.all)),
      vscode.workspace.onDidDeleteFiles(event => event.files.forEach(uri => this.bindings.removed(uri))),
      vscode.workspace.onDidRenameFiles(event => event.files.forEach(file => this.bindings.removed(file.oldUri, true))),
    ];
    panel.onDidDispose(() => {
      for (const subscription of sourceSubscriptions) subscription.dispose();
      if (this.panel !== panel) return;
      this.panel = null;
      this.source = null;
      this.bindings.retire('检查器已关闭。', false);
      this.sourceFileWatcher?.dispose();
      this.sourceFileWatcher = null;
      void this.restart(false);
    }, null, this.context.subscriptions);
    panel.webview.onDidReceiveMessage(message => {
      void this.onMessage(message, panel).catch(error => vscode.window.showErrorMessage(`TensorV：${error.message}`));
    }, null, this.context.subscriptions);
    try {
      panel.webview.html = webviewHtml(fs.readFileSync(path.join(dist.fsPath, 'index.html'), 'utf8'), {
        cspSource: panel.webview.cspSource,
        resourceUri: relative => panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, ...relative.split('/'))).toString(),
      });
    } catch (error) {
      panel.dispose();
      throw new Error(`无法加载插件前端，请运行 npm run build:vscode 后重新打包。${error.message}`);
    }
    return panel;
  }

  async runEditor(selectionOnly) {
    this.trusted();
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'python') throw new Error('请先打开一个 Python 文件。');
    if (selectionOnly && editor.selection.isEmpty) throw new Error('请先选择要运行的 Python 代码。');
    const code = selectionOnly ? editor.document.getText(editor.selection) : editor.document.getText();
    if (!code.trim()) throw new Error('当前 Python 代码为空。');
    if (code.length > 20_000) throw new Error('代码超过 20,000 字符，请选择较小的片段运行。');
    this.open();
    const source = this.bindings.replace(editor.document, {
      mode: selectionOnly ? 'selection' : 'file', lineOffset: selectionOnly ? editor.selection.start.line : 0,
    });
    if (!selectionOnly && editor.document.uri.scheme === 'file') {
      this.sourceFileWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(path.dirname(editor.document.uri.fsPath), '*'), true, true, false,
      );
      this.sourceFileWatcher.onDidDelete(uri => this.bindings.removed(uri));
    }
    const record = { ...source, uri: editor.document.uri };
    const title = path.basename(editor.document.fileName) + (selectionOnly ? ` · 选区 L${record.lineOffset + 1}` : '');
    const message = { type: 'tensorv:import', code, title, source };
    this.importRecords.set(message, record);
    await this.imports.enqueue(message);
  }

  async openExperiment() {
    const selection = await vscode.window.showOpenDialog({
      title: '打开 TensorV 实验', canSelectMany: false, canSelectFiles: true, canSelectFolders: false,
      filters: { 'TensorV 实验': ['tensorv.json'], JSON: ['json'] },
    });
    if (!selection?.length) return;
    const text = await readExperimentText(vscode.workspace.fs, selection[0]);
    // A single queue keeps the newest file/experiment when the view starts.
    // No Python execution occurs here. The frontend validates JSON and waits
    // for a separate, explicit Run action.
    this.open();
    this.bindings.retire('已打开实验副本，先前的源文件绑定已结束。');
    await this.imports.enqueue({ type: 'tensorv:experiment', text });
  }

  async onMessage(message, panel) {
    if (!message || typeof message !== 'object' || panel !== this.panel) return;
    if (message.type === 'tensorv:ready') { await this.imports.markReady(); return; }
    if (message.type === 'tensorv:bindSource') {
      try {
        this.bindings.bind(message.sourceId);
        if (message.sourceId === null && this.source?.mode === 'file') this.source = null;
      } catch (error) {
        if (error.code !== 'SOURCE_UNAVAILABLE') throw error;
      }
      return;
    }
    if (message.type === 'tensorv:editSource') {
      const document = this.bindings.document(message.sourceId, false);
      await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One });
      return;
    }
    if (message.type === 'tensorv:openExperiment') { await this.openExperiment(); return; }
    if (message.type === 'tensorv:copy') {
      if (!['string', 'number'].includes(typeof message.id)) return;
      try {
        if (typeof message.text !== 'string' || Buffer.byteLength(message.text, 'utf8') > MAX_EXPERIMENT_BYTES * 8) {
          throw new Error('复制内容必须是文本，且不超过 1 MiB。');
        }
        await vscode.env.clipboard.writeText(message.text);
        await panel.webview.postMessage({ type: 'tensorv:response', id: message.id, ok: true, data: null });
      } catch (error) {
        await panel.webview.postMessage({ type: 'tensorv:response', id: message.id, ok: false, message: error.message });
      }
      return;
    }
    if (message.type === 'tensorv:request') {
      if (!['string', 'number'].includes(typeof message.id)) return;
      if (message.action === 'getSource') {
        try {
          this.trusted();
          const data = this.readSource(message.payload?.sourceId);
          await panel.webview.postMessage({ type: 'tensorv:response', id: message.id, ok: true, data });
        } catch (error) {
          await panel.webview.postMessage({ type: 'tensorv:response', id: message.id, ok: false, message: error.message, code: error.code });
        }
        return;
      }
      const generation = this.generation;
      const resource = this.resource();
      // Serial execution preserves the Runner's snapshot ordering, including
      // requests that arrive during interpreter discovery or replacement.
      const execute = async () => {
        try {
          if (panel !== this.panel || generation !== this.generation) throw new Error('检查器已关闭或执行环境已重置，请重新运行。');
          this.trusted();
          if (!['execute', 'slice'].includes(message.action) || !message.payload || typeof message.payload !== 'object' || Array.isArray(message.payload)) {
            throw new Error('无效的 TensorV 请求。');
          }
          const linked = message.action === 'execute' && Object.hasOwn(message.payload, 'sourceId');
          if (linked && !Number.isInteger(message.payload.sourceVersion)) throw sourceError('缺少源文件版本，请同步源文件后重新运行。', 'SOURCE_CHANGED');
          if (message.action === 'execute' && !linked && (typeof message.payload.code !== 'string' || message.payload.code.length > 20_000)) {
            throw new Error('代码必须是文本，且不超过 20,000 字符。');
          }
          if (linked) this.readSource(message.payload.sourceId, message.payload.sourceVersion);
          const executionResource = linked ? this.bindings.document(message.payload.sourceId).uri : resource;
          const bridge = await this.getBridge(executionResource);
          if (panel !== this.panel || generation !== this.generation) throw new Error('检查器已关闭或执行环境已重置，请重新运行。');
          // Read again after asynchronous interpreter discovery, immediately
          // before sending to Python. A request can never run a stale mirror.
          const snapshot = linked ? this.readSource(message.payload.sourceId, message.payload.sourceVersion) : null;
          let data = await bridge.request(message.action, snapshot ? { code: snapshot.code } : message.payload);
          if (snapshot) {
            data = { ...data, source: { ...snapshot.source, code: snapshot.code } };
            if (this.bindings.active && this.bindings.record?.id === snapshot.source.id) {
              this.source = { ...snapshot.source, uri: executionResource };
            }
          }
          await panel.webview.postMessage({ type: 'tensorv:response', id: message.id, ok: true, data });
        } catch (error) {
          let detail = error.message;
          if (/PyTorch|No module named ['"]torch/.test(detail)) {
            detail += '\n在所选解释器的终端中安装 torch 和 numpy（python -m pip install torch numpy），或执行“TensorV: 选择 Python 解释器”选择已有依赖的环境。';
          }
          this.output.appendLine(detail);
          await panel.webview.postMessage({ type: 'tensorv:response', id: message.id, ok: false, message: detail, code: error.code });
        }
      };
      this.requestChain = this.requestChain.then(execute, execute);
      await this.requestChain;
      return;
    }
    if (message.type === 'tensorv:revealLine') {
      if (!this.source || !Number.isInteger(message.line) || message.line < 1) return;
      const document = await vscode.workspace.openTextDocument(this.source.uri);
      if (document.version !== this.source.version) {
        await vscode.window.showWarningMessage('源文件已修改，请重新运行文件或选区后再跳转。');
        return;
      }
      const line = message.line - 1 + this.source.lineOffset;
      if (line >= document.lineCount) return;
      const editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One });
      editor.selection = new vscode.Selection(line, 0, line, 0);
      editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
      return;
    }
    if (message.type === 'tensorv:save') {
      if (typeof message.content !== 'string' || message.content.length > 5_000_000 || typeof message.filename !== 'string') return;
      const filename = path.basename(message.filename.replaceAll('\\', '/'));
      const folder = this.folder()?.uri;
      const destination = await vscode.window.showSaveDialog({
        title: '保存 TensorV 导出', saveLabel: '保存',
        defaultUri: folder ? vscode.Uri.joinPath(folder, filename) : undefined,
      });
      if (destination) await vscode.workspace.fs.writeFile(destination, Buffer.from(message.content, 'utf8'));
    }
  }

  async selectInterpreter() {
    this.trusted();
    const resource = this.resource();
    const current = vscode.workspace.getConfiguration('tensorv', resource).get('pythonPath', '');
    const choice = await vscode.window.showQuickPick([
      { label: '输入 Python 路径', action: 'input', description: current || '可执行文件路径，不含命令参数' },
      { label: '浏览 Python 可执行文件', action: 'browse' },
      { label: '恢复自动选择', action: 'auto', description: '.venv → Python 扩展 → python' },
    ], { title: 'TensorV: 选择 Python 解释器' });
    if (!choice) return;
    let value = '';
    if (choice.action === 'input') {
      value = await vscode.window.showInputBox({ title: 'Python 可执行文件路径', value: current, ignoreFocusOut: true, placeHolder: '例如 D:\\project\\.venv\\Scripts\\python.exe' });
      if (!value?.trim()) return;
      value = value.trim();
    } else if (choice.action === 'browse') {
      const selection = await vscode.window.showOpenDialog({ title: '选择 Python 可执行文件', canSelectMany: false, canSelectFiles: true, canSelectFolders: false });
      if (!selection?.length) return;
      value = selection[0].fsPath;
    }
    const target = this.folder(resource) ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Global;
    await vscode.workspace.getConfiguration('tensorv', resource).update('pythonPath', value || undefined, target);
    await this.restart(false);
    await vscode.window.showInformationMessage('TensorV 解释器已更新，请重新运行代码。');
  }

  async restart(notify = true) {
    this.generation += 1;
    const bridge = this.bridge;
    this.bridge = null;
    this.bridgeKey = null;
    if (bridge) await bridge.close();
    if (notify) await vscode.window.showInformationMessage('TensorV 执行环境已重置，请重新运行代码。');
  }

  async dispose() { await this.restart(false); }
}

function activate(context) {
  controller = new TensorVController(context);
  const register = (name, callback) => context.subscriptions.push(vscode.commands.registerCommand(`tensorv.${name}`, async () => {
    try { return await callback(); }
    catch (error) { await vscode.window.showErrorMessage(`TensorV：${error.message}`); }
  }));
  register('open', () => { controller.open(); });
  register('openExperiment', () => controller.openExperiment());
  register('runFile', () => controller.runEditor(false));
  register('runSelection', () => controller.runEditor(true));
  register('selectInterpreter', () => controller.selectInterpreter());
  register('restart', () => { controller.trusted(); return controller.restart(); });
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('tensorv.pythonPath')) void controller.restart(false);
  }));
  return { version: '0.4.1' };
}

async function deactivate() { await controller?.dispose(); }

module.exports = { activate, deactivate };
