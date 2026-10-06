"""Validate bridge protocol and worker recovery without importing PyTorch."""

import io
import json
import unittest
from unittest.mock import Mock

from tensorv.bridge import MAX_REQUEST_BYTES, serve


class BridgeTests(unittest.TestCase):
    def exchange(self, lines, runner=None):
        runner = runner or Mock()
        stream = io.StringIO()
        serve(io.StringIO(lines), stream, runner)
        return [json.loads(line) for line in stream.getvalue().splitlines()], runner

    def test_code_preserved_and_eof_stops_worker(self):
        runner = Mock()
        runner.request.return_value = {"steps": [], "stdout": "hello\n"}
        code = "import torch\nx = torch.arange(4)\n"
        result, _ = self.exchange(json.dumps({"id": "a", "action": "execute", "payload": {"code": code}}) + "\n", runner)
        runner.request.assert_called_once_with({"action": "execute", "code": code})
        self.assertEqual(result[0], {"id": "a", "ok": True, "data": runner.request.return_value})
        runner.stop.assert_called_once()

    def test_slice_action_cannot_be_overridden(self):
        runner = Mock()
        runner.request.return_value = {"values": [[1]]}
        result, _ = self.exchange('{"id":2,"action":"slice","payload":{"action":"execute","id":"snapshot"}}\n', runner)
        runner.request.assert_called_once_with({"action": "slice", "id": "snapshot"})
        self.assertTrue(result[0]["ok"])

    def test_invalid_requests_do_not_execute_and_stream_recovers(self):
        invalid = ["{", "[]", '{"id":1,"action":"execute","payload":{"code":12}}',
                   '{"id":true,"action":"execute","payload":{"code":"x"}}',
                   '{"id":1,"action":"unknown","payload":{}}']
        result, runner = self.exchange("\n".join(invalid) + "\n")
        self.assertEqual(len(result), len(invalid))
        self.assertTrue(all(not item["ok"] for item in result))
        runner.request.assert_not_called()

    def test_timeout_resets_before_subsequent_request(self):
        runner = Mock()
        runner.request.side_effect = [TimeoutError("timeout"), {"steps": []}]
        request = '{"id":1,"action":"execute","payload":{"code":"pass"}}\n'
        result, _ = self.exchange(request + request, runner)
        self.assertFalse(result[0]["ok"])
        self.assertTrue(result[1]["ok"])
        self.assertEqual(runner.stop.call_count, 2)
        self.assertEqual([call[0] for call in runner.mock_calls], ["request", "stop", "request", "stop"])

    def test_oversized_line_is_not_executed(self):
        result, runner = self.exchange("x" * (MAX_REQUEST_BYTES + 1))
        self.assertFalse(result[0]["ok"])
        runner.request.assert_not_called()


if __name__ == "__main__":
    unittest.main()
