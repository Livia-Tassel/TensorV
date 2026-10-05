"""Opt-in gVisor integration checks against a locally built sandbox image.

Run serially on an otherwise idle deployment host:
    TENSORV_SANDBOX_IMAGE=tensorv-sandbox:0.2.0 \
        python3 -m unittest discover -s tests -p test_sandbox_live.py -v

The host imports only the trusted runner and Python's standard library. PyTorch
and every test snippet run exclusively inside disposable gVisor containers.
"""

import json
import os
import subprocess
import unittest

from tensorv.sandbox import SandboxRunner


IMAGE = os.environ.get("TENSORV_SANDBOX_IMAGE")


@unittest.skipUnless(IMAGE, "Set TENSORV_SANDBOX_IMAGE to run real gVisor integration checks")
class LiveSandboxTests(unittest.TestCase):
    def setUp(self):
        self.runner = SandboxRunner(image=IMAGE, timeout=20)

    def tearDown(self):
        self.runner.stop()
        # This suite intentionally requires an otherwise idle sandbox service.
        # No worker (including a detached descendant) may survive a request.
        remaining = subprocess.run(
            ["docker", "ps", "--all", "--filter", "label=app=tensorv-sandbox", "--quiet"],
            capture_output=True, text=True, timeout=10, check=True,
        ).stdout.strip()
        self.assertEqual(remaining, "", "A sandbox container remained after the request")

    def execute(self, code):
        result = self.runner.request({"action": "execute", "code": code})
        self.assertIsNone(result["error"], result["error"])
        return result

    def assert_recovers(self):
        self.runner.timeout = 20
        result = self.execute("x = torch.tensor([1.25, 2.5])")
        self.assertEqual(result["steps"][-1]["tensors"][0]["slice"]["values"], [[1.25, 2.5]])

    def test_01_identity_network_mounts_and_ephemeral_tmp(self):
        result = self.execute(
            "import errno, json, os, socket\n"
            "from pathlib import Path\n"
            "checks = {'uid': os.getuid(), 'host_app_visible': Path('/opt/tensorv').exists(), "
            "'docker_socket_visible': Path('/var/run/docker.sock').exists()}\n"
            "try:\n"
            "    Path('/app/tensorv-live-probe').write_text('unexpected write')\n"
            "    checks['rootfs_write_blocked'] = False\n"
            "except OSError as exc:\n"
            "    checks['rootfs_write_blocked'] = exc.errno in (errno.EROFS, errno.EACCES)\n"
            "try:\n"
            "    connection = socket.create_connection(('1.1.1.1', 443), timeout=1)\n"
            "    connection.close()\n"
            "    checks['outbound_network_blocked'] = False\n"
            "except OSError:\n"
            "    checks['outbound_network_blocked'] = True\n"
            "Path('/tmp/tensorv-live-marker').write_text('request-local data')\n"
            "checks['tmp_writable'] = Path('/tmp/tensorv-live-marker').exists()\n"
            "print(json.dumps(checks))"
        )
        self.assertEqual(json.loads(result["stdout"]), {
            "uid": 65532, "host_app_visible": False, "docker_socket_visible": False,
            "rootfs_write_blocked": True, "outbound_network_blocked": True,
            "tmp_writable": True,
        })
        next_run = self.execute(
            "from pathlib import Path\nprint(Path('/tmp/tensorv-live-marker').exists())"
        )
        self.assertEqual(next_run["stdout"].strip(), "False")

    def test_02_timeout_destroys_worker_and_next_execution_recovers(self):
        # Includes PyTorch's cold start; never use a sub-second deadline here.
        self.runner.timeout = 8
        with self.assertRaises(TimeoutError):
            self.runner.request({"action": "execute", "code": "while True: pass"})
        self.assertFalse(self.runner.ready)
        self.assertEqual(self.runner.records, {})
        self.assert_recovers()

    def test_03_direct_output_flood_is_bounded_and_next_execution_recovers(self):
        with self.assertRaisesRegex(ValueError, "超过限制"):
            self.runner.request({
                "action": "execute",
                # Pipe writes may be short under gVisor. Count bytes actually
                # written so the test necessarily reaches the 16 MiB cap.
                "code": (
                    "import os\n"
                    "remaining = 20 * 1024 * 1024\n"
                    "while remaining:\n"
                    "    remaining -= os.write(1, b'x' * min(65536, remaining))"
                ),
            })
        self.assertFalse(self.runner.ready)
        self.assertEqual(self.runner.records, {})
        self.assert_recovers()

    def test_04_detached_child_does_not_survive_a_successful_request(self):
        result = self.execute(
            "import subprocess, sys\n"
            "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'], "
            "stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, "
            "start_new_session=True)\n"
            "print('child-started', child.pid)\n"
            "x = torch.arange(3)"
        )
        self.assertIn("child-started", result["stdout"])
        self.assertEqual(result["steps"][-1]["tensors"][0]["slice"]["values"], [[0, 1, 2]])


if __name__ == "__main__":
    unittest.main()
