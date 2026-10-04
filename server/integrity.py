"""Content fingerprints bind approved files to local deployment and export.

These are transparent consistency checks, not signed tamper-proof attestations.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path


class IntegrityError(ValueError):
    pass


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def file_hash(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def protected_snapshot(root, pipeline_version=None, recorded_paths=None):
    root = Path(root).resolve()
    if recorded_paths is not None:
        paths=[]
        for name in recorded_paths:
            path=(root/name).resolve()
            if not path.is_relative_to(root) or not path.is_file() or (root/name).is_symlink():
                raise IntegrityError('受保护执行器文件缺失或路径变化：'+name)
            paths.append(path)
        return {path.relative_to(root).as_posix():file_hash(path) for path in sorted(paths)}
    paths = sorted(path for path in (root / 'worker').glob('*')
                   if path.suffix in {'.py', '.hpp', '.cpp', '.ino'} and path.is_file())
    # Freeze the complete current worker dependency set, including shared V3
    # supervisors and compiler helpers imported by V5. Historical verification
    # below still checks exactly the dependency names recorded at that time.
    launcher = root / 'worker-launch.sh'
    if launcher.is_file():
        paths.append(launcher)
    toolchain = root / '.tools' / 'arduino' / 'toolchain.json'
    if toolchain.is_file():
        paths.append(toolchain)
    return {path.relative_to(root).as_posix(): file_hash(path) for path in paths if not path.is_symlink()}


def _files(base, attempt):
    result = {}
    for parent, dirs, names in os.walk(base / ('attempt-' + str(attempt)), followlinks=False):
        dirs[:] = [name for name in dirs if name not in {'build', 'install', 'log', '__pycache__', '.git'}
                   and not (Path(parent) / name).is_symlink()]
        for name in names:
            path = Path(parent) / name
            if path.is_symlink() or name in {'lease.json', 'cancel.flag'} or path.suffix in {'.zip', '.pyc'}:
                continue
            if path.is_file():
                result[path.relative_to(base).as_posix()] = {'sha256': file_hash(path), 'size': path.stat().st_size}
    for path in base.iterdir():
        if path.is_file() and not path.is_symlink() and path.suffix in {'.json', '.xml', '.urdf'} and path.name != 'integrity.json':
            result[path.name] = {'sha256': file_hash(path), 'size': path.stat().st_size}
    return dict(sorted(result.items()))


def seal_run(root, run, protected_sources):
    from .store import now
    root = Path(root).resolve()
    base = root / 'runs' / run['id']
    pipeline_version=run['spec_snapshot'].get('pipeline_version')
    if protected_snapshot(root,pipeline_version=pipeline_version) != protected_sources:
        raise IntegrityError('执行器模板在本轮生成或运行期间发生变化，请重新运行；未把新旧版本合并为通过。')
    versions = run.get('code_versions') or []
    accepted = next((v for v in reversed(versions) if v.get('status', 'accepted') == 'accepted'), None)
    if not accepted or accepted.get('attempt') != run['attempt']:
        raise IntegrityError('没有与通过结果对应的双端源码版本。')
    out = base / ('attempt-' + str(run['attempt']))
    for name, key in [('algorithm.py', 'code'), ('device_logic.cpp', 'firmware_code')]:
        if (out / name).read_text(encoding='utf-8') != accepted.get(key):
            raise IntegrityError('本轮源码与生成记录不一致：' + name)
    manifest = {'schema_version': 1, 'created_at': now(), 'run_id': run['id'], 'attempt': run['attempt'],
                'spec_sha256': digest(run['spec_snapshot']), 'identity': run['spec_snapshot']['communication']['identity'],
                'protected_sources': protected_sources, 'files': _files(base, run['attempt']),
                'scope': '通过版本的内容一致性摘要；不是实物验收或带密钥签名'}
    manifest['fingerprint'] = digest(manifest)
    (base / 'integrity.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
    return manifest


def verify_run_integrity(root, run, check_templates=True):
    root = Path(root).resolve()
    manifest = run.get('integrity')
    if not isinstance(manifest, dict) or manifest.get('schema_version') != 1:
        raise IntegrityError('这份历史结果还没有完整版本指纹，请重新生成和检查后部署。')
    value = {key: item for key, item in manifest.items() if key != 'fingerprint'}
    if manifest.get('fingerprint') != digest(value) or manifest.get('spec_sha256') != digest(run['spec_snapshot']):
        raise IntegrityError('运行记录或规格摘要不一致，不能继续使用这份通过结果。')
    if manifest.get('run_id') != run['id'] or manifest.get('attempt') != run['attempt']:
        raise IntegrityError('完整性记录不属于这个运行版本。')
    base = (root / 'runs' / run['id']).resolve()
    try:
        persisted = json.loads((base / 'integrity.json').read_text(encoding='utf-8'))
    except (OSError, ValueError) as error:
        raise IntegrityError('工程中的完整性清单缺失或损坏。') from error
    if persisted != manifest:
        raise IntegrityError('工程中的完整性清单与运行记录不一致。')
    for name, expected in manifest.get('files', {}).items():
        path = (base / name).resolve()
        if not path.is_relative_to(base) or not path.is_file() or path.is_symlink():
            raise IntegrityError('通过版本文件缺失或路径变化：' + name)
        if path.stat().st_size != expected['size'] or file_hash(path) != expected['sha256']:
            raise IntegrityError('通过后文件已变化：' + name + '。请重新生成和检查。')
    if not manifest.get('files'):
        raise IntegrityError('版本指纹没有记录任何文件。')
    # Compare the original dependency set. Adding a new, unrelated executor
    # must not retroactively change a V3 fingerprint or upgrade its behavior.
    if check_templates and protected_snapshot(root,recorded_paths=manifest['protected_sources']) != manifest['protected_sources']:
        raise IntegrityError('执行器或受保护模板已更新，请重新生成和检查，不能沿用旧版部署确认。')
    return manifest
