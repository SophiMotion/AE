"""Small transactional JSON store; one database per local workbench."""
import hashlib
import json
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

ACTIVE = {'planning', 'queued', 'generating', 'building', 'testing', 'repairing', 'deploying'}


def now():
    return datetime.now(timezone.utc).isoformat()


def uid():
    return uuid.uuid4().hex


def specification(project):
    from worker.contract import project_contract
    if project.get('pipeline_version') == 5:
        from worker.motion_spec_v5 import motion_contract
        return {**{key: project[key] for key in ('name','request','task_type','parameters','hardware','spec_revision')},
            'prd':project.get('prd',{}),'structure':project.get('structure'),'pipeline_version':5,
            'manifest':project.get('manifest'),'execution_model':project.get('execution_model'),
            'motion_program':project.get('motion_program'),'workflow':project.get('workflow'),**motion_contract(project)}
    is_v3 = project.get('pipeline_version', 2) >= 3
    contract = project_contract(project if is_v3 else None)
    return {**{key: project[key] for key in ('name', 'request', 'task_type', 'parameters', 'hardware', 'spec_revision')},
            'prd': project.get('prd', {}), 'structure': project.get('structure'),
            **({'pipeline_version': 3, 'manifest': project.get('manifest'), 'execution_model': project.get('execution_model'), 'workflow': project.get('workflow')} if is_v3 else {}),
            'communication': contract['communication'], 'simulation': contract['simulation']}


def spec_hash(project):
    return hashlib.sha256(json.dumps(specification(project), sort_keys=True, ensure_ascii=False).encode()).hexdigest()


class Store:
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        with self.connection() as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE IF NOT EXISTS objects (kind TEXT, id TEXT, payload TEXT, PRIMARY KEY(kind,id))')

    def connection(self):
        return sqlite3.connect(self.path, timeout=20)

    def get(self, kind, ident):
        with self.lock, self.connection() as db:
            row = db.execute('SELECT payload FROM objects WHERE kind=? AND id=?', (kind, ident)).fetchone()
        if row is None:
            raise KeyError(ident)
        return json.loads(row[0])

    def put(self, kind, value):
        with self.lock, self.connection() as db:
            db.execute('INSERT OR REPLACE INTO objects VALUES (?,?,?)', (kind, value['id'], json.dumps(value, ensure_ascii=False, allow_nan=False)))
        return value

    def update(self, kind, ident, mutate):
        with self.lock:
            value = self.get(kind, ident)
            result = mutate(value)
            value['updated_at'] = now()
            self.put(kind, value)
            return value if result is None else result

    def list(self, kind):
        with self.lock, self.connection() as db:
            rows = db.execute('SELECT payload FROM objects WHERE kind=?', (kind,)).fetchall()
        return sorted([json.loads(r[0]) for r in rows], key=lambda x: x.get('created_at', ''), reverse=True)

    def record_project_history(self, project, event):
        """Keep an immutable copy before/after a user-visible revision change."""
        snapshot = json.loads(json.dumps(project, ensure_ascii=False, allow_nan=False))
        snapshot.pop('history', None)
        value = {'id': uid(), 'project_id': project['id'],
                 'revision': project.get('spec_revision', 1), 'event': str(event),
                 'created_at': now(), 'snapshot': snapshot}
        return self.put('project_history', value)

    def recover(self):
        live_states = []
        for kind in ('project', 'run'):
            for value in self.list(kind):
                if value.get('status') in ACTIVE:
                    if kind == 'run':
                        directory = self.path.parent.parent / 'runs' / value['id']
                        if directory.exists():
                            for output in directory.iterdir():
                                if output.is_dir() and not output.is_symlink() and (output.name.startswith('attempt-') or output.name.startswith('deployment-')):
                                    (output / 'cancel.flag').touch()
                                    live_states.append(output / 'worker-state.json')
                        if (value.get('deployment') or {}).get('status') == 'running':
                            value['deployment'].update(status='interrupted', finished_at=now())
                    value.update(status='interrupted', updated_at=now(), error='服务重启，上一轮已中断。请重新运行；没有自动重复执行。')
                    self.put(kind, value)
        # The worker also stops itself on heartbeat expiry after a server crash.
        deadline = time.monotonic() + 5
        while live_states and time.monotonic() < deadline:
            pending = []
            for path in live_states:
                try:
                    if path.exists() and json.loads(path.read_text(encoding='utf-8')).get('status') == 'running':
                        pending.append(path)
                except (OSError, ValueError):
                    pending.append(path)
            live_states = pending
            if live_states:
                time.sleep(0.1)
