"""Independent numerical comparison with pinned upstream Three.js evaluation.

The reference fixture was produced by executing the upstream TS implementation,
not by this Python port.  This catches axis sign / frame / unit / mesh grouping
mistakes even when both the API and worker agree on the same wrong data.
"""
import copy
import json
import math
from pathlib import Path
import xml.etree.ElementTree as ET

import pytest

from worker.robot_model import (
    ROOT, SOURCE_SHA256, DEFAULTS, _deform_vertex, _joint_definitions,
    _mesh_owner, build_execution_model, build_sophicore_model, digest, gen_urdf,
    normalize_sophicore_config, sophicore_structure, validate_execution_model,
)


@pytest.fixture(scope='module')
def config():
    return json.loads((ROOT/'knowledge'/'sophicore-default-configuration.json').read_text(encoding='utf-8'))


@pytest.fixture(scope='module')
def structure(config):
    return sophicore_structure(config)


def _matmul(a,b):
    return [[sum(a[r][k]*b[k][c] for k in range(4)) for c in range(4)] for r in range(4)]


def _identity(): return [[1 if r==c else 0 for c in range(4)] for r in range(4)]


def _translate(xyz):
    a=_identity()
    for i,x in enumerate(xyz): a[i][3]=x
    return a


def _rotate(axis,angle):
    # Rodrigues, independently expressed from Three.js Matrix4 implementation.
    x,y,z=axis; c=math.cos(angle); s=math.sin(angle); t=1-c
    return [[t*x*x+c,t*x*y-s*z,t*x*z+s*y,0],
            [t*x*y+s*z,t*y*y+c,t*y*z-s*x,0],
            [t*x*z-s*y,t*y*z+s*x,t*z*z+c,0],[0,0,0,1]]


def _world_frames(joints):
    frames={'base_link':_identity()}
    for j in joints:
        frames[j['child']]=_matmul(frames[j['parent']],_matmul(_translate(j['origin']['xyz']),_rotate(j['axis'],j['initial_position'])))
    return frames


def test_all_506_meshes_owned_once_and_18_source_joints(structure):
    assert len(structure['joints'])==18
    assert len(structure['links'])==19
    ids=[ident for link in structure['links'] for ident in link['mesh_ids']]
    assert sorted(ids)==list(range(506))
    assert len(ids)==len(set(ids))
    assert {j['name'] for j in structure['joints']}=={
        *(limb+'_'+key for limb in ('arm_l','arm_r') for key in ('shoulder_lift','shoulder_swing','arm_twist','elbow_bend','wrist_rotation','clamp')),
        *(limb+'_'+key for limb in ('leg_l','leg_r') for key in ('shoulder_lift','elbow_bend')),
        'head_rotation','head_tilt'}


@pytest.mark.parametrize('case_index',[0,1,2],ids=['neutral','mixed','resized_mixed'])
def test_coordinates_and_forward_kinematics_match_pinned_official_typescript(config,case_index):
    fixture=json.loads((ROOT/'knowledge'/'sophicore-upstream-reference-v3.json').read_text())
    case=fixture['cases'][case_index]
    c=copy.deepcopy(config); c['parameters']=case['parameters']; c['limbs']['pose']=case['pose']; c['head']['pose']=case['head']
    c=normalize_sophicore_config(c)
    joints=_joint_definitions(c); frames=_world_frames(joints)
    pivots={'base_link':[0,0,0], **{j['child']:[x/1000 for x in j['source']['pivot_mm']] for j in joints}}
    for mesh in case['meshes']:
        owner=_mesh_owner(mesh['id'],joints)
        if mesh['part'] and mesh['part']['stage']:
            joint=next(j for j in joints if j['source']['limb']==mesh['part']['limb'] and j['source']['stage']==mesh['part']['stage'])
            assert owner==joint['child']
        elif mesh['head_stage']:
            assert owner==('head_rotation_link' if mesh['head_stage']==1 else 'head_tilt_link')
        else: assert owner=='base_link'
        for sample in mesh['samples']:
            p=sample['source'] if c['parameters']==DEFAULTS else _deform_vertex(mesh['id'],*sample['source'],c['parameters'],mesh['center_x'])
            assert p==pytest.approx(sample['deformed'],abs=1e-8), (mesh['id'],'deformation')
            local=[p[i]/1000-pivots[owner][i] for i in range(3)]+[1]
            posed=[sum(frames[owner][r][k]*local[k] for k in range(4))*1000 for r in range(3)]
            assert posed==pytest.approx(sample['posed'],abs=2e-8), (mesh['id'],'kinematics')


def test_source_asymmetry_and_signed_axes_preserved(structure):
    joints={j['name']:j for j in structure['joints']}
    assert joints['arm_l_arm_twist']['source']['pivot_mm'][2]-joints['arm_r_arm_twist']['source']['pivot_mm'][2]==30
    assert joints['arm_r_shoulder_swing']['axis']==[0,-1,0]
    assert joints['arm_r_arm_twist']['axis']==[0,0,-1]
    assert joints['leg_l_elbow_bend']['axis']==[-1,0,0]
    assert joints['head_tilt']['axis']==[-1,0,0]
    assert joints['arm_r_wrist_rotation']['source']['pivot_mm']==[-320.480,-20.020,965.300]


def test_frozen_pose_selection_and_hash(config):
    c=copy.deepcopy(config); c['limbs']['pose']['arm_l']['elbow_bend']=30; c['head']['pose']['rotation']=15
    model=build_sophicore_model(c,'arm_l_elbow_bend')
    assert model['joint_position_offset']==pytest.approx(math.pi/6)
    assert model['held_positions']['head_rotation']==pytest.approx(math.pi/12)
    assert 'arm_l_elbow_bend' not in model['held_positions']
    assert len(model['held_positions'])==17
    assert validate_execution_model(model) is model
    assert model['model_sha256']==build_sophicore_model(c,'arm_l_elbow_bend')['model_sha256']
    assert model['model_sha256']!=build_sophicore_model(c,'head_rotation')['model_sha256']
    broken=copy.deepcopy(model); broken['held_positions']['head_rotation']=0
    with pytest.raises(ValueError,match='摘要'): validate_execution_model(broken)
    broken['model_sha256']=digest({k:v for k,v in broken.items() if k!='model_sha256'})
    with pytest.raises(ValueError,match='姿态'): validate_execution_model(broken)


@pytest.mark.parametrize('field,value',[('sourceSha256','other-model'),('parameters',{}),('limbs',{'pose':{'arm_l':{'elbow_bend':136}}})])
def test_invalid_source_and_joint_data_rejected(config,field,value):
    c=copy.deepcopy(config); c[field]=value
    with pytest.raises(ValueError): normalize_sophicore_config(c)


def test_foreign_leg_axis_is_not_silently_accepted(config):
    c=copy.deepcopy(config); c['limbs']['pose']['leg_l']['shoulder_swing']=2
    with pytest.raises(ValueError,match='腿部'): normalize_sophicore_config(c)


def test_does_not_return_mutable_cached_geometry(config):
    a=sophicore_structure(config); a['links'][0]['mesh_ids'].clear(); a['joints'][0]['axis'][0]=999
    b=sophicore_structure(config)
    assert b['links'][0]['mesh_ids']
    assert b['joints'][0]['axis']==[1,0,0]


def _external():
    return {'id':'imported','format':'urdf','content_sha256':'source-digest','source_url':'upload://robot.urdf',
        'links':[{'name':'base','visuals':[]},{'name':'arm','visuals':[{'type':'box','size':[.3,.04,.04],'xyz':[.15,0,0]}]}],
        'joints':[{'name':'elbow','type':'revolute','parent':'base','child':'arm','xyz':[0,0,.2],'rpy':[0,0,math.pi/4],
                   'axis':[0,0,2],'lower':-.5,'upper':1.2,'initial_position':.1}]}


def test_imported_urdf_joint_origin_source_limits_and_placeholder_preserved():
    model=build_execution_model(_external(),'elbow')
    assert model['joints'][0]['origin']['rpy']==[0,0,math.pi/4]
    assert model['joints'][0]['axis']==[0,0,1]
    assert model['source_sha256']=='source-digest'
    assert model['joint_position_offset']==.1
    assert model['links'][1]['inertial_source']=='numerical_placeholder_1kg_enclosing_box'
    assert validate_execution_model(model)


@pytest.mark.parametrize('change',[{'type':'fixed'},{'type':'prismatic'},{'mimic':{'joint':'other'}},{'axis':[0,0,0]},
    {'lower':None},{'initial_position':99},{'parent':'missing'},{'name':'bad/topic'}])
def test_invalid_or_unsupported_execution_joint_is_blocked(change):
    data=_external(); data['joints'][0].update(change)
    with pytest.raises(ValueError): build_execution_model(data,'elbow')


def test_disconnected_cycle_not_accepted():
    data=_external(); data['links'] += [{'name':'x','visuals':[]},{'name':'y','visuals':[]}]
    data['joints'] += [{'name':'xy','type':'fixed','parent':'x','child':'y'},{'name':'yx','type':'fixed','parent':'y','child':'x'}]
    with pytest.raises(ValueError,match='断开'): build_execution_model(data,'elbow')


def test_full_urdf_export_retains_selected_actual_name_and_no_collision(structure):
    model=build_execution_model(structure,'arm_l_elbow_bend'); xml=gen_urdf(model); robot=ET.fromstring(xml)
    assert len(robot.findall('link'))==20  # source 19 plus explicit fixed world
    assert len(robot.findall("joint[@type='revolute']"))==18
    assert robot.find("joint[@name='arm_l_elbow_bend']").find('axis').get('xyz')=='1 0 0'
    assert not robot.findall('.//collision')
    assert model['model_sha256'] in xml
    for link in model['links']:
        i=link['inertia']
        assert min(i['ixx'],i['iyy'],i['izz'])>0
        assert link['mass']==1 and 'placeholder' in link['inertial_source']


def test_legacy_sophicore_import_migration_preserves_source_identity(tmp_path, monkeypatch, config):
    from server import structures
    identifier = 'structure-' + 'b' * 24
    source = json.dumps(config, ensure_ascii=False)
    old = {'id':identifier, 'format':'sophicore-configuration',
           'content_sha256':'original-import-digest', 'filename':'my-sophicore.json',
           'source_content':source, 'joints':[], 'links':[]}
    folder = tmp_path / 'knowledge'
    folder.mkdir()
    path = folder / (identifier + '.json')
    path.write_text(json.dumps(old, ensure_ascii=False), encoding='utf-8')
    before = path.read_bytes()
    monkeypatch.setattr(structures, 'builtins', lambda root: [])
    def migrate(content, root):
        assert content == source and root == tmp_path
        return {'id':'sophicore-reference', 'format':'sophicore-kinematic',
                'content_sha256':'new-derived-kinematics-digest', 'filename':'default.json',
                'source_content':'normalized-source',
                'joints':[{'name':'arm_l_elbow_bend'}], 'links':[{'name':'base_link'}]}
    monkeypatch.setattr(structures, '_sophicore', migrate)

    item = structures.get_structure(tmp_path, identifier, include_source=True)
    for key in ('id', 'content_sha256', 'filename', 'source_content'):
        assert item[key] == old[key]
    assert item['format'] == 'sophicore-kinematic'
    assert item['joints'] == [{'name':'arm_l_elbow_bend'}]
    assert item['mesh_url'] == '/api/structures/' + identifier + '/mesh'
    listed = structures.list_structures(tmp_path)
    assert len(listed) == 1 and listed[0]['id'] == identifier
    assert 'source_content' not in listed[0]
    assert path.read_bytes() == before
