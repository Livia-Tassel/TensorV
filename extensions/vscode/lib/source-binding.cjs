'use strict';

const { randomUUID } = require('node:crypto');

function sourceError(message, code = 'SOURCE_UNAVAILABLE') {
  return Object.assign(new Error(message), { code });
}

// Exactly one native import owns a token. Pausing it does not revive older
// imports; every subsequent native import permanently retires the old token.
class SourceBinding {
  constructor(publish, makeId = randomUUID) {
    this.publish = publish;
    this.makeId = makeId;
    this.record = null;
    this.active = false;
  }

  metadata(record = this.record) {
    if (!record) return null;
    return { id: record.id, mode: record.mode, uri: record.document.uri.toString(),
      version: record.document.version, lineOffset: record.lineOffset };
  }

  replace(document, { mode = 'file', lineOffset = 0 } = {}) {
    this.retire('已连接新的代码来源，请从原 Python 文件重新运行以恢复联动。');
    this.record = { id: this.makeId(), document, mode, lineOffset };
    this.active = mode === 'file';
    return this.metadata();
  }

  retire(message = '源文件绑定已关闭，请从 Python 编辑器重新运行。', notify = true) {
    const source = this.metadata();
    this.record = null;
    this.active = false;
    if (source && notify) this.publish({ type: 'tensorv:sourceUnavailable', source, message });
  }

  unavailable(id, message) {
    const source = this.record?.id === id ? this.metadata() : { id };
    this.publish({ type: 'tensorv:sourceUnavailable', source, message });
    return sourceError(message);
  }

  document(id, requireActive = true) {
    if (typeof id !== 'string' || this.record?.id !== id || this.record.mode !== 'file') {
      throw this.unavailable(id, '源文件绑定已失效，请在 Python 编辑器中重新运行该文件。');
    }
    if (this.record.document.isClosed) {
      this.retire('源文件已关闭，请重新打开并从 Python 编辑器运行。');
      throw sourceError('源文件已关闭，请重新打开并从 Python 编辑器运行。');
    }
    if (requireActive && !this.active) throw sourceError('源码联动已暂停，请切回对应的源码脚本。');
    return this.record.document;
  }

  bind(id) {
    if (id === null) { this.active = false; return; }
    this.document(id, false);
    this.active = true;
    this.changed(this.record.document);
  }

  read(id, expectedVersion) {
    const document = this.document(id);
    const source = this.metadata();
    const code = document.getText();
    if (code.length > 20_000) throw this.unavailable(id, '源文件超过 20,000 字符，请缩短文件或重新选择较小片段运行。');
    if (expectedVersion !== undefined && expectedVersion !== source.version) {
      this.publish({ type: 'tensorv:sourceChanged', source, code });
      throw sourceError('源文件已更新，本次执行已取消；请运行最新代码。', 'SOURCE_CHANGED');
    }
    return { source, code };
  }

  changed(document) {
    if (!this.active || this.record?.mode !== 'file' || this.record.document !== document) return;
    try {
      const { source, code } = this.read(this.record.id);
      this.publish({ type: 'tensorv:sourceChanged', source, code });
    } catch (error) {
      if (error.code !== 'SOURCE_UNAVAILABLE') throw error;
    }
  }

  closed(document) {
    if (this.record?.document === document) this.retire('源文件已关闭，请重新打开并从 Python 编辑器运行。');
  }

  tabsChanged(event, groups) {
    const uri = this.record?.document.uri.toString();
    if (!uri) return;
    const matches = tab => [tab.input?.uri, tab.input?.original, tab.input?.modified]
      .some(candidate => candidate?.toString() === uri);
    // VS Code may keep the TextDocument model alive after its editor closes.
    // Retire on the last visible text/diff tab, while allowing split editors.
    if (event.closed.some(matches) && !groups.some(group => group.tabs.some(matches))) {
      this.retire('源文件标签页已关闭，请重新打开并从 Python 编辑器运行。');
    }
  }

  removed(uri, renamed = false) {
    const removed = uri.toString().replace(/\/$/, '');
    const source = this.record?.document.uri.toString();
    if (source === removed || source?.startsWith(`${removed}/`)) {
      this.retire(renamed ? '源文件已重命名，请从新文件重新运行以恢复联动。' : '源文件已删除，请选择其他 Python 文件。');
    }
  }
}

module.exports = { SourceBinding, sourceError };
