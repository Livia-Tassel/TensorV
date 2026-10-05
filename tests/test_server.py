"""Exercise HTTP validation and recovery without starting PyTorch."""

import http.client
import json
import threading
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import Mock

from tensorv.server import Handler


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.runner = Mock(ready=False, torch_version=None)
        self.server.runner.request.return_value = {"steps": [], "error": None}
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.host = f"127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)

    def post(self, body=None, headers=None, path="/api/execute"):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        try:
            connection.request("POST", path, body or '{"code": "x = torch.arange(4)"}',
                               {"Content-Type": "application/json", **(headers or {})})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_valid_request_preserves_api_payload(self):
        status, payload = self.post(headers={"Origin": f"http://{self.host}"})
        self.assertEqual(status, 200)
        self.assertEqual(payload, {"steps": [], "error": None})
        self.server.runner.request.assert_called_once_with({"action": "execute", "code": "x = torch.arange(4)"})

    def test_malformed_or_cross_origin_requests_do_not_execute(self):
        for origin in ("http://[", "null", "http://example.com", f"https://{self.host}"):
            with self.subTest(origin=origin):
                status, payload = self.post(headers={"Origin": origin})
                self.assertEqual(status, 403)
                self.assertIn("同源", payload["message"])
        self.server.runner.request.assert_not_called()
        self.assertEqual(self.post()[0], 200)

    def test_invalid_media_type_is_rejected(self):
        status, _ = self.post(headers={"Content-Type": "text/application/json-fake"})
        self.assertEqual(status, 415)
        self.server.runner.request.assert_not_called()
        self.assertEqual(self.post(headers={"Content-Type": "application/json; charset=utf-8"})[0], 200)

    def test_bad_json_or_non_object_returns_actionable_error(self):
        for body in ("{", "[]", '{"code": 12}'):
            with self.subTest(body=body):
                status, payload = self.post(body)
                self.assertEqual(status, 400)
                self.assertTrue(payload["message"])
        self.server.runner.request.assert_not_called()
        self.assertEqual(self.post()[0], 200)

    def test_worker_pipe_failure_returns_json_and_subsequent_request_works(self):
        self.server.runner.request.side_effect = [OSError("pipe disconnected"), {"steps": [], "error": None}]
        status, payload = self.post()
        self.assertEqual(status, 503)
        self.assertIn("重新运行", payload["message"])
        self.assertEqual(self.post()[0], 200)

    def test_timeout_returns_408_and_preserves_explanation(self):
        self.server.runner.request.side_effect = TimeoutError("执行超过限制，工作进程已重置。")
        status, payload = self.post()
        self.assertEqual(status, 408)
        self.assertIn("已重置", payload["message"])


if __name__ == "__main__":
    unittest.main()
