"""Execute trusted, local snippets and retain immutable, bounded tensor snapshots."""

import ast
import contextlib
import gc
import io
import math
import time
import traceback
import uuid

import torch

MAX_ELEMENTS = 100_000
MAX_BYTES = 64 * 1024 * 1024
MAX_STEPS = 128
MAX_TENSORS = 32
PAGE_SIZE = 24


def json_number(value):
    if isinstance(value, complex):
        return str(value)
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)
    return value


class OutputBuffer(io.StringIO):
    def write(self, value):
        remaining = max(0, 32_000 - self.tell())
        super().write(value[:remaining])
        return len(value)


def tensor_items(namespace):
    result = {}

    def visit(name, value, depth=0):
        if len(result) >= MAX_TENSORS:
            return
        if isinstance(value, torch.Tensor):
            result[name] = value
        elif depth < 3 and isinstance(value, (tuple, list)):
            for index, child in enumerate(value[:MAX_TENSORS]):
                visit(f"{name}[{index}]", child, depth + 1)
        elif depth < 3 and isinstance(value, dict):
            for key, child in list(value.items())[:MAX_TENSORS]:
                visit(f"{name}[{key!r}]", child, depth + 1)

    for name, value in list(namespace.items()):
        if not name.startswith("__"):
            visit(name, value)
    if isinstance(namespace.get("__tv_result__"), torch.Tensor):
        visit("结果", namespace["__tv_result__"])
    return result


class Engine:
    def __init__(self):
        self.records = {}
        self.run_id = None

    def execute(self, code):
        started = time.perf_counter()
        self.records = {}
        gc.collect()
        self.run_id = uuid.uuid4().hex
        steps = []
        output = OutputBuffer()
        error = None
        saved_bytes = 0
        # Retaining storage handles avoids allocator-address reuse in the trace.
        storages = {}
        namespace = {"torch": torch, "__name__": "__tensorv__"}
        current = {"line": 1, "inputs": []}
        source_lines = code.splitlines()
        torch.manual_seed(0)

        def before(line, loaded):
            current["line"] = line
            live = tensor_items(namespace)
            current["inputs"] = [n for n in live if n.split("[")[0] in loaded]
            namespace.pop("__tv_result__", None)

        def capture(line, end_line, assigned):
            nonlocal saved_bytes
            live = tensor_items(namespace)
            if not live:
                return
            if len(steps) >= MAX_STEPS:
                raise RuntimeError("最多记录 128 条语句，请缩短示例。")
            tensors = []
            for name, tensor in live.items():
                snapshot_id = f"{self.run_id}:{len(steps)}:{name}"
                metadata = {
                    "id": snapshot_id, "name": name, "shape": list(tensor.shape),
                    "dtype": str(tensor.dtype).removeprefix("torch."),
                    "device": str(tensor.device), "numel": tensor.numel(),
                    "stride": [], "offset": 0, "contiguous": False,
                    "storage": None, "available": False,
                }
                data = None
                if tensor.layout != torch.strided or tensor.device.type == "meta":
                    metadata["warning"] = "初版仅展示普通稠密 Tensor 的数值。"
                else:
                    metadata.update(stride=list(tensor.stride()), offset=tensor.storage_offset(),
                                    contiguous=tensor.is_contiguous())
                    storage = tensor.untyped_storage()
                    key = storage._cdata
                    if key not in storages:
                        storages[key] = (f"S{len(storages) + 1}", storage)
                    metadata["storage"] = storages[key][0]
                    size = tensor.numel() * tensor.element_size()
                    if tensor.numel() > MAX_ELEMENTS:
                        metadata["warning"] = "超过 100,000 个元素，仅显示形状信息。请先取较小切片。"
                    elif saved_bytes + size > MAX_BYTES:
                        metadata["warning"] = "历史快照达到 64 MB 上限，仅保留形状信息。"
                    else:
                        data = tensor.detach().to("cpu").resolve_conj().resolve_neg().clone()
                        saved_bytes += size
                    if data is not None:
                        metadata["available"] = True
                        if data.numel() and not data.is_complex():
                            values = data.to(torch.float64)
                            finite = values[torch.isfinite(values)]
                            if finite.numel():
                                metadata["min"] = finite.min().item()
                                metadata["max"] = finite.max().item()
                self.records[snapshot_id] = (metadata, data)
                if data is not None:
                    metadata["slice"] = self.slice({"id": snapshot_id})
                tensors.append(metadata)
            focuses = [n for n in live if n.split("[")[0] in assigned]
            if "结果" in live:
                focuses = ["结果"]
            steps.append({
                "line": line, "end_line": end_line,
                "source": "\n".join(source_lines[line - 1:end_line]),
                "inputs": current["inputs"], "outputs": focuses,
                "tensors": tensors,
            })

        namespace.update(__tv_before__=before, __tv_capture__=capture)
        try:
            tree = ast.parse(code, filename="<tensorv>")
            # Validate the uninstrumented program first (including future imports).
            compile(tree, "<tensorv>", "exec")
            instrumented = []
            for index, statement in enumerate(tree.body):
                line, end = statement.lineno, statement.end_lineno
                loaded = sorted({n.id for n in ast.walk(statement)
                                 if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)})
                assigned = sorted({n.id for n in ast.walk(statement)
                                   if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store)})
                is_future = isinstance(statement, ast.ImportFrom) and statement.module == "__future__"
                is_docstring = index == 0 and isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Constant) and isinstance(statement.value.value, str)
                is_header = is_future or is_docstring
                if not is_header:
                    call = ast.Expr(ast.Call(ast.Name("__tv_before__", ast.Load()),
                                             [ast.Constant(line), ast.Constant(tuple(loaded))], []))
                    instrumented.append(ast.copy_location(call, statement))
                if isinstance(statement, ast.Expr) and not isinstance(statement.value, ast.Constant):
                    statement = ast.copy_location(
                        ast.Assign([ast.Name("__tv_result__", ast.Store())], statement.value), statement)
                instrumented.append(statement)
                if not is_header:
                    call = ast.Expr(ast.Call(ast.Name("__tv_capture__", ast.Load()),
                                             [ast.Constant(line), ast.Constant(end),
                                              ast.Constant(tuple(assigned))], []))
                    instrumented.append(ast.copy_location(call, statement))
            tree.body = instrumented
            ast.fix_missing_locations(tree)
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
                exec(compile(tree, "<tensorv>", "exec"), namespace)
        except BaseException as exc:
            line = getattr(exc, "lineno", None) or current["line"]
            for frame in traceback.extract_tb(exc.__traceback__):
                if frame.filename == "<tensorv>":
                    line = frame.lineno
            error = {"type": type(exc).__name__, "message": str(exc), "line": line}
            if "view size is not compatible" in str(exc):
                error["hint"] = "当前 stride 不满足 view 的要求。试试 reshape(...)，或 contiguous().view(...)。"
        return {"run_id": self.run_id, "steps": steps, "error": error,
                "stdout": output.getvalue(), "elapsed_ms": round((time.perf_counter() - started) * 1000),
                "torch_version": torch.__version__}

    def slice(self, request):
        snapshot_id = request.get("id")
        if snapshot_id not in self.records:
            raise ValueError("快照已过期，请重新运行代码。")
        metadata, data = self.records[snapshot_id]
        if data is None:
            raise ValueError(metadata.get("warning", "此 Tensor 的数值不可用。"))
        shape = metadata["shape"]
        rank = len(shape)
        row = request.get("row_axis", rank - 2 if rank >= 2 else None)
        col = request.get("col_axis", rank - 1 if rank else None)
        axes = [axis for axis in (row, col) if axis is not None]
        if any(type(a) is not int or not 0 <= a < rank for a in axes) or len(set(axes)) != len(axes):
            raise ValueError("显示维度无效或重复。")
        fixed = request.get("indices", [0] * rank)
        if not isinstance(fixed, list) or len(fixed) != rank:
            raise ValueError("索引数量必须与维度数量相同。")
        for axis in range(rank):
            if axis not in axes and (type(fixed[axis]) is not int or not 0 <= fixed[axis] < max(1, shape[axis])):
                raise ValueError("切片索引越界。")
        row_start = request.get("row_start", 0)
        col_start = request.get("col_start", 0)
        if type(row_start) is not int or type(col_start) is not int or min(row_start, col_start) < 0:
            raise ValueError("分页位置无效。")
        row_count = min(PAGE_SIZE, max(0, shape[row] - row_start)) if row is not None else 1
        col_count = min(PAGE_SIZE, max(0, shape[col] - col_start)) if col is not None else 1
        values, offsets, coords = [], [], []
        if any(size == 0 for size in shape):
            row_count = 0
        for i in range(row_count):
            value_row, offset_row, coord_row = [], [], []
            for j in range(col_count):
                index = list(fixed)
                if row is not None:
                    index[row] = row_start + i
                if col is not None:
                    index[col] = col_start + j
                value_row.append(json_number(data[tuple(index)].item()))
                offset_row.append(metadata["offset"] + sum(a * b for a, b in zip(index, metadata["stride"])))
                coord_row.append(index)
            values.append(value_row)
            offsets.append(offset_row)
            coords.append(coord_row)
        return {"values": values, "offsets": offsets, "coords": coords,
                "row_axis": row, "col_axis": col, "indices": fixed,
                "row_start": row_start, "col_start": col_start,
                "row_total": shape[row] if row is not None else 1,
                "col_total": shape[col] if col is not None else 1}


def worker(connection):
    torch.set_num_threads(1)
    engine = Engine()
    connection.send({"ready": True, "torch_version": torch.__version__})
    while True:
        try:
            request = connection.recv()
        except EOFError:
            break
        try:
            if request["action"] == "execute":
                result = engine.execute(request["code"])
            elif request["action"] == "slice":
                result = engine.slice(request)
            else:
                raise ValueError("未知请求。")
            connection.send({"ok": True, "data": result})
        except BaseException as exc:
            connection.send({"ok": False, "message": str(exc)})
