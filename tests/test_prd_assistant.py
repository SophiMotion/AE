"""Complete PRD drafts preserve intent; no assistant response grants execution."""
import copy
import json
import math
import threading
import shutil
from pathlib import Path

import pytest

from tests.test_prd_intake import client, ready
from tests.test_prd_details import detailed
from server import providers
from server.schemas import IntakeV2, GuidedDraftInput
from server.store import spec_hash
from server.intake_details import mapping_source_fingerprint
from server.structures import get_structure, ingest_structure


def draft(request='让关节抬起，招手三次，然后放在身体旁边'):
    return {'name':'','request':request,'prd':{'use_case':'','constraints':'','acceptance':'',
        'intake':IntakeV2().model_dump()}}


def candidate(*, complex=True):
    steps = [{'id':'raise','title':'抬起','description':'抬起手臂，角度需看模型确认',
              'joint_names':['test_joint'],'repetitions':None,'target_rad':None,'confirmation_needed':True},
             {'id':'wave','title':'招手','description':'来回招手三次',
              'joint_names':['test_joint'],'repetitions':3,'target_rad':None,'confirmation_needed':True},
             {'id':'lower','title':'放下','description':'手臂放到身体旁边',
              'joint_names':['test_joint'],'repetitions':None,'target_rad':None,'confirmation_needed':True}]
    if not complex:
        steps = [{'id':'position','title':'转到位置','description':'关节转到0.5rad',
                  'joint_names':['test_joint'],'repetitions':None,'target_rad':.5,'confirmation_needed':False}]
    return {'name':'完整动作需求','use_case':'整理动作和待确认参数','intent':'oscillate' if complex else 'position',
        'structure_id':'builtin-joint','reference_joint':'test_joint',
        'action_draft':{'schema_version':1,'structure_id':None,'model_source_sha256':None,
            'summary':'完整动作需求','scope':'multi_joint' if complex else 'single_joint',
            'reference_joint':'test_joint','related_joints':[{'name':'test_joint','label':'AI不能伪造的标签',
                'role':'参考关节','reason':'模型中存在的候选'}], 'stages':steps,
            'end_pose_text':'手臂放到身体旁边' if complex else '',
            'unresolved':['身体旁的具体角度需看模型确认'] if complex else [],'requires_review':True},
        'parameters':[{'key':'repetitions' if complex else 'target_rad','value':3 if complex else .5,
                       'source':'request','reason':'用户原话明确给定'},
                      {'key':'max_velocity_rad_s','value':math.pi/6,'source':'example','reason':'草稿速度建议'},
                      {'key':'tolerance_rad','value':math.pi/90,'source':'example','reason':'草稿误差建议'},
                      {'key':'duration_s','value':15.,'source':'example','reason':'草稿观察时长建议'}]}


@pytest.fixture
def ai(monkeypatch):
    holder = {'candidate':candidate(), 'calls':[]}
    def invoke(prompt, schema, config, workdir, cancel):
        holder['calls'].append((prompt,schema))
        return copy.deepcopy(holder['candidate']), {'tool':'test fixture (not real AI)', 'model':'fixture',
              'prompt':prompt,'response':json.dumps(holder['candidate'],ensure_ascii=False),'status':'completed'}
    monkeypatch.setattr(providers,'generate_assistance',invoke)
    return holder


def request(client,body):
    response=client.post('/api/prd/assist',json=body)
    assert response.status_code==200,response.text
    return response.json()


def bypath(rows):return {row['path']:row for row in rows}


def adopt(body,result):
    value=copy.deepcopy(body)
    for row in result['suggestions']:
        obj=value;bits=row['path'].split('.')
        for bit in bits[:-1]:obj=obj.setdefault(bit,{})
        obj[bits[-1]]=copy.deepcopy(row['value'])
    value['prd']['intake']['recommendation_bundle']={'schema_version':1,'records':result['suggestions'],
                                                    'provenance':result['provenance']}
    return value


def test_sequence_count_and_model_reference_fill_without_compressing(client,ai):
    original=draft();result=request(client,original);rows=bypath(result['suggestions'])
    assert result['schema_version']==2 and not result['conflicts']
    assert rows['prd.intake.answers.structure_id']['value']=='builtin-joint'
    assert rows['prd.intake.answers.joint_name']['value']=='test_joint'
    assert rows['prd.intake.answers.repetitions']['value']==3
    action=rows['prd.intake.action_draft']['value']
    assert len(action['stages'])==3 and action['stages'][-1]['target_rad'] is None
    assert action['model_source_sha256']==mapping_source_fingerprint(client.app.state.jobs.root,get_structure(client.app.state.jobs.root,'builtin-joint'))
    assert action['related_joints'][0]['label']=='test_joint'
    assert not any(path.endswith(('wave_start_rad','wave_end_rad','end_position_rad')) for path in rows)
    assert client.app.state.store.list('project')==client.app.state.store.list('run')==[]
    assert original['prd']['intake']['answers']['joint_name'] is None
    assert '只返回给定JSON' in result['provenance']['prompt']


def test_existing_zero_custom_groups_and_words_are_preserved(client,ai):
    body=draft();body['name']='我的名称';body['prd']['intake']['answers'].update(repetitions=8,dwell_s=0)
    body['prd']['intake']['details']['communication'].update(selection='custom',transport='CAN')
    result=request(client,body);rows=bypath(result['suggestions']);conflicts=bypath(result['conflicts'])
    assert 'name' not in rows and 'prd.intake.answers.repetitions' not in rows
    assert conflicts['prd.intake.answers.repetitions']['current_value']==8
    assert not any(path.endswith('.communication') for path in rows)
    filled=adopt(body,result)
    assert filled['request']==body['request'] and filled['prd']['intake']['answers']['dwell_s']==0
    assert filled['prd']['intake']['details']['communication']['transport']=='CAN'


def test_unknown_hardware_remains_blank_and_board_is_only_platform_choice(client,ai):
    result=request(client,draft());rows=bypath(result['suggestions'])
    assert rows['prd.intake.answers.board']['source']=='platform'
    assert not any('hardware_notes' in x for x in rows)
    assert any(x['path']=='prd.intake.hardware_notes' for x in result['not_filled'])
    for bad in ('request','hardware.physical_io','approval','__proto__'):
        assert bad not in rows


@pytest.mark.parametrize('edit', [
    lambda c:c.update(structure_id='unknown-model'),
    lambda c:c['action_draft']['related_joints'][0].update(name='invented_joint'),
    lambda c:c['action_draft']['stages'][0].update(joint_names=['invented_joint']),
    lambda c:c['action_draft']['stages'][0].update(target_rad=999.),
    lambda c:c['action_draft']['stages'][-1].update(target_rad=0.),
    lambda c:c.update(physical_io=True),
    lambda c:c['parameters'].append({'key':'wiring','value':'GPIO1','source':'example','reason':'guess'}),
    lambda c:c['parameters'].append(copy.deepcopy(c['parameters'][0])),
])
def test_invalid_model_angles_or_field_injection_rejected_whole(client,ai,edit):
    edit(ai['candidate'])
    response=client.post('/api/prd/assist',json=draft())
    assert response.status_code==502,response.text
    assert response.json()['provenance']['status']=='rejected'
    assert not client.app.state.store.list('project')


def test_numeric_values_finite_and_bounds_and_bool(client,ai):
    ai['candidate']['parameters']=[{'key':'max_velocity_rad_s','value':999.,'source':'example','reason':'bad'}]
    result=request(client,draft())
    assert 'prd.intake.answers.max_velocity_rad_s' not in bypath(result['suggestions'])
    ai['candidate']['parameters'][0]['value']=True
    assert client.post('/api/prd/assist',json=draft()).status_code==502


def test_model_joint_conflict_keeps_old_selection_and_does_not_fill_angle(client,ai):
    body=draft('让关节转到0.5rad');body['prd']['intake']['answers'].update(structure_id='builtin-sensor',joint_name='mount')
    ai['candidate']=candidate(complex=False)
    result=request(client,body);rows=bypath(result['suggestions']);conflicts=bypath(result['conflicts'])
    assert 'prd.intake.answers.structure_id' in conflicts and 'prd.intake.answers.joint_name' in conflicts
    assert 'prd.intake.answers.target_rad' not in rows
    assert any('角度' in warning for warning in result['warnings'])


def test_multi_action_saved_copied_and_every_execution_gate_remains_blocked(client,ai):
    result=request(client,draft());body=adopt(draft(),result)
    saved=client.post('/api/projects',json=body)
    assert saved.status_code==200,saved.text
    project=saved.json();ident=project['id']
    assert not project['intake_readiness']['can_plan'] and project['execution_model'] is None
    assert client.get('/api/projects/'+ident).json()['prd']['intake']['action_draft']==body['prd']['intake']['action_draft']
    response=client.post('/api/projects/'+ident+'/plan')
    assert response.status_code in (409,422),response.text
    assert not client.app.state.store.list('run')
    history=client.get('/api/projects/'+ident+'/history').json()['items'][0]
    cloned=client.post('/api/projects/'+ident+'/history/'+history['id']+'/clone',json={})
    assert cloned.status_code==200,cloned.text
    clone=cloned.json()
    assert clone['prd']['intake']['recommendation_bundle']==body['prd']['intake']['recommendation_bundle']


@pytest.mark.parametrize('change',[lambda a:a.update(scope='single_joint'),
                                  lambda a:a.update(related_joints=[],scope='single_joint'),
                                  lambda a:a.update(stages=a['stages'][:1],scope='single_joint')])
def test_scope_flag_cannot_launder_complex_action(client,ai,change):
    body=adopt(draft(),request(client,draft()));change(body['prd']['intake']['action_draft'])
    # Force all old profile choices to ready; the new complete draft must still gate.
    baseline=detailed(ready());body['prd']['intake']['intent']='position'
    body['prd']['intake']['details']=baseline['prd']['intake']['details']
    body['prd']['intake']['answers'].update(target_rad=.5)
    result=client.post('/api/prd/preview',json=body).json()
    assert not result['can_plan'] and result['unsupported']+result['invalid']+result['missing']


def test_single_position_action_has_semantic_coverage_and_old_defaults_unchanged(client,ai):
    ai['candidate']=candidate(complex=False)
    body=adopt(draft('关节转到0.5rad'),request(client,draft('关节转到0.5rad')))
    saved=client.post('/api/projects',json=body).json()
    assert saved['intake_readiness']['can_plan'],saved['intake_readiness']
    from server.requirements import source_fields
    assert 'prd.intake.action_draft' in source_fields(saved)
    for old in (ready(), detailed(ready())):
        before=client.post('/api/projects',json=old).json()
        after=client.get('/api/projects/'+before['id']).json()
        assert before['prd']==after['prd']
        assert 'action_draft' not in after['prd']['intake']
        assert 'recommendation_bundle' not in after['prd']['intake']


def test_changed_model_identity_blocks_even_without_provenance_bundle(client,ai):
    ai['candidate']=candidate(complex=False)
    body=adopt(draft('关节转到0.5rad'),request(client,draft('关节转到0.5rad')))
    del body['prd']['intake']['recommendation_bundle']
    body['prd']['intake']['action_draft']['model_source_sha256']='a'*64
    result=client.post('/api/prd/preview',json=body).json()
    assert not result['can_plan'] and any('模型' in x['message'] for x in result['invalid'])


def test_original_unsupported_details_remain_blocking(client,ai):
    ai['candidate']=candidate(complex=False);body=draft('关节转到0.5rad')
    body['prd']['intake']['details']['lifecycle'].update(selection='custom',finish='结束后回到0度')
    filled=adopt(body,request(client,body))
    result=client.post('/api/prd/preview',json=filled).json()
    assert not result['can_plan'] and any('结束' in str(x) for x in result['unsupported'])


def test_prompt_preserves_negation_original_and_excludes_previous_provider_transcript(client,ai):
    body=draft('不要招手，只让右肩转到0.5rad。其它部位不要动。')
    old=request(client,body);body['prd']['intake']['recommendation_bundle']={'schema_version':1,'records':[],
        'provenance':{**old['provenance'],'response':'DO NOT REPLAY OLD MODEL'}}
    request(client,body)
    prompt=ai['calls'][-1][0]
    assert body['request'] in prompt and 'DO NOT REPLAY OLD MODEL' not in prompt
    assert '不要遗漏否定' in prompt and '多关节动作不填写' in prompt


def test_ai_failure_returns_real_failure_not_rule_fallback(client,monkeypatch):
    def fail(*args):raise providers.ProviderError('fixture service unavailable',{'status':'failed'})
    monkeypatch.setattr(providers,'generate_assistance',fail)
    response=client.post('/api/prd/assist',json=draft())
    assert response.status_code==502 and 'fixture service unavailable' in response.text
    assert 'suggestions' not in response.json()


def test_empty_and_v1_do_not_call_ai(client,ai):
    for value in (draft(''),ready()):
        assert client.post('/api/prd/assist',json=value).status_code==422
    assert not ai['calls']


def test_cancel_after_provider_result_never_offers_fields(client,ai):
    from server.intake_assistant import assist
    cancel=threading.Event();cancel.set()
    with pytest.raises(providers.ProviderCancelled):
        assist(client.app.state.jobs.root,GuidedDraftInput.model_validate(draft()),{},cancel)


def test_end_pose_wording_cannot_hide_in_generic_last_stage(client,ai):
    ai['candidate']['action_draft']['stages'][-1].update(title='结束',description='恢复姿势',target_rad=0.)
    response=client.post('/api/prd/assist',json=draft())
    assert response.status_code==502 and '结束姿势' in response.text


def test_position_without_explicit_number_cannot_invent_stage_zero(client,ai):
    ai['candidate']=candidate(complex=False)
    ai['candidate']['action_draft']['stages'][0]['target_rad']=0.
    response=client.post('/api/prd/assist',json=draft('让手臂抬起来'))
    assert response.status_code==502 and '数值依据' in response.text


def test_sophicore_alias_freeze_keeps_complete_draft_and_its_source(client,ai):
    root=client.app.state.jobs.root
    (root/'knowledge').mkdir(exist_ok=True)
    source=Path(__file__).resolve().parents[1]/'knowledge'
    for name in ('sophicore-default-configuration.json','sophicore-model.json'):
        shutil.copy2(source/name,root/'knowledge'/name)
    ai['candidate']=candidate(complex=False)
    ai['candidate'].update(structure_id='sophicore-reference',reference_joint='arm_r_shoulder_lift')
    action=ai['candidate']['action_draft'];action['reference_joint']='arm_r_shoulder_lift'
    action['related_joints'][0]['name']='arm_r_shoulder_lift'
    action['stages'][0]['joint_names']=['arm_r_shoulder_lift']
    body=draft('让右肩转到0.5rad')
    saved=client.post('/api/projects',json=adopt(body,request(client,body)))
    assert saved.status_code==200,saved.text
    result=saved.json();form=result['prd']['intake']
    assert form['answers']['structure_id'].startswith('structure-')
    assert form['action_draft']['structure_id']==form['answers']['structure_id']
    assert result['intake_readiness']['can_plan'],result['intake_readiness']
    row=next(x for x in form['recommendation_bundle']['records'] if x['path']=='prd.intake.action_draft')
    assert row['value']==form['action_draft']
    resolved=next(x for x in result['intake_readiness']['resolved'] if x['path']=='prd.intake.action_draft')
    assert resolved['origin']=='suggested' and '先前' not in resolved['source_ref']


def test_call_history_preserves_record_provenance_and_missing_call_rejected():
    from server.schemas import RecommendationBundle
    call={'tool':'test','model':'fixture','prompt':'first prompt','response':'first response','status':'completed',
          'invocation_id':'1'*32}
    row={'path':'name','label':'名称','value':'名称','source':'ai','reason':'test','section':1,
         'basis':{'request_text':'test','structure_id':None,'model_source_sha256':None},'invocation_id':'1'*32}
    newer={**call,'prompt':'second prompt','invocation_id':'2'*32}
    bundle={'schema_version':1,'records':[row],'provenance':newer,'history':[call]}
    assert RecommendationBundle.model_validate(bundle).model_dump()['history'][0]['prompt']=='first prompt'
    bundle['history']=[]
    with pytest.raises(ValueError):RecommendationBundle.model_validate(bundle)


def test_strict_provider_schema_keeps_real_title_property_and_all_required_fields():
    from server.intake_assistant import AssistantCandidate
    schema=AssistantCandidate.strict_schema()
    stage=schema['$defs']['ActionStage']
    assert 'title' in stage['properties'] and 'title' in stage['required']
    assert 'title' not in stage  # descriptive schema metadata is optional
    def walk(node):
        if isinstance(node,dict):
            if node.get('type')=='object':
                assert set(node['properties'])==set(node['required'])
                assert node['additionalProperties'] is False
            for value in node.values():walk(value)
        elif isinstance(node,list):
            for value in node:walk(value)
    walk(schema)


@pytest.mark.parametrize('text,expected,source',[
    ('用ESP32做招手', 'esp32','request'),
    ('用ESP32-S3做招手', 'esp32s3','request'),
    ('使用ESP32（不是S3）', 'esp32','request'),
    ('不用ESP32，使用ESP32-S3', 'esp32s3','request'),
    ('不是ESP32-S3，暂时不确定板型', 'esp32','platform'),
    ('让机器人招手，板型不知道', 'esp32s3','platform'),
])
def test_compile_board_follows_explicit_request_and_negative_exclusions(client,ai,text,expected,source):
    result=request(client,draft(text));row=bypath(result['suggestions'])['prd.intake.answers.board']
    assert row['value']==expected and row['source']==source


def test_board_request_conflict_preserves_existing_board_and_lists_correction(client,ai):
    body=draft('使用ESP32，不是S3');body['prd']['intake']['answers']['board']='esp32s3'
    result=request(client,body)
    assert 'prd.intake.answers.board' not in bypath(result['suggestions'])
    row=bypath(result['conflicts'])['prd.intake.answers.board']
    assert row['current_value']=='esp32s3' and row['value']=='esp32' and row['source']=='request'


@pytest.mark.parametrize('text',['ESP32和ESP32-S3都提到了，还没选','不用ESP32，也不用ESP32-S3'])
def test_ambiguous_or_excluded_boards_are_not_filled(client,ai,text):
    result=request(client,draft(text))
    assert 'prd.intake.answers.board' not in bypath(result['suggestions'])
    assert any(row['path']=='prd.intake.answers.board' for row in result['not_filled'])


def test_prompt_includes_current_platform_lifecycle_and_acceptance_facts(client,ai):
    from server.intake_details import profile_descriptions
    request(client,draft())
    prompt=ai['calls'][-1][0]
    for intent in ('position','threshold'):
        for group in ('lifecycle','acceptance','coordinates','communication'):
            assert profile_descriptions(intent)[group] in prompt
    assert '不把平台正常停止本轮进程重复编成动作步骤' in prompt
    assert '明确要求保持指定姿势/回原点/回家/放下等额外条件时仍须保留' in prompt


@pytest.mark.parametrize('text,expected',[
    ('不要招手，只转到30度',True),
    ('误差不超过2度，转到30度',True),
    ('其它关节不要动，右肩转到30度',True),
    ('不要转到30度',False),
])
def test_explicit_target_negation_is_scoped_to_its_clause(text,expected):
    from server.intake_assistant import _explicit_number
    assert _explicit_number(text,'target_rad',math.pi/6) is expected


def complete_action_body(client, intent='oscillate'):
    """The visible complete-action form, with deliberately empty legacy fields."""
    body = detailed()
    form = body['prd']['intake']
    form['intent'] = intent
    form['answers'].update(target_rad=None, wave_start_rad=None, wave_end_rad=None,
                           repetitions=None, dwell_s=None, end_behavior=None,
                           end_position_rad=None, other_action='')
    action = candidate()['action_draft']
    action['structure_id'] = 'builtin-joint'
    action['model_source_sha256'] = mapping_source_fingerprint(
        client.app.state.jobs.root, get_structure(client.app.state.jobs.root, 'builtin-joint'))
    action['summary'] = '抬起手臂，招手三次，再将手臂放到身体旁边。'
    action['unresolved'] = []
    for step in action['stages']:
        step['repetitions'] = 3 if step['id'] == 'wave' else 1
        step['confirmation_needed'] = False
    form['action_draft'] = action
    return body


@pytest.mark.parametrize('intent', ['oscillate', 'position', 'other', 'threshold'])
def test_complete_action_readiness_uses_visible_fields_and_summary(client, intent):
    body = complete_action_body(client, intent)
    before = copy.deepcopy(body)
    response = client.post('/api/prd/preview', json=body)
    assert response.status_code == 200, response.text
    result = response.json()
    hidden = {'target_rad', 'wave_start_rad', 'wave_end_rad', 'repetitions',
              'dwell_s', 'end_behavior', 'end_position_rad', 'other_action', 'threshold'}
    assert not any(x['path'].removeprefix('prd.intake.answers.') in hidden
                   for x in result['missing'] + result['invalid'])
    assert result['summary']['action'] == before['prd']['intake']['action_draft']['summary']
    assert not result['can_plan'] and result['unsupported']
    assert body == before
    assert client.app.state.store.list('project') == client.app.state.store.list('run') == []


def test_complete_action_checks_common_parameters_and_not_hidden_motion_group(client):
    body = complete_action_body(client)
    body['prd']['intake']['details']['motion'] = {}
    body['prd']['intake']['answers'].update(duration_s=None, max_velocity_rad_s=None, tolerance_rad=None)
    result = client.post('/api/prd/preview', json=body).json()
    paths = {x['path'] for x in result['missing']}
    assert {'prd.intake.answers.' + x for x in ('duration_s', 'max_velocity_rad_s', 'tolerance_rad')} <= paths
    assert not any(x.startswith('prd.intake.details.motion.') for x in paths)


@pytest.mark.parametrize('change, path, bucket', [
    (lambda a: a['stages'][0].update(target_rad=100.), '.stages.0.target_rad', 'invalid'),
    (lambda a: a['stages'][0].update(title=''), '.stages.0.title', 'missing'),
    (lambda a: a['stages'][0].update(description=''), '.stages.0.description', 'missing'),
    (lambda a: a['stages'][0].update(repetitions=None), '.stages.0.repetitions', 'missing'),
    (lambda a: a['stages'][0].update(confirmation_needed=True), '.stages.0.confirmation_needed', 'missing'),
    (lambda a: a.update(stages=[]), '.stages', 'missing'),
    (lambda a: a.update(related_joints=[]), '.related_joints', 'missing'),
    (lambda a: a.update(end_pose_text=''), '.end_pose_text', 'missing'),
    (lambda a: a.update(model_source_sha256='a' * 64), '.model_source_sha256', 'invalid'),
])
def test_complete_action_reports_real_visible_missing_and_invalid_fields(client, change, path, bucket):
    body = complete_action_body(client)
    change(body['prd']['intake']['action_draft'])
    result = client.post('/api/prd/preview', json=body).json()
    assert any(x['path'] == 'prd.intake.action_draft' + path for x in result[bucket]), result
    assert not result['can_plan']


def test_single_stage_repetition_uses_complete_view_but_never_grants_execution(client):
    body = complete_action_body(client)
    action = body['prd']['intake']['action_draft']
    action.update(scope='single_joint', stages=[action['stages'][1]])
    result = client.post('/api/prd/preview', json=body).json()
    assert not any(x['path'].endswith(('wave_start_rad', 'wave_end_rad', 'dwell_s', 'end_behavior')) for x in result['missing'])
    assert not result['can_plan'] and result['unsupported']


def test_complete_draft_still_blocks_all_existing_execution_gates(client):
    body = complete_action_body(client)
    saved = client.post('/api/projects', json=body).json()
    pid = saved['id']
    assert saved['manifest'] is saved['execution_model'] is None
    assert client.post(f'/api/projects/{pid}/plan').status_code == 409
    stored = client.app.state.store.get('project', pid)
    stored.update(status='awaiting_approval', plan={'plan_id': 'forged', 'blocking_issues': []})
    client.app.state.store.put('project', stored)
    assert client.post(f'/api/projects/{pid}/approve', json={'spec_revision': 1, 'plan_id': 'forged'}).status_code == 409
    stored.update(status='approved', approval={'spec_hash': 'forged'})
    client.app.state.store.put('project', stored)
    assert client.post(f'/api/projects/{pid}/run').status_code == 409
    assert client.app.state.store.list('run') == []


def test_complete_stage_cannot_apply_one_angle_to_multiple_or_unknown_joints(client):
    body = complete_action_body(client)
    step = body['prd']['intake']['action_draft']['stages'][0]
    step.update(joint_names=['test_joint', 'unknown_joint'], target_rad=.2)
    result = client.post('/api/prd/preview', json=body).json()
    messages = [x['message'] for x in result['invalid'] if x['path'].startswith('prd.intake.action_draft.stages.0.')]
    assert any('单个角度' in message for message in messages)
    assert any('关节清单' in message for message in messages)
    assert not result['can_plan']


def test_complete_draft_readiness_preserves_saved_data_and_hardware_blanks(client):
    body = complete_action_body(client)
    body['prd']['intake']['answers']['wave_start_rad'] = 99.  # Old hidden data is retained, not executed.
    body['prd']['intake']['action_draft']['unresolved'] = [' ', '具体姿势仍需核对']
    saved = client.post('/api/projects', json=body).json()
    before = client.app.state.store.get('project', saved['id'])
    digest = spec_hash(before)
    after = client.get('/api/projects/' + saved['id']).json()
    assert after['prd'] == saved['prd']
    assert spec_hash(client.app.state.store.get('project', saved['id'])) == digest
    assert after['prd']['intake']['answers']['wave_start_rad'] == 99.
    assert after['prd']['intake']['action_draft']['unresolved'] == [' ', '具体姿势仍需核对']
    assert not any(x['path'].endswith('wave_start_rad') for x in after['intake_readiness']['invalid'])
    assert any(x['path'] == 'prd.intake.action_draft.unresolved' for x in after['intake_readiness']['missing'])
    assert all(not item['value'] for item in after['prd']['intake']['hardware_notes'].values())

