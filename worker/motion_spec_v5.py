"""Finite, versioned multi-axis motion contract; no ROS or filesystem side effects."""
from __future__ import annotations
import copy
import math
import re
from .robot_model import build_execution_model, digest

PROFILE = 'multi_joint_source_kinematics_zero_gravity'


def number(value, label, minimum=None, maximum=None):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(label + '必须是有限数字。')
    if minimum is not None and value < minimum or maximum is not None and value > maximum:
        raise ValueError(label + '超出允许范围。')
    return float(value)


def build_motion_model(structure, joint_names):
    if not isinstance(structure, dict) or not str(structure.get('format', '')).startswith('sophicore'):
        raise ValueError('V5 本轮只接入 Sophicore 参考模型。')
    if not isinstance(joint_names, list) or not 1 <= len(joint_names) <= 12 or len(set(joint_names)) != len(joint_names):
        raise ValueError('请选择 1 到 12 个不重复的控制关节。')
    out = build_execution_model(structure, joint_names[0])
    joints = {j['name']: j for j in out['joints']}
    if any(n not in joints or joints[n]['type'] != 'revolute' for n in joint_names):
        raise ValueError('控制关节必须属于当前模型，且是有上下限的旋转关节。')
    out.pop('model_sha256'); out.pop('selected_joint'); out.pop('joint_position_offset')
    out.update(schema_version=5, physics_profile=PROFILE, active_joint_names=list(joint_names),
        held_positions={j['name']: j['initial_position'] for j in out['joints'] if j['name'] not in joint_names})
    out['assumptions'].update(control='参与关节由 ROS 轨迹控制器经同源固件核心驱动；其余关节固定在源姿态。')
    out['model_sha256'] = digest(out)
    return out


def validate_motion_model(model):
    if not isinstance(model, dict) or model.get('schema_version') != 5:
        raise ValueError('需要 V5 多关节执行模型。')
    if model.get('model_sha256') != digest({k:v for k,v in model.items() if k != 'model_sha256'}):
        raise ValueError('多关节模型摘要不一致。')
    rebuilt = build_motion_model({'id':model.get('model_id'), 'format':'sophicore-kinematic',
        'links':model.get('links'), 'joints':model.get('joints')}, model.get('active_joint_names'))
    for key in ('root_link', 'joints', 'held_positions', 'units', 'physics_profile', 'hardware_verified'):
        if model.get(key) != rebuilt.get(key):
            raise ValueError('多关节模型字段不一致：' + key)
    if model.get('assumptions', {}).get('base_fixed') is not True or model['assumptions'].get('gravity') != [0,0,0]:
        raise ValueError('本轮 Sophicore 仅允许固定底座和零重力台架。')
    return model


def compile_motion_program(plan, model):
    validate_motion_model(model)
    names = model['active_joint_names']
    if not isinstance(plan, dict) or plan.get('schema_version') != 1 or plan.get('joint_names') != names:
        raise ValueError('动作计划关节及顺序与模型不一致。')
    limits = {j['name']:j for j in model['joints']}
    velocity = number(plan.get('max_velocity_rad_s'), '速度上限', .05, 2.)
    acceleration = number(plan.get('max_acceleration_rad_s2'), '加速度上限', .05, 10.)
    tolerance = number(plan.get('tolerance_rad'), '位置误差', .005, .15)
    timeout = number(plan.get('timeout_s'), '动作超时', 4, 180)
    initial = [limits[n]['initial_position'] for n in names]
    last, stamp, rows = initial, 0., []
    points = plan.get('waypoints')
    if not isinstance(points, list) or not 1 <= len(points) <= 256:
        raise ValueError('需要 1 到 256 个动作路点。')
    for index, row in enumerate(points):
        if not isinstance(row, dict) or set(row) != {'positions', 'time_from_start_s', 'stage_id', 'cycle_index'}:
            raise ValueError('动作路点字段不完整或包含未知字段。')
        values = row['positions']
        if not isinstance(values, list) or len(values) != len(names):
            raise ValueError('每个路点必须填写所有参与关节的角度。')
        pos = [number(x, f'路点 {index + 1} 的 {n}', limits[n]['limits']['lower'], limits[n]['limits']['upper']) for n,x in zip(names,values)]
        t = number(row['time_from_start_s'], '路点时间', .001, 175)
        dt = t - stamp
        if dt <= 0:
            raise ValueError('路点时间必须严格递增。')
        # Zero endpoint velocity/acceleration means a quintic JTC segment.
        if any(1.875 * abs(a-b) / dt > velocity + 1e-9 or (10/math.sqrt(3))*abs(a-b)/dt**2 > acceleration+1e-9 for a,b in zip(pos,last)):
            raise ValueError('路点间隔太短，会超过已填写的速度或加速度限制。')
        if not isinstance(row['stage_id'], str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', row['stage_id']):
            raise ValueError('阶段标识无效。')
        cycle = row['cycle_index']
        if type(cycle) is not int or not 0 <= cycle <= 1000:
            raise ValueError('循环编号必须为 0 到 1000 的整数。')
        rows.append({**row,'positions':pos,'time_from_start_s':t})
        stamp, last = t, pos
    # A cycle label is a claim about an actual closed excursion, not a counter
    # that the caller can set to any desired number.
    current=0;highest=0;group=[];start=initial;previous=initial
    def close_cycle():
        if not current: return
        if len(group)<2 or any(abs(a-b)>1e-8 for a,b in zip(group[-1],start)):
            raise ValueError('每次往返至少需要两个连续路点，并回到该次开始前的关节姿势。')
        if not any(any(abs(a-b)>2*tolerance+1e-9 for a,b in zip(row,start)) for row in group):
            raise ValueError('每次往返至少一个关节的摆幅需大于两倍位置误差，才能从实际反馈区分离开和返回。')
    for row in rows:
        cycle=row['cycle_index']
        if cycle!=current:
            close_cycle()
            if cycle:
                if cycle!=highest+1:
                    raise ValueError('往返编号必须从 1 连续递增；同一次往返的路点不能拆散或重复编号。')
                highest=cycle
            current=cycle;start=previous;group=[]
        if cycle: group.append(row['positions'])
        previous=row['positions']
    close_cycle()
    if timeout < stamp + .5:
        raise ValueError('动作超时需要在最后路点后至少留出 0.5 秒。')
    out = {'schema_version':5, 'joint_names':copy.deepcopy(names), 'initial_positions':initial,
        'waypoints':rows, 'tolerance_rad':tolerance, 'max_velocity_rad_s':velocity,
        'max_acceleration_rad_s2':acceleration, 'timeout_s':timeout,
        'interpolation':'quintic_zero_endpoint_velocity_acceleration', 'model_sha256':model['model_sha256']}
    out['program_sha256'] = digest(out)
    return out


def validate_motion_program(program, model):
    if not isinstance(program, dict) or program.get('schema_version') != 5:
        raise ValueError('需要 V5 动作程序。')
    if program.get('program_sha256') != digest({k:v for k,v in program.items() if k != 'program_sha256'}):
        raise ValueError('动作程序摘要不一致。')
    checked = compile_motion_program({**program, 'schema_version':1}, model)
    if checked != program:
        raise ValueError('动作程序与模型或规范不一致。')
    return program


def motion_contract(spec):
    model = validate_motion_model(spec['execution_model'])
    program = validate_motion_program(spec['motion_program'], model)
    identity = {'model_sha256':model['model_sha256'], 'program_sha256':program['program_sha256'],
        'joint_names':list(program['joint_names'])}
    communication = {'schema_version':5, 'transport':'serial_motion_v5', 'ros_distro':'humble',
        'ros_domain_id':78, 'localhost_only':True, 'command_topic':'command', 'measurement_topic':'measurement',
        'state_topic':'state', 'event_topic':'event', 'ros_message_type':'std_msgs/msg/String',
        'command_unit':'rad position targets', 'state_position_unit':'rad', 'state_velocity_unit':'rad/s',
        'baudrate':921600, 'command_frequency_hz':50, 'measurement_frequency_hz':50, 'state_frequency_hz':50,
        'watchdog_seconds':.6, 'serial_line_max_bytes':2047, 'servo_p_gain':4.,
        'command_measurement_time_window_s':1.0,
        'servo_clock':'measurement simulation time; repeated stamps do not ramp',
        'watchdog_clock':'local monotonic wall time',
        'identity':identity, 'session_rule':'fresh runtime 32 lowercase hex handshake; monotonic independent stream seq/time',
        'atomic_vectors':True, 'physical_io':False, 'esp32_execution_verified':False}
    protocol_hash = digest(communication)
    communication['protocol_sha256'] = protocol_hash
    identity['protocol_sha256'] = protocol_hash
    if spec.get('communication') is not None and spec['communication'] != communication:
        raise ValueError('已保存的通信约定与当前模型、程序或协议版本不一致，请重新生成并核对。')
    simulation = {'physics_engine':'Gazebo Fortress/DART + ROS 2 Humble joint_trajectory_controller + shared C++ firmware core',
        'physics_profile':PROFILE, 'hardware_verified':False, 'initial_positions':program['initial_positions'],
        'active_joint_names':list(program['joint_names']), 'held_positions':copy.deepcopy(model['held_positions']),
        'assumptions':copy.deepcopy(model['assumptions']), 'identity':copy.deepcopy(identity),
        'communication_test_scope':'host_protocol_core_pty_ros; host executable is not an ESP32 emulator'}
    return {'communication':communication,'simulation':simulation}
