"""Real-worker rejection and cancellation checks; run under sourced Humble."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(os.environ.get('ROS_DISTRO') == 'humble', 'requires sourced ROS 2 Humble in WSL')
class WorkerProcessTests(unittest.TestCase):
    def fixture(self, directory, code):
        base=Path(directory)
        spec=base/'spec.json'
        source=base/'code.py'
        spec.write_text(json.dumps({'task_type':'joint_position','parameters':{'duration':8},'hardware':{'ros_distro':'humble'}}))
        source.write_text(code)
        output=base/'attempt-1'
        command=[sys.executable,str(ROOT/'worker'/'execute.py'),'--spec',str(spec),'--code',str(source),'--output',str(output)]
        return command,output

    def test_unsafe_code_cannot_start_ros_or_build(self):
        with tempfile.TemporaryDirectory(prefix='worker-integration-',dir=ROOT/'runs') as directory:
            command,output=self.fixture(directory,"import os\ndef compute_command(value,target,threshold,max_velocity):\n    return os.system('false')\n")
            process=subprocess.run(command,cwd=ROOT,capture_output=True,text=True,timeout=15)
            self.assertEqual(process.returncode,1)
            result=json.loads((output/'result.json').read_text())
            self.assertFalse(result['passed'])
            self.assertEqual(result['metrics']['cleanup'],{'owned_process_count':0,'all_exited':True})
            self.assertFalse((output/'ros_ws').exists())

    def test_cancel_during_real_ros_terminates_owned_processes(self):
        with tempfile.TemporaryDirectory(prefix='worker-integration-',dir=ROOT/'runs') as directory:
            command,output=self.fixture(directory,"def compute_command(value,target,threshold,max_velocity):\n    return max(-max_velocity,min(max_velocity,3*(target-value)))\n")
            logfile=Path(directory)/'events.log'
            with logfile.open('w') as stream:
                process=subprocess.Popen(command,cwd=ROOT,stdout=stream,stderr=subprocess.STDOUT)
                try:
                    deadline=time.monotonic()+35
                    while '"stage": "testing"' not in logfile.read_text() and process.poll() is None and time.monotonic()<deadline:
                        time.sleep(.1)
                    self.assertIsNone(process.poll(),logfile.read_text())
                    self.assertIn('"stage": "testing"',logfile.read_text())
                    time.sleep(1.0)
                    (output/'cancel.flag').write_text('independent runtime test')
                    process.wait(timeout=10)
                    self.assertEqual(process.returncode,130,logfile.read_text())
                    result=json.loads((output/'result.json').read_text())
                    self.assertTrue(result['cancelled'])
                    self.assertTrue(result['metrics']['cleanup']['all_exited'])
                    self.assertGreaterEqual(result['metrics']['cleanup']['owned_process_count'],3)
                    self.assertEqual(json.loads((output/'worker-state.json').read_text())['status'],'stopped')
                finally:
                    if process.poll() is None:
                        (output/'cancel.flag').write_text('test cleanup')
                        process.wait(timeout=10)


if __name__=='__main__':
    unittest.main()
