export function layout({ icon, shortcut, automatic, compare, heatmap }) {
  const button = (id, label, glyph) => `<button id="${id}" class="icon-button" title="${label}" aria-label="${label}">${icon(glyph)}</button>`;
  return `
  <aside class="app-sidebar" id="sidebar" aria-label="工作区导航">
    <div class="sidebar-header"><strong>TensorV</strong>${button('sidebar-close', '收起侧栏', 'sidebar')}</div>
    <div class="sidebar-actions">
      <button class="sidebar-action" id="new-script">${icon('plus')}<span>新建脚本</span></button>
      <button class="sidebar-action" id="rail-search">${icon('search')}<span>搜索命令</span><kbd>${shortcut} K</kbd></button>
    </div>
    <div class="sidebar-scroll">
      <section class="sidebar-section"><div class="sidebar-section-heading"><span>脚本</span>${button('sidebar-import', '导入 Python 文件', 'upload')}</div><div id="script-list"></div></section>
      <section class="sidebar-section"><div class="sidebar-section-heading"><span>示例</span><button class="text-button" id="browse-examples" title="搜索全部示例" aria-label="浏览示例库">${icon('search')}</button></div><div id="sidebar-examples" class="sidebar-examples"></div></section>
    </div>
    <div class="sidebar-bottom"><button class="sidebar-action" id="theme" aria-label="切换浅色主题">${icon('sun')}<span>浅色主题</span></button><button class="sidebar-action" id="help" aria-label="使用帮助">${icon('info')}<span>使用帮助</span></button><a class="sidebar-action" href="https://docs.pytorch.org/docs/stable/tensors.html" target="_blank" rel="noreferrer">${icon('external')}<span>PyTorch 文档</span></a></div>
  </aside>
  <button class="sidebar-backdrop" id="sidebar-backdrop" aria-label="关闭侧栏" hidden></button>
  <div class="app-shell">
    <header class="topbar">
      <div class="document-heading">${button('sidebar-toggle', '切换侧栏', 'sidebar')}<button id="rename-current" class="document-title" title="重命名脚本"><span id="document-title">playground.py</span>${icon('chevron')}</button><span id="document-state" class="document-state" role="status">已保存</span></div>
      <div class="heading-actions"><button class="auto-control" id="auto" role="switch" aria-checked="${automatic}"><span class="switch ${automatic ? 'on' : ''}"></span>自动运行</button><button class="run-button" id="run">${icon('play')}运行<kbd>${shortcut} ↵</kbd></button></div>
    </header>
    <div class="mobile-view-switch" aria-label="工作区域"><button id="mobile-editor" aria-pressed="true">编辑器</button><button id="mobile-inspector" aria-pressed="false">检查器</button></div>
    <main class="workspace" data-mobile-view="editor">
      <section class="editor-panel panel" aria-label="Python 编辑器">
        <div class="panel-header"><div class="file-tab">${icon('code')}<span id="file-tab-name">playground.py</span></div><div class="toolbar-group">${button('import', '导入 Python 文件', 'upload')}${button('copy-code', '复制代码', 'copy')}${button('download', '下载 Python 代码', 'download')}${button('reset', '恢复当前示例', 'reset')}</div></div>
        <div id="editor"></div>
        <div class="editor-footer"><span id="execution-status" role="status"><i></i>等待运行</span><span id="cursor-position">Ln 1, Col 1</span></div>
        <div id="error-box" role="alert" hidden></div>
        <div class="console-section"><button id="console-toggle" aria-expanded="false"><span>输出 <span id="output-count">0</span></span><span id="console-chevron">＋</span></button><pre id="console" hidden></pre></div>
      </section>
      <div class="panel-resizer" id="panel-resizer" role="separator" aria-label="调整编辑器宽度" aria-orientation="vertical" aria-valuemin="26" aria-valuemax="52" aria-valuenow="36" tabindex="0"><span></span></div>
      <section class="inspector-panel panel" aria-label="张量检查器">
        <div class="panel-header"><strong class="panel-title">检查器</strong><div class="toolbar-group"><button id="compare" class="compare-button ${compare ? 'active' : ''}" aria-pressed="${compare}">${icon('layers')}前后对照</button><button id="focus-view" class="icon-button" aria-label="专注画布" aria-pressed="false" title="专注画布">${icon('expand')}</button></div></div>
        <div class="trace-section"><div class="trace-header"><div class="section-label"><span>执行步骤</span><span id="step-count">—</span></div><div class="playback-controls">${button('prev-step', '上一步', 'back')}${button('play-steps', '播放步骤', 'play')}${button('next-step', '下一步', 'chevron')}<select id="play-speed" aria-label="步骤播放速度"><option value="1500">1×</option><option value="3000">0.5×</option><option value="750">2×</option></select></div></div><div id="timeline" class="timeline"></div></div>
        <div class="inspector-content">
          <div id="step-heading"></div>
          <div class="view-toolbar"><div class="view-tabs" role="tablist" aria-label="查看方式"><button id="tab-canvas" role="tab" aria-controls="canvas-panel" aria-selected="true" data-tab="canvas">张量画布</button><button id="tab-memory" role="tab" aria-controls="memory-panel" aria-selected="false" tabindex="-1" data-tab="memory">存储映射</button><button id="tab-stats" role="tab" aria-controls="stats-panel" aria-selected="false" tabindex="-1" data-tab="stats">数值统计</button></div><div class="view-options"><button class="text-button" id="heatmap" aria-pressed="${heatmap}" title="按数值深浅着色">热力图</button><select id="precision" aria-label="数值显示精度"><option value="4">4 位精度</option><option value="6">6 位精度</option><option value="8">8 位精度</option></select>${button('export-data', '导出当前切片', 'download')}</div></div>
          <div id="canvas-panel" role="tabpanel" aria-labelledby="tab-canvas"><div id="canvases" class="canvases"></div><div class="canvas-legend"><span><i class="legend-before"></i>操作前</span><span><i class="legend-after"></i>操作后</span><span><i class="legend-changed"></i>数值改变</span></div></div>
          <div id="memory-panel" role="tabpanel" aria-labelledby="tab-memory" hidden></div><div id="stats-panel" role="tabpanel" aria-labelledby="tab-stats" hidden></div>
          <div id="metadata"></div><div id="explanation"></div>
        </div>
        <div class="inspector-footer"><span id="tensor-count">—</span><span id="timing">—</span></div>
      </section>
    </main>
    <footer class="statusbar"><span class="runtime" id="runtime" data-state="connecting"><i></i><span id="runtime-label">连接执行服务</span></span><span>CPU</span><span id="script-storage-status">浏览器本地存储</span><button id="status-help">快捷键</button></footer>
  </div>
  <dialog id="library-dialog" class="library-dialog" aria-labelledby="library-title"><div class="dialog-header"><h2 id="library-title">示例</h2><button class="icon-button" data-close aria-label="关闭示例库">${icon('close')}</button></div><label class="search-field">${icon('search')}<input id="example-search" placeholder="搜索名称或算子" aria-label="搜索教学示例"></label><div id="example-categories" class="category-filters"></div><div id="library-results" class="library-grid"></div><div class="dialog-footer"><span>在新脚本中打开，不覆盖当前内容</span><span id="library-count"></span></div></dialog>
  <dialog id="command-dialog" class="command-dialog" aria-label="快捷指令"><label class="search-field">${icon('search')}<input id="command-search" placeholder="搜索命令或示例" aria-label="搜索快捷指令"><button class="icon-button" data-close aria-label="关闭快捷指令">${icon('close')}</button></label><div id="command-results"></div><div class="dialog-footer">↑ ↓ 选择 · Enter 执行 · Esc 关闭</div></dialog>
  <dialog id="help-dialog" class="help-dialog" aria-labelledby="help-title"><div class="dialog-header"><h2 id="help-title">使用帮助</h2><button class="icon-button" data-close aria-label="关闭使用帮助">${icon('close')}</button></div><div class="shortcut-list"><span>运行代码<kbd>${shortcut} Enter</kbd></span><span>搜索命令<kbd>${shortcut} K</kbd></span><span>切换执行步骤<kbd>Alt ← / →</kbd></span><span>撤销编辑<kbd>${shortcut} Z</kbd></span><span>解除元素锁定<kbd>Esc</kbd></span></div><dl class="help-topics"><dt>张量画布</dt><dd>选择行列维度，使用索引控件查看其他维度。点击格子锁定元素；方向键移动焦点。</dd><dt>快照与存储</dt><dd>每条语句保留独立数值快照。相同存储编号表示共享底层内存，偏移量以元素计。</dd><dt>数据导出</dt><dd>CSV 和 JSON 只包含操作后画布的当前页，最多 24 × 24 个元素。</dd><dt>脚本保存</dt><dd>脚本保存在当前浏览器，最多 20 个。需要独立文件时下载为 .py。</dd></dl><p class="help-note">本地 Python 执行具有当前用户的文件和网络权限。</p></dialog>
  <dialog id="export-dialog" class="help-dialog" aria-labelledby="export-title"><div class="dialog-header"><h2 id="export-title">导出当前切片</h2><button class="icon-button" data-close aria-label="关闭导出">${icon('close')}</button></div><p class="export-description">包含原始数值、坐标和存储偏移，仅导出当前页。</p><div class="export-actions"><button class="export-card" id="export-csv">${icon('grid')}<strong>CSV</strong><span>逐元素坐标与数值</span></button><button class="export-card" id="export-json">${icon('code')}<strong>JSON</strong><span>数值、shape、stride 与切片信息</span></button></div></dialog>
  <dialog id="script-dialog" class="script-dialog" aria-labelledby="script-dialog-title"><form id="script-form"><div class="dialog-header"><h2 id="script-dialog-title">重命名脚本</h2><button type="button" class="icon-button" data-close aria-label="关闭脚本设置">${icon('close')}</button></div><label class="field-label" for="script-name">名称</label><input id="script-name" maxlength="80" required autocomplete="off"><p id="script-dialog-error" class="form-error" role="alert" hidden></p><div class="dialog-actions"><button type="button" class="secondary-button" data-close>取消</button><button class="primary-button" type="submit">保存</button></div></form></dialog>
  <dialog id="delete-dialog" class="script-dialog" aria-labelledby="delete-title"><div class="dialog-header"><h2 id="delete-title">删除脚本</h2><button class="icon-button" data-close aria-label="关闭删除确认">${icon('close')}</button></div><p id="delete-description"></p><div class="dialog-actions"><button class="secondary-button" data-close>取消</button><button id="confirm-delete" class="danger-button">删除</button></div></dialog>
  <input type="file" id="file-input" accept=".py,.txt" hidden><div id="toast" class="toast" role="status" hidden></div>`;
}
