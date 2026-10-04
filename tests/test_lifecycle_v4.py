import base64
import hashlib
import io
import json
import zipfile

import pytest
from fastapi.testclient import TestClient

from server.app import create_app
from server.lifecycle import read_bundle
from server.store import specification


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path)) as c:
        yield c


def project(client, name='历史测试'):
    r = client.post('/api/projects', json={'name': name, 'request': '关节转到指定目标', 'task_type': 'joint_position'})
    assert r.status_code == 200, r.text
    return r.json()


def bundle(spec, extra=None, sealed=True):
    files = {'spec.json': json.dumps(spec).encode(),
             'run-record.json': json.dumps({'id': 'old-run', 'spec_snapshot': spec, 'status': 'deployed',
                                           'approval': {'by': 'not trusted'}}).encode(),
             'attempt-1/algorithm.py': b'raise RuntimeError("MUST NOT EXECUTE")'}
    files.update(extra or {})
    if sealed:
        files['bundle-manifest.json'] = json.dumps({'schema_version': 1, 'files': [
            {'path': p, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()} for p, data in files.items()]}).encode()
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        for p, data in files.items(): z.writestr(p, data)
    return out.getvalue()


def body(payload):
    return {'filename': '工程.zip', 'content_base64': base64.b64encode(payload).decode()}


def test_history_retains_pre_edit_and_clone_does_not_inherit_approval(client):
    p = project(client)
    pid = p['id']
    p.update(status='approved', approval={'by': 'historical'}, plan={'summary': '保留旧计划'})
    client.app.state.store.put('project', p)
    change = {k: p[k] for k in ('name', 'request', 'task_type', 'parameters', 'hardware', 'prd', 'workflow')}
    change['parameters'] = {**change['parameters'], 'target': 0.3}
    r = client.put(f'/api/projects/{pid}', json=change)
    assert r.status_code == 200, r.text
    rows = client.get(f'/api/projects/{pid}/history').json()['items']
    before = next(h for h in rows if h['event'] == 'before_edit')
    assert before['snapshot']['parameters']['target'] == 0.6
    assert before['snapshot']['plan']['summary'] == '保留旧计划'
    cloned = client.post(f'/api/projects/{pid}/history/{before["id"]}/clone').json()
    assert cloned['id'] != pid and cloned['parameters']['target'] == 0.6
    assert cloned['status'] == 'draft'
    assert cloned['approval'] is None and cloned['plan'] is None and cloned['latest_run_id'] is None
    assert client.get(f'/api/projects/{pid}').json()['parameters']['target'] == 0.3
    other = project(client, '另一个工程')
    assert client.post(f'/api/projects/{other["id"]}/history/{before["id"]}/clone').status_code == 404


def test_import_requires_preview_identity_and_only_recovers_data(client):
    p = project(client)
    data = body(bundle(specification(p)))
    preview = client.post('/api/projects/import/preview', json=data)
    assert preview.status_code == 200, preview.text
    v = preview.json()
    assert v['has_integrity'] and v['joint_name'] == 'test_joint'
    assert client.post('/api/projects/import', json=data).status_code == 409
    assert client.post('/api/projects/import', json={**data, 'confirm': True, 'preview_hash': '0'*64}).status_code == 409
    r = client.post('/api/projects/import', json={**data, 'confirm': True, 'preview_hash': v['preview_hash']})
    assert r.status_code == 200, r.text
    cloned = r.json()
    assert cloned['status'] == 'draft' and cloned['approval'] is None and cloned['plan'] is None
    assert cloned['id'] != p['id'] and cloned['origin']['source_run_id'] == 'old-run'
    assert client.post('/api/projects/'+cloned['id']+'/run').status_code == 409
    assert client.app.state.store.list('run') == []


@pytest.mark.parametrize('path', ['../outside.txt', 'C:/evil.py', 'x\\evil.py', '/root/evil', 'a/./file'])
def test_zip_path_traversal_rejected(client, path):
    payload = bundle(specification(project(client)), {path: b'bad'}, sealed=False)
    # Windows ZipInfo normalizes backslashes at write time; simulate an
    # externally supplied central/local header retaining the unsafe spelling.
    if '\\' in path:
        payload = payload.replace(path.replace('\\', '/').encode(), path.encode())
    data = body(payload)
    r = client.post('/api/projects/import/preview', json=data)
    assert r.status_code == 422 and '路径' in r.text


def test_manifest_tamper_rejected(client):
    payload = bundle(specification(project(client)))
    out = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(payload)) as src, zipfile.ZipFile(out,'w') as dst:
        for name in src.namelist():
            dst.writestr(name, b'modified' if name.endswith('algorithm.py') else src.read(name))
    r = client.post('/api/projects/import/preview', json=body(out.getvalue()))
    assert r.status_code == 422 and '已变化' in r.text


def test_legacy_bundle_is_explicitly_unverified(client):
    r = client.post('/api/projects/import/preview', json=body(bundle(specification(project(client)), sealed=False)))
    assert r.status_code == 200 and not r.json()['has_integrity']
    assert any('旧版' in w for w in r.json()['warnings'])


def test_missing_source_rejected_without_guessing(client):
    s = specification(project(client));s['structure']['id'] = 'structure-missing'
    r = client.post('/api/projects/import/preview', json=body(bundle(s)))
    assert r.status_code == 422 and '缺少结构原文' in r.text


def test_export_adds_file_digests_and_reimports(client, tmp_path):
    p = project(client)
    s = specification(p)
    run = {'id': 'export-test', 'project_id': p['id'], 'status': 'passed', 'created_at':'now',
           'spec_snapshot': s, 'artifacts': []}
    client.app.state.store.put('run', run)
    directory = tmp_path/'runs'/run['id'];directory.mkdir(parents=True)
    (directory/'spec.json').write_text(json.dumps(s))
    (directory/'algorithm.py').write_text('# source file')
    r = client.get('/api/runs/export-test/export')
    assert r.status_code == 200
    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        manifest = json.loads(z.read('bundle-manifest.json'))
        for row in manifest['files']:
            assert hashlib.sha256(z.read(row['path'])).hexdigest() == row['sha256']
    preview = client.post('/api/projects/import/preview', json=body(r.content))
    assert preview.status_code == 200 and preview.json()['has_integrity']


def test_run_copy_uses_snapshot_not_current_project(client):
    p = project(client); s = specification(p)
    client.app.state.store.put('run', {'id':'old', 'project_id':p['id'], 'spec_snapshot':s, 'status':'failed'})
    p['parameters']['target'] = 0.2
    client.app.state.store.put('project',p)
    r = client.post('/api/runs/old/clone')
    assert r.status_code == 200, r.text
    assert r.json()['parameters']['target'] == 0.6 and r.json()['status'] == 'draft'


def test_run_copy_refuses_changed_model_rules(client):
    p = project(client); s = specification(p)
    s['execution_model']['model_sha256'] = 'f'*64
    client.app.state.store.put('run', {'id':'old-model', 'project_id':p['id'], 'spec_snapshot':s, 'status':'passed'})
    r = client.post('/api/runs/old-model/clone')
    assert r.status_code == 422 and '无法原样复用' in r.text
    assert len(client.app.state.store.list('project')) == 1


@pytest.mark.parametrize('invalid', [None, [], {'schema_version': 1, 'files': None}])
def test_malformed_manifest_returns_422(client, invalid):
    payload = bundle(specification(project(client)), {'bundle-manifest.json': json.dumps(invalid).encode()}, sealed=False)
    assert client.post('/api/projects/import/preview', json=body(payload)).status_code == 422


@pytest.mark.parametrize('field', ['prd', 'structure', 'hardware', 'parameters', 'execution_model'])
def test_malformed_spec_object_returns_422(client, field):
    spec = specification(project(client)); spec[field] = ['invalid']
    assert client.post('/api/projects/import/preview', json=body(bundle(spec))).status_code == 422


def test_windows_source_newlines_recover_only_original_digest(client):
    source = '<robot name="fixture">\n<link name="base"/>\n<link name="arm"/>\n<joint name="hinge" type="revolute"><parent link="base"/><child link="arm"/><axis xyz="0 1 0"/><limit lower="-1" upper="1" effort="1" velocity="1"/></joint>\n</robot>\n'
    structure = client.post('/api/structures', json={'filename':'fixture.urdf','content':source}).json()
    p = client.post('/api/projects', json={'name':'source','request':'move joint','task_type':'joint_position',
        'prd':{'structure_id':structure['id'],'joint_name':'hinge'}}).json()
    payload = bundle(specification(p), {'structure-source.urdf':source.replace('\n','\r\n').encode()})
    r = client.post('/api/projects/import/preview', json=body(payload))
    assert r.status_code == 200, r.text
    payload = bundle(specification(p), {'structure-source.urdf':source.replace('effort="1"','effort="2"').encode()})
    assert client.post('/api/projects/import/preview', json=body(payload)).status_code == 422
