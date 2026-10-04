"""Source-defined structure import and explicit selected-joint execution binding."""
from __future__ import annotations

import hashlib
import json
import math
import re
import xml.etree.ElementTree as ET
from pathlib import Path

ORIGIN = 'https://sophimotion.github.io/sophicore-robot-cle/'
MODEL_LIMIT = 4_000_000
COLOR = [0.65, 0.69, 0.73, 1]


def vector(value, length=3, default=None):
    if value is None:
        return list(default if default is not None else [0] * length)
    result = [float(x) for x in value.split()] if isinstance(value, str) else list(value)
    if len(result) != length or any(not isinstance(x, (int, float)) or isinstance(x, bool) or not math.isfinite(x) or abs(x) > 10000 for x in result):
        raise ValueError('模型的坐标或颜色不正确。')
    return result


def visual(kind, *, xyz=None, rpy=None, color=None, **dimensions):
    return {'type': kind, 'xyz': xyz or [0, 0, 0], 'rpy': rpy or [0, 0, 0], 'color': color or COLOR, **dimensions}


def link(name, *visuals):
    return {'name': name, 'visuals': list(visuals)}


def builtins(root):
    common = {'format': 'builtin', 'warnings': [], 'source_url': 'project://structure', 'physics_validated': False}
    joint = {**common, 'id': 'builtin-joint', 'name': '单关节测试装置', 'simulation_binding': 'joint_position',
             'links': [link('base', visual('box', size=[0.3, 0.3, 0.08], xyz=[0, 0, 0.04])),
                       link('arm', visual('box', size=[0.5, 0.06, 0.06], xyz=[0.25, 0, 0]))],
             'joints': [{'name': 'test_joint', 'type': 'revolute', 'parent': 'base', 'child': 'arm',
                         'xyz': [0, 0, 0.12], 'rpy': [0, 0, 0], 'axis': [0, 0, 1], 'lower': -3.0, 'upper': 3.0}],
             'warnings': ['显示测试关节的角度示意；物理验收采用运行记录中指定的 Gazebo 模型。']}
    sensor = {**common, 'id': 'builtin-sensor', 'name': '传感器触发测试台', 'simulation_binding': 'sensor_threshold',
              'links': [link('base', visual('box', size=[0.35, 0.25, 0.05], xyz=[0, 0, 0.025])),
                        link('sensor', visual('box', size=[0.08, 0.06, 0.08], xyz=[0, 0, 0.10]))],
              'joints': [{'name': 'mount', 'type': 'fixed', 'parent': 'base', 'child': 'sensor',
                          'xyz': [0, 0, 0], 'rpy': [0, 0, 0], 'axis': [0, 0, 1]}]}
    reference = {**common, 'id': 'sophicore-reference', 'name': 'Sophicore 原站结构参考', 'format': 'sophicore-mesh',
                 'source_url': ORIGIN, 'links': [], 'joints': [], 'simulation_binding': None,
                 'mesh_url': '/api/structures/sophicore-reference/mesh',
                 'mesh_available': (Path(root) / 'knowledge' / 'sophicore-model.json').is_file(),
                 'warnings': ['原站默认装配网格，单位 mm。尚未绑定电机、质量和碰撞模型；不作为本轮任务仿真模型。']}
    config_path = Path(root) / 'knowledge' / 'sophicore-default-configuration.json'
    mesh_path = Path(root) / 'knowledge' / 'sophicore-model.json'
    if config_path.is_file() and mesh_path.is_file():
        from worker.robot_model import sophicore_structure
        reference = {**sophicore_structure(json.loads(config_path.read_text(encoding='utf-8-sig')), mesh_path),
                     'id': 'sophicore-reference', 'name': 'Sophicore 机器人（18 个结构关节）',
                     'mesh_url': '/api/structures/sophicore-reference/mesh', 'mesh_available': True}
    return [joint, sensor, reference]


def _digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False).encode()).hexdigest()


def list_structures(root):
    values = builtins(root)
    for p in sorted((Path(root) / 'knowledge').glob('structure-*.json')):
        if p.is_symlink():
            continue
        try:
            values.append(get_structure(root, p.stem))
        except (OSError, ValueError):
            continue
    # Source text is fetched separately; keep the list and project metadata light.
    return [{k: v for k, v in x.items() if k != 'source_content'} for x in values]


def get_structure(root, identifier, include_source=False):
    for item in builtins(root):
        if item['id'] == identifier:
            item['content_sha256'] = _digest(item)
            return item
    if not re.fullmatch(r'structure-[a-f0-9]{24}', identifier or ''):
        raise ValueError('找不到这个结构文件。')
    path = Path(root) / 'knowledge' / f'{identifier}.json'
    if not path.is_file() or path.is_symlink():
        raise ValueError('找不到这个结构文件。')
    item = json.loads(path.read_text(encoding='utf-8'))
    if item.get('format') == 'sophicore-configuration' and item.get('source_content'):
        migrated = _sophicore(item['source_content'], root)
        item = {**item, **migrated, **{k: item[k] for k in ('id', 'content_sha256', 'filename', 'source_content') if k in item}, 'mesh_url': '/api/structures/' + identifier + '/mesh'}
    if not include_source:
        item.pop('source_content', None)
    return item


def _urdf(content):
    if re.search(r'<!\s*(DOCTYPE|ENTITY)', content, re.I):
        raise ValueError('URDF 不接受外部实体或 DTD。')
    try:
        robot = ET.fromstring(content)
    except ET.ParseError as error:
        raise ValueError('URDF XML 格式不正确。') from error
    if robot.tag != 'robot':
        raise ValueError('文件需要以 robot 元素定义机器人。')
    warnings = ['有上下限的旋转关节可接入本机单关节仿真；缺少的质量与惯量使用明确标注的数值占位，不能据此判断实物负载能力。']
    links, joints = [], []
    if not 1 <= len(robot.findall('link')) <= 100 or len(robot.findall('joint')) > 100:
        raise ValueError('URDF 需要 1–100 个 link，最多 100 个 joint。')
    for el in robot.findall('link'):
        name = el.get('name', '').strip()
        if not name or len(name) > 120:
            raise ValueError('link 名称为空或过长。')
        shapes = []
        for v in el.findall('visual')[:30]:
            geometry = v.find('geometry')
            if geometry is None:
                continue
            origin = v.find('origin')
            xyz = vector(origin.get('xyz') if origin is not None else None)
            rpy = vector(origin.get('rpy') if origin is not None else None)
            material = v.find('material/color')
            color = vector(material.get('rgba') if material is not None else None, 4, COLOR)
            shape = next(iter(geometry), None)
            if shape is None:
                continue
            dims = {}
            if shape.tag == 'box':
                dims['size'] = vector(shape.get('size'))
            elif shape.tag in ('sphere', 'cylinder'):
                dims['radius'] = float(shape.get('radius', '0'))
                if shape.tag == 'cylinder':
                    dims['length'] = float(shape.get('length', '0'))
            elif shape.tag == 'mesh':
                warnings.append('网格附件尚未导入，已省略：' + str(shape.get('filename', ''))[:200])
                continue
            else:
                warnings.append('未支持的几何类型：' + shape.tag)
                continue
            nums = dims.get('size', list(dims.values()))
            if any(not math.isfinite(x) or x <= 0 or x > 20 for x in nums):
                raise ValueError('几何尺寸需为大于 0、不超过 20 米的有限值。')
            shapes.append(visual(shape.tag, xyz=xyz, rpy=rpy, color=color, **dims))
        item = link(name, *shapes)
        ine = el.find('inertial')
        if ine is not None:
            mass, inertia, origin = ine.find('mass'), ine.find('inertia'), ine.find('origin')
            if mass is None or inertia is None:
                raise ValueError('inertial 需同时给出 mass 和 inertia。')
            center = vector(origin.get('xyz') if origin is not None else None)
            angles = vector(origin.get('rpy') if origin is not None else None)
            # Rotate the supplied tensor into the link frame; preserve COM.
            values = {k: float(inertia.get(k, '0')) for k in ('ixx','iyy','izz','ixy','ixz','iyz')}
            m = float(mass.get('value', '0'))
            if not math.isfinite(m) or m <= 0 or any(not math.isfinite(v) for v in values.values()):
                raise ValueError('质量和惯量必须是有限数，质量须大于零。')
            cr,sr = math.cos(angles[0]),math.sin(angles[0])
            cp,sp = math.cos(angles[1]),math.sin(angles[1])
            cy,sy = math.cos(angles[2]),math.sin(angles[2])
            r = [[cy*cp,cy*sp*sr-sy*cr,cy*sp*cr+sy*sr],[sy*cp,sy*sp*sr+cy*cr,sy*sp*cr-cy*sr],[-sp,cp*sr,cp*cr]]
            t = [[values['ixx'],values['ixy'],values['ixz']],[values['ixy'],values['iyy'],values['iyz']],[values['ixz'],values['iyz'],values['izz']]]
            rotated = [[sum(r[i][a]*t[a][b]*r[j][b] for a in range(3) for b in range(3)) for j in range(3)] for i in range(3)]
            item.update(mass=m, center_of_mass=center, inertia=dict(zip(('ixx','iyy','izz','ixy','ixz','iyz'),(rotated[0][0],rotated[1][1],rotated[2][2],rotated[0][1],rotated[0][2],rotated[1][2]))), inertial_source='imported_urdf_unmeasured')
        links.append(item)
    names = {x['name'] for x in links}
    if len(names) != len(links):
        raise ValueError('link 名称不能重复。')
    seen_joints, parents, edges = set(), set(), {}
    for el in robot.findall('joint'):
        name, kind = el.get('name', ''), el.get('type', '')
        p, c, o, a = el.find('parent'), el.find('child'), el.find('origin'), el.find('axis')
        parent, child = p.get('link') if p is not None else None, c.get('link') if c is not None else None
        if not name or name in seen_joints or kind not in ('fixed', 'revolute', 'continuous', 'prismatic'):
            raise ValueError('关节名称重复或关节类型尚不支持。')
        if parent not in names or child not in names or parent == child or child in parents:
            raise ValueError('关节引用了不存在的零件，或连接关系有重复。')
        seen_joints.add(name)
        parents.add(child)
        edges.setdefault(parent, []).append(child)
        axis = vector(a.get('xyz') if a is not None else None, default=[1, 0, 0])
        if kind != 'fixed' and sum(v*v for v in axis) < 1e-10:
            raise ValueError('活动关节的轴不能是零向量。')
        joint = {'name': name, 'type': kind, 'parent': parent, 'child': child,
                 'xyz': vector(o.get('xyz') if o is not None else None), 'rpy': vector(o.get('rpy') if o is not None else None), 'axis': axis}
        limit = el.find('limit')
        if kind in ('revolute', 'prismatic'):
            if limit is None or limit.get('lower') is None or limit.get('upper') is None:
                warnings.append('关节缺少上下限，预览不能推定实际运动范围：' + name)
            else:
                lo, hi = float(limit.get('lower')), float(limit.get('upper'))
                if not math.isfinite(lo) or not math.isfinite(hi) or lo >= hi or max(abs(lo), abs(hi)) > 100:
                    raise ValueError('关节上下限无效。')
                joint.update(lower=lo, upper=hi)
        if el.find('mimic') is not None:
            if not el.find('mimic').get('joint'):
                raise ValueError('mimic 联动缺少引用的关节名称。')
            joint['mimic'] = dict(el.find('mimic').attrib)
            warnings.append('模型包含联动关节 mimic，尚不支持执行：' + name)
        joints.append(joint)
    def walk(name, stack):
        if name in stack:
            raise ValueError('关节连接形成了循环。')
        for child in edges.get(name, []):
            walk(child, stack | {name})
    for name in names:
        walk(name, set())
    if len(names - parents) != 1:
        raise ValueError('URDF 应为一棵相连的结构树。')
    return {'name': robot.get('name', '导入的机器人')[:120], 'format': 'urdf', 'simulation_binding': 'selected_joint', 'links': links, 'joints': joints, 'warnings': list(dict.fromkeys(warnings))}


def _sophicore(content, root):
    from worker.robot_model import sophicore_structure, normalize_sophicore_config
    try:
        config = normalize_sophicore_config(json.loads(content))
    except (TypeError, ValueError) as error:
        raise ValueError('Sophicore 配置不能使用：' + str(error)) from error
    result = sophicore_structure(config, Path(root) / 'knowledge' / 'sophicore-model.json')
    result.update(name='Sophicore 导入结构与关节', source_pose={'limbs': config['limbs'], 'head': config['head']},
                  motors=config['motors'], parameters=config['parameters'], source_sha256=config['sourceSha256'])
    return result


def ingest_structure(root, filename, content):
    if len(content.encode('utf-8')) > MODEL_LIMIT:
        raise ValueError('结构配置超过 4 MB；请导入 URDF 文本或配置 JSON。')
    suffix = Path(filename).suffix.lower()
    if suffix not in ('.urdf', '.xml', '.json'):
        raise ValueError('请选择 .urdf、.xml 或 Sophicore .json 配置。')
    try:
        result = _sophicore(content, root) if suffix == '.json' else _urdf(content)
    except (TypeError, OverflowError, RecursionError) as error:
        raise ValueError('结构文件的字段或连接关系无效。') from error
    digest = hashlib.sha256(content.encode('utf-8')).hexdigest()
    result.update(id='structure-' + digest[:24], content_sha256=digest, filename=Path(filename).name,
                  physics_validated=False, source_content=content)
    if suffix == '.json':
        result['mesh_url'] = '/api/structures/' + result['id'] + '/mesh'
    folder = Path(root) / 'knowledge'
    folder.mkdir(parents=True, exist_ok=True)
    (folder / (result['id'] + '.json')).write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
    return {k: v for k, v in result.items() if k != 'source_content'}


def attach_structure(root, project):
    prd = project.setdefault('prd', {})
    ident = prd.get('structure_id') or ('builtin-joint' if project['task_type'] == 'joint_position' else 'builtin-sensor')
    item = get_structure(root, ident)
    if ident == 'sophicore-reference' and item.get('format') == 'sophicore-kinematic':
        content = (Path(root) / 'knowledge' / 'sophicore-default-configuration.json').read_text(encoding='utf-8-sig')
        item = ingest_structure(root, 'sophicore-default-configuration.json', content)
        item['name'] = 'Sophicore 机器人（18 个结构关节）'
    selected = prd.get('joint_name')
    if selected and selected not in {x['name'] for x in item['joints']}:
        raise ValueError('所选关节不属于当前结构，请重新选择。')
    if project['task_type'] == 'joint_position':
        from worker.robot_model import build_execution_model
        if not selected and ident == 'builtin-joint':
            selected = 'test_joint'
        if not selected:
            raise ValueError('请先选择要控制的结构关节，再保存和拆分。')
        model = build_execution_model(item, selected)
        joint = next(j for j in model['joints'] if j['name'] == selected)
        lower, upper = joint['limits']['lower'], joint['limits']['upper']
        target = project['parameters']['target']
        if not lower <= target <= upper:
            raise ValueError(f'目标角度必须在所选关节的 {lower:.6g} 至 {upper:.6g} rad 范围内。')
        project['execution_model'] = model
        prd['joint_name'] = selected
    else:
        # Scalar testing does not claim to actuate a robot joint.
        project['execution_model'] = None
        prd['joint_name'] = None
    prd['structure_id'] = ident
    project['structure'] = item
    project['pipeline_version'] = 3
    return project
