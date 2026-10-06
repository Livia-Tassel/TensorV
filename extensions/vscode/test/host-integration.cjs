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
  const notifications = [];
  const children = [];
  const incoming = [];
  const outgoing = [];
  let panel;
  let failure;

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
    for (const name of ['open', 'runFile', 'runSelection', 'selectInterpreter', 'restart']) {
      assert.ok(commands.includes(`tensorv.${name}`), `tensorv.${name} is registered`);
    }
    checks.push('activation and command registration');

    await vscode.commands.executeCommand('tensorv.open');
    await until(() => panel && incoming.some((message) => message.type === 'tensorv:ready'), 'production webview loads and sends ready');
    await delay(150);
    assert.equal(incoming.filter((message) => message.type === 'tensorv:request' && message.action === 'execute').length, 0,
      'Opening the panel must not execute a persisted draft');
    checks.push('production webview assets and no execution on open');

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

    panel.dispose();
    panel = null;
    await until(() => children.every((child) => child.exitCode !== null || child.signalCode !== null), 'closing the panel releases bridge processes', 10000);
    assert.deepEqual(notifications.filter((item) => item.type === 'error'), []);
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
