"""Opt-in V5 admission, approval and legacy invariants use the actual API."""
import copy
import importlib.util
from pathlib import Path
import threading
import time

import pytest
from fastapi.testclient import TestClient
from server.app import create_app
from server.store import specification, spec_hash
from server.intake_details import mapping_source_fingerprint
from test_motion_v5_spec import source, plan


@pytest.fixture
def client(tmp_path, monkeypatch):
    assert importlib.util.find_spec('server.motion_v5'), 'V5 admission is not implemented'
    from server import motion_v5
    monkeypatch.setattr(motion_v5, 'get_structure', lambda root, ident, **kwargs: source())
    with TestClient(create_app(tmp_path)) as c:
        yield c


def draft(root):
    p = plan(); p['model_source_sha256'] = mapping_source_fingerprint(root, source())
    return {'name':'多关节模拟', 'request':'按下列两个关节路点依次运动，再回到开始姿势。',
        'prd':{'intake':{'schema_version':2,'intent':'oscillate','mode':'simulation',
            'answers':{'board':'esp32','structure_id':'fixture','joint_name':'a'}, 'motion_plan':p}}}


def test_opt_in_program_is_not_flattened_to_v3_or_hidden_ab_fields(client):
    value = draft(client.app.state.jobs.root)
    response = client.post('/api/projects', json=value)
    assert response.status_code == 200, response.text
    p = response.json()
    assert p['pipeline_version'] == 5 and p['task_type'] == 'joint_sequence'
    assert p['intake_readiness']['can_plan']
    assert p['motion_program']['joint_names'] == ['a','b']
    assert p['communication']['identity']['program_sha256'] == p['motion_program']['program_sha256']
    stored = client.app.state.store.get('project', p['id'])
    s = specification(stored)
    assert s['pipeline_version'] == 5 and s['motion_program'] == p['motion_program']
    assert s['prd']['intake']['answers']['wave_start_rad'] is None


def test_unreviewed_or_changed_model_program_stays_a_draft(client):
    body = draft(client.app.state.jobs.root); body['prd']['intake']['motion_plan']['reviewed'] = False
    p = client.post('/api/projects', json=body).json()
    assert not p['intake_readiness']['can_plan'] and p['motion_program'] is None
    assert client.post('/api/projects/'+p['id']+'/plan').status_code == 409
    body['prd']['intake']['motion_plan'].update(reviewed=True, model_source_sha256='b'*64)
    q = client.post('/api/projects', json=body).json()
    assert not q['intake_readiness']['can_plan'] and q['intake_readiness']['invalid']


def test_plan_is_real_deterministic_provenance_and_approval_invalidates_on_change(client, monkeypatch):
    from server import providers
    monkeypatch.setattr(providers,'generate_plan',lambda *a,**k: pytest.fail('V5 template plan must not claim an AI call'))
    body = draft(client.app.state.jobs.root); p = client.post('/api/projects',json=body).json(); pid=p['id']
    assert client.post(f'/api/projects/{pid}/plan').status_code == 200
    for _ in range(100):
        p=client.get(f'/api/projects/{pid}').json()
        if p['status'] != 'planning': break
        time.sleep(.01)
    assert p['status']=='awaiting_approval',p.get('error')
    assert p['plan']['provenance']['kind']=='deterministic_motion_program'
    assert p['plan']['blocking_issues']==[]
    assert client.post(f'/api/projects/{pid}/run').status_code == 409
    approve=client.post(f'/api/projects/{pid}/approve',json={'spec_revision':p['spec_revision'],'plan_id':p['plan']['plan_id']})
    assert approve.status_code == 200,approve.text
    old=client.app.state.store.get('project',pid); old_hash=spec_hash(old)
    body['prd']['intake']['motion_plan']['waypoints'][0]['positions']=[.35,.4]
    updated=client.put(f'/api/projects/{pid}',json=body).json()
    assert updated['approval'] is None and updated['plan'] is None
    assert spec_hash(client.app.state.store.get('project',pid)) != old_hash


def test_extra_unreviewed_action_text_is_not_erased_by_adopting_motion_plan(client):
    body=draft(client.app.state.jobs.root)
    body['prd']['intake']['details']={'lifecycle':{'selection':'custom','start':'自动检测到人后再开始','finish':'放下','cancel':'保持'}}
    p=client.post('/api/projects',json=body).json()
    assert not p['intake_readiness']['can_plan']
    assert p['prd']['intake']['details']['lifecycle']['start']=='自动检测到人后再开始'


def test_legacy_record_still_has_version_three(client):
    body={'name':'旧任务','request':'让关节转到0.6rad','task_type':'joint_position'}
    p=client.post('/api/projects',json=body).json()
    assert p['pipeline_version']==3 and p['task_type']=='joint_position'
    assert 'motion_program' not in p


def test_explicit_recipe_source_record_roundtrips(client):
    body=draft(client.app.state.jobs.root); p=body['prd']['intake']['motion_plan']
    body['prd']['intake']['recommendation_bundle']={'schema_version':1,'records':[{
        'path':'prd.intake.motion_plan','label':'模型参考动作','value':p,'source':'model',
        'reason':'显式采纳已展示的模型路点','section':3,
        'basis':{'request_text':body['request'],'structure_id':'fixture','model_source_sha256':p['model_source_sha256']}}],
        'provenance':{'tool':'GET /api/motion-v5/recipe','model':'none','prompt':'explicit reference selection','response':'model reference','status':'returned'}}
    response=client.post('/api/projects',json=body)
    assert response.status_code==200,response.text
    assert response.json()['prd']['intake']['recommendation_bundle']['records'][0]['value']==p


def test_history_clone_preserves_v5_program_and_never_inherits_approval(client):
    body=draft(client.app.state.jobs.root);p=client.post('/api/projects',json=body).json()
    original=copy.deepcopy(p)
    history=client.get('/api/projects/'+p['id']+'/history').json()['items'][0]
    clone=client.post(f"/api/projects/{p['id']}/history/{history['id']}/clone")
    assert clone.status_code==200,clone.text
    q=clone.json()
    assert q['id']!=p['id'] and q['pipeline_version']==5
    assert q['motion_program']==p['motion_program']
    assert q['approval'] is None and q['plan'] is None and q['status']=='draft'
    assert client.get('/api/projects/'+p['id']).json()==original


def test_v5_bundle_import_is_new_draft_not_execution(client,monkeypatch):
    from test_lifecycle_v4 import bundle,body as import_body
    from server import structures
    monkeypatch.setattr(structures,'get_structure',lambda *a,**k:source())
    p=client.post('/api/projects',json=draft(client.app.state.jobs.root)).json()
    stored=client.app.state.store.get('project',p['id'])
    payload=import_body(bundle(specification(stored)))
    preview=client.post('/api/projects/import/preview',json=payload)
    assert preview.status_code==200,preview.text
    clone=client.post('/api/projects/import',json={**payload,'confirm':True,'preview_hash':preview.json()['preview_hash']})
    assert clone.status_code==200,clone.text
    q=clone.json()
    assert q['id']!=p['id'] and q['pipeline_version']==5 and q['motion_program']==p['motion_program']
    assert q['approval'] is None and q['plan'] is None and client.app.state.store.list('run')==[]


def test_old_action_repetition_count_cannot_be_silently_replaced(client):
    body=draft(client.app.state.jobs.root)
    body['prd']['intake']['action_draft']={'schema_version':1,'structure_id':'fixture','model_source_sha256':'c'*64,
        'summary':'往返三次','scope':'multi_joint','reference_joint':'a',
        'related_joints':[{'name':'a','label':'关节 A','role':'摆动','reason':'原始要求'}],
        'stages':[{'id':'wave','title':'往返三次','description':'做三次完整往返','joint_names':['a'],
            'repetitions':3,'target_rad':None,'confirmation_needed':False}],
        'end_pose_text':'回到开始姿势','unresolved':[],'requires_review':True}
    p=client.post('/api/projects',json=body).json()
    assert not p['intake_readiness']['can_plan']
    assert any('次数' in row['message'] for row in p['intake_readiness']['invalid'])
