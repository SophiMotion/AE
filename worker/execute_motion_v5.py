#!/usr/bin/env python3
"""Dedicated frozen-program worker. Only reviewed data, no arbitrary execution."""
import argparse
import ast
import json
import os
from pathlib import Path
import shutil
import sys
import traceback

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from worker.execute import Supervisor,Cancelled,emit,overlay_environment
from worker.execute_v3 import execution_order
from worker.policy import safe_output
from worker.motion_spec_v5 import motion_contract
from worker.templates_motion_v5 import generate_motion_v5
from worker.build_motion_v5 import build_ros_v5
from worker.firmware_v5 import compile_firmware_v5,compile_host_v5,verify_protocol_v5
from worker.verification_motion_v5 import MotionVerifier,check


def validate_program_source(code, program):
    tree=ast.parse(code)
    body=[n for n in tree.body if not (isinstance(n,ast.Expr) and isinstance(n.value,ast.Constant) and isinstance(n.value.value,str))]
    if len(body)!=1 or not isinstance(body[0],ast.Assign) or len(body[0].targets)!=1 or not isinstance(body[0].targets[0],ast.Name) or body[0].targets[0].id!='MOTION_PROGRAM':
        raise ValueError('V5 algorithm.py must only define the approved MOTION_PROGRAM literal')
    if ast.literal_eval(body[0].value)!=program:raise ValueError('Generated program differs from approved motion')


def execute(output,spec,code,firmware_code,supervisor,environment,result,deploy=False):
    contract=motion_contract(spec);identity=contract['communication']['identity'];program=spec['motion_program'];model=spec['execution_model']
    if spec.get('pipeline_version')!=5 or spec.get('task_type')!='joint_sequence' or spec['hardware'].get('physical_io') is not False:
        raise ValueError('V5 requires reviewed local multi-joint virtual-device scope')
    validate_program_source(code,program)
    order=execution_order(spec)
    package,binding=generate_motion_v5(output,spec,firmware_code)
    result.update(pipeline_version=5,engine='ros2_jtc_gazebo_fortress_multi_joint_shared_core',
        identity=identity,workflow=spec['workflow'],execution_order=[],motion_program=program,joint_names=program['joint_names'],
        execution_model={'model_id':model['model_id'],'model_sha256':model['model_sha256'],'active_joint_names':model['active_joint_names'],
            'physics_profile':model['physics_profile'],'assumptions':model['assumptions'],'hardware_verified':False},
        scope='Gazebo fixed-base zero-gravity model + same native C++ firmware core via owned PTY; no board execution or physical IO')
    result['checks'].append(check('frozen_motion_source',True,'AST constant equals reviewed immutable program; no generated arbitrary code executed'))
    verifier=None
    try:
        for stage in order:
            result['failure_scope']='environment';emit(stage,{'ros_build':'正在构建真实 ROS 多关节控制器工程','esp_build':'正在分别编译 ESP32 和 ESP32-S3 固件','communication':'正在测试多关节通信及故障恢复','simulation':'正在本机 Gazebo 中执行并检查完整动作'}[stage])
            if stage=='ros_build':
                result['native_core_build']=compile_host_v5(output,supervisor,environment)
                shutil.copy2(output/'esp32'/'host_protocol_v5',package/'config'/'host_protocol_v5')
                code=build_ros_v5(output,supervisor,environment)
                result['checks'].append(check('ros_build',code==0,'actual colcon build exit code '+str(code)))
                if code:raise RuntimeError('ROS build failed; inspect ros-build.log')
                environment=overlay_environment(output/'ros_ws',environment)
            elif stage=='esp_build':
                firmware=compile_firmware_v5(spec,output,supervisor,environment)
                selected=next((b for b in firmware['boards'] if b['board']==spec['hardware']['board']),{})
                firmware.update(board=selected.get('board'),fqbn=selected.get('fqbn'),identity=identity)
                result['firmware']=firmware
                result['checks'].append(check('esp32_and_s3_builds',firmware['passed'],'both actual bin/elf artifacts and exit codes recorded'))
                if not firmware['passed']:raise RuntimeError('ESP firmware build failed')
            elif stage=='communication':
                protocol_checks=verify_protocol_v5(output,spec,supervisor,environment)
                communication={'passed':bool(protocol_checks) and all(c['passed'] for c in protocol_checks),'checks':protocol_checks,'identity':identity,
                    'scope':'actual owned PTY running same native C++ core; no physical serial or ESP chip execution'}
                result['communication_test']=communication
                result['checks'].extend(protocol_checks)
                if not communication['passed']:raise RuntimeError('same-source protocol acceptance failed')
            else:
                verifier=MotionVerifier(supervisor,environment,output,spec,binding)
                result['metrics']['cases']=[]
                for name,fault in [('motion_1',None),('motion_2',None),('motion_3',None),('command_loss','command_loss'),('measurement_loss','measurement_loss'),('cancel','cancel')]:
                    emit('simulation','正在验证：'+name)
                    checks,metrics,series=verifier.case(name,fault)
                    result['checks'].extend(checks);result['metrics']['cases'].append(metrics)
                    if name=='motion_1':result['series']=series
                    if not all(c['passed'] for c in checks):
                        result['failure_scope']='simulation';raise RuntimeError('motion acceptance failed: '+', '.join(c['name'] for c in checks if not c['passed']))
                result['ros_verified']=True;result['physics_simulation_verified']=True
            result['execution_order'].append(stage)
        result['execution_order'].append('report');result['failure_scope']=None
    finally:
        if verifier:verifier.close()


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--spec',type=Path,required=True);parser.add_argument('--code',type=Path,required=True)
    parser.add_argument('--firmware-code',type=Path,required=True);parser.add_argument('--output',type=Path,required=True);parser.add_argument('--deploy',action='store_true')
    args=parser.parse_args();output=safe_output(args.output,ROOT,args.deploy);output.mkdir(parents=True,exist_ok=True)
    for path in (args.spec,args.code,args.firmware_code):
        if not path.resolve().is_relative_to(ROOT/'runs'):raise ValueError('worker inputs must belong to project runs')
    supervisor=Supervisor(output)
    result={'pipeline_version':5,'passed':False,'ros_verified':False,'physics_simulation_verified':False,'checks':[],'series':[],
        'metrics':{},'physical_verified':False,'esp32_execution_verified':False,'flashed':False}
    try:
        spec=json.loads(args.spec.read_text(encoding='utf-8'))
        environment=dict(os.environ,ROS_DOMAIN_ID='78',ROS_LOCALHOST_ONLY='1',PYTHONUNBUFFERED='1',ROS_LOG_DIR=str(output/'ros_logs'))
        execute(output,spec,args.code.read_text(encoding='utf-8'),args.firmware_code.read_text(encoding='utf-8'),supervisor,environment,result,args.deploy)
    except Exception as error:
        result['error']=str(error);result['cancelled']=isinstance(error,Cancelled)
        result['failure_scope']=result.get('failure_scope') or ('cancelled' if isinstance(error,Cancelled) else 'configuration')
        (output/'error.log').write_text(traceback.format_exc(),encoding='utf-8');emit('failed',str(error),'error')
    finally:
        supervisor.close();result['metrics']['cleanup']={'all_exited':supervisor.all_exited()}
        result['checks'].append(check('owned_process_cleanup',supervisor.all_exited(),'only owned processes and descendant identities stopped'))
        result['passed']=not result.get('error') and result['ros_verified'] and result['physics_simulation_verified'] and bool(result['checks']) and all(c['passed'] for c in result['checks'])
        (output/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf-8')
    return 0 if result['passed'] else 1


if __name__=='__main__':sys.exit(main())
