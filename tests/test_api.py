from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from server.app import create_app
from server.store import spec_hash, specification


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path)) as value:
        yield value


def make_project(client):
    result = client.post('/api/projects', json={'name': '关节任务', 'request': '转到 0.6 rad 并反馈位置', 'task_type': 'joint_position'})
    assert result.status_code == 200
    return result.json()


def put_plan(client, project):
    project.update(status='awaiting_approval', plan={'summary': 'test', 'plan_id': 'test-plan', 'spec_hash': spec_hash(project)})
    client.app.state.store.put('project', project)


def test_approval_required_and_invalidation(client):
    p = make_project(client)
    assert client.post(f'/api/projects/{p["id"]}/run').status_code == 409
    put_plan(client, p)
    assert client.post(f'/api/projects/{p["id"]}/approve', json={'spec_revision': 9, 'plan_id': 'test-plan'}).status_code == 409
    approved = client.post(f'/api/projects/{p["id"]}/approve', json={'spec_revision': 1, 'plan_id': 'test-plan'}).json()
    assert approved['approval']['spec_hash'] == spec_hash(approved)
    approved['latest_run_id'] = 'previous-version-run'
    client.app.state.store.put('project', approved)
    body = {k: p[k] for k in ('name', 'request', 'task_type', 'parameters', 'hardware')}
    body['parameters']['target'] = 0.4
    changed = client.put(f'/api/projects/{p["id"]}', json=body).json()
    assert changed['spec_revision'] == 2 and changed['approval'] is None
    assert changed['latest_run_id'] is None
    assert client.post(f'/api/projects/{p["id"]}/run').status_code == 409


def test_bounds_and_unknown_hardware(client):
    base = {'name': '任务', 'request': '读取模拟数据', 'task_type': 'sensor_threshold'}
    assert client.post('/api/projects', json={**base, 'parameters': {'threshold': 20}}).status_code == 422
    assert client.post('/api/projects', json={**base, 'hardware': {'transport': 'CAN'}}).status_code == 422


def test_settings_never_return_or_persist_key(client):
    value = client.put('/api/settings', json={'provider': 'openai', 'model': 'selected-model', 'api_key': 'private-test-secret', 'base_url': 'https://api.example.org/v1'})
    assert value.status_code == 200
    assert value.json()['key_configured']
    assert 'private-test-secret' not in value.text
    assert 'private-test-secret' not in client.app.state.settings.path.read_text()
    assert client.put('/api/settings', json={'provider': 'openai', 'base_url': 'http://external.example/v1'}).status_code == 409


def test_path_escape_rejected(client, tmp_path):
    p = make_project(client)
    root = client.app.state.store.path.parent.parent
    (root / 'secret.txt').write_text('private')
    run = {'id': 'test-run', 'project_id': p['id'], 'status': 'passed', 'created_at': 'now'}
    client.app.state.store.put('run', run)
    folder = root / 'runs' / 'test-run'
    folder.mkdir(parents=True)
    (folder / 'example.py').write_text('print(1)')
    assert client.get('/api/runs/test-run/file', params={'path': '../../secret.txt'}).status_code == 404
    assert client.get('/api/runs/test-run/file', params={'path': 'example.py'}).json()['content'] == 'print(1)'


def test_external_origin_blocked(client):
    assert client.post('/api/projects', headers={'origin': 'https://example.com'}, json={}).status_code == 403


def test_recovery_marks_old_active_tasks(tmp_path):
    app = create_app(tmp_path)
    app.state.store.put('project', {'id': 'old', 'status': 'testing', 'created_at': 'now'})
    with TestClient(app) as client:
        assert client.get('/api/projects/old').json()['status'] == 'interrupted'


def test_deploy_requires_pass_and_explicit_confirmation(client):
    p = make_project(client)
    client.app.state.store.put('run', {'id': 'failed-run', 'project_id': p['id'], 'status': 'failed', 'spec_snapshot': specification(p), 'created_at': 'now'})
    assert client.post('/api/runs/failed-run/deploy', json={'confirm': False}).status_code == 422
    assert client.post('/api/runs/failed-run/deploy', json={'confirm': True}).status_code == 409
