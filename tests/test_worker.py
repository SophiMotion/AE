import importlib.util
from pathlib import Path
import sys
import unittest
import tempfile
import json
import time
import os
import ast
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


class WorkerPolicyTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(importlib.util.find_spec("worker.policy"), "worker policy must exist")
        from worker import policy
        self.policy = policy

    def test_accepts_bounded_joint_function_and_math(self):
        function = self.policy.load_compute("import math\ndef compute_command(value, target, threshold, max_velocity):\n    error = target - value\n    return max(-max_velocity, min(max_velocity, math.tanh(error * 3.0)))\n")
        self.assertGreater(function(0.0, 0.6, 0.5, 0.8), 0)
        self.assertLessEqual(abs(function(-100, 0.6, 0.5, 0.8)), 0.8)

    def test_accepts_threshold_at_equality(self):
        function = self.policy.load_compute("def compute_command(value, target, threshold, max_velocity):\n    return 1.0 if value >= threshold else 0.0\n")
        self.assertEqual(function(0.5, 0.6, 0.5, 0.8), 1)
        self.assertEqual(function(0.49, 0.6, 0.5, 0.8), 0)

    def test_rejects_system_calls_and_escape(self):
        snippets = [
            "import os\ndef compute_command(value, target, threshold, max_velocity):\n    return os.system('echo bad')",
            "def compute_command(value, target, threshold, max_velocity):\n    return value.__class__",
            "def compute_command(value, target, threshold, max_velocity):\n    return __import__('os')",
            "def compute_command(value, target, threshold, max_velocity):\n    while True:\n        pass",
            "def compute_command(value, target, threshold, max_velocity):\n    return 10 ** 1000000",
            "def compute_command(value, target, threshold, max_velocity):\n    math = value\n    return 0",
            "def compute_command(value, target, threshold, max_velocity):\n    return [1][0]",
            "def compute_command(value, target, threshold, max_velocity, x=1):\n    return x",
            "@float\ndef compute_command(value, target, threshold, max_velocity):\n    return 0",
            "def compute_command(value,target,threshold,max_velocity):\n    def float(value):\n        return value\n    return 0",
            "def compute_command(value,target,threshold,max_velocity):\n    import math\n    return 0",
        ]
        for code in snippets:
            with self.subTest(code=code), self.assertRaises(ValueError):
                self.policy.load_compute(code)

    def test_result_requires_finite_numeric(self):
        function = self.policy.load_compute("def compute_command(value, target, threshold, max_velocity):\n    return value * value\n")
        with self.assertRaises(ValueError):
            function(1e308, 0.6, 0.5, 0.8)

    def test_all_arithmetic_operands_are_converted_to_float(self):
        code='def compute_command(value,target,threshold,max_velocity):\n    a = value == target\n    a = a + a\n    return a * 2\n'
        with patch('builtins.compile',wraps=compile) as compiler:
            function=self.policy.load_compute(code)
        tree=next(call.args[0] for call in compiler.call_args_list if isinstance(call.args[0],ast.Module))
        for node in ast.walk(tree):
            if isinstance(node,ast.BinOp):
                for operand in (node.left,node.right):
                    self.assertIsInstance(operand,ast.Call)
                    self.assertEqual(operand.func.id,'float')
        self.assertEqual(function(.6,.6,.5,.8),4.0)
        # Execute only the validated/transformed function; never raw squaring.
        squares='def compute_command(value,target,threshold,max_velocity):\n    a = 1000000\n'+'    a = a * a\n'*6+'    return a\n'
        bounded=self.policy.load_compute(squares)
        with self.assertRaises(ValueError): bounded(.1,.6,.5,.8)

    def test_message_validation_rejects_bad_sequence_and_values(self):
        self.assertEqual(self.policy.parse_frame('{"seq":1,"value":0.3,"time":0.1}')["seq"], 1)
        for raw in ('{"seq":true,"value":0.3,"time":0.1}', '{"seq":1,"value":NaN,"time":0}', '{"seq":-1,"value":0,"time":0}', '{"seq":1,"value":0,"time":-1}', '{}'):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                self.policy.parse_frame(raw)

    def test_same_sequence_command_is_rejected_after_first_apply(self):
        gate = self.policy.SequenceGate()
        self.assertTrue(gate.accept(3))
        self.assertFalse(gate.accept(3))
        self.assertFalse(gate.accept(2))
        self.assertTrue(gate.accept(4))

    def test_spec_bounds_and_output_scope(self):
        self.assertEqual(self.policy.validate_parameters({"target": 0.6, "threshold": 0.5, "tolerance": 0.04, "duration": 8.0, "max_velocity": 0.8})["target"], 0.6)
        for parameters in ({"duration": 1e9}, {"target": float("nan")}, {"threshold": 3}, {"max_velocity": -1}):
            with self.subTest(parameters=parameters), self.assertRaises(ValueError):
                self.policy.validate_parameters(parameters)
        for key,(low,high) in self.policy.BOUNDS.items():
            for value in (low,high):
                self.assertEqual(self.policy.validate_parameters({key:value})[key],value)
            for value in (low-.0001,high+.0001):
                with self.assertRaises(ValueError): self.policy.validate_parameters({key:value})
        with self.assertRaises(ValueError):
            self.policy.safe_output(ROOT / "docs" / "attempt-1", ROOT)
        with self.assertRaises(ValueError):
            self.policy.safe_output(ROOT / "runs" / "foo" / "attempt-1" / ".." / ".." / ".." / "docs", ROOT)
        self.assertEqual(self.policy.safe_output(ROOT / "runs" / "probe" / "attempt-1", ROOT), ROOT / "runs" / "probe" / "attempt-1")
        deployment = ROOT/'runs'/'probe'/'deployment-abc01234'
        self.assertEqual(self.policy.safe_output(deployment, ROOT, deploy=True),deployment)
        with self.assertRaises(ValueError): self.policy.safe_output(deployment,ROOT)

    def test_supervisor_cancel_lease_and_state(self):
        from worker.execute import Supervisor, Cancelled
        with tempfile.TemporaryDirectory(dir=ROOT / 'runs') as directory:
            output=Path(directory)
            supervisor=Supervisor(output)
            supervisor.ensure_active()
            self.assertEqual(json.loads((output/'worker-state.json').read_text())['status'],'running')
            (output/'lease.json').write_text(json.dumps({'heartbeat':time.time()-11}))
            os.utime(output/'lease.json',(time.time()-11,time.time()-11))
            with self.assertRaises(Cancelled): supervisor.ensure_active()
            (output/'lease.json').write_text('{')
            supervisor.ensure_active()
            with patch('worker.execute.time.monotonic',return_value=supervisor.bad_lease_since+2.1):
                with self.assertRaises(Cancelled): supervisor.ensure_active()
            (output/'cancel.flag').write_text('cancel')
            with self.assertRaises(Cancelled): supervisor.ensure_active()
            supervisor.close()
            self.assertEqual(json.loads((output/'worker-state.json').read_text()), {'status':'stopped','all_exited':True})


if __name__ == "__main__":
    unittest.main()
