import json
import math
import unittest

import torch

from tensorv.engine import Engine, json_number
from tensorv.server import Runner


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.engine = Engine()

    def run_code(self, code):
        result = self.engine.execute(code)
        self.assertIsNone(result["error"], result["error"])
        return result

    def tensor(self, result, name, step=-1):
        return next(t for t in result["steps"][step]["tensors"] if t["name"] == name)

    def test_transpose_values_strides_and_storage(self):
        result = self.run_code("x = torch.arange(12).reshape(3, 4)\ny = x.transpose(0, 1)")
        x, y = self.tensor(result, "x"), self.tensor(result, "y")
        self.assertEqual(y["shape"], [4, 3])
        self.assertEqual(y["stride"], [1, 4])
        self.assertFalse(y["contiguous"])
        self.assertEqual(x["storage"], y["storage"])
        self.assertEqual(y["slice"]["values"], [[0, 4, 8], [1, 5, 9], [2, 6, 10], [3, 7, 11]])

    def test_unfold_overlapping_offsets(self):
        result = self.run_code("x = torch.arange(6)\ny = x.unfold(0, 3, 1)")
        y = self.tensor(result, "y")
        self.assertEqual(y["shape"], [4, 3])
        self.assertEqual(y["slice"]["values"], [[0, 1, 2], [1, 2, 3], [2, 3, 4], [3, 4, 5]])
        self.assertEqual(y["slice"]["offsets"][0][1], y["slice"]["offsets"][1][0])

    def test_inplace_preserves_history_and_updates_alias(self):
        result = self.run_code("x = torch.arange(6).reshape(2, 3)\ny = x.transpose(0, 1)\ny.clamp_(max=2)")
        old = self.tensor(result, "x", 0)
        self.assertEqual(self.engine.slice({"id": old["id"]})["values"], [[0, 1, 2], [3, 4, 5]])
        self.assertEqual(self.tensor(result, "x")["slice"]["values"], [[0, 1, 2], [2, 2, 2]])
        self.assertEqual(self.tensor(result, "y")["slice"]["values"], [[0, 2], [1, 2], [2, 2]])

    def test_reshape_copy_and_view_error(self):
        result = self.run_code("x = torch.arange(12).reshape(3, 4)\ny = x.T\nz = y.reshape(2, 6)")
        y, z = self.tensor(result, "y"), self.tensor(result, "z")
        self.assertNotEqual(y["storage"], z["storage"])
        self.assertEqual(z["slice"]["values"], [[0, 4, 8, 1, 5, 9], [2, 6, 10, 3, 7, 11]])
        bad = self.engine.execute("x = torch.arange(12).reshape(3, 4)\ny = x.T\nz = y.view(2, 6)")
        self.assertEqual(bad["error"]["line"], 3)
        self.assertIn("reshape", bad["error"]["hint"])
        self.assertEqual(len(bad["steps"]), 2)

    def test_data_mutation_is_captured_even_without_version_change(self):
        result = self.run_code("x = torch.arange(3)\nx.data.add_(10)")
        self.assertEqual(self.tensor(result, "x", 0)["slice"]["values"], [[0, 1, 2]])
        self.assertEqual(self.tensor(result, "x")["slice"]["values"], [[10, 11, 12]])

    def test_split_nested_tensors_and_offsets(self):
        result = self.run_code("x = torch.arange(12).reshape(2, 6)\nparts = x.split(2, dim=1)")
        part = self.tensor(result, "parts[2]")
        self.assertEqual(part["offset"], 4)
        self.assertEqual(part["slice"]["values"], [[4, 5], [10, 11]])
        self.assertEqual(part["storage"], self.tensor(result, "x")["storage"])

    def test_highdim_arbitrary_axis_order_and_fixed_indices(self):
        result = self.run_code("x = torch.arange(240).reshape(2, 3, 2, 4, 5)")
        x = self.tensor(result, "x")
        sliced = self.engine.slice({"id": x["id"], "row_axis": 4, "col_axis": 1,
                                    "indices": [1, 0, 1, 2, 0]})
        expected = torch.arange(240).reshape(2, 3, 2, 4, 5)[1, :, 1, 2, :].T.tolist()
        self.assertEqual(sliced["values"], expected)
        self.assertEqual(sliced["coords"][3][2], [1, 2, 1, 2, 3])

    def test_scalar_vector_and_empty(self):
        result = self.run_code("a = torch.tensor(7)\nb = torch.arange(4)\nc = torch.empty(2, 0, 3)")
        self.assertEqual(self.tensor(result, "a")["slice"]["values"], [[7]])
        self.assertEqual(self.tensor(result, "b")["slice"]["values"], [[0, 1, 2, 3]])
        self.assertEqual(self.tensor(result, "c")["slice"]["values"], [])

    def test_pagination(self):
        result = self.run_code("x = torch.arange(60)")
        x = self.tensor(result, "x")
        self.assertEqual(len(x["slice"]["values"][0]), 24)
        self.assertEqual(self.engine.slice({"id": x["id"], "col_start": 48})["values"], [list(range(48, 60))])

    def test_nonfinite_complex_and_bool_are_json_safe(self):
        result = self.run_code("x = torch.tensor([float('nan'), float('inf'), -float('inf')])\ny = torch.tensor([1+2j])\nz = torch.tensor([True, False])")
        json.dumps(result, allow_nan=False)
        self.assertEqual(self.tensor(result, "x")["slice"]["values"], [["nan", "inf", "-inf"]])
        self.assertEqual(self.tensor(result, "z")["slice"]["values"], [[True, False]])

    def test_large_integer_transport_preserves_exact_values_and_bool(self):
        safe = 2 ** 53 - 1
        for value in (0, safe, -safe):
            with self.subTest(value=value):
                self.assertEqual(json_number(value), value)
                self.assertIs(type(json_number(value)), int)
        for value in (safe + 1, -(safe + 1), 2 ** 63 - 1, -(2 ** 63)):
            with self.subTest(value=value):
                self.assertEqual(json_number(value), str(value))
        self.assertIs(json_number(True), True)
        self.assertIs(json_number(False), False)

    def test_large_int64_snapshots_survive_browser_json_roundtrip(self):
        code = "x = torch.tensor([9007199254740991, 9007199254740993, -9007199254740993, 9223372036854775807, -9223372036854775808], dtype=torch.int64)\nb = torch.tensor([True, False])"
        result = self.run_code(code)
        # Browser JSON.parse uses float64 for JSON numbers. Simulate that here
        # to ensure every original integer can be recovered exactly on export.
        browser_result = json.loads(json.dumps(result, allow_nan=False), parse_int=float)
        values = self.tensor(browser_result, "x")["slice"]["values"][0]
        expected = [9007199254740991, 9007199254740993, -9007199254740993,
                    9223372036854775807, -9223372036854775808]
        self.assertEqual([int(value) for value in values], expected)
        self.assertIsInstance(values[0], float)
        self.assertTrue(all(isinstance(value, str) for value in values[1:]))
        self.assertEqual(self.tensor(browser_result, "b")["slice"]["values"], [[True, False]])
        x = self.tensor(result, "x")
        requested = self.engine.slice({"id": x["id"], "col_start": 1})
        browser_slice = json.loads(json.dumps(requested, allow_nan=False), parse_int=float)
        self.assertEqual([int(value) for value in browser_slice["values"][0]], expected[1:])
        exported = json.loads(json.dumps(browser_slice, allow_nan=False), parse_int=float)
        self.assertEqual(exported["values"], browser_slice["values"])

    def test_multiline_loop_function_stdout_and_future_import(self):
        code = "from __future__ import annotations\nimport torch\nx = torch.tensor(\n [1, 2, 3]\n)\ndef f(a):\n return a * 2\nfor i in range(2):\n x = f(x)\nprint('done')"
        result = self.run_code(code)
        self.assertEqual(result["steps"][0]["line"], 3)
        self.assertEqual(result["steps"][0]["end_line"], 5)
        self.assertEqual(self.tensor(result, "x")["slice"]["values"], [[4, 8, 12]])
        self.assertEqual(result["stdout"], "done\n")
        self.run_code('"module docstring"\nfrom __future__ import annotations\nx = torch.arange(3)')

    def test_random_is_repeatable_and_snapshot_ids_expire(self):
        first = self.run_code("x = torch.rand(4)")
        second = self.run_code("x = torch.rand(4)")
        self.assertEqual(self.tensor(first, "x")["slice"]["values"], self.tensor(second, "x")["slice"]["values"])
        with self.assertRaises(ValueError):
            self.engine.slice({"id": self.tensor(first, "x")["id"]})

    def test_syntax_error_and_runtime_error_line(self):
        broken = self.engine.execute("x = torch.arange(")
        self.assertEqual(broken["error"]["type"], "SyntaxError")
        self.assertEqual(broken["error"]["line"], 1)
        broken = self.engine.execute("x = torch.arange(6)\ny = x.reshape(4, 4)")
        self.assertEqual(broken["error"]["line"], 2)
        self.assertEqual(self.tensor(broken, "x")["slice"]["values"], [list(range(6))])

    def test_invalid_slice_requests(self):
        result = self.run_code("x = torch.arange(6).reshape(2, 3)")
        snapshot = self.tensor(result, "x")["id"]
        for extra in [{"row_axis": 1, "col_axis": 1}, {"row_axis": 3},
                      {"indices": [0]}, {"col_start": -1}, {"row_axis": "0"}]:
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                self.engine.slice({"id": snapshot, **extra})

    def test_large_tensor_metadata_only(self):
        result = self.run_code("x = torch.zeros(100001)")
        x = self.tensor(result, "x")
        self.assertFalse(x["available"])
        self.assertEqual(x["shape"], [100001])
        self.assertIn("100,000", x["warning"])
        self.assertFalse(x["stats"]["supported"])
        self.assertEqual(x["stats"]["count"], 100001)

    def test_stats_cover_full_snapshot_and_logical_bytes(self):
        result = self.run_code("x = torch.arange(60, dtype=torch.int64)\ny = x[:1].expand(100)")
        x, y = self.tensor(result, "x"), self.tensor(result, "y")
        stats = x["stats"]
        self.assertEqual(len(x["slice"]["values"][0]), 24)
        self.assertEqual(stats["count"], 60)
        self.assertEqual(stats["finite_count"], 60)
        self.assertEqual(stats["nonfinite_count"], 0)
        self.assertEqual((stats["min"], stats["max"], stats["mean"]), (0, 59, 29.5))
        self.assertAlmostEqual(stats["std"], math.sqrt((60 ** 2 - 1) / 12))
        self.assertEqual(x["element_size"], 8)
        self.assertEqual(x["nbytes"], 480)
        self.assertEqual(y["storage"], x["storage"])
        self.assertEqual(y["nbytes"], 800)
        self.assertEqual(y["stats"]["std"], 0)

    def test_stats_exclude_nonfinite_and_support_bool(self):
        result = self.run_code("x = torch.tensor([float('nan'), float('inf'), -float('inf'), 1., 3.])\ny = torch.tensor([True, False, True, False])")
        stats = self.tensor(result, "x")["stats"]
        self.assertTrue(stats["supported"])
        self.assertEqual((stats["count"], stats["finite_count"], stats["nonfinite_count"]), (5, 2, 3))
        self.assertEqual((stats["min"], stats["max"], stats["mean"], stats["std"]), (1, 3, 2, 1))
        stats = self.tensor(result, "y")["stats"]
        self.assertEqual((stats["min"], stats["max"], stats["mean"], stats["std"]), (0, 1, .5, .5))
        json.dumps(result, allow_nan=False)

    def test_stats_empty_singleton_and_no_finite_values(self):
        result = self.run_code("empty = torch.empty(2, 0, 3)\nsingle = torch.tensor(42.)\ninvalid = torch.tensor([float('nan'), float('inf')])")
        for name, count in (("empty", 0), ("invalid", 2)):
            stats = self.tensor(result, name)["stats"]
            self.assertTrue(stats["supported"])
            self.assertEqual(stats["finite_count"], 0)
            self.assertEqual(stats["nonfinite_count"], count)
            for aggregate in ("min", "max", "mean", "std"):
                self.assertIsNone(stats[aggregate])
        stats = self.tensor(result, "single")["stats"]
        self.assertEqual(stats["count"], 1)
        self.assertEqual(stats["mean"], 42)
        self.assertEqual(stats["std"], 0)
        json.dumps(result, allow_nan=False)

    def test_stats_remain_finite_at_float64_extremes(self):
        result = self.run_code("x = torch.tensor([-1.7e308, 1.7e308], dtype=torch.float64)\ny = torch.tensor([1.7e308, 1.7e308], dtype=torch.float64)")
        stats = self.tensor(result, "x")["stats"]
        self.assertEqual(stats["mean"], 0)
        self.assertEqual(stats["std"], 1.7e308)
        stats = self.tensor(result, "y")["stats"]
        self.assertEqual(stats["mean"], 1.7e308)
        self.assertEqual(stats["std"], 0)
        json.dumps(result, allow_nan=False)

    def test_stats_preserve_history_and_explain_unsupported_types(self):
        result = self.run_code("x = torch.arange(3.)\nx.add_(10)\nz = torch.tensor([1+2j])\nm = torch.empty(2, device='meta')")
        self.assertEqual(self.tensor(result, "x", 0)["stats"]["mean"], 1)
        self.assertEqual(self.tensor(result, "x")["stats"]["mean"], 11)
        for name in ("z", "m"):
            stats = self.tensor(result, name)["stats"]
            self.assertFalse(stats["supported"])
            self.assertTrue(stats["reason"])
            self.assertIsNone(stats["mean"])

    def test_quantized_tensor_stats_use_dequantized_values(self):
        result = self.run_code("x = torch.quantize_per_tensor(torch.tensor([1., 2., 3.]), .5, 0, torch.qint8)")
        x = self.tensor(result, "x")
        self.assertEqual(x["slice"]["values"], [[1, 2, 3]])
        self.assertEqual(x["stats"]["mean"], 2)
        self.assertAlmostEqual(x["stats"]["std"], math.sqrt(2 / 3))
        self.assertEqual(x["nbytes"], 3)


class RunnerTests(unittest.TestCase):
    def test_crashed_worker_resets_and_next_execution_recovers(self):
        runner = Runner(timeout=2)
        try:
            runner.request({"action": "execute", "code": "x = torch.arange(4)"})
            with self.assertRaises((EOFError, OSError)):
                runner.request({"action": "execute", "code": "import os\nos._exit(1)"})
            self.assertFalse(runner.ready)
            result = runner.request({"action": "execute", "code": "x = torch.tensor(9)"})
            self.assertIsNone(result["error"])
            self.assertEqual(result["steps"][0]["tensors"][0]["slice"]["values"], [[9]])
        finally:
            runner.stop()

    def test_timeout_resets_worker_and_next_execution_recovers(self):
        runner = Runner(timeout=0.2)
        try:
            runner.request({"action": "execute", "code": "x = torch.arange(4)"})
            with self.assertRaises(TimeoutError):
                runner.request({"action": "execute", "code": "while True: pass"})
            self.assertFalse(runner.ready)
            result = runner.request({"action": "execute", "code": "x = torch.tensor(9)"})
            self.assertIsNone(result["error"])
            self.assertEqual(result["steps"][0]["tensors"][0]["slice"]["values"], [[9]])
        finally:
            runner.stop()


if __name__ == "__main__":
    unittest.main()
