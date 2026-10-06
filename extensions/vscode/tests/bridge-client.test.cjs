const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { BridgeClient } = require('../lib/bridge-client.cjs');

test('spawn uses no shell, a hidden window, and only packaged runtime PYTHONPATH', async () => {
  let called;
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  child.stdin.on('finish', () => child.emit('close', 0));
  const client = new BridgeClient({ python: 'python path', runtime: '/runtime', cwd: '/workspace', spawnProcess: (...args) => { called = args; return child; } });
  assert.equal(called[0], 'python path');
  assert.equal(called[2].shell, false);
  assert.equal(called[2].windowsHide, true);
  assert.equal(called[2].env.PYTHONPATH, '/runtime');
  assert.equal(called[1].at(-1), '/runtime');
  assert.match(called[1][2], /sys\.path\.insert\(0/);
  const request = client.request('execute', { code: 'pass' });
  child.stdout.write('{"id":1,"ok":true,"data":{"steps":[]}}\n');
  assert.deepEqual(await request, { steps: [] });
  await client.close();
  assert.equal(client.pending.size, 0);
});

test('malformed protocol rejects pending requests and closes input', async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  child.stdin.on('finish', () => child.emit('close', 0));
  const client = new BridgeClient({ python: 'python', runtime: '/runtime', cwd: '/workspace', spawnProcess: () => child });
  const request = client.request('execute', { code: 'pass' });
  child.stdout.write('unexpected native stdout\n');
  await assert.rejects(request, /无效数据/);
  await client.close();
});

const root = path.resolve(__dirname, '../../..');
const venv = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const python = process.env.TENSORV_PYTHON || (existsSync(venv) ? venv : null);

test('real Python execute, native stdout isolation, slice and timeout recovery', { skip: !python, timeout: 60_000 }, async () => {
  let nativeOutput = '';
  const cwd = mkdtempSync(path.join(tmpdir(), 'tensorv-bridge-test-'));
  mkdirSync(path.join(cwd, 'tensorv'));
  writeFileSync(path.join(cwd, 'tensorv/__init__.py'), 'raise RuntimeError("Workspace tensorv must not replace runtime")');
  writeFileSync(path.join(cwd, 'local_helper.py'), 'VALUE = 6');
  const runtime = path.join(root, 'extensions/vscode/runtime');
  const client = new BridgeClient({ python, runtime: existsSync(runtime) ? runtime : root, cwd, log: text => { nativeOutput += text; } });
  try {
    const result = await client.request('execute', {
      code: "import os\nimport subprocess\nimport sys\nfrom local_helper import VALUE\nos.write(1, b'native-output\\n')\nsubprocess.run([sys.executable, '-c', \"print('child-output')\"])\nx = torch.arange(VALUE).reshape(2, 3)",
    });
    assert.equal(result.error, null);
    const tensor = result.steps.at(-1).tensors.find(tensor => tensor.name === 'x');
    assert.deepEqual(tensor.shape, [2, 3]);
    assert.deepEqual((await client.request('slice', { id: tensor.id })).values, [[0, 1, 2], [3, 4, 5]]);
    assert.match(nativeOutput, /native-output/);
    assert.match(nativeOutput, /child-output/);
    await assert.rejects(client.request('execute', { code: 'while True: pass' }), /已重置/);
    const recovered = await client.request('execute', { code: 'x = torch.ones(2)' });
    assert.equal(recovered.error, null);
    assert.deepEqual(recovered.steps.at(-1).tensors[0].shape, [2]);
  } finally {
    await client.close();
    const target = path.resolve(cwd);
    if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith('tensorv-bridge-test-')) throw new Error('Invalid temporary workspace');
    rmSync(target, { recursive: true, force: true });
  }
  assert.equal(client.child.exitCode, 0);
});
