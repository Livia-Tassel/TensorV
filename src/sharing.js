import { experimentURL, serializeExperiment, parseExperiment, decodeExperiment } from './experiments';
import './sharing.css';

export const PUBLIC_WORKSPACE = 'https://tensorv.43.135.182.151.nip.io/';

export function setupSharing({ host, capture, importExperiment, pauseForImport, download, openDialog, toast, showError }) {
  const $ = (selector) => document.querySelector(selector);
  let captured = null;
  let generation = 0;
  async function openShare() {
    const current = ++generation;
    try { captured = capture(); }
    catch (error) { toast(error.message); return; }
    $('#share-link').value = '';
    $('#share-error').hidden = true;
    $('#copy-experiment-link').disabled = true;
    $('#share-summary').textContent = captured.view.step
      ? `${captured.title} · 第 ${captured.view.step.line} 行 · ${captured.view.after?.name || '张量'}`
      : `${captured.title} · 仅代码，未包含执行视图`;
    $('#share-link-status').textContent = '正在生成链接…';
    openDialog('#share-dialog');
    try {
      const link = await experimentURL(captured, host ? PUBLIC_WORKSPACE : window.location.href);
      if (current !== generation) return;
      $('#share-link').value = link;
      $('#copy-experiment-link').disabled = false;
      $('#share-link-status').textContent = host ? '链接在在线工作区打开。' : '打开链接后，点击运行以还原查看位置。';
      if (!host && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
        $('#share-link-status').textContent = '当前链接指向本机；跨设备分享请使用实验文件或在线工作区。';
      }
    } catch (error) {
      if (current !== generation) return;
      $('#share-link-status').textContent = '';
      $('#share-error').textContent = `${error.message} 可下载实验文件发送。`;
      $('#share-error').hidden = false;
    }
  }
  function importText(text) {
    pauseForImport();
    try { importExperiment(parseExperiment(text)); }
    catch (error) { showError({ type: '实验导入', message: error.message }); }
  }
  $('#share-experiment').onclick = openShare;
  $('#copy-experiment-link').onclick = async () => {
    const link = $('#share-link').value;
    if (!link) return;
    try {
      if (host) await host.copy(link);
      else await navigator.clipboard.writeText(link);
      toast('实验链接已复制。');
    } catch {
      $('#share-link').focus(); $('#share-link').select();
      $('#share-link-status').textContent = '链接已选中，可手动复制。';
    }
  };
  $('#download-experiment').onclick = () => {
    if (!captured) return;
    const filename = captured.title.replace(/\.py$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
    download(serializeExperiment(captured), `${filename}.tensorv.json`, 'application/json');
    toast(host ? '已打开保存对话框。' : '实验文件已下载。');
  };
  $('#open-experiment').onclick = () => host ? host.openExperiment() : $('#experiment-file-input').click();
  $('#experiment-file-input').onchange = async (event) => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    pauseForImport();
    if (file.size > 128 * 1024) { showError({ type: '实验导入', message: '实验文件不能超过 128 KiB。' }); return; }
    try { importText(await file.text()); }
    catch { showError({ type: '实验导入', message: '无法读取实验文件。' }); }
  };
  host?.onExperiment((message) => importText(message.text));
  async function importHash() {
    if (!location.hash.startsWith('#tv=')) return false;
    pauseForImport();
    const fragment = location.hash;
    try {
      importExperiment(await decodeExperiment(fragment));
      history.replaceState(null, '', location.pathname + location.search);
    } catch (error) { showError({ type: '实验导入', message: error.message }); }
    return true;
  }
  window.addEventListener('hashchange', () => { void importHash(); });
  return { importHash, openShare };
}
