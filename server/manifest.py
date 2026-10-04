"""Project manifest and deterministic preflight, inspired by modular hardware workflows.

This is independently implemented for the ROS/C++ bench. It neither executes
upstream Blockless code nor claims MicroPython, wiring or PCB generation.
"""
import hashlib
import json

from worker.contract import project_contract
from worker.firmware import FQBNS, CORE_VERSION, LIBRARY_VERSION, validate_hardware
from worker.robot_model import validate_execution_model
from .workflow import validate_workflow


def build_manifest(project):
    if project.get('pipeline_version') == 5:
        from .motion_v5 import build_motion_manifest
        return build_motion_manifest(project)
    hardware, kind = project['hardware'], project['task_type']
    validate_hardware(hardware, kind)
    flow = validate_workflow(project['workflow'])
    model = project.get('execution_model')
    joint = None
    if kind == 'joint_position':
        validate_execution_model(model)
        joint = next(j for j in model['joints'] if j['name'] == model['selected_joint'])
        if not joint['limits']['lower'] <= project['parameters']['target'] <= joint['limits']['upper']:
            raise ValueError('目标角度超出所选关节范围。')
    if hardware.get('ros_distro') != 'humble':
        raise ValueError('当前编译环境只支持 ROS 2 Humble。')
    contract = project_contract(project)
    identity = contract['communication']['identity']
    checks = [
        {'id':'board', 'passed':True, 'label':'板型已明确', 'detail':FQBNS[hardware['board']] + '；通用编译目标，未认定具体实物板'},
        {'id':'runtime', 'passed':True, 'label':'运行环境已配对', 'detail':'ROS 2 Humble / Ubuntu 22.04；Arduino ESP32 core ' + CORE_VERSION},
        {'id':'device', 'passed':True, 'label':'输入输出与任务匹配', 'detail':hardware['actuator'] + ' / ' + hardware['sensor'] + '；本轮为模拟设备'},
        {'id':'model', 'passed':True, 'label':'控制对象已固定', 'detail':(joint.get('label') or joint['name']) + '；' + joint['name'] if joint else '数值传感器通道，不驱动机器人关节'},
        {'id':'protocol', 'passed':True, 'label':'两端共用通信格式', 'detail':'串口 JSONL / 115200；同一对象、模型和协议版本；600 ms 收不到有效指令清零'},
        {'id':'review', 'passed':True, 'label':'流程保留人工核对', 'detail':'先核对需求，再生成程序；两端编译和通信、仿真检查均保留'},
    ]
    manifest = {
        'schema_version':1, 'task_type':kind,
        'modules':[
            {'id':'ros', 'label':'ROS 程序', 'runtime':'ROS 2 Humble', 'language':'Python', 'role':'根据反馈计算任务指令', 'ai_file':'algorithm.py', 'generated_scope':'AI 只生成任务计算函数；ROS 节点由模板提供'},
            {'id':'esp32', 'label':'ESP32 程序', 'runtime':'Arduino C++', 'board':hardware['board'], 'fqbn':FQBNS[hardware['board']], 'role':'检查和限制指令，回传状态，失联清零', 'ai_file':'device_logic.cpp', 'generated_scope':'AI 只生成数值限幅函数；协议和失联保护由模板提供'},
            {'id':'connection', 'label':'两端通信', 'transport':'serial_jsonl', 'baudrate':115200, 'identity':identity, 'physical_port':None},
            {'id':'device', 'label':'测试设备', 'actuator':hardware['actuator'], 'sensor':hardware['sensor'], 'physical_io':False, 'pins':None},
        ],
        'dependencies':{'ros_distro':'humble','esp32_core':CORE_VERSION,'arduinojson':LIBRARY_VERSION},
        'selected_joint':joint, 'model_sha256':identity['model_sha256'], 'protocol_sha256':identity['protocol_sha256'],
        'workflow_hash':flow['hash'], 'execution_order':flow['execution_order'],
        'preflight':{'passed':True,'scope':'配置一致性检查；编译和运行结果另行记录','checks':checks},
        'missing_for_hardware':[
            '具体开发板型号，以及 Flash / PSRAM 配置',
            '电机和驱动型号、供电、引脚或总线接线',
            '传感器型号、真实反馈方式和实物关节限位',
            '烧录后的实际通信、失联停车和动作验收',
        ],
        'provenance':{'kind':'deterministic_project_manifest','note':'由已保存的选择和固定工程规则生成；不把 AI 推测作为接线信息'},
    }
    manifest['hash'] = hashlib.sha256(json.dumps(manifest,sort_keys=True,ensure_ascii=False,separators=(',',':'),allow_nan=False).encode()).hexdigest()
    return manifest
