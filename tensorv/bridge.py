"""Newline-delimited JSON transport for the trusted local VS Code extension.

No HTTP listener or dependency installation. EOF stops the Runner and its worker.
"""

import argparse
import json
import os
import sys

from tensorv.server import Runner

MAX_REQUEST_BYTES = 200_000


def handle_request(request, runner):
    if not isinstance(request, dict):
        raise ValueError("请求必须是 JSON 对象。")
    if type(request.get("id")) not in (str, int):
        raise ValueError("请求 ID 无效。")
    action = request.get("action")
    payload = request.get("payload")
    if action not in ("execute", "slice") or not isinstance(payload, dict):
        raise ValueError("仅支持 execute 和 slice 请求。")
    if action == "execute":
        code = payload.get("code")
        if not isinstance(code, str) or len(code) > 20_000:
            raise ValueError("代码必须是文本，且不超过 20,000 字符。")
        payload = {"code": code}
    try:
        return runner.request({**payload, "action": action})
    except TimeoutError:
        # Ensure cleanup even when an alternative Runner implementation does
        # not stop itself. Timed-out replies must not reach the next request.
        runner.stop()
        raise


def serve(input_stream, output_stream, runner):
    try:
        while True:
            line = input_stream.readline(MAX_REQUEST_BYTES + 1)
            if not line:
                break
            request_id = None
            try:
                if len(line) > MAX_REQUEST_BYTES:
                    raise ValueError("请求超过大小限制。")
                request = json.loads(line)
                if isinstance(request, dict) and type(request.get("id")) in (str, int):
                    request_id = request["id"]
                data = handle_request(request, runner)
                result = {"id": request_id, "ok": True, "data": data}
            except (ValueError, TypeError, KeyError, IndexError, TimeoutError) as exc:
                result = {"id": request_id, "ok": False, "message": str(exc)}
            except (OSError, EOFError) as exc:
                runner.stop()
                print(f"TensorV worker disconnected: {exc}", file=sys.stderr)
                result = {"id": request_id, "ok": False, "message": "执行进程中断，请重新运行。"}
            output_stream.write(json.dumps(result, ensure_ascii=False, allow_nan=False) + "\n")
            output_stream.flush()
            if len(line) > MAX_REQUEST_BYTES:
                # Do not interpret the remainder of a malformed oversized line.
                break
    finally:
        runner.stop()


def main():
    parser = argparse.ArgumentParser(description="TensorV local VS Code bridge")
    parser.add_argument("--timeout", type=float, default=8)
    args = parser.parse_args()
    if not 0 < args.timeout <= 120:
        parser.error("timeout must be between 0 and 120 seconds")
    # Preserve a private stdout descriptor for JSON, then redirect fd 1 itself.
    # This also contains native writes and stdout inherited by spawned workers.
    protocol_fd = os.dup(sys.stdout.fileno())
    os.set_inheritable(protocol_fd, False)
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8")
    with os.fdopen(protocol_fd, "w", encoding="utf-8", newline="\n", buffering=1) as protocol:
        serve(sys.stdin, protocol, Runner(timeout=args.timeout))


if __name__ == "__main__":
    main()
