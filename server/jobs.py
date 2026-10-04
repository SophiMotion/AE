"""One local execution queue. AI suggests source; an independent ROS worker judges it."""
import json
import os
import queue
import shutil
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from .store import now, uid, specification, spec_hash, ACTIVE


class JobError(ValueError):
    pass


def to_wsl(path):
    path = Path(path).resolve()
    if os.name == 'nt':
        return '/mnt/' + path.drive[0].lower() + path.as_posix()[2:]
    return str(path)


def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')


def failure_context(directory, result):
    """Send bounded real diagnostics back to the model, not just 'see build.log'."""
    logs = []
    remaining = 16000
    for path in sorted(directory.glob('*.log'), key=lambda p: (p.name != 'build.log', p.name)):
        if path.is_symlink() or not path.resolve().is_relative_to(directory.resolve()):
            continue
        with path.open('rb') as handle:
            handle.seek(max(0, path.stat().st_size - min(remaining, 5000)))
            tail = handle.read(min(remaining, 5000)).decode('utf-8', errors='replace')
        logs.append({'file': path.name, 'tail': tail})
        remaining -= len(tail)
        if remaining <= 0:
            break
    # Raw series are not useful for repair; failed checks and metrics are.
    detail = {k: v for k, v in (result or {}).items() if k != 'series'} if isinstance(result, dict) else result
    return json.dumps({'result': detail, 'actual_logs': logs}, ensure_ascii=False)[:24000]


def retrieval_options(project, root):
    from worker.contract import project_contract
    model = project.get('execution_model') or {}
    if project.get('pipeline_version') == 5:
        from worker.motion_spec_v5 import motion_contract
        contract = motion_contract(project)
    else:
        contract = project_contract(project if project.get('pipeline_version', 2) >= 3 else None)
    dependencies = (project.get('manifest') or {}).get('dependencies') or {}
    return {'board': project['hardware'].get('board'), 'ros_distro': project['hardware'].get('ros_distro', 'humble'),
            'root': root, 'robot_model': 'sophicore_506' if (project.get('structure') or {}).get('format') == 'sophicore-kinematic' else model.get('model_id'),
            'source_model_sha256': model.get('source_sha256'),
            'protocol_sha256': contract['communication'].get('identity', {}).get('protocol_sha256'),
            'software_versions': {key: dependencies[key] for key in ('esp32_core', 'arduinojson') if key in dependencies}}


def retrieval_query(project):
    model = project.get('execution_model') or {}
    return project['request'] + ('\n' + str(model.get('model_id')) + ' ' + str(model.get('selected_joint')) if model else '')


class Jobs:
    def __init__(self, root, store, config_getter):
        self.root, self.store, self.config_getter = root, store, config_getter
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='ae-worker')
        self.cancels = {}
        self.lock = threading.RLock()

    def event(self, rid, stage, message, level='info'):
        def add(run):
            run['events'].append({'time': now(), 'stage': stage, 'message': str(message)[:16000], 'level': level})
            run['events'] = run['events'][-2000:]
        self.store.update('run', rid, add)

    def status(self, pid, rid, status):
        self.store.update('run', rid, lambda r: r.update(status=status))
        self.store.update('project', pid, lambda p: p.update(status=status))

    def _check_intake(self, project):
        from .intake import assert_intake_ready
        try:
            assert_intake_ready(self.root, project)
        except ValueError as error:
            raise JobError(str(error)) from error

    def _check_v2_coverage(self, project):
        if project.get('pipeline_version') == 5:
            from .motion_v5 import motion_coverage
            expected=motion_coverage(specification(project))
            if (project.get('plan') or {}).get('requirement_coverage') != expected:
                raise JobError('多关节程序或原始需求已变化，请重新拆分和核对。')
            return
        if ((project.get('prd') or {}).get('intake') or {}).get('schema_version') != 2:
            return
        from .requirements import build_coverage
        try:
            coverage = build_coverage(specification(project), (project.get('plan') or {}).get('requirement_items'))
        except ValueError as error:
            raise JobError('详细需求覆盖记录不完整，请重新拆分并核对：' + str(error)) from error
        if coverage['blocking_issues']:
            raise JobError('详细需求还有未覆盖或未支持的要求，不能批准或执行：' + '；'.join(coverage['blocking_issues'])[:2000])

    def plan(self, pid):
        with self.lock:
            project = self.store.get('project', pid)
            self._check_intake(project)
            if project['status'] in ACTIVE:
                raise JobError('这个工程还有任务正在执行。')
            if project.get('hardware', {}).get('board') not in ('esp32', 'esp32s3'):
                raise JobError('这个旧工程尚未选择编译板型，请先选择 ESP32 或 ESP32-S3 并保存，再拆分需求。')
            if project.get('pipeline_version', 2) < 3:
                raise JobError('旧工程请先重新保存需求，补上关节与流程，再拆分和核对。')
            from .manifest import build_manifest
            if hasattr(self.store, 'record_project_history'):
                self.store.record_project_history(project, 'before_plan')
            project['manifest'] = build_manifest(project)
            project.update(status='planning', plan=None, approval=None, plan_failure_provenance=None, error=None, updated_at=now())
            self.store.put('project', project)
            cancel = threading.Event()
            self.cancels['plan:' + pid] = cancel
            self.pool.submit(self._plan, project, self.config_getter(), cancel)
            return project

    def _plan(self, project, config, cancel):
        from .providers import generate_plan
        from .retrieval import retrieve
        import hashlib
        pid = project['id']
        path = self.root / 'runs' / ('plan-' + uid())
        try:
            path.mkdir(parents=True)
            context = retrieve(retrieval_query(project), project['task_type'], **retrieval_options(project, self.root))
            planned_spec = specification(project)
            planned_hash = hashlib.sha256(json.dumps(planned_spec, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
            if project.get('pipeline_version') == 5:
                from .motion_v5 import deterministic_plan
                plan = deterministic_plan(planned_spec, context)
            else:
                plan = generate_plan(planned_spec, context, config, path, cancel, lambda msg: None)
            if cancel.is_set():
                raise JobError('拆分已取消')
            for field in ('ros_tasks', 'esp32_tasks', 'communication', 'checks', 'missing_information', 'citations', 'blocking_issues'):
                if not isinstance(plan.get(field), list):
                    raise JobError('模型返回的拆分格式不完整：' + field)
            from .requirements import build_coverage
            if project.get('pipeline_version') != 5:
                plan['requirement_coverage'] = build_coverage(planned_spec, plan.get('requirement_items'))
            plan['blocking_issues'] = list(dict.fromkeys([*plan['blocking_issues'], *plan['requirement_coverage']['blocking_issues']]))
            plan['scope'] = '按所选板型真实编译固件，ROS 与共享固件核心通过虚拟串口测试。未烧录或运行实际 ESP32。'
            plan['plan_id'] = uid()
            plan['spec_hash'] = planned_hash
            plan['sources'] = context
            write_json(path / 'plan.json', plan)
            ready = self.store.update('project', pid, lambda p: p.update(plan=plan, status='awaiting_approval', plan_failure_provenance=None, error=None))
            if hasattr(self.store, 'record_project_history'):
                self.store.record_project_history(ready, 'plan_ready')
        except Exception as exc:
            if getattr(exc, 'provenance', None) and path.exists():
                write_json(path / 'failure-provenance.json', exc.provenance)
            failed = self.store.update('project', pid, lambda p: p.update(status='cancelled' if cancel.is_set() else 'failed', error=str(exc)[:4000], plan_failure_provenance=getattr(exc, 'provenance', None)))
            if hasattr(self.store, 'record_project_history'):
                self.store.record_project_history(failed, 'plan_cancelled' if cancel.is_set() else 'plan_failed')
        finally:
            self.cancels.pop('plan:' + pid, None)

    def approve(self, pid, revision, plan_id):
        with self.lock:
            project = self.store.get('project', pid)
            self._check_intake(project)
            if project['status'] != 'awaiting_approval' or not project.get('plan'):
                raise JobError('请先拆分需求，再核对结果。')
            if project['spec_revision'] != revision:
                raise JobError('参数已经变化，请重新核对最新需求。')
            if not project['plan'].get('plan_id') or project['plan']['plan_id'] != plan_id:
                raise JobError('拆分结果已经变化，请刷新并核对当前这一版；旧版拆分请先重新生成。')
            self._check_v2_coverage(project)
            if project['plan'].get('blocking_issues'):
                raise JobError('拆分还有未解决的问题，请先修改需求：' + '；'.join(project['plan']['blocking_issues'])[:2000])
            current_hash = spec_hash(project)
            if project.get('pipeline_version', 2) >= 3 and project['plan'].get('spec_hash') != current_hash:
                raise JobError('工程或通信约定已经更新，或旧计划没有规格摘要，请重新拆分需求后再核对。')
            project.update(status='approved', approval={'spec_revision': revision, 'plan_id': plan_id, 'spec_hash': current_hash, 'approved_at': now(), 'by': '本机用户'}, updated_at=now())
            approved = self.store.put('project', project)
            if hasattr(self.store, 'record_project_history'):
                self.store.record_project_history(approved, 'approved')
            return approved

    def start(self, pid, previous=None):
        with self.lock:
            project = self.store.get('project', pid)
            self._check_intake(project)
            if project['status'] in ACTIVE:
                raise JobError('这个工程已有运行任务。')
            if project.get('hardware', {}).get('board') not in ('esp32', 'esp32s3'):
                raise JobError('本轮需要明确编译板型，请选择 ESP32 或 ESP32-S3，保存后重新拆分和核对。')
            if not project.get('approval') or project['approval']['spec_hash'] != spec_hash(project):
                raise JobError('需求需要先经人工核对；参数改变后要重新确认。')
            self._check_v2_coverage(project)
            if project.get('pipeline_version', 2) < 3:
                raise JobError('旧工程请先重新保存，核对升级后的结构和流程再运行。')
            if previous:
                baseline = self.store.get('run', previous)
                if baseline['project_id'] != pid or baseline['spec_snapshot'] != specification(project):
                    raise JobError('需求与该失败版本不同，不能沿用旧版报错修复；请从已核对的新需求重新生成。')
            rid = uid()
            run = {'id': rid, 'project_id': pid, 'status': 'queued', 'attempt': 0,
                   'created_at': now(), 'updated_at': now(), 'spec_snapshot': specification(project),
                   'events': [], 'result': None, 'artifacts': [], 'error': None, 'code_versions': [],
                   'provenance': [], 'deployment': None, 'approval': project['approval']}
            run['plan_snapshot'] = project['plan']
            self.store.put('run', run)
            self.store.update('project', pid, lambda p: p.update(status='queued', latest_run_id=rid))
            cancel = threading.Event()
            self.cancels[rid] = cancel
            self.pool.submit(self._run, project, run, self.config_getter(), cancel, previous)
            return run

    def _run(self, project, run, config, cancel, previous):
        if project.get('pipeline_version') == 5:
            return self._run_motion(project, run, cancel, previous)
        from .providers import generate_code, GenerationRejected
        from .retrieval import retrieve
        from .integrity import protected_snapshot, seal_run
        pid, rid = project['id'], run['id']
        directory = self.root / 'runs' / rid
        spec = run['spec_snapshot']
        code, firmware_code, failure = None, None, None
        baseline_metadata = {}
        try:
            directory.mkdir(parents=True)
            write_json(directory / 'spec.json', spec)
            write_json(directory / 'approval.json', run['approval'])
            if spec.get('pipeline_version', 2) >= 3:
                write_json(directory / 'execution-model.json', spec.get('execution_model'))
                write_json(directory / 'workflow.json', spec['workflow'])
                write_json(directory / 'project-manifest.json', spec.get('manifest'))
            write_json(directory / 'plan.json', project['plan'])
            write_json(directory / 'requirements.json', {'prd': spec.get('prd'), 'hardware': spec['hardware'], 'parameters': spec['parameters'], 'structure': spec.get('structure')})
            model = spec.get('structure') or {}
            if model.get('id', '').startswith('structure-'):
                from .structures import get_structure
                original = get_structure(self.root, model['id'], include_source=True)
                if original['content_sha256'] != model.get('content_sha256'):
                    raise JobError('结构文件已变化，需要重新保存并核对。')
                (directory / ('structure-source' + Path(original.get('filename', '.txt')).suffix)).write_text(original['source_content'], encoding='utf-8')
            context = project['plan'].get('sources') or retrieve(retrieval_query(project), project['task_type'], **retrieval_options(project, self.root))
            write_json(directory / 'retrieval-sources.json', context)
            protected_sources = protected_snapshot(self.root)
            if spec.get('pipeline_version', 2) >= 3:
                write_json(directory / 'protected-source-snapshot.json', protected_sources)
            if previous:
                old = self.store.get('run', previous)
                if old['project_id'] != pid or old['spec_snapshot'] != spec:
                    raise JobError('修复基线的规格已不同，请重新生成。')
                versions = old.get('code_versions', [])
                if versions:
                    code = versions[-1]['code']
                    firmware_code = versions[-1].get('firmware_code')
                    baseline_metadata = {'baseline_run_id': previous, 'baseline_attempt': versions[-1].get('attempt'),
                                         'baseline_code': code, 'baseline_firmware_code': firmware_code}
                old_dir = self.root / 'runs' / previous / ('attempt-' + str(old.get('attempt', 1)))
                failure = failure_context(old_dir, old.get('result') or old.get('error'))
            for attempt in range(1, 4):
                if cancel.is_set():
                    raise JobError('已取消运行')
                out = directory / ('attempt-' + str(attempt))
                out.mkdir()
                self.store.update('run', rid, lambda r: r.update(attempt=attempt))
                stage = 'repairing' if code or failure else 'generating'
                self.status(pid, rid, stage)
                self.event(rid, stage, '按已确认需求生成任务程序。' if stage == 'generating' else '把上一轮真实报错交给 AI 修改；验收标准保持不变。')
                if failure:
                    repair_context = retrieve(retrieval_query(project) + '\n' + failure[:2500], project['task_type'], **retrieval_options(project, self.root))
                    by_id = {x.get('id', x.get('url')): x for x in [*context, *repair_context]}
                    context = list(by_id.values())[:8]
                write_json(out / 'retrieval-sources.json', context)
                try:
                    generated = generate_code(spec, project['plan'], context, config, out, cancel,
                                              lambda msg: self.event(rid, stage, msg), previous_code=code, failure=failure, previous_firmware_code=firmware_code)
                except GenerationRejected as exc:
                    if cancel.is_set():
                        raise JobError('已取消运行') from exc
                    candidate = exc.candidate
                    rejected = {'attempt': attempt, 'code': candidate.get('code', ''),
                                'firmware_code': candidate.get('firmware_code', ''),
                                'explanation': candidate.get('explanation', ''), 'status': 'rejected',
                                'diagnostic': str(exc), 'failure_scope': 'generation_validation',
                                **(baseline_metadata if attempt == 1 else {})}
                    write_json(out / 'rejected-candidate.json', rejected)
                    result = {'passed': False, 'failure_scope': 'generation_validation', 'ros_verified': False,
                              'checks': [{'name': 'generated_source_validation', 'passed': False, 'detail': str(exc)}],
                              'error': str(exc), 'candidate_executed': False}
                    write_json(out / 'result.json', result)
                    self.store.update('run', rid, lambda r: (r['code_versions'].append(rejected),
                        r['provenance'].append(exc.provenance), r.update(result=result)) and None)
                    code = candidate.get('code', code)
                    firmware_code = candidate.get('firmware_code', firmware_code)
                    failure = json.dumps({'failure_scope': 'generation_validation', 'diagnostic': str(exc),
                                          'candidate_executed': False, 'raw_response': exc.provenance.get('response', '')[:12000]}, ensure_ascii=False)
                    self.event(rid, 'repairing' if attempt < 3 else 'failed',
                               '生成的候选未通过检查，未执行：' + str(exc) + ('；正在让 AI 修正。' if attempt < 3 else '；已达到三轮上限。'), 'error')
                    if attempt < 3:
                        continue
                    self.status(pid, rid, 'failed')
                    return
                code = generated['code']
                firmware_code = generated.get('firmware_code')
                if spec.get('pipeline_version', 2) >= 3:
                    from worker.device_logic import validate_device_logic
                    firmware_code = validate_device_logic(firmware_code)
                    (out / 'device_logic.cpp').write_text(firmware_code, encoding='utf-8')
                (out / 'algorithm.py').write_text(code, encoding='utf-8')
                self.store.update('run', rid, lambda r: (r['code_versions'].append({'attempt': attempt, 'code': code, 'firmware_code': firmware_code, 'status': 'accepted', 'explanation': generated.get('explanation', ''), **(baseline_metadata if attempt == 1 else {})}), r['provenance'].append(generated.get('provenance', {}))) and None)
                if spec.get('pipeline_version', 2) >= 3 and protected_snapshot(self.root) != protected_sources:
                    raise JobError('生成期间执行器模板变化，请重新运行；本次候选未执行。')
                result = self.execute(pid, rid, directory / 'spec.json', out / 'algorithm.py', out, cancel)
                self.store.update('run', rid, lambda r: r.update(result=result))
                if result.get('passed'):
                    if spec.get('pipeline_version', 2) >= 3:
                        sealed = seal_run(self.root, self.store.get('run', rid), protected_sources)
                        self.store.update('run', rid, lambda r: r.update(integrity=sealed))
                    self.status(pid, rid, 'passed')
                    self.event(rid, 'passed', '本轮软件检查通过，可查看程序和测试结果。实物尚未验证。')
                    return
                if result.get('failure_scope') in ('environment', 'firmware', 'communication'):
                    self.status(pid, rid, 'failed')
                    self.event(rid, 'failed', '问题来自编译工具、受保护固件框架或通信环境，已保留真实诊断；不会反复让 AI 修改无关的 ROS 任务函数。请查看失败项后重试。', 'error')
                    return
                failure = failure_context(out, result)
                self.event(rid, 'failed', '检查未通过，已保存日志。' + ('将进入下一轮修改。' if attempt < 3 else '已达到三轮上限。'), 'error')
            self.status(pid, rid, 'failed')
        except Exception as exc:
            if getattr(exc, 'provenance', None):
                self.store.update('run', rid, lambda r: r['provenance'].append(exc.provenance))
            state = 'cancelled' if cancel.is_set() else 'failed'
            self.status(pid, rid, state)
            self.store.update('run', rid, lambda r: r.update(error=str(exc)[:4000]))
            self.event(rid, state, str(exc), 'error')
        finally:
            try:
                self.archive_artifacts(rid)
            except OSError as exc:
                self.status(pid, rid, 'failed')
                self.store.update('run', rid, lambda r: r.update(error='归档失败：' + str(exc)))
            self.cancels.pop(rid, None)

    def _run_motion(self, project, run, cancel, previous):
        """V5 emits reviewed data plus fixed templates; it never enters scalar AI repair."""
        from .motion_v5 import generated_sources
        from .integrity import protected_snapshot, seal_run
        pid,rid=project['id'],run['id']; spec=run['spec_snapshot']
        directory=self.root/'runs'/rid
        try:
            directory.mkdir(parents=True)
            if cancel.is_set():
                raise JobError('已取消运行')
            for filename,value in [('spec',spec),('approval',run['approval']),('plan',project['plan']),
                    ('execution-model',spec['execution_model']),('motion-program',spec['motion_program']),
                    ('workflow',spec['workflow']),('project-manifest',spec['manifest']),
                    ('requirements',{'request':spec['request'],'prd':spec['prd']}),
                    ('retrieval-sources',project['plan'].get('sources',[]))]:
                write_json(directory/(filename+'.json'),value)
            model=spec.get('structure') or {}
            if model.get('id','').startswith('structure-'):
                from .structures import get_structure
                original=get_structure(self.root,model['id'],include_source=True)
                if original['content_sha256'] != model.get('content_sha256'):
                    raise JobError('结构来源已变化，需要重新保存并核对。')
                (directory/('structure-source'+Path(original.get('filename','.txt')).suffix)).write_text(original['source_content'],encoding='utf-8')
            protected=protected_snapshot(self.root, pipeline_version=5)
            write_json(directory/'protected-source-snapshot.json',protected)
            out=directory/'attempt-1';out.mkdir()
            self.store.update('run',rid,lambda r:r.update(attempt=1))
            self.status(pid,rid,'generating')
            self.event(rid,'generating','将已人工核对的多关节程序写入固定 ROS 与 ESP 模板；本轮没有调用 AI 生成任意代码。')
            generated=generated_sources(spec)
            (out/'algorithm.py').write_text(generated['code'],encoding='utf-8')
            (out/'device_logic.cpp').write_text(generated['firmware_code'],encoding='utf-8')
            write_json(out/'generation-provenance.json',generated['provenance'])
            version={'attempt':1,'status':'accepted',**{k:generated[k] for k in ('code','firmware_code','explanation')}}
            if previous:
                old=self.store.get('run',previous)
                baseline=(old.get('code_versions') or [{}])[-1]
                version.update(baseline_run_id=previous,baseline_attempt=baseline.get('attempt'),
                    baseline_code=baseline.get('code'),baseline_firmware_code=baseline.get('firmware_code'))
            self.store.update('run',rid,lambda r:(r['code_versions'].append(version),r['provenance'].append(generated['provenance'])) and None)
            if cancel.is_set(): raise JobError('已取消运行')
            if protected_snapshot(self.root,pipeline_version=5) != protected:
                raise JobError('执行模板发生变化，请重新运行；本次候选未执行。')
            result=self.execute(pid,rid,directory/'spec.json',out/'algorithm.py',out,cancel)
            self.store.update('run',rid,lambda r:r.update(result=result))
            if result.get('passed'):
                sealed=seal_run(self.root,self.store.get('run',rid),protected)
                self.store.update('run',rid,lambda r:r.update(integrity=sealed))
                self.status(pid,rid,'passed')
                self.event(rid,'passed','多关节软件测试通过：请查看逐阶段反馈与双端编译记录。尚未接 ESP 实物。')
            else:
                self.status(pid,rid,'failed')
                self.event(rid,'failed','本轮实际检查未通过，已保留报错。固定执行器不会自动改写已批准的动作或验收值；修改需求后需重新核对。','error')
        except Exception as exc:
            state='cancelled' if cancel.is_set() else 'failed'
            self.status(pid,rid,state)
            self.store.update('run',rid,lambda r:r.update(error=str(exc)[:4000]))
            self.event(rid,state,str(exc),'error')
        finally:
            try: self.archive_artifacts(rid)
            except OSError as exc:
                self.status(pid,rid,'failed')
                self.store.update('run',rid,lambda r:r.update(error='归档失败：'+str(exc)))
            self.cancels.pop(rid,None)

    def execute(self, pid, rid, spec, code, out, cancel, deploy=False):
        actual_spec = json.loads(spec.read_text(encoding='utf-8-sig'))
        worker = self.root / 'worker' / ('execute_motion_v5.py' if actual_spec.get('pipeline_version') == 5 else 'execute.py')
        if not worker.exists():
            raise JobError('ROS 执行器尚未安装完成。')
        args = [to_wsl(worker), '--spec', to_wsl(spec), '--code', to_wsl(code), '--output', to_wsl(out)]
        if actual_spec.get('pipeline_version', 2) >= 3:
            firmware_path = code.parent / 'device_logic.cpp'
            if not firmware_path.is_file():
                raise JobError('缺少本轮 ESP32 生成片段，不能用其他版本代替。')
            args.extend(['--firmware-code', to_wsl(firmware_path)])
        if deploy:
            args.append('--deploy')
        # Use a file launcher and WSL --exec to avoid Windows/default-shell re-quoting of $@.
        launcher = to_wsl(self.root / 'worker-launch.sh')
        cmd = ['wsl.exe', '-d', 'Ubuntu-22.04', '--exec', '/bin/bash', launcher, *args] if os.name == 'nt' else ['bash', launcher, *args]
        self.status(pid, rid, 'deploying' if deploy else 'building')
        self.event(rid, 'building', '启动隔离 ROS 执行器，真实编译和运行生成的工程。')
        write_json(out / 'lease.json', {'heartbeat': time.time(), 'owner_pid': os.getpid()})
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace', creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        lines = queue.Queue()
        def read():
            for line in proc.stdout:
                lines.put(line)
            lines.put(None)
        threading.Thread(target=read, daemon=True).start()
        started = time.monotonic()
        done = False
        cancelled_at = None
        heartbeat_at = 0
        try:
            with (out / 'worker-output.log').open('w', encoding='utf-8') as logfile:
                while not done:
                    if time.monotonic() - heartbeat_at > 1:
                        # Windows cannot rename over a file while a WSL reader holds it.
                        # The worker uses mtime as the lease heartbeat; immutable JSON identifies owner.
                        os.utime(out / 'lease.json', None)
                        heartbeat_at = time.monotonic()
                    if cancel.is_set() or time.monotonic() - started > 900:
                        (out / 'cancel.flag').touch()
                        cancelled_at = cancelled_at or time.monotonic()
                        if time.monotonic() - cancelled_at > 12:
                            proc.kill()
                            raise JobError('运行已取消' if cancel.is_set() else 'ROS 执行超时')
                    try:
                        line = lines.get(timeout=0.2)
                    except queue.Empty:
                        if proc.poll() is not None:
                            break
                        continue
                    if line is None:
                        done = True
                        continue
                    logfile.write(line)
                    logfile.flush()
                    clean = line.replace('\x00', '').strip()
                    if '\x00' in line:
                        continue  # WSL emits a UTF-16 proxy notice on the shared pipe, not a worker log.
                    try:
                        event = json.loads(clean)
                        stage = event.get('stage', 'testing')
                        if stage in ('building', 'testing', 'deploying') and not deploy:
                            self.status(pid, rid, stage)
                        self.event(rid, stage, event.get('message', clean), event.get('level', 'info'))
                    except (ValueError, AttributeError):
                        if clean:
                            self.event(rid, 'worker', clean)
            exit_code = proc.wait(timeout=10)
            if cancel.is_set():
                raise JobError('已取消运行')
            result_path = out / 'result.json'
            if not result_path.exists():
                raise JobError(f'ROS 执行器未正常启动或未返回结果（退出码 {exit_code}）。请查看 worker-output.log；这类环境错误不会交给 AI 反复改任务代码。')
            result = json.loads(result_path.read_text(encoding='utf-8-sig'))
            if not isinstance(result, dict):
                raise JobError('执行器结果格式错误。')
            checks = result.get('checks')
            evidence_valid = (isinstance(checks, list) and bool(checks)
                              and all(isinstance(item, dict) and item.get('passed') is True for item in checks)
                              and result.get('ros_verified') is True)
            actual_spec = json.loads(spec.read_text(encoding='utf-8-sig'))
            if actual_spec.get('hardware', {}).get('board') in ('esp32', 'esp32s3'):
                firmware, communication = result.get('firmware'), result.get('communication_test')
                evidence_valid = (evidence_valid and isinstance(firmware, dict) and firmware.get('passed') is True
                                  and isinstance(communication, dict) and communication.get('passed') is True)
            if actual_spec.get('pipeline_version') == 5:
                from .motion_v5 import result_evidence_valid
                evidence_valid = result_evidence_valid(actual_spec, result, out)
            elif actual_spec.get('pipeline_version', 2) >= 3:
                from worker.firmware import FQBNS
                identity = actual_spec['communication'].get('identity')
                board = actual_spec['hardware']['board']
                numeric = result.get('device_logic_test') or {}
                stages = {'ros_build', 'esp_build', 'communication', 'simulation', 'report'}
                expected_order = [x for x in actual_spec['workflow']['execution_order'] if x in stages]
                evidence_valid = (evidence_valid and bool(identity) and result.get('identity') == identity
                                  and result.get('execution_order') == expected_order
                                  and result.get('firmware', {}).get('identity') == identity
                                  and result.get('communication_test', {}).get('identity') == identity
                                  and result.get('execution_model', {}).get('model_sha256') == identity['model_sha256']
                                  and result.get('execution_model', {}).get('selected_joint') == identity['joint_name']
                                  and result.get('workflow', {}).get('hash') == actual_spec['workflow']['hash']
                                  and result.get('firmware', {}).get('board') == board
                                  and result.get('firmware', {}).get('fqbn') == FQBNS[board]
                                  and numeric.get('passed') is True and numeric.get('cases') == 28
                                  and result.get('metrics', {}).get('cleanup', {}).get('all_exited') is True)
                if actual_spec['task_type'] == 'joint_position':
                    evidence_valid = evidence_valid and result.get('physics_simulation_verified') is True
            if result.get('passed') is True and not evidence_valid:
                result['passed'] = False
                if not isinstance(checks, list):
                    result['checks'] = []
                result['checks'].append({'name': 'result_contract', 'passed': False, 'detail': '结果缺少全部通过的独立检查，或缺少本轮所需 ROS、固件编译、通信证据。'})
            result['passed'] = result.get('passed') is True and bool(evidence_valid) and exit_code == 0
            return result
        finally:
            if proc.poll() is None:
                (out / 'cancel.flag').touch()
                try:
                    proc.wait(timeout=12)
                except subprocess.TimeoutExpired:
                    proc.kill()

    def archive_artifacts(self, rid):
        directory = self.root / 'runs' / rid
        files = []
        if directory.exists():
            # Prune colcon trees before querying their WSL-only symlinks on Windows.
            excluded = {'build', 'install', 'log', '__pycache__', '.git'}
            for parent, dirs, names in os.walk(directory, followlinks=False):
                dirs[:] = [name for name in dirs if name not in excluded and not (Path(parent) / name).is_symlink()]
                for name in names:
                    path = Path(parent) / name
                    if path.suffix in {'.zip', '.pyc'} or path.is_symlink():
                        continue
                    if path.is_file():
                        files.append({'path': path.relative_to(directory).as_posix(), 'size': path.stat().st_size})
        self.store.update('run', rid, lambda r: r.update(artifacts=sorted(files, key=lambda f: f['path'])))

    def cancel(self, rid):
        run = self.store.get('run', rid)
        event = self.cancels.get(rid)
        if event is not None:
            event.set()
            self.event(rid, 'cancel', '已请求取消，正在停止本轮进程。')
        return self.store.get('run', rid)

    def deploy(self, rid, expected_fingerprint=None):
        with self.lock:
            run = self.store.get('run', rid)
            project = self.store.get('project', run['project_id'])
            self._check_intake(project)
            self._check_v2_coverage(project)
            if run['status'] != 'passed' or project['status'] in ACTIVE:
                raise JobError('只可部署已通过检查的版本，且本工程不能有其他任务。')
            if specification(project) != run['spec_snapshot']:
                raise JobError('工程需求已变化，请先重新生成和检查。')
            if run['spec_snapshot'].get('pipeline_version', 2) >= 3:
                from .integrity import verify_run_integrity, IntegrityError
                try:
                    verified = verify_run_integrity(self.root, run)
                except IntegrityError as exc:
                    raise JobError(str(exc)) from exc
                if expected_fingerprint != verified['fingerprint']:
                    raise JobError('部署确认不属于当前通过版本，请刷新后重新核对。')
            cancel = threading.Event()
            self.cancels[rid] = cancel
            self.status(project['id'], rid, 'deploying')
            self.store.update('project', project['id'], lambda p: p.update(latest_run_id=rid))
            self.store.update('run', rid, lambda r: r.update(deployment={'approved_at': now(), 'target': '本机隔离 ROS，模拟设备', 'status': 'running'}))
            self.pool.submit(self._deploy, run, cancel)
            return self.store.get('run', rid)

    def _deploy(self, run, cancel):
        rid, pid = run['id'], run['project_id']
        directory = self.root / 'runs' / rid
        out = directory / ('deployment-' + uid()[:8])
        code = directory / ('attempt-' + str(run['attempt'])) / 'algorithm.py'
        try:
            if run['spec_snapshot'].get('pipeline_version', 2) >= 3:
                from .integrity import verify_run_integrity
                verify_run_integrity(self.root, run)
            out.mkdir()
            result = self.execute(pid, rid, directory / 'spec.json', code, out, cancel, deploy=True)
            if run['spec_snapshot'].get('pipeline_version', 2) >= 3:
                verify_run_integrity(self.root, run)
            status = 'deployed' if result.get('passed') else 'failed'
            self.store.update('run', rid, lambda r: r['deployment'].update(status=status, result=result, finished_at=now()))
            self.status(pid, rid, status)
            self.event(rid, status, '本机 ROS 安装与复测通过。没有连接实物。' if status == 'deployed' else '部署复测失败，请查看记录。')
        except Exception as exc:
            status = 'cancelled' if cancel.is_set() else 'failed'
            self.status(pid, rid, status)
            def record_error(r):
                r.update(error=str(exc))
                r['deployment'].update(status=status, error=str(exc), finished_at=now())
            self.store.update('run', rid, record_error)
        finally:
            self.archive_artifacts(rid)
            self.cancels.pop(rid, None)

    def close(self):
        for event in list(self.cancels.values()):
            event.set()
        self.pool.shutdown(wait=False, cancel_futures=True)
