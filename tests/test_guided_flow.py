"""Guided intake and route-specific exports. In-memory only; no robot or flash access."""
import io
import json
import threading
import zipfile
from copy import deepcopy
from pathlib import Path

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from server.foldbot_projects import DEFAULTS, PROJECT_KIND, FoldBotProjects, create_router


FLOW = {
    'schema_version': 1, 'robot': 'foldbot', 'control': 'esp', 'wiring_reviewed': True,
    'ros_host': 'local', 'ros_version': 'humble', 'ros_serial': '', 'action_group': 'fold-cycle',
}
GUIDED = {
    'schema_version': 1, 'robot_choice': 'foldbot', 'purpose': '能展开双板并收回，保留底盘和机械臂',
    'primary_task': 'fold-cycle',
    'hardware': {'controller': 'sophicar-s3', 'fold_driver': 'external-step-dir',
                 'arm_bus': 'buslinker-hx', 'chassis': 'sophicar-m1-m2', 'notes': '保持现有线束，电源待现场核对'},
    'wiring_binding_sha256': None,
}


class MemoryStore:
    def __init__(self):
        self.lock, self.objects = threading.RLock(), {}

    def get(self, kind, ident):
        return deepcopy(self.objects[(kind, ident)])

    def put(self, kind, value):
        self.objects[(kind, value['id'])] = deepcopy(value)
        return value

    def list(self, kind):
        return [deepcopy(value) for (stored, _), value in self.objects.items() if stored == kind]


@pytest.fixture
def service():
    return FoldBotProjects(MemoryStore(), Path(__file__).resolve().parents[1])


@pytest.fixture
def client(service):
    app = FastAPI()
    app.include_router(create_router(service.store, service.root, projects=service))
    with TestClient(app) as result:
        yield result


def draft(**patch):
    return {**DEFAULTS, 'request': '制作一个折叠机器人', 'guided': deepcopy(GUIDED), 'workflow': deepcopy(FLOW), **patch}


def prepared(service, **patch):
    body = draft(**patch)
    body['guided']['wiring_binding_sha256'] = service.wiring_preview(body)['binding_sha256']
    return body


def generate(service, body):
    project = service.create(body)
    return service.generate(project['id'], {'revision': 1, 'reviewed': True})


def test_preview_is_read_only_and_binds_selected_source_with_unresolved_physical_evidence(client, service):
    response = client.post('/api/foldbot/wiring/preview', json=draft())
    assert response.status_code == 200
    preview = response.json()
    assert len(preview['binding_sha256']) == 64
    # Cross-runtime fixture shared with guided-flow.test.mjs (Python canonical JSON vs browser Web Crypto).
    assert preview['binding_sha256'] == '58e4ea7c861b100bb45e46cfbb8b6a06bdc3dc0d4647d8c4a5fcec7f537ac63d'
    assert preview['physical_verified'] is False
    assert len(preview['connections']) == 5
    assert preview['connections'][0]['pins'] == 'DIR GPIO3 · STEP GPIO8 · EN GPIO10'
    assert 'GPIO35–37' in ' '.join(preview['warnings'])
    assert not service.store.objects
    inputs = json.loads(preview['input_key'])
    assert inputs['request'] == '制作一个折叠机器人'
    assert inputs['hardware'] == GUIDED['hardware']
    assert 'control' not in inputs and 'workflow' not in inputs


def test_unbound_digest_survives_save_and_reload_as_explicit_null(client):
    created = client.post('/api/foldbot/projects', json=draft()).json()
    assert created['guided']['wiring_binding_sha256'] is None
    response = client.get('/api/foldbot/projects/' + created['id'])
    assert response.json()['guided'] == GUIDED
    updated = client.put('/api/foldbot/projects/' + created['id'], json={**draft(), 'name': 'A new name', 'revision': 1}).json()
    assert updated['guided']['wiring_binding_sha256'] is None


@pytest.mark.parametrize('field,value', [
    ('schema_version', True), ('schema_version', 2), ('robot_choice', 'quad'),
    ('purpose', 3), ('purpose', 'x' * 2001), ('purpose', 'x\0'),
    ('primary_task', 'execute'), ('wiring_binding_sha256', 'a' * 63),
    ('wiring_binding_sha256', 'A' * 64), ('wiring_binding_sha256', 3),
    ('wiring_binding_sha256', 'a' * 64 + '\n'),
    ('hardware', {}), ('hardware', None), ('execute', True),
])
def test_guided_fields_are_strict(client, field, value):
    assert client.post('/api/foldbot/projects', json=draft(guided={**GUIDED, field: value})).status_code == 422


@pytest.mark.parametrize('field,value', [
    ('controller', 'generic-s3'), ('fold_driver', 1), ('arm_bus', 'pwm'),
    ('chassis', True), ('notes', 3), ('notes', 'x' * 2001), ('notes', '\0'), ('pins', [3, 8, 10]),
])
def test_hardware_fields_are_strict(client, field, value):
    guided = {**GUIDED, 'hardware': {**GUIDED['hardware'], field: value}}
    assert client.post('/api/foldbot/projects', json=draft(guided=guided)).status_code == 422


@pytest.mark.parametrize('guided', [None, {}, [], 'foldbot'])
def test_guided_must_be_complete_or_omitted(client, guided):
    assert client.post('/api/foldbot/projects', json=draft(guided=guided)).status_code == 422


@pytest.mark.parametrize('field,value', [('robot_choice', 'undecided'), ('purpose', '  '), ('primary_task', 'unselected')])
def test_incomplete_intent_saves_but_cannot_generate_wiring_or_engineering(service, field, value):
    body = draft(guided={**GUIDED, field: value})
    project = service.create(body)
    for action in [lambda: service.wiring_preview(body), lambda: service.generate(project['id'], {'revision': 1, 'reviewed': True})]:
        with pytest.raises(HTTPException) as error:
            action()
        assert error.value.status_code == 409
        assert error.value.detail == 'guided_requirements_incomplete'


@pytest.mark.parametrize('field', ['controller', 'fold_driver', 'arm_bus', 'chassis'])
@pytest.mark.parametrize('value', ['unselected', 'other'])
def test_unknown_hardware_remains_a_draft_without_guessed_wiring(service, field, value):
    body = draft(guided={**GUIDED, 'hardware': {**GUIDED['hardware'], field: value}})
    project = service.create(body)
    for action in [lambda: service.wiring_preview(body), lambda: service.generate(project['id'], {'revision': 1, 'reviewed': True})]:
        with pytest.raises(HTTPException) as error:
            action()
        assert error.value.detail == 'guided_hardware_not_adapted'
    assert service.get(project['id'])['guided']['hardware'][field] == value


def test_other_robot_does_not_silently_become_foldbot(service):
    body = draft(guided={**GUIDED, 'robot_choice': 'other'}, request='制作一台四足机器人')
    project = service.create(body)
    with pytest.raises(HTTPException) as error:
        service.generate(project['id'], {'revision': 1, 'reviewed': True})
    assert error.value.detail == 'guided_hardware_not_adapted'
    assert service.get(project['id'])['generation'] is None


@pytest.mark.parametrize('digest', [None, '0' * 64])
def test_wiring_checkbox_alone_or_forged_binding_cannot_generate(service, digest):
    body = draft(guided={**GUIDED, 'wiring_binding_sha256': digest})
    project = service.create(body)
    with pytest.raises(HTTPException) as error:
        service.generate(project['id'], {'revision': 1, 'reviewed': True})
    assert error.value.detail == 'guided_wiring_binding_stale'


def test_bound_wiring_still_requires_explicit_review_and_control_config(service):
    body = prepared(service, workflow={**FLOW, 'wiring_reviewed': False})
    project = service.create(body)
    with pytest.raises(HTTPException) as error:
        service.generate(project['id'], {'revision': 1, 'reviewed': True})
    assert error.value.detail == 'guided_wiring_review_required'
    body.pop('workflow')
    project = service.create(body)
    with pytest.raises(HTTPException) as error:
        service.generate(project['id'], {'revision': 1, 'reviewed': True})
    assert error.value.detail == 'guided_control_not_selected'


@pytest.mark.parametrize('field,value', [('purpose', '换成另一个期望结果'), ('primary_task', 'arm-demo')])
def test_intent_changes_immediately_make_old_wiring_stale(service, field, value):
    body = prepared(service)
    project = generate(service, body)
    changed = {**body, 'guided': {**body['guided'], field: value}}
    updated = service.update(project['id'], {**changed, 'revision': 1})
    assert updated['revision'] == 2 and updated['generation'] is None
    with pytest.raises(HTTPException) as error:
        service.generate(project['id'], {'revision': 2, 'reviewed': True})
    assert error.value.detail == 'guided_wiring_binding_stale'
    assert service.wiring_preview(changed)['binding_sha256'] != body['guided']['wiring_binding_sha256']


def test_request_and_hardware_notes_are_bound_but_control_route_is_not(service):
    body = prepared(service)
    first = service.wiring_preview(body)
    for changed in [
        {**body, 'request': '只测试机械臂'},
        {**body, 'guided': {**body['guided'], 'hardware': {**GUIDED['hardware'], 'notes': '另一组接线'}}},
    ]:
        assert service.wiring_preview(changed)['binding_sha256'] != first['binding_sha256']
    changed = {**body, 'workflow': {**FLOW, 'control': 'ros', 'ros_host': 'jetson', 'ros_version': 'jazzy', 'ros_serial': '/dev/ttyUSB0'}}
    assert service.wiring_preview(changed) == first
    old = generate(service, body)
    updated = service.update(old['id'], {**changed, 'revision': 1})
    assert updated['generation'] is None
    regenerated = service.generate(old['id'], {'revision': 2, 'reviewed': True})
    assert regenerated['generation']['sha256'] != old['generation']['sha256']
    assert regenerated['generation']['config_sha256'] != old['generation']['config_sha256']


@pytest.mark.parametrize('control,include,exclude', [('esp', 'firmware/', 'ros2/'), ('ros', 'ros2/', 'firmware/')])
def test_guided_exports_only_the_selected_target_with_shared_bound_records(service, control, include, exclude):
    project = generate(service, prepared(service, workflow={**FLOW, 'control': control}))
    _, content = service.export(project['id'])
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        names = archive.namelist()
        assert any(path.startswith(include) for path in names)
        assert not any(path.startswith(exclude) for path in names)
        for name in ['config/guided.json', 'config/wiring_preview.json', 'config/wiring.json', 'config/workflow.json', 'prd.json', 'provenance.json', 'manifest.json', 'deployment.md']:
            assert name in names
        assert json.loads(archive.read('config/guided.json')) == project['guided']
        assert json.loads(archive.read('prd.json'))['guided'] == project['guided']
        preview = json.loads(archive.read('config/wiring_preview.json'))
        assert preview['binding_sha256'] == project['guided']['wiring_binding_sha256']
        assert preview['physical_verified'] is False
        manifest = json.loads(archive.read('manifest.json'))
        assert set(item['path'] for item in manifest['files']) == set(names) - {'manifest.json'}
        contract = json.loads(archive.read('config/foldbot_config.json'))['output_contract']
        assert contract['selected_target'] == control
        assert contract['firmware_included'] is (control == 'esp')
        assert not any(path.endswith('.bin') for path in names)
    assert project['generation']['evidence'] == {
        'source_generated': True, 'compiled': False, 'flashed': False,
        'ros_executed': False, 'hardware_verified': False,
    }


def test_legacy_snapshots_are_not_migrated_and_legacy_updates_preserve_guidance(service):
    for legacy in [DEFAULTS, {**DEFAULTS, 'workflow': FLOW}]:
        project = generate(service, legacy)
        assert 'guided' not in project
        assert len(project['generation']['files']) == (19 if 'workflow' in legacy else 14)
        paths = [item['path'] for item in project['generation']['files']]
        assert any(path.startswith('firmware/') for path in paths)
        assert any(path.startswith('ros2/') for path in paths)
    body = prepared(service)
    project = generate(service, body)
    legacy_update = {key: value for key, value in body.items() if key != 'guided'}
    assert service.update(project['id'], {**legacy_update, 'revision': 1}) == project


def test_direct_guided_tamper_is_rejected_before_export_or_control_binding(service):
    project = generate(service, prepared(service))
    project['guided']['purpose'] = '被修改但没有重新核对'
    service.store.put(PROJECT_KIND, project)
    with pytest.raises(HTTPException) as error:
        service.require_current_generation(project['id'])
    assert error.value.detail == 'guided_wiring_binding_stale'


def test_template_digest_change_invalidates_an_old_wiring_binding(service, monkeypatch):
    body = prepared(service)
    original = service._templates

    def changed_source():
        provenance, files = original()
        provenance['sources'][0]['sanitized_sha256'] = '0' * 64
        return provenance, files

    monkeypatch.setattr(service, '_templates', changed_source)
    with pytest.raises(HTTPException) as error:
        generate(service, body)
    assert error.value.detail == 'guided_wiring_binding_stale'
