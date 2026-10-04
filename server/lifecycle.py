"""Import configuration as new drafts; never trust uploaded execution state."""
from __future__ import annotations

import base64
import hashlib
import io
import json
import stat
import zipfile
from pathlib import Path, PurePosixPath

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from .schemas import ProjectInput, GuidedDraftInput, parse_project_input
from .store import now, uid

MAX_ZIP_BYTES = 30_000_000
MAX_EXPANDED_BYTES = 100_000_000
MAX_TEXT_BYTES = 4_000_000
INPUT_KEYS = ('name', 'request', 'task_type', 'parameters', 'hardware', 'prd', 'workflow')


class ImportInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    filename: str = Field(max_length=200)
    content_base64: str = Field(max_length=40_000_000)
    preview_hash: str | None = Field(default=None, max_length=64)
    confirm: bool = False


def draft_input(snapshot):
    """Whitelist only editable fields; status, approval and executable code vanish."""
    value = {k: snapshot[k] for k in INPUT_KEYS if k in snapshot}
    value = json.loads(json.dumps(value, ensure_ascii=False))
    value['name'] = (str(value.get('name', '导入工程'))[:87] + ' · 新草稿')[:100]
    structure = snapshot.get('structure') or {}
    if structure.get('id'):
        value.setdefault('prd', {})['structure_id'] = structure['id']
        intake = value['prd'].get('intake')
        if isinstance(intake, dict) and snapshot.get('execution_model'):
            intake.setdefault('answers', {})['structure_id'] = structure['id']
    return value


def _safe_name(name):
    path = PurePosixPath(name)
    return (bool(name) and '\\' not in name and ':' not in name and not name.startswith('/')
            and all(p not in ('', '.', '..') for p in name.rstrip('/').split('/'))
            and not path.is_absolute())


def read_bundle(payload):
    if not payload or len(payload) > MAX_ZIP_BYTES:
        raise ValueError('工程包为空或超过 30 MB。')
    try:
        archive = zipfile.ZipFile(io.BytesIO(payload))
    except (zipfile.BadZipFile, ValueError) as error:
        raise ValueError('请选择本平台导出的有效 ZIP 工程包。') from error
    with archive:
        entries = archive.infolist()
        if len(entries) > 2000 or sum(i.file_size for i in entries) > MAX_EXPANDED_BYTES:
            raise ValueError('工程包文件数量或展开大小超过限制。')
        names = [i.filename for i in entries]
        if (len(names) != len(set(names)) or any(not _safe_name(n) for n in names)
                or any(i.orig_filename != i.filename for i in entries)):
            raise ValueError('工程包存在重复文件名或不安全路径。')
        if any(i.flag_bits & 1 or stat.S_ISLNK(i.external_attr >> 16) for i in entries):
            raise ValueError('工程包不能包含加密文件或符号链接。')
        if 'spec.json' not in names:
            raise ValueError('工程包缺少 spec.json，不能恢复需求。')

        def text(name):
            info = archive.getinfo(name)
            if info.file_size > MAX_TEXT_BYTES:
                raise ValueError('需求或结构文件超过 4 MB。')
            return archive.read(name).decode('utf-8-sig')

        has_integrity = 'bundle-manifest.json' in names
        if has_integrity:
            manifest = json.loads(text('bundle-manifest.json'))
            if not isinstance(manifest, dict):
                raise ValueError('工程包文件校验清单必须是对象。')
            rows = manifest.get('files')
            if manifest.get('schema_version') != 1 or not isinstance(rows, list):
                raise ValueError('工程包文件校验清单格式不正确。')
            recorded = [r.get('path') for r in rows if isinstance(r, dict)]
            actual = [i.filename for i in entries if not i.is_dir() and i.filename != 'bundle-manifest.json']
            if len(recorded) != len(set(recorded)) or set(recorded) != set(actual):
                raise ValueError('工程包文件清单与实际内容不一致。')
            for row in rows:
                data = archive.read(row['path'])
                if len(data) != row.get('size') or hashlib.sha256(data).hexdigest() != row.get('sha256'):
                    raise ValueError('工程包文件已变化：' + row['path'])
        spec = json.loads(text('spec.json'))
        if not isinstance(spec, dict):
            raise ValueError('需求快照格式不正确。')
        if any(k in spec and not isinstance(spec[k], dict) for k in ('prd', 'hardware', 'parameters')) or any(
                spec.get(k) is not None and not isinstance(spec[k], dict) for k in ('structure', 'execution_model')):
            raise ValueError('需求快照中的参数、硬件或结构格式不正确。')
        record = json.loads(text('run-record.json')) if 'run-record.json' in names else {}
        if not isinstance(record, dict):
            raise ValueError('运行说明格式不正确。')
        if record.get('spec_snapshot') is not None and record['spec_snapshot'] != spec:
            raise ValueError('运行记录与需求快照不一致。')
        source_names = [n for n in names if n.startswith('structure-source.') and '/' not in n]
        if len(source_names) > 1:
            raise ValueError('工程包含有多个结构来源，无法确定应使用哪一个。')
        source = {'filename': source_names[0], 'content': text(source_names[0])} if source_names else None
        return spec, source, record.get('id'), has_integrity


def prepare_import(root, body):
    if Path(body.filename).suffix.lower() != '.zip':
        raise ValueError('请选择 ZIP 工程包。')
    try:
        payload = base64.b64decode(body.content_base64, validate=True)
        spec, source, source_run_id, has_integrity = read_bundle(payload)
        value = draft_input(spec)
        structure = spec.get('structure') or {}
        from .structures import _sophicore, _urdf, get_structure
        if source:
            digest = hashlib.sha256(source['content'].encode('utf-8')).hexdigest()
            if structure.get('content_sha256') and digest != structure['content_sha256']:
                # Old Windows exports used write_text(), which converted LF to
                # CRLF. Accept only an exact original digest after that known
                # reversible conversion; never bypass the content identity.
                normalized = source['content'].replace('\r\n', '\n')
                normalized_digest = hashlib.sha256(normalized.encode('utf-8')).hexdigest()
                if normalized_digest != structure['content_sha256']:
                    raise ValueError('结构原文与需求快照中的摘要不一致。')
                source['content'], digest = normalized, normalized_digest
            if source['filename'].endswith('.json'):
                model = _sophicore(source['content'], root)
            elif source['filename'].endswith(('.urdf', '.xml')):
                model = _urdf(source['content'])
            else:
                raise ValueError('结构来源格式不受支持。')
            model['id'] = 'structure-' + digest[:24]
            value.setdefault('prd', {})['structure_id'] = model['id']
            if isinstance(value['prd'].get('intake'), dict):
                value['prd']['intake'].setdefault('answers', {})['structure_id'] = model['id']
        else:
            form = value.get('prd', {}).get('intake')
            ident = (form.get('answers') or {}).get('structure_id') if isinstance(form, dict) else value.get('prd', {}).get('structure_id')
            if ident and ident.startswith('structure-'):
                raise ValueError('工程包缺少结构原文，请从原工程重新导出。')
            model = get_structure(root, ident) if ident else None if isinstance(form, dict) else get_structure(
                root, 'builtin-joint' if value.get('task_type') == 'joint_position' else 'builtin-sensor')
        parsed = parse_project_input(value)
        guided = isinstance(parsed, GuidedDraftInput)
        is_joint = parsed.prd.intake.intent == 'position' if guided else parsed.task_type == 'joint_position'
        selected = parsed.prd.intake.answers.joint_name if guided else parsed.prd.joint_name
        target = parsed.prd.intake.answers.target_rad if guided else parsed.parameters.target
        if is_joint and (not guided or model and selected and target is not None):
            from worker.robot_model import build_execution_model
            selected = selected or ('test_joint' if model.get('id') == 'builtin-joint' else None)
            if not selected:
                raise ValueError('工程没有指定要控制的关节。')
            execution = build_execution_model(model, selected)
            joint = next(j for j in execution['joints'] if j['name'] == selected)
            if not joint['limits']['lower'] <= target <= joint['limits']['upper']:
                raise ValueError('目标角度超出结构中的关节范围。')
        warnings = ['只恢复需求、参数和结构；必须重新拆分、核对、生成和检查。',
                    '不执行包内程序，不恢复旧批准、部署或通过状态。']
        if not has_integrity:
            warnings.append('这是旧版工程包，没有逐文件 SHA256 清单；将作为未验证草稿导入。')
        preview = {'preview_hash': hashlib.sha256(payload).hexdigest(), 'name': parsed.name,
                   'task_type': parsed.task_type, 'board': parsed.prd.intake.answers.board if guided else parsed.hardware.board,
                   'joint_name': selected, 'source_run_id': source_run_id,
                   'warnings': warnings, 'has_integrity': has_integrity}
        return parsed, source, preview
    except (UnicodeError, json.JSONDecodeError, zipfile.BadZipFile, KeyError, TypeError, OverflowError, RecursionError, NotImplementedError) as error:
        raise ValueError('工程包的需求、结构或文件校验格式不正确。') from error


def build_router(root, store, jobs, project_value, project_response):
    router = APIRouter()

    def create_draft(body, origin, old_snapshot=None):
        value = project_value(body)
        if old_snapshot:
            expected = (old_snapshot.get('execution_model') or {}).get('model_sha256')
            actual = (value.get('execution_model') or {}).get('model_sha256')
            old_source = (old_snapshot.get('structure') or {}).get('content_sha256')
            new_source = (value.get('structure') or {}).get('content_sha256')
            if (expected and expected != actual) or (old_source and old_source != new_source):
                raise ValueError('结构来源或模型生成规则与历史版本不同，无法原样复用。请重新导入原结构并新建需求；旧运行保留不变。')
        value.update(id=uid(), spec_revision=1, status='draft', plan=None, approval=None,
                     latest_run_id=None, error=None, created_at=now(), updated_at=now(), origin=origin)
        store.put('project', value)
        store.record_project_history(value, 'created_from_copy')
        return project_response(value)

    @router.get('/api/projects/{pid}/history')
    def history(pid: str):
        store.get('project', pid)
        return {'items': [h for h in store.list('project_history') if h['project_id'] == pid]}

    @router.post('/api/projects/{pid}/history/{hid}/clone')
    def clone_history(pid: str, hid: str):
        with jobs.lock:
            store.get('project', pid)
            old = store.get('project_history', hid)
            if old['project_id'] != pid:
                raise HTTPException(404, '该版本不属于这个工程。')
            try:
                return create_draft(parse_project_input(draft_input(old['snapshot'])),
                                    {'kind': 'history', 'project_id': pid, 'history_id': hid}, old['snapshot'])
            except ValueError as error:
                raise HTTPException(422, '旧需求不符合当前输入要求，请手动新建并补齐：' + str(error))

    @router.post('/api/runs/{rid}/clone')
    def clone_run(rid: str):
        with jobs.lock:
            old = store.get('run', rid)
            try:
                return create_draft(parse_project_input(draft_input(old['spec_snapshot'])),
                                    {'kind': 'run', 'run_id': rid, 'project_id': old['project_id']}, old['spec_snapshot'])
            except ValueError as error:
                raise HTTPException(422, '旧需求不符合当前输入要求，请手动新建并补齐：' + str(error))

    @router.post('/api/projects/import/preview')
    def import_preview(body: ImportInput):
        try:
            return prepare_import(root, body)[2]
        except ValueError as error:
            raise HTTPException(422, str(error))

    @router.post('/api/projects/import')
    def import_project(body: ImportInput):
        try:
            with jobs.lock:
                parsed, source, preview = prepare_import(root, body)
                if not body.confirm or body.preview_hash != preview['preview_hash']:
                    raise HTTPException(409, '请先预览并确认当前这份工程包。')
                if source:
                    from .structures import ingest_structure
                    model = ingest_structure(root, source['filename'], source['content'])
                    parsed.prd.structure_id = model['id']
                    if isinstance(parsed, GuidedDraftInput):
                        parsed.prd.intake.answers.structure_id = model['id']
                return create_draft(parsed, {'kind': 'import', 'source_run_id': preview['source_run_id'],
                                             'bundle_sha256': preview['preview_hash'], 'has_integrity': preview['has_integrity']})
        except ValueError as error:
            raise HTTPException(422, str(error))

    return router
