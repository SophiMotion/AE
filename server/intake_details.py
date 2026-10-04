"""V2 requirement collection; it admits only the existing local test profile."""
from __future__ import annotations

import hashlib
from pathlib import Path

from .structures import get_structure

GROUPS = {
    'motion': ('动作顺序与完成条件', 3),
    'lifecycle': ('开始、结束与取消', 3),
    'device_mapping': ('关节与设备对应', 4),
    'coordinates': ('零位、方向与单位', 4),
    'communication': ('两端分工与通信', 4),
    'faults': ('出错后怎么办', 5),
    'acceptance': ('怎样检查结果', 5),
    'environment': ('在哪里、带什么负载运行', 5),
}


def uses_complete_action(form):
    """Match the visible complete-action editor, not the selected intent label."""
    action = form.get('action_draft')
    return bool(action and (action['scope'] != 'single_joint' or
                len(action['related_joints']) != 1 or len(action['stages']) != 1 or
                any((stage['repetitions'] or 1) > 1 for stage in action['stages'])))


def profile_descriptions(intent):
    joint = intent != 'threshold'
    return {
        'motion': '只执行上面所填的一项动作；所有固定检查都需通过，不编排多个动作。',
        'lifecycle': ('从模型初始角度开始，其他关节保持源姿态；不是实物回零。' if joint else '从固定的 0–1 合成数值开始，不读取实物传感器。') +
                     '手动启动；端点就绪后观察给定时长，到位不提前结束。结束或取消停止本轮进程，不代表实物刹车、卸力或返回起点。',
        'device_mapping': '本轮只对应模拟设备；ESP32 是编译目标，不连接板子、不驱动真实电机或 GPIO。',
        'coordinates': '沿用模型转轴及初始角度偏移；位置反馈用 rad，速度指令用 rad/s，不做真实编码器校零或减速比换算。' if joint else '输入是 0–1 模拟数值，输出为 0 或 1；不换算温度、距离等实物单位。',
        'communication': 'ROS 根据反馈计算速度或开关；ESP32 工程负责限幅和通信。在电脑上通过虚拟串口测试共享固件核心：JSONL、115200、名义 20 Hz。没有板上执行。',
        'faults': '超过 600 ms 没收到有效状态或指令时归零；坏包拒绝，不保证任意坏包立即停车。重复指令不重新执行；没有实物急停、断电或自动重连恢复。',
        'acceptance': ('观察结束时最后 5 个反馈位置都在允许误差内；不是持续稳定指定秒数。' if joint else '模拟值达到或超过阈值输出 1，否则输出 0；检查阈值上下及等于边界，没有迟滞或滤波。') +
                      '另检查 ROS 与固件编译、两端身份、通信、指令范围及失联。所有检查须在实际运行后通过。',
        'environment': '固定基座、零重力、理想速度的单关节仿真，无额外负载或碰撞验收；三维外观不证明真实动力学。' if joint else '固定软件产生的 0–1 数值；不验证实物传感器噪声、负载、碰撞或现场条件。',
    }


def mapping_source_fingerprint(root, model):
    """A configuration identity, not Sophicore's shared upstream code revision."""
    if model.get('id') == 'sophicore-reference' and model.get('format') == 'sophicore-kinematic':
        content = (Path(root) / 'knowledge' / 'sophicore-default-configuration.json').read_text(encoding='utf-8-sig')
        return hashlib.sha256(content.encode('utf-8')).hexdigest()
    digest = model.get('content_sha256')
    if not digest and model.get('id'):
        # The catalog's builtin entries omit their digest; compute it via the
        # same read used by /structures/{id}, without modifying stored models.
        digest = get_structure(root, model['id']).get('content_sha256')
    return str(digest or '').lower()


def structure_for_mapping(root, model):
    # Display-only metadata. Never insert it into stored V1 structures/digests.
    return {**model, 'mapping_source_sha256': mapping_source_fingerprint(root, model)}


def source_fingerprints(root, model):
    """Alias and frozen Sophicore sources may have different wrapper IDs."""
    values = {str(model.get('content_sha256') or '').lower(), mapping_source_fingerprint(root, model)}
    content = model.get('source_content')
    if isinstance(content, str):
        values.add(hashlib.sha256(content.encode('utf-8')).hexdigest())
    values.discard('')
    return values


def _content(value):
    if isinstance(value, str):
        return bool(value.strip())
    if value is None:
        return False
    if isinstance(value, dict):
        return any(_content(v) for k, v in value.items() if k not in ('id', 'status'))
    if isinstance(value, list):
        return any(_content(item) for item in value)
    return True  # Numeric zero is an explicit requirement, never an empty input.


def analyze_details(root, form, current_model, missing, invalid, unsupported, resolved):
    details, answers = form['details'], form['answers']
    profiles = profile_descriptions(form['intent'])
    complete_action = uses_complete_action(form)
    if complete_action:
        profiles['motion'] = '步骤、相关关节和次数按上面的完整动作草稿检查；当前执行器还不能执行这套动作。'
        for group in ('lifecycle', 'acceptance'):
            profiles[group] += ' 这些是现有单项测试的设置，不代表完整动作已能运行或通过验收。'
    coverage = []
    cache = {}

    def model_at(identifier):
        if identifier not in cache:
            cache[identifier] = get_structure(root, identifier, include_source=True)
        return cache[identifier]

    # Mapping references also need a source in non-joint draft modes. This read
    # does not select a joint or bind a real driver.
    current_id = answers.get('structure_id')
    current = None
    if current_id and details['device_mapping']['entries']:
        try:
            current = model_at(current_id)
        except (ValueError, OSError):
            pass

    for group, (label, section) in GROUPS.items():
        data = details[group]
        prefix = 'prd.intake.details.' + group
        counts = (len(missing), len(invalid), len(unsupported))

        def issue(bucket, suffix, message):
            bucket.append({'path': prefix + suffix, 'label': label, 'message': message, 'section': section})

        def require(value, suffix, message):
            if value is None or isinstance(value, str) and not value.strip():
                issue(missing, suffix, message)

        if group == 'motion':
            extras = (data['pattern'] in ('sequence', 'parallel') or data['completion'] == 'custom' or
                      data['steps'] or data['completion_note'].strip())
            # The legacy motion group is hidden when the complete editor owns
            # the steps. Existing extra requirements still remain visible and
            # are checked below; no stored profile fields are changed.
            if not complete_action or extras:
                require(data['pattern'], '.pattern', '请选择本轮只有上面的动作，还是还有顺序或同时动作。')
                require(data['completion'], '.completion', '请选择怎样算所有动作完成。')
            if complete_action:
                issue(unsupported, '', '按完整动作草稿核对步骤；当前执行器尚不支持这套动作。')
            if data['pattern'] in ('sequence', 'parallel') or data['completion'] == 'custom' or data['steps'] or data['completion_note'].strip():
                issue(unsupported, '', '补充的动作顺序、同时动作或完成条件暂不能执行；已保留，不会改成只到一个位置。')
            if data['pattern'] in ('sequence', 'parallel') and not data['steps']:
                issue(missing, '.steps', '请至少写出一个要执行的步骤。')
            if data['completion'] == 'custom':
                require(data['completion_note'], '.completion_note', '请写清自定义完成条件。')
            for index, step in enumerate(data['steps']):
                base = f'.steps.{index}.'
                required = {'move': ('joint_name', 'target_rad'), 'wait': ('duration_s',), 'condition': ('condition',), 'other': ('description',)}[step['kind']]
                labels = {'joint_name': '关节', 'target_rad': '目标角度', 'duration_s': '等待时长', 'condition': '触发条件', 'description': '步骤说明'}
                for key in required:
                    require(step[key], base + key, f'请填写第 {index + 1} 步的{labels[key]}。')
                for key in ('duration_s', 'timeout_s'):
                    if step[key] is not None and step[key] < 0:
                        issue(invalid, base + key, '步骤时长和超时不能是负数。')
                if step['kind'] == 'move' and step['joint_name'] and current_model:
                    joint = next((j for j in current_model.get('joints', []) if j['name'] == step['joint_name']), None)
                    if joint is None:
                        issue(invalid, base + 'joint_name', '步骤中的关节不在当前结构里，请重新核对。')
                    elif step['target_rad'] is not None and joint.get('lower') is not None and joint.get('upper') is not None and not joint['lower'] <= step['target_rad'] <= joint['upper']:
                        issue(invalid, base + 'target_rad', '步骤角度超出该关节模型范围。')
        elif group == 'device_mapping':
            scope, rows = data['scope'], data['entries']
            require(scope, '.scope', '请选择只用模拟设备、只保存硬件资料，还是本轮必须连接所填设备。')
            if scope == 'required' or scope == 'simulation_only' and rows:
                issue(unsupported, '', '本轮尚无真实设备驱动；这些对应资料不能悄悄忽略。可明确改为只保存资料，或清空后用模拟设备。')
            if scope in ('required', 'reference_only') and not rows:
                issue(missing, '.entries', '请添加需要保存的关节与设备对应资料。')
            addresses = set()
            for index, row in enumerate(rows):
                base = f'.entries.{index}.'
                for key, text in (('structure_id','结构来源'),('source_sha256','结构来源指纹'),('joint_name','关节'),('device','设备'),('interface','接口')):
                    require(row[key], base + key, f'请填写第 {index + 1} 条对应资料的{text}。')
                if row['status'] == 'documented':
                    require(row['source'], base + 'source', '标为有出处时，请补充出处。')
                source_model = None
                fingerprint = (row['source_sha256'] or '').lower()
                if row['structure_id']:
                    try:
                        source_model = model_at(row['structure_id'])
                    except (ValueError, OSError):
                        pass
                # An imported/frozen source can outlive its historical alias.
                # Resolve only when the exact configuration fingerprint matches;
                # never substitute a current model merely because names match.
                if current is not None and fingerprint == mapping_source_fingerprint(root, current):
                    source_model = current
                if row['structure_id'] and source_model is None:
                    issue(invalid, base + 'structure_id', '对应资料的结构来源已不存在，请重新核对。')
                if source_model:
                    if row['joint_name'] and row['joint_name'] not in {j['name'] for j in source_model.get('joints', [])}:
                        issue(invalid, base + 'joint_name', '对应资料的关节已不在该结构里，请重新核对。')
                    if fingerprint and fingerprint not in source_fingerprints(root, source_model):
                        issue(invalid, base + 'source_sha256', '结构来源指纹与对应资料不一致，请重新核对。')
                    if current is None or mapping_source_fingerprint(root, source_model) != mapping_source_fingerprint(root, current):
                        issue(invalid, base + 'structure_id', '当前模型与对应资料的来源不同，请重新核对后修改资料。')
                if row['interface'].strip() and row['address'].strip():
                    address = (row['interface'].strip().casefold(), row['address'].strip().casefold())
                    if address in addresses:
                        issue(invalid, base + 'address', '同一接口的设备地址重复，请核对是否冲突。')
                    addresses.add(address)
            if rows and answers.get('joint_name') and not any(row['joint_name'] == answers['joint_name'] for row in rows):
                issue(invalid, '.entries', '所选主关节已改变，对应资料没有这一关节，请重新核对。')
        else:
            selection = data['selection']
            supplements = {key: value for key, value in data.items() if key != 'selection'}
            has_content = _content(supplements)
            require(selection, '.selection', '请确认“' + label + '”使用本机设置，还是另有要求。')
            if selection == 'custom' or has_content:
                issue(unsupported, '', '“' + label + '”的补充要求已保存，当前执行器尚未支持；选择本机设置也不会忽略这些内容。')
            if selection == 'custom' and not has_content:
                issue(missing, '', '请写清“' + label + '”的具体要求。')
            if group == 'communication':
                for key in ('rate_hz', 'timeout_ms'):
                    if data[key] is not None and data[key] <= 0:
                        issue(invalid, '.' + key, '通信频率和超时时间必须大于 0。')
            if group == 'environment' and data['load_kg'] is not None and data['load_kg'] < 0:
                issue(invalid, '.load_kg', '负载不能是负数。')
            if group == 'acceptance':
                for index, row in enumerate(data['criteria']):
                    for key, text in (('metric', '检查项'), ('expected', '期望结果'), ('method', '检查办法')):
                        require(row[key], f'.criteria.{index}.{key}', f'请补充第 {index + 1} 条验收的{text}。')

        status = ('unsupported' if len(unsupported) > counts[2] or len(invalid) > counts[1]
                  else 'missing' if len(missing) > counts[0]
                  else 'reference_only' if group == 'device_mapping' and data['scope'] == 'reference_only'
                  else 'confirmed')
        summary = profiles[group] if status == 'confirmed' else (
            f'保存 {len(data["entries"])} 条设备对应资料；不参与本轮控制，不表示已适配或实测。' if status == 'reference_only'
            else '尚未确认，请补齐这一组。' if status == 'missing'
            else '补充内容已保留，暂不进入生成；请查看本组具体待补或未支持项。')
        if complete_action and group == 'motion' and not extras:
            summary = profiles[group]
        coverage.append({'group': group, 'label': label, 'section': section, 'status': status, 'summary': summary})
        resolved.append({'path': prefix, 'label': label, 'value': data, 'unit': None, 'origin': 'user'})
        resolved.append({'path': 'platform.details.' + group, 'label': label + '：当前本机设置', 'value': profiles[group], 'unit': None, 'origin': 'platform'})
    return coverage
