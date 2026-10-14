"""Workflow revision / export tests. No device, serial, flash or ROS transport."""
import ast
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
    'schema_version': 1, 'robot': 'foldbot', 'control': 'esp',
    'wiring_reviewed': True, 'ros_host': 'local', 'ros_version': 'humble',
    'ros_serial': '', 'action_group': 'fold-cycle',
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


def generate(service, flow=None):
    project = service.create({**DEFAULTS, 'workflow': deepcopy(flow or FLOW)})
    return service.generate(project['id'], {'revision': 1, 'reviewed': True})


@pytest.mark.parametrize('field,value', [
    ('schema_version', True), ('schema_version', '1'), ('schema_version', 2),
    ('robot', 'sophicore'), ('control', 'serial'), ('wiring_reviewed', 1),
    ('wiring_reviewed', 'true'), ('ros_host', 'shell'), ('ros_version', 'latest'),
    ('ros_serial', '/dev/ttyUSB0;rm -rf .'), ('ros_serial', 'COM3\n'),
    ('ros_serial', '../private'), ('ros_serial', 'COM0'), ('ros_serial', 3),
    ('ros_serial', 'a' * 121), ('action_group', 'physical-motion'),
    ('execute', True),
])
def test_malformed_workflow_rejected(client, field, value):
    response = client.post('/api/foldbot/projects', json={**DEFAULTS, 'workflow': {**FLOW, field: value}})
    assert response.status_code == 422


@pytest.mark.parametrize('workflow', [None, {}, {'robot': 'foldbot'}, [], 'esp'])
def test_nested_workflow_is_complete_or_omitted(client, workflow):
    assert client.post('/api/foldbot/projects', json={**DEFAULTS, 'workflow': workflow}).status_code == 422


@pytest.mark.parametrize('serial', ['', 'COM3', 'COM9999', '/dev/ttyUSB0', '/dev/ttyACM12', '/dev/cu.usbserial-110'])
def test_serial_is_only_a_validated_label(client, serial):
    response = client.post('/api/foldbot/projects', json={**DEFAULTS, 'workflow': {**FLOW, 'ros_serial': serial}})
    assert response.status_code == 200
    assert response.json()['workflow']['ros_serial'] == serial


def test_wiring_review_gates_new_flow_generation_but_not_legacy(service):
    project = service.create({**DEFAULTS, 'workflow': {**FLOW, 'wiring_reviewed': False}})
    with pytest.raises(HTTPException) as error:
        service.generate(project['id'], {'revision': 1, 'reviewed': True})
    assert error.value.status_code == 409
    assert service.get(project['id'])['generation'] is None
    legacy = service.create(DEFAULTS)
    assert 'workflow' not in legacy
    legacy = service.generate(legacy['id'], {'revision': 1, 'reviewed': True})
    assert len(legacy['generation']['files']) == 14


@pytest.mark.parametrize('field,value', [
    ('control', 'ros'), ('ros_host', 'jetson'), ('ros_version', 'jazzy'),
    ('ros_serial', 'COM3'), ('action_group', 'arm-demo'),
    ('wiring_reviewed', False),
])
def test_every_flow_edit_invalidates_previous_generation(service, field, value):
    initial = generate(service)
    changed = service.update(initial['id'], {
        **DEFAULTS, 'revision': 1, 'workflow': {**FLOW, field: value},
    })
    assert changed['revision'] == 2
    assert changed['generation'] is None and changed['reviewed'] is False
    with pytest.raises(HTTPException):
        service.export(initial['id'])
    with pytest.raises(HTTPException):
        service.require_current_generation(initial['id'], 1)
    if field != 'wiring_reviewed':
        updated = service.generate(initial['id'], {'revision': 2, 'reviewed': True})
        assert initial['generation']['spec_sha256'] != updated['generation']['spec_sha256']
        assert initial['generation']['config_sha256'] != updated['generation']['config_sha256']
        assert json.loads(service.file(initial['id'], 'config/workflow.json')['content'])[field] == value


def test_legacy_update_does_not_remove_new_workflow_or_invalidate_noop(service):
    project = generate(service)
    assert service.update(project['id'], {**DEFAULTS, 'revision': 1}) == project


def test_flow_is_bound_to_config_and_snapshot_hash(service):
    project = generate(service)
    project['workflow']['ros_host'] = 'raspberrypi'
    service.store.put(PROJECT_KIND, project)
    with pytest.raises(HTTPException) as error:
        service.require_current_generation(project['id'])
    assert error.value.status_code == 409


def test_export_records_source_wiring_and_visual_only_action_without_firmware_edits(service):
    project = generate(service, {**FLOW, 'control': 'ros', 'ros_host': 'jetson', 'ros_serial': '/dev/ttyUSB0', 'action_group': 'arm-demo'})
    _, content = service.export(project['id'])
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        flow = json.loads(archive.read('config/workflow.json'))
        assert flow == project['workflow']
        assert json.loads(archive.read('ros2/foldbot_demo/foldbot_demo/workflow.json')) == flow
        assert json.loads(archive.read('prd.json'))['workflow'] == flow
        wiring = json.loads(archive.read('config/wiring.json'))
        assert wiring['source_only'] is True and wiring['hardware_verified'] is False
        assert wiring['chassis'] == {'M1_gpio': [38, 37], 'M2_gpio': [36, 35]}
        assert wiring['fold_axes'][0] == {'axis': 1, 'dir_gpio': 3, 'step_gpio': 8, 'enable_gpio': 10}
        assert wiring['limits']['enabled_in_source'] is False
        assert 'GPIO35–37' in wiring['unresolved'][0]
        action = json.loads(archive.read('config/action_preview.json'))
        assert action['action_group'] == 'arm-demo'
        assert action['visual_only'] is True and action['hardware_target'] is None
        assert action['measured_torque_nm'] is None
        assert action['gazebo_executed'] is False and action['automatic_motion'] is False
        assert 'package_data={"foldbot_demo": ["workflow.json"]}' in archive.read('ros2/foldbot_demo/setup.py').decode()
        assert 'not firmware flashed through a COM port' in archive.read('deployment.md').decode()
    legacy = service.create(DEFAULTS)
    service.generate(legacy['id'], {'revision': 1, 'reviewed': True})
    for path in ['firmware/foldbot/foldbot.ino', 'firmware/foldbot/web_ui.h']:
        assert service.file(project['id'], path)['content'] == service.file(legacy['id'], path)['content']


def test_generated_demo_loads_current_choices_and_defaults_to_offline(capsys, service):
    project = generate(service, {**FLOW, 'control': 'ros', 'ros_host': 'raspberrypi', 'ros_version': 'jazzy'})
    source = service.file(project['id'], 'ros2/foldbot_demo/foldbot_demo/demo.py')['content']
    tree = ast.parse(source)
    assert not any(term in source for term in ['create_publisher', 'create_subscription', 'subprocess', 'serial.Serial', 'websocket'])
    module = {'__name__': 'isolated_demo_test', '__file__': 'demo.py'}
    exec(compile(tree, 'generated-demo.py', 'exec'), module)

    class FrozenJsonPath:
        def __init__(self, _):
            pass

        def with_name(self, name):
            assert name == 'workflow.json'
            return self

        def read_text(self, encoding):
            assert encoding == 'utf-8'
            return json.dumps(project['workflow'])

    module['Path'] = FrozenJsonPath
    module['main']([])
    output = json.loads(capsys.readouterr().out)
    assert output['workflow'] == project['workflow']
    assert output['mode'] == 'offline_demo'
    assert output['hardware_connected'] is False and output['motion_enabled'] is False
    assert output['serial_configuration_only'] is True
