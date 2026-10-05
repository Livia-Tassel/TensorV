# 本地部署

本文适用于在个人计算机上运行可信 Python 代码。需要开放给其他用户访问时，使用[服务器部署](server-deployment.md)中的公共模式。

## 环境要求

| 组件 | 要求 | 用途 |
| --- | --- | --- |
| Git | 可从命令行调用 | 获取和更新源码 |
| Python | 3.10+，且有适配当前平台的 PyTorch 发行包 | 执行服务 |
| Node.js | 20.19+ 或 22.12+ | 安装前端依赖和构建静态资源 |
| 浏览器 | 支持现代 JavaScript、CSS 和 localStorage | 工作区界面 |

运行依赖由 `requirements.txt` 声明，前端依赖由 `package-lock.json` 锁定。依赖安装后，本地编辑、执行和检查不需要连接外部服务；打开外部文档链接仍需要网络。

## 自动安装和启动

Windows PowerShell：

```powershell
git clone https://github.com/Livia-Tassel/TensorV.git
cd TensorV
.\start.ps1
```

若系统策略禁止执行脚本，可仅对本次进程设置执行策略：

```powershell
powershell -ExecutionPolicy Bypass -File .\start.ps1
```

macOS / Linux：

```sh
git clone https://github.com/Livia-Tassel/TensorV.git
cd TensorV
sh start.sh
```

脚本在项目目录创建 `.venv`。未检测到 Python 依赖或 `node_modules` 时会安装相应依赖，随后运行前端构建并启动服务。它不会在每次启动时更新已有依赖。

默认地址为 [http://127.0.0.1:8765](http://127.0.0.1:8765)，需要手动在浏览器中打开。终端保持运行，按 `Ctrl+C` 停止服务。

指定端口：

```powershell
.\start.ps1 -Port 9000
```

```sh
sh start.sh --port 9000
```

创建虚拟环境前，可通过 `TENSORV_PYTHON` 指定 Python 可执行文件。已有 `.venv` 时脚本继续使用该环境；切换 Python 大版本需要重新创建虚拟环境。

## 手动安装

先克隆仓库并进入项目根目录，再执行相应平台的命令。

Windows：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
npm ci
npm run build
.\.venv\Scripts\python.exe -m tensorv.server
```

macOS / Linux：

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm ci
npm run build
.venv/bin/python -m tensorv.server
```

服务默认仅监听 `127.0.0.1:8765`。可通过 `/api/health` 检查 HTTP 服务是否响应：

```sh
curl http://127.0.0.1:8765/api/health
```

健康接口响应不代表一段代码已经成功执行。首次运行还需要导入 PyTorch；验收时应在界面运行一个示例并检查返回数值。

## 后续启动

如果依赖和构建产物未发生变化，可直接启动 Python，省略重新构建。

Windows：

```powershell
.\.venv\Scripts\python.exe -m tensorv.server
```

macOS / Linux：

```sh
.venv/bin/python -m tensorv.server
```

Python 服务同时提供 `dist/` 中的静态页面和执行 API。日常运行不需要 Vite 或 Node.js 常驻，但服务进程必须保持运行。关闭终端、结束进程或关闭计算机会中断后续执行请求。

## 更新

先下载需要保留的浏览器脚本，再停止服务。提交或备份本地源码修改后，拉取更新并重新安装依赖、构建前端：

```sh
git pull --ff-only
npm ci
npm run build
```

Windows 更新 Python 依赖：

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

macOS / Linux 更新 Python 依赖：

```sh
.venv/bin/python -m pip install -r requirements.txt
```

随后重新启动 Python 服务。浏览器脚本按站点来源保存：域名、协议或端口发生变化时，新地址无法直接读取原地址的本地脚本。先从旧地址下载 `.py`，再在新地址导入。

## 常见问题

| 现象 | 检查与处理 |
| --- | --- |
| 页面无法访问 | 确认终端中的服务仍在运行，并使用正确端口；检查启动日志中的错误 |
| 返回前端未构建提示或 404 | 在项目根目录执行 `npm ci` 和 `npm run build`，确认存在 `dist/index.html` |
| 端口已被占用 | 停止已存在的 TensorV 实例，或通过 `--port` 指定其他端口 |
| PyTorch 安装失败 | 核对 Python 版本、系统架构和包索引可达性；改用有对应发行包的 Python 环境 |
| 首次执行较慢 | 等待 PyTorch 初始化；后续本地执行会复用工作进程 |
| 执行超时 | 缩小张量或计算量，避免长循环；本地默认执行超时为 8 秒 |
| 显示“快照已过期” | 重新运行当前脚本；快照只保留最近一次执行状态，重启后不会恢复 |
| 脚本未保存 | 查看界面的本地存储状态；检查浏览器是否禁用了站点存储，并下载代码副本 |

本地模式不是安全沙箱。即使代码在独立进程中执行，仍可访问当前系统用户允许的文件和网络；不要执行来源不明的代码，不要将该模式暴露到公网。

## 停用和数据保留

按 `Ctrl+C` 停止服务即可停用。项目虚拟环境和前端依赖都位于项目目录内。删除项目目录前，应先保存自行修改的源码；浏览器中的脚本另存于站点数据，不随项目目录自动删除。清除浏览器站点数据前，先下载需保留的脚本。

返回 [README](../README.md) · [用户指南](user-guide.md)
