"""Mandatory V3 build/check groups; order follows the approved DAG snapshot."""
import json
import hashlib
import shutil
from pathlib import Path
from .contract import project_contract
from .firmware import validate_hardware,probe_firmware_toolchain,compile_firmware,compile_host_core,verify_device_logic
from .policy import validate_parameters,load_compute
from .robot_model import validate_execution_model
from .templates_v3 import generate_v3
from .verification import check,logic_checks
from .verification_v3 import ModelVerifier
from .protocol_verification_v3 import verify_core_faults_v3

DEFAULT_ORDER=['ros_build','esp_build','communication','simulation']
def classify_v3_checks(checks,cases=(),error=None):
    import subprocess
    failed=[item for item in checks if not item['passed']]
    if any('device_logic' in item['name'] for item in failed): return 'firmware_code'
    if isinstance(error,(TimeoutError,OSError,subprocess.SubprocessError)) or any(item['name'].endswith(('_state_frequency','_gazebo_backend_loaded')) for item in failed): return 'environment'
    # Only actual trusted task errors justify algorithm repair. Transport faults
    # and absence of confirmations cannot be repaired by changing compute().
    if any(event.get('event')=='task_error' for case in cases for event in case.get('events',[])): return 'algorithm'
    if any(item['name'].startswith('protocol') or item['name'].endswith(('_message_contract','_firmware_applied','_same_model_feedback','_firmware_drives_gazebo')) or 'identity' in item['name'] or 'bridge' in item['name'] for item in failed): return 'communication'
    if error is not None: return 'configuration' if isinstance(error,ValueError) else 'environment'
    return 'algorithm' if failed else None

def execution_order(spec):
    workflow=spec.get('workflow')
    if not isinstance(workflow,dict): raise ValueError('V3 requires approved workflow snapshot')
    content={key:value for key,value in workflow.items() if key!='hash'}
    digest=hashlib.sha256(json.dumps(content,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()
    if workflow.get('hash')!=digest: raise ValueError('workflow snapshot hash mismatch')
    order=[item for item in workflow.get('execution_order',[]) if item in DEFAULT_ORDER]
    if len(order)!=4 or set(order)!=set(DEFAULT_ORDER): raise ValueError('workflow cannot omit or duplicate mandatory build/check groups')
    if max(order.index('ros_build'),order.index('esp_build'))>min(order.index('communication'),order.index('simulation')): raise ValueError('both builds must precede communication and simulation')
    return order

def execute_v3(output,spec,code,firmware_code,supervisor,environment,emit,overlay_environment,result,deploy=False):
    result['failure_scope']='configuration'
    model=validate_execution_model(spec['execution_model']) if spec['task_type']=='joint_position' else {'model_id':'software_scalar_channel','selected_joint':'scalar_channel','joints':[],'held_positions':{},'assumptions':{'sensor':'software scalar pattern; no structure joint drive'}}
    if not validate_hardware(spec.get('hardware',{}),spec['task_type']): raise ValueError('V3 requires explicit supported ESP32 board')
    if spec['hardware'].get('physical_io',False) is not False: raise ValueError('physical IO must remain false')
    spec['parameters']=validate_parameters(spec.get('parameters',{}),model=model if spec['task_type']=='joint_position' else None)
    order=execution_order(spec);identity=project_contract(spec)['communication']['identity']
    model['model_sha256']=identity['model_sha256']
    declared=spec.get('communication',{}).get('identity')
    if declared is not None and declared!=identity: raise ValueError('approved communication identity differs from model contract')
    result['failure_scope']='algorithm'
    compute=load_compute(code)
    result['checks'].append(check('bounded_ast_policy',True,'trusted pure numeric Python policy'))
    result['checks'].extend(logic_checks(compute,spec['task_type'],spec['parameters']))
    from .device_logic import validate_device_logic
    result['failure_scope']='firmware_code'
    validate_device_logic(firmware_code)
    result['checks'].append(check('bounded_device_logic_policy',True,'restricted pure C++ numeric limit function; no IO/tool/system access'))
    result['failure_scope']='configuration'
    package,binding=generate_v3(output,spec,code,firmware_code)
    result['failure_scope']=None
    (output/'spec-used.json').write_text(json.dumps(spec,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf-8')
    result.update(pipeline_version=3,identity=identity,execution_order=[],execution_model={'model_id':model['model_id'],'model_sha256':model['model_sha256'],'selected_joint':model['selected_joint'],'joint_count':len(model['joints']),'held_positions':model['held_positions'],'assumptions':model['assumptions']},workflow={'hash':spec['workflow'].get('hash'),'execution_order':order,'executed_order':[]},physical_io=False)
    result['engine']='gazebo_fortress_dart_selected_model_ros_pty_shared_core' if spec['task_type']=='joint_position' else 'ros2_pty_shared_core_scalar_pattern'
    stage='deploying' if deploy else 'building';verifier=None
    try:
        for group in order:
            supervisor.ensure_active();result['workflow']['executed_order'].append(group)
            result['execution_order'].append(group)
            if group=='ros_build':
                emit(stage,'按审批节点顺序执行 ros_build：真实 colcon 构建同模型 ROS 工程')
                exit_code=supervisor.run(['colcon','build','--merge-install','--executor','sequential','--event-handlers','console_direct+'],output/'build.log',environment,cwd=output/'ros_ws',timeout=180)
                result['checks'].append(check('colcon_build',exit_code==0,f'exit={exit_code}; build.log'))
                if exit_code: result['failure_scope']='environment';raise RuntimeError('V3 colcon build failed')
                environment=overlay_environment(output/'ros_ws',environment)
            elif group=='esp_build':
                if not probe_firmware_toolchain()['available']: result['failure_scope']='environment';raise RuntimeError('fixed firmware toolchain unavailable')
                emit(stage,'按审批节点顺序执行 esp_build：真实 Arduino CLI 编译 '+spec['hardware']['board'])
                result['firmware']=compile_firmware(spec,output,supervisor,environment)
                result['checks'].append(check('firmware_cross_compile',result['firmware']['passed'],'ELF/BIN from fixed ESP32 core 3.3.12; firmware-build.json'))
                if not result['firmware']['passed']: result['failure_scope']=result['firmware'].get('failure_scope','firmware');raise RuntimeError('V3 ESP firmware compile failed; see real diagnostic log')
                result['esp32_status']='compiled_not_flashed_not_executed'
                result['failure_scope']='firmware'
                try: result['native_protocol_build']=compile_host_core(output,supervisor,environment)
                except RuntimeError:
                    log=(output/'protocol-host-build.log').read_text(errors='replace')
                    if any('device_logic.' in line and 'error:' in line for line in log.splitlines()): result['failure_scope']='firmware_code'
                    raise
                result['failure_scope']=None
                shutil.copyfile(output/'esp32'/'host_protocol',package/'config'/'host_protocol')
                (package/'config'/'host_protocol').chmod(0o755)
                # Build can have happened first; export binary into installed share too.
                installed=output/'ros_ws'/'install'/'share'/'ae_generated'/'config'
                if installed.is_dir():
                    shutil.copyfile(output/'esp32'/'host_protocol',installed/'host_protocol');(installed/'host_protocol').chmod(0o755)
            else:
                stage='deploying' if deploy else 'testing'
                if verifier is None: verifier=ModelVerifier(supervisor,environment,output,spec,binding)
                if group=='communication':
                    emit(stage,'按审批节点顺序执行 communication：'+('同模型 Gazebo ↔ ROS ↔ PTY ↔ 固件核心' if spec['task_type']=='joint_position' else 'ROS ↔ PTY ↔ 固件标量协议核心')+'双向闭环、断流与独立协议注入')
                    numeric=verify_device_logic(output,supervisor,environment)
                    result['device_logic_test']=numeric
                    result['checks'].append(check('device_logic_independent_numerical',numeric['passed'],numeric['detail']))
                    if not numeric['passed']: result['failure_scope']='firmware_code';raise RuntimeError('generated C++ numerical function failed independent preservation/clamp cases')
                    result['communication_test']=verifier.communication_cases()
                    protocol_checks=verify_core_faults_v3(output,spec,binding,supervisor,environment)
                    verifier.checks.extend(protocol_checks);result['communication_test']['checks'].extend(protocol_checks)
                    result['communication_test']['passed']=all(c['passed'] for c in result['communication_test']['checks'])
                elif group=='simulation':
                    emit(stage,'按审批节点顺序执行 simulation：所选真实结构关节目标/替代目标/初始姿态独立验收' if spec['task_type']=='joint_position' else '按审批节点顺序执行 simulation：标量阈值多场景独立验收，明确不驱动结构关节')
                    verifier.simulation_cases()
        result['checks'].extend(verifier.checks);result['series']=verifier.series
        result['ros_verified']=verifier.received_count>0 and all(c['passed'] for c in verifier.checks if c['name'].endswith('_message_contract'))
        physics=[c for c in verifier.checks if c['name'].startswith('model_') and c['name'].endswith(('_same_model_feedback','_gazebo_backend_loaded','_firmware_drives_gazebo'))]
        verified=spec['task_type']=='joint_position' and bool(physics) and all(c['passed'] for c in physics)
        result['physics_verified']=verified
        result['physics_simulation_verified']=verified
        result['metrics']={'samples':len(verifier.series),'cases':verifier.cases,'ros_domain_id':78,'localhost_only':True,'physics_simulation_verified':verified,'gazebo_available':spec['task_type']=='joint_position','validation_owner':'trusted worker/verification_v3.py','deployment_scope':'isolated local same-model re-run' if deploy else 'local same-model verification'}
        result['checks'].append(check('workflow_execution_order',result['workflow']['executed_order']==order,'all mandatory groups executed in approved relative order'))
        result['execution_order'].append('report')
        result['checks'].append(check('model_protocol_identity',result['firmware']['identity']==identity and result['communication_test']['identity']==identity,'firmware / ROS / communication / execution model use same approved identity'))
        result['passed']=all(c['passed'] for c in result['checks'])
        failed=[c for c in result['checks'] if not c['passed']]
        result['failure_scope']=classify_v3_checks(result['checks'],verifier.cases)
        emit(stage,'V3 同模型独立验收通过' if result['passed'] else 'V3 独立验收失败；保留真实场景与协议证据','info' if result['passed'] else 'error')
    except Exception as error:
        if result.get('failure_scope') is None: result['failure_scope']=classify_v3_checks(result['checks']+(verifier.checks if verifier else []),verifier.cases if verifier else (),error)
        raise
    finally:
        if verifier:
            present={c['name'] for c in result['checks']};result['checks'].extend(c for c in verifier.checks if c['name'] not in present)
            if not result['series']: result['series']=verifier.series
            result['metrics'].setdefault('cases',verifier.cases);verifier.close()
