"""Rule recommendations are conservative draft suggestions, not execution."""
import copy
import json
import math

import pytest

from tests.test_prd_intake import client, ready
from tests.test_prd_details import detailed
from server.store import spec_hash


def body(text, intent=None, selected=True):
    return {'name':'','request':text,'prd':{'use_case':'','intake':{'schema_version':2,'intent':intent,
            'answers':{'structure_id':'builtin-joint' if selected else None,'joint_name':'test_joint' if selected else None}}}}


def recommend(client, draft):
    response=client.post('/api/prd/recommendations',json=draft)
    assert response.status_code==200,response.text
    return response.json()


def rows(result):return {row['path']:row for row in result['suggestions']}
def answer(result,key):return rows(result)['prd.intake.answers.'+key]


def adopt(draft,result):
    value=copy.deepcopy(draft)
    for row in result['suggestions']:
        target=value;path=row['path'].split('.')
        for key in path[:-1]:target=target.setdefault(key,{})
        target[path[-1]]=row['value']
    value['prd']['intake']['recommendation_records']=result['suggestions']
    return value


def test_wave_request_extracts_units_and_chinese_count_without_executing(client):
    draft=body('让关节在30度和60度之间来回摆动三次，端点停留0.3秒，最高速度30度/秒，误差2度。')
    result=recommend(client,draft)
    assert rows(result)['prd.intake.intent']['value']=='oscillate'
    assert answer(result,'repetitions')['value']==3 and answer(result,'repetitions')['source']=='request'
    assert answer(result,'wave_start_rad')['value']==pytest.approx(math.pi/6)
    assert answer(result,'wave_end_rad')['value']==pytest.approx(math.pi/3)
    assert answer(result,'max_velocity_rad_s')['value']==pytest.approx(math.pi/6)
    assert answer(result,'dwell_s')['value']==.3
    assert draft['prd']['intake']['intent'] is None
    saved=client.post('/api/projects',json=adopt(draft,result)).json()
    assert saved['prd']['intake']['intent']=='oscillate'
    assert not saved['intake_readiness']['can_plan']
    assert not client.app.state.store.list('run')


def test_request_required_v2_required_and_preview_is_read_only(client,monkeypatch):
    assert client.post('/api/prd/recommendations',json=ready()).status_code==422
    assert client.post('/api/prd/recommendations',json=body('')).status_code==422
    from server import structures,providers
    def forbidden(*a,**k):raise AssertionError('recommendation must be read-only')
    monkeypatch.setattr(structures,'attach_structure',forbidden)
    monkeypatch.setattr(structures,'ingest_structure',forbidden)
    monkeypatch.setattr(providers,'generate_plan',forbidden)
    recommend(client,body('让关节来回摆动'))
    assert not client.app.state.store.list('project') and not client.app.state.store.list('run')


def test_examples_never_fill_unknown_hardware_model_or_platform_confirmations(client):
    draft=body('来回招手',selected=False)
    result=recommend(client,draft);paths=set(rows(result))
    assert 'prd.intake.intent' in paths
    assert not any(any(token in path for token in ('board','mode','joint_name','structure_id','details','hardware')) for path in paths)
    assert not any(path.endswith(('_start_rad','_end_rad','target_rad')) for path in paths)
    assert answer(result,'repetitions')['source']=='example'
    assert answer(result,'max_velocity_rad_s')['value']==pytest.approx(math.pi/6)
    assert any('关节' in item['reason'] for item in result['not_filled'])


@pytest.mark.parametrize('text', ['不要转到90度','先转到30度再转到60度','不要超过20度，来回摆动','速度不是30度/秒，来回摆动','不到3次不要停，来回摆动'])
def test_negated_conditional_or_multitask_requirements_do_not_fall_back_to_examples(client,text):
    result=recommend(client,body(text))
    assert not any(path.startswith('prd.intake.answers.') for path in rows(result))
    assert result['warnings'] and result['not_filled']


def test_existing_values_including_zero_are_kept_and_conflict_is_reported(client):
    draft=body('在30度和60度之间来回三次',intent='oscillate')
    draft['prd']['intake']['answers'].update(wave_start_rad=0,repetitions=5,dwell_s=0)
    result=recommend(client,draft)
    assert not {'prd.intake.answers.'+key for key in ('wave_start_rad','repetitions','dwell_s')} & set(rows(result))
    assert any('已有' in warning or '冲突' in warning for warning in result['warnings'])


def test_single_endpoint_uses_existing_value_and_out_of_range_blocks_pair(client):
    draft=body('来回摆动',intent='oscillate');draft['prd']['intake']['answers']['wave_start_rad']=1.2
    result=recommend(client,draft)
    assert 'prd.intake.answers.wave_start_rad' not in rows(result)
    assert answer(result,'wave_end_rad')['value']!=1.2
    draft['prd']['intake']['answers']['wave_start_rad']=100
    assert 'prd.intake.answers.wave_end_rad' not in rows(recommend(client,draft))


def test_explicit_angle_outside_model_range_is_not_replaced_by_example(client):
    result=recommend(client,body('转到300度',intent='position'))
    assert 'prd.intake.answers.target_rad' not in rows(result)
    assert any('范围' in item['reason'] for item in result['not_filled'])


def test_ms_and_speed_cannot_be_misread_as_angle_or_seconds(client):
    result=recommend(client,body('来回摆动，端点停留300ms，最高速度30度/秒，观察时长1000ms',intent='oscillate'))
    assert answer(result,'dwell_s')['value']==.3
    assert 'prd.intake.answers.duration_s' not in rows(result)
    assert answer(result,'wave_start_rad')['source']=='example'
    assert answer(result,'max_velocity_rad_s')['source']=='request'


def test_unitless_value_is_not_silently_replaced_by_an_example(client):
    result=recommend(client,body('转到30，速度20',intent='position'))
    assert 'prd.intake.answers.target_rad' not in rows(result)
    assert 'prd.intake.answers.max_velocity_rad_s' not in rows(result)


def test_old_intakes_serialization_and_read_hash_are_unchanged(client):
    from server.schemas import parse_project_input
    for draft in (ready(),detailed()):
        parsed=parse_project_input(draft).model_dump()
        assert 'recommendation_records' not in parsed['prd']['intake']
        p=client.post('/api/projects',json=draft).json();store=client.app.state.store
        before=store.get('project',p['id']);digest=spec_hash(before)
        assert client.get('/api/projects/'+p['id']).json()==p
        assert store.get('project',p['id'])==before and spec_hash(before)==digest


def test_matching_records_show_source_and_changed_context_is_stale(client):
    draft=body('转到30度',intent='position');value=adopt(draft,recommend(client,draft))
    first=client.post('/api/prd/preview',json=value).json()
    target=next(x for x in first['resolved'] if x['path']=='prd.intake.answers.target_rad')
    assert target['origin']=='suggested' and '从需求提取' in target['source_ref']
    value['request']='现在仍到目标位置但负载另行确认'
    stale=client.post('/api/prd/preview',json=value).json()
    assert '先前建议' in next(x for x in stale['resolved'] if x['path']=='prd.intake.answers.target_rad')['source_ref']
    value['prd']['intake']['answers']['target_rad']=.7
    modified=client.post('/api/prd/preview',json=value).json()
    target=next(x for x in modified['resolved'] if x['path']=='prd.intake.answers.target_rad')
    assert target['origin']=='user'


@pytest.mark.parametrize('bad', ['bool','nan','path','duplicate'])
def test_invalid_recommendation_records_rejected(client,bad):
    draft=body('转到30度',intent='position');result=recommend(client,draft);value=adopt(draft,result)
    record=value['prd']['intake']['recommendation_records'][0]
    if bad=='bool':record['value']=True
    elif bad=='nan':record['value']=float('nan')
    elif bad=='path':record['path']='prd.intake.hardware_notes.wiring'
    else:value['prd']['intake']['recommendation_records'].append(copy.deepcopy(record))
    r=client.post('/api/projects',content=json.dumps(value),headers={'content-type':'application/json'})
    assert r.status_code==422,r.text


def test_all_filled_draft_has_no_changes(client):
    draft=body('转到30度',intent='position')
    draft=adopt(draft,recommend(client,draft))
    assert recommend(client,draft)['suggestions']==[]


def test_duration_estimate_includes_wave_route_but_does_not_replace_user_time(client):
    draft=body('来回摆动',intent='oscillate');draft['prd']['intake']['answers'].update(wave_start_rad=0,wave_end_rad=2,repetitions=10,max_velocity_rad_s=.1,dwell_s=1,duration_s=4)
    result=recommend(client,draft)
    assert 'prd.intake.answers.duration_s' not in rows(result)
    assert any('时长' in warning for warning in result['warnings'])


@pytest.mark.parametrize('count',['-3','3.5','1e2'])
def test_invalid_or_unsupported_count_is_not_partially_parsed(client,count):
    result=recommend(client,body('来回摆动'+count+'次',intent='oscillate'))
    assert 'prd.intake.answers.repetitions' not in rows(result)


def test_unassigned_wave_angle_is_not_overridden_with_endpoints(client):
    result=recommend(client,body('来回摆动20度',intent='oscillate'))
    assert 'prd.intake.answers.wave_start_rad' not in rows(result)
    assert 'prd.intake.answers.wave_end_rad' not in rows(result)


def test_huge_integer_record_returns_422(client):
    draft=body('来回摆动',intent='oscillate');value=adopt(draft,recommend(client,draft))
    record=next(x for x in value['prd']['intake']['recommendation_records'] if x['path'].endswith('repetitions'))
    record['value']=10**400
    assert client.post('/api/projects',json=value).status_code==422


def test_record_survives_save_clone_import_and_other_edits(client):
    import base64,io,zipfile
    from server.store import specification
    draft=adopt(body('来回摆动三次',intent='oscillate'),recommend(client,body('来回摆动三次',intent='oscillate')))
    p=client.post('/api/projects',json=draft).json()
    original=p['prd']['intake']['recommendation_records']
    history=client.get('/api/projects/'+p['id']+'/history').json()['items'][0]
    clone=client.post(f'/api/projects/{p["id"]}/history/{history["id"]}/clone').json()
    assert clone['prd']['intake']['recommendation_records']==original
    payload=io.BytesIO()
    with zipfile.ZipFile(payload,'w') as archive:archive.writestr('spec.json',json.dumps(specification(p)))
    upload={'filename':'recommendation.zip','content_base64':base64.b64encode(payload.getvalue()).decode()}
    preview=client.post('/api/projects/import/preview',json=upload)
    assert preview.status_code==200,preview.text
    imported=client.post('/api/projects/import',json={**upload,'confirm':True,'preview_hash':preview.json()['preview_hash']})
    assert imported.status_code==200,imported.text
    assert imported.json()['prd']['intake']['recommendation_records']==original
    draft['prd']['intake']['answers']['board']='esp32s3'
    saved=client.put('/api/projects/'+p['id'],json=draft).json()
    assert saved['prd']['intake']['recommendation_records']==original


def test_narrow_joint_range_cannot_create_identical_endpoints(client):
    urdf='<robot name="tiny"><link name="base"/><link name="arm"/><joint name="tiny" type="revolute"><parent link="base"/><child link="arm"/><axis xyz="0 0 1"/><limit lower="0" upper="0.001" effort="1" velocity="1"/></joint></robot>'
    model=client.post('/api/structures',json={'filename':'tiny.urdf','content':urdf}).json()
    draft=body('来回摆动',intent='oscillate');draft['prd']['intake']['answers'].update(structure_id=model['id'],joint_name='tiny')
    result=recommend(client,draft)
    assert not {'prd.intake.answers.wave_start_rad','prd.intake.answers.wave_end_rad'} & set(rows(result))
    assert any('太窄' in x['reason'] for x in result['not_filled'])


@pytest.mark.parametrize('text',[
    '转到30度，然后回到0度',
    '在30度和60度之间来回摆动三次，再到90度',
    '左肩来回摆动三次，右肩也来回摆动三次',
    '不想转到30度',
    '禁止转到30度',
])
def test_sequences_multiple_targets_and_other_negations_are_not_simplified(client,text):
    result=recommend(client,body(text))
    assert not any(path.startswith('prd.intake.answers.') for path in rows(result))
    assert result['warnings']


@pytest.mark.parametrize('ending',[
    '完成后停在30度',
    '最后停在哪里还没确定',
    '结束后回到初始位置',
])
def test_mentioned_unresolved_ending_does_not_default_to_endpoint_a(client,ending):
    result=recommend(client,body('来回摆动三次，'+ending,intent='oscillate'))
    assert 'prd.intake.answers.end_behavior' not in rows(result)
    assert any(x['path']=='prd.intake.answers.end_behavior' for x in result['not_filled'])


def test_speed_per_second_and_short_stop_expression_keep_request_source(client):
    result=recommend(client,body('在30度和60度之间来回摆动三次，每到一个位置停0.5秒，最快每秒20度',intent='oscillate'))
    assert answer(result,'max_velocity_rad_s')['value']==pytest.approx(math.radians(20))
    assert answer(result,'max_velocity_rad_s')['source']=='request'
    assert answer(result,'dwell_s')['value']==.5
    assert answer(result,'dwell_s')['source']=='request'
    result=recommend(client,body('来回摆动三次，停留300MS，最快每秒30度',intent='oscillate'))
    assert answer(result,'dwell_s')['value']==.3
    assert answer(result,'wave_start_rad')['source']=='example'


@pytest.mark.parametrize('text',['模拟温度阈值0.5摄氏度时触发','模拟阈值0.5V时触发','模拟压力阈值0.5时触发'])
def test_physical_threshold_units_are_not_silently_used_as_normalized_value(client,text):
    result=recommend(client,body(text,intent='threshold'))
    assert 'prd.intake.answers.threshold' not in rows(result)
    assert any('物理量' in item['reason'] for item in result['not_filled'])


@pytest.mark.parametrize('values',[
    {'repetitions':10**400},
    {'dwell_s':1e308},
    {'wave_start_rad':1e308},
])
def test_invalid_existing_numbers_remain_draft_without_crashing_estimate(client,values):
    draft=body('来回摆动',intent='oscillate')
    draft['prd']['intake']['answers'].update(values)
    result=recommend(client,draft)
    assert 'prd.intake.answers.duration_s' not in rows(result)
    assert all('prd.intake.answers.'+key not in rows(result) for key in values)


@pytest.mark.parametrize('text',['左肩抬起30度','转到负30度'])
def test_unsupported_explicit_position_angle_is_not_replaced_by_default(client,text):
    result=recommend(client,body(text,intent='position'))
    assert 'prd.intake.answers.target_rad' not in rows(result)


def test_relative_position_is_not_treated_as_absolute(client):
    result=recommend(client,body('相对当前位置转到30度',intent='position'))
    assert not any(path.startswith('prd.intake.answers.') for path in rows(result))


def test_acceleration_is_not_parsed_as_angular_velocity(client):
    result=recommend(client,body('转到30度，最大加速度0.5rad/s/s',intent='position'))
    assert answer(result,'target_rad')['value']==pytest.approx(math.pi/6)
    assert 'prd.intake.answers.max_velocity_rad_s' not in rows(result)


def test_request_target_conflicting_with_selected_joint_is_not_recommended(client,monkeypatch):
    from server import recommendations
    original=recommendations.selected_model
    def right_shoulder(root,answers):
        model,joint=original(root,answers)
        return model,{**joint,'label':'右肩抬起'}
    monkeypatch.setattr(recommendations,'selected_model',right_shoulder)
    result=recommend(client,body('左肩来回摆动三次',intent='oscillate'))
    assert not any(path.startswith('prd.intake.answers.') for path in rows(result))
    assert any('已选关节不一致' in warning for warning in result['warnings'])
    compatible=recommend(client,body('右肩来回摆动三次',intent='oscillate'))
    assert answer(compatible,'repetitions')['value']==3
