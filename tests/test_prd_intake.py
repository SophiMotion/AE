"""PRD drafts are data, never an implicit expansion of executable capability."""
import copy
import math
import os
from pathlib import Path
import shutil

import pytest
from fastapi.testclient import TestClient

from server.app import create_app
from server.schemas import ProjectInput
from server.store import spec_hash


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path)) as value:
        yield value


def draft(intent=None, mode='simulation', **answers):
    return {'name': '引导测试', 'request': '按已选要求验证关节控制',
            'prd': {'intake': {'schema_version': 1, 'mode': mode, 'intent': intent, 'answers': answers}}}


def ready():
    return draft('position', structure_id='builtin-joint', joint_name='test_joint', board='esp32',
                 target_rad=0.5, tolerance_rad=0.04, max_velocity_rad_s=0.8, duration_s=8)


def test_empty_preview_and_draft_save_preserve_missing_values(client):
    value = {'name': '', 'request': '', 'prd': {'intake': {}}}
    preview = client.post('/api/prd/preview', json=value)
    assert preview.status_code == 200, preview.text
    assert preview.json()['status'] == 'incomplete' and not preview.json()['can_plan']
    assert client.app.state.store.list('project') == []
    saved = client.post('/api/projects', json=value)
    assert saved.status_code == 200, saved.text
    p = saved.json()
    assert p['name'] == p['request'] == ''
    assert p['prd']['intake']['answers']['target_rad'] is None
    assert p['prd']['intake']['answers']['joint_name'] is None
    assert p['execution_model'] is p['manifest'] is None
    assert client.get('/api/projects/'+p['id']).json()['intake_readiness'] == p['intake_readiness']
    assert 'intake_readiness' not in client.app.state.store.get('project', p['id'])


def test_supported_answers_are_only_source_of_execution_fields(client):
    body = ready()
    body.update(task_type='sensor_threshold', parameters={'target': 999, 'threshold': -900}, hardware={'board': 'esp32s3'})
    body['prd'].update(structure_id='not-selected', joint_name='not-selected')
    r = client.post('/api/projects', json=body)
    assert r.status_code == 200, r.text
    p = r.json()
    assert p['intake_readiness']['can_plan']
    assert p['task_type'] == 'joint_position' and p['parameters']['target'] == .5
    assert p['hardware']['board'] == 'esp32' and p['hardware']['physical_io'] is False
    assert p['execution_model']['selected_joint'] == 'test_joint'
    assert p['prd']['structure_id'] == 'builtin-joint'


@pytest.mark.parametrize('intent,mode', [('oscillate','simulation'), ('other','simulation'), ('position','hardware_notes'), (None,'simulation')])
def test_unsupported_or_missing_intent_cannot_enter_any_execution_gate(client, intent, mode):
    body = ready();body['prd']['intake'].update(intent=intent, mode=mode)
    body['task_type'] = 'joint_position'
    r = client.post('/api/projects', json=body)
    assert r.status_code == 200, r.text
    p = r.json();pid=p['id']
    assert not p['intake_readiness']['can_plan']
    assert p['manifest'] is p['execution_model'] is None
    assert client.post(f'/api/projects/{pid}/plan').status_code == 409
    store = client.app.state.store
    forged = store.get('project', pid)
    forged.update(status='awaiting_approval', plan={'plan_id':'forged','blocking_issues':[]})
    store.put('project', forged)
    assert client.post(f'/api/projects/{pid}/approve', json={'spec_revision':1,'plan_id':'forged'}).status_code == 409
    forged.update(status='approved', approval={'spec_hash':'forged'})
    store.put('project', forged)
    assert client.post(f'/api/projects/{pid}/run').status_code == 409
    assert store.list('run') == []


def test_unselected_joint_is_never_filled_with_default(client):
    value=ready();value['prd']['intake']['answers']['joint_name']=None
    p=client.post('/api/projects',json=value).json()
    assert not p['intake_readiness']['can_plan'] and p['prd']['joint_name'] is None
    assert any(x['path'].endswith('joint_name') for x in p['intake_readiness']['missing'])


def test_sensor_does_not_require_hidden_joint_fields(client):
    body=draft('threshold',board='esp32s3',threshold=.4,duration_s=9,target_rad=None,tolerance_rad=None,
               structure_id='removed-hidden-structure',joint_name='removed-hidden-joint')
    p=client.post('/api/projects',json=body).json()
    assert p['intake_readiness']['can_plan']
    assert p['task_type']=='sensor_threshold' and p['parameters']['threshold']==.4
    assert p['execution_model'] is None and p['manifest']


def test_out_of_range_values_are_saved_as_invalid_drafts(client):
    body=ready();body['prd']['intake']['answers']['target_rad']=100
    r=client.post('/api/projects',json=body)
    assert r.status_code==200,r.text
    assert not r.json()['intake_readiness']['can_plan']
    assert r.json()['prd']['intake']['answers']['target_rad']==100
    assert r.json()['intake_readiness']['invalid']


def test_readiness_does_not_mutate_legacy_project_or_hash(client):
    body={'name':'旧工程','request':'让关节到指定角度','task_type':'joint_position'}
    p=client.post('/api/projects',json=body).json()
    before=client.app.state.store.get('project',p['id']);digest=spec_hash(before)
    r=client.get('/api/projects/'+p['id']).json()
    assert 'intake_readiness' not in r and 'intake' not in r['prd']
    assert client.app.state.store.get('project',p['id'])==before
    assert spec_hash(before)==digest
    assert ProjectInput(**body).parameters.target==.6


def test_unfinished_history_clone_keeps_intent_and_blanks(client):
    body=draft('oscillate',board=None,wave_start_rad=None,wave_end_rad=.5)
    p=client.post('/api/projects',json=body).json()
    history=client.get('/api/projects/'+p['id']+'/history').json()['items'][0]
    r=client.post(f'/api/projects/{p["id"]}/history/{history["id"]}/clone')
    assert r.status_code==200,r.text
    cloned=r.json()
    assert cloned['prd']['intake']['intent']=='oscillate'
    assert cloned['prd']['intake']['answers']['wave_start_rad'] is None
    assert cloned['approval'] is None and not cloned['intake_readiness']['can_plan']


@pytest.mark.parametrize('bad', [True, '0.6'])
def test_numeric_answers_reject_non_numbers(client,bad):
    body=ready();body['prd']['intake']['answers']['target_rad']=bad
    assert client.post('/api/projects',json=body).status_code==422


@pytest.mark.parametrize('bad', [math.nan, math.inf, -math.inf])
def test_nonfinite_numbers_never_reach_storage(client,bad):
    import json
    body=ready();body['prd']['intake']['answers']['target_rad']=bad
    r=client.post('/api/projects',content=json.dumps(body),headers={'content-type':'application/json'})
    assert r.status_code==422
    assert not client.app.state.store.list('project')


def test_preview_does_not_write_structure_or_call_ai(client,monkeypatch):
    from server import providers, structures
    def forbidden(*args, **kwargs):
        raise AssertionError('preview must not call this')
    monkeypatch.setattr(structures,'ingest_structure',forbidden)
    monkeypatch.setattr(structures,'attach_structure',forbidden)
    monkeypatch.setattr(providers,'generate_plan',forbidden)
    r=client.post('/api/prd/preview',json=ready())
    assert r.status_code==200 and r.json()['can_plan']
    assert not client.app.state.store.list('project') and not client.app.state.store.list('run')


def test_suggestion_origin_tracks_current_value_and_rad_is_exact(client):
    body=ready();body['prd']['intake']['accepted_suggestions']=['answers.target_rad','answers.duration_s']
    body['prd']['intake']['answers']['target_rad']=.6
    first=client.post('/api/prd/preview',json=body).json()
    by_path={x['path']:x for x in first['resolved']}
    assert by_path['prd.intake.answers.target_rad']['origin']=='suggested'
    body['prd']['intake']['answers']['target_rad']=math.pi/6
    p=client.post('/api/projects',json=body).json()
    assert p['parameters']['target']==math.pi/6
    assert next(x for x in p['intake_readiness']['resolved'] if x['path'].endswith('target_rad'))['origin']=='user'


def test_hardware_notes_never_change_virtual_execution(client):
    body=ready();body['prd']['intake']['hardware_notes']={
        'board_model':{'value':'unverified board','status':'provided'},
        'wiring':{'value':'GPIO99','source':'user note','status':'documented'}}
    p=client.post('/api/projects',json=body).json()
    assert p['hardware']['physical_io'] is False and p['manifest']['modules'][3]['pins'] is None
    assert p['hardware']['actuator']=='virtual_joint'
    body['prd']['intake']['hardware_notes']['wiring']['source']=''
    bad=client.post('/api/projects',json=body).json()
    assert not bad['intake_readiness']['can_plan']
    assert any(x['path'].endswith('wiring') for x in bad['intake_readiness']['invalid'])


def test_modified_answer_invalidates_approval_and_clears_derived_model(client):
    p=client.post('/api/projects',json=ready()).json();pid=p['id']
    store=client.app.state.store
    old=store.get('project',pid);old.update(status='approved',approval={'spec_hash':spec_hash(old)},plan={'plan_id':'old'})
    store.put('project',old)
    body=ready();body['prd']['intake']['answers']['target_rad']=None
    updated=client.put('/api/projects/'+pid,json=body).json()
    assert updated['approval'] is None and updated['plan'] is None
    assert updated['execution_model'] is updated['manifest'] is None
    assert client.post('/api/projects/'+pid+'/run').status_code==409


def test_stored_carrier_tampering_cannot_bypass_answer_gate(client):
    p=client.post('/api/projects',json=ready()).json();store=client.app.state.store
    p=store.get('project',p['id']);p['parameters']['target']=.9
    store.put('project',p)
    assert client.post('/api/projects/'+p['id']+'/plan').status_code==409
    assert not store.list('run')


def test_pending_draft_cannot_deploy_old_run(client):
    p=client.post('/api/projects',json=draft('oscillate')).json()
    client.app.state.store.put('run',{'id':'blocked-deploy','project_id':p['id'],'status':'passed'})
    r=client.post('/api/runs/blocked-deploy/deploy',json={'confirm':True})
    assert r.status_code==409 and '需求' in r.json()['detail']


def test_issue_sections_match_visible_controls(client):
    body=ready();body['prd']['intake']['mode']=None
    body['prd']['intake']['answers'].update(tolerance_rad=None,duration_s=None)
    result=client.post('/api/prd/preview',json=body).json()
    sections={x['path']:x['section'] for x in result['missing']}
    assert sections['prd.intake.mode']==4
    assert sections['prd.intake.answers.tolerance_rad']==3
    assert sections['prd.intake.answers.duration_s']==3


def test_intake_export_import_preserves_selected_source_and_rechecks(client):
    import base64,io,json,zipfile
    from server.store import specification
    p=client.post('/api/projects',json=ready()).json()
    payload=io.BytesIO()
    with zipfile.ZipFile(payload,'w') as archive:
        archive.writestr('spec.json',json.dumps(specification(p)))
    body={'filename':'guided.zip','content_base64':base64.b64encode(payload.getvalue()).decode()}
    r=client.post('/api/projects/import/preview',json=body)
    assert r.status_code==200,r.text
    imported=client.post('/api/projects/import',json={**body,'confirm':True,'preview_hash':r.json()['preview_hash']})
    assert imported.status_code==200,imported.text
    value=imported.json()
    assert value['prd']['intake']['answers']['joint_name']=='test_joint'
    assert value['parameters']['target']==.5 and value['approval'] is None
    assert value['intake_readiness']['can_plan']


def test_sophicore_alias_is_frozen_and_immediately_admitted(client,tmp_path,monkeypatch):
    from server.intake import assert_intake_ready
    from server import structures
    source=Path(__file__).resolve().parents[1]/'knowledge'
    knowledge=tmp_path/'knowledge';knowledge.mkdir(exist_ok=True)
    for filename in ('sophicore-model.json','sophicore-default-configuration.json'):
        if not (source/filename).is_file():
            pytest.skip('local Sophicore assets are not available')
        try:
            os.link(source/filename,knowledge/filename)
        except OSError:
            shutil.copyfile(source/filename,knowledge/filename)
    body=ready();body['prd']['intake']['answers'].update(structure_id='sophicore-reference',joint_name='arm_l_shoulder_swing',target_rad=.2)
    r=client.post('/api/projects',json=body)
    assert r.status_code==200,r.text
    saved=client.app.state.store.get('project',r.json()['id'])
    assert saved['prd']['intake']['answers']['structure_id']==saved['structure']['id']
    assert saved['structure']['id'].startswith('structure-')
    def do_not_write(*args,**kwargs):
        raise AssertionError('admission after saving must not ingest a model')
    monkeypatch.setattr(structures,'ingest_structure',do_not_write)
    assert_intake_ready(tmp_path,saved)
    assert client.get('/api/projects/'+saved['id']).json()['intake_readiness']['can_plan']


def test_legacy_single_joint_oscillation_still_requires_its_visible_fields(client):
    body = ready()
    body['prd']['intake']['intent'] = 'oscillate'
    result = client.post('/api/prd/preview', json=body).json()
    paths = {row['path'].removeprefix('prd.intake.answers.') for row in result['missing']}
    assert {'wave_start_rad', 'wave_end_rad', 'repetitions', 'dwell_s', 'end_behavior'} <= paths
    assert not result['can_plan']
    body['prd']['intake']['answers'].update(wave_start_rad=0, wave_end_rad=.5,
        repetitions=3, dwell_s=0, end_behavior='custom', end_position_rad=None)
    result = client.post('/api/prd/preview', json=body).json()
    assert any(x['path'].endswith('end_position_rad') for x in result['missing'])
    assert not any(x['path'].endswith(('wave_start_rad', 'dwell_s')) for x in result['missing'])


def test_legacy_position_target_remains_required(client):
    body = ready()
    body['prd']['intake']['answers']['target_rad'] = None
    result = client.post('/api/prd/preview', json=body).json()
    assert any(x['path'] == 'prd.intake.answers.target_rad' for x in result['missing'])
    assert not result['can_plan']
