"""Progressive PRD drafts and deterministic admission to existing executors.

This module neither invokes AI nor writes model files. An answer is not a test
result; hardware notes never select a real driver or change physical_io.
"""
from __future__ import annotations

import copy
import math

from .schemas import GuidedDraftInput, parse_intake, Parameters, ProjectInput
from .structures import get_structure
from .workflow import validate_workflow
from .intake_details import uses_complete_action
from worker.firmware import CORE_VERSION, LIBRARY_VERSION
from worker.contract import COMMUNICATION_DEFAULTS

INPUT_KEYS = ('name', 'request', 'task_type', 'parameters', 'hardware', 'prd', 'workflow')
SUGGESTIONS = {'target_rad': .6, 'tolerance_rad': .04, 'max_velocity_rad_s': .8,
               'duration_s': 8, 'threshold': .5, 'dwell_s': 0, 'repetitions': 3}
INTENTS = {'position': '转到一个位置', 'oscillate': '来回摆动', 'threshold': '数值达到条件后触发', 'other': '其他任务'}
TASKS = {'position': 'joint_position', 'threshold': 'sensor_threshold'}
NOTICE = '信息够用只表示可以开始拆分；还需人工核对，再生成、编译和检查仿真与通信。硬件资料有出处不代表已适配或实测。'


def has_intake(project):
    return isinstance(project.get('prd'), dict) and project['prd'].get('intake') is not None


def _data(value):
    return value.model_dump() if isinstance(value, GuidedDraftInput) else value


def _analyze(root, value):
    value = _data(value)
    from .motion_v5 import has_motion, assess_motion
    if has_motion(value):
        result, structure, _, _ = assess_motion(root, value)
        return result, structure
    prd = value.get('prd') or {}
    form = parse_intake(prd.get('intake')).model_dump()
    answers, intent, mode = form['answers'], form['intent'], form['mode']
    complete_action = uses_complete_action(form)
    missing, invalid, unsupported, resolved = [], [], [], []
    prefix = 'prd.intake.answers.'

    def issue(bucket, path, label, message, section):
        bucket.append({'path': path, 'label': label, 'message': message, 'section': section})

    def answer(key, label, section, lower=None, upper=None, unit=None):
        item = answers[key]
        if item is None or isinstance(item, str) and not item.strip():
            issue(missing, prefix + key, label, '请填写或明确选择' + label + '。', section)
            return None
        if lower is not None and (item < lower or item > upper):
            issue(invalid, prefix + key, label, f'{label}需在 {lower:g} 到 {upper:g} {unit or ""} 之间。', section)
        origin = ('suggested' if 'answers.' + key in form['accepted_suggestions']
                  and key in SUGGESTIONS and item == SUGGESTIONS[key] else 'user')
        resolved.append({'path': prefix + key, 'label': label, 'value': item, 'unit': unit, 'origin': origin})
        return item

    for key, label, minimum in [('name', '工程名称', 1), ('request', '你希望机器人做什么', 5)]:
        if len(str(value.get(key) or '').strip()) < minimum:
            issue(missing, key, label, f'{label}至少需要 {minimum} 个字。', 1)
    if mode is None:
        issue(missing, 'prd.intake.mode', '本轮用途', '请选择先做本机仿真，还是整理实物资料。', 4)
    elif mode == 'hardware_notes':
        issue(unsupported, 'prd.intake.mode', '本轮用途', '当前只整理实物资料；尚未提供真实设备驱动，不能生成并执行实物控制。', 4)
    if intent is None:
        issue(missing, 'prd.intake.intent', '动作类型', '请选择这次想做什么。', 1)
    elif intent not in TASKS:
        issue(unsupported, 'prd.intake.intent', '动作类型',
              '来回摆动可以保存需求，当前没有往返动作执行器；不会改成只到一个位置。' if intent == 'oscillate'
              else '这类任务可以保存说明，当前执行器尚未支持。', 1)
    if intent:
        resolved.append({'path': 'prd.intake.intent', 'label': '动作类型', 'value': INTENTS[intent], 'unit': None, 'origin': 'user'})

    model = joint = None
    if intent in ('position', 'oscillate') or complete_action:
        ident = answer('structure_id', '机器人结构', 2)
        selected = answer('joint_name', '要控制的关节', 2)
        if ident:
            try:
                model = get_structure(root, ident)
            except (ValueError, OSError) as error:
                issue(invalid, prefix + 'structure_id', '机器人结构', str(error), 2)
        if model and selected:
            try:
                from worker.robot_model import build_execution_model
                execution = build_execution_model(model, selected)
                joint = next(item for item in execution['joints'] if item['name'] == selected)
                source = model.get('source_url') or model.get('id')
                for path, label, item, unit in [
                    ('initial_position', '结构中的初始角度', joint['initial_position'], 'rad'),
                    ('limits', '模型角度范围', joint['limits'], 'rad'),
                    ('axis', '模型转轴', joint['axis'], None)]:
                    resolved.append({'path': 'model.' + path, 'label': label, 'value': item, 'unit': unit,
                                     'origin': 'model', 'source_ref': source})
            except (ValueError, KeyError, StopIteration) as error:
                issue(invalid, prefix + 'joint_name', '要控制的关节', str(error) or '该关节不属于所选结构。', 2)
    if complete_action:
        # Complete actions have their own stage/joint editor. Requiring hidden
        # single-joint A/B fields here makes the visible form impossible to fill.
        if form['action_draft']['related_joints']:
            answer('max_velocity_rad_s', '计划最高速度', 3, .1, 2, 'rad/s')
            answer('tolerance_rad', '计划允许角度误差', 3, .005, .15, 'rad')
        answer('duration_s', '观察时长', 3, 4, 30, 's')
    elif intent == 'position':
        answer('target_rad', '目标角度', 3, -2 * math.pi, 2 * math.pi, 'rad')
        answer('tolerance_rad', '允许角度误差', 3, .005, .15, 'rad')
        answer('max_velocity_rad_s', '最高速度', 3, .1, 2, 'rad/s')
        answer('duration_s', '观察时长', 3, 4, 30, 's')
    elif intent == 'threshold':
        answer('threshold', '触发阈值', 3, .1, .9, '0–1')
        answer('duration_s', '观察时长', 3, 4, 30, 's')
    elif intent == 'oscillate':
        for key, label, low, high, unit in [
            ('wave_start_rad', '摆动起点', -2 * math.pi, 2 * math.pi, 'rad'),
            ('wave_end_rad', '摆动终点', -2 * math.pi, 2 * math.pi, 'rad'),
            ('repetitions', '往返次数', 1, 1000, '次'), ('dwell_s', '端点停留', 0, 60, 's'),
            ('max_velocity_rad_s', '计划最高速度', .1, 2, 'rad/s'),
            ('tolerance_rad', '计划允许角度误差', .005, .15, 'rad')]:
            answer(key, label, 3, low, high, unit)
        if answer('end_behavior', '结束位置', 3) == 'custom':
            answer('end_position_rad', '自定结束角度', 3, -2 * math.pi, 2 * math.pi, 'rad')
    elif intent == 'other':
        answer('other_action', '其他任务说明', 3)
    if joint and not complete_action:
        relevant = ['target_rad'] if intent == 'position' else ['wave_start_rad', 'wave_end_rad']
        if intent == 'oscillate' and answers['end_behavior'] == 'custom':
            relevant.append('end_position_rad')
        for key in relevant:
            number = answers[key]
            if number is not None and not joint['limits']['lower'] <= number <= joint['limits']['upper']:
                issue(invalid, prefix + key, '关节角度', '这个角度超出当前模型关节范围；请修改角度或重新选择部位。', 3)
    answer('board', 'ESP32 编译目标', 4)

    note_labels = {'board_model': '具体开发板', 'flash_psram': 'Flash / PSRAM', 'motor_model': '电机',
                   'driver_model': '驱动器', 'feedback_model': '反馈设备', 'supply': '供电', 'wiring': '接线', 'docs': '参考资料'}
    for key, fact in form['hardware_notes'].items():
        if fact['status'] == 'documented' and (not fact['source'].strip() or not fact['value'].strip()):
            # A draft may retain an unfinished reference, but must not call it a
            # documented fact. This does not enable any real hardware capability.
            issue(invalid, 'prd.intake.hardware_notes.' + key, '硬件资料出处', '标为有出处时，请同时填写资料内容与出处；否则改为待确认。', 4)
        if fact['value'].strip() or fact['source'].strip():
            resolved.append({'path': 'prd.intake.hardware_notes.' + key, 'label': '硬件资料存档：' + note_labels[key],
                             'value': fact, 'unit': None, 'origin': 'user',
                             'source_ref': fact['source'] or '用户记录，未经实物验证'})
    for path, label, item, unit in [
        ('ros_distro', 'ROS 版本', 'Humble', None), ('firmware_dependencies', '固件依赖',
         {'esp32_core': CORE_VERSION, 'arduinojson': LIBRARY_VERSION}, None),
        ('transport', '两端通信', '串口 JSONL，通过主机虚拟串口检查', None),
        ('baudrate', '串口波特率', 115200, 'baud'), ('watchdog', '有效指令失联后归零', COMMUNICATION_DEFAULTS['watchdog_seconds'] * 1000, 'ms'),
        ('physical_io', '实物执行', False, None)]:
        resolved.append({'path': 'platform.' + path, 'label': label, 'value': item, 'unit': unit, 'origin': 'platform'})
    if intent == 'threshold':
        resolved.append({'path': 'platform.sensor_rule', 'label': '触发规则',
                         'value': '0–1 模拟值 >= 阈值输出 1，否则输出 0；无迟滞和单位换算', 'unit': None, 'origin': 'platform'})
    try:
        validate_workflow(value.get('workflow'))
    except ValueError as error:
        issue(invalid, 'workflow', '工程步骤', str(error), 5)
    detail_coverage = None
    if form['schema_version'] == 2:
        from .intake_details import analyze_details
        detail_coverage = analyze_details(root, form, model, missing, invalid, unsupported, resolved)
        if form.get('recommendation_records'):
            from .recommendations import apply_recommendation_origins
            apply_recommendation_origins(root, value, form, model, resolved)
        if form.get('action_draft'):
            from .intake_assistant import analyze_action
            analyze_action(root, value, form, missing, invalid, unsupported, resolved)
    can_plan = mode == 'simulation' and intent in TASKS and not missing and not invalid and not unsupported
    action = INTENTS.get(intent, '尚未选择动作')
    if complete_action:
        action = form['action_draft']['summary'].strip() or '完整动作说明待填写'
    elif intent == 'position':
        action += '：' + (str(answers['target_rad']) + ' rad' if answers['target_rad'] is not None else '目标角度待填')
    elif intent == 'threshold':
        action += '：' + (str(answers['threshold']) if answers['threshold'] is not None else '阈值待填')
    elif intent == 'oscillate':
        action += f"：{answers['wave_start_rad'] if answers['wave_start_rad'] is not None else '待填'} → {answers['wave_end_rad'] if answers['wave_end_rad'] is not None else '待填'} rad，{answers['repetitions'] if answers['repetitions'] is not None else '待填'} 次；当前仅存需求"
    criteria = ('末段位置误差不超过 ' + str(answers['tolerance_rad']) + ' rad' if intent == 'position' and answers['tolerance_rad'] is not None
                else '达到阈值输出 1，低于阈值输出 0' if intent == 'threshold'
                else '计划角度误差不超过 ' + str(answers['tolerance_rad']) + ' rad；仅记录要求，未接往返验收' if intent == 'oscillate' and answers['tolerance_rad'] is not None
                else '动作结果标准待确认')
    if complete_action:
        criteria = '按完整动作逐阶段核对关节、次数、姿势与待确认项；当前仅保存需求，尚不能执行或验收整套动作。'
    elif intent in TASKS:
        criteria += '；ROS 与固件编译、两端软件通信和失联检查须另行通过。'
    summary = {'action': action, 'device': {'esp32': 'ESP32 通用编译目标', 'esp32s3': 'ESP32-S3 通用编译目标'}.get(answers['board'], '编译目标待选择'),
               'model': ((model.get('name') or model['id']) + ' / ' + str(answers['joint_name'] or '关节待选择')) if model
                        else '0–1 模拟数值通道' if intent == 'threshold' else '结构或关节待选择',
               'criteria': criteria, 'scope': '硬件资料准备，不执行实物程序' if mode == 'hardware_notes'
                        else '本机模拟设备；不烧录、不控制实物'}
    result = {'schema_version': form['schema_version'], 'status': 'ready_for_plan' if can_plan else 'unsupported' if unsupported else 'incomplete',
            'can_save': True, 'can_plan': can_plan, 'execution_task': TASKS.get(intent) if can_plan else None,
            'missing': missing, 'invalid': invalid, 'unsupported': unsupported, 'resolved': resolved,
            'summary': summary, 'notice': NOTICE}
    if detail_coverage is not None:
        result['detail_coverage'] = detail_coverage
        summary['details'] = detail_coverage
    return result, model


def evaluate_intake(root, value):
    return _analyze(root, value)[0]


def materialize(root, body):
    """Only this converter supplies executable fields for a guided draft."""
    raw = _data(body)
    from .motion_v5 import has_motion, materialize_motion
    if has_motion(raw):
        return materialize_motion(root, raw)
    readiness, model = _analyze(root, raw)
    form = parse_intake(raw['prd']['intake']).model_dump()
    answer = form['answers']
    kind = TASKS.get(form['intent'])
    prd = {**raw['prd'], 'intake': form, 'structure_id': answer['structure_id'], 'joint_name': answer['joint_name']}
    hardware = {'board': answer['board'], 'ros_distro': 'humble', 'transport': 'serial_jsonl', 'baudrate': 115200,
                'physical_io': False, 'actuator': 'virtual_joint' if kind == 'joint_position' else 'virtual_switch' if kind else None,
                'sensor': 'simulated_encoder' if kind == 'joint_position' else 'simulated_scalar' if kind else None}
    parameter_keys = {'target': 'target_rad', 'threshold': 'threshold', 'tolerance': 'tolerance_rad',
                      'duration': 'duration_s', 'max_velocity': 'max_velocity_rad_s'}
    values = {key: answer[path] for key, path in parameter_keys.items()}
    if not readiness['can_plan']:
        return {'name': raw['name'], 'request': raw['request'], 'task_type': kind,
                'parameters': values, 'hardware': hardware, 'prd': prd,
                'workflow': copy.deepcopy(raw.get('workflow')), 'structure': model,
                'manifest': None, 'execution_model': None, 'pipeline_version': 3}
    parameters = Parameters().model_dump()
    used = ('target', 'tolerance', 'max_velocity', 'duration') if kind == 'joint_position' else ('threshold', 'duration')
    parameters.update({key: values[key] for key in used})
    if kind == 'sensor_threshold':
        prd.update(structure_id='builtin-sensor', joint_name=None)
    legacy = ProjectInput(name=raw['name'], request=raw['request'], task_type=kind, parameters=parameters,
                          hardware=hardware, prd={k: v for k, v in prd.items() if k != 'intake'},
                          workflow=raw.get('workflow')).model_dump()
    legacy['prd']['intake'] = form
    legacy['workflow'] = validate_workflow(legacy.get('workflow'))
    from .structures import attach_structure
    from .manifest import build_manifest
    legacy = attach_structure(root, legacy)
    # Saving the shared Sophicore reference creates its existing content-addressed
    # source. Pin the answer to that same source, so later admission checks read
    # the saved selection and do not re-import a mutable default configuration.
    selected_id = (legacy.get('structure') or {}).get('id')
    if kind == 'joint_position' and selected_id:
        legacy['prd']['structure_id'] = selected_id
        legacy['prd']['intake']['answers']['structure_id'] = selected_id
        action = legacy['prd']['intake'].get('action_draft')
        if action:
            old_action = copy.deepcopy(action)
            from .intake_details import mapping_source_fingerprint
            action['structure_id'] = selected_id
            action['model_source_sha256'] = mapping_source_fingerprint(root, legacy['structure'])
            # A content-identical alias is now pinned. Retain the same source
            # invocation while updating only the local model-binding metadata.
            bundle = legacy['prd']['intake'].get('recommendation_bundle')
            if bundle:
                for row in bundle['records']:
                    if row['path'] == 'prd.intake.action_draft' and row['value'] == old_action:
                        row['value'] = copy.deepcopy(action)
                        row['basis']['structure_id'] = selected_id
    legacy['manifest'] = build_manifest(legacy)
    return legacy


def assert_intake_ready(root, project):
    """Recompute at every execution gate; a stored/client readiness flag is ignored."""
    if not has_intake(project):
        return
    raw = {key: project[key] for key in INPUT_KEYS if key in project}
    body = GuidedDraftInput(**raw)
    readiness = evaluate_intake(root, body)
    if not readiness['can_plan']:
        issues = readiness['unsupported'] + readiness['missing'] + readiness['invalid']
        raise ValueError('需求还不能进入生成：' + '；'.join(item['message'] for item in issues)[:2000])
    expected = materialize(root, body)
    for key in ('task_type', 'parameters', 'hardware', 'prd', 'workflow', 'execution_model', 'manifest', 'motion_program'):
        if expected.get(key) != project.get(key):
            raise ValueError('引导答案、执行参数或结构版本已变化，请保存需求并重新拆分、核对。')
