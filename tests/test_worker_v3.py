"""Independent fast V3 model, contract and workflow acceptance."""
import copy
import json
import math
import os
from pathlib import Path
import tempfile
import unittest
from worker.binding import parse_bound_frame,frame,SerialLines
from worker.contract import project_contract
from worker.execute_v3 import execution_order,classify_v3_checks
from worker.physics_v3 import generate_sdf,source_poses,axis_rotation,multiply,transform,pose
from worker.policy import validate_parameters
from worker.robot_model import build_execution_model,digest
from worker.templates_v3 import generate_v3
from worker.device_logic import DEFAULT_DEVICE_CODE
from server.workflow import default_workflow
import xml.etree.ElementTree as ET
ROOT=Path(__file__).resolve().parents[1]

def model():
    structure={'id':'offset-fixture','format':'urdf','links':[{'name':'base','visuals':[]},{'name':'arm','visuals':[{'type':'box','size':[.2,.04,.04],'xyz':[.1,0,0],'rpy':[0,0,0]}]},{'name':'hand','visuals':[]}],
      'joints':[{'name':'shoulder','type':'revolute','parent':'base','child':'arm','origin':{'xyz':[.1,.2,.3],'rpy':[0,0,.4]},'axis':[0,-1,0],'lower':-math.pi,'upper':math.pi,'initial_position':.6}, {'name':'finger','type':'revolute','parent':'arm','child':'hand','xyz':[.2,0,0],'rpy':[0,0,0],'axis':[0,0,1],'lower':0,'upper':1,'initial_position':.3}]}
    return build_execution_model(structure,'shoulder')

class WorkerV3Tests(unittest.TestCase):
    def test_observer_scans_are_bounded_without_per_callback_io(self):
        from worker.verification_v3 import ObserverSchedule
        schedule=ObserverSchedule(0);self.assertTrue(schedule.due(0));schedule.record(0)
        for tick in range(1,50):
            now=tick/1000;self.assertFalse(schedule.due(now));self.assertLessEqual(schedule.timeout(now),.01);self.assertLessEqual(now+schedule.timeout(now),.05)
        self.assertTrue(schedule.due(.05));schedule.record(.05);self.assertAlmostEqual(schedule.max_gap,.05);self.assertEqual(schedule.checks,2)
        self.assertEqual(schedule.timeout(.1),0)
    def spec(self): return {'pipeline_version':3,'task_type':'joint_position','parameters':validate_parameters({}),'execution_model':model(),'workflow':default_workflow(),'hardware':{'board':'esp32','transport':'serial_jsonl','physical_io':False}}
    def test_dynamic_model_target_limits(self):
        self.assertEqual(validate_parameters({'target':2.5},model())['target'],2.5)
        for target in (3.2,-3.2,True,float('inf')):
            with self.assertRaises(ValueError): validate_parameters({'target':target},model())
        with self.assertRaises(ValueError): validate_parameters({'target':2.5})
    def test_contract_identity_depends_on_selection_model(self):
        spec=self.spec();contract=project_contract(spec);identity=contract['communication']['identity']
        self.assertEqual(identity['joint_name'],'shoulder');self.assertEqual(len(identity['protocol_sha256']),64)
        self.assertEqual(contract['simulation']['initial_joint_position_rad'],.6)
        self.assertEqual(project_contract()['communication']['schema_version'],1)
    def test_strict_frame_identity_duplicate_trailing_and_range(self):
        binding={'identity':project_contract(self.spec())['communication']['identity']};raw=frame(binding,'command',1,0,.2)
        self.assertEqual(parse_bound_frame(raw,binding,'command')['value'],.2)
        invalid=[raw+'x',raw+raw,raw.replace('"seq":1','"seq":1,"seq":2'),raw.replace('shoulder','other'),raw.replace('"value":0.2','"value":true'),raw.replace('"seq":1','"seq":1.0')]
        for bad in invalid:
            with self.subTest(bad=bad),self.assertRaises(ValueError): parse_bound_frame(bad,binding,'command')
    def test_bad_serial_line_does_not_poison_following_frame(self):
        binding={'identity':project_contract(self.spec())['communication']['identity']};lines=SerialLines(binding)
        valid=(frame(binding,'state',1,0,.2)+'\n').encode()
        for bad in (b'broken\n',b'\xff\n',b'x'*600+b'\n',b'\0\n'):
            packets,errors=lines.feed(bad+valid)
            self.assertEqual(len(errors),1);self.assertEqual(len(packets),1);self.assertEqual(packets[0][1]['seq'],1)
        first,errors=lines.feed(valid[:25]);self.assertFalse(first);self.assertFalse(errors)
        packets,errors=lines.feed(valid[25:]);self.assertEqual(len(packets),1);self.assertFalse(errors)
    def test_workflow_order_and_non_bypass(self):
        spec=self.spec();self.assertEqual(execution_order(spec),['ros_build','esp_build','communication','simulation'])
        workflow=spec['workflow'];workflow['execution_order']=['esp_build','ros_build','simulation','communication'];workflow['hash']=digest({k:v for k,v in workflow.items() if k!='hash'})
        self.assertEqual(execution_order(spec),['esp_build','ros_build','simulation','communication'])
        for order in (['ros_build','communication','esp_build','simulation'],['ros_build','esp_build','simulation'],['ros_build','esp_build','simulation','simulation']):
            workflow['execution_order']=order;workflow['hash']=digest({k:v for k,v in workflow.items() if k!='hash'})
            with self.assertRaises(ValueError): execution_order(spec)
    def test_transport_failure_does_not_trigger_algorithm_repair(self):
        bad=lambda name:{'name':name,'passed':False}
        for name in ('primary_message_contract','protocol_v3_identity_and_malformed_rejected','model_protocol_identity','primary_firmware_applied','primary_firmware_drives_gazebo'):
            self.assertEqual(classify_v3_checks([bad(name)]),'communication')
        self.assertEqual(classify_v3_checks([bad('model_primary_position_tolerance')]),'algorithm')
        self.assertEqual(classify_v3_checks([bad('primary_message_contract')],[{'events':[{'event':'task_error'}]}]),'algorithm')
        self.assertEqual(classify_v3_checks([bad('device_logic_independent_numerical'),bad('primary_message_contract')]),'firmware_code')
        self.assertEqual(classify_v3_checks([bad('primary_state_frequency')]),'environment')
        self.assertEqual(classify_v3_checks([],error=TimeoutError('discovery')),'environment')
    def test_sdf_full_tree_and_offset(self):
        m=model();world=ET.fromstring(generate_sdf(m,'/ae_fixture',.8));joints={j.attrib['name']:j for j in world.findall('.//model/joint')}
        self.assertEqual(joints['shoulder'].attrib['type'],'revolute');self.assertEqual(joints['finger'].attrib['type'],'fixed')
        self.assertAlmostEqual(float(joints['shoulder'].find('axis/limit/lower').text),-math.pi-.6)
        self.assertEqual(joints['shoulder'].find('axis/xyz').text,'0 -1 0');self.assertNotIn('hinge',ET.tostring(world,encoding='unicode'))
        self.assertEqual(len(world.findall('.//model/link')),3);self.assertFalse(world.findall('.//collision'))
    def test_imported_joint_name_cannot_collide_with_anchor(self):
        m=model();m['joints'][0]['name']='ae_world_fixed';m['selected_joint']='ae_world_fixed';m['model_sha256']=digest({k:v for k,v in m.items() if k!='model_sha256'})
        world=ET.fromstring(generate_sdf(m,'/ae_reserved',.8));names=[j.get('name') for j in world.findall('.//model/joint')]
        self.assertEqual(len(names),len(set(names)))
        self.assertEqual([j.get('name') for j in world.findall('.//model/joint') if j.get('type')=='revolute'],['ae_world_fixed'])
    def test_pose_is_origin_times_signed_axis_initial(self):
        m=model();poses,_=source_poses(m);expected=multiply(transform([.1,.2,.3],[0,0,.4]),axis_rotation([0,-1,0],.6))
        for actual,wanted in zip(pose(poses['arm']),pose(expected)): self.assertAlmostEqual(actual,wanted)
    def test_export_binds_shared_firmware_and_ros(self):
        with tempfile.TemporaryDirectory(prefix='v3-fast-',dir=ROOT/'runs') as directory:
            path=Path(directory);spec=self.spec();package,binding=generate_v3(path,spec,'def compute_command(value,target,threshold,max_velocity):\n    return max(-max_velocity,min(max_velocity,target-value))\n',DEFAULT_DEVICE_CODE)
            for identity in binding['identity'].values(): self.assertIn(identity,(path/'esp32'/'ae_firmware'/'model_binding.hpp').read_text())
            self.assertEqual((path/'esp32'/'protocol_core.hpp').read_bytes(),(path/'esp32'/'ae_firmware'/'protocol_core.hpp').read_bytes())
            self.assertIn('Never integrate joint position',(path/'esp32'/'protocol_core.hpp').read_text())
            self.assertIn('bench.launch.py',[p.name for p in (package/'launch').glob('*')])
            self.assertIn('binding.json',(package/'setup.py').read_text())
    def test_sensor_contract_has_no_joint_physics_claim(self):
        spec=self.spec();spec['task_type']='sensor_threshold';contract=project_contract(spec)
        self.assertIn('scalar pattern',contract['communication']['measurement_source'])
        self.assertNotIn('mandatory',contract['simulation']['physics_engine'])
    def test_sensor_without_joint_model_has_stable_identity(self):
        spec=self.spec();spec.update(task_type='sensor_threshold',execution_model=None,structure={'id':'sensor_mount','links':[],'joints':[]})
        identity=project_contract(spec)['communication']['identity']
        self.assertEqual(identity['joint_name'],'scalar_channel')
        self.assertEqual(identity,project_contract(copy.deepcopy(spec))['communication']['identity'])
        spec['structure']['id']='different_mount'
        self.assertNotEqual(identity['model_sha256'],project_contract(spec)['communication']['identity']['model_sha256'])
    def test_all_18_sophicore_axes_generate_selected_sdf(self):
        from worker.firmware import ROOT
        from worker.robot_model import sophicore_structure,build_sophicore_model
        config=json.loads((ROOT/'knowledge'/'sophicore-default-configuration.json').read_text())
        hashes=set()
        for joint in sophicore_structure(config)['joints']:
            with self.subTest(joint=joint['name']):
                m=build_sophicore_model(config,joint['name']);hashes.add(m['model_sha256'])
                sdf=ET.fromstring(generate_sdf(m,'/ae_all_axes',.8));joints=sdf.findall('.//model/joint')
                moving=[j for j in joints if j.get('type')=='revolute']
                self.assertEqual([j.get('name') for j in moving],[joint['name']])
                self.assertEqual(len(sdf.findall('.//model/link')),19)
                self.assertEqual(len([j for j in joints if j.get('type')=='fixed']),18)
                self.assertAlmostEqual(float(moving[0].find('axis/limit/lower').text),joint['limits']['lower']-joint['initial_position'])
        self.assertEqual(len(hashes),18)

@unittest.skipUnless(os.name=='posix','native shared protocol needs WSL C++/PTY')
class NativeV3Tests(unittest.TestCase):
    def test_device_logic_independent_harness_detects_wrong_output(self):
        from worker.firmware import ROOT,verify_device_logic
        from worker.execute import Supervisor
        with tempfile.TemporaryDirectory(prefix='v3-device-',dir=ROOT/'runs') as directory:
            path=Path(directory);(path/'esp32').mkdir();header=path/'esp32'/'device_logic.hpp';supervisor=Supervisor(path)
            try:
                header.write_text(DEFAULT_DEVICE_CODE,encoding='utf-8')
                result=verify_device_logic(path,supervisor,dict(os.environ));self.assertTrue(result['passed']);self.assertEqual(result['cases'],28)
                header.write_text('double limit_command(double value,double max_velocity) {return value*0+max_velocity*0;}\n',encoding='utf-8')
                self.assertFalse(verify_device_logic(path,supervisor,dict(os.environ))['passed'])
            finally: supervisor.close()
            self.assertTrue(supervisor.all_exited())
    def test_shared_v3_core_both_task_protocols(self):
        from worker.firmware import ROOT,compile_host_core
        from worker.execute import Supervisor
        from worker.protocol_verification_v3 import verify_core_faults_v3
        for task in ('joint_position','sensor_threshold'):
            with self.subTest(task=task),tempfile.TemporaryDirectory(prefix='v3-native-',dir=ROOT/'runs') as directory:
                spec=WorkerV3Tests().spec();spec['task_type']=task
                if task=='sensor_threshold': spec['execution_model']=None
                path=Path(directory);package,binding=generate_v3(path,spec,'def compute_command(value,target,threshold,max_velocity):\n    return 0.0\n',DEFAULT_DEVICE_CODE)
                supervisor=Supervisor(path)
                try:
                    compile_host_core(path,supervisor,dict(os.environ))
                    checks=verify_core_faults_v3(path,spec,binding,supervisor,dict(os.environ))
                    self.assertTrue(all(item['passed'] for item in checks),checks)
                finally: supervisor.close()
                self.assertTrue(supervisor.all_exited())

if __name__=='__main__': unittest.main()
