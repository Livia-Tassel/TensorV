'use strict';

const { randomBytes } = require('node:crypto');

function escapeAttribute(text) {
  return String(text).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function webviewHtml(html, { cspSource, resourceUri, nonce = randomBytes(24).toString('base64') }) {
  const policy = `default-src 'none'; script-src ${cspSource} 'nonce-${nonce}'; style-src ${cspSource} 'unsafe-inline'; img-src ${cspSource} data:; font-src ${cspSource}; connect-src 'none'; base-uri 'none'; form-action 'none';`;
  return html.replace(/\b(src|href)="([^"]+)"/g, (match, attr, path) => {
    if (/^(?:https?:|data:|#)/i.test(path)) return match;
    const relative = path.replace(/^\.\//, '').replace(/^\//, '');
    if (relative.split('/').includes('..')) throw new Error('无效的 Webview 资源路径。');
    return `${attr}="${escapeAttribute(resourceUri(relative))}"`;
  }).replace(/<script\b/g, `<script nonce="${nonce}"`)
    .replace(/<head>/i, `<head>\n<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}">`);
}

// Import messages may arrive before the webview is ready. Keep one stable
// latest request, and do not lose a newer request while postMessage awaits.
class ImportQueue {
  constructor(send) { this.send = send; this.ready = false; this.latest = null; this.delivered = null; this.flushing = false; }
  enqueue(message) { this.latest = message; return this.flush(); }
  markReady() { this.ready = true; return this.flush(); }
  async flush() {
    if (!this.ready || this.flushing) return;
    this.flushing = true;
    try {
      while (this.latest && this.latest !== this.delivered) {
        const message = this.latest;
        if (!await this.send(message)) { this.ready = false; break; }
        this.delivered = message;
      }
    } finally { this.flushing = false; }
  }
}

module.exports = { webviewHtml, ImportQueue };
