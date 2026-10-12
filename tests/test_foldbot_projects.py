"""Software-only generation tests; no robot/ROS/network or filesystem output."""
import ast
import hashlib
import io
import json
import re
import threading
import zipfile
from copy import deepcopy
from pathlib import Path

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from server.foldbot_projects import (
    DEFAULTS, GENERATION_KIND, PROJECT_KIND, REVISION_KIND, TEMPLATE_ROOT,
    FoldBotProjects, create_router,
)


class MemoryStore:
    """Store contract without directories, subprocesses or any real device."""
    def __init__(self):
        self.lock = threading.RLock()
        self.objects = {}

    def get(self, kind, ident):
        return deepcopy(self.objects[(kind, ident)])

    def put(self, kind, value):
        self.objects[(kind, value['id'])] = deepcopy(value)
        return value

    def list(self, kind):
        return [deepcopy(value) for (stored_kind, _), value in self.objects.items() if kind == stored_kind]


@pytest.fixture
def service():
    return FoldBotProjects(MemoryStore(), Path(__file__).resolve().parents[1])


@pytest.fixture
def client(service):
    app = FastAPI()
    app.include_router(create_router(service.store, service.root, projects=service))
    with TestClient(app) as value:
        yield value


def generated(service):
    project = service.create(DEFAULTS)
    return service.generate(project['id'], {'revision': 1, 'reviewed': True})


def test_template_is_explicit_about_source_and_unverified_evidence(client):
    result = client.get('/api/foldbot/template')
    assert result.status_code == 200
    template = result.json()
    assert template['defaults']['drive_level'] == 10
    assert {module['id'] for module in template['modules']} == {'chassis', 'fold', 'arm', 'web', 'ros_demo'}
    assert all(value is False for value in template['evidence'].values())
    assert len(template['source_provenance']) == 2
    assert all(len(item['original_sha256']) == 64 for item in template['source_provenance'])


def test_review_is_required_and_stale_revisions_rejected(client):
    project = client.post('/api/foldbot/projects', json={**DEFAULTS, 'reviewed': True}).json()
    assert project['reviewed'] is False
    endpoint = f'/api/foldbot/projects/{project["id"]}/generate'
    for body in ({'revision': 1}, {'revision': 1, 'reviewed': False}, {'revision': 1, 'reviewed': 1}):
        assert client.post(endpoint, json=body).status_code == 422
    assert client.post(endpoint, json={'revision': 2, 'reviewed': True}).status_code == 409
    result = client.post(endpoint, json={'revision': 1, 'reviewed': True})
    assert result.status_code == 200
    assert result.json()['reviewed'] is True


@pytest.mark.parametrize('field,value', [
    ('drive_level', 0), ('drive_level', 21), ('drive_level', 1.5),
    ('drive_level', True), ('drive_level', '10'),
    ('drive_duration_ms', 0), ('drive_duration_ms', 2001),
    ('drive_duration_ms', False), ('name', '  '), ('request', '\x00'),
    ('calibration_override', True),
])
def test_input_boundaries_are_enforced(client, field, value):
    assert client.post('/api/foldbot/projects', json={**DEFAULTS, field: value}).status_code == 422


def test_each_edit_invalidates_current_generation_but_keeps_snapshot(service):
    original = generated(service)
    generation_id = original['generation']['id']
    frozen = service.store.get(GENERATION_KIND, generation_id)
    changed = service.update(original['id'], {**DEFAULTS, 'revision': 1,
                                             'request': '新的任务需求', 'drive_level': 11, 'reviewed': True})
    assert changed['revision'] == 2 and changed['generation'] is None and changed['reviewed'] is False
    assert service.store.get(GENERATION_KIND, generation_id) == frozen
    with pytest.raises(HTTPException) as exc:
        service.require_current_generation(original['id'], 1)
    assert exc.value.status_code == 409
    for action in (lambda: service.file(original['id'], 'README.md'), lambda: service.export(original['id'])):
        with pytest.raises(HTTPException) as exc:
            action()
        assert exc.value.status_code == 409
    updated = service.generate(original['id'], {'revision': 2, 'reviewed': True})
    assert updated['generation']['id'] != generation_id
    assert updated['generation']['config']['project']['request'] == '新的任务需求'
    assert len(service.store.list(REVISION_KIND)) == 2
    assert len(service.store.list(GENERATION_KIND)) == 2


def test_stale_update_rejected_and_noop_preserves_review(service):
    project = generated(service)
    with pytest.raises(HTTPException) as exc:
        service.update(project['id'], {**DEFAULTS, 'revision': 2})
    assert exc.value.status_code == 409
    assert service.update(project['id'], {**DEFAULTS, 'revision': 1}) == project
    assert service.generate(project['id'], {'revision': 1, 'reviewed': True}) == project


def test_current_generation_limits_and_config_tampering(service):
    project = generated(service)
    approved = service.require_current_generation(project['id'], 1)
    control = approved['generation']['config']['local_control']
    assert control['hard_limits'] == {'drive_level': 20, 'drive_duration_ms': 2000, 'arm_step_raw': 8}
    assert control['fold']['manual_reference_required'] is True
    assert control['calibration_override'] is False
    assert control['automatic_connect'] is False and control['automatic_motion'] is False
    project['generation']['config']['local_control']['hard_limits']['drive_level'] = 100
    service.store.put(PROJECT_KIND, project)
    with pytest.raises(HTTPException) as exc:
        service.require_current_generation(project['id'])
    assert exc.value.status_code == 409


@pytest.mark.parametrize('path', [
    '../server/app.py', 'firmware/../../server/app.py', '/README.md',
    'C:/private.txt', 'firmware\\foldbot\\foldbot.ino', './README.md',
    'firmware//foldbot/foldbot.ino', 'unknown.txt', 'README.md\x00',
])
def test_preview_only_allows_exact_snapshot_paths(service, path):
    project = generated(service)
    with pytest.raises(HTTPException) as exc:
        service.file(project['id'], path)
    assert exc.value.status_code == 404


def test_export_is_complete_and_hashes_match_preview_and_manifest(service):
    project = generated(service)
    _, raw = service.export(project['id'])
    metadata = {item['path']: item for item in project['generation']['files']}
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        assert set(archive.namelist()) == set(metadata)
        assert len(metadata) == 14
        assert not any(name.endswith('.bin') for name in archive.namelist())
        for path, item in metadata.items():
            content = archive.read(path)
            assert len(content) == item['bytes']
            assert hashlib.sha256(content).hexdigest() == item['sha256']
            assert service.file(project['id'], path)['content'].encode('utf-8') == content
        manifest = json.loads(archive.read('manifest.json'))
        assert {item['path'] for item in manifest['files']} == set(metadata) - {'manifest.json'}
        assert manifest['revision'] == project['revision']
        for item in manifest['files']:
            assert item == metadata[item['path']]
        firmware = archive.read('firmware/foldbot/foldbot.ino').decode('utf-8')
        assert len(firmware) > 250_000
        assert all(name in firmware for name in ('StepperMotion', 'WEB_AP_PASSWORD', 'stepper_zero', 'motion_enable'))
        assert len(archive.read('firmware/foldbot/web_ui.h')) > 1_000_000
        for path in metadata:
            if path.endswith('.py'):
                ast.parse(archive.read(path).decode('utf-8'))


def test_credentials_removed_and_template_hashes_verified(service):
    project = generated(service)
    ino = service.file(project['id'], 'firmware/foldbot/foldbot.ino')['content']
    assert 'WEB_AP_PASSWORD = FOLDBOT_AP_PASSWORD;' in ino
    assert 'Serial.println(WEB_AP_PASSWORD);' not in ino
    assert not re.search(r'WEB_AP_PASSWORD\s*=\s*"', ino)
    header = service.file(project['id'], 'firmware/foldbot/foldbot_local_config.h')['content']
    assert '#error "Set FOLDBOT_AP_PASSWORD locally before building' in header
    for item in project['generation']['source_provenance']:
        raw = (TEMPLATE_ROOT / item['template']).read_bytes()
        assert hashlib.sha256(raw).hexdigest() == item['sanitized_sha256']
    # Local regression check when the known original exists; never expose its value.
    original = Path('D:/espkuozhanban/espkuozhanban.ino')
    if original.is_file():
        raw = original.read_bytes()
        match = re.search(rb'WEB_AP_PASSWORD\s*=\s*"([^"\r\n]*)"', raw)
        assert match is not None
        original_password = match.group(1)
        _, bundle = service.export(project['id'])
        with zipfile.ZipFile(io.BytesIO(bundle)) as archive:
            assert all(original_password not in archive.read(path) for path in archive.namelist()), 'Original credential escaped redaction'
        assert hashlib.sha256(raw).hexdigest() == project['generation']['source_provenance'][0]['original_sha256']


def test_generated_demo_has_no_default_ros_or_hardware_transport(service):
    project = generated(service)
    demo = service.file(project['id'], 'ros2/foldbot_demo/foldbot_demo/demo.py')['content']
    module = ast.parse(demo)
    top_level_imports = [item for item in module.body if isinstance(item, (ast.Import, ast.ImportFrom))]
    assert {alias.name for item in top_level_imports for alias in item.names} == {'argparse', 'json'}
    assert '--run-ros' in demo
    assert not any(name in demo for name in ('create_publisher', 'create_subscription', 'websocket', 'socket.', 'serial.'))
    evidence = project['generation']['evidence']
    assert evidence == {'source_generated': True, 'compiled': False, 'flashed': False,
                        'ros_executed': False, 'hardware_verified': False}
    readme = service.file(project['id'], 'README.md')['content']
    assert '未验证实物动作' in readme and '原始工程未改动' in readme


def test_mutated_generated_content_is_not_exported(service):
    project = generated(service)
    snapshot = service.store.get(GENERATION_KIND, project['generation']['id'])
    snapshot['files']['README.md']['content'] += '\nChanged outside the generator\n'
    service.store.put(GENERATION_KIND, snapshot)
    with pytest.raises(HTTPException) as exc:
        service.export(project['id'])
    assert exc.value.status_code == 409


def test_http_list_preview_export_and_missing_project(client):
    assert client.get('/api/foldbot/projects/no-such-project').status_code == 404
    project = client.post('/api/foldbot/projects', json=DEFAULTS).json()
    assert client.get('/api/foldbot/projects').json()[0]['id'] == project['id']
    assert client.put(f'/api/foldbot/projects/{project["id"]}', json=DEFAULTS).status_code == 422
    assert client.post(f'/api/foldbot/projects/{project["id"]}/generate',
                       json={'revision': 1, 'reviewed': True}).status_code == 200
    preview = client.get(f'/api/foldbot/projects/{project["id"]}/file', params={'path': 'README.md'})
    assert preview.status_code == 200 and preview.json()['revision'] == 1
    archive = client.get(f'/api/foldbot/projects/{project["id"]}/export')
    assert archive.status_code == 200
    assert archive.headers['content-type'] == 'application/zip'
    assert archive.headers['content-disposition'].endswith('-r1.zip"')
