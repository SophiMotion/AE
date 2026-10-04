"""Single-user local service. Run with python -m server.app from the project root."""
import json
import base64
import binascii
import os
import threading
import asyncio
import zipfile
import io
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlparse
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ConfigDict
from starlette.middleware.gzip import GZipMiddleware
from .jobs import Jobs, JobError
from .schemas import ProjectInput, GuidedDraftInput, parse_project_input, ApprovalInput, DeployInput, SettingsInput, TASKS
from .store import Store, ACTIVE, now, uid
from .structures import list_structures, get_structure, ingest_structure, attach_structure, MODEL_LIMIT
from .workflow import default_workflow, validate_workflow

ROOT = Path(__file__).resolve().parents[1]

BOARDS = [
    {'id': 'esp32', 'label': 'ESP32 通用编译目标', 'fqbn': 'esp32:esp32:esp32'},
    {'id': 'esp32s3', 'label': 'ESP32-S3 通用编译目标', 'fqbn': 'esp32:esp32:esp32s3'},
]


class StructureInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    filename: str = Field(min_length=1, max_length=200)
    content: str = Field(max_length=MODEL_LIMIT)


class DocumentInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    filename: str = Field(min_length=1, max_length=200)
    content_base64: str = Field(max_length=14_000_000)
    title: str = Field(default='', max_length=200)
    url: str = Field(default='', max_length=1000)
    version: str = Field(default='unknown', max_length=100)
    board: str = Field(default='unknown', max_length=100)
    ros_distro: str = Field(default='unknown', max_length=100)
    robot_model: str = Field(default='unknown', max_length=100)
    source_model_sha256: str | None = Field(default=None, max_length=64)
    software_versions: dict[str, str] = Field(default_factory=lambda: {'esp32_core': 'unknown', 'arduinojson': 'unknown'}, max_length=2)
    task_types: list[str] = Field(default_factory=lambda: ['joint_position', 'sensor_threshold'], max_length=10)
    tags: list[str] = Field(default_factory=list, max_length=30)


class Settings:
    def __init__(self, root):
        self.path = root / '.tools' / 'settings.json'
        self.lock = threading.RLock()
        self.value = {'provider': 'codex', 'model': 'gpt-6.1-sol', 'base_url': 'https://api.openai.com/v1'}
        if self.path.exists():
            self.value.update(json.loads(self.path.read_text(encoding='utf-8')))
        self.key = os.environ.get('AE_API_KEY', '')

    def private(self):
        with self.lock:
            return {**self.value, 'api_key': self.key}

    def public(self):
        import shutil
        with self.lock:
            value = dict(self.value)
            value.update(key_configured=bool(self.key), key_storage='仅当前进程；重启后需重新填写或配置 AE_API_KEY',
                         codex_available=bool(shutil.which('codex') or list(Path(os.environ.get('LOCALAPPDATA', 'C:/none')).glob('OpenAI/Codex/bin/*/codex.exe'))))
            return value

    def update(self, body):
        config = body.model_dump()
        parsed = urlparse(config['base_url'])
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise JobError('服务地址不能包含密码、查询参数或片段。')
        if parsed.scheme != 'https' and not (parsed.scheme == 'http' and parsed.hostname in {'localhost', '127.0.0.1', '::1'}):
            raise JobError('远程模型服务使用 HTTPS；本机服务可以使用 HTTP。')
        with self.lock:
            key = config.pop('api_key')
            if key is not None:
                self.key = key
            self.value = config
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding='utf-8')
        return self.public()


def create_app(root: Path = ROOT):
    root = root.resolve()
    store = Store(root / '.tools' / 'workbench.sqlite3')
    settings = Settings(root)
    jobs = Jobs(root, store, settings.private)

    @asynccontextmanager
    async def lifespan(app):
        store.recover()
        yield
        jobs.close()

    app = FastAPI(title='Auto Engineering Local', version='0.4.0', lifespan=lifespan)
    app.add_middleware(GZipMiddleware, minimum_size=2000)
    app.state.store, app.state.jobs, app.state.settings = store, jobs, settings

    @app.middleware('http')
    async def local_only(request: Request, call_next):
        host = request.headers.get('host', '').split(':')[0]
        if host not in {'localhost', '127.0.0.1', 'testserver'}:
            return JSONResponse({'detail': '本地工作台仅接受本机访问。'}, status_code=403)
        origin = request.headers.get('origin')
        allowed = {'http://localhost:8877', 'http://127.0.0.1:8877', 'http://localhost:5178', 'http://127.0.0.1:5178'}
        if origin and origin not in allowed:
            return JSONResponse({'detail': '不允许这个网页发起操作。'}, status_code=403)
        response = await call_next(request)
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'no-referrer'
        if request.url.path.startswith('/api/'):
            response.headers['Cache-Control'] = 'no-store'
        return response

    @app.exception_handler(KeyError)
    async def missing(request, exc):
        return JSONResponse({'detail': '没有找到这个工程或记录。'}, status_code=404)

    @app.exception_handler(JobError)
    async def conflict(request, exc):
        return JSONResponse({'detail': str(exc)}, status_code=409)

    def environment():
        path = root / 'docs' / 'ros-environment.json'
        evidence = json.loads(path.read_text(encoding='utf-8-sig')) if path.exists() else {}
        return {'ros_distro': 'humble', 'os': 'Ubuntu 22.04 / WSL2', 'mode': '本机仿真与模拟设备',
                'domain_id': 78, 'hardware_connected': False, 'probe': evidence}

    @app.get('/api/health')
    def health():
        from worker.firmware import probe_firmware_toolchain
        return {'status': 'ok', 'environment': environment(), 'provider': settings.public(), 'firmware_toolchain': probe_firmware_toolchain()}

    @app.get('/api/catalog')
    def catalog():
        from worker.contract import project_contract
        return {'tasks': TASKS, 'boards': BOARDS, 'default_workflow': default_workflow(), 'pipeline_version': 3,
                'supported_pipeline_versions':[3,5],
                'motion_v5':{'task_type':'joint_sequence','model_family':'sophicore','requires_explicit_reviewed_motion_plan':True,
                    'scope':'本机固定底座、零重力，多关节顺序及完整往返；不连接实物'},
                'actuators': [{'id': 'virtual_joint', 'label': '虚拟关节（没有电机接线）'}, {'id': 'virtual_switch', 'label': '虚拟开关（没有输出接线）'}],
                'sensors': [{'id': 'simulated_encoder', 'label': '模拟位置反馈'}, {'id': 'simulated_scalar', 'label': '模拟数值传感器'}],
                'transports': [{'id': 'serial_jsonl', 'label': '串口 JSONL（本轮用虚拟串口测试）'}],
                'hardware_options': [{'id': 'simulated', 'label': '模拟设备（无实物接线）'}], 'environment': environment(), **project_contract()}

    @app.post('/api/workflow/validate')
    def workflow_validate(body: dict):
        try:
            return {'workflow': validate_workflow(body.get('workflow', body))}
        except ValueError as error:
            raise HTTPException(422, str(error))

    @app.get('/api/motion-v5/recipe')
    def get_motion_recipe(structure_id: str, side: str = 'right', cycles: int = 3):
        from .motion_v5 import motion_recipe
        try:
            return motion_recipe(root, structure_id, side, cycles)
        except (ValueError, KeyError) as error:
            raise HTTPException(422, str(error))

    @app.get('/api/settings')
    def get_settings():
        return settings.public()

    @app.put('/api/settings')
    def update_settings(body: SettingsInput):
        return settings.update(body)

    @app.get('/api/knowledge')
    def knowledge(q: str = '', task_type: str = '', board: str | None = None, ros_distro: str = 'any'):
        from .retrieval import browse_documents, retrieve
        # This endpoint browses the library. Generation calls retrieve directly
        # with an approved board/version and retains its strict defaults.
        items = retrieve(q, task_type, limit=20, board=board or 'any', ros_distro=ros_distro or 'any', root=root, robot_model='any') if q.strip() else browse_documents(root=root, task_type=task_type, board=board, ros_distro=ros_distro)
        return {'items': items, 'mode': 'fts5_bm25' if q.strip() else 'document_catalog'}

    @app.get('/api/knowledge/stats')
    def knowledge_stats():
        from .retrieval import stats
        return stats(root)

    @app.post('/api/knowledge/evaluate')
    def knowledge_evaluate():
        from .retrieval import evaluate
        return evaluate(root)

    @app.post('/api/knowledge/documents')
    def knowledge_upload(body: DocumentInput):
        from .retrieval import ingest_document
        try:
            content = base64.b64decode(body.content_base64, validate=True)
            if len(content) > 10_000_000:
                raise ValueError('资料超过 10 MB，请拆分后上传。')
            return ingest_document(root, body.filename, content, body.model_dump(exclude={'filename', 'content_base64'}))
        except (ValueError, binascii.Error) as error:
            raise HTTPException(422, str(error))

    @app.delete('/api/knowledge/documents/{document_id}')
    def knowledge_delete(document_id: str):
        from .retrieval import delete_document
        try:
            return delete_document(root, document_id)
        except ValueError as error:
            raise HTTPException(422, str(error))

    @app.get('/api/structures')
    def structures():
        from .intake_details import structure_for_mapping
        return {'items': [structure_for_mapping(root, item) for item in list_structures(root)]}

    @app.post('/api/structures')
    def structure_upload(body: StructureInput):
        try:
            from .intake_details import structure_for_mapping
            return structure_for_mapping(root, ingest_structure(root, body.filename, body.content))
        except ValueError as error:
            raise HTTPException(422, str(error))

    @app.get('/api/structures/sophicore-reference/mesh')
    def structure_mesh():
        path = root / 'knowledge' / 'sophicore-model.json'
        if not path.is_file() or path.is_symlink():
            raise HTTPException(404, '原站参考网格尚未下载，请先使用内置模型或导入配置。')
        return FileResponse(path, media_type='application/json')

    @app.get('/api/structures/{identifier}')
    def structure_detail(identifier: str):
        try:
            from .intake_details import structure_for_mapping
            return structure_for_mapping(root, get_structure(root, identifier))
        except ValueError as error:
            raise HTTPException(404, str(error))

    @app.get('/api/structures/{identifier}/mesh')
    def configured_structure_mesh(identifier: str):
        from worker.robot_model import sophicore_mesh_data
        try:
            model = get_structure(root, identifier, include_source=True)
            if model.get('format') != 'sophicore-kinematic' or not model.get('source_content'):
                raise ValueError('这个模型没有可读取的 Sophicore 配置网格。')
            return JSONResponse(sophicore_mesh_data(json.loads(model['source_content']), root / 'knowledge' / 'sophicore-model.json'))
        except (ValueError, OSError) as error:
            raise HTTPException(422, str(error))

    def project_value(body):
        if isinstance(body, GuidedDraftInput):
            from .intake import materialize
            try:
                return materialize(root, body)
            except ValueError as error:
                raise HTTPException(422, str(error))
        value = body.model_dump()
        if 'actuator' not in body.hardware.model_fields_set:
            value['hardware']['actuator'] = 'virtual_joint' if body.task_type == 'joint_position' else 'virtual_switch'
        if 'sensor' not in body.hardware.model_fields_set:
            value['hardware']['sensor'] = 'simulated_encoder' if body.task_type == 'joint_position' else 'simulated_scalar'
        expected = ('virtual_joint', 'simulated_encoder') if body.task_type == 'joint_position' else ('virtual_switch', 'simulated_scalar')
        if (value['hardware']['actuator'], value['hardware']['sensor']) != expected:
            raise HTTPException(422, '当前设备组合与任务不匹配，请使用对应的虚拟执行器和反馈。')
        try:
            value['workflow'] = validate_workflow(value.get('workflow'))
            from .manifest import build_manifest
            value = attach_structure(root, value)
            value['manifest'] = build_manifest(value)
            return value
        except ValueError as error:
            raise HTTPException(422, str(error))

    def project_response(value):
        from worker.contract import project_contract
        if value.get('pipeline_version') == 5:
            from .motion_v5 import assess_motion
            from worker.motion_spec_v5 import motion_contract
            readiness = assess_motion(root, value)[0]
            contract = motion_contract(value) if readiness['can_plan'] and value.get('manifest') else {'communication':None,'simulation':None}
            return {**value, **contract, 'intake_readiness':readiness}
        from .intake import has_intake, evaluate_intake
        if has_intake(value):
            readiness = evaluate_intake(root, value)
            if not readiness['can_plan'] or value.get('manifest') is None:
                return {**value, 'communication': None, 'simulation': None, 'intake_readiness': readiness}
            return {**value, **project_contract(value), 'intake_readiness': readiness}
        return {**value, **project_contract(value if value.get('pipeline_version', 2) >= 3 else None)}

    def parse_body(body):
        try:
            return parse_project_input(body)
        except ValueError as error:
            raise HTTPException(422, str(error))

    @app.post('/api/prd/preview')
    def preview_prd(body: dict):
        from .intake import evaluate_intake
        parsed = parse_body(body)
        if not isinstance(parsed, GuidedDraftInput):
            raise HTTPException(422, '引导预览需要 prd.intake；旧工程可继续使用原保存方式。')
        return evaluate_intake(root, parsed)

    @app.post('/api/prd/recommendations')
    def recommend_prd(body: dict):
        from .recommendations import recommend
        parsed = parse_body(body)
        if not isinstance(parsed, GuidedDraftInput):
            raise HTTPException(422, '请先使用详细需求表单，再根据原话推荐填写。')
        try:
            return recommend(root, parsed)
        except ValueError as error:
            raise HTTPException(422, str(error))

    @app.post('/api/prd/assist')
    async def assist_prd(body: dict, request: Request):
        from .intake_assistant import assist
        from .providers import ProviderError, ProviderCancelled
        parsed = parse_body(body)
        if not isinstance(parsed, GuidedDraftInput):
            raise HTTPException(422, '请先使用详细需求表单，再根据原话智能填写。')
        cancel = threading.Event()
        work = asyncio.create_task(asyncio.to_thread(assist, root, parsed, settings.private(), cancel))
        try:
            while not work.done():
                await asyncio.wait({work}, timeout=0.15)
                if await request.is_disconnected():
                    cancel.set()
            return await work
        except ProviderCancelled as error:
            return JSONResponse({'detail': str(error), 'provenance': error.provenance}, status_code=499)
        except ProviderError as error:
            return JSONResponse({'detail': str(error), 'provenance': error.provenance}, status_code=502)
        except ValueError as error:
            raise HTTPException(422, str(error))
        finally:
            if not work.done():
                cancel.set()

    @app.get('/api/projects')
    def projects():
        return {'items': [project_response(value) for value in store.list('project')]}

    @app.post('/api/projects')
    def create_project(body: dict):
        value = project_value(parse_body(body))
        value.update(id=uid(), spec_revision=1, status='draft', plan=None, approval=None,
                     latest_run_id=None, error=None, created_at=now(), updated_at=now())
        store.put('project', value)
        store.record_project_history(value, 'created')
        return project_response(value)

    @app.get('/api/projects/{pid}')
    def get_project(pid: str):
        return project_response(store.get('project', pid))

    @app.put('/api/projects/{pid}')
    def update_project(pid: str, body: dict):
        with jobs.lock:
            project = store.get('project', pid)
            if project['status'] in ACTIVE:
                raise JobError('请先等待或取消正在执行的任务，再修改需求。')
            parsed = parse_body(body)
            old_intake = (project.get('prd') or {}).get('intake') or {}
            new_version = parsed.prd.intake.schema_version if isinstance(parsed, GuidedDraftInput) else None
            if old_intake.get('schema_version') == 2 and new_version != 2:
                raise JobError('详细需求不能降级为旧版；请保留八组内容，或明确清空相应补充后重新核对。')
            validated = project_value(parsed)
            store.record_project_history(project, 'before_edit')
            project.update(validated)
            project.update(spec_revision=project['spec_revision'] + 1, status='draft', plan=None, latest_run_id=None,
                           approval=None, error=None, updated_at=now())
            project.pop('plan_failure_provenance', None)
            store.put('project', project)
            store.record_project_history(project, 'saved')
            return project_response(project)

    @app.post('/api/projects/{pid}/plan')
    def plan(pid: str):
        return project_response(jobs.plan(pid))

    @app.post('/api/projects/{pid}/cancel')
    def cancel_plan(pid: str):
        project = store.get('project', pid)
        event = jobs.cancels.get('plan:' + pid)
        if event:
            event.set()
        elif project.get('latest_run_id'):
            jobs.cancel(project['latest_run_id'])
        return project_response(store.get('project', pid))

    @app.post('/api/projects/{pid}/approve')
    def approve(pid: str, body: ApprovalInput):
        return project_response(jobs.approve(pid, body.spec_revision, body.plan_id))

    @app.post('/api/projects/{pid}/run')
    def run(pid: str):
        return jobs.start(pid)

    @app.get('/api/projects/{pid}/runs')
    def list_runs(pid: str):
        store.get('project', pid)
        return {'items': [r for r in store.list('run') if r['project_id'] == pid]}

    @app.get('/api/runs/{rid}')
    def get_run(rid: str):
        return store.get('run', rid)

    @app.post('/api/runs/{rid}/cancel')
    def cancel(rid: str):
        return jobs.cancel(rid)

    @app.post('/api/runs/{rid}/repair')
    def repair(rid: str):
        previous = store.get('run', rid)
        if previous['status'] not in {'failed', 'interrupted', 'cancelled'}:
            raise JobError('这个版本没有需要重试的失败。')
        return jobs.start(previous['project_id'], previous=rid)

    def permitted_file(rid, name):
        store.get('run', rid)
        base = (root / 'runs' / rid).resolve()
        target = (base / name).resolve()
        if not target.is_relative_to(base) or not target.is_file():
            raise HTTPException(404, '没有这个工程文件。')
        if target.stat().st_size > 2_000_000:
            raise HTTPException(413, '文件较大，请下载工程查看。')
        return target

    @app.get('/api/runs/{rid}/file')
    def get_file(rid: str, path: str):
        target = permitted_file(rid, path)
        try:
            content = target.read_text(encoding='utf-8-sig')
        except UnicodeError:
            raise HTTPException(415, '这个文件不能按文本预览。')
        return {'path': path, 'content': content}

    @app.get('/api/runs/{rid}/export')
    def export(rid: str):
        run = store.get('run', rid)
        if run['status'] in ACTIVE:
            raise JobError('请等待本轮结束后导出完整结果。')
        base = root / 'runs' / rid
        if not base.exists():
            raise HTTPException(404, '工程尚未生成。')
        if run.get('integrity'):
            from .integrity import verify_run_integrity, IntegrityError
            try:
                verify_run_integrity(root, run, check_templates=False)
            except IntegrityError as error:
                raise HTTPException(409, str(error))
        jobs.archive_artifacts(rid)
        run = store.get('run', rid)
        target = io.BytesIO()
        import hashlib
        manifest_files = []
        with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED, strict_timestamps=False) as archive:
            for item in run['artifacts']:
                if item['path'] in {'run-record.json', 'bundle-manifest.json'}:
                    continue
                file = (base / item['path']).resolve()
                if file.is_file() and file.is_relative_to(base.resolve()):
                    data = file.read_bytes()
                    archive.writestr(item['path'], data)
                    manifest_files.append({'path': item['path'], 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
            record = json.dumps(run, ensure_ascii=False, indent=2).encode('utf-8')
            archive.writestr('run-record.json', record)
            manifest_files.append({'path': 'run-record.json', 'size': len(record), 'sha256': hashlib.sha256(record).hexdigest()})
            archive.writestr('bundle-manifest.json', json.dumps({'schema_version': 1, 'run_id': rid,
                'created_at': now(), 'files': manifest_files, 'execution_seal': run.get('integrity'),
                'notice': '文件摘要用于检查内容是否一致；导入只创建待核对草稿，不授予执行权限。'}, ensure_ascii=False, indent=2))
        return Response(target.getvalue(), media_type='application/zip',
                        headers={'Content-Disposition': f'attachment; filename="ae-{rid[:8]}.zip"'})

    @app.post('/api/runs/{rid}/deploy')
    def deploy(rid: str, body: DeployInput):
        return jobs.deploy(rid, expected_fingerprint=body.fingerprint)

    from .lifecycle import build_router as lifecycle_router
    app.include_router(lifecycle_router(root, store, jobs, project_value, project_response))
    from .experiences import build_router as experience_router
    app.include_router(experience_router(root, store))

    client = root / 'web' / 'dist' / 'client'
    if not client.exists():
        client = root / 'web' / 'dist'
    if (client / 'index.html').exists():
        app.mount('/', StaticFiles(directory=client, html=True), name='web')
    else:
        @app.get('/')
        def pending():
            return {'message': 'API 已启动，前端请运行 npm run dev，或先构建 web。'}
    return app


app = create_app()

if __name__ == '__main__':
    import uvicorn
    uvicorn.run('server.app:app', host='127.0.0.1', port=8877, reload=False)
