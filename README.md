# TensorV

一个在本机运行的 PyTorch Tensor 教学与探索工具：左侧写 Python，右侧查看每条语句执行后的真实形状、数值和内存布局。

## 启动

需要 Python 3.10+（须有对应 PyTorch wheel）和 Node.js 20.19+ 或 22.12+。首次安装依赖需要联网；安装后编辑器与执行服务可离线运行。

```sh
./start.sh
```

打开 http://127.0.0.1:8765 。也可用 `./start.sh --port 9000` 指定端口。

手动安装和启动：

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm ci
npm run build
.venv/bin/python -m tensorv.server
```

开发时用两个终端：

```sh
.venv/bin/python -m tensorv.server
```

```sh
npm run dev
```

Vite 的开发页面通常位于 http://127.0.0.1:5173 ，API 会代理到 8765。

## 如何使用

- 编辑停止 650 ms 后自动执行；可关闭自动运行，使用运行按钮或 `⌘/Ctrl + Enter`。
- 点击轨迹中的步骤，或将编辑器光标移到已执行的语句，回看对应状态。
- 用变量选择器查看不同变量及 `split` 等操作返回的 Tensor 列表。
- 选择行、列维度，使用滑块或数字输入浏览其他维度的索引。每页最多显示 24 × 24 个元素，大维度可以翻页。
- 悬停格子查看完整坐标。共享底层存储的格子联动高亮；`unfold` 的重叠元素会同时高亮。
- 前后形状一致时，用橙色边框标出同坐标上数值改变的元素。
- 查看 shape、stride、连续性、存储编号和偏移量，区分视图与复制。
- 代码没有写完时，保留上一次成功画面；运行中出错时，显示出错前已经完成的步骤。
- 内置 `transpose`、`reshape/view`、`clamp`、`split`、`unfold`、五维切片和原地修改示例。
- 草稿存储于浏览器 localStorage，可下载为 `.py` 文件。

## 执行与边界

后端直接运行真实 PyTorch，前端不会模拟算子。每次从头执行短程序，随机种子重置为 0。默认用 CPU；首次运行需等待 PyTorch 导入，之后复用工作进程。

在顶层完整语句结束后记录状态。支持多行语句、函数和循环执行，但初版不逐次记录函数内部或每个循环迭代。表达式产生的 Tensor 以“结果”展示；列表、元组和字典中的 Tensor 会展开为变量路径。

历史数值使用独立快照，原地操作不会改变之前的画布。存储编号描述本次运行中原始 Tensor 的共享关系，格子中的存储位置是以元素为单位的偏移；联动高亮仅在存储编号和 dtype 都相同时进行。

每个 Tensor 最多保存 100,000 个元素，历史数值内存预算为 64 MB，最多记录 128 步及每步 32 个 Tensor。超过大小或内存限制时保留元数据。执行默认超时 8 秒并重置工作进程。普通稠密 Tensor 支持数值浏览；稀疏和 meta Tensor 只显示元数据。

这是用于本人可信代码的本地工具。独立工作进程用于超时和状态恢复，并非安全沙箱；Python 代码仍具有当前用户的文件与网络权限。服务仅监听 `127.0.0.1`，不应暴露到公网。

## 验证

```sh
npm run build
.venv/bin/python -m unittest discover -s tests -v
```

测试覆盖 transpose 的真实数值与 stride、unfold 重叠、原地修改的历史快照、reshape 复制与 view 报错、split 偏移、高维切片、分页、标量、空 Tensor、特殊数值、随机可重复性，以及超时后的恢复。

## 结构

- `src/`：CodeMirror Python 编辑器、执行轨迹、切片画布和示例。
- `tensorv/engine.py`：AST 语句插桩、真实执行、快照与切片。
- `tensorv/server.py`：Python 标准库 HTTP 服务和独立工作进程。
- `tests/`：执行与快照语义测试。

PyTorch 视图语义参考：[Tensor Views](https://docs.pytorch.org/docs/stable/tensor_view.html)。
