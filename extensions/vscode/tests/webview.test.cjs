const test = require('node:test');
const assert = require('node:assert/strict');
const { webviewHtml, ImportQueue } = require('../lib/webview.cjs');

test('bundled assets use webview URIs and a nonce CSP with no network', () => {
  const html = webviewHtml('<head><script type="module" src="./assets/app.js"></script><link href="/assets/app.css"></head>', {
    nonce: 'test-nonce', cspSource: 'https://local.vscode-cdn.net', resourceUri: path => `vscode-resource:/${path}`,
  });
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /nonce="test-nonce"/);
  assert.match(html, /src="vscode-resource:\/assets\/app.js"/);
  assert.match(html, /href="vscode-resource:\/assets\/app.css"/);
  assert.throws(() => webviewHtml('<head><script src="../secret.js"></script></head>', { resourceUri: x => x }), /无效/);
});

test('imports queue the latest until ready and tolerate repeated ready', async () => {
  const sent = [];
  const queue = new ImportQueue(async message => { sent.push(message); return true; });
  await queue.enqueue({ code: 'first' });
  await queue.enqueue({ code: 'latest' });
  assert.equal(sent.length, 0);
  await queue.markReady();
  await queue.markReady();
  assert.deepEqual(sent, [{ code: 'latest' }]);
});

test('new imports arriving while a delivery awaits are not lost', async () => {
  const sent = [];
  let release;
  const queue = new ImportQueue(message => {
    sent.push(message);
    return sent.length === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve(true);
  });
  await queue.markReady();
  const first = queue.enqueue({ code: 'first' });
  await queue.enqueue({ code: 'second' });
  await queue.enqueue({ code: 'third' });
  release(true);
  await first;
  assert.deepEqual(sent.map(x => x.code), ['first', 'third']);
});

test('failed delivery remains pending until webview announces readiness', async () => {
  let success = false;
  const sent = [];
  const queue = new ImportQueue(async message => { sent.push(message); return success; });
  await queue.enqueue({ code: 'retained' });
  await queue.markReady();
  success = true;
  await queue.markReady();
  assert.equal(sent.length, 2);
  assert.equal(queue.delivered.code, 'retained');
});
