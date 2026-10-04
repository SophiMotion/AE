import base64
import json

import pytest
from fastapi.testclient import TestClient

from server.app import create_app
from server.structures import ingest_structure, get_structure, list_structures
from server.store import spec_hash, specification

URDF = '''<robot name="测试机械臂"><link name="base"><visual><geometry><box size=".2 .2 .05"/></geometry></visual></link><link name="arm"><visual><origin xyz=".2 0 0"/><geometry><cylinder radius=".02" length=".4"/></geometry></visual></link><joint name="shoulder" type="revolute"><parent link="base"/><child link="arm"/><origin xyz="0 0 .1"/><axis xyz="0 1 0"/><limit lower="-1" upper="1"/></joint></robot>'''


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path)) as c:
        yield c


def test_urdf_import_is_persisted_and_does_not_claim_physics(tmp_path):
    saved = ingest_structure(tmp_path, 'arm.urdf', URDF)
    assert saved['links'][1]['visuals'][0]['type'] == 'cylinder'
    assert saved['joints'][0]['axis'] == [0, 1, 0]
    assert saved['joints'][0]['lower'] == -1
    assert saved['physics_validated'] is False
    assert saved['simulation_binding'] == 'selected_joint'
    assert 'source_content' not in saved
    assert get_structure(tmp_path, saved['id'], True)['source_content'] == URDF
    assert ingest_structure(tmp_path, 'again.urdf', URDF)['id'] == saved['id']
    assert len(list_structures(tmp_path)) == 4


@pytest.mark.parametrize('source', [
    '<!DOCTYPE robot [<!ENTITY x SYSTEM "file:///etc/passwd">]><robot name="&x;"/>',
    URDF.replace('child link="arm"', 'child link="base"'),
    URDF.replace('size=".2 .2 .05"', 'size="nan .2 .05"'),
    URDF.replace('lower="-1" upper="1"', 'lower="2" upper="1"'),
    URDF.replace('axis xyz="0 1 0"', 'axis xyz="0 0 0"'),
    '<robot><link name="a"/><link name="b"/></robot>',
])
def test_invalid_and_external_urdf_rejected(tmp_path, source):
    with pytest.raises(ValueError):
        ingest_structure(tmp_path, 'bad.urdf', source)


def test_unknown_structures_cannot_escape_path(tmp_path):
    with pytest.raises(ValueError):
        get_structure(tmp_path, '../../secret')


def test_v3_rejects_unrecognized_sophicore_source(tmp_path):
    raw = {'version': 1, 'sourceSha256': 'test', 'parameters': {'base_length': 900, 'base_width': 850, 'base_height': 200, 'total_height': 1875.75}}
    # V2 rendered any dimensions as boxes. V3 only executes a verified source mapping.
    with pytest.raises(ValueError, match='不属于已核对'):
        ingest_structure(tmp_path, 'configuration.json', json.dumps(raw))


def test_prd_board_and_structure_are_part_of_approval(client):
    body = {'name': '板编译试验', 'request': '让关节到指定位置', 'task_type': 'joint_position',
            'hardware': {'board': 'esp32s3'}, 'prd': {'use_case': '台架', 'constraints': '不接硬件'}}
    p = client.post('/api/projects', json=body).json()
    assert p['hardware']['board'] == 'esp32s3'
    assert p['hardware']['transport'] == 'serial_jsonl'
    assert p['structure']['id'] == 'builtin-joint'
    assert p['prd']['constraints'] == '不接硬件'
    assert specification(p)['prd'] == p['prd']
    initial = spec_hash(p)
    p['prd']['acceptance'] = '新的验收要求'
    assert initial != spec_hash(p)
    p['status'] = 'awaiting_approval'
    p['plan'] = {'summary': '待确认', 'plan_id': 'test-plan', 'spec_hash': spec_hash(p)}
    client.app.state.store.put('project', p)
    assert client.post(f'/api/projects/{p["id"]}/approve', json={'spec_revision': 1, 'plan_id': 'test-plan'}).status_code == 200
    body['hardware']['board'] = 'esp32'
    q = client.put(f'/api/projects/{p["id"]}', json=body).json()
    assert q['approval'] is None and q['spec_revision'] == 2
    assert client.post(f'/api/projects/{q["id"]}/run').status_code == 409


def test_sensor_devices_inferred_but_incompatible_explicit_combination_rejected(client):
    body = {'name': '触发试验', 'request': '读取并比较模拟传感器', 'task_type': 'sensor_threshold'}
    result = client.post('/api/projects', json=body)
    assert result.status_code == 200
    assert result.json()['hardware']['actuator'] == 'virtual_switch'
    body['hardware'] = {'actuator': 'virtual_joint', 'sensor': 'simulated_encoder'}
    assert client.post('/api/projects', json=body).status_code == 422


def test_old_unselected_boards_readable_but_cannot_start_new_v2_work(client):
    body = {'name': '旧工程', 'request': '读取并比较模拟传感器', 'task_type': 'sensor_threshold'}
    assert client.post('/api/projects', json={**body, 'hardware': {'board': '未指定（模拟）', 'transport': 'simulated'}}).status_code == 422
    p = client.post('/api/projects', json=body).json()
    p['hardware'].update(board='未指定（模拟）', transport='simulated')
    client.app.state.store.put('project', p)
    assert client.get(f'/api/projects/{p["id"]}').status_code == 200
    assert client.post(f'/api/projects/{p["id"]}/plan').status_code == 409
    assert client.post(f'/api/projects/{p["id"]}/run').status_code == 409


def test_unimplemented_request_cannot_be_approved(client):
    p = client.post('/api/projects', json={'name': '不可执行任务', 'request': '让机械臂自主避障导航', 'task_type': 'joint_position'}).json()
    p.update(status='awaiting_approval', plan={'summary': '无法覆盖', 'plan_id': 'test-plan', 'spec_hash': spec_hash(p), 'blocking_issues': ['本轮单关节控制不支持自主避障导航']})
    client.app.state.store.put('project', p)
    result = client.post(f'/api/projects/{p["id"]}/approve', json={'spec_revision': 1, 'plan_id': 'test-plan'})
    assert result.status_code == 409
    assert '避障导航' in result.json()['detail']
    assert client.post(f'/api/projects/{p["id"]}/run').status_code == 409


def test_approval_must_match_plan_that_was_actually_reviewed(client):
    p = client.post('/api/projects', json={'name': '同规格重拆', 'request': '让模拟关节转到目标位置', 'task_type': 'joint_position'}).json()
    p.update(status='awaiting_approval', plan={'summary': '第二次拆分', 'plan_id': 'new-plan', 'spec_hash': spec_hash(p), 'blocking_issues': []})
    client.app.state.store.put('project', p)
    old_tab = client.post(f'/api/projects/{p["id"]}/approve', json={'spec_revision': 1, 'plan_id': 'old-plan'})
    assert old_tab.status_code == 409
    assert client.get(f'/api/projects/{p["id"]}').json()['approval'] is None
    current = client.post(f'/api/projects/{p["id"]}/approve', json={'spec_revision': 1, 'plan_id': 'new-plan'})
    assert current.status_code == 200 and current.json()['approval']['plan_id'] == 'new-plan'


def test_structure_api_resolves_selected_joint_and_blocks_unknown(client):
    uploaded = client.post('/api/structures', json={'filename': 'arm.urdf', 'content': URDF})
    assert uploaded.status_code == 200
    sid = uploaded.json()['id']
    body = {'name': '结构参考', 'request': '使用导入模型作为结构参考', 'task_type': 'joint_position', 'prd': {'structure_id': sid, 'joint_name': 'missing'}}
    assert client.post('/api/projects', json=body).status_code == 422
    body['prd']['joint_name'] = 'shoulder'
    p = client.post('/api/projects', json=body).json()
    assert p['structure']['id'] == sid
    assert p['structure']['simulation_binding'] == 'selected_joint'
    assert p['execution_model']['selected_joint'] == 'shoulder'


def test_knowledge_upload_rejects_invalid_encoding_and_extensions(client):
    assert client.post('/api/knowledge/documents', json={'filename': 'x.txt', 'content_base64': 'not base64'}).status_code == 422
    payload = base64.b64encode(b'print(1)').decode()
    assert client.post('/api/knowledge/documents', json={'filename': 'x.exe', 'content_base64': payload}).status_code == 422


def test_knowledge_missing_metadata_does_not_assume_compatible(client):
    payload = base64.b64encode('独特型号 XYZ123 发送串口数据'.encode()).decode()
    response = client.post('/api/knowledge/documents', json={'filename': 'unknown.txt', 'content_base64': payload})
    assert response.status_code == 200
    uploaded = response.json()
    assert uploaded['board'] == 'unknown' and uploaded['ros_distro'] == 'unknown'
    assert uploaded['id'] in [item['id'] for item in client.get('/api/knowledge').json()['items']]
    found = client.get('/api/knowledge', params={'q': 'XYZ123', 'board': 'esp32', 'ros_distro': 'humble'}).json()['items']
    assert not any(item.get('document_id') == uploaded['id'] for item in found)


def test_library_search_all_boards_and_versions_but_explicit_filter_is_strict(client):
    payload = base64.b64encode('专用板 XYZ987 串口接口示例'.encode()).decode()
    uploaded = client.post('/api/knowledge/documents', json={'filename': 'specific.txt', 'content_base64': payload,
        'board': 'esp32s3', 'ros_distro': 'jazzy', 'version': '1.0'}).json()
    found = client.get('/api/knowledge', params={'q': 'XYZ987', 'board': ''}).json()['items']
    assert any(item['document_id'] == uploaded['id'] for item in found)
    filtered = client.get('/api/knowledge', params={'q': 'XYZ987', 'board': 'esp32', 'ros_distro': 'humble'}).json()['items']
    assert not any(item['document_id'] == uploaded['id'] for item in filtered)
