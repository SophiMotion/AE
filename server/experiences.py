"""Human-confirmed local run summaries for RAG, never a training claim.

Only store-owned terminal runs are accepted. Logs, prompts, user free text and
arbitrary local paths are not ingested. Failed code is never a success example.
"""
from __future__ import annotations

import ast
import hashlib
import json
import math
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from typing import Literal

from . import retrieval

TERMINAL = {'passed', 'deployed', 'failed', 'cancelled', 'interrupted'}
_TOKEN = re.compile(r'^[a-zA-Z0-9_.:+/ -]{1,120}$')
_HASH = re.compile(r'^[a-f0-9]{64}$')
_ID = re.compile(r'^[a-zA-Z0-9_-]{1,100}$')


class PublishExperience(BaseModel):
    model_config = ConfigDict(extra='forbid')
    confirm: Literal[True]
    preview_hash: str = Field(pattern=r'^[a-f0-9]{64}$')


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def _token(value, default='unknown'):
    return value if isinstance(value, str) and _TOKEN.fullmatch(value) else default


def _hash(value):
    return value if isinstance(value, str) and _HASH.fullmatch(value) else None


def _code_hash(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest() if isinstance(value, str) else None


def _ros_excerpt(code):
    """Parse and serialize a numeric excerpt without compiling or running it."""
    if not isinstance(code, str) or len(code) > 12000:
        return ''
    try:
        tree = ast.parse(code)
        functions = [node for node in tree.body if isinstance(node, ast.FunctionDef)]
        if len(functions) != 1 or functions[0].name != 'compute_command':
            return ''
        function = functions[0]
        if [arg.arg for arg in function.args.args] != ['value', 'target', 'threshold', 'max_velocity']:
            return ''
        if function.body and isinstance(function.body[0], ast.Expr) and isinstance(function.body[0].value, ast.Constant) and isinstance(function.body[0].value.value, str):
            function.body.pop(0)  # user comments/docstrings are not an experience source
        safe_types = (ast.Module, ast.FunctionDef, ast.arguments, ast.arg, ast.Import, ast.alias,
                      ast.Assign, ast.Name, ast.Load, ast.Store, ast.Return, ast.If, ast.IfExp,
                      ast.BinOp, ast.UnaryOp, ast.BoolOp, ast.Compare, ast.Call, ast.Attribute,
                      ast.Constant, ast.Add, ast.Sub, ast.Mult, ast.Div, ast.FloorDiv, ast.Mod,
                      ast.USub, ast.UAdd, ast.Not, ast.And, ast.Or, ast.Lt, ast.LtE, ast.Gt,
                      ast.GtE, ast.Eq, ast.NotEq)
        for node in ast.walk(tree):
            if not isinstance(node, safe_types):
                return ''
            if isinstance(node, ast.Constant) and (not isinstance(node.value, (int, float, bool)) or not math.isfinite(node.value) or abs(node.value) > 1e6):
                return ''
            if isinstance(node, ast.Name) and (len(node.id) > 48 or re.search(r'(?i)secret|token|password|credential|api.?key|authorization', node.id)):
                return ''
            if isinstance(node, ast.Import) and any(alias.name != 'math' or alias.asname for alias in node.names):
                return ''
            if isinstance(node, ast.Attribute) and (not isinstance(node.value, ast.Name) or node.value.id != 'math' or node.attr not in {'sin', 'cos', 'tan', 'tanh', 'sqrt', 'fabs', 'floor', 'ceil', 'copysign', 'isfinite', 'pi', 'e', 'tau'}):
                return ''
            if isinstance(node, ast.Call) and not (isinstance(node.func, ast.Name) and node.func.id in {'min', 'max', 'abs', 'float'} or isinstance(node.func, ast.Attribute)):
                return ''
        return ast.unparse(tree)[:1800]
    except (SyntaxError, ValueError, RecursionError):
        return ''


def _esp_excerpt(code):
    try:
        from worker.device_logic import validate_device_logic
        return validate_device_logic(code)[:1800]
    except (ValueError, TypeError):
        return ''


def _sealed(root, run):
    if not run.get('integrity'):
        return {'verified': False, 'mode': 'legacy_store_evidence',
                'notice': '旧运行没有产物封存校验；本页核对已有规格、批准和工具结果，不能补称已封存。'}
    # V4's integrity verifier is provided by the platform, not by RAG inputs.
    from .integrity import verify_run_integrity
    verification = verify_run_integrity(root, run, check_templates=False)
    if not isinstance(verification, dict) or not _hash(verification.get('fingerprint')):
        raise ValueError('运行产物完整性核对未通过，不能把这次运行发布为经验。')
    return {'verified': True, 'mode': 'sealed_run', 'notice': '本次封存产物已核对。'}


def _repair_baselines(root, store, run, spec, versions):
    """Link a user retry to its store-owned prior failure, without ingesting it."""
    baselines = []
    seen = set()
    for version in versions:
        rid = version.get('baseline_run_id') if isinstance(version, dict) else None
        if not rid or rid in seen:
            continue
        if not isinstance(rid, str) or not _ID.fullmatch(rid) or rid == run['id']:
            raise ValueError('修复基线编号无效，不能整理经验。')
        seen.add(rid)
        try:
            old = store.get('run', rid)
        except KeyError as error:
            raise ValueError('找不到修复所依据的旧运行，不能核对经验。') from error
        if (old.get('status') not in TERMINAL or old.get('project_id') != run.get('project_id')
                or old.get('spec_snapshot') != spec or (old.get('approval') or {}).get('spec_hash') != _digest(spec)):
            raise ValueError('修复基线与本轮工程、规格或批准不一致。')
        seal = _sealed(root, old)
        previous = (old.get('code_versions') or [{}])[-1]
        if (version.get('baseline_attempt') != previous.get('attempt')
                or _code_hash(version.get('baseline_code')) != _code_hash(previous.get('code'))
                or _code_hash(version.get('baseline_firmware_code')) != _code_hash(previous.get('firmware_code'))):
            raise ValueError('修复基线源码摘要与旧运行不一致。')
        result = old.get('result') or {}
        checks = result.get('checks') or []
        checks = checks if isinstance(checks, list) else []
        baselines.append({'run_id': rid, 'attempt': previous.get('attempt'), 'run_status': old['status'],
                          'spec_hash': _digest(spec), 'ros_sha256': _code_hash(previous.get('code')),
                          'esp32_sha256': _code_hash(previous.get('firmware_code')),
                          'failed_checks': [_token(c.get('name'), 'unnamed_check') for c in checks
                                            if isinstance(c, dict) and c.get('passed') is not True][:80],
                          'failure_scope': _token(result.get('failure_scope'), 'unclassified'),
                          'integrity': seal,
                          'notice': '只保留修复来源和失败检查名称，不收录旧失败代码或日志。'})
        if len(baselines) >= 3:
            break
    return baselines


def preview_experience(root, store, run_id):
    if not isinstance(run_id, str) or not _ID.fullmatch(run_id):
        raise ValueError('运行编号格式不正确。')
    run = store.get('run', run_id)
    if run.get('id') != run_id or run.get('status') not in TERMINAL:
        raise ValueError('只可整理已经结束的运行；执行中请稍后再试。')
    spec = run.get('spec_snapshot')
    if not isinstance(spec, dict):
        raise ValueError('这条记录缺少冻结规格，不能整理经验。')
    seal = _sealed(root, run)
    hardware, model = spec.get('hardware') or {}, spec.get('execution_model') or {}
    structure, manifest = spec.get('structure') or {}, spec.get('manifest') or {}
    result = run.get('result') or {}
    checks = result.get('checks') or []
    checks = checks if isinstance(checks, list) else []
    identity = (spec.get('communication') or {}).get('identity') or {}
    expected_sha, approval = _digest(spec), run.get('approval') or {}
    if approval.get('spec_hash') != expected_sha:
        raise ValueError('运行批准与冻结规格不一致，不能整理经验。')
    if hardware.get('physical_io') is not False:
        raise ValueError('当前经验入口仅接收明确无实物的本机运行。')
    board, ros = _token(hardware.get('board')), _token(hardware.get('ros_distro'))
    protocol_sha = _hash(identity.get('protocol_sha256'))
    model_sha = _hash(identity.get('model_sha256'))
    if not protocol_sha or not model_sha or board == 'unknown' or ros == 'unknown':
        raise ValueError('记录缺少明确板型、软件版本或模型与协议摘要，不能整理经验。')
    firmware = result.get('firmware') or {}
    comm = result.get('communication_test') or {}
    valid_checks = bool(checks) and all(isinstance(check, dict) and check.get('passed') is True for check in checks)
    identities_match = all(value.get('identity') == identity for value in (result, firmware, comm))
    paired_passed = (run['status'] in {'passed', 'deployed'} and result.get('passed') is True and valid_checks
                     and result.get('ros_verified') is True and firmware.get('passed') is True
                     and comm.get('passed') is True and identities_match)
    is_motion=spec.get('pipeline_version')==5
    if is_motion:
        from .motion_v5 import result_evidence_valid
        paired_passed=paired_passed and result_evidence_valid(spec,result)
    versions = run.get('code_versions') or []
    versions = versions if isinstance(versions, list) else []
    baselines = _repair_baselines(root, store, run, spec, versions)
    kind = ('repair' if len(versions) > 1 or baselines else 'success') if paired_passed else 'failure'
    label = {'success': '双端软件检查通过', 'repair': '修复后双端软件检查通过', 'failure': '失败或未完成的排查记录'}[kind]
    board_label = 'ESP32-S3' if board == 'esp32s3' else 'ESP32' if board == 'esp32' else board
    task = _token(spec.get('task_type'))
    joint = _token(identity.get('joint_name')) if not is_motion else ', '.join(_token(n) for n in identity.get('joint_names',[]))
    software = {key: _token((manifest.get('dependencies') or {}).get(key)) for key in ('esp32_core', 'arduinojson')}
    if any(value == 'unknown' or not retrieval._known_version(value) for value in software.values()):
        raise ValueError('缺少固定的固件依赖版本，请保留原始运行，不能用于后续生成。')
    applicability = {'task_type': task, 'board': board, 'ros_distro': ros,
                     'version': f"ROS {ros}; ESP32 core {software['esp32_core']}; ArduinoJson {software['arduinojson']}",
                     'robot_model': 'sophicore_506' if structure.get('format') == 'sophicore-kinematic' else _token(model.get('model_id'), 'any'),
                     'source_model_sha256': _hash(model.get('source_sha256')),
                     'software_versions': software}
    selected_versions = []
    for index, version in enumerate(versions[-3:]):
        final_success = paired_passed and index == len(versions[-3:]) - 1
        selected_versions.append({'attempt': version.get('attempt'),
                                  'ros_sha256': _code_hash(version.get('code')), 'esp32_sha256': _code_hash(version.get('firmware_code')),
                                  'ros_excerpt': _ros_excerpt(version.get('code')) if final_success and not is_motion else '',
                                  'esp32_excerpt': _esp_excerpt(version.get('firmware_code')) if final_success and not is_motion else '',
                                  'is_final_success': final_success,
                                  'note': ('多关节任务保存已验证程序摘要与关节顺序，不把固定框架误称为 AI 数值函数。' if is_motion else '仅最后一次通过的数值函数摘录；不是完整驱动。') if final_success else '保留版本摘要，不把失败或早期代码作为可复用程序。'})
    failed_checks = [_token(check.get('name'), 'unnamed_check') for check in checks if isinstance(check, dict) and check.get('passed') is not True][:80]
    attempt = run.get('attempt', 0)
    if type(attempt) is not int or not 0 <= attempt <= 100:
        raise ValueError('运行轮次不正确。')
    evidence = [{'label': '冻结规格', 'path': 'spec.json'}, {'label': '人工核对', 'path': 'approval.json'}]
    if attempt:
        evidence.extend([{'label': '本轮工具结果', 'path': f'attempt-{attempt}/result.json'},
                         {'label': 'ROS 任务源码', 'path': f'attempt-{attempt}/algorithm.py'},
                         {'label': 'ESP32 数值源码', 'path': f'attempt-{attempt}/device_logic.cpp'}])
    summary = (f'{board_label} / ROS {ros}，任务 {task}，对象 {joint}。{label}。'
               f'记录包含 {len(checks)} 项工具检查，{sum(check.get("passed") is True for check in checks if isinstance(check, dict))} 项通过。'
               '只验证本机编译、仿真或软件通信；没有烧录、板上通信或实际动作验收。')
    parameters = {key: value for key, value in (spec.get('parameters') or {}).items()
                  if key in {'target', 'threshold', 'tolerance', 'duration', 'max_velocity', 'max_acceleration'}
                  and isinstance(value, (float, int)) and not isinstance(value, bool) and math.isfinite(value)}
    preview = {'schema_version': 1, 'run_id': run_id, 'kind': kind,
               'title': f'{board_label} {task}：{label}', 'summary': summary,
               'applicability': applicability, 'spec_hash': expected_sha,
               'model_sha256': model_sha, 'protocol_sha256': protocol_sha,
               'joint_name': joint, 'parameters': parameters, 'run_status': run['status'], 'integrity': seal,
               'result': {'passed': paired_passed, 'total_checks': len(checks),
                          'passed_checks': sum(check.get('passed') is True for check in checks if isinstance(check, dict)),
                          'failed_checks': failed_checks, 'failure_scope': _token(result.get('failure_scope'), 'unclassified'),
                          'firmware_compiled': firmware.get('passed') is True,
                          'communication_verified': comm.get('passed') is True,
                          'physics_simulation_verified': result.get('physics_simulation_verified') is True},
               'code_versions': selected_versions, 'repair_baselines': baselines, 'evidence': evidence,
               'physical_verified': False, 'esp32_execution_verified': False, 'flashed': False,
               'publishable': True, 'retrieval_use': 'validated_example' if paired_passed else 'diagnostic_only',
               'notice': '人工核对后才收录到本机资料库。失败经验仅用于排查；收录不是训练或蒸馏模型。原运行记录不会被修改。'}
    if is_motion:
        program=spec['motion_program']
        preview['motion_program']={'program_sha256':program['program_sha256'],'joint_names':program['joint_names'],
            'waypoint_count':len(program['waypoints']),'cycles':max(row['cycle_index'] for row in program['waypoints'])}
    preview['preview_hash'] = _digest(preview)
    try:
        existing = retrieval.document_detail(root, 'experience-' + run_id)['document']
        preview['published_document_id'] = existing['id']
    except KeyError:
        preview['published_document_id'] = None
    return preview


def publish_experience(root, store, run_id, preview_hash):
    # Keep terminal status/spec stable while the preview is rechecked and indexed.
    with store.lock:
        return _publish_locked(root, store, run_id, preview_hash)


def _publish_locked(root, store, run_id, preview_hash):
    preview = preview_experience(root, store, run_id)
    if preview['preview_hash'] != preview_hash:
        raise ValueError('运行内容已经变化，请刷新预览，重新核对后再收录。')
    scope = preview['applicability']
    lines = [f"# {preview['title']}", preview['summary'],
             f"用途：{preview['retrieval_use']}。失败记录不能作为通过的代码示例。",
             f"run_id={run_id}; spec_sha256={preview['spec_hash']}",
             f"板型={scope['board']}; ROS={scope['ros_distro']}; 软件版本={scope['version']}",
             f"robot_model={scope['robot_model']}; source_model_sha256={scope['source_model_sha256']}",
             f"joint_name={preview['joint_name']}; model_sha256={preview['model_sha256']}; protocol_sha256={preview['protocol_sha256']}",
             '本轮已批准的数值参数：' + json.dumps(preview['parameters'], ensure_ascii=False, sort_keys=True),
             'physical_verified=false; esp32_execution_verified=false; flashed=false',
             preview['integrity']['notice'],
             '检查摘要：' + json.dumps(preview['result'], ensure_ascii=False, sort_keys=True)]
    if preview['repair_baselines']:
        lines.append('本次修复所依据的旧运行：' + json.dumps(preview['repair_baselines'], ensure_ascii=False, sort_keys=True))
    if preview.get('motion_program'):
        lines.append('本次多关节程序摘要：'+json.dumps(preview['motion_program'],ensure_ascii=False,sort_keys=True))
    for version in preview['code_versions']:
        lines.append(f"轮次 {version['attempt']}：ROS SHA256={version['ros_sha256']}; ESP32 SHA256={version['esp32_sha256']}")
        if version['is_final_success']:
            if version['ros_excerpt']:
                lines.extend(['最终通过的 ROS 数值函数摘录（不是驱动）：', '```python', version['ros_excerpt'], '```'])
            if version['esp32_excerpt']:
                lines.extend(['最终通过的 ESP32 数值函数摘录（不是驱动）：', '```cpp', version['esp32_excerpt'], '```'])
    lines.extend(['证据相对于本轮工程：'] + [f"- {entry['label']}: {entry['path']}" for entry in preview['evidence']])
    doc_id = 'experience-' + run_id
    document = {'id': doc_id, 'title': preview['title'], 'url': f'http://127.0.0.1:8877/api/runs/{run_id}',
                'version': scope['version'], 'ros_distro': scope['ros_distro'], 'board': scope['board'],
                'task_types': [scope['task_type']], 'tags': ['本机经验', scope['task_type'], preview['kind'], preview['joint_name']],
                'origin': 'experience', 'experience_kind': preview['kind'], 'run_id': run_id,
                'verification_status': 'reviewed_software_evidence' if preview['result']['passed'] else 'reviewed_failure_diagnostic',
                'license': '本机运行摘要；外部复用前核对项目及依赖许可',
                'robot_model': scope['robot_model'], 'source_model_sha256': scope['source_model_sha256'],
                'software_versions': scope['software_versions'], 'protocol_sha256': preview['protocol_sha256'],
                'model_sha256': preview['model_sha256'], 'spec_hash': preview['spec_hash'],
                'preview_hash': preview_hash, 'retrieval_use': preview['retrieval_use'],
                'review': {'confirmed': True, 'scope': '本机用户核对经验摘要，不是实物验收'},
                'warnings': [preview['notice'], preview['integrity']['notice']],
                'evidence': preview['evidence'], 'code_versions': preview['code_versions'],
                'repair_baselines': preview['repair_baselines']}
    return retrieval.ingest_experience(root, document, '\n\n'.join(lines))


def build_router(root: Path, store):
    router = APIRouter(prefix='/api')

    @router.get('/knowledge/documents/{document_id}')
    def get_document(document_id: str):
        try:
            return retrieval.document_detail(root, document_id)
        except KeyError:
            raise HTTPException(404, '没有这份资料。')
        except ValueError as error:
            raise HTTPException(422, str(error))

    @router.get('/runs/{rid}/experience')
    def get_experience(rid: str):
        try:
            return preview_experience(root, store, rid)
        except KeyError:
            raise HTTPException(404, '没有这条运行记录。')
        except (ValueError, ImportError) as error:
            raise HTTPException(409, str(error))

    @router.post('/runs/{rid}/experience')
    def post_experience(rid: str, body: PublishExperience):
        try:
            return publish_experience(root, store, rid, body.preview_hash)
        except KeyError:
            raise HTTPException(404, '没有这条运行记录。')
        except (ValueError, ImportError) as error:
            raise HTTPException(409, str(error))

    return router
