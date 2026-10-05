"""Bounded, same-origin HTTP gateway for the isolated public execution service.

This module never imports PyTorch or evaluates user Python. The local development
server remains separate; public execution requires a verified gVisor runner.
"""

import argparse
from dataclasses import dataclass, field
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import mimetypes
from pathlib import Path
import re
import secrets
import socket
import threading
import time
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parents[1]
MAX_BODY_BYTES = 100_000
MAX_CODE_CHARS = 20_000
TOKEN_PATTERN = re.compile(r"[A-Za-z0-9_-]{43}\Z")
CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
       "img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; "
       "worker-src 'self' blob:; object-src 'none'; base-uri 'none'; "
       "frame-ancestors 'none'; form-action 'none'")


def configured_origins(origins):
    """Map exact public authorities to one explicitly configured origin each."""
    result = {}
    for origin in origins:
        try:
            parts = urlsplit(origin)
            valid = (parts.scheme in ("http", "https") and parts.hostname
                     and parts.username is None and parts.password is None
                     and not parts.path and not parts.query and not parts.fragment
                     and parts.port != 0 and not any(c.isspace() for c in origin)
                     and "\\" not in origin)
        except ValueError:
            valid = False
        if not valid:
            raise ValueError("--origin must be an http(s) origin without a path or credentials.")
        authority = parts.netloc.lower()
        normalized = f"{parts.scheme}://{authority}"
        if authority in result and result[authority] != normalized:
            raise ValueError("Configure only one scheme for each public Host.")
        result[authority] = normalized
    if not result:
        raise ValueError("At least one explicit --origin is required.")
    return result


class TokenBucket:
    def __init__(self, capacity, period, now):
        self.capacity = capacity
        self.rate = capacity / period
        self.tokens = float(capacity)
        self.updated = now

    def consume(self, now):
        self.tokens = min(self.capacity, self.tokens + max(0, now - self.updated) * self.rate)
        self.updated = now
        if self.tokens < 1:
            return False
        self.tokens -= 1
        return True


@dataclass
class Session:
    token: str
    origin: str
    runner: object
    last_seen: float
    executions: TokenBucket
    lock: object = field(default_factory=threading.Lock)
    address: str = ""


class CapacityError(Exception):
    pass


class SessionBusyError(Exception):
    pass


class SessionStore:
    def __init__(self, runner_factory, max_sessions=32, ttl=900, clock=time.monotonic,
                 max_sessions_per_ip=2):
        self.runner_factory = runner_factory
        self.max_sessions = max_sessions
        self.ttl = ttl
        self.clock = clock
        self.max_sessions_per_ip = max_sessions_per_ip
        self.lock = threading.Lock()
        self.sessions = {}

    @staticmethod
    def stop_session(session):
        with session.runner.lock:
            session.runner.stop()

    def get(self, token, origin, create=True, address="", acquire_lock=False):
        with self.lock:
            now = self.clock()
            for key, session in list(self.sessions.items()):
                if now - session.last_seen >= self.ttl and session.lock.acquire(blocking=False):
                    try:
                        del self.sessions[key]
                        self.stop_session(session)
                    finally:
                        session.lock.release()
            session = self.sessions.get(token)
            if session is not None and session.origin == origin:
                if acquire_lock and not session.lock.acquire(blocking=False):
                    raise SessionBusyError("当前会话有请求正在执行。")
                session.last_seen = now
                return session, False
            if not create:
                return None, False
            owned = [value for value in self.sessions.values() if value.address == address]
            if len(owned) >= self.max_sessions_per_ip or len(self.sessions) >= self.max_sessions:
                candidates = owned if len(owned) >= self.max_sessions_per_ip else self.sessions.values()
                evicted = False
                for previous in sorted(candidates, key=lambda value: value.last_seen):
                    if previous.lock.acquire(blocking=False):
                        try:
                            del self.sessions[previous.token]
                            self.stop_session(previous)
                            evicted = True
                        finally:
                            previous.lock.release()
                        break
                if not evicted:
                    raise CapacityError("会话资源繁忙，请稍后重试。")
            token = secrets.token_urlsafe(32)
            session = Session(token, origin, self.runner_factory(), now, TokenBucket(10, 60, now),
                              address=address)
            if acquire_lock:
                session.lock.acquire()
            self.sessions[token] = session
            return session, True

    def discard(self, session):
        with self.lock:
            if self.sessions.get(session.token) is session:
                del self.sessions[session.token]
                self.stop_session(session)

    def close(self):
        with self.lock:
            sessions, self.sessions = list(self.sessions.values()), {}
        for session in sessions:
            with session.lock:
                self.stop_session(session)


class RateLimits:
    """Execution limits persist across new cookies; the IP table is bounded."""
    def __init__(self, clock=time.monotonic, max_ips=1024):
        self.clock = clock
        self.max_ips = max_ips
        self.lock = threading.Lock()
        self.global_bucket = TokenBucket(60, 60, clock())
        self.ips = {}

    def allow(self, session, address):
        with self.lock:
            now = self.clock()
            for key, bucket in list(self.ips.items()):
                if now - bucket.updated >= 120:
                    del self.ips[key]
            if address not in self.ips:
                if len(self.ips) >= self.max_ips:
                    return False
                self.ips[address] = TokenBucket(10, 60, now)
            # Rejected requests from one session/IP cannot drain the shared
            # allowance belonging to other visitors.
            return ((session is None or session.executions.consume(now)) and self.ips[address].consume(now)
                    and self.global_bucket.consume(now))


def validate_payload(path, payload):
    if not isinstance(payload, dict):
        raise ValueError("请求必须是 JSON 对象。")
    if path == "/api/execute":
        if set(payload) != {"code"}:
            raise ValueError("执行请求只接受 code 字段。")
        code = payload["code"]
        if not isinstance(code, str) or len(code) > MAX_CODE_CHARS:
            raise ValueError("代码必须是文本，且不超过 20,000 字符。")
        return {"action": "execute", "code": code}
    allowed = {"id", "row_axis", "col_axis", "indices", "row_start", "col_start"}
    if set(payload) - allowed:
        raise ValueError("切片请求包含不支持的字段。")
    snapshot = payload.get("id")
    if not isinstance(snapshot, str) or not 0 < len(snapshot) <= 256:
        raise ValueError("快照标识无效。")
    axes = []
    for name in ("row_axis", "col_axis"):
        value = payload.get(name)
        if value is not None:
            if type(value) is not int or not 0 <= value < 64:
                raise ValueError("显示维度无效。")
            axes.append(value)
    if len(axes) != len(set(axes)):
        raise ValueError("显示维度不能重复。")
    if "indices" in payload:
        indices = payload["indices"]
        if (not isinstance(indices, list) or len(indices) > 64
                or any(type(index) is not int or not 0 <= index <= 2**53 - 1 for index in indices)):
            raise ValueError("切片索引无效。")
    for name in ("row_start", "col_start"):
        value = payload.get(name, 0)
        if type(value) is not int or not 0 <= value <= 2**53 - 1:
            raise ValueError("分页位置无效。")
    return {"action": "slice", **payload}


def strict_json(body):
    def invalid_constant(_):
        raise ValueError("JSON 不支持非有限数值。")

    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("JSON 字段不能重复。")
            result[key] = value
        return result

    return json.loads(body, parse_constant=invalid_constant, object_pairs_hook=unique_object)


class PublicHandler(BaseHTTPRequestHandler):
    server_version = "TensorV"
    sys_version = ""

    def log_message(self, *_):
        # Never log user source, credentials, cookie values, or snapshot data.
        pass

    def end_headers(self):
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        if (getattr(self, "public_origin", "") or "").startswith("https://"):
            self.send_header("Strict-Transport-Security", "max-age=31536000")
        if getattr(self, "new_session", None):
            cookie = (f"{self.cookie_name()}={self.new_session.token}; Path=/; "
                      f"Max-Age={int(self.server.sessions.ttl)}; HttpOnly; SameSite=Strict")
            if self.public_origin.startswith("https://"):
                cookie += "; Secure"
            self.send_header("Set-Cookie", cookie)
            self.new_session = None
        super().end_headers()

    def json_response(self, status, payload, retry=False):
        body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if retry:
            self.send_header("Retry-After", "6")
        self.end_headers()
        try:
            self.wfile.write(body)
        except OSError:
            pass

    def permitted(self, require_origin=False):
        hosts = self.headers.get_all("Host", [])
        origins = self.headers.get_all("Origin", [])
        if len(hosts) != 1 or len(origins) > 1:
            self.json_response(403, {"message": "请求来源无效。"})
            return False
        self.public_origin = self.server.origins.get(hosts[0].lower())
        if (not self.public_origin or (require_origin and not origins)
                or (origins and origins[0] != self.public_origin)
                or self.headers.get("Sec-Fetch-Site") == "cross-site"):
            self.json_response(403, {"message": "仅接受配置站点的同源请求。"})
            return False
        return True

    def cookie_name(self):
        return "__Host-tensorv_session" if self.public_origin.startswith("https://") else "tensorv_session"

    def session(self, create=False, address="", acquire_lock=False):
        token = None
        cookies = self.headers.get_all("Cookie", [])
        try:
            if len(cookies) == 1 and len(cookies[0]) <= 4096:
                cookie = SimpleCookie()
                cookie.load(cookies[0])
                value = cookie.get(self.cookie_name())
                if value is not None and TOKEN_PATTERN.fullmatch(value.value):
                    token = value.value
        except CookieError:
            pass
        session, created = self.server.sessions.get(token, self.public_origin, create=create, address=address,
                                                    acquire_lock=acquire_lock)
        self.session_created = created
        # Renew browser expiry alongside the server's idle timeout.
        self.new_session = session
        return session

    def client_ip(self):
        peer = ipaddress.ip_address(self.client_address[0])
        if self.server.trust_proxy_loopback and peer.is_loopback:
            values = self.headers.get_all("X-Forwarded-For", [])
            if len(values) != 1:
                raise ValueError("反向代理必须提供单一客户端地址。")
            # Proxies must overwrite this field, never append to client input.
            try:
                forwarded = ipaddress.ip_address(values[0].strip())
            except ValueError as exc:
                raise ValueError("反向代理客户端地址无效。") from exc
            return str(forwarded)
        return str(peer)

    def do_GET(self):
        if not self.permitted():
            return
        try:
            path = unquote(urlsplit(self.path).path, errors="strict")
            if path == "/api/health":
                self.json_response(200, {"status": "ok", "ready": True, "mode": "isolated"})
                return
            if "\x00" in path or "\\" in path:
                raise ValueError("无效路径。")
            dist = self.server.dist
            target = (dist / ("index.html" if path == "/" else path.lstrip("/"))).resolve()
            if not target.is_relative_to(dist) or not target.is_file():
                self.json_response(404, {"message": "文件不存在。"})
                return
            body = target.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", mimetypes.guess_type(target)[0] or "application/octet-stream")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store" if target.name == "index.html" else "no-cache")
            self.end_headers()
            self.wfile.write(body)
        except CapacityError as exc:
            self.json_response(429, {"message": str(exc)}, retry=True)
        except (ValueError, UnicodeError):
            self.json_response(400, {"message": "请求路径无效。"})
        except OSError:
            self.json_response(503, {"message": "服务暂时不可用，请稍后重试。"})

    def do_POST(self):
        if not self.permitted(require_origin=True):
            return
        try:
            path = urlsplit(self.path).path
            if path not in ("/api/execute", "/api/slice"):
                self.json_response(404, {"message": "接口不存在。"})
                return
            if self.headers.get_content_type() != "application/json":
                self.json_response(415, {"message": "请使用 application/json。"})
                return
            lengths = self.headers.get_all("Content-Length", [])
            if self.headers.get_all("Transfer-Encoding") or len(lengths) != 1:
                raise ValueError("请求必须包含唯一的 Content-Length。")
            try:
                length = int(lengths[0])
            except ValueError as exc:
                raise ValueError("请求大小无效。") from exc
            if not 0 < length <= MAX_BODY_BYTES:
                self.json_response(413, {"message": "请求体不能超过 100,000 字节。"})
                return
            try:
                body = self.rfile.read(length)
            except socket.timeout:
                self.json_response(408, {"message": "请求上传超时。"})
                return
            if len(body) != length:
                raise ValueError("请求体不完整。")
            payload = validate_payload(path, strict_json(body))
            address = self.client_ip()
            session = self.session(acquire_lock=True)
            if session is None and path == "/api/slice":
                raise ValueError("快照会话已过期，请重新运行。")
            locked = session is not None
            acquired = False
            succeeded = False
            try:
                if path == "/api/execute":
                    if not self.server.rates.allow(session, address):
                        self.json_response(429, {"message": "运行频率超出限制，请稍后重试。"}, retry=True)
                        return
                    acquired = self.server.execution_slots.acquire(blocking=False)
                    if not acquired:
                        self.json_response(429, {"message": "执行资源繁忙，请稍后重试。"}, retry=True)
                        return
                    if session is None:
                        # Admission precedes allocation: anonymous busy/rate-
                        # limited requests never reserve a persistent session.
                        session = self.session(create=True, address=address, acquire_lock=True)
                        locked = True
                        session.executions.consume(self.server.sessions.clock())
                result = session.runner.request(payload)
                if not isinstance(result, dict):
                    raise OSError("Invalid sandbox response")
                if path == "/api/execute":
                    result = {**result, "execution_mode": "isolated"}
                self.json_response(200, result)
                succeeded = True
            finally:
                if acquired:
                    self.server.execution_slots.release()
                if locked:
                    session.last_seen = self.server.sessions.clock()
                    session.lock.release()
                if not succeeded and getattr(self, "session_created", False) and session is not None:
                    self.new_session = None
                    self.server.sessions.discard(session)
        except SessionBusyError as exc:
            self.json_response(409, {"message": str(exc)})
        except CapacityError as exc:
            self.json_response(429, {"message": str(exc)}, retry=True)
        except TimeoutError:
            self.json_response(504, {"message": "执行超过时间限制，隔离环境已回收。"})
        except (ValueError, TypeError, KeyError, IndexError, UnicodeError, RecursionError):
            self.json_response(400, {"message": "请求内容无效或快照已过期，请检查参数后重新运行。"})
        except (OSError, EOFError):
            self.json_response(503, {"message": "隔离执行服务暂时不可用，请稍后重新运行。"})


class PublicServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 32

    def __init__(self, address, *, origins, runner_factory, dist=ROOT / "dist",
                 max_sessions=32, session_ttl=900, concurrency=2,
                 max_connections=32, trust_proxy_loopback=False, clock=time.monotonic,
                 max_sessions_per_ip=2):
        if min(max_sessions, session_ttl, concurrency, max_connections, max_sessions_per_ip) <= 0:
            raise ValueError("Server limits must be positive.")
        self.origins = configured_origins(origins)
        self.dist = Path(dist).resolve()
        self.sessions = SessionStore(runner_factory, max_sessions, session_ttl, clock, max_sessions_per_ip)
        self.rates = RateLimits(clock)
        self.execution_slots = threading.BoundedSemaphore(concurrency)
        self.connection_slots = threading.BoundedSemaphore(max_connections)
        self.trust_proxy_loopback = trust_proxy_loopback
        super().__init__(address, PublicHandler)

    def get_request(self):
        request, address = super().get_request()
        request.settimeout(5)
        return request, address

    def process_request(self, request, client_address):
        if not self.connection_slots.acquire(blocking=False):
            try:
                request.sendall(b"HTTP/1.0 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            except OSError:
                pass
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.connection_slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.connection_slots.release()

    def server_close(self):
        super().server_close()
        self.sessions.close()


def main():
    parser = argparse.ArgumentParser(description="TensorV isolated public HTTP gateway")
    parser.add_argument("--origin", action="append", required=True,
                        help="Exact public origin, e.g. https://tensorv.example.com; may be repeated")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--trust-proxy-loopback", action="store_true",
                        help="Trust one X-Forwarded-For address set by a loopback reverse proxy")
    parser.add_argument("--max-sessions", type=int, default=32)
    parser.add_argument("--max-sessions-per-ip", type=int, default=2)
    parser.add_argument("--session-ttl", type=int, default=900)
    parser.add_argument("--concurrency", type=int, default=2)
    parser.add_argument("--max-connections", type=int, default=32)
    parser.add_argument("--image", default="tensorv-sandbox:latest")
    parser.add_argument("--runtime", default="runsc")
    parser.add_argument("--timeout", type=float, default=20)
    args = parser.parse_args()
    try:
        if not ipaddress.ip_address(args.host).is_loopback:
            parser.error("The public gateway must bind to loopback behind a reverse proxy.")
        configured_origins(args.origin)
        if args.timeout <= 0:
            raise ValueError("--timeout must be positive.")
    except ValueError as exc:
        parser.error(str(exc))
    from tensorv.sandbox import SandboxRunner, check_sandbox
    check_sandbox(image=args.image, runtime=args.runtime)
    server = PublicServer(
        (args.host, args.port), origins=args.origin,
        runner_factory=lambda: SandboxRunner(timeout=args.timeout, image=args.image, runtime=args.runtime),
        max_sessions=args.max_sessions, session_ttl=args.session_ttl, concurrency=args.concurrency,
        max_connections=args.max_connections, trust_proxy_loopback=args.trust_proxy_loopback,
        max_sessions_per_ip=args.max_sessions_per_ip,
    )
    print(f"TensorV public gateway listening on {args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
