'use strict';

const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');

class BridgeClient {
  constructor({ python, runtime, cwd, log = () => {}, spawnProcess = spawn }) {
    this.pending = new Map();
    this.nextId = 0;
    this.closed = false;
    this.log = log;
    this.stderr = '';
    // `-m` would import a workspace's same-named tensorv package before
    // PYTHONPATH. Put the bundled runtime first without changing the cwd used
    // by the user's imports, and pass its path as a plain argument.
    const bootstrap = 'import sys; sys.path.insert(0, sys.argv.pop(1)); from tensorv.bridge import main; main()';
    this.child = spawnProcess(python, ['-u', '-c', bootstrap, runtime], {
      cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONPATH: runtime, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' },
    });
    this.child.stderr.on('data', chunk => {
      const text = chunk.toString();
      this.stderr = (this.stderr + text).slice(-8000);
      log(text);
    });
    this.reader = createInterface({ input: this.child.stdout });
    this.reader.on('line', line => {
      try {
        const response = JSON.parse(line);
        const pending = this.pending.get(response.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(response.id);
        if (response.ok) pending.resolve(response.data);
        else pending.reject(new Error(response.message || 'Python 执行失败。'));
      } catch (error) {
        log(`桥接协议错误：${error.message}\n`);
        void this.close(new Error('Python 返回了无效数据，请重启执行环境。'));
      }
    });
    this.exited = new Promise(resolve => {
      this.child.once('close', (code, signal) => {
        this.closed = true;
        clearTimeout(this.killTimer);
        this.rejectAll(new Error(`Python 进程已退出（${signal || code}）。${this.stderr.trim()}`));
        this.reader.close();
        resolve();
      });
    });
    this.child.on('error', error => {
      this.closed = true;
      this.rejectAll(new Error(`无法启动 Python：${error.message}。请使用“TensorV: 选择 Python 解释器”。`));
    });
    this.child.stdin.on('error', error => {
      this.rejectAll(new Error(`Python 连接已关闭：${error.message}`));
    });
  }

  request(action, payload) {
    if (this.closed) return Promise.reject(new Error('执行环境已关闭，请重新运行。'));
    if (this.pending.size >= 32) return Promise.reject(new Error('待执行请求过多，请稍后重试。'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Covers Python startup (30s), execution (8s), and process cleanup.
        void this.close(new Error('执行环境响应超时，已关闭连接；请重新运行。'));
      }, 45_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, action, payload })}\n`, 'utf8', error => {
        if (error) void this.close(error);
      });
    });
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close(reason = new Error('执行环境已重启或关闭。')) {
    if (!this.closed) {
      this.closed = true;
      this.rejectAll(reason);
      // EOF lets Python's finally block terminate the worker. Do not kill the
      // bridge before Runner has had its startup/execution timeout to clean up.
      this.child.stdin.end();
      this.killTimer = setTimeout(() => this.child.kill(), 45_000);
      this.killTimer.unref();
    }
    return this.exited;
  }
}

module.exports = { BridgeClient };
