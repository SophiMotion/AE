"""Independent vector atomicity/lease tests of real compiled shared V5 core."""
import copy
import json
import os
from pathlib import Path
import tempfile
import unittest
from worker.firmware import ROOT
from worker.firmware_v5 import binding_v5, generate_firmware_v5, compile_host_v5, verify_protocol_v5, serial_budget_v5, validate_binding_v5, hello_frame, wire_frame
from worker.motion_spec_v5 import build_motion_model, compile_motion_program
from worker.firmware_v5 import wait_protocol_condition


def fixture_spec():
    source={'id':'fixture','format':'sophicore-kinematic','links':[{'name':n,'visuals':[]} for n in ('base','upper','lower')], 'joints':[
        {'name':'a','type':'revolute','parent':'base','child':'upper','axis':[1,0,0],'lower':-2,'upper':2,'initial_position':.1},
        {'name':'b','type':'revolute','parent':'upper','child':'lower','axis':[0,1,0],'lower':-1,'upper':1,'initial_position':.2}]}
    model=build_motion_model(source,['a','b'])
    plan={'schema_version':1,'joint_names':['a','b'],'waypoints':[{'positions':[.4,.5],'time_from_start_s':2.,'stage_id':'prepare','cycle_index':0}], 'tolerance_rad':.035,'max_velocity_rad_s':.5,'max_acceleration_rad_s2':1.,'timeout_s':8.}
    return {'pipeline_version':5,'task_type':'joint_sequence','execution_model':model,'motion_program':compile_motion_program(plan,model),'hardware':{'physical_io':False}}


class BindingTests(unittest.TestCase):
    def test_bounded_wait_observes_delayed_ack_without_resending(self):
        from unittest.mock import patch
        clock=[0.];events=[];polls=[]
        def collect(seconds):
            polls.append(seconds);clock[0]+=seconds
            if clock[0]>=.16: events.append('hello_ack')
        with patch('worker.firmware_v5.time.monotonic',side_effect=lambda:clock[0]):
            self.assertTrue(wait_protocol_condition(lambda:'hello_ack' in events,collect,timeout=.3))
        self.assertGreater(clock[0],.03);self.assertLessEqual(clock[0],.3)
        self.assertGreater(len(polls),1)

    def test_bounded_wait_cannot_turn_missing_evidence_into_pass(self):
        from unittest.mock import patch
        clock=[0.]
        def collect(seconds): clock[0]+=seconds
        with patch('worker.firmware_v5.time.monotonic',side_effect=lambda:clock[0]):
            self.assertFalse(wait_protocol_condition(lambda:False,collect,timeout=.1))
        self.assertAlmostEqual(clock[0],.1)

    def test_same_contract_and_budget(self):
        from worker.motion_spec_v5 import motion_contract
        spec=fixture_spec();binding=binding_v5(spec)
        self.assertEqual(binding['identity'],motion_contract(spec)['communication']['identity'])
        budget=serial_budget_v5(binding)
        self.assertTrue(budget['within_budget']);self.assertEqual(budget['baudrate'],921600)
        self.assertGreater(budget['max_rx_bytes_s'],0)

    def test_invalid_binding_cannot_generate(self):
        valid=binding_v5(fixture_spec())
        for update in ({'physical_io':True},{'initial_positions':[.1]},{'max_acceleration_rad_s2':False},{'max_velocity_rad_s':float('inf')},{'joint_names':['a','a']},{'baudrate':115200}):
            with self.subTest(update=update),self.assertRaises(ValueError): validate_binding_v5(dict(valid,**update))

    def test_generation_immutable_core_and_unknown_hardware(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'runs',prefix='firmware-v5-test-') as directory:
            output=Path(directory);result=generate_firmware_v5(output,fixture_spec())
            self.assertFalse(result['binding']['physical_io'])
            self.assertEqual((output/'esp32'/'protocol_core_v5.hpp').read_bytes(),(output/'esp32'/'ae_firmware_v5'/'protocol_core_v5.hpp').read_bytes())
            with self.assertRaises(ValueError): generate_firmware_v5(output,fixture_spec(),'unsafe generated core')


@unittest.skipUnless(os.name=='posix','requires WSL native Linux g++/PTY')
class NativeVectorTests(unittest.TestCase):
    def test_real_native_pty_faults(self):
        from worker.execute import Supervisor
        with tempfile.TemporaryDirectory(dir=ROOT/'runs',prefix='firmware-v5-test-') as directory:
            output=Path(directory);spec=fixture_spec();generate_firmware_v5(output,spec);supervisor=Supervisor(output)
            try:
                compile_host_v5(output,supervisor,dict(os.environ))
                checks=verify_protocol_v5(output,spec,supervisor,dict(os.environ))
                self.assertTrue(all(c['passed'] for c in checks),json.dumps(checks,indent=2))
            finally: supervisor.close()

    def test_deterministic_acceleration_limits_wrap_time_and_atomicity(self):
        from worker.execute import Supervisor
        with tempfile.TemporaryDirectory(dir=ROOT/'runs',prefix='firmware-v5-test-') as directory:
            output=Path(directory);spec=fixture_spec();generate_firmware_v5(output,spec);supervisor=Supervisor(output)
            binding=binding_v5(spec);session='1234567890abcdef'*2
            def command(kind,seq,stamp,pos): return wire_frame({'kind':kind,'session':session,'seq':seq,'time':stamp,'positions':pos})+'\n'
            strings={
                'hello':wire_frame(hello_frame(binding,session))+'\n',
                'measure':command('measurement',0,1,[.1,.2]),
                'measure20':command('measurement',1,1.02,[.1,.2]),
                'repeat_stamp':command('measurement',2,1.02,[.1,.2]),
                'measure40':command('measurement',3,1.04,[.1,.2]),
                'target':command('command',0,1,[1.,.9]),
                'bad':command('command',1,2,[.9,2.]),
                'backtime':command('command',1,.5,[.2,.3]),
                'future':command('command',1,10,[.2,.3]),
                'freshmeasure':command('measurement',4,2,[.1,.2]),
                'freshcommand':command('command',1,2,[.2,.3]),
                'recoverymeasure':command('measurement',5,2.02,[.1,.2]),
            }
            source=output/'esp32'/'deterministic_test.cpp'
            literals='\n'.join('static const char* '+name+'='+json.dumps(text)+';' for name,text in strings.items())
            source.write_text('''#include "protocol_core_v5.hpp"
#include "model_binding_v5.hpp"
static void emit(void*,const char*) {}
static void send(ae5::ProtocolCore& core,const char* text,uint32_t now) {for(const char* p=text;*p;++p) core.feed(*p,now);}
'''+literals+'''
int main() {
  const uint32_t start=0xfffffff0u;
  ae5::ProtocolCore core(ae5_model_binding,emit,nullptr);
  core.tick(start);send(core,hello,start);send(core,measure,start);send(core,target,start);
  core.tick(start+1u);
  send(core,measure20,start+20u);
  core.tick(start+20u);
  if(fabs(core.applied(0)-.02)>1e-9 || fabs(core.applied(1)-.02)>1e-9) return 1;
  send(core,bad,start+20u);send(core,backtime,start+20u);send(core,future,start+20u);
  if(core.last_sequence()!=0) return 2;
  send(core,repeat_stamp,start+30u);core.tick(start+30u);
  if(fabs(core.applied(0)-.02)>1e-9) return 7;
  send(core,measure40,start+40u);
  core.tick(start+40u);
  if(fabs(core.applied(0)-.04)>1e-9 || fabs(core.applied(1)-.04)>1e-9) return 3;
  // uint32 millis wrap does not defeat independent watchdogs.
  core.tick(start+601u);
  if(core.applied(0)!=0 || core.applied(1)!=0) return 4;
  send(core,freshmeasure,start+620u);core.tick(start+640u);
  if(core.applied(0)!=0 || core.applied(1)!=0) return 5;
  send(core,freshcommand,start+640u);send(core,recoverymeasure,start+660u);core.tick(start+660u);
  if(fabs(core.applied(0)-.02)>1e-9 || fabs(core.applied(1)-.02)>1e-9 || core.last_sequence()!=1) return 6;
  return 0;
}
''',encoding='utf-8')
            environment=dict(os.environ)
            try:
                binary=source.with_suffix('')
                result=supervisor.run(['g++','-std=c++17','-O2','-Wall','-Wextra','-Werror',str(source),'-o',str(binary)],output/'deterministic-build.log',environment,timeout=45)
                self.assertEqual(result,0,(output/'deterministic-build.log').read_text())
                result=supervisor.run([str(binary)],output/'deterministic-test.log',environment,timeout=5)
                self.assertEqual(result,0,(output/'deterministic-test.log').read_text())
            finally: supervisor.close()


def build_preflight():
    """Durable compiler proof using actual Sophicore geometry, not motion acceptance."""
    from server.structures import get_structure
    from worker.execute import Supervisor
    from worker.firmware_v5 import compile_firmware_v5
    structure=get_structure(ROOT,'sophicore-reference')
    names=['arm_r_shoulder_lift','arm_r_shoulder_swing','arm_r_elbow_bend','arm_r_wrist_rotation']
    model=build_motion_model(structure,names)
    joints={j['name']:j for j in model['joints']}
    initial=[joints[name]['initial_position'] for name in names]
    target=[min(joints[n]['limits']['upper'],max(joints[n]['limits']['lower'],v+.1)) for n,v in zip(names,initial)]
    plan={'schema_version':1,'joint_names':names,'waypoints':[{'positions':target,'time_from_start_s':2.,'stage_id':'compiler_test','cycle_index':0}], 'tolerance_rad':.035,'max_velocity_rad_s':.5,'max_acceleration_rad_s2':1.,'timeout_s':8.}
    spec={'pipeline_version':5,'task_type':'joint_sequence','execution_model':model,'motion_program':compile_motion_program(plan,model),'hardware':{'physical_io':False}}
    output=ROOT/'runs'/'v5-firmware-preflight';output.mkdir(parents=True,exist_ok=True)
    (output/'spec.json').write_text(json.dumps(spec,ensure_ascii=False,indent=2),encoding='utf-8')
    generate_firmware_v5(output,spec);supervisor=Supervisor(output)
    try:
        native=compile_host_v5(output,supervisor,dict(os.environ));checks=verify_protocol_v5(output,spec,supervisor,dict(os.environ))
        print(json.dumps({'native':native,'checks':checks}),flush=True)
        if not all(c['passed'] for c in checks): raise RuntimeError('native vector fault proof failed')
        result=compile_firmware_v5(spec,output,supervisor,dict(os.environ))
        print(json.dumps(result),flush=True)
        if not result['passed']: raise RuntimeError('ESP32/S3 cross compilation failed')
    finally: supervisor.close()


def repeat_existing_protocol():
    """Use the already-built actual six-axis native host, with no ROS/rebuild."""
    from worker.execute import Supervisor
    import shutil
    base=ROOT/'runs'/'v5-runtime-preflight'
    spec_path=next(path for path in (base/'spec-used.json',base/'spec.json') if path.is_file())
    spec=json.loads(spec_path.read_text(encoding='utf-8'));supervisor=Supervisor(base)
    try:
        for index in range(3):
            checks=verify_protocol_v5(base,spec,supervisor,dict(os.environ))
            shutil.copy2(base/'protocol-v5-faults-trace.json',base/f'protocol-v5-event-wait-{index+1}-trace.json')
            print(json.dumps({'repeat':index+1,'passed':all(c['passed'] for c in checks),'checks':checks}),flush=True)
            if not all(c['passed'] for c in checks): raise RuntimeError('existing native protocol proof failed')
    finally: supervisor.close()


if __name__=='__main__':
    import sys
    if sys.argv[1:]==['--build-evidence']: build_preflight()
    elif sys.argv[1:]==['--repeat-existing-protocol']: repeat_existing_protocol()
    else: unittest.main()
