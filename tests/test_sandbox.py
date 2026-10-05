"""Public sandbox protocol and lifecycle tests; no Docker daemon is required."""

import copy
import json
import platform
import subprocess
import sys
import unittest
from unittest.mock import patch

import torch

from tensorv import engine as engine_module
from tensorv.engine import Engine
from tensorv.sandbox import (SandboxRunner, _exchange, _parse_json, _run_container,
                             check_sandbox, container_command, slice_snapshot,
                             validate_result)
from tensorv.sandbox_worker import execute


class SandboxProtocolTests(unittest.TestCase):
    def setUp(self):
        self.limits = (engine_module.MAX_BYTES, engine_module.MAX_STEPS, engine_module.MAX_TENSORS)

    def tearDown(self):
        engine_module.MAX_BYTES, engine_module.MAX_STEPS, engine_module.MAX_TENSORS = self.limits

    def test_trusted_gateway_does_not_import_torch_or_engine(self):
        result = subprocess.run([sys.executable, "-c",
                                 "import sys; import tensorv.sandbox; "
                                 "assert 'torch' not in sys.modules; "
                                 "assert 'tensorv.engine' not in sys.modules"], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_slicing_matches_engine_for_strides_aliases_and_arbitrary_axes(self):
        code = ("x = torch.arange(240).reshape(2, 3, 2, 4, 5)\n"
                "y = x.permute(4, 2, 0, 3, 1)\nz = y[1:]\n"
                "w = torch.arange(6).unfold(0, 3, 1)")
        local = Engine()
        expected = local.execute(code)
        result, records = validate_result(execute(code))
        for step, local_step in zip(result["steps"], expected["steps"]):
            for metadata, original in zip(step["tensors"], local_step["tensors"]):
                self.assertEqual(slice_snapshot(records, {"id": metadata["id"]}),
                                 local.slice({"id": original["id"]}))
                if len(metadata["shape"]) == 5:
                    request = {"row_axis": 4, "col_axis": 1, "indices": [0, 0, 1, 2, 0]}
                    self.assertEqual(slice_snapshot(records, {"id": metadata["id"], **request}),
                                     local.slice({"id": original["id"], **request}))

    def test_scalar_empty_bool_complex_and_exact_integers_survive_json(self):
        code = ("a = torch.tensor(7)\nb = torch.empty(2, 0, 3)\n"
                "c = torch.tensor([True, False])\nd = torch.tensor([1+2j])\n"
                "e = torch.tensor([float('nan'), float('inf')])\n"
                "f = torch.tensor([9007199254740993, -9223372036854775808])")
        result, records = validate_result(_parse_json(json.dumps(execute(code), allow_nan=False).encode()))
        tensors = {t["name"]: slice_snapshot(records, {"id": t["id"]})["values"]
                   for t in result["steps"][-1]["tensors"]}
        self.assertEqual(tensors["a"], [[7]])
        self.assertEqual(tensors["b"], [])
        self.assertEqual(tensors["c"], [[True, False]])
        self.assertEqual(tensors["d"], [["(1+2j)"]])
        self.assertEqual(tensors["e"], [["nan", "inf"]])
        self.assertEqual(tensors["f"], [["9007199254740993", "-9223372036854775808"]])

    def test_pagination_and_input_validation(self):
        result, records = validate_result(execute("x = torch.arange(60)"))
        snapshot_id = result["steps"][0]["tensors"][0]["id"]
        self.assertEqual(slice_snapshot(records, {"id": snapshot_id, "col_start": 48})["values"],
                         [list(range(48, 60))])
        for request in ({"row_axis": 0, "col_axis": 0}, {"indices": [False]},
                        {"indices": [60]}, {"indices": []}, {"col_start": -1},
                        {"col_axis": True}, {"row_start": "0"}):
            with self.subTest(request=request), self.assertRaises(ValueError):
                slice_snapshot(records, {"id": snapshot_id, **request})

    def test_snapshot_budget_is_enforced_across_history(self):
        result, records = validate_result(execute("x = torch.arange(60000)\ny = x + 1"))
        self.assertLessEqual(sum(len(data) for _, data in records.values() if data is not None), 100000)
        self.assertTrue(result["steps"][0]["tensors"][0]["available"])
        self.assertFalse(result["steps"][-1]["tensors"][-1]["available"])

    def test_quantized_values_and_metadata_only_tensors_are_supported(self):
        result, records = validate_result(execute(
            "q = torch.quantize_per_tensor(torch.tensor([1., 2., 3.]), .5, 0, torch.qint8)\n"
            "m = torch.empty(2, device='meta')\ns = torch.eye(2).to_sparse()\n"
            "h = torch.ones([1] * 33)"))
        tensors = {item["name"]: item for item in result["steps"][-1]["tensors"]}
        self.assertEqual(slice_snapshot(records, {"id": tensors["q"]["id"]})["values"], [[1., 2., 3.]])
        for name in ("m", "s", "h"):
            self.assertFalse(tensors[name]["available"])
            with self.assertRaises(ValueError):
                slice_snapshot(records, {"id": tensors[name]["id"]})

    def test_long_scalar_strings_cannot_multiply_session_cache_budget(self):
        candidate = execute("x = torch.zeros(40000, dtype=torch.bool)")
        snapshot_id = next(iter(candidate["snapshots"]))
        candidate["snapshots"][snapshot_id] = ["x" * 128] * 40000
        with self.assertRaisesRegex(ValueError, "内存限制"):
            validate_result(candidate)

    def test_json_parser_counts_structure_but_not_punctuation_inside_strings(self):
        source = {"stdout": '[ { " escaped \\"' * 1000}
        self.assertEqual(_parse_json(json.dumps(source).encode()), source)
        with self.assertRaises(ValueError):
            _parse_json(b'{"x":[' + b"0," * 300000 + b"0]}")

    def test_untrusted_shape_values_stats_and_duplicate_ids_are_rejected(self):
        valid = execute("x = torch.arange(3)")
        for field, value in (("shape", [2]), ("shape", [-1]), ("stride", [False]),
                             ("numel", 4), ("offset", "0"), ("stats", []),
                             ("element_size", 999), ("name", "x" * 257)):
            candidate = copy.deepcopy(valid)
            candidate["result"]["steps"][0]["tensors"][0][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                validate_result(candidate)
        snapshot_id = next(iter(valid["snapshots"]))
        for values in ([0, 1], [0, 1, {}], [0, 1, float("nan")]):
            candidate = copy.deepcopy(valid)
            candidate["snapshots"][snapshot_id] = values
            with self.subTest(values=values), self.assertRaises(ValueError):
                validate_result(candidate)
        candidate = copy.deepcopy(valid)
        candidate["result"]["steps"] *= 2
        with self.assertRaises(ValueError):
            validate_result(candidate)

    def test_protocol_does_not_accept_pickle_nonfinite_json_or_extra_stdout(self):
        for data in (b"not json", b"\x80\x04cos\nsystem\n.", b'{"value": NaN}',
                     b'notice\n{"protocol":1}', b"[" * 1500 + b"]" * 1500):
            with self.subTest(data=data[:30]), self.assertRaises(ValueError):
                _parse_json(data)

    def test_sessions_are_isolated_and_failure_invalidates_previous_snapshots(self):
        encoded = json.dumps(execute("x = torch.arange(3)")).encode()
        first, second = SandboxRunner(), SandboxRunner()
        with patch("tensorv.sandbox._run_container", return_value=encoded) as run:
            result = first.request({"action": "execute", "code": "x = torch.arange(3)"})
            snapshot_id = result["steps"][0]["tensors"][0]["id"]
            self.assertEqual(first.request({"action": "slice", "id": snapshot_id})["values"], [[0, 1, 2]])
            self.assertNotIn("slice", first.records[snapshot_id][0])
            with self.assertRaises(ValueError):
                second.request({"action": "slice", "id": snapshot_id})
            self.assertEqual(run.call_count, 1)
        with patch("tensorv.sandbox._run_container", side_effect=TimeoutError):
            with self.assertRaises(TimeoutError):
                first.request({"action": "execute", "code": "while True: pass"})
        self.assertEqual(first.records, {})
        self.assertFalse(first.ready)


class SandboxPolicyTests(unittest.TestCase):
    def test_public_policy_requires_gvisor_and_disables_host_access(self):
        command = container_command("test")
        for option, value in (("--runtime", "runsc"), ("--network", "none"),
                              ("--user", "65532:65532"), ("--cap-drop", "ALL"),
                              ("--memory", "512m"), ("--memory-swap", "512m"),
                              ("--log-driver", "none")):
            self.assertEqual(command[command.index(option) + 1], value)
        self.assertIn("--read-only", command)
        self.assertNotIn("--privileged", command)
        self.assertNotIn("--volume", command)
        self.assertNotIn("--mount", command)
        for runtime in ("runc", "", "runsc --privileged"):
            with self.assertRaises(ValueError):
                SandboxRunner(runtime=runtime)

    def test_container_and_descendants_are_removed_on_success_timeout_and_invalid_output(self):
        for failure in (None, TimeoutError("deadline"), ValueError("output limit")):
            with self.subTest(failure=failure), patch("tensorv.sandbox._docker") as docker, \
                    patch("tensorv.sandbox._exchange", return_value=b"{}", side_effect=failure):
                if failure:
                    with self.assertRaises(type(failure)):
                        _run_container({}, "image", "runsc", 1)
                else:
                    self.assertEqual(_run_container({}, "image", "runsc", 1), b"{}")
                create = docker.call_args_list[0].args
                remove = docker.call_args_list[-1].args
                self.assertEqual(remove, ("rm", "--force", create[create.index("--name") + 1]))

    def test_startup_refuses_missing_or_relabelled_runtime(self):
        for info in ({"OSType": "linux", "Runtimes": {}},
                     {"OSType": "linux", "Runtimes": {"runsc": {"path": "runc"}}}):
            with self.subTest(info=info), patch("tensorv.sandbox.platform.system", return_value="Linux"), \
                    patch("tensorv.sandbox._docker", return_value=json.dumps(info).encode()), \
                    patch("tensorv.sandbox._run_container") as run:
                with self.assertRaises(OSError):
                    check_sandbox()
                run.assert_not_called()

    def test_startup_probes_nonroot_execution_with_actual_runtime(self):
        info = {"OSType": "linux", "Runtimes": {"runsc": {"path": "/usr/local/bin/runsc"}}}
        with patch("tensorv.sandbox.platform.system", return_value="Linux"), \
                patch("tensorv.sandbox._docker", return_value=json.dumps(info).encode()), \
                patch("tensorv.sandbox._run_container", return_value=b'{"ready":true,"uid":65532,"torch_version":"2.14.1"}') as run:
            self.assertTrue(check_sandbox()["ready"])
            self.assertEqual(run.call_args.args[-1], 45)

    @unittest.skipUnless(platform.system() == "Linux", "selector pipe integration requires Linux")
    def test_raw_output_flood_and_nonterminating_process_are_bounded(self):
        with self.assertRaises(ValueError):
            _exchange([sys.executable, "-c", "import os; os.write(1,b'x'*100000)"], b"{}", 2, 1024)
        with self.assertRaises(ValueError):
            _exchange([sys.executable, "-c", "import os; os.write(2,b'x'*100000)"], b"{}", 2, 1024)
        with self.assertRaises(TimeoutError):
            _exchange([sys.executable, "-c", "while True: pass"], b"{}", 0.1)


if __name__ == "__main__":
    unittest.main()
