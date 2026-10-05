"""Public gateway isolation and resource limits, independent of Docker/PyTorch."""

import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest

from tensorv.public_server import PublicServer, RateLimits, configured_origins


ORIGIN = "https://tensorv.example.com"
HOST = "tensorv.example.com"


class FakeRunner:
    def __init__(self):
        self.lock = threading.Lock()
        self.ready = True
        self.calls = []
        self.values = {}
        self.failure = None
        self.stopped = False

    def request(self, payload):
        with self.lock:
            self.calls.append(payload)
            if self.failure:
                raise self.failure
            if payload["action"] == "execute":
                self.values = {"snapshot": payload["code"]}
                return {"steps": [{"id": "snapshot"}], "error": None}
            if payload["id"] not in self.values:
                raise ValueError("Snapshot not in this session")
            return {"values": [[self.values[payload["id"]]]]}

    def stop(self):
        self.stopped = True
        self.values.clear()


class PublicHttpTests(unittest.TestCase):
    def setUp(self):
        self.now = 100.0
        self.temp = tempfile.TemporaryDirectory()
        self.dist = Path(self.temp.name) / "dist"
        self.dist.mkdir()
        (self.dist / "index.html").write_text("<html>TensorV</html>", encoding="utf-8")
        (Path(self.temp.name) / "private.txt").write_text("private", encoding="utf-8")
        self.runners = []

        def runner_factory():
            runner = FakeRunner()
            self.runners.append(runner)
            return runner

        self.server = PublicServer(("127.0.0.1", 0), origins=[ORIGIN], runner_factory=runner_factory,
                                   dist=self.dist, max_sessions=4, session_ttl=900,
                                   concurrency=1, clock=lambda: self.now)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)
        self.temp.cleanup()

    def request(self, method="POST", path="/api/execute", payload=None, cookie=None, headers=None, raw=None):
        values = {"Host": HOST, "Origin": ORIGIN}
        if method == "POST":
            values["Content-Type"] = "application/json"
        if cookie:
            values["Cookie"] = cookie
        values.update(headers or {})
        values = {key: value for key, value in values.items() if value is not None}
        body = raw if raw is not None else (json.dumps(payload if payload is not None else {"code": "x"})
                                             if method == "POST" else None)
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        try:
            connection.request(method, path, body, values)
            response = connection.getresponse()
            data = response.read()
            if "application/json" in response.getheader("Content-Type", ""):
                data = json.loads(data)
            return response.status, data, dict(response.getheaders())
        finally:
            connection.close()

    def create_session(self):
        session, _ = self.server.sessions.get(None, ORIGIN, address=f"203.0.113.{len(self.runners) + 1}")
        return f"__Host-tensorv_session={session.token}"

    def test_health_and_cookie_do_not_disclose_infrastructure(self):
        status, payload, headers = self.request("GET", "/api/health")
        self.assertEqual((status, payload), (200, {"status": "ok", "ready": True, "mode": "isolated"}))
        self.assertNotIn("Set-Cookie", headers)
        self.assertEqual(self.runners, [])
        status, payload, headers = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(payload["execution_mode"], "isolated")
        cookie = headers["Set-Cookie"]
        for value in ("__Host-tensorv_session=", "HttpOnly", "SameSite=Strict", "Secure", "Path=/"):
            self.assertIn(value, cookie)
        self.assertEqual(len(cookie.split("=", 1)[1].split(";", 1)[0]), 43)
        self.assertNotIn("Python", headers["Server"])
        self.assertIn("script-src 'self'", headers["Content-Security-Policy"])
        self.assertIn("style-src 'self' 'unsafe-inline'", headers["Content-Security-Policy"])
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(headers["Cache-Control"], "no-store")

    def test_execute_and_slice_are_private_to_each_cookie(self):
        cookie_a = self.create_session()
        cookie_b = self.create_session()
        self.assertNotEqual(cookie_a, cookie_b)
        self.assertEqual(self.request(payload={"code": "secret-a"}, cookie=cookie_a)[0], 200)
        self.assertEqual(self.request(path="/api/slice", payload={"id": "snapshot"}, cookie=cookie_b)[0], 400)
        self.assertEqual(self.request(payload={"code": "secret-b"}, cookie=cookie_b)[0], 200)
        for cookie, value in ((cookie_a, "secret-a"), (cookie_b, "secret-b")):
            status, payload, _ = self.request(path="/api/slice", payload={"id": "snapshot"}, cookie=cookie)
            self.assertEqual((status, payload), (200, {"values": [[value]]}))

    def test_expiration_discards_snapshot_and_rotates_cookie(self):
        cookie = self.create_session()
        self.request(cookie=cookie)
        old_runner = self.runners[0]
        self.now += 901
        status, _, headers = self.request(path="/api/slice", payload={"id": "snapshot"}, cookie=cookie)
        self.assertEqual(status, 400)
        self.assertNotIn("Set-Cookie", headers)
        status, _, headers = self.request(cookie=cookie)
        self.assertEqual(status, 200)
        self.assertNotEqual(headers["Set-Cookie"].split(";", 1)[0], cookie)
        self.assertTrue(old_runner.stopped)

    def test_cookie_activity_renews_browser_and_server_expiration(self):
        cookie = self.create_session()
        self.now += 899
        status, _, headers = self.request(cookie=cookie)
        self.assertEqual(status, 200)
        self.assertEqual(headers["Set-Cookie"].split(";", 1)[0], cookie)
        self.now += 899
        self.assertEqual(self.request(path="/api/slice", payload={"id": "snapshot"}, cookie=cookie)[0], 200)

    def test_foreign_host_and_missing_or_foreign_origin_never_create_sessions(self):
        for headers in ({"Host": "attacker.example"}, {"Origin": "https://attacker.example"},
                        {"Origin": None}, {"Origin": "null"}, {"Origin": "http://["},
                        {"Origin": ORIGIN + "/"}, {"Sec-Fetch-Site": "cross-site"}):
            with self.subTest(headers=headers):
                self.assertEqual(self.request(headers=headers)[0], 403)
        self.assertEqual(self.runners, [])

    def test_cookie_cannot_be_fixed_by_client_or_reused_across_origins(self):
        forged = "__Host-tensorv_session=" + "a" * 43
        status, _, headers = self.request(cookie=forged)
        self.assertEqual(status, 200)
        self.assertNotEqual(headers["Set-Cookie"].split(";", 1)[0], forged)
        cookie = headers["Set-Cookie"].split(";", 1)[0]
        self.server.origins["other.example.com"] = "https://other.example.com"
        status, _, headers = self.request(cookie=cookie,
                                          headers={"Host": "other.example.com", "Origin": "https://other.example.com"})
        self.assertEqual(status, 200)
        self.assertNotEqual(headers["Set-Cookie"].split(";", 1)[0], cookie)

    def test_request_and_code_size_are_bounded(self):
        self.assertEqual(self.request(raw="", headers={"Content-Length": "100001"})[0], 413)
        self.assertEqual(self.request(payload={"code": "x" * 20001})[0], 400)
        self.assertEqual(self.runners, [])

    def test_untrusted_actions_and_slice_metadata_never_reach_runner(self):
        invalid = [{"id": "snapshot", "action": "execute", "code": "evil"},
                   {"id": "snapshot", "row_axis": True}, {"id": "snapshot", "col_axis": 64},
                   {"id": "snapshot", "row_axis": 0, "col_axis": 0},
                   {"id": "snapshot", "indices": [False]}, {"id": "snapshot", "indices": [0] * 65},
                   {"id": "snapshot", "indices": [-1]}, {"id": "snapshot", "row_start": -1},
                   {"id": "snapshot", "col_start": 1.5}, {"id": 12}]
        for payload in invalid:
            with self.subTest(payload=payload):
                self.assertEqual(self.request(path="/api/slice", payload=payload)[0], 400)
        for raw in ('[]', '{"code":"x","code":"y"}', '{"code":NaN}', '{'):
            self.assertEqual(self.request(raw=raw)[0], 400)
        self.assertEqual(self.request(payload={"code": "x", "action": "anything"})[0], 400)
        self.assertEqual(self.request(path="/api/unknown")[0], 404)
        self.assertEqual(self.runners, [])

    def test_execute_limit_survives_cookie_rotation_and_refills(self):
        cookie = self.create_session()
        for _ in range(10):
            self.assertEqual(self.request(cookie=cookie)[0], 200)
        status, _, headers = self.request(cookie=cookie)
        self.assertEqual(status, 429)
        self.assertIn("Retry-After", headers)
        new_cookie = self.create_session()
        self.assertEqual(self.request(cookie=new_cookie)[0], 429)
        self.now += 6
        self.assertEqual(self.request(cookie=cookie)[0], 200)

    def test_slice_does_not_consume_execution_rate_budget(self):
        cookie = self.create_session()
        self.request(cookie=cookie)
        for _ in range(15):
            self.assertEqual(self.request(path="/api/slice", payload={"id": "snapshot"}, cookie=cookie)[0], 200)
        self.assertEqual(self.request(cookie=cookie)[0], 200)

    def test_session_and_global_concurrency_return_immediately(self):
        cookie = self.create_session()
        session = next(iter(self.server.sessions.sessions.values()))
        with session.lock:
            self.assertEqual(self.request(cookie=cookie)[0], 409)
        with self.server.execution_slots:
            self.assertEqual(self.request(cookie=cookie)[0], 429)
        self.assertEqual(self.request(cookie=cookie)[0], 200)

    def test_session_capacity_evicts_idle_lru_and_expires(self):
        for _ in range(4):
            self.create_session()
            self.now += 1
        first_runner = self.runners[0]
        self.assertEqual(self.request()[0], 200)
        self.assertTrue(first_runner.stopped)
        self.assertEqual(len(self.server.sessions.sessions), 4)
        for path in ("/api/health", "/", "/index.html"):
            status, _, headers = self.request("GET", path)
            self.assertEqual(status, 200)
            self.assertNotIn("Set-Cookie", headers)
        self.assertEqual(len(self.runners), 5)
        self.now += 901
        self.assertEqual(self.request()[0], 200)
        self.assertTrue(all(runner.stopped for runner in self.runners[:5]))

    def test_anonymous_busy_and_limited_requests_do_not_allocate_sessions(self):
        with self.server.execution_slots:
            for _ in range(4):
                status, _, headers = self.request()
                self.assertEqual(status, 429)
                self.assertNotIn("Set-Cookie", headers)
        self.assertEqual(self.runners, [])
        self.assertEqual(self.server.sessions.sessions, {})
        self.assertEqual(self.request()[0], 200)
        self.server.rates.ips["127.0.0.1"].tokens = 0
        status, _, headers = self.request()
        self.assertEqual(status, 429)
        self.assertNotIn("Set-Cookie", headers)
        self.assertEqual(len(self.runners), 1)

    def test_one_ip_cannot_reserve_more_than_two_sessions(self):
        cookies = []
        for _ in range(3):
            status, _, headers = self.request()
            self.assertEqual(status, 200)
            cookies.append(headers["Set-Cookie"].split(";", 1)[0])
            self.now += 1
        self.assertEqual(len(self.server.sessions.sessions), 2)
        self.assertTrue(self.runners[0].stopped)
        self.assertEqual(self.request(path="/api/slice", payload={"id": "snapshot"}, cookie=cookies[0])[0], 400)
        self.assertEqual(self.request(path="/api/slice", payload={"id": "snapshot"}, cookie=cookies[-1])[0], 200)

    def test_busy_sessions_cannot_be_evicted(self):
        self.server.sessions.max_sessions = 1
        cookie = self.create_session()
        session = next(iter(self.server.sessions.sessions.values()))
        with session.lock:
            status, _, headers = self.request()
            self.assertEqual(status, 429)
            self.assertNotIn("Set-Cookie", headers)
        self.assertFalse(self.runners[0].stopped)
        self.assertEqual(self.request(cookie=cookie)[0], 200)

    def test_first_execution_infrastructure_failure_discards_unpublished_session(self):
        def broken_runner():
            runner = FakeRunner()
            runner.failure = OSError("Docker unavailable")
            return runner
        self.server.sessions.runner_factory = broken_runner
        status, _, headers = self.request()
        self.assertEqual(status, 503)
        self.assertNotIn("Set-Cookie", headers)
        self.assertEqual(self.server.sessions.sessions, {})

    def test_infrastructure_failures_are_sanitized_and_recover(self):
        cookie = self.create_session()
        for failure, expected in ((TimeoutError("secret runtime config"), 504),
                                  (OSError("secret filesystem path"), 503)):
            self.runners[0].failure = failure
            status, payload, _ = self.request(cookie=cookie)
            self.assertEqual(status, expected)
            self.assertNotIn("secret", payload["message"])
        self.runners[0].failure = None
        self.assertEqual(self.request(cookie=cookie)[0], 200)

    def test_forwarded_ip_is_ignored_unless_proxy_is_explicitly_trusted(self):
        cookie = self.create_session()
        self.request(cookie=cookie, headers={"X-Forwarded-For": "203.0.113.1"})
        self.assertEqual(set(self.server.rates.ips), {"127.0.0.1"})
        self.server.trust_proxy_loopback = True
        self.assertEqual(self.request(cookie=cookie, headers={"X-Forwarded-For": "203.0.113.2"})[0], 200)
        self.assertIn("203.0.113.2", self.server.rates.ips)
        for address in (None, "203.0.113.2, 127.0.0.1", "invalid"):
            self.assertEqual(self.request(cookie=cookie, headers={"X-Forwarded-For": address})[0], 400)

    def test_static_paths_are_decoded_and_confined_to_dist(self):
        self.assertEqual(self.request("GET", "/?version=1")[0], 200)
        for path in ("/../private.txt", "/%2e%2e/private.txt", "/%2e%2e%2fprivate.txt"):
            status, payload, _ = self.request("GET", path)
            self.assertEqual(status, 404)
            self.assertNotIn("private", str(payload))
        self.assertEqual(self.request("GET", "/%00")[0], 400)


class GatewayPolicyTests(unittest.TestCase):
    def test_origins_must_be_explicit_and_unambiguous(self):
        for origins in ([], ["*"], ["https://example.com/"], ["https://user@example.com"],
                        ["https://example.com?q=1"], ["https://example.com#x"],
                        ["http://example.com", "https://example.com"]):
            with self.subTest(origins=origins):
                with self.assertRaises(ValueError):
                    configured_origins(origins)

    def test_ip_rate_table_is_bounded_and_shared_budget_survives_rejected_ip(self):
        now = [100.0]
        rates = RateLimits(clock=lambda: now[0], max_ips=2)
        from tensorv.public_server import Session, TokenBucket
        first = Session("a", ORIGIN, None, now[0], TokenBucket(10, 60, now[0]))
        second = Session("b", ORIGIN, None, now[0], TokenBucket(10, 60, now[0]))
        for _ in range(10):
            self.assertTrue(rates.allow(first, "203.0.113.1"))
        for _ in range(100):
            self.assertFalse(rates.allow(first, "203.0.113.1"))
        self.assertTrue(rates.allow(second, "203.0.113.2"))
        self.assertFalse(rates.allow(second, "203.0.113.3"))
        self.assertEqual(len(rates.ips), 2)
        now[0] += 121
        self.assertTrue(rates.allow(second, "203.0.113.3"))
        self.assertEqual(len(rates.ips), 1)


if __name__ == "__main__":
    unittest.main()
