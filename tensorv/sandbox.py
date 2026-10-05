"""Public execution boundary: disposable gVisor containers and JSON-only snapshots.

This module deliberately does not import torch or the local execution engine.
All container output is untrusted, including output from the bundled worker.
"""

import json
import math
import os
import platform
import selectors
import subprocess
import threading
import time
import uuid

DEFAULT_IMAGE = "tensorv-sandbox:latest"
MAX_OUTPUT = 16 * 1024 * 1024
MAX_VALUES = 100_000
MAX_RECORDS = 1024
MAX_RANK = 64
MAX_CACHE_BYTES = 4 * 1024 * 1024
PAGE_SIZE = 24


def _docker(*args, timeout=10):
    try:
        result = subprocess.run(["docker", *args], capture_output=True, timeout=timeout,
                                check=False)
    except (subprocess.TimeoutExpired, OSError) as exc:
        raise OSError("隔离运行时暂不可用。") from exc
    if result.returncode:
        raise OSError("隔离运行时操作失败。")
    return result.stdout


def container_command(name, image=DEFAULT_IMAGE, runtime="runsc"):
    """Return a fixed isolation policy; clients cannot change Docker arguments."""
    if runtime != "runsc":
        raise ValueError("公开执行必须使用 gVisor runsc。")
    if not isinstance(image, str) or not image or image.startswith("-"):
        raise ValueError("无效的隔离镜像名称。")
    return [
        "create", "--name", name, "--label", "app=tensorv-sandbox", "-i",
        "--runtime", runtime, "--network", "none", "--read-only",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--user", "65532:65532", "--memory", "512m", "--memory-swap", "512m",
        "--cpus", "1", "--pids-limit", "64", "--ulimit", "nofile=128:128",
        "--ulimit", "core=0:0", "--tmpfs",
        "/tmp:rw,noexec,nosuid,nodev,size=64m,uid=65532,gid=65532,mode=700",
        "--shm-size", "8m", "--log-driver", "none", image,
    ]


def _exchange(command, request, timeout, output_limit=MAX_OUTPUT):
    """Bound wall time and combined stdout/stderr, including direct os.write."""
    deadline = time.monotonic() + timeout
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, bufsize=0)
    selector = selectors.DefaultSelector()
    output = bytearray()
    total = 0
    written = 0
    try:
        for pipe, event, kind in ((process.stdin, selectors.EVENT_WRITE, "input"),
                                  (process.stdout, selectors.EVENT_READ, "output"),
                                  (process.stderr, selectors.EVENT_READ, "error")):
            os.set_blocking(pipe.fileno(), False)
            selector.register(pipe, event, kind)
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("执行超时，隔离环境已销毁。请缩短代码或减小张量。")
            for key, _ in selector.select(min(remaining, 0.2)):
                pipe = key.fileobj
                if key.data == "input":
                    try:
                        written += os.write(pipe.fileno(), request[written:written + 65536])
                    except BrokenPipeError:
                        written = len(request)
                    except BlockingIOError:
                        continue
                    if written >= len(request):
                        selector.unregister(pipe)
                        pipe.close()
                    continue
                try:
                    chunk = os.read(pipe.fileno(), 65536)
                except BlockingIOError:
                    continue
                if not chunk:
                    selector.unregister(pipe)
                    pipe.close()
                    continue
                total += len(chunk)
                if total > output_limit:
                    raise ValueError("执行输出超过限制，隔离环境已销毁。")
                if key.data == "output":
                    output.extend(chunk)
        try:
            returncode = process.wait(timeout=max(0.01, deadline - time.monotonic()))
        except subprocess.TimeoutExpired as exc:
            raise TimeoutError("执行超时，隔离环境已销毁。") from exc
        if returncode:
            raise ValueError("隔离执行已终止，可能超过内存或进程限制。")
        return bytes(output)
    finally:
        selector.close()
        if process.poll() is None:
            process.kill()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass
        for pipe in (process.stdin, process.stdout, process.stderr):
            if not pipe.closed:
                pipe.close()


def _run_container(payload, image, runtime, timeout):
    name = "tensorv-" + uuid.uuid4().hex
    created = False
    try:
        _docker(*container_command(name, image, runtime))
        created = True
        return _exchange(["docker", "start", "--attach", "--interactive", name],
                         json.dumps(payload, ensure_ascii=False).encode(), timeout)
    finally:
        # Removing the container also kills descendants that outlive Python or
        # keep a stdout descriptor open. Never reuse a user's process or disk.
        if created:
            _docker("rm", "--force", name)
        else:
            # Also attempt removal if Docker created it but the CLI timed out.
            try:
                _docker("rm", "--force", name)
            except OSError:
                pass


def _reject_constant(_):
    raise ValueError("隔离结果包含无效数值。")


def _parse_json(raw):
    if len(raw) > MAX_OUTPUT:
        raise ValueError("隔离输出超过限制。")
    # Validate structural complexity before allocating Python lists/dicts.
    # A byte cap alone permits millions of tiny objects or deep nesting.
    depth = separators = 0
    quoted = escaped = False
    for byte in raw:
        if quoted:
            if escaped:
                escaped = False
            elif byte == 92:
                escaped = True
            elif byte == 34:
                quoted = False
        elif byte == 34:
            quoted = True
        elif byte in (91, 123):
            depth += 1
            separators += 1
        elif byte in (93, 125):
            depth -= 1
        elif byte in (44, 58):
            separators += 1
        if depth > 16 or separators > 300_000:
            raise ValueError("隔离结果结构超过限制。")
    try:
        return json.loads(raw, parse_constant=_reject_constant)
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise ValueError("隔离执行未返回有效结果。请避免直接写入进程输出。") from exc


def check_sandbox(image=DEFAULT_IMAGE, runtime="runsc", timeout=45):
    """Fail closed before accepting requests; no fallback to ordinary Docker."""
    if platform.system() != "Linux":
        raise OSError("公开执行仅支持配置了 gVisor 的 Linux 主机。")
    container_command("tensorv-check", image, runtime)
    info = _parse_json(_docker("info", "--format", "{{json .}}"))
    if info.get("OSType") != "linux" or runtime not in info.get("Runtimes", {}):
        raise OSError("gVisor runsc 未配置，拒绝启动公开执行。")
    runtime_path = info["Runtimes"][runtime].get("path", "")
    if os.path.basename(runtime_path) != "runsc":
        raise OSError("runsc 运行时配置不正确。")
    _docker("image", "inspect", image)
    probe = _parse_json(_run_container({"action": "probe"}, image, runtime, timeout))
    if (not isinstance(probe, dict) or probe.get("ready") is not True
            or probe.get("uid") != 65532 or not isinstance(probe.get("torch_version"), str)):
        raise OSError("隔离运行时自检失败。")
    return {"ready": True, "torch_version": probe["torch_version"], "runtime": runtime}


def _text(value, limit=4096):
    if not isinstance(value, str) or len(value) > limit:
        raise ValueError("隔离结果中的文本无效。")
    return value


def _int(value, maximum=2 ** 63 - 1):
    if type(value) is not int or not 0 <= value <= maximum:
        raise ValueError("隔离结果中的整数无效。")
    return value


def _numeric(value):
    if value is None or type(value) is bool:
        return value
    if type(value) is int and abs(value) <= 2 ** 63:
        return value if abs(value) <= 2 ** 53 - 1 else str(value)
    if type(value) is float and math.isfinite(value):
        return value
    if isinstance(value, str) and len(value) <= 128:
        return value
    raise ValueError("隔离结果中的数值无效。")


def _metadata(source):
    if not isinstance(source, dict):
        raise ValueError("无效的张量元数据。")
    shape = source.get("shape")
    if not isinstance(shape, list) or len(shape) > MAX_RANK:
        raise ValueError("张量维度超过公开服务限制。")
    shape = [_int(size) for size in shape]
    stride = source.get("stride")
    if not isinstance(stride, list) or len(stride) not in (0, len(shape)):
        raise ValueError("张量 stride 无效。")
    stride = [_int(size) for size in stride]
    numel = _int(source.get("numel"))
    if math.prod(shape) != numel:
        raise ValueError("张量形状与元素数量不一致。")
    result = {"id": _text(source.get("id"), 512), "name": _text(source.get("name"), 256),
              "shape": shape, "stride": stride, "offset": _int(source.get("offset")),
              "numel": numel, "nbytes": _int(source.get("nbytes")),
              "element_size": _int(source.get("element_size"), 32),
              "dtype": _text(source.get("dtype"), 64),
              "device": _text(source.get("device"), 64),
              "available": source.get("available") is True,
              "contiguous": source.get("contiguous") is True,
              "storage": None if source.get("storage") is None else _text(source["storage"], 64)}
    if result["available"] and (len(stride) != len(shape) or numel > MAX_VALUES or len(shape) > 32):
        raise ValueError("张量快照超过公开服务限制。")
    for key in ("warning",):
        if key in source:
            result[key] = _text(source[key])
    for key in ("min", "max"):
        if key in source:
            result[key] = _numeric(source[key])
    stats = source.get("stats")
    if not isinstance(stats, dict):
        raise ValueError("张量统计无效。")
    result["stats"] = {"supported": stats.get("supported") is True,
                       "count": _int(stats.get("count"))}
    for key in ("finite_count", "nonfinite_count"):
        value = stats.get(key)
        result["stats"][key] = None if value is None else _int(value)
    for key in ("min", "max", "mean", "std"):
        result["stats"][key] = _numeric(stats.get(key))
    if "reason" in stats:
        result["stats"]["reason"] = _text(stats["reason"])
    return result


def validate_result(envelope):
    """Reconstruct a bounded schema; discard all unrecognized worker fields."""
    if not isinstance(envelope, dict) or envelope.get("protocol") != 1:
        raise ValueError("隔离结果协议无效。")
    source = envelope.get("result")
    snapshots = envelope.get("snapshots")
    if not isinstance(source, dict) or not isinstance(snapshots, dict) or len(snapshots) > MAX_RECORDS:
        raise ValueError("隔离结果结构无效。")
    steps = source.get("steps")
    if not isinstance(steps, list) or len(steps) > 64:
        raise ValueError("执行步骤超过公开服务限制。")
    result = {"run_id": _text(source.get("run_id"), 64), "steps": [],
              "stdout": _text(source.get("stdout"), 32_000),
              "elapsed_ms": _int(source.get("elapsed_ms"), 3_600_000),
              "torch_version": _text(source.get("torch_version"), 64), "error": None}
    error = source.get("error")
    if error is not None:
        if not isinstance(error, dict):
            raise ValueError("执行错误信息无效。")
        result["error"] = {"type": _text(error.get("type"), 128),
                           "message": _text(error.get("message")),
                           "line": _int(error.get("line"), 20_001)}
        if "hint" in error:
            result["error"]["hint"] = _text(error["hint"])
    records = {}
    total_values = 0
    for step in steps:
        if not isinstance(step, dict) or not isinstance(step.get("tensors"), list) or len(step["tensors"]) > 16:
            raise ValueError("执行步骤结构无效。")
        item = {"line": _int(step.get("line"), 20_001),
                "end_line": _int(step.get("end_line"), 20_001),
                "source": _text(step.get("source"), 20_000), "tensors": []}
        for key in ("inputs", "outputs"):
            names = step.get(key)
            if not isinstance(names, list) or len(names) > 16:
                raise ValueError("执行变量列表无效。")
            item[key] = [_text(name, 256) for name in names]
        for raw_metadata in step["tensors"]:
            metadata = _metadata(raw_metadata)
            snapshot_id = metadata["id"]
            if snapshot_id in records:
                raise ValueError("重复的张量快照。")
            values = snapshots.get(snapshot_id)
            if metadata["available"]:
                if not isinstance(values, list) or len(values) != metadata["numel"]:
                    raise ValueError("张量快照的元素数量无效。")
                total_values += len(values)
                if total_values > MAX_VALUES:
                    raise ValueError("张量快照超过公开服务内存限制。")
                values = [_numeric(value) for value in values]
            else:
                values = None
            records[snapshot_id] = (metadata, values)
            item["tensors"].append(metadata.copy())
        result["steps"].append(item)
    # Python object overhead exceeds raw tensor bytes. Bound the serialized
    # cache as well as scalar count so hostile long scalar strings/metadata
    # cannot multiply the memory budget across anonymous sessions.
    if len(json.dumps(records, ensure_ascii=False, separators=(",", ":")).encode()) > MAX_CACHE_BYTES:
        raise ValueError("张量快照超过公开服务内存限制。")
    return result, records


def slice_snapshot(records, request):
    snapshot_id = request.get("id")
    if not isinstance(snapshot_id, str) or snapshot_id not in records:
        raise ValueError("快照已过期，请重新运行代码。")
    metadata, data = records[snapshot_id]
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
    if any(type(index) is not int or index < 0 or index >= max(1, shape[axis])
           for axis, index in enumerate(fixed)):
        raise ValueError("切片索引越界。")
    row_start, col_start = request.get("row_start", 0), request.get("col_start", 0)
    if type(row_start) is not int or type(col_start) is not int or min(row_start, col_start) < 0:
        raise ValueError("分页位置无效。")
    row_count = min(PAGE_SIZE, max(0, shape[row] - row_start)) if row is not None else 1
    col_count = min(PAGE_SIZE, max(0, shape[col] - col_start)) if col is not None else 1
    values, offsets, coords = [], [], []
    if 0 in shape:
        row_count = 0
    for i in range(row_count):
        value_row, offset_row, coord_row = [], [], []
        for j in range(col_count):
            index = list(fixed)
            if row is not None:
                index[row] = row_start + i
            if col is not None:
                index[col] = col_start + j
            flat_index = 0
            for size, coordinate in zip(shape, index):
                flat_index = flat_index * size + coordinate
            value_row.append(data[flat_index])
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


class SandboxRunner:
    def __init__(self, timeout=20, image=DEFAULT_IMAGE, runtime="runsc"):
        container_command("tensorv-config", image, runtime)
        self.timeout = timeout
        self.image = image
        self.runtime = runtime
        self.lock = threading.Lock()
        self.ready = False
        self.torch_version = None
        self.records = {}

    def stop(self):
        self.records.clear()
        self.ready = False

    def request(self, payload):
        with self.lock:
            if payload.get("action") == "slice":
                return slice_snapshot(self.records, payload)
            if payload.get("action") != "execute":
                raise ValueError("未知请求。")
            code = payload.get("code")
            if not isinstance(code, str) or len(code) > 20_000:
                raise ValueError("代码必须是文本，且不超过 20,000 字符。")
            self.stop()
            raw = _run_container({"action": "execute", "code": code},
                                 self.image, self.runtime, self.timeout)
            result, records = validate_result(_parse_json(raw))
            for step in result["steps"]:
                for metadata in step["tensors"]:
                    if metadata["available"]:
                        metadata["slice"] = slice_snapshot(records, {"id": metadata["id"]})
            self.records = records
            self.torch_version = result["torch_version"]
            self.ready = True
            return result
