"""Local HTTP server. User Python runs in a separate, restartable process."""

import argparse
import json
import mimetypes
import multiprocessing
from pathlib import Path
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]


def worker_entry(connection):
    # Delayed import keeps the HTTP server responsive during PyTorch startup.
    try:
        from tensorv.engine import worker
    except (ImportError, OSError) as exc:
        connection.send({"ready": False, "message": f"PyTorch 导入失败：{exc}。请安装 requirements.txt 中的依赖后重试。"})
        connection.close()
        return
    worker(connection)


class Runner:
    def __init__(self, timeout=8):
        self.timeout = timeout
        self.lock = threading.Lock()
        self.process = None
        self.connection = None
        self.ready = False
        self.torch_version = None

    def stop(self):
        if self.process is not None:
            if self.process.is_alive():
                self.process.terminate()
            self.process.join(2)
            if self.process.is_alive():
                self.process.kill()
                self.process.join(2)
            self.process.close()
            self.process = None
        if self.connection is not None:
            self.connection.close()
            self.connection = None
        self.ready = False

    def start(self):
        self.stop()
        context = multiprocessing.get_context("spawn")
        self.connection, child = context.Pipe()
        self.process = context.Process(target=worker_entry, args=(child,), daemon=True)
        self.process.start()
        child.close()

    def request(self, payload):
        with self.lock:
            try:
                if self.process is None or not self.process.is_alive():
                    self.start()
                if not self.ready:
                    if not self.connection.poll(30):
                        raise TimeoutError("PyTorch 启动超时。")
                    greeting = self.connection.recv()
                    if not greeting.get("ready"):
                        self.stop()
                        raise ValueError(greeting.get("message", "PyTorch 启动失败。"))
                    self.torch_version = greeting["torch_version"]
                    self.ready = True
                self.connection.send(payload)
                if not self.connection.poll(self.timeout):
                    raise TimeoutError(f"执行超过 {self.timeout} 秒，工作进程已重置。请缩短代码或 Tensor 大小。")
                result = self.connection.recv()
                if not result["ok"]:
                    raise ValueError(result["message"])
                return result["data"]
            except (OSError, EOFError):
                self.stop()
                raise


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def json_response(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/health":
            self.json_response(200, {"status": "ok", "ready": self.server.runner.ready,
                                     "torch_version": self.server.runner.torch_version})
            return
        dist = ROOT / "dist"
        target = (dist / ("index.html" if path == "/" else path.lstrip("/"))).resolve()
        if not target.is_relative_to(dist) or not target.is_file():
            self.send_error(404, "Build the frontend with npm run build first.")
            return
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(target)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        # No cross-origin execution, including requests from unrelated websites.
        origin = self.headers.get("Origin")
        host = self.headers.get("Host", "").split(":")[0]
        if host not in ("localhost", "127.0.0.1"):
            self.json_response(403, {"message": "仅接受本机 Host。"})
            return
        try:
            same_origin = not origin or (urlparse(origin).scheme == "http"
                                        and urlparse(origin).netloc == self.headers.get("Host"))
        except ValueError:
            same_origin = False
        if not same_origin:
            self.json_response(403, {"message": "仅接受同源请求。"})
            return
        if self.headers.get_content_type() != "application/json":
            self.json_response(415, {"message": "请使用 application/json。"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 100_000:
                raise ValueError("请求大小无效。")
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise ValueError("请求必须是 JSON 对象。")
            path = urlparse(self.path).path
            if path == "/api/execute":
                code = payload.get("code")
                if not isinstance(code, str) or len(code) > 20_000:
                    raise ValueError("代码必须是文本，且不超过 20,000 字符。")
                payload = {"action": "execute", "code": code}
            elif path == "/api/slice":
                payload["action"] = "slice"
            else:
                self.json_response(404, {"message": "接口不存在。"})
                return
            self.json_response(200, self.server.runner.request(payload))
        except TimeoutError as exc:
            self.json_response(408, {"message": str(exc)})
        except (ValueError, TypeError, KeyError, IndexError) as exc:
            self.json_response(400, {"message": str(exc)})
        except (EOFError, OSError):
            try:
                self.json_response(503, {"message": "工作进程中断，请重新运行。"})
            except OSError:
                pass


def main():
    parser = argparse.ArgumentParser(description="TensorV local playground")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.runner = Runner()
    print(f"TensorV is running at http://127.0.0.1:{args.port}", flush=True)
    print("Runs trusted local Python code; process isolation is not a security sandbox.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        with server.runner.lock:
            server.runner.stop()


if __name__ == "__main__":
    main()
