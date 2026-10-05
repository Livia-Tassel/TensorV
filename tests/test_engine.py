import json
import unittest

import torch

from tensorv.engine import Engine
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


class RunnerTests(unittest.TestCase):
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
