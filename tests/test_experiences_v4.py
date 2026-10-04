"""Evidence publication is an explicit review, not execution or training."""
import hashlib
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from server import experiences, retrieval
from server.store import Store

ROS_CODE = 'def compute_command(value, target, threshold, max_velocity):\n    return max(-max_velocity, min(max_velocity, target - value))\n'
ESP_CODE = 'double limit_command(double value, double max_velocity) { if (value > max_velocity) return max_velocity; if (value < -max_velocity) return -max_velocity; return value; }\n'
IDENTITY = {'joint_name': 'fixture_joint', 'model_sha256': 'b' * 64, 'protocol_sha256': 'c' * 64}
GENERIC_SDK = {'esp32_core': 'any', 'arduinojson': 'any'}


@pytest.fixture
def corpus(tmp_path):
    (tmp_path / 'knowledge').mkdir()
    (tmp_path / 'knowledge' / 'sources.json').write_text('{"items":[]}', encoding='utf-8')
    store = Store(tmp_path / '.tools' / 'store.sqlite3')
    spec = {'pipeline_version': 3, 'task_type': 'joint_position',
            'request': 'PRIVATE_USER_REQUEST_AND_KEY sk-private-request',
            'hardware': {'board': 'esp32', 'ros_distro': 'humble', 'physical_io': False},
            'manifest': {'dependencies': {'esp32_core': '3.3.12', 'arduinojson': '7.4.3'}},
            'communication': {'identity': IDENTITY},
            'execution_model': {'model_id': 'fixture_robot', 'source_sha256': 'a' * 64},
            'structure': {'format': 'urdf'}}
    run = {'id': 'review-fixture', 'project_id': 'project-fixture', 'status': 'passed', 'attempt': 1,
           'spec_snapshot': spec, 'approval': {'spec_hash': experiences._digest(spec)},
           'code_versions': [{'attempt': 1, 'code': ROS_CODE, 'firmware_code': ESP_CODE}],
           'error': 'PRIVATE_TOKEN_AND_LOG', 'events': [{'message': 'PRIVATE_RAW_LOG'}],
           'provenance': [{'prompt': 'PRIVATE_PROMPT'}],
           'result': {'passed': True, 'ros_verified': True, 'identity': IDENTITY,
                      'checks': [{'name': 'task_converged', 'passed': True, 'detail': 'PRIVATE_DETAILS'}],
                      'firmware': {'passed': True, 'identity': IDENTITY, 'command': ['PRIVATE_PATH']},
                      'communication_test': {'passed': True, 'identity': IDENTITY},
                      'physics_simulation_verified': True}}
    store.put('run', run)
    return tmp_path, store, run


def options():
    return {'task_type': 'joint_position', 'board': 'esp32', 'ros_distro': 'humble',
            'robot_model': 'fixture_robot', 'source_model_sha256': 'a' * 64,
            'protocol_sha256': 'c' * 64, 'software_versions': {'esp32_core': '3.3.12', 'arduinojson': '7.4.3'}}


def test_preview_never_publishes_or_ingests_private_text(corpus):
    root, store, run = corpus
    preview = experiences.preview_experience(root, store, run['id'])
    assert preview['kind'] == 'success' and preview['result']['passed']
    assert preview['code_versions'][0]['ros_sha256'] == hashlib.sha256(ROS_CODE.encode()).hexdigest()
    assert 'PRIVATE' not in json.dumps(preview)
    assert preview['physical_verified'] is False
    assert preview['integrity']['mode'] == 'legacy_store_evidence'
    assert retrieval.list_sources(root) == []
    assert store.get('run', run['id']) == run


def test_publish_is_idempotent_and_exactly_scoped(corpus):
    root, store, run = corpus
    preview = experiences.preview_experience(root, store, run['id'])
    first = experiences.publish_experience(root, store, run['id'], preview['preview_hash'])
    second = experiences.publish_experience(root, store, run['id'], preview['preview_hash'])
    assert first['id'] == second['id'] and second['duplicate']
    assert retrieval.stats(root)['experience_documents'] == 1
    hits = retrieval.retrieve('compute_command fixture_joint', root=root, **options())
    assert hits and hits[0]['origin'] == 'experience'
    assert hits[0]['retrieval_use'] == 'validated_example'
    for changed in ({'board': 'esp32s3'}, {'ros_distro': 'jazzy'}, {'robot_model': 'other_robot'},
                    {'source_model_sha256': 'd' * 64}, {'protocol_sha256': 'e' * 64},
                    {'software_versions': {'esp32_core': '2.0.0', 'arduinojson': '7.4.3'}},
                    {'software_versions': None}):
        assert retrieval.retrieve('compute_command fixture_joint', root=root, **{**options(), **changed}) == []
    assert retrieval.retrieve('compute_command', 'joint_position', board='esp32', root=root) == []


def test_delete_removes_rag_not_original_run(corpus):
    root, store, run = corpus
    preview = experiences.preview_experience(root, store, run['id'])
    doc = experiences.publish_experience(root, store, run['id'], preview['preview_hash'])
    retrieval.delete_document(root, doc['id'])
    assert retrieval.retrieve('fixture_joint', root=root, **options()) == []
    assert store.get('run', run['id']) == run
    assert experiences.preview_experience(root, store, run['id'])['published_document_id'] is None


def test_failed_code_is_diagnostic_only_not_a_success_example(corpus):
    root, store, run = corpus
    run['status'] = 'failed'
    run['result']['passed'] = False
    run['result']['checks'][0]['passed'] = False
    run['result']['failure_scope'] = 'algorithm'
    store.put('run', run)
    preview = experiences.preview_experience(root, store, run['id'])
    assert preview['kind'] == 'failure' and not preview['result']['passed']
    assert all(not item['ros_excerpt'] and not item['esp32_excerpt'] for item in preview['code_versions'])
    doc = experiences.publish_experience(root, store, run['id'], preview['preview_hash'])
    detail = retrieval.document_detail(root, doc['id'])
    text = '\n'.join(page['text'] for page in detail['pages'])
    assert doc['verification_status'] == 'reviewed_failure_diagnostic'
    assert 'compute_command(' not in text and '失败记录不能作为通过的代码示例' in text


def test_repaired_record_exposes_only_last_passed_code(corpus):
    root, store, run = corpus
    run['attempt'] = 2
    run['code_versions'].insert(0, {'attempt': 1, 'code': 'FAILED_SECRET_CODE', 'firmware_code': 'BROKEN_SECRET'})
    run['code_versions'][-1]['attempt'] = 2
    store.put('run', run)
    preview = experiences.preview_experience(root, store, run['id'])
    assert preview['kind'] == 'repair'
    assert preview['code_versions'][0]['ros_excerpt'] == ''
    assert preview['code_versions'][1]['ros_excerpt']
    assert 'SECRET' not in json.dumps(preview)


def test_retry_in_new_run_preserves_verified_failure_link(corpus):
    root, store, run = corpus
    previous = json.loads(json.dumps(run))
    previous.update(id='previous-failure', status='failed')
    previous['result'].update(passed=False, failure_scope='algorithm')
    previous['result']['checks'][0]['passed'] = False
    previous['code_versions'][0]['code'] = 'OLD_SECRET_FAILED_SOURCE'
    store.put('run', previous)
    run['code_versions'][0].update(baseline_run_id=previous['id'], baseline_attempt=1,
                                  baseline_code=previous['code_versions'][0]['code'], baseline_firmware_code=ESP_CODE)
    store.put('run', run)
    preview = experiences.preview_experience(root, store, run['id'])
    assert preview['kind'] == 'repair'
    assert preview['repair_baselines'][0]['run_id'] == previous['id']
    assert preview['repair_baselines'][0]['failed_checks'] == ['task_converged']
    assert 'OLD_SECRET' not in json.dumps(preview)
    doc = experiences.publish_experience(root, store, run['id'], preview['preview_hash'])
    assert doc['repair_baselines'] == preview['repair_baselines']
    previous['code_versions'][0]['code'] = 'changed old source'
    store.put('run', previous)
    with pytest.raises(ValueError, match='源码摘要'):
        experiences.preview_experience(root, store, run['id'])


@pytest.mark.parametrize('change', ['active', 'approval', 'physical', 'version'])
def test_invalid_runs_are_not_publishable(corpus, change):
    root, store, run = corpus
    if change == 'active':
        run['status'] = 'testing'
    elif change == 'approval':
        run['approval']['spec_hash'] = 'e' * 64
    elif change == 'physical':
        run['spec_snapshot']['hardware']['physical_io'] = True
        run['approval']['spec_hash'] = experiences._digest(run['spec_snapshot'])
    else:
        run['spec_snapshot']['manifest']['dependencies']['esp32_core'] = 'unknown'
        run['approval']['spec_hash'] = experiences._digest(run['spec_snapshot'])
    store.put('run', run)
    with pytest.raises(ValueError):
        experiences.preview_experience(root, store, run['id'])
    assert retrieval.list_sources(root) == []


def test_stale_preview_is_rejected(corpus):
    root, store, run = corpus
    preview = experiences.preview_experience(root, store, run['id'])
    run['code_versions'][0]['code'] = ROS_CODE.replace('target - value', '(target - value) * 0.5')
    store.put('run', run)
    with pytest.raises(ValueError, match='重新核对'):
        experiences.publish_experience(root, store, run['id'], preview['preview_hash'])


def test_failing_check_or_identity_cannot_be_promoted(corpus):
    root, store, run = corpus
    run['result']['communication_test']['identity'] = {'joint_name': 'other_joint'}
    store.put('run', run)
    preview = experiences.preview_experience(root, store, run['id'])
    assert preview['kind'] == 'failure'
    assert not preview['result']['passed']


def test_seal_verifier_is_enforced_without_current_template_requirement(corpus, monkeypatch):
    from server import integrity
    root, store, run = corpus
    run['integrity'] = {'schema_version': 1}
    store.put('run', run)
    calls = []
    def verified(root_arg, run_arg, check_templates):
        calls.append(check_templates)
        return {'fingerprint': 'f' * 64}
    monkeypatch.setattr(integrity, 'verify_run_integrity', verified)
    assert experiences.preview_experience(root, store, run['id'])['integrity']['verified']
    assert calls == [False]
    def corrupted(*args, **kwargs):
        raise integrity.IntegrityError('changed evidence')
    monkeypatch.setattr(integrity, 'verify_run_integrity', corrupted)
    with pytest.raises(ValueError, match='changed evidence'):
        experiences.preview_experience(root, store, run['id'])


def test_router_requires_explicit_confirmation_and_returns_detail(corpus):
    root, store, run = corpus
    app = FastAPI()
    app.include_router(experiences.build_router(root, store))
    with TestClient(app) as client:
        preview = client.get(f'/api/runs/{run["id"]}/experience').json()
        assert client.post(f'/api/runs/{run["id"]}/experience', json={'preview_hash': preview['preview_hash']}).status_code == 422
        assert client.post(f'/api/runs/{run["id"]}/experience', json={'confirm': False, 'preview_hash': preview['preview_hash']}).status_code == 422
        response = client.post(f'/api/runs/{run["id"]}/experience', json={'confirm': True, 'preview_hash': preview['preview_hash']})
        assert response.status_code == 200
        doc = response.json()
        detail = client.get(f'/api/knowledge/documents/{doc["id"]}').json()
        assert detail['document']['origin'] == 'experience'
        assert detail['pages'] and detail['original_available']
        assert client.get('/api/knowledge/documents/does-not-exist').status_code == 404


@pytest.mark.parametrize('extension', ['.py', '.cpp', '.h', '.hpp', '.ino', '.c', '.cc', '.cxx', '.yaml', '.yml', '.json', '.xml', '.urdf', '.sdf'])
def test_source_upload_is_inert_and_detail_preserves_original(corpus, extension):
    root, _, _ = corpus
    content = f'# SOURCE_LITERAL_MARKER\n__import__("pathlib").Path({str(root / "SHOULD_NOT_EXIST")!r}).touch()\n'
    doc = retrieval.ingest_document(root, 'source' + extension, content.encode(),
                                    {'version': 'fixture-1', 'ros_distro': 'humble', 'board': 'any', 'robot_model': 'any', 'software_versions': GENERIC_SDK})
    detail = retrieval.document_detail(root, doc['id'])
    assert detail['pages'] == [{'page': None, 'text': content}]
    assert not (root / 'SHOULD_NOT_EXIST').exists()
    assert retrieval.retrieve('SOURCE_LITERAL_MARKER', 'joint_position', root=root)


@pytest.mark.parametrize('version', [None, '', 'unknown', 'UNKNOWN', '未标明', '待确认', 'latest'])
def test_unknown_software_version_is_catalog_only(corpus, version):
    root, _, _ = corpus
    doc = retrieval.ingest_document(root, 'unknown.py', b'UNVERSIONED_SOURCE',
                                    {'version': version, 'ros_distro': 'humble', 'board': 'any', 'robot_model': 'any', 'software_versions': GENERIC_SDK})
    assert doc['warnings']
    assert any(row['id'] == doc['id'] for row in retrieval.browse_documents(root))
    assert retrieval.retrieve('UNVERSIONED_SOURCE', 'joint_position', root=root) == []
    assert retrieval.document_detail(root, doc['id'])['document']['generation_eligible'] is False


def test_legacy_document_detail_migrates_from_stored_bytes(corpus):
    root, _, _ = corpus
    doc = retrieval.ingest_document(root, 'manual.txt', b'original exact text', {'version': '1'})
    with retrieval._database(root) as connection:
        connection.execute('DELETE FROM document_pages WHERE document_id=?', (doc['id'],))
    assert retrieval.document_detail(root, doc['id'])['pages'][0]['text'] == 'original exact text'
    with pytest.raises(KeyError):
        retrieval.document_detail(root, '../../README.md')


def test_upload_model_scope_is_explicit_and_matched_before_generation(corpus):
    root, _, _ = corpus
    common = {'version': '1.0', 'ros_distro': 'humble', 'board': 'any', 'software_versions': GENERIC_SDK}
    unknown = retrieval.ingest_document(root, 'unknown.txt', b'MODEL_SCOPE_MARKER unknown', common)
    assert unknown['robot_model'] == 'unknown'
    assert not retrieval.document_detail(root, unknown['id'])['document']['generation_eligible']
    specific = retrieval.ingest_document(root, 'specific.txt', b'MODEL_SCOPE_MARKER specific',
                                         {**common, 'robot_model': 'fixture_robot', 'source_model_sha256': 'a'*64})
    general = retrieval.ingest_document(root, 'general.txt', b'MODEL_SCOPE_MARKER general',
                                        {**common, 'robot_model': 'any'})
    matched = retrieval.retrieve('MODEL_SCOPE_MARKER', root=root, **options())
    assert {item['document_id'] for item in matched} == {specific['id'], general['id']}
    for scope in ({'robot_model': 'other'}, {'source_model_sha256': 'e'*64}, {'source_model_sha256': None}):
        hits = retrieval.retrieve('MODEL_SCOPE_MARKER', root=root, **{**options(), **scope})
        assert {item['document_id'] for item in hits} == {general['id']}
    assert unknown['id'] in {item['document_id'] for item in retrieval.retrieve('MODEL_SCOPE_MARKER', None, root=root, robot_model='any', board='any')}
    detail = retrieval.document_detail(root, specific['id'])['document']
    assert detail['robot_model'] == 'fixture_robot' and detail['source_model_sha256'] == 'a'*64
    assert detail['generation_eligible']


@pytest.mark.parametrize('scope', [
    {'robot_model': 'fixture_robot'}, {'robot_model': 'fixture_robot', 'source_model_sha256': 'bad'},
    {'robot_model': 'any', 'source_model_sha256': 'a'*64},
    {'robot_model': 'unknown', 'source_model_sha256': 'a'*64}, {'robot_model': '../invalid'}])
def test_upload_model_scope_rejects_incomplete_or_inconsistent_metadata(corpus, scope):
    root, _, _ = corpus
    with pytest.raises(ValueError):
        retrieval.ingest_document(root, 'source.cpp', b'example', {'version': '1.0', **scope})


def test_legacy_upload_without_model_scope_is_browse_only(corpus):
    root, _, _ = corpus
    doc = retrieval.ingest_document(root, 'legacy.txt', b'LEGACY_SCOPE_MARKER',
                                    {'version': '1.0', 'ros_distro': 'humble', 'board': 'any', 'robot_model': 'any', 'software_versions': GENERIC_SDK})
    with retrieval._database(root) as connection:
        for table, column, predicate in [('documents', 'metadata', 'id'), ('chunks', 'payload', 'document_id')]:
            for row_id, raw in connection.execute(f'SELECT rowid,{column} FROM {table} WHERE {predicate}=?', (doc['id'],)).fetchall():
                value = json.loads(raw); value.pop('robot_model'); value.pop('source_model_sha256')
                connection.execute(f'UPDATE {table} SET {column}=? WHERE rowid=?', (json.dumps(value), row_id))
    assert not retrieval.retrieve('LEGACY_SCOPE_MARKER', root=root, **options())
    assert not retrieval.document_detail(root, doc['id'])['document']['generation_eligible']
    assert retrieval.retrieve('LEGACY_SCOPE_MARKER', None, root=root, robot_model='any', board='any')


def test_uploaded_sdk_versions_are_matched_before_ranking(corpus):
    root, _, _ = corpus
    common = {'version': 'manual-1.0', 'ros_distro': 'humble', 'board': 'esp32', 'robot_model': 'any'}
    def put(name, sdk):
        return retrieval.ingest_document(root, name+'.txt', b'SDK_SCOPE_MARKER '+name.encode(), {**common, 'software_versions': sdk})
    matching = put('matching', {'esp32_core': '3.3.12', 'arduinojson': '7.4.3'})
    wrong_core = put('old-core', {'esp32_core': '2.0.0', 'arduinojson': 'any'})
    wrong_library = put('old-library', {'esp32_core': 'any', 'arduinojson': '6.0.0'})
    generic = put('general', GENERIC_SDK)
    unknown = put('unknown', {})
    latest = put('latest', {'esp32_core': 'latest', 'arduinojson': 'any'})
    hits = retrieval.retrieve('SDK_SCOPE_MARKER', root=root, **options())
    assert {h['document_id'] for h in hits} == {matching['id'], generic['id']}
    assert {h['document_id'] for h in retrieval.retrieve('SDK_SCOPE_MARKER', root=root, **{**options(), 'software_versions': None})} == {generic['id']}
    for doc in (unknown, latest):
        assert not retrieval.document_detail(root, doc['id'])['document']['generation_eligible']
    assert len(retrieval.retrieve('SDK_SCOPE_MARKER', None, root=root, robot_model='any', board='any')) == 6
    detail = retrieval.document_detail(root, matching['id'])['document']
    assert detail['software_versions'] == options()['software_versions'] and detail['generation_eligible']


@pytest.mark.parametrize('software', [None, [], {'other_sdk': '1'}, {'esp32_core': []}, {'arduinojson': 'arbitrary free text'}])
def test_uploaded_sdk_scope_rejects_invalid_fields(corpus, software):
    root, _, _ = corpus
    with pytest.raises(ValueError):
        retrieval.ingest_document(root, 'sdk.cpp', b'example', {'software_versions': software})


def test_knowledge_api_preserves_declared_sdk_scope(corpus):
    import base64
    from server.app import create_app
    root, _, _ = corpus
    with TestClient(create_app(root)) as client:
        response = client.post('/api/knowledge/documents', json={
            'filename': 'sdk.cpp', 'content_base64': base64.b64encode(b'SDK_API_MARKER').decode(),
            'version': 'manual-1.0', 'board': 'esp32', 'ros_distro': 'humble', 'robot_model': 'any',
            'software_versions': {'esp32_core': '2.0.0', 'arduinojson': 'any'}})
        assert response.status_code == 200, response.text
        doc = response.json()
        assert client.get('/api/knowledge/documents/'+doc['id']).json()['document']['software_versions'] == {'esp32_core': '2.0.0', 'arduinojson': 'any'}
        assert not retrieval.retrieve('SDK_API_MARKER', root=root, **options())
