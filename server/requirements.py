"""Trace natural-language review to a bounded, independently tested task contract.

The model classifies the user's text; this is not a semantic proof. Executable
checks and their numerical values come only from the saved structured inputs.
"""
from __future__ import annotations

import json

FIELDS = ('request', 'prd.use_case', 'prd.constraints', 'prd.acceptance')
DETAIL_FIELDS = tuple('prd.intake.details.' + key for key in
                      ('motion', 'lifecycle', 'device_mapping', 'coordinates', 'communication', 'faults', 'acceptance', 'environment'))
ACTION_FIELD = 'prd.intake.action_draft'
STATUS = ('covered', 'manual_review', 'unsupported', 'conflict')
CHECK_IDS = ('task_behavior', 'target', 'threshold', 'tolerance', 'duration',
             'max_velocity', 'ros_build', 'esp_build', 'communication',
             'watchdog', 'model_identity', 'local_scope', 'source_provenance')
ITEM_SCHEMA = {'type': 'object', 'additionalProperties': False, 'properties': {
    'source_field': {'type': 'string', 'enum': list(FIELDS + DETAIL_FIELDS + (ACTION_FIELD,))},
    'text': {'type': 'string'},
    'status': {'type': 'string', 'enum': list(STATUS)},
    'check_ids': {'type': 'array', 'items': {'type': 'string', 'enum': list(CHECK_IDS)}},
    'reason': {'type': 'string'}},
    'required': ['source_field', 'text', 'status', 'check_ids', 'reason']}


def source_fields(spec):
    prd = spec.get('prd') or {}
    fields = {'request': str(spec.get('request') or ''), **{
        'prd.' + key: str(prd.get(key) or '') for key in ('use_case', 'constraints', 'acceptance')}}
    intake = prd.get('intake') or {}
    if intake.get('schema_version') == 2:
        from .schemas import parse_intake
        details = parse_intake(intake).model_dump()['details']
        fields.update({key: json.dumps(details[key.rsplit('.', 1)[1]], ensure_ascii=False,
                                     sort_keys=True, separators=(',', ':'), allow_nan=False) for key in DETAIL_FIELDS})
        if intake.get('action_draft'):
            fields[ACTION_FIELD] = json.dumps(intake['action_draft'], ensure_ascii=False,
                                              sort_keys=True, separators=(',', ':'), allow_nan=False)
    return fields


def executable_checks(spec):
    p = {key: '未提供' for key in ('duration', 'target', 'threshold', 'tolerance', 'max_velocity')}
    p.update(spec.get('parameters') or {})
    joint = spec['task_type'] == 'joint_position'
    checks = [
        ('task_behavior', '实际支持的任务', '一个所选关节到一个目标角度；其他关节固定在源姿态' if joint else '0–1 模拟值达到阈值输出 1，否则输出 0；没有迟滞或单位换算'),
        ('duration', '主场景观察时间', f"{p['duration']} 秒，从端点连接完成后计时"),
        ('ros_build', 'ROS 编译', 'ROS 2 Humble / colcon 真实构建退出码为 0'),
        ('esp_build', '固件编译', f"{spec['hardware']['board']} 通用目标真实编译，生成 BIN 与 ELF；未烧录"),
        ('communication', '共同通信', 'ROS ↔ 虚拟串口 ↔ 同源 C++ 核心，身份、格式、单位、序号与异常检查'),
        ('watchdog', '失联处理', '600 ms 收不到有效命令时输出零；包含软件断流测试'),
        ('model_identity', '模型一致', '所选关节、模型和协议摘要一致' if joint else '固定 scalar_channel 模拟通道，不驱动结构关节'),
        ('local_scope', '运行范围', '本机模拟设备，无真实 GPIO、板上运行或实物动作'),
        ('source_provenance', '资料与 AI 记录', '保留实际引用、生成工具、提示词、回答和版本记录'),
    ]
    if joint:
        checks[1:1] = [('target', '目标角度', f"{p['target']} rad"),
                       ('tolerance', '位置误差', f"主场景末段最大误差不超过 {p['tolerance']} rad"),
                       ('max_velocity', '指令上限', f"不超过 {p['max_velocity']} rad/s")]
    else:
        checks[1:1] = [('threshold', '触发阈值', f"value >= {p['threshold']} 输出 1，否则输出 0；独立检查等于边界")]
    return [{'id': key, 'label': label, 'expected': value} for key, label, value in checks]


def build_coverage(spec, supplied=None):
    fields = source_fields(spec)
    checks = executable_checks(spec)
    allowed = {check['id'] for check in checks}
    entries = []
    if supplied is None:
        # Legacy/mocked plans can still be inspected. No executable promise is
        # inferred from prose, and fresh production provider calls require items.
        supplied = [{'source_field': key, 'text': text, 'status': 'manual_review',
                     'check_ids': [], 'reason': '旧记录未保存逐项映射，请人工对照固定执行范围；文字本身不会变成自动测试。'}
                    for key, text in fields.items() if text.strip()]
    if not isinstance(supplied, list) or len(supplied) > 16:
        raise ValueError('需求覆盖清单格式不正确。')
    seen = set()
    for index, item in enumerate(supplied):
        if not isinstance(item, dict) or set(item) != set(ITEM_SCHEMA['required']):
            raise ValueError('需求覆盖条目缺少字段。')
        field, status, ids = item['source_field'], item['status'], item['check_ids']
        if field not in fields or field in seen or item['text'] != fields[field] or not fields[field].strip():
            raise ValueError('需求覆盖清单必须逐字段保留完整原文，不能遗漏、改写或重复。')
        if status not in STATUS or not isinstance(ids, list) or any(not isinstance(x, str) or x not in allowed for x in ids) or len(ids) != len(set(ids)):
            raise ValueError('需求覆盖条目引用了当前任务不能执行的检查。')
        if not isinstance(item['reason'], str) or not item['reason'].strip() or len(item['reason']) > 3000:
            raise ValueError('需求覆盖条目需要说明依据。')
        if status == 'covered' and not ids:
            raise ValueError('标为可检查的需求必须对应真实检查。')
        seen.add(field)
        entries.append({'id': 'requirement-' + str(index + 1), **item})
    expected = {key for key, text in fields.items() if text.strip()}
    if seen != expected:
        raise ValueError('需求覆盖清单没有覆盖全部需求、限制与验收原文。')
    v2 = ((spec.get('prd') or {}).get('intake') or {}).get('schema_version') == 2
    blocking_statuses = ('unsupported', 'conflict', 'manual_review') if v2 else ('unsupported', 'conflict')
    blocked = [entry['text'] + '：' + entry['reason'] for entry in entries if entry['status'] in blocking_statuses]
    return {'schema_version': 1,
            'scope': '仅覆盖当前选择的两类本机软件任务；AI 对文字的归类仍需人工核对。',
            'checks': checks, 'items': entries, 'blocking_issues': blocked,
            'review_note': '数值和检查来自固定执行器；AI 映射不是已经验收。请逐条核对文字要求是否都能被右侧检查覆盖，不能覆盖就先修改需求。'}


def plan_contract_prompt(spec):
    return {'source_fields': source_fields(spec), 'available_checks': executable_checks(spec)}
