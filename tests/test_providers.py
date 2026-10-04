"""Provider contracts and real subprocess/HTTP transport; mocks are not AI evidence."""
import json
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from server import providers as p
from server import retrieval

ROOT = Path(__file__).resolve().parents[1]
SPEC = {"name": "test", "request": "关节到目标位置", "task_type": "joint_position",
        "parameters": {"target": 0.6, "threshold": 0.5, "max_velocity": 0.8},
        "hardware": {"ros_distro": "humble", "board": "未指定（模拟）"}, "spec_revision": 1}
CODE = "def compute_command(value, target, threshold, max_velocity):\n    return float(max(-max_velocity, min(max_velocity, 2.0 * (target - value))))\n"


class RetrievalTests(unittest.TestCase):
    def test_sources_have_traceable_metadata(self):
        items = retrieval.list_sources()
        self.assertGreaterEqual(len(items), 6)
        self.assertEqual(len(items), len({x["id"] for x in items}))
        for item in items:
            for key in ("title", "url", "version", "content", "tags", "license", "checked_at"):
                self.assertTrue(item[key])

    def test_task_filter_and_keyword_ranking(self):
        items = retrieval.retrieve("ESP32 UART 串口 接线", "sensor_threshold")
        self.assertEqual(items[0]["id"], "esp32-uart")
        self.assertNotIn("gazebo-ros-pairing", [x["id"] for x in items])
        self.assertEqual(retrieval.retrieve("anything", "unimplemented_robot"), [])

    def test_ros_version_filter(self):
        # Exercise persisted filtering; mocking list_sources no longer reaches
        # the SQLite query and would allow a broken filter to pass unnoticed.
        with tempfile.TemporaryDirectory(dir=ROOT / '.tools') as folder:
            root = Path(folder)
            (root / 'knowledge').mkdir()
            (root / 'knowledge' / 'sources.json').write_text('{"items":[]}', encoding='utf-8')
            common = {'title': 'rclpy version fixture', 'version': 'fixture-1', 'board': 'any', 'robot_model': 'any', 'task_types': ['joint_position'], 'software_versions': {'esp32_core': 'any', 'arduinojson': 'any'}}
            correct = retrieval.ingest_document(root, 'humble.txt', b'rclpy test evidence', {**common, 'ros_distro':'humble'})
            wrong = retrieval.ingest_document(root, 'jazzy.txt', b'rclpy rclpy test evidence', {**common, 'ros_distro':'jazzy'})
            result = retrieval.retrieve('rclpy', 'joint_position', 10, root=root)
            self.assertIn(correct['id'], [x['document_id'] for x in result])
            self.assertNotIn(wrong['id'], [x['document_id'] for x in result])

    def test_reads_do_not_share_mutable_results(self):
        items = retrieval.list_sources()
        items[0]["title"] = "changed"
        self.assertNotEqual(retrieval.list_sources()[0]["title"], "changed")


class CodeBoundaryTests(unittest.TestCase):
    def test_supported_math(self):
        p._validate_code(CODE)
        p._validate_code("import math\ndef compute_command(value, target, threshold, max_velocity):\n    if not math.isfinite(value):\n        return 0.0\n    return 1.0 if value >= threshold else 0.0\n")

    def test_rejects_system_file_import_loop_and_signature(self):
        samples = [
            "import os\n" + CODE,
            "open('outside','w')\n" + CODE,
            CODE.replace("2.0 * (target - value)", "__import__('os').system('x')"),
            CODE.replace("    return", "    while True:\n        pass\n    return"),
            CODE.replace("threshold, max_velocity", "threshold, max_velocity=1"),
            CODE.replace("2.0 * (target - value)", "value.__class__"),
        ]
        for code in samples:
            with self.subTest(code=code), self.assertRaises(p.ProviderError):
                p._validate_code(code)

    def test_structured_response_does_not_silently_fill_fields(self):
        with self.assertRaises(p.ProviderError):
            p._parse_object('{"code":"x"}', p.CODE_SCHEMA)
        with self.assertRaises(p.ProviderError):
            p._parse_object('not json', p.CODE_SCHEMA)

    def test_rejects_nested_function_and_nested_import(self):
        for body in ("    def float(value):\n        return value\n    return float(3)",
                     "    import math\n    return math.fabs(value)"):
            with self.subTest(body=body), self.assertRaises(p.ProviderError):
                p._validate_code("def compute_command(value, target, threshold, max_velocity):\n" + body + "\n")

    def test_prompt_minimizes_data_and_preserves_repair_input(self):
        spec = dict(SPEC, meeting_transcript="PRIVATE MEETING", api_key="DO NOT SEND",
                    communication={"timeout_seconds": 0.5}, simulation={"initial_value": 0})
        prompt = p._prompt("code", spec, [], {}, CODE, "actual test failure")
        self.assertNotIn("PRIVATE MEETING", prompt)
        self.assertNotIn("DO NOT SEND", prompt)
        self.assertIn("actual test failure", prompt)
        self.assertIn("previous_code", prompt)
        self.assertIn('"timeout_seconds": 0.5', prompt)
        self.assertIn('"initial_value": 0', prompt)

    def test_endpoint_validation(self):
        for url in ("http://remote.example/v1", "https://key:secret@example.com/v1", "file:///tmp/x",
                    "https://example.com/v1?key=secret"):
            with self.subTest(url=url), self.assertRaises(p.ProviderError):
                p._endpoint({"base_url": url})
        self.assertEqual(p._endpoint({"base_url": "http://127.0.0.1:1234/v1"}),
                         "http://127.0.0.1:1234/v1/chat/completions")

    def test_large_structure_is_bounded_without_losing_joint_limits(self):
        shape = {'type': 'box', 'size': [.1, .2, .3], 'xyz': [0, 0, 0], 'rpy': [0, 0, 0], 'color': [1, 1, 1, 1]}
        model = {'id': 'imported-robot', 'name': '测试模型', 'content_sha256': 'source-hash',
                 'format': 'urdf', 'physics_validated': False, 'warnings': ['模型只作预览'],
                 'links': [{'name': str(i), 'visuals': [shape] * 100} for i in range(100)],
                 'joints': [{'name': 'joint1', 'type': 'revolute', 'parent': '0', 'child': '1',
                             'axis': [0, 0, 1], 'lower': -1.2, 'upper': 1.2}],
                 'motors': {'unused_catalog': 'X' * 310000}}
        spec = dict(SPEC, structure=model)
        prompt = p._prompt('plan', spec, [])
        self.assertLess(len(prompt.encode('utf-8')), 20000)
        self.assertIn('source-hash', prompt)
        self.assertIn('"lower": -1.2', prompt)
        self.assertIn('"link_count": 100', prompt)
        self.assertNotIn('unused_catalog', prompt)
        self.assertEqual(len(model['links'][0]['visuals']), 100)

    def test_public_status_does_not_contain_key(self):
        config = {"provider": "openai", "model": "test-model", "api_key": "test-secret"}
        status = p.get_provider_status(config)
        self.assertNotIn("test-secret", json.dumps(status))
        self.assertTrue(status["key_configured"])

    def test_unrelated_environment_keys_not_borrowed(self):
        with patch.dict(p.os.environ, {"OPENAI_API_KEY": "unrelated", "AE_OPENAI_API_KEY": "old-unrelated"}, clear=True):
            self.assertEqual(p._api_key({}), "")
        with patch.dict(p.os.environ, {"AE_API_KEY": "this-project"}, clear=True):
            self.assertEqual(p._api_key({}), "this-project")
            self.assertEqual(p._api_key({"api_key": ""}), "")


class ProviderTransportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="provider-test-", dir=ROOT / "tests")
        self.workdir = Path(self.temp.name).resolve()
        self.assertTrue(self.workdir.is_relative_to(ROOT / "tests"))
        self.received = []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                owner.received.append({"path": self.path, "authorization": self.headers.get("Authorization"),
                                       "body": json.loads(self.rfile.read(int(self.headers["Content-Length"])))})
                time.sleep(getattr(owner, "delay", 0))
                body = json.dumps({"choices": [{"message": {"content": getattr(owner, "content", json.dumps({"code": CODE, "explanation": "transport fixture"}))}}]}).encode()
                try:
                    self.send_response(getattr(owner, "http_status", 200))
                    if getattr(owner, "http_status", 200) in (301, 302, 307, 308):
                        self.send_header("Location", f"http://127.0.0.1:{owner.server.server_port}/redirected")
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.config = {"provider": "openai", "model": "transport-test", "api_key": "test-secret",
                       "base_url": f"http://127.0.0.1:{self.server.server_port}/v1", "timeout_seconds": 5}

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temp.cleanup()

    def call(self, cancel=None, config=None):
        return p.generate_code(SPEC, {}, [], config or self.config, self.workdir,
                               cancel or threading.Event(), lambda _: None)

    def test_http_adapter_and_secret_free_provenance(self):
        result = self.call()
        self.assertEqual(result["code"], CODE)
        self.assertEqual(self.received[0]["path"], "/v1/chat/completions")
        self.assertEqual(self.received[0]["authorization"], "Bearer test-secret")
        self.assertNotIn("tools", self.received[0]["body"])
        self.assertEqual(result["provenance"]["status"], "completed")
        saved = list(self.workdir.glob("provider-code-*.json"))
        self.assertEqual(len(saved), 1)
        self.assertNotIn("test-secret", saved[0].read_text(encoding="utf-8"))

    def test_invalid_ai_output_is_failure_not_template(self):
        self.content = '{"code": "import os", "explanation":"wrong"}'
        with self.assertRaises(p.ProviderError) as caught:
            self.call()
        self.assertEqual(caught.exception.provenance["status"], "failed")
        self.assertIn("import os", caught.exception.provenance["response"])

    def test_http_errors_not_echoed(self):
        self.http_status = 401
        self.content = "Authorization: Bearer test-secret"
        with self.assertRaises(p.ProviderError) as caught:
            self.call()
        self.assertIn("HTTP 401", str(caught.exception))
        self.assertNotIn("test-secret", json.dumps(caught.exception.provenance))

    def test_http_redirect_does_not_forward_credentials(self):
        self.http_status = 307
        with self.assertRaises(p.ProviderError) as caught:
            self.call()
        self.assertIn("HTTP 307", str(caught.exception))
        self.assertEqual(len(self.received), 1)

    def test_precancelled_request_never_calls_model(self):
        cancel = threading.Event()
        cancel.set()
        with self.assertRaises(p.ProviderCancelled):
            self.call(cancel)
        self.assertEqual(self.received, [])

    def test_running_request_cancelled_promptly(self):
        self.delay = 3
        cancel = threading.Event()
        timer = threading.Timer(0.5, cancel.set)
        timer.start()
        start = time.monotonic()
        try:
            with self.assertRaises(p.ProviderCancelled):
                self.call(cancel)
        finally:
            timer.cancel()
        self.assertLess(time.monotonic() - start, 2.5)

    def test_subprocess_timeout(self):
        start = time.monotonic()
        with self.assertRaises(p.ProviderError):
            p._run_process([sys.executable, "-c", "import time; time.sleep(30)"], "", self.workdir,
                           threading.Event(), 0.3)
        self.assertLess(time.monotonic() - start, 3)

    def test_cli_flags_and_jsonl_parsing(self):
        raw = json.dumps({"code": CODE, "explanation": "CLI transport fixture"})
        event = json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": raw}})
        with patch.object(p, "_codex_path", return_value="codex.exe"), patch.object(p, "_run_process", return_value=(0, event, "")) as run:
            response = p._codex_invoke("prompt", p.CODE_SCHEMA, {}, self.workdir, threading.Event(), 5)
        args = run.call_args.args[0]
        self.assertEqual(response, raw)
        for flag in ("--ignore-user-config", "--ephemeral", "features.shell_tool=false", "features.plugins=false", "read-only"):
            self.assertIn(flag, args)

    def test_cli_tool_activity_refused(self):
        event = json.dumps({"type": "item.completed", "item": {"type": "command_execution"}})
        with patch.object(p, "_codex_path", return_value="codex.exe"), patch.object(p, "_run_process", return_value=(0, event, "")):
            with self.assertRaises(p.ProviderError):
                p._codex_invoke("prompt", p.CODE_SCHEMA, {}, self.workdir, threading.Event(), 5)


if __name__ == "__main__":
    unittest.main()
