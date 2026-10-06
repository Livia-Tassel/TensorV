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
    const value = predicate();
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
    checks.push('selection executes independently and preserves its source-line offset');

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
    const executionCount = incoming.filter((message) => message.type === 'tensorv:request' && message.action === 'execute').length;
    const finalProbeStart = incoming.length;
    await vscode.commands.executeCommand('tensorv.openExperiment');
    const finalView = await until(() => incoming.slice(finalProbeStart).find((message) => message.type === 'tensorv:test:experiment'), 'rendered experiment clears the previous source button');
    assert.equal(finalView.sourceVisible, false);
    assert.equal(incoming.filter((message) => message.type === 'tensorv:request' && message.action === 'execute').length, executionCount);
    checks.push('experiment import after a Python run does not trigger another execution');

    // The actual production webview was exercised above. This final, isolated
    // driver sends one slice request through VS Code's real Webview transport.
    const request = { type: 'tensorv:request', id: 900001, action: 'slice', payload: {
      id: tensor.id, row_axis: 1, col_axis: 2, indices: [1, 0, 0], row_start: 0, col_start: 0,
    } };
    const outgoingStart = outgoing.length;
    panel.webview.html = '<!doctype html><html><body><script>' +
      'acquireVsCodeApi().postMessage(' + JSON.stringify(request).replaceAll('<', '\\u003c') + ');' +
      '</script></body></html>';
    const slice = await until(() => responseFor(request.id, outgoingStart), 'the actual bridge answers a slice request');
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
