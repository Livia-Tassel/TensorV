# TensorV for VS Code

在 VS Code 中运行 Python 文件或选区，检查 PyTorch 张量的形状、数值、步幅、存储别名和逐步变化。文件内容作为副本进入检查器；TensorV 不修改源文件。

## 使用

1. 安装构建生成的 `.vsix`：扩展视图 → `…` → **从 VSIX 安装**。
2. 打开并信任工作区，准备 Python 3.10+ 且安装了 `torch`、`numpy` 的解释器。
3. 打开 Python 文件，点击编辑器标题栏运行按钮，或使用右键菜单 **TensorV: 运行当前 Python 文件 / 运行所选 Python 代码**。
4. 在检查器内选择步骤、Tensor 和切片；使用“返回源码”跳转到原文件行。源文件已修改时，重新运行后再跳转。

选区独立执行，TensorV 保留选中代码的原始文本，不自动补齐外部变量或上下文。运行时复用 TensorV 引擎；`torch` 已在引擎命名空间中可用。这里只检查顶层语句，不是 Python 调试器。

## Python 环境

依次使用 `tensorv.pythonPath`、当前工作区 `.venv`、Microsoft Python 扩展的所选解释器、PATH 中的 `python`。可通过 **TensorV: 选择 Python 解释器** 设置路径。插件不会自动安装依赖；缺依赖时，在目标解释器环境中运行 `python -m pip install torch numpy`。

命令面板还提供 **TensorV: 打开张量检查器** 和 **TensorV: 重启执行环境**。重启会清除后端张量快照，需要重新运行代码。

## 执行范围

代码在扩展宿主所在机器的 Python 进程内运行。使用 SSH / WSL / Dev Containers 时，解释器也位于相应远程环境。进程隔离用于超时恢复，**不是安全沙箱**；只运行你信任的代码。插件本身不启动 HTTP 端口、不向公网发送代码。用户 Python 代码仍拥有所选解释器的文件、网络等权限。

限制：代码最长 20,000 字符；单次执行约 8 秒；TensorV 引擎限制最多 128 步、每个张量 100,000 元素及 64 MB 历史快照。打开检查器不会自动执行代码。在不受信任的工作区中不执行 Python。

## 构建

从仓库根目录运行 `npm run build:vscode`，再运行 `npm run package:vscode` 生成 `.vsix`。首次打包需要 `npm install --prefix extensions/vscode` 安装开发用打包工具。构建只复制前端产物和所需 Python 源码，不附带 Python、虚拟环境、依赖或凭据。不会发布到 Marketplace。
