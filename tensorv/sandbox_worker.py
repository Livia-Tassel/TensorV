"""Disposable container entry point. Never run this on a public host directly."""

import json
import os
import sys

import torch

from tensorv import engine as engine_module

MAX_VALUES = 100_000


def execute(code):
    # These are product limits, not the security boundary. Arbitrary Python can
    # change them; Docker/gVisor and host-side validation enforce hard limits.
    engine_module.MAX_BYTES = 2 * 1024 * 1024
    engine_module.MAX_STEPS = 64
    engine_module.MAX_TENSORS = 16
    engine = engine_module.Engine()
    result = engine.execute(code)
    if result["error"] and result["error"]["message"] == "最多记录 128 条语句，请缩短示例。":
        result["error"]["message"] = "公开服务最多记录 64 条语句，请缩短示例。"
    snapshots = {}
    retained = 0
    for metadata, data in engine.records.values():
        metadata.pop("slice", None)
        if data is None:
            if "64 MB" in metadata.get("warning", ""):
                metadata["warning"] = "公开服务快照达到 2 MB 上限，仅保留形状信息。"
                metadata["stats"]["reason"] = metadata["warning"]
            continue
        count = data.numel()
        if retained + count > MAX_VALUES or data.ndim > 32:
            metadata["available"] = False
            metadata["warning"] = "公开服务最多保留 100,000 个历史元素、32 个维度。"
            continue
        if data.is_quantized:
            data = data.dequantize()
        snapshots[metadata["id"]] = [engine_module.json_number(value)
                                       for value in data.reshape(-1).tolist()]
        retained += count
    return {"protocol": 1, "result": result, "snapshots": snapshots}


def main():
    torch.set_num_threads(1)
    torch.set_num_interop_threads(1)
    request = json.loads(sys.stdin.buffer.read(100_001))
    if request.get("action") == "probe":
        response = {"ready": True, "uid": os.getuid(), "torch_version": torch.__version__}
    elif request.get("action") == "execute" and isinstance(request.get("code"), str):
        response = execute(request["code"])
    else:
        raise ValueError("Unknown sandbox action")
    # Direct process output from user code makes the protocol invalid. The
    # gateway rejects it and enforces the same size cap on stdout and stderr.
    sys.stdout.write(json.dumps(response, ensure_ascii=False, allow_nan=False,
                               separators=(",", ":")))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
