"""Editor graphs are revision-bound data. No physical transports or compiler are used."""
import io
import json
import zipfile
from copy import deepcopy

import pytest
from fastapi import HTTPException

from server.foldbot_graphs import COMPONENTS, SOURCE_CONNECTIONS, STAGES, ProjectGraphs, normalized_wiring_value, readiness_issues
from server.foldbot_projects import DEFAULTS, PROJECT_KIND
from server.foldbot_flash import FoldBotFlashSessions
from test_guided_flow import client, service, draft, generate, prepared


def graphs():
    return {
        'schema_version': 1,
        'wiring': {
            'nodes': [{'id': 'hw-' + role, 'component': role, 'label': role} for role in COMPONENTS],
            'edges': [{'id': f'wire-{index + 1}', 'source': 'hw-' + a, 'sourcePort': ap,
                       'target': 'hw-' + b, 'targetPort': bp} for index, (a, ap, b, bp) in enumerate(SOURCE_CONNECTIONS)],
        },
        'behavior': {
            'nodes': [{'id': 'stage-' + stage, 'kind': 'stage', 'stage': stage} for stage in STAGES],
            'edges': [{'id': 'flow-' + a, 'source': 'stage-' + a, 'sourcePort': 'next',
                       'target': 'stage-' + b, 'targetPort': 'in'} for a, b in zip(STAGES, STAGES[1:])],
        },
    }


def insert_node(value, after_stage, node):
    edge = next(e for e in value['behavior']['edges'] if e['source'] == 'stage-' + after_stage)
    target = edge['target']
    edge['target'] = node['id']
    value['behavior']['nodes'].append(node)
    value['behavior']['edges'].append({'id': 'from-' + node['id'], 'source': node['id'],
                                      'sourcePort': 'true' if node['kind'] == 'condition' else 'next',
                                      'target': target, 'targetPort': 'in'})
    return value


def test_graphs_are_optional_without_legacy_upgrade(service):
    for legacy in [DEFAULTS, draft()]:
        body = prepared(service) if 'guided' in legacy else legacy
        project = generate(service, body)
        assert 'graphs' not in project
        assert not any('graph.json' in f['path'] for f in project['generation']['files'])
    body = prepared(service, graphs=graphs())
    project = generate(service, body)
    omitted = {key: value for key, value in body.items() if key != 'graphs'}
    assert service.update(project['id'], {**omitted, 'revision': 1}) == project


@pytest.mark.parametrize('value', [None, {}, [], {'schema_version': 2, 'wiring': {}, 'behavior': {}}])
def test_invalid_graph_shapes_are_not_silently_ignored(client, value):
    assert client.post('/api/foldbot/projects', json=draft(graphs=value)).status_code == 422


@pytest.mark.parametrize('mutation', [
    lambda g: g.update(schema_version=True),
    lambda g: g.update(layout={'x': 1}),
    lambda g: g['wiring']['nodes'][0].update(id='x\n'),
    lambda g: g['wiring']['nodes'][0].update(label=3),
    lambda g: g['wiring']['nodes'][0].update(label='x\0'),
    lambda g: g['wiring']['nodes'][0].update(component='a4988'),
    lambda g: g['wiring']['nodes'][0].update(pins=[3]),
    lambda g: g['wiring']['nodes'].append(deepcopy(g['wiring']['nodes'][0])),
    lambda g: g['wiring']['edges'][0].update(sourcePort='gpio3\n'),
    lambda g: g['wiring']['edges'].append(deepcopy(g['wiring']['edges'][0])),
    lambda g: g['behavior']['nodes'][0].update(kind='script', code='move()'),
    lambda g: g['behavior']['nodes'][0].update(kind='action', ref='robot.move'),
    lambda g: g['behavior']['nodes'][0].update(kind='condition', check='eval'),
])
def test_graph_fields_and_limits_are_strict(client, mutation):
    value = graphs()
    mutation(value)
    assert client.post('/api/foldbot/projects', json=draft(graphs=value)).status_code == 422


def test_graphs_require_shared_guided_and_workflow_sources(client):
    for missing in ('guided', 'workflow'):
        body = draft(graphs=graphs())
        body.pop(missing)
        assert client.post('/api/foldbot/projects', json=body).status_code == 422


@pytest.mark.parametrize('mutation,code', [
    (lambda g: g['wiring']['edges'].pop(), 'missing_connection'),
    (lambda g: g['wiring']['edges'][0].update(sourcePort='gpio4'), 'unadapted_connection'),
    (lambda g: g['wiring']['edges'][0].update(sourcePort='gpio999'), 'unknown_port'),
    (lambda g: g['wiring']['edges'][0].update(source='missing'), 'missing_endpoint'),
    (lambda g: g['wiring']['edges'][0].update(sourcePort='gnd'), 'port_mismatch'),
    (lambda g: g['wiring']['nodes'].append({'id': 'extra', 'component': 'custom', 'label': '未知驱动'}), 'unadapted_component'),
    (lambda g: g['wiring']['nodes'].append({'id': 'second', 'component': 'controller', 'label': 'another'}), 'required_component'),
    (lambda g: g['wiring']['edges'].append({**g['wiring']['edges'][0], 'id': 'duplicate'}), 'duplicate_connection'),
])
def test_unsupported_wiring_saves_as_draft_but_never_generates(client, mutation, code):
    value = graphs()
    mutation(value)
    body = draft(graphs=value)
    response = client.post('/api/foldbot/projects', json=body)
    assert response.status_code == 200
    for response in [client.post('/api/foldbot/wiring/preview', json=body),
                     client.post('/api/foldbot/projects/' + response.json()['id'] + '/generate', json={'revision': 1, 'reviewed': True})]:
        assert response.status_code == 409
        assert code in {item['code'] for item in response.json()['detail']['issues']}


@pytest.mark.parametrize('mutation,code', [
    (lambda g: g['behavior']['nodes'].pop(), 'required_stage'),
    (lambda g: g['behavior']['edges'].pop(), 'incomplete_flow'),
    (lambda g: g['behavior']['edges'][0].update(target='stage-program'), 'stage_order'),
    (lambda g: g['behavior']['edges'][-1].update(target='stage-requirements'), 'cycle_or_disconnected'),
    (lambda g: g['behavior']['edges'][0].update(sourcePort='false'), 'invalid_flow_port'),
    (lambda g: insert_node(g, 'hardware', {'id': 'wrong', 'kind': 'condition', 'check': 'requirements_ready'}), 'node_position'),
    (lambda g: insert_node(g, 'deploy', {'id': 'wrong', 'kind': 'action', 'ref': 'workflow.action_group'}), 'node_position'),
])
def test_project_flow_cannot_skip_mandatory_stages_or_add_execution(service, mutation, code):
    value = graphs()
    mutation(value)
    body = prepared(service, graphs=value)  # Wiring can be prepared while the flow is a draft.
    project = service.create(body)
    with pytest.raises(HTTPException) as error:
        service.generate(project['id'], {'revision': 1, 'reviewed': True})
    assert code in {item['code'] for item in error.value.detail['issues']}


def test_bound_wiring_normalization_and_cross_runtime_digest(service):
    original = graphs()
    body = prepared(service, graphs=original)
    first = service.wiring_preview(body)
    # Same fixture as project-graphs.test.mjs; labels are presentation, not pin evidence.
    assert first['binding_sha256'] == 'a92ed8fd1153ccb7eac0cb3095dff03e185b32de82eea6367a5c593196625d13'
    changed = deepcopy(original)
    changed['wiring']['nodes'].reverse()
    changed['wiring']['nodes'][0]['label'] = 'renamed'
    changed['wiring']['edges'].reverse()
    for edge in changed['wiring']['edges']:
        edge['source'], edge['target'] = edge['target'], edge['source']
        edge['sourcePort'], edge['targetPort'] = edge['targetPort'], edge['sourcePort']
        edge['id'] += '-renamed'
    assert normalized_wiring_value(original['wiring']) == normalized_wiring_value(changed['wiring'])
    assert service.wiring_preview({**body, 'graphs': changed}) == first
    assert readiness_issues(changed) == []


@pytest.mark.parametrize('control,include,exclude', [('esp', 'firmware/', 'ros2/'), ('ros', 'ros2/', 'firmware/')])
def test_graph_exports_preserve_shared_parameter_references_and_selected_route(service, control, include, exclude):
    value = insert_node(graphs(), 'preview', {'id': 'action', 'kind': 'action', 'ref': 'workflow.action_group'})
    insert_node(value, 'requirements', {'id': 'intent', 'kind': 'condition', 'check': 'requirements_ready'})
    insert_node(value, 'wiring', {'id': 'review', 'kind': 'condition', 'check': 'wiring_reviewed'})
    assert readiness_issues(value) == []
    body = draft(graphs=value)
    body['workflow']['control'] = control
    body = prepared(service, **body)
    project = generate(service, body)
    _, content = service.export(project['id'])
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        assert any(path.startswith(include) for path in archive.namelist())
        assert not any(path.startswith(exclude) for path in archive.namelist())
        assert json.loads(archive.read('prd.json'))['graphs'] == value
        assert json.loads(archive.read('config/wiring_graph.json'))['graph'] == value['wiring']
        flow = json.loads(archive.read('config/behavior_graph.json'))
        assert flow['graph'] == value['behavior']
        assert flow['automatic_motion'] is False and flow['condition_false'] == 'pause'
        assert flow['action_meaning'] == 'browser_visual_preview_only'
        assert all(not evidence for key, evidence in project['generation']['evidence'].items() if key != 'source_generated')


def test_behavior_edit_keeps_wiring_but_invalidates_generation_export_and_current_binding(service):
    body = prepared(service, graphs=graphs())
    project = generate(service, body)
    changed = deepcopy(body)
    insert_node(changed['graphs'], 'preview', {'id': 'action', 'kind': 'action', 'ref': 'workflow.action_group'})
    assert service.wiring_preview(changed)['binding_sha256'] == body['guided']['wiring_binding_sha256']
    updated = service.update(project['id'], {**changed, 'revision': 1})
    assert updated['generation'] is None and updated['revision'] == 2
    for action in [lambda: service.require_current_generation(project['id']), lambda: service.export(project['id']),
                   lambda: service.file(project['id'], 'prd.json')]:
        with pytest.raises(HTTPException) as error:
            action()
        assert error.value.status_code == 409
    regenerated = service.generate(project['id'], {'revision': 2, 'reviewed': True})
    assert regenerated['generation']['spec_sha256'] != project['generation']['spec_sha256']


@pytest.mark.parametrize('mutation', [
    lambda g: g['wiring']['edges'][0].update(sourcePort='gpio4'),
    lambda g: insert_node(g, 'preview', {'id': 'action', 'kind': 'action', 'ref': 'workflow.action_group'}),
    lambda g: g.update(layout={}),
])
def test_direct_stored_graph_tampering_is_blocked_without_500(service, mutation):
    project = generate(service, prepared(service, graphs=graphs()))
    mutation(project['graphs'])
    service.store.put(PROJECT_KIND, project)
    for action in [lambda: service.require_current_generation(project['id']), lambda: service.export(project['id'])]:
        with pytest.raises(HTTPException) as error:
            action()
        assert error.value.status_code == 409


def test_old_wiring_digest_cannot_be_reused_when_graph_is_added(service):
    body = prepared(service)
    body['graphs'] = graphs()
    project = service.create(body)
    with pytest.raises(HTTPException) as error:
        service.generate(project['id'], {'revision': 1, 'reviewed': True})
    assert error.value.detail == 'guided_wiring_binding_stale'


@pytest.mark.parametrize('control', ['esp', 'ros'])
def test_graph_generation_cannot_bypass_flash_target_or_stale_revision(service, control):
    body = draft(graphs=graphs())
    body['workflow']['control'] = control
    body = prepared(service, **body)
    project = generate(service, body)
    sessions = FoldBotFlashSessions(service.require_current_generation)
    binding = {'project_id': project['id'], 'revision': 1,
               'generation_id': project['generation']['id'], 'source_hash': project['generation']['sha256']}
    if control == 'ros':
        with pytest.raises(HTTPException) as error:
            sessions.create_session(binding)
        assert error.value.detail == 'guided_ros_usb_flash_not_supported'
        assert not sessions.arbiter.status()['occupied']
        return
    # Admission reserves an in-memory owner only; no browser or USB device is opened.
    token = sessions.create_session(binding)['session_id']
    insert_node(body['graphs'], 'preview', {'id': 'action', 'kind': 'action', 'ref': 'workflow.action_group'})
    service.update(project['id'], {**body, 'revision': 1})
    with pytest.raises(HTTPException) as error:
        sessions.heartbeat(token)
    assert 'generation_changed' in error.value.detail
    assert sessions.arbiter.owns(token)  # Existing USB exclusion is retained until explicit transport cleanup.
    assert sessions.status()['recovery_required']
    sessions.stop(token)
