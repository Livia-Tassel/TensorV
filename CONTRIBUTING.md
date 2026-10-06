# 开发指南

GitHub Actions 在推送主分支及 Pull Request 时执行单元测试、生产构建和浏览器测试，配置见 [ci.yml](.github/workflows/ci.yml)。真实 gVisor 验收需在具备隔离运行时的验证主机上单独执行。

## 开发环境

先按[本地部署](docs/local-deployment.md)安装依赖。在项目根目录启动 Python 服务：

```powershell
# Windows
.\.venv\Scripts\python.exe -m tensorv.server
```

```sh
# macOS / Linux
.venv/bin/python -m tensorv.server
```

在另一个终端启动前端开发服务器：

```sh
npm run dev
```

Vite 默认地址为 `http://127.0.0.1:5173`，`/api` 请求代理到 `http://127.0.0.1:8765`。改变后端端口时，同时修改 `vite.config.js` 中的开发代理。生产环境使用 `npm run build` 生成的 `dist/`，不运行开发服务器。

## 代码结构

| 路径 | 职责 |
| --- | --- |
| `src/main.js` | 编辑器、执行状态、检查器交互及切片请求 |
| `src/layout.js`、`src/style.css` | 工作区结构、主题和响应式布局 |
| `src/scripts.js` | 脚本管理、本地存储和缓存迁移 |
| `src/inspect.js` | 数值格式、切片分布和导出 |
| `src/examples.js` | 示例与算子说明 |
| `src/host.js` | VS Code Webview 请求、导入和面板状态 |
| `src/diagnostics.js`、`src/diagnostics.css` | 形状诊断渲染和样式 |
| `tensorv/engine.py` | 代码插桩、张量快照、统计和切片 |
| `tensorv/diagnostics.py` | 基于实际输入形状的保守错误诊断 |
| `tensorv/server.py` | 本地 HTTP 服务和可信代码工作进程 |
| `tensorv/bridge.py` | VS Code 使用的 stdio JSON 通信入口 |
| `extensions/vscode/` | 扩展命令、解释器选择、Webview、打包清单和测试 |
| `tensorv/public_server.py` | 公共网关、会话、请求验证和限流 |
| `tensorv/sandbox.py`、`tensorv/sandbox_worker.py` | gVisor 执行、JSON 数据校验和独立沙箱入口 |
| `deploy/` | 执行镜像、服务、代理和遗留容器清理配置 |
| `tests/` | Python、JavaScript 和浏览器验证 |

数据语义和组件边界见[架构文档](docs/architecture.md)。

## 验证

```sh
npm run build
npm test
npm run test:ui
```

`npm test` 依次运行 Python 测试和 JavaScript 单元测试。Python 入口优先使用 `TENSORV_PYTHON`，其次选择项目 `.venv`，最后尝试系统 Python。运行前需要安装 `requirements.txt`。

浏览器测试会启动后端和 Vite，使用单个 worker。Windows 默认使用已安装的 Chrome；可设置 `PLAYWRIGHT_CHANNEL=msedge` 使用 Edge。其他平台首次使用前可安装 Chromium：

```sh
npx playwright install chromium
```

已有的 8765 / 5173 端口服务可能被本地测试复用，提交前请确认它们对应当前工作区。失败截图和 trace 位于 `test-results/`，仅用于本地验证，不作为发布产物提交。

修改执行引擎时，重点验证数值、stride、共享存储、历史快照和异常路径。修改界面时，除自动化测试外，应检查桌面与窄屏布局、键盘操作、空状态及服务错误。修改公共执行边界时，还需按照服务器部署文档验证隔离与资源回收。

## VS Code 开发与验收

在仓库根目录运行：

```sh
npm run test:vscode
npm run build:vscode
npm install --prefix extensions/vscode
npm run package:vscode
```

`build:vscode` 构建前端并将允许打包的 Python 源码复制到插件的 `runtime/`；`package:vscode` 生成 `extensions/vscode/tensorv-0.3.0.vsix`。VSIX 不包含 `.venv`、开发依赖、凭据或公共服务部署配置。构建及 CI 产物不等于 Marketplace 发布，也不会更新线上服务。

已有本地 VS Code 的 Windows 环境可验证真实扩展宿主：

```powershell
.\scripts\test-vscode-host.ps1
.\scripts\test-vscode-host.ps1 -Untrusted
```

脚本默认寻找 PATH 中的 `code` 和项目 `.venv\Scripts\python.exe`，也可传入 `-CodePath`、`-PythonPath`、`-ExtensionPath`。每次运行使用 `test-results/` 下独立的用户配置、扩展目录和测试工作区，不改变日常 VS Code 配置。

可信工作区测试使用真实生产 Webview、扩展宿主和 Python，验证未保存文件、选区独立执行、源码行偏移、快照切片、重启和面板关闭后的进程释放；通知弹窗由测试自动处理。未可信测试单独启用 VS Code 的工作区信任机制，检查编辑器命令和直接 Webview 请求均不能启动 Python。结果保存在各次运行的 `result.json`，此测试不替代其他平台及远程扩展宿主验收。

修改通信层时，应同时运行 Python bridge、JavaScript host 和插件单元测试；HTTP 浏览器测试通过不能证明 VS Code 的资源加载、CSP 或进程回收有效。修改诊断规则时，应保留原始异常，并验证复杂或不明确的表达式不会得到猜测性的诊断。

本地单元测试不能证明实际容器隔离有效。公共部署还需要 Linux、Docker 和 gVisor，并用配置中的实际镜像运行 `check_sandbox`，验证网络、文件系统、资源限制、会话隔离及故障清理。不要为了让本地测试通过而允许公共入口回退到本地 Runner。

## 实际沙箱集成验证

在已安装 Docker 和 gVisor 的 Linux 验证主机上构建执行镜像，然后从源码根目录运行：

```sh
docker build -f deploy/Dockerfile.sandbox -t tensorv-sandbox:0.2.0 .
TENSORV_SANDBOX_IMAGE=tensorv-sandbox:0.2.0 \
  python3 -m unittest discover -s tests -p test_sandbox_live.py -v
```

该组测试为显式启用：未设置 `TENSORV_SANDBOX_IMAGE` 时跳过。应串行运行，确保同一 Docker 实例没有其他 TensorV 执行任务；如使用部署主机，应先安排维护窗口并停止公共网关。测试会检查是否仍有 TensorV 容器存活，不应与在线请求并行。

验证覆盖非 root 身份、宿主目录及 Docker socket 不可见、只读根文件系统、无外部网络、临时文件隔离、执行超时、超量直接输出、子进程销毁和后续执行恢复。测试通过不代表已证明任意恶意代码都无法突破隔离。

仓库的 `.github/workflows/ci.yml` 配置了前端构建、Python / JavaScript 测试和浏览器验证。实际 gVisor 集成测试仍需在具备对应运行时的环境中单独启用；是否通过以具体提交的运行结果为准。

## 提交变更

Pull Request 应说明触发条件、行为变化、验证方式和尚未解决的限制。涉及使用方式、配置或运行边界的变更，应同步更新文档。

不要提交 `.venv/`、`node_modules/`、临时日志、服务器凭据、私钥、浏览器会话令牌或本地部署目录。涉及漏洞或隔离绕过的问题，先阅读[安全说明](SECURITY.md)，避免在公开 Issue 中发布可直接利用的细节。
