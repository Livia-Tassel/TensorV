/* Real VS Code Extension Host smoke test. Run with scripts/test-vscode-host.ps1. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const vscode = require('vscode');

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function until(predicate, label, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
}

async function run() {
  const checks = [];
  const resultPath = process.env.TENSORV_TEST_RESULTS;
  const pythonPath = process.env.TENSORV_TEST_PYTHON;
  const untrusted = process.env.TENSORV_TEST_UNTRUSTED === '1';
  const originalCreatePanel = vscode.window.createWebviewPanel;
  const originalSpawn = childProcess.spawn;
  const originalInformation = vscode.window.showInformationMessage;
  const originalError = vscode.window.showErrorMessage;
  const originalOpenDialog = vscode.window.showOpenDialog;
  const notifications = [];
  const children = [];
  const incoming = [];
  const outgoing = [];
  let panel;
  let failure;
  let dialogSelection;
  let clipboardBefore;

  vscode.window.showOpenDialog = async () => dialogSelection;

  // Notification actions are not part of the execution contract and would
  // otherwise wait for a person to dismiss a toast in this hidden test host.
  vscode.window.showInformationMessage = async (message) => { notifications.push({ type: 'info', message }); };
  vscode.window.showErrorMessage = async (message) => { notifications.push({ type: 'error', message }); };

  childProcess.spawn = function (executable, args, options) {
    const child = originalSpawn.apply(this, arguments);
    if (Array.isArray(args) && args.some((argument) => String(argument).includes('tensorv.bridge'))) children.push(child);
    return child;
  };
  vscode.window.createWebviewPanel = function () {
    const created = originalCreatePanel.apply(this, arguments);
    if (String(arguments[0]).toLowerCase().includes('tensorv')) {
      panel = created;
      created.webview.onDidReceiveMessage((message) => incoming.push(message));
      const originalPostMessage = created.webview.postMessage.bind(created.webview);
      created.webview.postMessage = (message) => {
        outgoing.push(message);
        return originalPostMessage(message);
      };
      // Test-only probe: preserve the production HTML/CSP/assets, seed a real
      // persisted auto-run preference, and observe the rendered editor after
      // imports. The public extension never exposes the acquired VS Code API.
      let owner = created.webview;
      let descriptor;
      while (owner && !descriptor) {
        descriptor = Object.getOwnPropertyDescriptor(owner, 'html');
        owner = Object.getPrototypeOf(owner);
      }
      assert.ok(descriptor?.get && descriptor?.set, 'Webview HTML accessor is available to the test harness');
      Object.defineProperty(created.webview, 'html', {
        configurable: true,
        get() { return descriptor.get.call(created.webview); },
        set(html) {
          const nonce = html.match(/<script nonce="([^"]+)"/);
          if (nonce && html.includes('id="app"')) {
            const probe = `(() => {
              const api = acquireVsCodeApi();
              window.acquireVsCodeApi = () => api;
              const state = api.getState() || {};
              api.setState({ ...state, storage: { ...state.storage, 'tensorv:auto': 'true' } });
              window.addEventListener('message', ({ data }) => {
                if (data?.type === 'tensorv:test:probe') {
                  if (data.action === 'click') {
                    const target = document.querySelector(data.selector);
                    target?.focus(); target?.click();
                  } else if (data.action === 'auto') {
                    const target = document.querySelector('#auto');
                    if (target?.getAttribute('aria-checked') !== String(data.value)) target?.click();
                  }
                  api.postMessage({
                    type: 'tensorv:test:state', id: data.id,
                    code: Array.from(document.querySelectorAll('.cm-line'), node => node.textContent).join('\\n'),
                    title: document.querySelector('#document-title')?.textContent,
                    automatic: document.querySelector('#auto')?.getAttribute('aria-checked'),
                    status: document.querySelector('#execution-status')?.textContent,
                    sourceState: document.querySelector('#source-state')?.textContent,
                    sourceVisible: !document.querySelector('#source-bar')?.hidden,
                    editable: document.querySelector('.cm-content')?.getAttribute('contenteditable'),
                    stale: document.querySelector('#canvases')?.classList.contains('stale'),
                    scriptCount: document.querySelectorAll('#script-list .script-row').length,
                    currentScript: document.querySelector('#script-list .script-row.current')?.dataset.scriptId,
                    afterShape: document.querySelector('#tensor-after')?.selectedOptions[0]?.textContent,
                    values: Array.from(document.querySelectorAll('#grid-after .tensor-cell'), node => node.textContent),
                    error: document.querySelector('#error-box')?.hidden ? '' : document.querySelector('#error-box')?.textContent,
                    notice: document.querySelector('#experiment-notice')?.textContent,
                  });
                  return;
                }
                if (data?.type === 'tensorv:test:enableAuto') {
                  const toggle = document.querySelector('#auto');
                  if (toggle?.getAttribute('aria-checked') === 'false') toggle.click();
                  api.postMessage({ type: 'tensorv:test:autoEnabled', automatic: toggle?.getAttribute('aria-checked') });
                  return;
                }
                if (data?.type !== 'tensorv:experiment') return;
                setTimeout(() => api.postMessage({
                  type: 'tensorv:test:experiment',
                  code: document.querySelector('.cm-content')?.textContent,
                  automatic: document.querySelector('#auto')?.getAttribute('aria-checked'),
                  sourceVisible: !!document.querySelector('#reveal-source:not([hidden])'),
                }), 900);
              });
            })();`;
            html = html.replace('<head>', `<head><script nonce="${nonce[1]}">${probe}</script>`);
          }
          descriptor.set.call(created.webview, html);
        },
      });
    }
    return created;
  };

  const responseFor = (id, from = 0) => outgoing.slice(from).find((message) => message.type === 'tensorv:response' && message.id === id);
  let probeSequence = 0;
  const probe = async (action = 'inspect', extra = {}) => {
    const id = ++probeSequence;
    await panel.webview.postMessage({ type: 'tensorv:test:probe', id, action, ...extra });
    return until(() => incoming.find((message) => message.type === 'tensorv:test:state' && message.id === id), 'webview probe replies', 5000);
  };
  const viewWhen = (predicate, label) => until(async () => {
    const state = await probe();
    return predicate(state) ? state : null;
  }, label);
  const executionCount = () => incoming.filter((message) => message.type === 'tensorv:request' && message.action === 'execute').length;
  const waitExecution = async (code, incomingStart, outgoingStart) => {
    const request = await until(() => incoming.slice(incomingStart).find((message) =>
      message.type === 'tensorv:request' && message.action === 'execute' && message.payload?.code === code), 'the current source reaches execute');
    const response = await until(() => responseFor(request.id, outgoingStart), 'current source returns Python output');
    assert.equal(response.ok, true, response.message);
    return response.data;
  };
  const runCommand = async (command, code) => {
    const incomingStart = incoming.length;
    const outgoingStart = outgoing.length;
    await vscode.commands.executeCommand(command);
    const request = await until(() => incoming.slice(incomingStart).find((message) =>
      message.type === 'tensorv:request' && message.action === 'execute' && message.payload?.code === code), `${command} sends the current code`);
    const response = await until(() => responseFor(request.id, outgoingStart), `${command} returns Python output`);
    assert.equal(response.ok, true, response.message);
    return response.data;
  };
  const runFromWebview = async (code) => {
    const incomingStart = incoming.length, outgoingStart = outgoing.length;
    panel.reveal(vscode.ViewColumn.Beside);
    await probe('click', { selector: '#run' });
    return waitExecution(code, incomingStart, outgoingStart);
  };
  const replaceDocument = async (document, code) => {
    const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    await editor.edit((builder) => builder.replace(new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), code));
    return editor;
  };

  try {
    assert.equal(vscode.workspace.isTrusted, !untrusted, 'The fixture has the intended workspace trust state');
    assert.ok(pythonPath && fs.existsSync(pythonPath), 'TENSORV_TEST_PYTHON must point to Python with PyTorch');
    const extension = vscode.extensions.all.find((item) => item.packageJSON.name === 'tensorv');
    assert.ok(extension, 'TensorV extension is discoverable');
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'The test fixture workspace is open');
    await vscode.workspace.getConfiguration('tensorv', folder.uri).update('pythonPath', pythonPath, vscode.ConfigurationTarget.Workspace);
    await extension.activate();
    const commands = await vscode.commands.getCommands(true);
    for (const name of ['open', 'openExperiment', 'runFile', 'runSelection', 'selectInterpreter', 'restart']) {
      assert.ok(commands.includes(`tensorv.${name}`), `tensorv.${name} is registered`);
    }
    checks.push('activation and command registration');

    const experiment = {
      format: 'tensorv-experiment', version: 1, title: 'Host 实验导入',
      code: 'raise RuntimeError("An imported experiment must never execute automatically")\n',
      environment: { torch: null, app: '0.4.0' },
      view: { step: null, referenceStep: null, before: null, after: null, compare: true, heatmap: true, precision: 4, tab: 'canvas' },
    };
    const experimentText = JSON.stringify(experiment);
    const experimentUri = vscode.Uri.joinPath(folder.uri, 'host.tensorv.json');
    await vscode.workspace.fs.writeFile(experimentUri, Buffer.from(experimentText));
    dialogSelection = [experimentUri];
    await vscode.commands.executeCommand('tensorv.openExperiment');
    await until(() => panel && incoming.some((message) => message.type === 'tensorv:ready'), 'production webview loads and sends ready');
    await until(() => outgoing.some((message) => message.type === 'tensorv:experiment' && message.text === experimentText), 'experiment queued before ready reaches webview');
    const initialView = await until(() => incoming.find((message) => message.type === 'tensorv:test:experiment'), 'production editor renders the imported experiment');
    assert.match(initialView.code, /must never execute automatically/);
    assert.equal(initialView.automatic, 'false', 'Imported experiments turn off a previously persisted auto-run preference');
    assert.equal(incoming.filter((message) => message.type === 'tensorv:request' && message.action === 'execute').length, 0,
      'Opening the panel must not execute a persisted draft');
    checks.push('production webview assets and no execution on open');
    assert.equal(children.length, 0, 'Importing an experiment must not start Python');
    checks.push('native UTF-8 experiment import waits for ready and never executes');

    const oversizedUri = vscode.Uri.joinPath(folder.uri, 'oversized.tensorv.json');
    await vscode.workspace.fs.writeFile(oversizedUri, Buffer.alloc(128 * 1024 + 1, 32));
    dialogSelection = [oversizedUri];
    const importCount = outgoing.filter((message) => message.type === 'tensorv:experiment').length;
    await vscode.commands.executeCommand('tensorv.openExperiment');
    assert.equal(outgoing.filter((message) => message.type === 'tensorv:experiment').length, importCount);
    assert.ok(notifications.some((item) => item.type === 'error' && /128 KiB/.test(item.message)));
    dialogSelection = [experimentUri];
    checks.push('native import rejects experiment files over 128 KiB');

    if (untrusted) {
      const document = await vscode.workspace.openTextDocument({ language: 'python', content: 'import torch\nx = torch.arange(6)\n' });
      await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
      await vscode.commands.executeCommand('tensorv.runFile');
      assert.ok(notifications.some((item) => item.type === 'error' && /信任/.test(item.message)));
      const request = { type: 'tensorv:request', id: 900002, action: 'execute', payload: { code: document.getText() } };
      panel.webview.html = '<!doctype html><html><body><script>' +
        'acquireVsCodeApi().postMessage(' + JSON.stringify(request).replaceAll('<', '\\u003c') + ');' +
        '</script></body></html>';
      const response = await until(() => responseFor(request.id), 'untrusted direct webview request is rejected');
      assert.equal(response.ok, false);
      assert.match(response.message, /信任/);
      assert.equal(children.length, 0, 'No Python bridge may spawn in an untrusted workspace');
      checks.push('untrusted workspace rejects commands and direct webview requests without starting Python');
      return;
    }

    const source = 'import torch\nx = torch.arange(24).reshape(2, 3, 4)\ny = x.transpose(1, 2)\nprint("tensorv-host-saved")\n';
    const draft = source.replace('tensorv-host-saved', 'tensorv-host-unsaved');
    const uri = vscode.Uri.joinPath(folder.uri, 'host-smoke.py');
    await vscode.workspace.fs.writeFile(uri, Buffer.from(source));
    const document = await vscode.workspace.openTextDocument(uri);
    let editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    await editor.edit((builder) => builder.replace(new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), draft));
    assert.equal(document.isDirty, true);
    let execution = await runCommand('tensorv.runFile', draft);
    assert.equal(execution.error, null);
    assert.match(execution.stdout, /tensorv-host-unsaved/);
    let tensor = execution.steps.at(-1).tensors.find((item) => item.name === 'y');
    assert.deepEqual(tensor.shape, [2, 4, 3]);
    assert.deepEqual(tensor.slice.values[0], [0, 4, 8]);
    assert.ok(children.length > 0, 'Execution starts the stdio bridge process');
    checks.push('unsaved Python file executes through the real webview and stdio bridge');

    // Reproduce the reported workflow with actual VS Code document edits and
    // real clicks inside the production Webview, including focus away from the
    // Python editor when running manually.
    const originalExample = 'import torch\nx = torch.arange(12).reshape(2, 3, 2)\ny = x.transpose(1, 2)\n';
    const changedExample = 'import torch\nx = torch.arange(36).reshape(3, 3, 4)\ny = x.transpose(1, 2)\n';
    await replaceDocument(document, originalExample);
    await runCommand('tensorv.runFile', originalExample);
    const originalView = await viewWhen((view) => view.status?.includes('已更新') && view.afterShape?.includes('[2, 2, 3]'), 'original user example renders');
    assert.equal(originalView.editable, 'false', 'A linked full-file mirror cannot be edited as an independent draft');
    const linkedScriptCount = originalView.scriptCount;
    await probe('auto', { value: true });
    let incomingStart = incoming.length, outgoingStart = outgoing.length;
    await replaceDocument(document, changedExample);
    execution = await waitExecution(changedExample, incomingStart, outgoingStart);
    assert.equal(execution.error, null);
    assert.deepEqual(execution.steps.at(-1).tensors.find((item) => item.name === 'y').shape, [3, 4, 3]);
    let view = await viewWhen((state) => state.status?.includes('已更新') && state.afterShape?.includes('[3, 4, 3]'), 'unsaved source edit updates the visible tensor');
    assert.equal(view.scriptCount, linkedScriptCount);
    assert.equal(document.isDirty, true);
    checks.push('automatic source updates reproduce arange(12) to arange(36) and render shape [3, 4, 3]');

    await probe('auto', { value: false });
    const beforeManualEdit = executionCount();
    await replaceDocument(document, originalExample);
    view = await viewWhen((state) => state.sourceState?.includes('待更新') && state.code === originalExample, 'manual mode marks the changed source stale');
    assert.equal(view.stale, true);
    await delay(850);
    assert.equal(executionCount(), beforeManualEdit);
    execution = await runFromWebview(originalExample);
    assert.deepEqual(execution.steps.at(-1).tensors.find((item) => item.name === 'y').shape, [2, 2, 3]);
    await viewWhen((state) => state.status?.includes('已更新') && state.afterShape?.includes('[2, 2, 3]'), 'right-side Run reads the unsaved bound source');
    checks.push('manual source updates stay pending and right-side Run reads the newest unsaved text');

    const beforeBurst = executionCount();
    for (let index = 0; index < 22; index++) {
      await replaceDocument(document, `import torch\nx = torch.arange(${6 * (index + 2)}).reshape(2, 3, ${index + 2})\ny = x.transpose(1, 2)\n`);
    }
    await replaceDocument(document, changedExample);
    view = await viewWhen((state) => state.code === changedExample && state.sourceState?.includes('待更新'), 'the last of many source changes reaches the same mirror');
    assert.equal(view.scriptCount, linkedScriptCount, 'Source updates do not consume the 20-script limit');
    assert.equal(executionCount(), beforeBurst);
    await runFromWebview(changedExample);
    await viewWhen((state) => state.status?.includes('已更新') && state.afterShape?.includes('[3, 4, 3]'), 'latest burst edit renders');
    checks.push('more than twenty source edits reuse one bound script');

    await probe('auto', { value: true });
    const unrelated = await vscode.workspace.openTextDocument({ language: 'python', content: 'import torch\nx = torch.tensor([999])\n' });
    const beforeUnrelated = executionCount();
    await replaceDocument(unrelated, 'import torch\nx = torch.tensor([888])\n');
    await delay(850);
    view = await probe();
    assert.equal(executionCount(), beforeUnrelated);
    assert.equal(view.code, changedExample);
    assert.match(view.afterShape, /\[3, 4, 3\]/);
    checks.push('editing another Python document does not replace or execute the bound source');

    const delayedSource = 'import time\nimport torch\ntime.sleep(1.4)\nx = torch.arange(12).reshape(2, 3, 2)\ny = x.transpose(1, 2)\n';
    incomingStart = incoming.length;
    await replaceDocument(document, delayedSource);
    await until(() => incoming.slice(incomingStart).find((message) => message.type === 'tensorv:request' && message.action === 'execute' && message.payload?.code === delayedSource), 'a slow source run is in flight');
    incomingStart = incoming.length; outgoingStart = outgoing.length;
    await replaceDocument(document, changedExample);
    await viewWhen((state) => state.code === changedExample, 'new source arrives before old execution settles');
    let oldResultWasFresh = false;
    await until(async () => {
      const state = await probe();
      if (state.status?.includes('已更新') && state.afterShape && !state.afterShape.includes('[3, 4, 3]')) oldResultWasFresh = true;
      return state.status?.includes('已更新') && state.afterShape?.includes('[3, 4, 3]');
    }, 'only the newest source is marked updated after an in-flight older run');
    execution = await waitExecution(changedExample, incomingStart, outgoingStart);
    assert.equal(oldResultWasFresh, false);
    assert.equal(execution.error, null);
    checks.push('edits during an older run discard its result and finish on the newest source');

    await probe('auto', { value: false });
    await replaceDocument(document, '#'.repeat(20001));
    view = await viewWhen((state) => /不可用|超|20,?000/.test(`${state.sourceState} ${state.error}`), 'oversized source invalidates the visible result');
    const beforeOversizedRun = executionCount();
    await probe('click', { selector: '#run' });
    await delay(850);
    view = await probe();
    assert.equal(executionCount(), beforeOversizedRun);
    assert.equal(view.stale, true);
    assert.ok(!view.sourceState?.includes('已更新'));
    await replaceDocument(document, changedExample);
    await runFromWebview(changedExample);
    await viewWhen((state) => state.sourceState?.includes('已更新'), 'valid source recovers after exceeding the length limit');
    checks.push('oversized source cannot silently rerun an old mirror and recovers after shortening');

    await probe('auto', { value: true });
    await probe('click', { selector: '#sidebar-examples [data-example]' });
    const exampleView = await viewWhen((state) => state.status?.includes('已更新') && !state.sourceVisible, 'choosing an example detaches the source');
    const beforeDetachedEdit = executionCount();
    await replaceDocument(document, originalExample);
    await delay(850);
    view = await probe();
    assert.equal(view.currentScript, exampleView.currentScript);
    assert.equal(view.code, exampleView.code);
    assert.equal(executionCount(), beforeDetachedEdit);
    checks.push('switching to an example detaches source edits without replacing or rerunning the example');

    // Restore the original smoke fixture before exercising selection and the
    // existing experiment-import/restart checks below.
    await probe('auto', { value: false });
    await replaceDocument(document, draft);
    await runCommand('tensorv.runFile', draft);
    if (process.env.TENSORV_TEST_CAPTURE_POINT) {
      const capturePoint = process.env.TENSORV_TEST_CAPTURE_POINT;
      fs.writeFileSync(capturePoint, 'ready');
      await until(() => fs.existsSync(`${capturePoint}.done`), 'optional live VS Code screenshot', 60000);
    }

    editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    editor.selection = new vscode.Selection(2, 0, 2, document.lineAt(2).text.length);
    const selection = document.getText(editor.selection);
    execution = await runCommand('tensorv.runSelection', selection);
    assert.equal(execution.error.type, 'NameError');
    assert.match(execution.error.message, /x/);
    const imported = outgoing.filter((message) => message.type === 'tensorv:import').at(-1);
    assert.equal(imported.code, selection);
    assert.equal(imported.source.lineOffset, 2);
    const selectionCount = executionCount();
    await replaceDocument(document, changedExample);
    await delay(850);
    assert.equal(executionCount(), selectionCount, 'Editing the whole document does not expand or autorun an explicit selection');
    execution = await runFromWebview(selection);
    assert.equal(execution.error.type, 'NameError');
    assert.ok(incoming.filter((message) => message.type === 'tensorv:request' && message.action === 'execute').at(-1).payload.code === selection);
    await replaceDocument(document, draft);
    checks.push('selection executes independently and preserves its source-line offset');

    for (const unavailableKind of ['closed', 'deleted']) {
      const unavailableUri = vscode.Uri.joinPath(folder.uri, `source-${unavailableKind}.py`);
      await vscode.workspace.fs.writeFile(unavailableUri, Buffer.from(originalExample));
      const unavailableDocument = await vscode.workspace.openTextDocument(unavailableUri);
      await vscode.window.showTextDocument(unavailableDocument, vscode.ViewColumn.One);
      await runCommand('tensorv.runFile', originalExample);
      await viewWhen((state) => state.sourceState?.includes('已更新'), `${unavailableKind} fixture first renders`);
      const sourceId = outgoing.filter((message) => message.type === 'tensorv:import').at(-1).source.id;
      if (unavailableKind === 'closed') {
        await vscode.window.showTextDocument(unavailableDocument, vscode.ViewColumn.One);
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        await until(() => !vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) =>
          tab.input?.uri?.toString() === unavailableUri.toString())), 'the actual source tab closes', 5000);
      } else {
        const edit = new vscode.WorkspaceEdit();
        edit.deleteFile(unavailableUri);
        assert.equal(await vscode.workspace.applyEdit(edit), true);
      }
      await until(() => outgoing.some((message) => message.type === 'tensorv:sourceUnavailable' && message.source?.id === sourceId), `${unavailableKind} source retires its binding`);
      view = await viewWhen((state) => state.sourceState?.includes('不可用'), `${unavailableKind} source is visibly unavailable`);
      assert.equal(view.stale, true);
      const beforeUnavailableRun = executionCount();
      await probe('click', { selector: '#run' });
      await delay(400);
      view = await probe();
      assert.equal(executionCount(), beforeUnavailableRun, 'An unavailable source must not run its old mirror');
      assert.ok(!view.sourceState?.includes('已更新'));
      checks.push(`${unavailableKind} source invalidates results and cannot rerun a stale mirror`);
    }

    const slowCode = 'import time\nimport torch\ntime.sleep(1.5)\nx = torch.arange(3)\n';
    const slowDocument = await vscode.workspace.openTextDocument({ language: 'python', content: slowCode });
    await vscode.window.showTextDocument(slowDocument, vscode.ViewColumn.One);
    const slowIncomingStart = incoming.length;
    const slowOutgoingStart = outgoing.length;
    await vscode.commands.executeCommand('tensorv.runFile');
    const slowRequest = await until(() => incoming.slice(slowIncomingStart).find((message) =>
      message.type === 'tensorv:request' && message.action === 'execute' && message.payload?.code === slowCode), 'slow Python request enters execution');
    await panel.webview.postMessage({ type: 'tensorv:test:enableAuto' });
    const autoState = await until(() => incoming.slice(slowIncomingStart).find((message) => message.type === 'tensorv:test:autoEnabled'), 'automatic execution is enabled while Python is running');
    assert.equal(autoState.automatic, 'true');
    const beforeImportExecutions = incoming.filter((message) => message.type === 'tensorv:request' && message.action === 'execute').length;
    const probeStart = incoming.length;
    await vscode.commands.executeCommand('tensorv.openExperiment');
    await until(() => responseFor(slowRequest.id, slowOutgoingStart), 'in-flight Python request settles after import');
    const importedView = await until(() => incoming.slice(probeStart).find((message) => message.type === 'tensorv:test:experiment'), 'experiment replaces the editor while execution is in flight');
    await delay(800);
    assert.match(importedView.code, /must never execute automatically/);
    assert.equal(importedView.automatic, 'false');
    assert.equal(importedView.sourceVisible, false);
    assert.equal(incoming.filter((message) => message.type === 'tensorv:request' && message.action === 'execute').length, beforeImportExecutions);
    await replaceDocument(slowDocument, 'import torch\nx = torch.arange(9)\n');
    await delay(850);
    const experimentAfterSourceEdit = await probe();
    assert.match(experimentAfterSourceEdit.code, /must never execute automatically/);
    assert.equal(executionCount(), beforeImportExecutions);
    checks.push('experiment imported during execution stays inert with persisted automatic-run enabled');

    const firstChild = children.at(-1);
    await vscode.commands.executeCommand('tensorv.restart');
    await until(() => firstChild.exitCode !== null || firstChild.signalCode !== null, 'restart terminates the previous bridge', 10000);
    await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    execution = await runCommand('tensorv.runFile', draft);
    assert.equal(execution.error, null);
    assert.match(execution.stdout, /tensorv-host-unsaved/);
    assert.ok(children.length >= 2);
    tensor = execution.steps.at(-1).tensors.find((item) => item.name === 'y');
    checks.push('execution environment restarts and runs again');

    // A second import after actual execution must also remain inert, including
    // any persisted automatic-run preference restored by the frontend.
    const finalExecutionCount = executionCount();
    const finalProbeStart = incoming.length;
    await vscode.commands.executeCommand('tensorv.openExperiment');
    const finalView = await until(() => incoming.slice(finalProbeStart).find((message) => message.type === 'tensorv:test:experiment'), 'rendered experiment clears the previous source button');
    assert.equal(finalView.sourceVisible, false);
    assert.equal(executionCount(), finalExecutionCount);
    checks.push('experiment import after a Python run does not trigger another execution');

    // The actual production webview was exercised above. This final, isolated
    // driver sends one slice request through VS Code's real Webview transport.
    const request = { type: 'tensorv:request', id: 900001, action: 'slice', payload: {
      id: tensor.id, row_axis: 1, col_axis: 2, indices: [1, 0, 0], row_start: 0, col_start: 0,
    } };
    const sliceOutgoingStart = outgoing.length;
    panel.webview.html = '<!doctype html><html><body><script>' +
      'acquireVsCodeApi().postMessage(' + JSON.stringify(request).replaceAll('<', '\\u003c') + ');' +
      '</script></body></html>';
    const slice = await until(() => responseFor(request.id, sliceOutgoingStart), 'the actual bridge answers a slice request');
    assert.equal(slice.ok, true, slice.message);
    assert.deepEqual(slice.data.values[0], [12, 16, 20]);
    checks.push('real snapshot slice resolves after restart');

    // Use a single real Webview API object to exercise clipboard acknowledgement
    // and prove the previous Python source mapping was cleared by the import.
    editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    clipboardBefore = await vscode.env.clipboard.readText();
    const copiedText = 'https://tensorv.example/#experiment=host-test';
    const copyRequest = { type: 'tensorv:copy', id: 900003, text: copiedText };
    panel.webview.html = '<!doctype html><html><body><script>' +
      'const api = acquireVsCodeApi(); api.postMessage(' + JSON.stringify(copyRequest) + ');' +
      'api.postMessage({type:"tensorv:revealLine",line:2});' +
      '</script></body></html>';
    const copyResponse = await until(() => responseFor(copyRequest.id), 'native clipboard acknowledges copy');
    assert.equal(copyResponse.ok, true, copyResponse.message);
    assert.equal(copyResponse.data, null);
    assert.equal(await vscode.env.clipboard.readText(), copiedText);
    await vscode.env.clipboard.writeText(clipboardBefore);
    clipboardBefore = undefined;
    await delay(100);
    assert.equal(editor.selection.active.line, 0, 'Imported experiments cannot reveal a stale Python source mapping');
    checks.push('native clipboard copy round-trips and experiment import clears source mapping');

    panel.dispose();
    panel = null;
    await until(() => children.every((child) => child.exitCode !== null || child.signalCode !== null), 'closing the panel releases bridge processes', 10000);
    assert.deepEqual(notifications.filter((item) => item.type === 'error' && !/128 KiB/.test(item.message)), []);
    checks.push('panel closure releases owned Python bridge processes');
  } catch (error) {
    failure = error;
  } finally {
    if (panel) panel.dispose();
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    vscode.window.createWebviewPanel = originalCreatePanel;
    childProcess.spawn = originalSpawn;
    vscode.window.showInformationMessage = originalInformation;
    vscode.window.showErrorMessage = originalError;
    vscode.window.showOpenDialog = originalOpenDialog;
    if (clipboardBefore !== undefined) await vscode.env.clipboard.writeText(clipboardBefore);
    const report = {
      ok: !failure,
      vscode: vscode.version,
      mode: untrusted ? 'untrusted' : 'trusted',
      checks,
      notifications,
      incoming: incoming.map((message) => ({ type: message.type, id: message.id, action: message.action })),
      outgoing: outgoing.map((message) => ({ type: message.type, id: message.id, ok: message.ok, message: message.message })),
      error: failure?.stack,
    };
    if (resultPath) fs.writeFileSync(resultPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
  if (failure) throw failure;
}

module.exports = { run };
