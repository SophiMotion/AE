import os
import json
from pathlib import Path
import tempfile
import unittest
from worker.firmware import FQBNS,ROOT,TOOLS,generate_firmware,compile_host_core,validate_hardware,probe_firmware_toolchain
from worker.policy import validate_parameters
from worker.execute import Supervisor,Cancelled,classify_failure


class FirmwareConfigurationTests(unittest.TestCase):
    def test_targets_and_hardware_boundaries(self):
        for board,fqbn in FQBNS.items():
            self.assertTrue(validate_hardware({'board':board,'transport':'serial_jsonl','physical_io':False,'baudrate':115200},'joint_position'))
            self.assertTrue(fqbn.startswith('esp32:esp32:'))
        self.assertFalse(validate_hardware({'board':'未指定（模拟）','transport':'simulated'},'joint_position'))
        for hardware in ({'board':'unknown','transport':'simulated'},{'board':'esp32','transport':'serial_jsonl','physical_io':True},{'board':'esp32','transport':'serial_jsonl','baudrate':9600},{'board':'esp32','transport':'serial_jsonl','sensor':'simulated_scalar'}):
            with self.subTest(hardware=hardware),self.assertRaises(ValueError): validate_hardware(hardware,'joint_position')

    def test_probe_never_claims_board_execution(self):
        result=probe_firmware_toolchain()
        for key in ('flashed','esp32_execution_verified','physical_verified'): self.assertFalse(result[key])

    def test_failure_scope_distinguishes_environment_and_logic(self):
        self.assertEqual(classify_failure([{'name':'primary_state_frequency','passed':False}]),'environment')
        self.assertEqual(classify_failure([],TimeoutError('endpoint discovery')),'environment')
        self.assertEqual(classify_failure([{'name':'firmware_cross_compile','passed':False}]),'firmware')
        self.assertEqual(classify_failure([{'name':'primary_position_tolerance','passed':False}]),'algorithm')

    def test_generated_selected_target_has_explicit_pending_evidence(self):
        from worker.templates import generate
        with tempfile.TemporaryDirectory(prefix='firmware-test-',dir=ROOT/'runs') as directory:
            output=Path(directory)
            generate(output,{'task_type':'sensor_threshold','parameters':validate_parameters({'duration':4}),'hardware':{'board':'esp32s3','transport':'serial_jsonl'}},'def compute_command(value,target,threshold,max_velocity):\n    return float(value >= threshold)\n')
            contract=json.loads((output/'communication.json').read_text())['esp32']
            self.assertEqual(contract['validation_scope'],'host_protocol_core_pty_ros')
            self.assertFalse(contract['board_compiled'])
            self.assertFalse((output/'esp32'/'ae_reference.ino').exists())
            self.assertIn('esp32:esp32:esp32s3',(output/'esp32'/'README.md').read_text(encoding='utf-8'))


@unittest.skipUnless(os.name=='posix' and (TOOLS/'user'/'libraries'/'ArduinoJson'/'src'/'ArduinoJson.h').is_file(),'requires WSL C++ and fixed portable ArduinoJson library')
class NativeProtocolTests(unittest.TestCase):
    def fixture(self,directory,kind):
        output=Path(directory);spec={'task_type':kind,'parameters':validate_parameters({'duration':4}),'hardware':{'board':'esp32','transport':'serial_jsonl'}}
        generate_firmware(output,spec)
        supervisor=Supervisor(output)
        compile_host_core(output,supervisor,dict(os.environ))
        return output,spec,supervisor

    def test_native_shared_core_faults_for_both_tasks(self):
        from worker.protocol_verification import verify_core_faults
        for kind in ('sensor_threshold','joint_position'):
            with self.subTest(kind=kind),tempfile.TemporaryDirectory(prefix='firmware-test-',dir=ROOT/'runs') as directory:
                output,spec,supervisor=self.fixture(directory,kind)
                try:
                    checks=verify_core_faults(output,kind,spec['parameters'],supervisor,dict(os.environ))
                    self.assertTrue(all(item['passed'] for item in checks),checks)
                finally: supervisor.close()
                self.assertTrue(all(not supervisor.group_alive(process.pid) for process in supervisor.processes))

    def test_cancel_native_protocol_stops_owned_child(self):
        import pty
        with tempfile.TemporaryDirectory(prefix='firmware-test-',dir=ROOT/'runs') as directory:
            output,spec,supervisor=self.fixture(directory,'sensor_threshold')
            master,slave=pty.openpty()
            try:
                child=supervisor.spawn([str(output/'esp32'/'host_protocol'),str(master),'sensor_threshold','.5','.8'],output/'host.log',dict(os.environ),pass_fds=(master,))
                (output/'cancel.flag').write_text('independent test')
                with self.assertRaises(Cancelled): supervisor.ensure_active()
                supervisor.close()
                self.assertIsNotNone(child.poll())
                self.assertFalse(supervisor.group_alive(child.pid))
            finally:
                supervisor.close();os.close(master);os.close(slave)

    def test_millis_wrap_watchdog_and_monotonic_elapsed(self):
        # Actual native build of the same header with deterministic clock inputs.
        with tempfile.TemporaryDirectory(prefix='firmware-test-',dir=ROOT/'runs') as directory:
            output=Path(directory);supervisor=Supervisor(output)
            source=output/'clock_test.cpp'
            source.write_text('''#include "protocol_core.hpp"
#include <vector>
#include <string>
#include <cstdio>
static std::vector<std::string> packets;
static void emit(void*,const char* line){packets.emplace_back(line);}
int main(){
  ae::ProtocolCore core(true,.5,.8,emit,nullptr);
  core.tick(0xfffffff0u);
  const char* command="{\\"seq\\":1,\\"time\\":0,\\"value\\":0.2}\\n";
  for(const char* p=command;*p;++p) core.feed(*p,0xfffffff0u);
  core.tick(0x30u);
  if(fabs(core.applied()-.2)>1e-9 || core.last_sequence()!=1){fprintf(stderr,"applied=%.17g seq=%lld\\n",core.applied(),(long long)core.last_sequence());return 1;}
  const char* limit_command="{\\"seq\\":2,\\"time\\":0,\\"value\\":0.8}\\n";
  for(const char* p=limit_command;*p;++p) core.feed(*p,0x30u);
  if(core.applied()!=.8 || core.last_sequence()!=2) return 5;
  ae::ProtocolCore low(true,.5,.1,emit,nullptr);
  const char* low_command="{\\"seq\\":1,\\"time\\":0,\\"value\\":0.1}\\n";
  for(const char* p=low_command;*p;++p) low.feed(*p,0);
  if(low.applied()!=.1 || low.last_sequence()!=1) return 6;
  core.tick(0x300u);
  if(core.applied()!=0) return 2;
  bool timeout=false;double previous=-1;
  for(const auto& line:packets){JsonDocument p;deserializeJson(p,line);
    if(p["event"]=="device_timeout") timeout=true;
    if(p["kind"]=="state"){double t=p["time"].as<double>();if(t<previous || t>2)return 3;previous=t;}}
  return timeout && previous>.6 ? 0 : 4;
}
''',encoding='utf-8')
            from worker.firmware import SOURCES
            environment=dict(os.environ)
            try:
                command=['g++','-std=c++17','-O2','-Wall','-Wextra','-Werror','-I',str(SOURCES),'-I',str(TOOLS/'user'/'libraries'/'ArduinoJson'/'src'),str(source),'-o',str(output/'clock_test')]
                compiled=supervisor.run(command,output/'build.log',environment,timeout=45)
                self.assertEqual(compiled,0,(output/'build.log').read_text())
                tested=supervisor.run([str(output/'clock_test')],output/'test.log',environment,timeout=5)
                self.assertEqual(tested,0,(output/'test.log').read_text())
            finally: supervisor.close()


@unittest.skipUnless(os.name=='posix','requires Linux process identities and child-subreaper')
class LifecycleTests(unittest.TestCase):
    def test_fast_parent_exit_adopted_setsid_child_is_cleaned(self):
        import sys
        import subprocess
        import time
        with tempfile.TemporaryDirectory(prefix='firmware-test-',dir=ROOT/'runs') as directory:
            output=Path(directory)
            # Deliberately pre-existing direct child must never become owned.
            foreign=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'])
            supervisor=Supervisor(output)
            marker=output/'child.pid'
            source='import os,sys,time\npid=os.fork()\nif pid==0:\n os.setsid()\n time.sleep(30)\nelse:\n open(sys.argv[1],"w").write(str(pid))\n os._exit(0)\n'
            try:
                parent=supervisor.spawn([sys.executable,'-c',source,str(marker)],output/'parent.log',dict(os.environ))
                parent.wait(timeout=5)  # No polling while the parent forks/exits.
                child=int(marker.read_text())
                supervisor.close()
                self.assertTrue(supervisor.all_exited())
                self.assertTrue(supervisor.owned_descendants[child]['adopted'])
                self.assertFalse(Path(f'/proc/{child}').exists(),'adopted child should also be reaped')
                self.assertIsNone(foreign.poll(),'pre-existing direct child must survive')
            finally:
                supervisor.close();foreign.terminate();foreign.wait(timeout=5)


@unittest.skipUnless(os.name=='posix' and probe_firmware_toolchain()['available'],'requires fully installed fixed WSL ESP32 toolchain')
class CompilerCancellationTests(unittest.TestCase):
    def test_cancel_real_cli_compile_cleans_own_group(self):
        import threading
        import time
        from worker.firmware import compile_firmware
        with tempfile.TemporaryDirectory(prefix='firmware-test-',dir=ROOT/'runs') as directory:
            output=Path(directory)
            spec={'task_type':'sensor_threshold','parameters':validate_parameters({'duration':4}),'hardware':{'board':'esp32s3','transport':'serial_jsonl'}}
            generate_firmware(output,spec)
            supervisor=Supervisor(output);done=threading.Event();observed=[]
            def cancel_owned_compile():
                deadline=time.monotonic()+15
                while not done.is_set() and time.monotonic()<deadline:
                    if supervisor.processes:
                        group=supervisor.processes[0].pid
                        table={}
                        for entry in Path('/proc').glob('[0-9]*/stat'):
                            try:
                                fields=entry.read_text().rsplit(')',1)[1].split()
                                table[int(entry.parent.name)]={'parent':int(fields[1]),'group':int(fields[2]),'start':fields[19],'state':fields[0]}
                            except (OSError,ValueError,IndexError): pass
                        descendants={group}
                        while True:
                            discovered={pid for pid,info in table.items() if info['parent'] in descendants}
                            if discovered.issubset(descendants): break
                            descendants.update(discovered)
                        for pid in descendants-{group}:
                            if table[pid]['state']!='Z': observed.append({'pid':pid,**table[pid]})
                        if observed:
                            (output/'cancel.flag').write_text('independent real compiler cancellation')
                            return
                    time.sleep(.05)
                if not done.is_set(): (output/'cancel.flag').write_text('compiler initialization cancellation')
            thread=threading.Thread(target=cancel_owned_compile,daemon=True);thread.start()
            try:
                with self.assertRaises(Cancelled): compile_firmware(spec,output,supervisor,dict(os.environ))
            finally:
                done.set();thread.join(timeout=2);supervisor.close()
            self.assertTrue(observed,'must observe actual compiler descendant, not only CLI initialization')
            self.assertTrue(all(process.poll() is not None and not supervisor.group_alive(process.pid) for process in supervisor.processes))
            self.assertTrue(json.loads((output/'worker-state.json').read_text())['all_exited'])
            remaining=[]
            for owned in observed:
                try:
                    fields=Path(f'/proc/{owned["pid"]}/stat').read_text().rsplit(')',1)[1].split()
                    if fields[19]==owned['start'] and fields[0]!='Z': remaining.append(owned)
                except (OSError,IndexError): pass
            # If the assertion finds a leak, stop only the captured descendant
            # with identical kernel start-time; leave unrelated processes alone.
            for owned in remaining:
                try: os.kill(owned['pid'],15)
                except ProcessLookupError: pass
            self.assertFalse(remaining,'owned compiler descendants escaped cleanup: '+json.dumps(remaining))


if __name__=='__main__': unittest.main()
