"""Independent job-lifecycle review. Model and ROS calls are isolated test doubles."""
import io
import json
import threading
from pathlib import Path

import pytest

from server.jobs import Jobs, JobError
from server.store import Store, now, spec_hash, specification
from server import providers, retrieval


@pytest.fixture
def jobcase(tmp_path):
    store = Store(tmp_path / 'state.sqlite3')
    jobs = Jobs(tmp_path, store, lambda: {'provider': 'codex'})
    project = {'id': 'project', 'name': 'Review fixture', 'request': 'joint test',
               'task_type': 'joint_position', 'parameters': {'target': .6, 'threshold': .5,
                    'max_velocity': .8, 'tolerance': .04, 'duration': 8.0},
               'hardware': {'board': 'esp32', 'ros_distro': 'humble', 'transport': 'serial_jsonl'},
               'spec_revision': 1, 'status': 'approved', 'created_at': now(),
               'plan': {'summary': 'test'}, 'approval': None}
    project['approval'] = {'spec_revision': 1, 'spec_hash': spec_hash(project), 'approved_at': now()}
    store.put('project', project)
    run = {'id': 'run', 'project_id': project['id'], 'status': 'queued', 'attempt': 1,
           'created_at': now(), 'updated_at': now(), 'spec_snapshot': specification(project),
           'events': [], 'result': None, 'artifacts': [], 'error': None, 'code_versions': [],
           'provenance': [], 'deployment': None, 'approval': project['approval']}
    store.put('run', run)
    yield jobs, store, project, run
    jobs.close()


def test_start_checks_current_spec_hash(jobcase, monkeypatch):
    jobs, store, project, _ = jobcase
    project['parameters']['target'] = .4
    store.put('project', project)
    monkeypatch.setattr(jobs.pool, 'submit', lambda *args: None)
    with pytest.raises(JobError, match='核对'):
        jobs.start(project['id'])


def test_deploying_older_run_becomes_current_cancel_target(jobcase, monkeypatch):
    jobs, store, project, run = jobcase
    project.update(status='failed', latest_run_id='newer-failed-run')
    store.put('project', project)
    run.update(status='passed')
    store.put('run', run)
    store.put('run', {**run, 'id': 'newer-failed-run', 'status': 'failed'})
    monkeypatch.setattr(jobs.pool, 'submit', lambda *args: None)
    jobs.deploy(run['id'])
    active = store.get('project', project['id'])
    assert active['latest_run_id'] == run['id']
    jobs.cancel(active['latest_run_id'])
    assert jobs.cancels[run['id']].is_set()


def test_precancelled_job_does_not_generate(jobcase, monkeypatch):
    jobs, store, project, run = jobcase
    monkeypatch.setattr(providers, 'generate_code', lambda *a, **kw: pytest.fail('must not call model'))
    cancel = threading.Event()
    cancel.set()
    jobs._run(project, run, {}, cancel, None)
    assert store.get('run', run['id'])['status'] == 'cancelled'


def test_initialization_failure_becomes_failed_not_unhandled(jobcase, monkeypatch):
    jobs, store, project, run = jobcase
    def corrupt_index(*args, **kwargs):
        raise ValueError('knowledge file invalid')
    monkeypatch.setattr(retrieval, 'retrieve', corrupt_index)
    jobs._run(project, run, {}, threading.Event(), None)
    result = store.get('run', run['id'])
    assert result['status'] == 'failed'
    assert 'knowledge file invalid' in result['error']


def test_repair_receives_actual_build_log(jobcase, monkeypatch):
    jobs, store, project, run = jobcase
    captures = []
    def generate(*args, **kwargs):
        captures.append(kwargs.get('failure'))
        return {'code': 'def compute_command(value, target, threshold, max_velocity):\n    return 0.0\n',
                'explanation': 'fixture', 'provenance': {}}
    calls = 0
    def execute(pid, rid, spec, code, out, cancel, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            (out / 'build.log').write_text('ACTUAL_DIAGNOSTIC: missing dependency rclpy', encoding='utf-8')
            return {'passed': False, 'checks': [{'name': 'build', 'passed': False, 'detail': 'see build.log'}]}
        return {'passed': True, 'checks': [{'name': 'build', 'passed': True, 'detail': 'ok'}]}
    monkeypatch.setattr(providers, 'generate_code', generate)
    monkeypatch.setattr(jobs, 'execute', execute)
    jobs._run(project, run, {}, threading.Event(), None)
    assert len(captures) == 2
    assert 'ACTUAL_DIAGNOSTIC' in captures[1]


def test_deployment_exception_has_terminal_substatus(jobcase, monkeypatch):
    jobs, store, project, run = jobcase
    folder = jobs.root / 'runs' / run['id']
    folder.mkdir(parents=True)
    run['deployment'] = {'status': 'running'}
    store.put('run', run)
    def failure(*a, **kw):
        raise JobError('failed to launch deployment')
    monkeypatch.setattr(jobs, 'execute', failure)
    jobs._deploy(run, threading.Event())
    result = store.get('run', run['id'])
    assert result['status'] == 'failed'
    assert result['deployment']['status'] == 'failed'
    assert result['deployment'].get('finished_at')


@pytest.mark.parametrize('exit_code, passed, checks, expected', [
    (1, True, [{'name': 'check', 'passed': True}], False),
    (0, True, [{'name': 'check', 'passed': False}], False),
    (0, True, [], False),
    (0, 'false', [{'name': 'check', 'passed': True}], False),
    (0, 1, [{'name': 'check', 'passed': True}], False),
])
def test_result_fails_closed(jobcase, monkeypatch, exit_code, passed, checks, expected):
    jobs, store, project, run = jobcase
    out = jobs.root / 'runs' / run['id'] / 'attempt-1'
    out.mkdir(parents=True)
    worker = jobs.root / 'worker'
    worker.mkdir()
    (worker / 'execute.py').write_text('# fixture', encoding='utf-8')
    (out / 'result.json').write_text(json.dumps({'passed': passed, 'checks': checks,
          'ros_verified': False, 'physical_verified': False, 'metrics': {}, 'series': []}), encoding='utf-8')
    (out / 'spec.json').write_text(json.dumps(specification(project)), encoding='utf-8')
    class Process:
        stdout = io.StringIO('')
        def poll(self): return exit_code
        def wait(self, timeout=None): return exit_code
    monkeypatch.setattr('server.jobs.subprocess.Popen', lambda *a, **kw: Process())
    result = jobs.execute(project['id'], run['id'], out / 'spec.json', out / 'algorithm.py', out, threading.Event())
    assert result['passed'] is expected


@pytest.mark.parametrize('deployment', [None, {'status': 'running'}])
def test_recover_marks_interrupted_and_cancels_existing_worker_dirs(tmp_path, deployment):
    store = Store(tmp_path / '.tools' / 'workbench.sqlite3')
    store.put('project', {'id': 'p', 'status': 'testing', 'created_at': now()})
    store.put('run', {'id': 'active', 'status': 'testing', 'deployment': deployment, 'created_at': now()})
    store.put('run', {'id': 'completed', 'status': 'passed', 'deployment': None, 'created_at': now()})
    for name in ('attempt-1', 'deployment-a'):
        output = tmp_path / 'runs' / 'active' / name
        output.mkdir(parents=True)
        (output / 'worker-state.json').write_text('{"status":"stopped"}', encoding='utf-8')
    unrelated = tmp_path / 'runs' / 'active' / 'assets'
    unrelated.mkdir()
    store.recover()
    assert store.get('project', 'p')['status'] == 'interrupted'
    run = store.get('run', 'active')
    assert run['status'] == 'interrupted'
    assert (tmp_path / 'runs' / 'active' / 'attempt-1' / 'cancel.flag').exists()
    assert (tmp_path / 'runs' / 'active' / 'deployment-a' / 'cancel.flag').exists()
    assert not (unrelated / 'cancel.flag').exists()
    assert store.get('run', 'completed')['status'] == 'passed'
    if deployment is None:
        assert run['deployment'] is None
    else:
        assert run['deployment']['status'] == 'interrupted'
        assert run['deployment']['finished_at']


@pytest.mark.parametrize('firmware,communication', [(None, None), ({'passed': True}, None), ('invalid', {'passed': True})])
def test_incomplete_firmware_evidence_keeps_worker_diagnostics(jobcase, monkeypatch, firmware, communication):
    jobs, _, project, run = jobcase
    project['hardware']['board'] = 'esp32'
    out = jobs.root / 'runs' / run['id'] / 'attempt-1'
    out.mkdir(parents=True)
    worker = jobs.root / 'worker'
    worker.mkdir()
    (worker / 'execute.py').write_text('# fixture', encoding='utf-8')
    # Even if a worker incorrectly reports overall success, missing evidence must
    # become a readable failure without throwing away its original diagnostics.
    (out / 'result.json').write_text(json.dumps({'passed': True, 'checks': [{'name': 'ros', 'passed': True}],
        'ros_verified': True, 'firmware': firmware, 'communication_test': communication,
        'failure_scope': 'environment', 'error': 'fixed toolchain unavailable'}), encoding='utf-8')
    (out / 'spec.json').write_text(json.dumps(specification(project)), encoding='utf-8')
    class Process:
        stdout = io.StringIO('')
        def poll(self): return 0
        def wait(self, timeout=None): return 0
    monkeypatch.setattr('server.jobs.subprocess.Popen', lambda *a, **kw: Process())
    result = jobs.execute(project['id'], run['id'], out / 'spec.json', out / 'algorithm.py', out, threading.Event())
    assert result['passed'] is False
    assert result['failure_scope'] == 'environment'
    assert result['error'] == 'fixed toolchain unavailable'
    assert any(item['name'] == 'result_contract' for item in result['checks'])


def test_archive_skips_colcon_trees_before_touching_wsl_only_entries(jobcase, monkeypatch):
    """Windows must archive source/evidence without stat'ing WSL colcon links."""
    jobs, store, _, run = jobcase
    base = jobs.root / 'runs' / run['id']
    attempt = base / 'attempt-1'
    source = attempt / 'ros_ws' / 'src' / 'ae_generated' / 'package.xml'
    source.parent.mkdir(parents=True)
    source.write_text('<package/>', encoding='utf-8')
    (attempt / 'algorithm.py').write_text('def compute_command(): pass', encoding='utf-8')
    (attempt / 'build.log').write_text('actual compiler evidence', encoding='utf-8')
    (attempt / 'old.zip').write_bytes(b'not part of a new archive')
    excluded = [attempt / 'ros_ws' / name for name in ('build', 'install', 'log')]
    excluded += [attempt / '__pycache__', attempt / '.git']
    for directory in excluded:
        (directory / 'latest').mkdir(parents=True)
        (directory / 'latest' / 'wsl-only-entry').write_text('fixture', encoding='utf-8')

    original_stat = Path.stat
    touched = []

    def reject_excluded_stat(path, *args, **kwargs):
        if any(path == directory or directory in path.parents for directory in excluded):
            touched.append(str(path))
            error = OSError(1920, 'WSL reparse point cannot be accessed from Windows')
            error.winerror = 1920
            raise error
        return original_stat(path, *args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(Path, 'stat', reject_excluded_stat)
        jobs.archive_artifacts(run['id'])

    assert touched == []
    artifacts = store.get('run', run['id'])['artifacts']
    assert {item['path'] for item in artifacts} == {
        'attempt-1/algorithm.py', 'attempt-1/build.log',
        'attempt-1/ros_ws/src/ae_generated/package.xml',
    }
    assert all(item['size'] > 0 for item in artifacts)
