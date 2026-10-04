"""Frozen, auditable robot kinematics shared by the API and execution worker.

Sophicore source coordinates are right handed, Z up, front -Y, in mm.  Each
link frame is its incoming joint's neutral pivot; joint origin is the pivot
difference in the parent frame.  Mesh vertices are source-global and must be
converted to metres, then have ``mesh_origin_m`` subtracted before attachment.
Angles are the source's absolute pose angles in radians (NOT pose deltas).

CAD axes/limits are source preview approximations.  The simulation mass, COM
and inertia below are explicit numerical placeholders, not measured hardware.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
from functools import lru_cache
from pathlib import Path
import re
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
SOURCE_REVISION = '3466db3591c16acc0c017782140d2df183763a74'
SOURCE_SHA256 = 'a8435cbd1f3598f699c9bc4f95bd08b898c1e92c5d29baf5d6665e07fb7ed3de'
MODEL_ASSET_SHA256 = 'e4fecfb762a35b013897a2bd0b2a40e64e0dbc00918e642b5266a92ac291f9e2'
SOURCE_URL = 'https://github.com/SophiMotion/sophicore-robot-cle/tree/' + SOURCE_REVISION
MODEL_PROFILE = 'single_joint_source_kinematics_zero_gravity'
DEFAULTS = dict(base_length=900, base_width=850, base_height=200, total_height=1875.75,
    wheel_base=500, od_tire=150, tire_thickness=20, thin_sheet=2, structural_sheet=5,
    base_angle=30, base_middle_length=100, wheel_track=600, shoulder_length=450,
    hip_length=400, hip_position=800, tube_diameter=50, tube_thickness=2,
    upper_arm_length=200, lower_arm_length=300, thigh_length=250, lower_leg_length=250)
PARAMETER_RANGES = dict(base_length=(650,1400), base_width=(650,1200), base_height=(160,350),
    total_height=(1200,2200), wheel_base=(300,850), od_tire=(100,220), tire_thickness=(8,50),
    thin_sheet=(1,6), structural_sheet=(5,5), base_angle=(15,60), base_middle_length=(40,220),
    wheel_track=(400,950), shoulder_length=(250,800), hip_length=(180,650), hip_position=(350,1500),
    tube_diameter=(30,80), tube_thickness=(1,16), upper_arm_length=(100,500),
    lower_arm_length=(100,650), thigh_length=(100,500), lower_leg_length=(100,500))
ARM_JOINTS = [('shoulder_lift','肩抬起',-180,180), ('shoulder_swing','肩侧摆',-100,40),
    ('arm_twist','上臂旋转',-90,90), ('elbow_bend','肘弯曲',0,135),
    ('wrist_rotation','手腕旋转',-90,90), ('clamp','夹爪开合',0,45)]
LEG_JOINTS = [('shoulder_lift','髋抬起',-90,90), ('elbow_bend','膝弯曲',0,135)]
HEAD_JOINTS = [('rotation','头部转向',-90,90), ('tilt','头部俯仰',-30,30)]
ASSUMPTIONS = {
    'kinematics': '原站从 CAD 安装件推定的轴心与角度范围；用于本机运动流程验证，未经实物标定。',
    'inertia': '每个部件组采用 1 kg 数值占位质量，包围盒中心和均匀实心盒惯量；不是实际质量或负载能力。',
    'gravity': [0.0, 0.0, 0.0],
    'collision': '包围盒仅作显示和惯量占位，不启用碰撞；不能证明防碰撞、强度或夹爪极限。',
    'base_fixed': True,
    'control': '每次只运行所选一轴，其余轴固定在保存的原始姿态；理想速度执行器。',
    'hardware': '驱动器型号、减速比、接线和扭矩尚未标定，禁止据此认定实物已可驱动。',
}


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
        separators=(',', ':'), allow_nan=False).encode('utf-8')).hexdigest()


def _finite(value, label):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(label + ' 必须是有限数字。')
    return float(value)


def _vec(value, label):
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        raise ValueError(label + ' 必须有三个坐标。')
    return [_finite(v, label) for v in value]


def _ramp_start(p):
    return 362.325662851831 + (p['base_length']-900)/2 - ((p['base_height']-p['base_middle_length'])/2/math.tan(math.radians(p['base_angle'])) - 50/math.tan(math.pi/6))


def normalize_sophicore_config(config):
    """Validate against the same source model and upstream parameter ranges."""
    if not isinstance(config, dict) or config.get('version') != 1 or config.get('sourceSha256') != SOURCE_SHA256:
        raise ValueError('该配置不属于已核对的 Sophicore 506 部件模型；请从原结构网站重新导出。')
    supplied = config.get('parameters')
    if not isinstance(supplied, dict):
        raise ValueError('配置缺少 parameters。')
    p = {}
    for key, default in DEFAULTS.items():
        value = supplied.get(key, default if key in ('thigh_length','lower_leg_length') else None)
        p[key] = _finite(value, key)
        lower, upper = PARAMETER_RANGES[key]
        if not lower <= p[key] <= upper:
            raise ValueError(f'{key} 超出原站允许的 {lower}–{upper} 范围。')
    errors = []
    if p['tube_diameter'] - 2*p['tube_thickness'] < 12: errors.append('管内径小于 12 mm')
    if 857.6+p['total_height']-1875.75-(p['upper_arm_length']-200)-(p['lower_arm_length']-300) < 50+p['base_height']+20: errors.append('手臂与底座间距不足')
    if p['base_middle_length'] > p['base_height']-40: errors.append('底座中间段过高')
    if p['wheel_base']/2+p['od_tire']/2+6 >= _ramp_start(p): errors.append('车轮开口进入斜坡')
    if p['wheel_track']/2+81+p['thin_sheet'] >= p['base_width']/2: errors.append('车轮外侧电机空间不足')
    if p['od_tire']-p['tire_thickness'] < 70: errors.append('轮毂直径不足')
    if p['od_tire']+8 >= 50+p['base_height']-p['thin_sheet']: errors.append('车轮上方间距不足')
    if 407.5+p['hip_position']-800-(p['thigh_length']-250)-(p['lower_leg_length']-250) < 270: errors.append('腿部与底座间距不足')
    if p['hip_position']+50+p['base_height']+80 >= p['total_height']-171.75: errors.append('髋部与肩部间距不足')
    if errors: raise ValueError('结构参数不符合原站检查：' + '；'.join(errors))
    limbs = config.get('limbs', {})
    head = config.get('head', {})
    if not isinstance(limbs, dict) or not isinstance(head, dict): raise ValueError('关节姿态格式错误。')
    saved = limbs.get('pose', {})
    if not isinstance(saved, dict): raise ValueError('肢体姿态格式错误。')
    pose = {}
    for limb in ('arm_l', 'arm_r', 'leg_l', 'leg_r'):
        item = saved.get(limb, {})
        if not isinstance(item, dict): raise ValueError('肢体姿态格式错误：' + limb)
        allowed = ARM_JOINTS if limb.startswith('arm') else LEG_JOINTS
        pose[limb] = {}
        for key, label, lower, upper in allowed:
            v = _finite(item.get(key, 0), limb + '.' + key)
            if not lower <= v <= upper: raise ValueError(limb + '.' + key + ' 超出原站预览范围。')
            pose[limb][key] = v
        if limb.startswith('leg') and any(item.get(k,0) != 0 for k in ('shoulder_swing','arm_twist','wrist_rotation','clamp')):
            raise ValueError('原结构没有这些腿部关节，不能用手臂自由度代替腿部：' + limb)
    hp = head.get('pose', {})
    if not isinstance(hp, dict): raise ValueError('头部姿态格式错误。')
    head_pose = {}
    for key, label, lower, upper in HEAD_JOINTS:
        v = _finite(hp.get(key,0), 'head.' + key)
        if not lower <= v <= upper: raise ValueError('头部角度超出原站预览范围。')
        head_pose[key] = v
    return {'version':1, 'sourceSha256':SOURCE_SHA256, 'parameters':p,
        'limbs':{'pose':pose}, 'head':{'pose':head_pose}, 'motors':copy.deepcopy(config.get('motors', {}))}


def _range(a,b): return list(range(a,b+1))


def _parts():
    out = {}
    def put(limb,stage,shift,ids,tube=None):
        for ident in ids:
            if ident in out: raise RuntimeError('Repeated source mesh mapping')
            out[ident] = dict(limb=limb, stage=stage, shift=shift, tube=tube)
    put('arm_l',0,0,[*_range(25,88),165]); put('arm_l',1,0,[*_range(89,152),166,167])
    put('arm_l',2,0,[168,169,170,171]); put('arm_l',2,0,[153],'upper_arm_length')
    put('arm_l',2,1,[154,155,172,173]); put('arm_l',3,1,[156,157,174,175,179])
    put('arm_l',4,1,[176,177,178,180]); put('arm_l',4,1,[158],'lower_arm_length')
    put('arm_l',4,2,[267,268,269,*_range(271,280),300,301]); put('arm_l',5,2,[270,*_range(281,285),*_range(287,296)])
    put('arm_l',6,2,[286,297,298,299]); put('arm_r',0,0,[302,*_range(303,366)])
    put('arm_r',1,0,[367,368,*_range(369,432)]); put('arm_r',2,0,[433,434,435,436]); put('arm_r',2,0,[437],'upper_arm_length')
    put('arm_r',2,1,[438,439,440,441]); put('arm_r',3,1,[442,443,444,445,446]); put('arm_r',4,1,[447,448,449,450])
    put('arm_r',4,1,[451],'lower_arm_length'); put('arm_r',4,2,[*_range(452,456),*_range(458,467)])
    put('arm_r',5,2,[457,*_range(468,472),*_range(474,483)]); put('arm_r',6,2,[473,484,485,486])
    put('leg_l',0,0,[159,160,181,182,183,184,185]); put('leg_l',2,0,[186,187]); put('leg_l',2,0,[161],'thigh_length')
    put('leg_l',2,1,[162,163,188,189,190,191]); put('leg_l',3,1,[192,193]); put('leg_l',3,1,[164],'lower_leg_length')
    put('leg_r',0,0,_range(487,493)); put('leg_r',2,0,[494,495]); put('leg_r',2,0,[496],'thigh_length')
    put('leg_r',2,1,_range(497,502)); put('leg_r',3,1,[503,504]); put('leg_r',3,1,[505],'lower_leg_length')
    return out


PARTS = _parts()
HEAD_YAW = {195,201,202,211,*range(243,258),258,259,260,262,263,264,266}
TUBE_REFERENCE = {
    153:([320.4999999999789,-20.000000000001364],1674), 158:([320.49999999997897,-20],1334.75),
    161:([169.4499999999999,-20.000000000000455],968.75), 164:([169.44999999999993,-20.00000000000034],657.5),
    437:([-320.49528761944924,-20.004712380371075],1644.0009255861955),
    451:([-320.4850970848681,-20.014902914811955],1304.7509258826312),
    496:([-169.45,-19.99999999998613],968.75), 505:([-169.44999999999973,-19.99999999998613],657.5),
}


def _pivots(limb, p):
    side = 1 if limb.endswith('_l') else -1
    arm = limb.startswith('arm')
    dx = side * (p['shoulder_length']-450 if arm else p['hip_length']-400)/2
    dz = p['total_height']-1875.75 if arm else p['base_height']-200+p['hip_position']-800
    if not arm:
        return [[side*169.45+dx,-20,1008.75+dz], [side*169.45+dx,-20,697.5+dz-(p['thigh_length']-250)]]
    offset = 0 if side == 1 else -30
    x = side*320.5+dx
    hand = dz-(p['upper_arm_length']-200)-(p['lower_arm_length']-300)
    wrist = [320.5+dx,-20,995.5193+hand] if side == 1 else [-320.480+dx,-20.020,965.300+hand]
    clamp = [318.51543774+dx,-46.50605813,970.11952428+hand] if side == 1 else [-322.45936475+dx,-46.53703852,939.65064290+hand]
    return [[side*250+dx,-20,1724+dz], [x,-20,1724+dz], [x,-20,1403+offset+dz-(p['upper_arm_length']-200)],
        [x,-20,1374.75+offset+dz-(p['upper_arm_length']-200)], wrist, clamp]


def _map(value, source, target):
    i = 0
    while i < len(source)-2 and value > source[i+1]: i += 1
    return target[i] + (value-source[i])/(source[i+1]-source[i])*(target[i+1]-target[i])


def _sign(x): return 1 if x > 0 else -1 if x < 0 else 0


def _deform_vertex(ident, x, y, z, p, center_x=0):
    """Direct coordinate rules from upstream geometry.ts / limbs.ts (mm)."""
    part = PARTS.get(ident)
    if 194 <= ident <= 266: return x,y,z+p['total_height']-1875.75
    if part:
        arm = part['limb'].startswith('arm'); side = 1 if part['limb'].endswith('_l') else -1
        dx = side*(p['shoulder_length']-450 if arm else p['hip_length']-400)/2
        dz = p['total_height']-1875.75 if arm else p['base_height']-200+p['hip_position']-800
        proximal = p['upper_arm_length']-200 if arm else p['thigh_length']-250
        distal = p['lower_arm_length']-300 if arm else p['lower_leg_length']-250
        shift = 0 if part['shift'] == 0 else proximal + (distal if part['shift'] == 2 else 0)
        if part['tube']:
            (cx,cy),top = TUBE_REFERENCE[ident]; radius = math.hypot(x-cx,y-cy)
            nr = p['tube_diameter']/2-p['tube_thickness']+(radius-23)*p['tube_thickness']/2
            x,y = cx+(x-cx)*nr/radius, cy+(y-cy)*nr/radius
            old = 200 if part['tube']=='upper_arm_length' else 300 if part['tube']=='lower_arm_length' else 250
            z = top-(top-z)*p[part['tube']]/old
        return x+dx,y,z+dz-shift
    side = _sign(center_x); t=p['thin_sheet']; dh=p['base_height']-200; deck=50+p['base_height']
    dx=side*(p['wheel_track']-600)/2; dy=(p['wheel_base']-500)/2; dz=(p['od_tire']-150)/2
    if ident in (3,4,7,8):
        ry,rz=y-250,z-75; radius=math.hypot(ry,rz); nr=radius
        if ident in (4,8): nr=_map(radius,[65,75],[(p['od_tire']-p['tire_thickness'])/2,p['od_tire']/2])
        elif radius > 25: nr=_map(radius,[25,65],[25,(p['od_tire']-p['tire_thickness'])/2])
        return x+dx,250+dy+ry*(nr/radius if radius else 1),75+dz+rz*(nr/radius if radius else 1)
    if ident in (5,6,21,22): return x+dx,y+dy,z+dz
    if ident in (9,10): return x+dx,y-dy,z
    if ident == 11: return x,y,_map(z,[56,1704],[54+t,p['total_height']-171.75])
    if ident == 17: return x*p['shoulder_length']/450,y,z+p['total_height']-1875.75
    if ident in (23,24): return side*(40+(abs(x)-40)*(p['hip_length']/2-40)/160),y,z+dh+p['hip_position']-800
    if ident in (12,13): return x*((p['base_width']/2-t)/423),y,z+dh-(t-2)
    if ident not in (0,1,2):
        x += side*((p['base_width']-850)/2-(t-2))
        z = z+t-2 if ident in (14,18) else _map(z,[92,206],[50+t+40,deck-t-2-40])
        return x,y,z
    x=_sign(x)*_map(abs(x),[0,40.2,273,300,342.5,403,421,422.8,423,425],
        [0,40.2,p['wheel_track']/2-27,p['wheel_track']/2,p['wheel_track']/2+42.5,p['base_width']/2-t-20,p['base_width']/2-2*t,p['base_width']/2-t-.2,p['base_width']/2-t,p['base_width']/2])
    y=_sign(y)*_map(abs(y),[0,20.2,173,250,327,362.325662851831,450],
        [0,20.2,p['wheel_base']/2-p['od_tire']/2-2,p['wheel_base']/2,p['wheel_base']/2+p['od_tire']/2+2,_ramp_start(p),p['base_length']/2])
    z=_map(z,[50,52,100,170,200,248,250],[50,50+t,50+(p['base_height']-p['base_middle_length'])/2,50+(p['base_height']+p['base_middle_length'])/2-30,50+(p['base_height']+p['base_middle_length'])/2,deck-t,deck])
    return x,y,z


@lru_cache(maxsize=2)
def _load_model(path_string, mtime_ns, size):
    content=Path(path_string).read_bytes()
    if hashlib.sha256(content).hexdigest()!=MODEL_ASSET_SHA256:
        raise ValueError('Sophicore 网格文件已变化，必须重新核对零件与关节映射。')
    data=json.loads(content)
    meta=data.get('metadata', {})
    if meta.get('sha256') != SOURCE_SHA256 or meta.get('units') != 'mm' or len(data.get('meshes', [])) != 506:
        raise ValueError('Sophicore 网格来源或单位与已核对的映射不一致。')
    if sorted(m['id'] for m in data['meshes']) != list(range(506)):
        raise ValueError('Sophicore 网格 ID 不完整。')
    return data


def _model(model_path=None):
    p=Path(model_path) if model_path is not None else ROOT/'knowledge'/'sophicore-model.json'
    st=p.stat()
    return _load_model(str(p.resolve()), st.st_mtime_ns, st.st_size)


def sophicore_mesh_data(config, model_path=None):
    """Return an independently owned deformed NEUTRAL mesh asset; units remain mm."""
    c=normalize_sophicore_config(config); p=c['parameters']; source=_model(model_path)
    if p == DEFAULTS: return copy.deepcopy(source)
    meshes=[]
    for m in source['meshes']:
        positions=[]; old=m['positions']; cx=m['bounds']['center'][0]
        for i in range(0,len(old),3): positions.extend(_deform_vertex(m['id'],*old[i:i+3],p,cx))
        bounds=_bounds(positions)
        meshes.append({**{k:v for k,v in m.items() if k not in ('positions','bounds')},'positions':positions,'bounds':bounds})
    return {'metadata':{**source['metadata'],'configuration_sha256':digest(c),'deformation':'upstream coordinate rules; neutral pose'},'meshes':meshes}


def _bounds(positions):
    lower=[min(positions[i::3]) for i in range(3)]
    upper=[max(positions[i::3]) for i in range(3)]
    return {'min':lower,'max':upper,'size':[upper[i]-lower[i] for i in range(3)],'center':[(upper[i]+lower[i])/2 for i in range(3)]}


def _joint_definitions(c):
    p=c['parameters']; joints=[]
    for limb in ('arm_l','arm_r','leg_l','leg_r','head'):
        arm=limb.startswith('arm'); head=limb=='head'; side=1 if limb.endswith('_l') else -1
        specs=HEAD_JOINTS if head else ARM_JOINTS if arm else LEG_JOINTS
        pivots=[[0,-20,1787+p['total_height']-1875.75],[0,-20,1824.75+p['total_height']-1875.75]] if head else _pivots(limb,p)
        axes=[[0,0,1],[-1,0,0]] if head else [[1,0,0],[0,side,0],[0,0,side],[1,0,0],[0,0,1],[math.sqrt(.5),-math.sqrt(.5),0]] if arm else [[1,0,0],[-1,0,0]]
        parent='base_link'; prev=[0,0,0]
        for idx,((key,label,lower,upper),pivot,axis) in enumerate(zip(specs,pivots,axes)):
            name=limb+'_'+key; child=name+'_link'
            initial=c['head']['pose'][key] if head else c['limbs']['pose'][limb][key]
            stage=idx+1 if arm or head else idx+2
            prefix='' if head else ('左' if side==1 else '右')
            joints.append({'name':name,'label':prefix+label,'type':'revolute','parent':parent,'child':child,
                'origin':{'xyz':[(pivot[i]-prev[i])/1000 for i in range(3)],'rpy':[0,0,0]}, 'axis':axis,
                'limits':{'lower':math.radians(lower),'upper':math.radians(upper)}, 'initial_position':math.radians(initial),
                'source_parameter':('head.pose.' if head else 'limbs.pose.'+limb+'.')+key,
                'source':{'limb':limb,'stage':stage,'pivot_mm':pivot,'axis_in_source_frame':axis,'limit_scope':'source_preview_not_hardware'}})
            parent=child; prev=pivot
    return joints


def _mesh_owner(ident,joints):
    part=PARTS.get(ident)
    if part:
        key=(part['limb'],part['stage'])
    elif ident==265: key=('head',2)
    elif ident in HEAD_YAW: key=('head',1)
    else: return 'base_link'
    for j in joints:
        if key==(j['source']['limb'],j['source']['stage']): return j['child']
    return 'base_link'


def _box_inertia(size,mass=1.0):
    x,y,z=size
    return {'ixx':mass*(y*y+z*z)/12,'iyy':mass*(x*x+z*z)/12,'izz':mass*(x*x+y*y)/12,'ixy':0.0,'ixz':0.0,'iyz':0.0}


@lru_cache(maxsize=8)
def _sophicore_geometry(config_json,path_string,mtime_ns,size):
    c=json.loads(config_json); p=c['parameters']; source=_load_model(path_string,mtime_ns,size)
    joints=_joint_definitions(c)
    names=['base_link']+[j['child'] for j in joints]
    group={n:[] for n in names}; bounds={n:([math.inf]*3,[-math.inf]*3) for n in names}
    for m in source['meshes']:
        name=_mesh_owner(m['id'],joints); group[name].append(m['id'])
        if p==DEFAULTS: b=m['bounds']
        else:
            v=m['positions']; deformed=[]; cx=m['bounds']['center'][0]
            for i in range(0,len(v),3): deformed.extend(_deform_vertex(m['id'],*v[i:i+3],p,cx))
            b=_bounds(deformed)
        lower,upper=bounds[name]
        for i in range(3): lower[i]=min(lower[i],b['min'][i]); upper[i]=max(upper[i],b['max'][i])
    links=[]
    for name in names:
        pivot=[0,0,0] if name=='base_link' else next(j['source']['pivot_mm'] for j in joints if j['child']==name)
        lower,upper=bounds[name]
        if not group[name]: raise ValueError('运动部件组没有对应的原始网格：'+name)
        dim=[max((upper[i]-lower[i])/1000,.001) for i in range(3)]
        center=[((upper[i]+lower[i])/2-pivot[i])/1000 for i in range(3)]
        links.append({'name':name,'mesh_ids':group[name],'mesh_origin_m':[v/1000 for v in pivot],
            'visuals':[{'type':'box','size':dim,'xyz':center,'rpy':[0,0,0],'color':[.48,.55,.62,1]}],
            'mass':1.0,'center_of_mass':center,'inertia':_box_inertia(dim),'inertial_source':'numerical_placeholder_1kg_uniform_aabb'})
    return links,joints


def sophicore_structure(config,model_path=None):
    c=normalize_sophicore_config(config)
    path=Path(model_path) if model_path is not None else ROOT/'knowledge'/'sophicore-model.json'
    st=path.stat()
    links,joints=_sophicore_geometry(json.dumps(c,sort_keys=True,separators=(',',':')),str(path.resolve()),st.st_mtime_ns,st.st_size)
    flat=[]
    for j in joints:
        flat.append({**copy.deepcopy(j),'xyz':j['origin']['xyz'][:],'rpy':[0,0,0],**j['limits']})
    provenance={'repository':SOURCE_URL,'commit':SOURCE_REVISION,'model_source_sha256':SOURCE_SHA256,'mesh_file_sha256':MODEL_ASSET_SHA256,
        'files':['src/limbs.ts','src/arms.ts','src/head.ts','src/geometry.ts','src/model4-tubes.json','src/parameters.ts','README.md'],
        'frame_convention':'source CAD: +X left, front -Y, +Z up; right handed; preserved explicitly, not relabelled REP-103',
        'source_units':'mm/degrees','status':'upstream_CAD_preview_approximation'}
    result={'id':'sophicore-reference','name':'Sophicore 可选关节结构','format':'sophicore-kinematic',
        'source_url':'https://sophimotion.github.io/sophicore-robot-cle/','source_sha256':SOURCE_SHA256,
        'parameters':c['parameters'],'motors':c['motors'],'source_pose':{'limbs':c['limbs'],'head':c['head']},
        'links':copy.deepcopy(links),'joints':flat,'provenance':provenance,'assumptions':copy.deepcopy(ASSUMPTIONS),
        'simulation_binding':'selected_joint','physics_validated':False,'mesh_units':'mm',
        'warnings':[ASSUMPTIONS[k] for k in ('kinematics','inertia','collision','control','hardware')]}
    result['kinematics_sha256']=digest({'joints':joints,'links':links,'parameters':c['parameters'],'provenance':provenance})
    result['content_sha256']=digest(result)
    return result


def _primitive_inertial(link):
    """Only a numerical placeholder if an imported normalized URDF has no inertia."""
    visuals=link.get('visuals',[])
    extent=[.05,.05,.05]
    for v in visuals:
        xyz=_vec(v.get('xyz',[0,0,0]),'visual.xyz')
        if v.get('type')=='box': dim=_vec(v.get('size'), 'box.size')
        elif v.get('type')=='sphere': dim=[2*_finite(v.get('radius'),'sphere.radius')]*3
        elif v.get('type')=='cylinder':
            radius=_finite(v.get('radius'),'cylinder.radius'); length=_finite(v.get('length'),'cylinder.length')
            dim=[max(2*radius,length)]*3  # enclosing cube remains valid for arbitrary RPY
        else: continue
        if any(d<=0 for d in dim): raise ValueError('结构几何尺寸必须为正数。')
        # Uniform enclosing cube avoids claiming actual mass geometry for rotated primitives.
        radius=math.sqrt(sum((d/2)**2 for d in dim))
        for i in range(3): extent[i]=max(extent[i],2*(abs(xyz[i])+radius))
    return {'mass':1.0,'center_of_mass':[0,0,0],'inertia':_box_inertia(extent),
        'inertial_source':'numerical_placeholder_1kg_enclosing_box'}


def build_execution_model(structure,selected_joint):
    """Freeze normalized geometry into a single-axis, simulation-only contract."""
    if not isinstance(structure,dict): raise ValueError('缺少结构模型。')
    links=copy.deepcopy(structure.get('links',[])); raw=structure.get('joints',[])
    if not links or not raw: raise ValueError('结构没有可执行的关节树。')
    names=[x.get('name') for x in links]
    if any(not isinstance(n,str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,99}',n) or n=='world' for n in names) or len(set(names))!=len(names):
        raise ValueError('部件名称需唯一，使用字母、数字和下划线，且不能以数字开头。')
    if len(links)>100 or len(raw)>100: raise ValueError('本机模型最多支持 100 个部件和关节。')
    joints=[]; joint_names=set(); parents=set(); known=set(names); children={}
    for item in raw:
        name=item.get('name'); kind=item.get('type'); parent=item.get('parent'); child=item.get('child')
        if not isinstance(name,str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,99}',name) or name=='world_fixed' or name in joint_names:
            raise ValueError('关节名称必须唯一且只含字母、数字和下划线。')
        if kind not in ('fixed','revolute','continuous','prismatic') or item.get('mimic'):
            raise ValueError('该模型存在尚未支持的关节或 mimic 联动，不能直接运行。')
        if parent not in known or child not in known or child==parent or child in parents:
            raise ValueError('关节父子关系不完整或重复。')
        joint_names.add(name); parents.add(child); children.setdefault(parent,[]).append(child)
        origin=item.get('origin') or {'xyz':item.get('xyz',[0,0,0]),'rpy':item.get('rpy',[0,0,0])}
        origin={'xyz':_vec(origin.get('xyz'),'joint.xyz'),'rpy':_vec(origin.get('rpy'),'joint.rpy')}
        axis=_vec(item.get('axis'),'joint.axis') if kind!='fixed' else [0,0,1]
        norm=math.sqrt(sum(v*v for v in axis))
        if norm<1e-10: raise ValueError('活动关节缺少有效转轴。')
        axis=[v/norm for v in axis]
        lim=item.get('limits') or {k:item[k] for k in ('lower','upper') if k in item}
        if kind in ('revolute','prismatic'):
            lower=_finite(lim.get('lower'),'joint.lower'); upper=_finite(lim.get('upper'),'joint.upper')
            if lower>=upper: raise ValueError('活动关节上下限无效。')
            lim={'lower':lower,'upper':upper}
        elif kind=='continuous': lim={}
        else: lim={}
        initial=_finite(item.get('initial_position',0),'joint.initial_position')
        if kind in ('revolute','prismatic') and not lim['lower']<=initial<=lim['upper']:
            raise ValueError('保存的关节姿态超出源模型范围：'+name)
        joints.append({'name':name,'label':item.get('label',name),'type':kind,'parent':parent,'child':child,
            'origin':origin,'axis':axis,'limits':lim,'initial_position':initial,
            'source_parameter':item.get('source_parameter'), 'source':copy.deepcopy(item.get('source',{}))})
    roots=known-parents
    if len(roots)!=1: raise ValueError('结构必须是一棵连通的关节树。')
    root=next(iter(roots)); visited=set()
    def walk(name):
        if name in visited: raise ValueError('关节树含循环。')
        visited.add(name)
        for child in children.get(name,[]): walk(child)
    walk(root)
    if visited!=known: raise ValueError('结构存在断开的部件或关节循环。')
    selected=next((j for j in joints if j['name']==selected_joint),None)
    if selected is None or selected['type']=='fixed': raise ValueError('请选择当前结构中的活动关节。')
    if selected['type']!='revolute': raise ValueError('本轮角度控制需要有上下限的旋转关节；无界旋转或直线关节暂不执行。')
    for link in links:
        if not all(k in link for k in ('mass','center_of_mass','inertia')): link.update(_primitive_inertial(link))
        mass=_finite(link['mass'],'link.mass'); center=_vec(link['center_of_mass'],'link.center_of_mass'); inertia=link['inertia']
        values={k:_finite(inertia.get(k,0),'inertia.'+k) for k in ('ixx','iyy','izz','ixy','ixz','iyz')}
        a,b,c=values['ixx'],values['iyy'],values['izz']; d,e,f=values['ixy'],values['ixz'],values['iyz']
        if mass<=0 or a<=0 or a*b-d*d<=0 or a*b*c+2*d*e*f-a*f*f-b*e*e-c*d*d<=0:
            raise ValueError('部件质量或惯量不是有效的正定值。')
        link.update(mass=mass,center_of_mass=center,inertia=values)
    assumptions=copy.deepcopy(ASSUMPTIONS)
    if not structure.get('format','').startswith('sophicore'):
        assumptions['kinematics']='沿用导入 URDF 的关节连接、原点、转轴和范围；尚未在实物上标定。'
        assumptions['inertia']='缺少质量和惯量的部件使用明确的 1 kg 数值占位；已有数值沿用模型资料，不代表实测。'
    assumptions.update(copy.deepcopy(structure.get('assumptions',{})))
    out={'schema_version':1,'model_id':structure.get('id','imported-model'),'source_sha256':structure.get('source_sha256') or structure.get('content_sha256'),
        'kinematics_sha256':structure.get('kinematics_sha256') or digest({'links':links,'joints':joints}),
        'root_link':root,'links':links,'joints':joints,'selected_joint':selected_joint,
        'held_positions':{j['name']:j['initial_position'] for j in joints if j['name']!=selected_joint},
        'joint_position_offset':selected['initial_position'],'units':{'length':'m','angle':'rad','mass':'kg','time':'s'},
        'physics_profile':MODEL_PROFILE,'provenance':copy.deepcopy(structure.get('provenance',{'source_url':structure.get('source_url'),'format':structure.get('format')})),
        'assumptions':assumptions,'hardware_verified':False}
    out['model_sha256']=digest(out)
    return out


def build_sophicore_model(config,selected_joint,model_path=None):
    return build_execution_model(sophicore_structure(config,model_path),selected_joint)


def validate_execution_model(model):
    """Recheck a frozen model in the worker before generating or running anything."""
    if not isinstance(model,dict) or model.get('schema_version')!=1:
        raise ValueError('执行模型版本不受支持。')
    supplied=model.get('model_sha256')
    if not isinstance(supplied,str) or supplied!=digest({k:v for k,v in model.items() if k!='model_sha256'}):
        raise ValueError('执行模型内容与已确认的摘要不一致。')
    checked=build_execution_model({'id':model.get('model_id'),'links':model.get('links'),'joints':model.get('joints')},model.get('selected_joint'))
    if model.get('root_link')!=checked['root_link'] or model.get('held_positions')!=checked['held_positions'] or model.get('joint_position_offset')!=checked['joint_position_offset']:
        raise ValueError('执行模型的根部件、固定姿态或关节零位不一致。')
    if model.get('units')!={'length':'m','angle':'rad','mass':'kg','time':'s'} or model.get('physics_profile')!=MODEL_PROFILE:
        raise ValueError('执行模型单位或仿真模式不受支持。')
    assumptions=model.get('assumptions',{})
    if assumptions.get('gravity')!=[0,0,0] or assumptions.get('base_fixed') is not True or model.get('hardware_verified') is not False:
        raise ValueError('该模型只允许固定基座、零重力、未验证实物的本机运行模式。')
    return model


def gen_urdf(model):
    """All source joints at CAD zero; saved initial poses remain in model JSON.

    Consumers must use model.initial_position / held_positions for saved poses.
    A fixed world joint is deliberate: this is a stationary single-axis test.
    """
    validate_execution_model(model)
    root=ET.Element('robot',name='ae_source_robot')
    root.append(ET.Comment('Simulation only. AABB visual proxies; numerical placeholder inertia. Saved angles are in execution_model.json.'))
    root.append(ET.Comment('model_sha256='+str(model['model_sha256'])))
    def fmt(values): return ' '.join(format(v,'.12g') for v in values)
    def origin(parent,xyz,rpy=None): ET.SubElement(parent,'origin',xyz=fmt(xyz),rpy=fmt(rpy or [0,0,0]))
    ET.SubElement(root,'link',name='world')
    fixed=ET.SubElement(root,'joint',name='world_fixed',type='fixed'); ET.SubElement(fixed,'parent',link='world'); ET.SubElement(fixed,'child',link=model['root_link'])
    for link in model['links']:
        el=ET.SubElement(root,'link',name=link['name']); ine=ET.SubElement(el,'inertial'); origin(ine,link['center_of_mass'])
        ET.SubElement(ine,'mass',value=str(link['mass'])); ET.SubElement(ine,'inertia',**{k:str(v) for k,v in link['inertia'].items()})
        for index,v in enumerate(link.get('visuals',[])):
            vis=ET.SubElement(el,'visual',name=link['name']+'_visual_'+str(index)); origin(vis,v.get('xyz',[0,0,0]),v.get('rpy',[0,0,0])); geom=ET.SubElement(vis,'geometry')
            if v['type']=='box': ET.SubElement(geom,'box',size=fmt(v['size']))
            elif v['type']=='sphere': ET.SubElement(geom,'sphere',radius=str(v['radius']))
            elif v['type']=='cylinder': ET.SubElement(geom,'cylinder',radius=str(v['radius']),length=str(v['length']))
            else: raise ValueError('URDF 导出遇到未支持的几何类型。')
    for joint in model['joints']:
        el=ET.SubElement(root,'joint',name=joint['name'],type=joint['type']); ET.SubElement(el,'parent',link=joint['parent']); ET.SubElement(el,'child',link=joint['child'])
        origin(el,joint['origin']['xyz'],joint['origin']['rpy'])
        if joint['type']!='fixed':
            ET.SubElement(el,'axis',xyz=fmt(joint['axis']))
            limits=joint['limits']; attrs={'effort':'1','velocity':'0.8'}  # numerical limits only; not a motor rating
            if joint['type']!='continuous': attrs.update(lower=str(limits['lower']),upper=str(limits['upper']))
            ET.SubElement(el,'limit',**attrs)
    ET.indent(root)
    return ET.tostring(root,encoding='unicode')+'\n'
