"""Real execution, conservative attribution and public diagnostic validation."""

import ast
import copy
import unittest
from unittest.mock import patch

import torch

from tensorv.diagnostics import diagnose_shape
from tensorv import engine as engine_module
from tensorv.engine import Engine
from tensorv.sandbox import validate_result


class ShapeDiagnosticTests(unittest.TestCase):
    def diagnostic(self, code, kind):
        result = Engine().execute(code)
        self.assertIsNotNone(result["error"])
        self.assertEqual(result["error"]["type"], "RuntimeError")
        diagnostic = result["error"].get("diagnostic")
        self.assertIsNotNone(diagnostic, result["error"])
        self.assertEqual(diagnostic["kind"], kind)
        self.assertTrue(diagnostic["suggestions"])
        return result, diagnostic

    def test_broadcast_aligns_trailing_axes_and_keeps_original_error(self):
        for operation in ("x + y", "torch.add(x, y)", "x.add(y)"):
            with self.subTest(operation=operation):
                result, diagnostic = self.diagnostic(
                    f"x = torch.ones(2, 1, 3)\ny = torch.ones(4, 5)\nz = {operation}", "broadcast")
                self.assertEqual(diagnostic["inputs"], [{"name": "x", "shape": [2, 1, 3]},
                                                        {"name": "y", "shape": [4, 5]}])
                self.assertEqual(diagnostic["axes"], [{"input": 0, "axis": 2}, {"input": 1, "axis": 1}])
                self.assertIn("must match the size", result["error"]["message"])
                self.assertEqual(result["error"]["line"], 3)
                self.assertEqual(len(result["steps"]), 2)

    def test_broadcast_identifies_all_conflicts_including_empty_dimensions(self):
        _, diagnostic = self.diagnostic("x = torch.empty(0, 3)\ny = torch.ones(2, 4)\nz = x * y", "broadcast")
        self.assertEqual({(item["input"], item["axis"]) for item in diagnostic["axes"]},
                         {(0, 0), (0, 1), (1, 0), (1, 1)})

    def test_matmul_and_batched_matmul_report_contraction_axes(self):
        cases = [
            ("x = torch.ones(2, 3)\ny = torch.ones(4, 5)\nz = x @ y", 1, 0),
            ("x = torch.ones(2, 3, 4)\ny = torch.ones(2, 5, 6)\nz = torch.matmul(x, y)", 2, 1),
            ("x = torch.ones(2, 3, 4)\ny = torch.ones(2, 5, 6)\nz = x.bmm(y)", 2, 1),
            ("x = torch.ones(3)\ny = torch.ones(4)\nz = x @ y", 0, 0),
        ]
        for code, left_axis, right_axis in cases:
            with self.subTest(code=code):
                _, diagnostic = self.diagnostic(code, "matmul")
                self.assertEqual(diagnostic["axes"], [{"input": 0, "axis": left_axis},
                                                       {"input": 1, "axis": right_axis}])

    def test_reshape_counts_elements_and_accepts_plain_shape_variables(self):
        for operation, target in (("x.reshape(5, 3)", [5, 3]), ("x.view(5, 3)", [5, 3]),
                                  ("torch.reshape(x, target)", [2, 7]), ("x.reshape(-1, 5)", [-1, 5]),
                                  ("torch.reshape(x, shape=target)", [2, 7])):
            with self.subTest(operation=operation):
                _, diagnostic = self.diagnostic(
                    f"x = torch.arange(12)\ntarget = (2, 7)\ny = {operation}",
                    "view" if ".view(" in operation else "reshape")
                self.assertEqual(diagnostic["target_shape"], target)
                self.assertIn("12", diagnostic["message"])

    def test_invalid_inference_and_empty_shapes_explain_the_actual_problem(self):
        for operation in ("x.reshape(-1, -1)", "x.reshape(-2, 3)"):
            with self.subTest(operation=operation):
                _, diagnostic = self.diagnostic(f"x = torch.arange(6)\ny = {operation}", "reshape")
                self.assertIn("最多有一个 -1", diagnostic["message"])
        _, diagnostic = self.diagnostic("x = torch.empty(0)\ny = x.reshape(0, -1)", "reshape")
        self.assertIn("无法唯一确定", diagnostic["message"])

    def test_view_stride_hint_is_preserved_and_names_copy_tradeoff(self):
        result, diagnostic = self.diagnostic(
            "x = torch.arange(12).reshape(3, 4)\ny = x.transpose(0, 1)\nz = y.view(2, 6)", "view")
        self.assertIn("stride", result["error"]["hint"])
        self.assertIn("[1, 4]", diagnostic["message"])
        self.assertTrue(any("复制" in item for item in diagnostic["suggestions"]))

    def test_complex_expressions_are_not_reexecuted_or_guessed(self):
        code = ("x = torch.ones(2, 3)\ny = torch.ones(4)\n"
                "def operand():\n    print('called-once')\n    return x\nz = operand() + y")
        result = Engine().execute(code)
        self.assertIsNotNone(result["error"])
        self.assertNotIn("diagnostic", result["error"])
        self.assertEqual(result["stdout"], "called-once\n")

    def test_unattributable_and_unrelated_errors_keep_only_original_error(self):
        cases = [
            "x = torch.ones(2, 3)\ny = torch.ones(4)\nz = x + y; z = x + y",
            "x = torch.ones(2, 3)\ny = torch.ones(4)\nz = x[:, :] + y",
            "x = torch.ones(2, 3)\ny = torch.ones(4)\ndef f():\n    return x + y\nz = f()",
            "x = torch.ones(3)\ny = torch.ones(2, 3)\nx += y",
            "x = torch.ones(3, 2, 3)\ny = torch.ones(4, 5, 2)\nz = torch.bmm(x, y)",
            "x = torch.ones(2, 3)\ny = torch.ones(3, 2, dtype=torch.int64)\nz = x @ y",
        ]
        for code in cases:
            with self.subTest(code=code):
                result = Engine().execute(code)
                self.assertIsNotNone(result["error"])
                self.assertNotIn("diagnostic", result["error"])

    def test_diagnostics_do_not_invoke_tensor_subclass_properties(self):
        class Trap(torch.Tensor):
            @property
            def shape(self):
                raise AssertionError("A custom property must not run")

        x = torch.Tensor._make_subclass(Trap, torch.ones(2, 3))
        statement = ast.parse("z = x + y").body[0]
        error = RuntimeError("The size of tensor a (3) must match the size of tensor b (4) at non-singleton dimension 1")
        self.assertIsNone(diagnose_shape(statement, {"x": x, "y": torch.ones(4)}, error, 1))

    def test_view_diagnostic_uses_native_metadata_without_calling_instance_methods(self):
        x = torch.arange(12).reshape(3, 4).T
        x.stride = lambda: self.fail("Must not call a user-provided stride function")
        statement = ast.parse("z = x.view(2, 6)").body[0]
        error = RuntimeError("view size is not compatible with input tensor's size and stride")
        self.assertIn("[1, 4]", diagnose_shape(statement, {"x": x}, error, 1)["message"])

    def test_monkeypatched_torch_function_and_non_string_error_are_not_inspected(self):
        statement = ast.parse("z = torch.matmul(x, y)").body[0]
        namespace = {"torch": torch, "x": torch.ones(2, 3), "y": torch.ones(4, 5)}
        error = RuntimeError("mat1 and mat2 shapes cannot be multiplied")
        with patch.object(torch, "matmul", lambda *_: None):
            self.assertIsNone(diagnose_shape(statement, namespace, error, 1))

        class ErrorArgument:
            def __str__(self):
                raise AssertionError("Diagnostic must not format user objects")

        self.assertIsNone(diagnose_shape(statement, namespace, RuntimeError(ErrorArgument()), 1))

    def test_multiline_expression_uses_the_actual_source_statement(self):
        _, diagnostic = self.diagnostic("x = torch.ones(2, 3)\ny = torch.ones(4)\nz = (\n    x + y\n)", "broadcast")
        self.assertEqual(diagnostic["inputs"][0]["name"], "x")

    def test_out_keywords_and_computed_shapes_fall_back_without_guessing(self):
        cases = [
            "x = torch.ones(2, 3)\ny = torch.ones(4, 5)\nout = torch.empty(2, 5)\nz = torch.matmul(x, y, out=out)",
            "x = torch.ones(2, 3)\ny = torch.ones(4, 5)\nz = torch.matmul(x, y, shape=(2, 5))",
            "x = torch.arange(12)\ny = torch.ones(3, 5)\nz = x.reshape(y.shape)",
            "x = torch.arange(12)\nshape = (3, 5)\nz = x.reshape(*shape)",
        ]
        for code in cases:
            with self.subTest(code=code):
                result = Engine().execute(code)
                self.assertIsNotNone(result["error"])
                self.assertNotIn("diagnostic", result["error"])


class DiagnosticProtocolTests(unittest.TestCase):
    def envelope(self, diagnostic=None):
        diagnostic = diagnostic or {"kind": "broadcast", "inputs": [{"name": "x", "shape": [2, 3]},
                                                                     {"name": "y", "shape": [4]}],
                                    "axes": [{"input": 0, "axis": 1}, {"input": 1, "axis": 0}],
                                    "message": "维度不匹配", "suggestions": ["核对输入维度。"]}
        return {"protocol": 1, "snapshots": {}, "result": {"run_id": "test", "steps": [], "stdout": "",
                "elapsed_ms": 1, "torch_version": "test", "error": {"type": "RuntimeError", "line": 3,
                "message": "original error", "diagnostic": diagnostic}}}

    def test_diagnostic_survives_json_schema_and_unrecognized_fields_are_removed(self):
        envelope = self.envelope()
        raw = envelope["result"]["error"]["diagnostic"]
        raw["html"] = "<script>not allowed</script>"
        raw["inputs"][0]["extra"] = "discard"
        raw["axes"][0]["extra"] = "discard"
        result, _ = validate_result(envelope)
        diagnostic = result["error"]["diagnostic"]
        self.assertNotIn("html", diagnostic)
        self.assertNotIn("extra", diagnostic["inputs"][0])
        self.assertNotIn("extra", diagnostic["axes"][0])
        self.assertEqual(result["error"]["message"], "original error")

    def test_untrusted_diagnostic_lengths_types_and_axis_bounds_are_rejected(self):
        valid = self.envelope()
        changes = [
            ("kind", "unknown"), ("kind", []), ("inputs", []),
            ("inputs", [{"name": "x", "shape": [1] * 65}, {"name": "y", "shape": [4]}]),
            ("inputs", [{"name": "x", "shape": [True]}, {"name": "y", "shape": [4]}]),
            ("inputs", [{"name": "x", "shape": [2 ** 53]}, {"name": "y", "shape": [4]}]),
            ("inputs", [{"name": "x" * 257, "shape": [3]}, {"name": "y", "shape": [4]}]),
            ("axes", [{"input": 0, "axis": 2}]), ("axes", [{"input": 2, "axis": 0}]),
            ("axes", [{"input": False, "axis": 0}]), ("axes", [{"input": 0, "axis": -1}]),
            ("axes", [{"input": 0, "axis": 0}] * 2), ("axes", [None] * 129),
            ("message", "x" * 2049), ("suggestions", []), ("suggestions", ["x"] * 5),
            ("suggestions", ["x" * 1025]), ("suggestions", [{}]),
        ]
        for field, value in changes:
            candidate = copy.deepcopy(valid)
            candidate["result"]["error"]["diagnostic"][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                validate_result(candidate)

    def test_target_shapes_accept_negative_inference_but_reject_unbounded_data(self):
        diagnostic = {"kind": "reshape", "inputs": [{"name": "x", "shape": [12]}], "axes": [],
                      "message": "无法推断", "suggestions": ["核对维度"], "target_shape": [-1, 5]}
        result, _ = validate_result(self.envelope(diagnostic))
        self.assertEqual(result["error"]["diagnostic"]["target_shape"], [-1, 5])
        for target in (None, [True], [2 ** 53], [1] * 65, {"x": 1}):
            candidate = copy.deepcopy(diagnostic)
            candidate["target_shape"] = target
            with self.subTest(target=target), self.assertRaises(ValueError):
                validate_result(self.envelope(candidate))

    def test_real_public_worker_preserves_the_diagnostic_and_prior_steps(self):
        from tensorv.sandbox_worker import execute
        with patch.multiple(engine_module, MAX_BYTES=engine_module.MAX_BYTES,
                            MAX_STEPS=engine_module.MAX_STEPS, MAX_TENSORS=engine_module.MAX_TENSORS):
            envelope = execute("x = torch.ones(2, 3)\ny = torch.ones(4)\nz = x + y")
        result, records = validate_result(envelope)
        self.assertEqual(result["error"]["diagnostic"]["kind"], "broadcast")
        self.assertEqual(len(result["steps"]), 2)
        self.assertTrue(records)


if __name__ == "__main__":
    unittest.main()
