"""V4 review/repair/integrity contracts. All execution below uses test doubles."""
import copy
import json
import threading

import pytest

from server.jobs import Jobs, JobError
from server.providers import GenerationRejected, ProviderError, ProviderCancelled, _parse_object, PLAN_SCHEMA
from server.requirements import build_coverage, source_fields, executable_checks
from server.integrity import protected_snapshot, seal_run, verify_run_integrity, IntegrityError
from server.schemas import ProjectInput
from server.structures import attach_structure
from server.workflow import default_workflow
from server.manifest import build_manifest
from server.store import Store, specification, spec_hash
from worker.device_logic import DEFAULT_DEVICE_CODE

CODE = 'def compute_command(value, target, threshold, max_velocity):\n    return max(-max_velocity,min(max_velocity,2*(target-value)))\n'


@pytest.fixture
def case(tmp_path):
    project = attach_structure(tmp_path, ProjectInput(name='V4 fixture', request='Move one joint to the configured target', task_type='joint_position').model_dump())
    project.update(id='project', spec_revision=1, workflow=default_workflow(), status='approved')
    project['manifest'] = build_manifest(project)
    project['plan'] = {'summary': 'test double', 'sources': []}
    project['approval'] = {'spec_hash': spec_hash(project)}
    run = {'id': 'run', 'project_id': 'project', 'status': 'queued', 'attempt': 0,
           'spec_snapshot': specification(project), 'approval': project['approval'],
           'events': [], 'result': None, 'code_versions': [], 'provenance': [], 'artifacts': [], 'deployment': None}
    store = Store(tmp_path / '.tools' / 'workbench.sqlite3')
    store.put('project', project); store.put('run', run)
    (tmp_path / 'worker').mkdir()
    (tmp_path / 'worker' / 'runtime.py').write_text('# trusted test fixture\n')
    jobs = Jobs(tmp_path, store, lambda: {})
    yield tmp_path, project, run, store, jobs
    jobs.close()


def coverage_items(spec):
    return [{'source_field': field, 'text': text, 'status': 'covered',
             'check_ids': ['task_behavior'], 'reason': 'test mapping, not semantic proof'}
            for field, text in source_fields(spec).items() if text.strip()]


def test_every_text_field_is_visible_and_tools_own_numeric_expectations(case):
    _, project, run, _, _ = case
    spec = run['spec_snapshot']
    coverage = build_coverage(spec, coverage_items(spec))
    assert {entry['source_field']: entry['text'] for entry in coverage['items']} == source_fields(spec)
    assert '0.04' in next(c['expected'] for c in coverage['checks'] if c['id'] == 'tolerance')
    sensor = copy.deepcopy(spec); sensor['task_type'] = 'sensor_threshold'
    ids = {c['id'] for c in executable_checks(sensor)}
    assert 'threshold' in ids and not {'target', 'tolerance', 'max_velocity'} & ids


@pytest.mark.parametrize('mistake', ['omit', 'rewrite', 'duplicate', 'invent_check', 'no_check'])
def test_coverage_rejects_omitted_prose_or_nonexistent_checks(case, mistake):
    spec = case[2]['spec_snapshot']; items = coverage_items(spec)
    if mistake == 'omit': items.pop()
    if mistake == 'rewrite': items[0]['text'] = 'changed original'
    if mistake == 'duplicate': items.append(items[0])
    if mistake == 'invent_check': items[0]['check_ids'] = ['robot_navigation']
    if mistake == 'no_check': items[0]['check_ids'] = []
    with pytest.raises(ValueError): build_coverage(spec, items)


@pytest.mark.parametrize('status', ['unsupported', 'conflict'])
def test_unsupported_and_conflict_are_blocking(case, status):
    spec = case[2]['spec_snapshot']; items = coverage_items(spec)
    items[0].update(status=status, check_ids=[], reason='cannot run this requirement')
    assert build_coverage(spec, items)['blocking_issues']


def test_plan_schema_validates_nested_items(case):
    plan = {'summary': 'test', **{key: [] for key in ('ros_tasks','esp32_tasks','communication','checks','missing_information','citations','blocking_issues')}}
    plan['requirement_items'] = coverage_items(case[2]['spec_snapshot'])
    assert _parse_object(json.dumps(plan), PLAN_SCHEMA)['requirement_items']
    plan['requirement_items'][0]['status'] = 'everything_works'
    with pytest.raises(ProviderError): _parse_object(json.dumps(plan), PLAN_SCHEMA)


def test_rejected_source_is_recorded_and_repaired_without_execution(case, monkeypatch):
    root, project, run, store, jobs = case
    calls, executions = [], []
    candidate = {'code': CODE.replace(':\n', '\n', 1), 'firmware_code': DEFAULT_DEVICE_CODE}
    def generate(*args, **kwargs):
        calls.append(kwargs)
        if len(calls) == 1:
            raise GenerationRejected('Python syntax line 1', candidate, {'tool':'test double','response':json.dumps(candidate)})
        return {'code': CODE, 'firmware_code': DEFAULT_DEVICE_CODE, 'explanation':'fixed syntax', 'provenance':{'tool':'test double'}}
    def execute(pid, rid, spec, code, out, cancel):
        executions.append(code.read_text(encoding='utf-8'))
        result = {'passed': True, 'scope': 'test double only'}
        (out/'result.json').write_text(json.dumps(result))
        return result
    monkeypatch.setattr('server.providers.generate_code', generate)
    monkeypatch.setattr('server.retrieval.retrieve', lambda *a, **k: [])
    monkeypatch.setattr(jobs, 'execute', execute)
    jobs._run(project, run, {}, threading.Event(), None)
    final = store.get('run', 'run')
    assert final['status'] == 'passed' and executions == [CODE]
    assert calls[1]['previous_code'] == candidate['code'] and 'Python syntax line 1' in calls[1]['failure']
    assert [v['status'] for v in final['code_versions']] == ['rejected', 'accepted']
    assert not (root/'runs'/'run'/'attempt-1'/'algorithm.py').exists()
    assert json.loads((root/'runs'/'run'/'attempt-1'/'result.json').read_text())['candidate_executed'] is False
    assert verify_run_integrity(root, final)['fingerprint'] == final['integrity']['fingerprint']


@pytest.mark.parametrize('kind,count', [('invalid',3), ('network',1), ('cancel',1)])
def test_retry_budget_does_not_blindly_retry_transport_or_cancel(case, monkeypatch, kind, count):
    _, project, run, store, jobs = case
    calls = []
    cancel = threading.Event()
    def generate(*args, **kwargs):
        calls.append(1)
        if kind == 'invalid': raise GenerationRejected('bad candidate', {'code':'not python'}, {'response':'raw invalid output'})
        if kind == 'cancel':
            cancel.set(); raise ProviderCancelled('cancelled by user')
        raise ProviderError('HTTP 401 authentication failed')
    monkeypatch.setattr('server.providers.generate_code', generate)
    monkeypatch.setattr('server.retrieval.retrieve', lambda *a, **k: [])
    monkeypatch.setattr(jobs, 'execute', lambda *a, **k: pytest.fail('must never execute'))
    jobs._run(project, run, {}, cancel, None)
    final = store.get('run', 'run')
    assert len(calls) == count
    assert final['status'] == ('cancelled' if kind == 'cancel' else 'failed')
    if kind == 'invalid': assert len(final['code_versions']) == 3


def _sealed(case):
    root, project, run, store, jobs = case
    out = root/'runs'/'run'/'attempt-1'; out.mkdir(parents=True)
    (out/'algorithm.py').write_text(CODE, encoding='utf-8')
    (out/'device_logic.cpp').write_text(DEFAULT_DEVICE_CODE, encoding='utf-8')
    (out/'result.json').write_text('{"passed":true,"scope":"fixture"}')
    run.update(status='passed', attempt=1, code_versions=[{'attempt':1,'code':CODE,'firmware_code':DEFAULT_DEVICE_CODE,'status':'accepted'}])
    (out.parent/'spec.json').write_text(json.dumps(run['spec_snapshot']), encoding='utf-8')
    run['integrity'] = seal_run(root, run, protected_snapshot(root))
    store.put('run', run)
    return run, out


@pytest.mark.parametrize('changed', ['code','spec','template','fingerprint','missing','manifest'])
def test_changed_passed_files_or_templates_cannot_deploy(case, changed):
    run, out = _sealed(case); root = case[0]
    if changed == 'code': (out/'algorithm.py').write_text(CODE+'# local edit\n')
    if changed == 'spec': run['spec_snapshot']['parameters']['target'] = .7
    if changed == 'template': (root/'worker'/'runtime.py').write_text('# upgraded\n')
    if changed == 'fingerprint': run['integrity']['fingerprint'] = '0'*64
    if changed == 'missing': (out/'device_logic.cpp').unlink()
    if changed == 'manifest': (out.parent/'integrity.json').write_text('{}')
    with pytest.raises(IntegrityError): verify_run_integrity(root, run)
    if changed == 'template': assert verify_run_integrity(root, run, check_templates=False)


def test_deploy_confirmation_binds_passed_fingerprint(case, monkeypatch):
    run, _ = _sealed(case); _, _, _, store, jobs = case
    monkeypatch.setattr(jobs.pool, 'submit', lambda *a: None)
    with pytest.raises(JobError, match='确认'): jobs.deploy('run', 'another-version')
    deployed = jobs.deploy('run', run['integrity']['fingerprint'])
    assert deployed['status'] == 'deploying'


def test_retry_cannot_silently_use_another_requirement_version(case, monkeypatch):
    _, project, run, store, jobs = case
    run['spec_snapshot']['parameters']['target'] = .2
    store.put('run', run)
    monkeypatch.setattr(jobs.pool, 'submit', lambda *a: pytest.fail('must not queue'))
    with pytest.raises(JobError, match='需求与该失败版本不同'): jobs.start('project', previous='run')


def test_failed_plan_keeps_model_provenance_for_page(case, monkeypatch):
    _, project, _, store, jobs = case
    provenance = {'tool':'test double','prompt':'exact test prompt','response':'invalid plan'}
    def generate(*args, **kwargs): raise ProviderError('plan incomplete', provenance)
    monkeypatch.setattr('server.providers.generate_plan', generate)
    monkeypatch.setattr('server.retrieval.retrieve', lambda *a, **k: [])
    jobs._plan(project, {}, threading.Event())
    assert store.get('project', 'project')['plan_failure_provenance'] == provenance


@pytest.mark.parametrize('fault', ['python', 'firmware', 'schema', 'json'])
def test_provider_rejection_preserves_raw_response_and_safe_candidate(case, monkeypatch, fault):
    from server import providers
    root, _, run, _, _ = case
    output = root/'provider-fixture'; output.mkdir()
    monkeypatch.setattr(providers, 'ROOT', root)
    response = {'code':CODE, 'firmware_code':DEFAULT_DEVICE_CODE, 'explanation':'fixture'}
    if fault == 'python': response['code'] = CODE.replace(':\n', '\n')
    if fault == 'firmware': response['firmware_code'] = DEFAULT_DEVICE_CODE.replace('return value;', 'return 1e999;')
    if fault == 'schema': response['unexpected'] = 'invalid schema'
    raw = '{broken json' if fault == 'json' else json.dumps(response)
    monkeypatch.setattr(providers, '_codex_invoke', lambda *a, **k: raw)
    with pytest.raises(GenerationRejected) as caught:
        providers.generate_code(run['spec_snapshot'], {}, [], {'provider':'codex'}, output, threading.Event(), lambda message:None)
    error = caught.value
    assert error.provenance['response'] == raw
    assert error.provenance['status'] == 'failed'
    assert error.candidate.get('code') == (None if fault == 'json' else response['code'])
    records = list(output.glob('provider-code-*.json'))
    assert len(records) == 1 and json.loads(records[0].read_text(encoding='utf-8'))['response'] == raw
