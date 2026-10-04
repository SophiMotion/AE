"""V3 approvals bind the actual model, editable workflow and both generated sources."""
import copy
import json
import math
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server.app import create_app
from server.providers import _prompt, _safe_spec, V3_CODE_SCHEMA, _parse_object, ProviderError
from server.schemas import ProjectInput
from server.store import specification, spec_hash
from server.structures import _urdf, attach_structure
from server.workflow import default_workflow, validate_workflow
from worker.device_logic import DEFAULT_DEVICE_CODE, validate_device_logic
from worker.robot_model import validate_execution_model


def test_workflow_order_changes_execution_and_hash():
    flow = default_workflow()
    alternate = copy.deepcopy(flow)
    alternate['edges'] = [e for e in alternate['edges'] if e['source'] != 'communication']
    alternate['edges'] += [{'source': 'esp_build', 'target': 'ros_build'},
                           {'source': 'ros_build', 'target': 'simulation'},
                           {'source': 'simulation', 'target': 'communication'},
                           {'source': 'communication', 'target': 'report'}]
    changed = validate_workflow(alternate)
    assert changed['execution_order'].index('esp_build') < changed['execution_order'].index('ros_build')
    assert changed['execution_order'].index('simulation') < changed['execution_order'].index('communication')
    assert changed['hash'] != flow['hash']


@pytest.mark.parametrize('change', ['cycle', 'skip_review', 'missing_build', 'bad_edge', 'duplicate', 'position_nan'])
def test_workflow_cannot_bypass_required_steps(change):
    flow = default_workflow()
    if change == 'cycle': flow['edges'].append({'source': 'report', 'target': 'requirements'})
    if change == 'skip_review': flow['edges'] = [e for e in flow['edges'] if e['target'] != 'review']
    if change == 'missing_build': flow['nodes'] = flow['nodes'][:-1]
    if change == 'bad_edge': flow['edges'][0]['source'] = {}
    if change == 'duplicate': flow['edges'].append(flow['edges'][0])
    if change == 'position_nan': flow['nodes'][0]['position']['x'] = float('nan')
    with pytest.raises(ValueError): validate_workflow(flow)


@pytest.mark.parametrize('code', [
    '#include <iostream>\n' + DEFAULT_DEVICE_CODE,
    DEFAULT_DEVICE_CODE.replace('return value;', 'while (true) {} return value;'),
    DEFAULT_DEVICE_CODE.replace('return value;', 'return system(value);'),
    DEFAULT_DEVICE_CODE + '\ndouble value = 4;',
    DEFAULT_DEVICE_CODE.replace('return value;', 'return limit_command(value,max_velocity);'),
    DEFAULT_DEVICE_CODE.replace('return value;', 'return 1e999;'),
    DEFAULT_DEVICE_CODE.replace('return value;', 'return 1.7976931348623157e308;'),
    DEFAULT_DEVICE_CODE.replace('return value;', 'return value / 0;'),
    DEFAULT_DEVICE_CODE.replace('return value;', 'return *(double*)1234;'),
])
def test_generated_firmware_cannot_escape_numeric_function(code):
    with pytest.raises(ValueError): validate_device_logic(code)


def test_firmware_comments_removed_and_syntax_errors_left_for_compiler():
    assert validate_device_logic('// note\n' + DEFAULT_DEVICE_CODE) == DEFAULT_DEVICE_CODE
    missing_semicolon = DEFAULT_DEVICE_CODE.replace('return value;', 'return value')
    assert validate_device_logic(missing_semicolon) == missing_semicolon


def test_v3_model_and_workflow_bound_into_approval(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        body = {'name': '关节绑定', 'request': '让所选关节达到目标角度', 'task_type': 'joint_position'}
        response = client.post('/api/projects', json=body)
        assert response.status_code == 200, response.text
        project = response.json()
        manifest = project['manifest']
        assert manifest['preflight']['passed'] is True
        assert '配置一致性' in manifest['preflight']['scope']
        assert manifest['modules'][1]['fqbn'] == 'esp32:esp32:esp32'
        assert manifest['modules'][3]['pins'] is None
        assert manifest['modules'][3]['physical_io'] is False
        assert manifest['missing_for_hardware']
        assert specification(project)['manifest'] == manifest
        validate_execution_model(project['execution_model'])
        assert project['execution_model']['selected_joint'] == 'test_joint'
        assert specification(project)['communication']['identity']['model_sha256'] == project['execution_model']['model_sha256']
        assert project['communication'] == specification(project)['communication']
        assert client.get('/api/projects/'+project['id']).json()['communication']['identity'] == project['communication']['identity']
        assert project['simulation']['selected_joint'] == project['prd']['joint_name']
        before = spec_hash(project)
        project['workflow']['nodes'][0]['position']['x'] += 1
        assert spec_hash(project) != before
        assert client.post('/api/projects/' + project['id'] + '/run').status_code == 409
        invalid = default_workflow()
        invalid['edges'] = []
        assert client.post('/api/projects', json={**body, 'workflow': invalid}).status_code == 422


def test_manifest_is_rebuilt_when_board_or_joint_changes(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        body = {'name':'清单变更', 'request':'在模拟设备验证关节控制', 'task_type':'joint_position'}
        p = client.post('/api/projects', json=body).json()
        q = client.put('/api/projects/'+p['id'], json={**body,'hardware':{'board':'esp32s3'}}).json()
        assert p['manifest']['hash'] != q['manifest']['hash']
        assert q['manifest']['modules'][1]['fqbn'] == 'esp32:esp32:esp32s3'
        assert q['approval'] is None
        assert q['manifest']['model_sha256'] == q['execution_model']['model_sha256']


def test_imported_urdf_inertia_rotated_and_mimic_execution_rejected(tmp_path):
    from server.structures import ingest_structure
    raw = '''<robot name="arm"><link name="base"/><link name="arm"><inertial><origin xyz=".1 .2 .3" rpy="0 0 1.5707963267948966"/><mass value="2"/><inertia ixx="1" iyy="2" izz="2.5"/></inertial></link><joint name="axis" type="revolute"><parent link="base"/><child link="arm"/><limit lower="-1" upper="1"/><mimic joint="other"/></joint></robot>'''
    structure = _urdf(raw)
    assert structure['links'][1]['mass'] == 2
    assert structure['links'][1]['center_of_mass'] == [.1,.2,.3]
    assert structure['links'][1]['inertia']['ixx'] == pytest.approx(2)
    assert structure['links'][1]['inertia']['iyy'] == pytest.approx(1)
    saved = ingest_structure(tmp_path, 'robot.urdf', raw)
    with pytest.raises(ValueError, match='mimic'):
        _urdf(raw.replace('<mimic joint="other"/>', '<mimic/>'))
    project = ProjectInput(name='联动测试', request='测试该联动关节', task_type='joint_position', prd={'structure_id': saved['id'], 'joint_name':'axis'}).model_dump()
    with pytest.raises(ValueError, match='mimic'): attach_structure(tmp_path, project)


def test_provider_gets_model_limits_and_both_sources(tmp_path):
    project = attach_structure(tmp_path, ProjectInput(name='测试', request='关节转到目标角', task_type='joint_position').model_dump())
    project.update(spec_revision=1, workflow=default_workflow())
    spec = specification(project)
    prompt = _prompt('code', spec, [], {}, 'old python', 'device_logic.hpp: error', DEFAULT_DEVICE_CODE)
    assert 'previous_firmware_code' in prompt and 'device_logic.hpp: error' in prompt
    assert 'firmware_code' in prompt and 'selected_joint_data' in prompt
    assert _safe_spec(spec)['execution_model']['selected_joint_data']['limits'] == {'lower':-3,'upper':3}
    with pytest.raises(ProviderError): _parse_object('{"code":"x","explanation":"x"}', V3_CODE_SCHEMA)


def test_legacy_spec_does_not_change_historical_approval_hash():
    p = {'name':'x','request':'x','task_type':'joint_position','parameters':{},'hardware':{},'spec_revision':1}
    assert 'pipeline_version' not in specification(p)


def _plan_fixture():
    return {'summary':'本地审批绑定测试', **{key:[] for key in
        ('ros_tasks','esp32_tasks','communication','checks','missing_information','citations','blocking_issues')}}


def test_v3_plan_refreshes_manifest_and_binds_exact_model_input(tmp_path, monkeypatch):
    import hashlib
    from worker import contract
    captured = []
    def generate(spec, *args):
        captured.append(copy.deepcopy(spec))
        return _plan_fixture()
    monkeypatch.setattr('server.providers.generate_plan', generate)
    monkeypatch.setattr('server.retrieval.retrieve', lambda *args, **kwargs: [])
    with TestClient(create_app(tmp_path)) as client:
        monkeypatch.setattr(client.app.state.jobs.pool, 'submit', lambda function, *args: function(*args))
        project = client.post('/api/projects', json={'name':'计划升级', 'request':'转到目标角度', 'task_type':'joint_position'}).json()
        old_manifest = project['manifest']['hash']
        monkeypatch.setitem(contract.COMMUNICATION_DEFAULTS, 'watchdog_behavior', 'updated source contract before planning')
        assert client.post('/api/projects/'+project['id']+'/plan').status_code == 200
        planned = client.get('/api/projects/'+project['id']).json()
        assert planned['status'] == 'awaiting_approval'
        assert planned['manifest']['hash'] != old_manifest
        assert captured[0]['manifest']['protocol_sha256'] == captured[0]['communication']['identity']['protocol_sha256']
        exact_hash = hashlib.sha256(json.dumps(captured[0],sort_keys=True,ensure_ascii=False).encode()).hexdigest()
        assert planned['plan']['spec_hash'] == exact_hash == spec_hash(planned)
        archived = list((tmp_path/'runs').glob('plan-*/plan.json'))
        assert len(archived) == 1 and json.loads(archived[0].read_text(encoding='utf-8'))['spec_hash'] == exact_hash
        approved = client.post('/api/projects/'+project['id']+'/approve', json={'spec_revision':planned['spec_revision'], 'plan_id':planned['plan']['plan_id']})
        assert approved.status_code == 200, approved.text
        assert approved.json()['approval']['spec_hash'] == exact_hash


@pytest.mark.parametrize('changed_when', ['during_generation','after_generation'])
def test_v3_plan_rejects_contract_change_without_revision_change(tmp_path, monkeypatch, changed_when):
    from worker import contract
    def change_contract():
        monkeypatch.setitem(contract.COMMUNICATION_DEFAULTS, 'watchdog_behavior', 'source contract upgraded after plan input')
    def generate(spec, *args):
        if changed_when == 'during_generation': change_contract()
        return _plan_fixture()
    monkeypatch.setattr('server.providers.generate_plan', generate)
    monkeypatch.setattr('server.retrieval.retrieve', lambda *args, **kwargs: [])
    with TestClient(create_app(tmp_path)) as client:
        monkeypatch.setattr(client.app.state.jobs.pool, 'submit', lambda function, *args: function(*args))
        project = client.post('/api/projects', json={'name':'旧计划', 'request':'转到目标角度', 'task_type':'joint_position'}).json()
        assert client.post('/api/projects/'+project['id']+'/plan').status_code == 200
        if changed_when == 'after_generation': change_contract()
        planned = client.get('/api/projects/'+project['id']).json()
        assert planned['spec_revision'] == project['spec_revision']
        assert planned['plan']['spec_hash'] != spec_hash(planned)
        response = client.post('/api/projects/'+project['id']+'/approve', json={'spec_revision':planned['spec_revision'], 'plan_id':planned['plan']['plan_id']})
        assert response.status_code == 409 and '重新拆分' in response.json()['detail']
        assert client.get('/api/projects/'+project['id']).json()['approval'] is None


@pytest.mark.parametrize('version,expected_status', [(3,409),(2,200)])
def test_plan_without_spec_hash_requires_v3_replanning_but_preserves_legacy_approval(tmp_path, version, expected_status):
    with TestClient(create_app(tmp_path)) as client:
        project = client.post('/api/projects', json={'name':'历史计划', 'request':'转到目标角度', 'task_type':'joint_position'}).json()
        project.update(pipeline_version=version, status='awaiting_approval', plan={'summary':'以前的计划', 'plan_id':'old-plan'})
        client.app.state.store.put('project', project)
        response = client.post('/api/projects/'+project['id']+'/approve', json={'spec_revision':project['spec_revision'], 'plan_id':'old-plan'})
        assert response.status_code == expected_status, response.text
        if version == 3:
            assert '重新拆分' in response.json()['detail']
            assert client.get('/api/projects/'+project['id']).json()['approval'] is None
        else:
            assert response.json()['approval']['spec_hash'] == spec_hash(project)


@pytest.mark.parametrize('mismatch', ['none','identity','firmware','model','physics','order','workflow','board','fqbn','numeric','missing_numeric','cleanup'])
def test_v3_executor_rejects_other_model_or_unapproved_order(tmp_path, monkeypatch, mismatch):
    import io
    import threading
    from server.jobs import Jobs
    from server.store import Store
    project = attach_structure(tmp_path, ProjectInput(name='证据检查', request='仅测试结果契约', task_type='joint_position').model_dump())
    project.update(id='project', spec_revision=1, workflow=default_workflow(), status='approved')
    spec = specification(project)
    identity = spec['communication']['identity']
    result = {'passed':True,'checks':[{'name':'independent_check','passed':True}], 'ros_verified':True,
              'physics_simulation_verified':True,'identity':copy.deepcopy(identity),
              'execution_model':{'model_sha256':identity['model_sha256'],'selected_joint':identity['joint_name']},
              'workflow':{'hash':spec['workflow']['hash']},
              'execution_order':['ros_build','esp_build','communication','simulation','report'],
              'firmware':{'passed':True,'identity':copy.deepcopy(identity),'board':'esp32','fqbn':'esp32:esp32:esp32'},
              'device_logic_test':{'passed':True,'cases':28}, 'metrics':{'cleanup':{'all_exited':True}},
              'communication_test':{'passed':True,'identity':copy.deepcopy(identity)}}
    if mismatch == 'identity': result['identity']['joint_name'] = 'another_joint'
    if mismatch == 'firmware': result['firmware']['identity']['model_sha256'] = '0'*64
    if mismatch == 'model': result['execution_model']['selected_joint'] = 'another_joint'
    if mismatch == 'physics': result['physics_simulation_verified'] = False
    if mismatch == 'order': result['execution_order'][:2] = ['esp_build','ros_build']
    if mismatch == 'workflow': result['workflow']['hash'] = '0'*64
    if mismatch == 'board': result['firmware']['board'] = 'esp32s3'
    if mismatch == 'fqbn': result['firmware']['fqbn'] = 'esp32:esp32:esp32s3'
    if mismatch == 'numeric': result['device_logic_test']['passed'] = False
    if mismatch == 'missing_numeric': result.pop('device_logic_test')
    if mismatch == 'cleanup': result['metrics']['cleanup']['all_exited'] = False
    (tmp_path/'worker').mkdir(); (tmp_path/'worker'/'execute.py').write_text('# test double')
    out = tmp_path/'runs'/'run'/'attempt-1'; out.mkdir(parents=True)
    (out/'spec.json').write_text(json.dumps(spec),encoding='utf-8')
    (out/'result.json').write_text(json.dumps(result),encoding='utf-8')
    (out/'device_logic.cpp').write_text(DEFAULT_DEVICE_CODE,encoding='utf-8')
    store = Store(tmp_path/'state.sqlite3')
    store.put('project',project); store.put('run',{'id':'run','project_id':'project','events':[]})
    jobs = Jobs(tmp_path,store,lambda: {})
    class Process:
        stdout = io.StringIO('')
        def poll(self): return 0
        def wait(self, timeout=None): return 0
    monkeypatch.setattr('server.jobs.subprocess.Popen',lambda *args,**kwargs: Process())
    try:
        checked = jobs.execute('project','run',out/'spec.json',out/'algorithm.py',out,threading.Event())
        assert checked['passed'] is (mismatch == 'none')
    finally:
        jobs.close()

