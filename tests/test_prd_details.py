"""Detailed PRDs preserve new requirements without expanding the executor."""
import copy
import json

import pytest

from tests.test_prd_intake import client, ready
from server.store import spec_hash


GROUPS = ('motion', 'lifecycle', 'device_mapping', 'coordinates', 'communication', 'faults', 'acceptance', 'environment')


def detailed(confirmed=True):
    body = ready()
    body['prd']['intake']['schema_version'] = 2
    details = {}
    if confirmed:
        details = {key: {'selection': 'platform'} for key in GROUPS if key not in ('motion', 'device_mapping')}
        details.update(motion={'pattern': 'from_answers', 'completion': 'all'}, device_mapping={'scope': 'simulation_only'})
    body['prd']['intake']['details'] = details
    return body


def preview(client, body):
    response = client.post('/api/prd/preview', json=body)
    assert response.status_code == 200, response.text
    return response.json()


def assert_contains(actual, supplied):
    if isinstance(supplied, dict):
        for key, value in supplied.items():assert_contains(actual[key], value)
    elif isinstance(supplied, list):
        assert len(actual)==len(supplied)
        for item, value in zip(actual, supplied):assert_contains(item, value)
    else:assert actual==supplied


def test_v2_all_eight_groups_are_explicit_and_can_save_unconfirmed(client):
    body = detailed(False)
    result = preview(client, body)
    assert not result['can_plan'] and len(result['detail_coverage']) == 8
    assert {x['group'] for x in result['detail_coverage']} == set(GROUPS)
    assert all(x['status'] == 'missing' for x in result['detail_coverage'])
    saved = client.post('/api/projects', json=body)
    assert saved.status_code == 200, saved.text
    assert saved.json()['manifest'] is saved.json()['execution_model'] is None


def test_confirmed_v2_is_materialized_and_coverage_is_derived(client):
    p = client.post('/api/projects', json=detailed()).json()
    assert p['intake_readiness']['can_plan']
    assert all(x['status'] == 'confirmed' for x in p['intake_readiness']['detail_coverage'])
    assert len(p['intake_readiness']['summary']['details']) == 8
    assert p['parameters']['target'] == .5 and p['hardware']['physical_io'] is False
    stored = client.app.state.store.get('project', p['id'])
    assert 'intake_readiness' not in stored
    from server.intake import assert_intake_ready
    assert_intake_ready(client.app.state.jobs.root, stored)


@pytest.mark.parametrize('group,extra', [
    ('motion', {'pattern':'from_answers','completion':'all','completion_note':'动作完成后退回零位'}),
    ('lifecycle', {'selection':'platform','finish':'回到起点'}),
    ('coordinates', {'selection':'platform','conversion':'减速比100:1'}),
    ('communication', {'selection':'platform','rate_hz':50}),
    ('faults', {'selection':'platform','recovery':'自动重新启动'}),
    ('acceptance', {'selection':'platform','criteria':[{'id':'c1','metric':'延迟','expected':'10 ms以内','method':'计时'}]}),
    ('environment', {'selection':'platform','load_kg':0}),
    ('device_mapping', {'scope':'simulation_only','entries':[{'id':'m1','joint_name':'test_joint','device':'电机','interface':'CAN'}]}),
])
def test_switching_to_platform_never_hides_custom_requirements(client, group, extra):
    body = detailed(); body['prd']['intake']['details'][group] = extra
    result = preview(client, body)
    assert not result['can_plan']
    assert any(x['path'].startswith('prd.intake.details.'+group) for x in result['unsupported'])
    p = client.post('/api/projects', json=body).json()
    assert_contains(p['prd']['intake']['details'][group], extra)
    assert client.post('/api/projects/'+p['id']+'/plan').status_code == 409


@pytest.mark.parametrize('group', ['lifecycle','coordinates','communication','faults','acceptance','environment'])
def test_empty_custom_has_missing_and_unsupported(client, group):
    body = detailed();body['prd']['intake']['details'][group] = {'selection':'custom'}
    result = preview(client, body)
    assert any(x['path'].startswith('prd.intake.details.'+group) for x in result['missing'])
    assert any(x['path'].startswith('prd.intake.details.'+group) for x in result['unsupported'])


def test_step_order_and_conditions_saved_and_validated(client):
    body = detailed();body['prd']['intake']['details']['motion'] = {
        'pattern':'sequence','completion':'custom','completion_note':'所有关节都到位',
        'steps':[{'id':'first','kind':'move','joint_name':'test_joint','target_rad':0},
                 {'id':'second','kind':'wait','duration_s':0},
                 {'id':'third','kind':'condition','condition':'传感器为1','timeout_s':2,'on_failure':'结束任务'}]}
    p = client.post('/api/projects', json=body).json()
    assert [x['id'] for x in p['prd']['intake']['details']['motion']['steps']] == ['first','second','third']
    assert not p['intake_readiness']['can_plan']
    assert not p['intake_readiness']['invalid']
    body['prd']['intake']['details']['motion']['steps'][1]['duration_s'] = -1
    result = preview(client, body)
    assert any(x['path'].endswith('steps.1.duration_s') for x in result['invalid'])


def test_mapping_reference_requires_existing_joint_and_unique_address(client):
    source = client.get('/api/structures/builtin-joint').json()['mapping_source_sha256']
    body = detailed();row = {'id':'one','structure_id':'builtin-joint','source_sha256':source,'joint_name':'test_joint','device':'电机','interface':'CAN','address':'1','status':'documented','source':'手册第3页'}
    body['prd']['intake']['details']['device_mapping'] = {'scope':'reference_only','entries':[row]}
    result = preview(client, body)
    assert result['can_plan']
    assert next(x for x in result['detail_coverage'] if x['group']=='device_mapping')['status']=='reference_only'
    body['prd']['intake']['details']['device_mapping']['entries'].append({**row,'id':'two'})
    assert any('地址' in x['message'] for x in preview(client,body)['invalid'])
    body['prd']['intake']['details']['device_mapping']['entries']=[{**row,'joint_name':'removed','source':''}]
    result=preview(client,body)
    assert any('关节' in x['message'] for x in result['invalid'])
    assert any('出处' in x['message'] for x in result['missing'])


def test_structure_catalog_and_detail_expose_same_nonempty_mapping_fingerprint(client):
    catalog=client.get('/api/structures').json()['items']
    for identifier in ('builtin-joint','builtin-sensor'):
        row=next(item for item in catalog if item['id']==identifier)
        detail=client.get('/api/structures/'+identifier).json()
        assert len(row['mapping_source_sha256'])==64
        assert row['mapping_source_sha256']==detail['mapping_source_sha256']


@pytest.mark.parametrize('change', ['unknown_version','extra','boolean','nonfinite','duplicate'])
def test_structurally_invalid_v2_is_rejected(client,change):
    body=detailed();details=body['prd']['intake']['details']
    if change=='unknown_version':body['prd']['intake']['schema_version']=3
    elif change=='extra': details['faults']['execute_shell']='bad'
    elif change=='boolean': details['environment']['load_kg']=True
    elif change=='nonfinite':details['communication']['rate_hz']=float('nan')
    else: details['motion']['steps']=[{'id':'same','kind':'wait'},{'id':'same','kind':'wait'}]
    response=client.post('/api/projects',content=json.dumps(body),headers={'content-type':'application/json'})
    assert response.status_code==422,response.text
    assert client.app.state.store.list('project')==[]


def test_v2_cannot_downgrade_and_v1_read_remains_exact(client):
    old=client.post('/api/projects',json=ready()).json()
    stored=client.app.state.store.get('project',old['id']);fingerprint=spec_hash(stored)
    old['intake_readiness'].pop('detail_coverage',None)
    assert client.get('/api/projects/'+old['id']).json()==old
    assert client.app.state.store.get('project',old['id'])==stored and spec_hash(stored)==fingerprint
    assert 'details' not in stored['prd']['intake']
    upgraded=client.put('/api/projects/'+old['id'],json=detailed(False)).json()
    assert upgraded['prd']['intake']['schema_version']==2
    assert client.put('/api/projects/'+old['id'],json=ready()).status_code==409
    legacy={'name':'old','request':'legacy request','task_type':'joint_position'}
    assert client.put('/api/projects/'+old['id'],json=legacy).status_code==409
    before=client.app.state.store.get('project',old['id'])
    for invalid in (['bad'], 'bad', 7):
        malformed=detailed();malformed['prd']=invalid
        assert client.put('/api/projects/'+old['id'],json=malformed).status_code==422
    assert client.app.state.store.get('project',old['id'])==before


def test_v2_plan_coverage_requires_exact_eight_group_text(client):
    from server.requirements import source_fields,build_coverage,ITEM_SCHEMA
    p=client.post('/api/projects',json=detailed()).json()
    fields=source_fields(p)
    for group in GROUPS:
        key='prd.intake.details.'+group
        assert fields[key]==json.dumps(p['prd']['intake']['details'][group],ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False)
        assert key in ITEM_SCHEMA['properties']['source_field']['enum']
    supplied=[{'source_field':key,'text':text,'status':'manual_review','check_ids':[],'reason':'待人工核对'} for key,text in fields.items() if text.strip()]
    assert len(build_coverage(p,supplied)['items'])==12
    assert len(build_coverage(p,supplied)['blocking_issues'])==12
    with pytest.raises(ValueError):build_coverage(p,supplied[:-1])


def test_v1_manual_review_coverage_and_intake_are_unchanged(client):
    from server.requirements import build_coverage, source_fields
    p=client.post('/api/projects',json=ready()).json()
    assert len(source_fields(p))==4
    assert not build_coverage(p)['blocking_issues']
    assert 'detail_coverage' not in p['intake_readiness']


def test_v2_custom_requirement_blocks_all_gates_and_no_provider_called(client,monkeypatch):
    from server import providers
    def forbidden(*args,**kwargs):raise AssertionError('must not invoke AI')
    monkeypatch.setattr(providers,'generate_plan',forbidden)
    body=detailed();body['prd']['intake']['details']['communication']={'selection':'custom','transport':'CAN'}
    p=client.post('/api/projects',json=body).json();pid=p['id'];store=client.app.state.store
    assert client.post('/api/projects/'+pid+'/plan').status_code==409
    forged=store.get('project',pid);forged.update(status='awaiting_approval',plan={'plan_id':'forged','blocking_issues':[]})
    store.put('project',forged)
    assert client.post('/api/projects/'+pid+'/approve',json={'spec_revision':1,'plan_id':'forged'}).status_code==409
    forged.update(status='approved',approval={'spec_hash':spec_hash(forged)})
    store.put('project',forged)
    assert client.post('/api/projects/'+pid+'/run').status_code==409
    store.put('run',{'id':'forged-run','project_id':pid,'status':'failed'})
    assert client.post('/api/runs/forged-run/repair').status_code==409
    assert client.post('/api/runs/forged-run/deploy',json={'confirm':True}).status_code==409


def test_v2_unresolved_coverage_cannot_be_approved_even_if_old_blocking_array_empty(client):
    from server.requirements import source_fields
    p=client.post('/api/projects',json=detailed()).json();store=client.app.state.store
    stored=store.get('project',p['id']);digest=spec_hash(stored)
    items=[{'source_field':key,'text':text,'status':'manual_review','check_ids':[],'reason':'尚未覆盖'} for key,text in source_fields(stored).items() if text.strip()]
    stored.update(status='awaiting_approval',plan={'plan_id':'manual','spec_hash':digest,'requirement_items':items,'blocking_issues':[]})
    store.put('project',stored)
    response=client.post('/api/projects/'+p['id']+'/approve',json={'spec_revision':1,'plan_id':'manual'})
    assert response.status_code==409,response.text
    stored.update(status='approved',approval={'spec_hash':digest})
    store.put('project',stored)
    assert client.post('/api/projects/'+p['id']+'/run').status_code==409
    assert not store.list('run')


@pytest.mark.parametrize('group,key,value', [('communication','rate_hz',0),('communication','timeout_ms',-1),('environment','load_kg',-1)])
def test_invalid_numeric_requirements_are_preserved_as_drafts(client,group,key,value):
    body=detailed();body['prd']['intake']['details'][group]={'selection':'custom',key:value}
    p=client.post('/api/projects',json=body).json()
    assert p['prd']['intake']['details'][group][key]==value
    assert any(x['path'].endswith('.'+key) for x in p['intake_readiness']['invalid'])


def test_incomplete_criterion_and_conditional_step_have_precise_missing_paths(client):
    body=detailed();body['prd']['intake']['details']['acceptance']={'selection':'custom','criteria':[{'id':'c1','metric':'延迟'}]}
    body['prd']['intake']['details']['motion']={'pattern':'parallel','completion':'custom','steps':[{'id':'s1','kind':'condition'}]}
    result=preview(client,body);paths={x['path']:x['section'] for x in result['missing']}
    assert paths['prd.intake.details.acceptance.criteria.0.method']==5
    assert paths['prd.intake.details.motion.steps.0.condition']==3
    assert paths['prd.intake.details.motion.completion_note']==3


def test_sophicore_alias_mapping_freezes_without_rewriting_rows(client,tmp_path,monkeypatch):
    import os,shutil
    from pathlib import Path
    from server.intake import assert_intake_ready
    source=Path(__file__).resolve().parents[1]/'knowledge'
    knowledge=tmp_path/'knowledge';knowledge.mkdir(exist_ok=True)
    for filename in ('sophicore-model.json','sophicore-default-configuration.json'):
        try:os.link(source/filename,knowledge/filename)
        except OSError:shutil.copyfile(source/filename,knowledge/filename)
    original=client.get('/api/structures/sophicore-reference').json()
    body=detailed();body['prd']['intake']['answers'].update(structure_id='sophicore-reference',joint_name='arm_l_shoulder_swing',target_rad=.2)
    row={'id':'one','structure_id':'sophicore-reference','source_sha256':original['mapping_source_sha256'],
         'joint_name':'arm_l_shoulder_swing','device':'参考电机','interface':'CAN'}
    body['prd']['intake']['details']['device_mapping']={'scope':'reference_only','entries':[row]}
    response=client.post('/api/projects',json=body)
    assert response.status_code==200,response.text
    p=response.json();assert p['intake_readiness']['can_plan']
    assert_contains(p['prd']['intake']['details']['device_mapping']['entries'][0],row)
    frozen=client.get('/api/structures/'+p['structure']['id']).json()
    assert frozen['content_sha256']!=original['content_sha256']
    assert frozen['mapping_source_sha256']==original['mapping_source_sha256']
    assert_intake_ready(tmp_path,client.app.state.store.get('project',p['id']))
    # Import/restore may retain the historical alias name while the exact source
    # is now available only under its frozen ID. Resolve by approved source hash.
    from server import intake_details
    original_get=intake_details.get_structure
    def missing_alias(root, identifier, **kwargs):
        if identifier=='sophicore-reference':raise ValueError('historical alias unavailable')
        return original_get(root,identifier,**kwargs)
    with monkeypatch.context() as patch:
        patch.setattr(intake_details,'get_structure',missing_alias)
        assert_intake_ready(tmp_path,client.app.state.store.get('project',p['id']))
    # A second configuration shares upstream source_sha256 but must not share a
    # mapping identity. Both the stale row and the shared upstream hash fail.
    config=json.loads((knowledge/'sophicore-default-configuration.json').read_text(encoding='utf-8-sig'))
    config['parameters']['upper_arm_length']+=10
    changed=client.post('/api/structures',json={'filename':'changed.json','content':json.dumps(config)}).json()
    assert changed['source_sha256']==original['source_sha256']
    assert changed['mapping_source_sha256']!=original['mapping_source_sha256']
    body['prd']['intake']['answers']['structure_id']=changed['id']
    result=preview(client,body)
    assert not result['can_plan'] and any('来源不同' in x['message'] for x in result['invalid'])
    row['structure_id']=changed['id'];row['source_sha256']=changed['source_sha256']
    result=preview(client,body)
    assert not result['can_plan'] and any('指纹' in x['message'] for x in result['invalid'])
    row['source_sha256']=changed['mapping_source_sha256']
    assert preview(client,body)['can_plan']
    body['prd']['intake']['answers']['joint_name']='arm_r_shoulder_swing'
    result=preview(client,body)
    assert not result['can_plan'] and any('主关节' in x['message'] for x in result['invalid'])


def test_v2_details_survive_clone_and_zip_import(client):
    import base64,io,zipfile
    from server.store import specification
    body=detailed();body['prd']['intake']['details']['lifecycle']={'selection':'custom','finish':'返回起点'}
    p=client.post('/api/projects',json=body).json()
    history=client.get('/api/projects/'+p['id']+'/history').json()['items'][0]
    cloned=client.post(f'/api/projects/{p["id"]}/history/{history["id"]}/clone').json()
    assert cloned['prd']['intake']['details']==p['prd']['intake']['details']
    payload=io.BytesIO()
    with zipfile.ZipFile(payload,'w') as archive:archive.writestr('spec.json',json.dumps(specification(p)))
    upload={'filename':'details.zip','content_base64':base64.b64encode(payload.getvalue()).decode()}
    before=client.post('/api/projects/import/preview',json=upload)
    assert before.status_code==200,before.text
    imported=client.post('/api/projects/import',json={**upload,'confirm':True,'preview_hash':before.json()['preview_hash']})
    assert imported.status_code==200,imported.text
    assert imported.json()['prd']['intake']['details']==p['prd']['intake']['details']
