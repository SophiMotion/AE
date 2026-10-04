"""Persistent document RAG: SQLite FTS5/BM25, not embeddings or model training.

Uploaded text is inert evidence. It cannot change task approval or execute tools.
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import subprocess
import sys
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
SOURCE_PATH = ROOT / 'knowledge' / 'sources.json'
MODE = 'sqlite_fts5_bm25'
MAX_UPLOAD_BYTES = 10_000_000
MAX_TEXT_CHARS = 1_000_000
MAX_DOCUMENTS = 500
CHUNK_SIZE, CHUNK_OVERLAP = 1400, 180
_LOCK = threading.RLock()
_GENERIC = {'any', 'all', 'not_applicable'}
_UNKNOWN_VERSIONS = {'', 'unknown', 'unspecified', 'unversioned', 'latest', '未标明', '未填写', '待确认', '未知'}
TEXT_EXTENSIONS = {'.md', '.txt', '.py', '.cpp', '.h', '.hpp', '.ino', '.c', '.cc', '.cxx', '.yaml', '.yml', '.json', '.xml', '.urdf', '.sdf'}
_TASKS = {'joint_position', 'sensor_threshold', 'joint_sequence'}
_STOP = {'the', 'and', 'for', 'with', 'that', 'this', 'from', 'how', 'what', 'are', 'of', 'to', 'in', 'is', 'a', 'an', '如何', '怎么', '什么', '这个', '一个', '我们', '需要', '可以', '请问'}
_SYNONYMS = [
    ('uart', 'serial', '串口'), ('qos', 'reliability', '消息可靠性', '可靠'),
    ('timeout', '失联', '超时'), ('watchdog', '看门狗'),
    ('publisher', 'publish', '发布'), ('subscriber', 'subscription', '订阅', '接收'),
    ('colcon', 'build', '编译', '构建'), ('joint', '关节', '角度'),
    ('sensor', '传感器'), ('threshold', '阈值'), ('gazebo', '物理仿真'),
]


def _now():
    return datetime.now(timezone.utc).isoformat()


def _home(root):
    base = Path(root or ROOT).resolve()
    folder = base / 'knowledge'
    if not folder.resolve().is_relative_to(base):
        raise ValueError('资料目录不能指向工程外部。')
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def _terms(text):
    terms = re.findall(r'[a-z0-9_]+', text.lower())
    for word in re.findall(r'[\u4e00-\u9fff]+', text):
        terms.extend(word[i:i + 2] for i in range(len(word) - 1))
    return [term for term in terms if term not in _STOP and len(term) > 1][:10000]


def _query_terms(text):
    terms = list(dict.fromkeys(_terms(text)))[:80]
    lower = text.lower()
    for group in _SYNONYMS:
        if any((word in lower if re.search('[\u4e00-\u9fff]', word) else word in terms) for word in group):
            for word in group:
                terms.extend(_terms(word))
    return list(dict.fromkeys(terms))[:100]


def _chunks(pages):
    chunks = []
    for page_number, text in pages:
        start = 0
        while start < len(text):
            end = min(start + CHUNK_SIZE, len(text))
            if end < len(text):
                boundary = text.rfind('\n', start + CHUNK_SIZE // 2, end)
                if boundary > start:
                    end = boundary
            raw = text[start:end]
            left = start + len(raw) - len(raw.lstrip())
            right = end - (len(raw) - len(raw.rstrip()))
            content = text[left:right]
            if content:
                headings = re.findall(r'^#{1,6}\s+(.+)$', text[:left] + content.split('\n')[0], re.M)
                chunks.append({'content': content, 'chunk_index': len(chunks) + 1,
                               'page_start': page_number, 'page_end': page_number,
                               'line_start': text.count('\n', 0, left) + 1,
                               'line_end': text.count('\n', 0, right) + 1,
                               'start_char': left, 'end_char': right,
                               'heading': headings[-1][:200] if headings else ''})
            if end >= len(text):
                break
            start = max(start + 1, end - CHUNK_OVERLAP)
    return chunks


def _clean_string(value, name, limit=300, default=''):
    if value is None:
        return default
    if not isinstance(value, str) or len(value) > limit or '\x00' in value:
        raise ValueError(f'{name}格式不正确或过长。')
    return value.strip() or default


def _metadata(metadata, filename):
    if not isinstance(metadata, dict):
        raise ValueError('资料信息必须是对象。')
    title = _clean_string(metadata.get('title'), '标题', default=Path(filename).stem)
    url = _clean_string(metadata.get('url', metadata.get('source_url')), '来源地址', 2000)
    if url:
        parsed = urlsplit(url)
        if parsed.scheme not in {'http', 'https'} or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError('来源地址只接受不含凭据的 HTTP/HTTPS 链接。')
    ros = _clean_string(metadata.get('ros_distro'), 'ROS版本', 40, 'unknown').lower()
    if not re.fullmatch('[a-z][a-z0-9_-]{0,39}', ros):
        raise ValueError('ROS版本格式不正确。')
    board = _clean_string(metadata.get('board'), '板型', 100, 'unknown')
    robot_model = _clean_string(metadata.get('robot_model'), '适用结构', 100, 'unknown')
    source_sha = _clean_string(metadata.get('source_model_sha256'), '源模型摘要', 64) or None
    if not re.fullmatch(r'[A-Za-z0-9_.:-]{1,100}', robot_model):
        raise ValueError('适用结构请使用已知模型编号，通用资料选择 any，尚未核对选择 unknown。')
    if robot_model in {'any', 'unknown'}:
        if source_sha:
            raise ValueError('通用或未确认结构的资料不能填写特定源模型摘要。')
    elif not source_sha or not re.fullmatch(r'[a-f0-9]{64}', source_sha):
        raise ValueError('特定结构资料必须同时提供该源模型的 64 位 SHA256 摘要。')
    declared_software = metadata.get('software_versions', {})
    if not isinstance(declared_software, dict) or set(declared_software) - {'esp32_core', 'arduinojson'}:
        raise ValueError('软件适用版本只接受 esp32_core 和 arduinojson。')
    software = {}
    for key in ('esp32_core', 'arduinojson'):
        value = _clean_string(declared_software.get(key), key + '版本', 80, 'unknown')
        if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.+\-]{0,79}', value):
            raise ValueError('软件适用版本请填固定版本、any（已确认通用）或 unknown（未确认）。')
        software[key] = value
    tasks = metadata.get('task_types', [])
    if not isinstance(tasks, list) or any(task not in _TASKS for task in tasks):
        raise ValueError('任务类型只接受已支持的两类任务。')
    tags = metadata.get('tags', [])
    if not isinstance(tags, list) or len(tags) > 30:
        raise ValueError('关键词最多30项。')
    tags = [_clean_string(tag, '关键词', 60) for tag in tags]
    return {'title': title, 'url': url, 'version': _clean_string(metadata.get('version'), '资料版本', default='未标明'),
            'ros_distro': ros, 'board': board, 'task_types': sorted(set(tasks)), 'tags': tags,
            'robot_model': robot_model, 'source_model_sha256': source_sha,
            'software_versions': software,
            'license': _clean_string(metadata.get('license'), '许可', 500, '用户上传，复用许可待核对'),
            'content_kind': 'original', 'origin': 'upload', 'uploaded': True, 'verification_status': 'unverified_upload',
            'filename': filename}


def _extract(filename, content):
    if not isinstance(filename, str) or Path(filename).name != filename or re.search(r'[\\/:\x00]', filename):
        raise ValueError('文件名不能包含路径。')
    suffix = Path(filename).suffix.lower()
    if suffix not in TEXT_EXTENSIONS | {'.pdf'}:
        raise ValueError('只接受文字 PDF、Markdown、TXT 和支持的源码/配置文本；上传内容不会执行。')
    if not isinstance(content, bytes) or not content or len(content) > MAX_UPLOAD_BYTES:
        raise ValueError('资料必须非空，且不能超过10MB（10,000,000字节）。')
    if suffix == '.pdf':
        if not content.startswith(b'%PDF-'):
            raise ValueError('PDF 文件头不正确。')
        try:
            process = subprocess.run([sys.executable, '-I', '-X', 'utf8', str(Path(__file__).with_name('retrieval_pdf.py'))],
                                     input=content, capture_output=True, timeout=25,
                                     creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            result = json.loads(process.stdout.decode('utf-8'))
        except subprocess.TimeoutExpired as error:
            raise ValueError('PDF 解析超过25秒，请缩小文件或先转为文本。') from error
        except (ValueError, UnicodeError) as error:
            raise ValueError('PDF 无法解析或超过资源限制，请先转为文本。') from error
        if process.returncode or result.get('error'):
            raise ValueError(result.get('error', 'PDF 解析失败。'))
        return [(int(x['page']), x['text']) for x in result['pages']], result.get('warnings', [])
    try:
        text = content.decode('utf-8-sig')
    except UnicodeDecodeError as error:
        raise ValueError('源码和文本资料请使用 UTF-8 编码。') from error
    if '\x00' in text or len(text) > MAX_TEXT_CHARS or not text.strip():
        raise ValueError('文本为空、含二进制内容或超过100万字符。')
    return [(None, text)], []


def _store_document(connection, document, pages, raw=None):
    document = dict(document)
    chunks = _chunks(pages)
    document['chunk_count'] = len(chunks)
    document['content'] = '\n\n'.join(text for _, text in pages)[:1000]
    connection.execute('INSERT INTO documents(id,metadata,raw) VALUES(?,?,?)',
                       (document['id'], json.dumps(document, ensure_ascii=False), raw))
    connection.execute('INSERT INTO document_pages(document_id,pages) VALUES(?,?)',
                       (document['id'], json.dumps([{'page': page, 'text': text} for page, text in pages], ensure_ascii=False)))
    for chunk in chunks:
        chunk_id = document['id'] if len(chunks) == 1 else f"{document['id']}#chunk-{chunk['chunk_index']}"
        item = {**document, **chunk, 'id': chunk_id, 'document_id': document['id']}
        cursor = connection.execute('INSERT INTO chunks(id,document_id,payload) VALUES(?,?,?)',
                                    (chunk_id, document['id'], json.dumps(item, ensure_ascii=False)))
        connection.execute('INSERT INTO search(rowid,title,tags,body) VALUES(?,?,?,?)',
                           (cursor.lastrowid, ' '.join(_terms(document['title'] + ' ' + chunk['heading'])),
                            ' '.join(_terms(' '.join(document.get('tags', [])))), ' '.join(_terms(chunk['content']))))
    return document


def _remove(connection, doc_id):
    connection.execute('DELETE FROM search WHERE rowid IN (SELECT rowid FROM chunks WHERE document_id=?)', (doc_id,))
    connection.execute('DELETE FROM chunks WHERE document_id=?', (doc_id,))
    connection.execute('DELETE FROM document_pages WHERE document_id=?', (doc_id,))
    connection.execute('DELETE FROM documents WHERE id=?', (doc_id,))


def _sync_seeds(connection, folder):
    path = folder / 'sources.json'
    if not path.is_file():
        path = SOURCE_PATH
    seed = json.loads(path.read_text(encoding='utf-8'))
    items = seed.get('items', [])
    signature = hashlib.sha256(json.dumps(items, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    current = connection.execute("SELECT value FROM metadata WHERE key='seed_hash'").fetchone()
    if current and current[0] == signature:
        return
    for row in connection.execute('SELECT id,metadata FROM documents').fetchall():
        if json.loads(row[1]).get('origin') == 'builtin':
            _remove(connection, row[0])
    for source in items:
        content = source['content']
        document = {**source, 'board': source.get('board', 'any'), 'origin': 'builtin', 'uploaded': False,
                    'content_kind': source.get('content_kind', 'summary'),
                    'verification_status': source.get('verification_status', 'curated_summary'),
                    'filename': source.get('filename', 'sources.json'),
                    'source_hash': hashlib.sha256(content.encode()).hexdigest(),
                    'created_at': source.get('checked_at', ''), 'status': 'indexed', 'warnings': []}
        _store_document(connection, document, [(source.get('page_start'), content)])
    connection.execute("INSERT OR REPLACE INTO metadata(key,value) VALUES('seed_hash',?)", (signature,))


@contextmanager
def _database(root=None):
    with _LOCK:
        folder = _home(root)
        path = folder / 'rag.sqlite3'
        if path.is_symlink():
            raise ValueError('资料索引不能使用符号链接。')
        connection = sqlite3.connect(path, timeout=15)
        try:
            connection.executescript('''
                CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,metadata TEXT NOT NULL,raw BLOB);
                CREATE TABLE IF NOT EXISTS chunks(id TEXT UNIQUE,document_id TEXT NOT NULL,payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS document_pages(document_id TEXT PRIMARY KEY,pages TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS chunks_document ON chunks(document_id);
                CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(title,tags,body);
            ''')
            _sync_seeds(connection, folder)
            yield connection
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()


def list_sources(root=None):
    """Document catalog; summaries and uploaded originals are explicitly labelled."""
    with _database(root) as connection:
        return [json.loads(row[0]) for row in connection.execute('SELECT metadata FROM documents ORDER BY rowid')]


def browse_documents(root=None, task_type='', board=None, ros_distro='humble'):
    """Management view may show unknown scope; generation still uses retrieve()."""
    rows = []
    for item in list_sources(root):
        applicable = dict(item)
        # Unknown uploads must remain manageable, with their warnings intact.
        if applicable.get('ros_distro') == 'unknown':
            applicable['ros_distro'] = 'any'
        if applicable.get('board', '').lower() == 'unknown':
            applicable['board'] = 'any'
        if not _compatible(applicable, task_type, board or 'any', str(ros_distro or 'any').lower()):
            continue
        rows.append({**item, 'document_id': item['id'], 'uploaded': item.get('origin') == 'upload'})
    return rows


def ingest_document(root, filename, content_bytes, metadata):
    pages, warnings = _extract(filename, content_bytes)
    meta = _metadata(metadata, filename)
    if meta['ros_distro'] == 'unknown':
        warnings.append('未填写适用 ROS 版本，默认工程检索不会采用；通用资料请明确选择 any。')
    if meta['board'].lower() == 'unknown':
        warnings.append('未填写适用板型，不能据此生成硬件接线；通用资料请明确选择 any。')
    if not _known_version(meta.get('version')):
        warnings.append('资料未标明固定的软件/文档版本，保留在目录中；补齐前不会用于生成。')
    if meta['robot_model'] == 'unknown':
        warnings.append('尚未确认适用结构，保留供浏览；确认通用或绑定具体源模型后才用于生成。')
    if not _upload_software_known(meta):
        warnings.append('尚未确认 ESP32 核心或 ArduinoJson 适用版本，只供浏览；请明确固定版本或 any（已确认通用）。')
    digest = hashlib.sha256(content_bytes).hexdigest()
    doc_id = 'upload-' + hashlib.sha256((digest + json.dumps(meta, sort_keys=True, ensure_ascii=False)).encode()).hexdigest()[:24]
    with _database(root) as connection:
        old = connection.execute('SELECT metadata FROM documents WHERE id=?', (doc_id,)).fetchone()
        if old:
            return {**json.loads(old[0]), 'duplicate': True}
        if connection.execute('SELECT count(*) FROM documents').fetchone()[0] >= MAX_DOCUMENTS:
            raise ValueError('本机轻量资料库最多500份资料，请先整理重复内容。')
        document = {**meta, 'id': doc_id, 'source_hash': digest, 'created_at': _now(),
                    'checked_at': None, 'status': 'indexed', 'warnings': warnings,
                    'url': meta['url'] or f'knowledge://document/{doc_id}'}
        return {**_store_document(connection, document, pages, content_bytes), 'duplicate': False}


def delete_document(root, id):
    with _database(root) as connection:
        row = connection.execute('SELECT metadata FROM documents WHERE id=?', (str(id),)).fetchone()
        if not row:
            raise ValueError('资料不存在。')
        if json.loads(row[0]).get('origin') == 'builtin':
            raise ValueError('内置资料请通过维护语料文件更新，不能从上传界面删除。')
        _remove(connection, str(id))
    return {'id': str(id), 'deleted': True, 'notice': '已从后续检索移除；既有运行记录保留当时使用的证据。'}


def _board_key(value):
    return re.sub(r'[^a-z0-9]', '', str(value or '').lower())


def _known_version(value):
    return isinstance(value, str) and value.strip().lower() not in _UNKNOWN_VERSIONS


def _model_scope_known(document):
    # Legacy uploaded metadata never asked whether a source was model-specific.
    # Preserve those files, but do not silently treat them as general manuals.
    if document.get('origin') == 'upload':
        model = document.get('robot_model', 'unknown')
        return model == 'any' or (model != 'unknown' and bool(re.fullmatch(r'[a-f0-9]{64}', document.get('source_model_sha256') or '')))
    return document.get('robot_model') != 'unknown'


def _upload_software_known(document):
    if document.get('origin') != 'upload':
        return True
    versions = document.get('software_versions') or {}
    return isinstance(versions, dict) and all(_known_version(versions.get(key)) for key in ('esp32_core', 'arduinojson'))


def document_detail(root, document_id):
    """Return stored inert text. Never treats a document id as a filesystem path."""
    with _database(root) as connection:
        row = connection.execute('SELECT metadata,raw FROM documents WHERE id=?', (str(document_id),)).fetchone()
        if not row:
            raise KeyError(document_id)
        document = json.loads(row[0])
        page_row = connection.execute('SELECT pages FROM document_pages WHERE document_id=?', (str(document_id),)).fetchone()
        if page_row:
            pages = json.loads(page_row[0])
        elif row[1] is not None:
            # Migration for pre-V4 uploads. Reparse their stored bytes, never a
            # caller supplied path. A PDF keeps extracted pages, not executable HTML.
            extracted, _ = _extract(document['filename'], bytes(row[1]))
            pages = [{'page': page, 'text': text} for page, text in extracted]
        else:
            # Older builtins are exact entries in the trusted local seed file.
            path = _home(root) / 'sources.json'
            source = path if path.is_file() else SOURCE_PATH
            seeds = json.loads(source.read_text(encoding='utf-8')).get('items', [])
            entry = next((value for value in seeds if value['id'] == str(document_id)), None)
            pages = [{'page': entry.get('page_start'), 'text': entry['content']}] if entry else []
        if not page_row and pages:
            connection.execute('INSERT INTO document_pages(document_id,pages) VALUES(?,?)',
                               (str(document_id), json.dumps(pages, ensure_ascii=False)))
        chunks = [json.loads(item[0]) for item in connection.execute('SELECT payload FROM chunks WHERE document_id=? ORDER BY rowid', (str(document_id),))]
        return {'document': {**document, 'document_id': document['id'],
                             'generation_eligible': _known_version(document.get('version')) and document.get('board') != 'unknown' and document.get('ros_distro') != 'unknown' and _model_scope_known(document) and _upload_software_known(document)},
                'pages': pages, 'chunks': [{key: chunk.get(key) for key in ('id', 'chunk_index', 'heading', 'page_start', 'page_end', 'line_start', 'line_end')} for chunk in chunks],
                'source_bytes_sha256': document.get('source_hash'), 'original_available': bool(pages),
                'notice': '只显示已存资料原文或经验摘要，不执行源码；经验摘要不是原始日志，也不代表实物验收。'}


def ingest_experience(root, document, text):
    """Trusted publication entrypoint; caller must build and confirm run evidence."""
    if document.get('origin') != 'experience' or not re.fullmatch(r'experience-[a-zA-Z0-9_-]{1,100}', str(document.get('id', ''))):
        raise ValueError('经验来源格式不正确。')
    if not isinstance(text, str) or not text.strip() or len(text) > 30000:
        raise ValueError('经验必须是有限长度的摘要。')
    raw = text.encode('utf-8')
    with _database(root) as connection:
        old = connection.execute('SELECT metadata FROM documents WHERE id=?', (document['id'],)).fetchone()
        if old:
            previous = json.loads(old[0])
            if previous.get('preview_hash') != document.get('preview_hash'):
                raise ValueError('该运行已经收录为另一份摘要，请先删除旧经验，再核对当前记录。')
            return {**previous, 'document_id': previous['id'], 'duplicate': True}
        if connection.execute('SELECT count(*) FROM documents').fetchone()[0] >= MAX_DOCUMENTS:
            raise ValueError('本机资料库最多500份资料，请先整理已有资料。')
        value = {**document, 'source_hash': hashlib.sha256(raw).hexdigest(), 'created_at': _now(),
                 'checked_at': _now(), 'status': 'indexed', 'uploaded': False,
                 'filename': document['id'] + '.md', 'content_kind': 'summary',
                 'physical_verified': False, 'esp32_execution_verified': False, 'flashed': False}
        stored = _store_document(connection, value, [(None, text)], raw)
        return {**stored, 'document_id': stored['id'], 'duplicate': False}


def _compatible(item, task_type, board, ros_distro):
    item_ros = item.get('ros_distro', 'unknown')
    if ros_distro not in {'any', 'all'} and item_ros not in {ros_distro, 'any', 'not_applicable'}:
        return False
    item_board = item.get('board', 'unknown')
    if str(board).lower() not in {'any', 'all'} and item_board.lower() not in _GENERIC:
        if not board or _board_key(board) != _board_key(item_board) or _board_key(board) == 'unknown':
            return False
    tasks = item.get('task_types', [])
    return not task_type or not tasks or task_type in tasks


def retrieve(query, task_type, limit=6, *, board=None, ros_distro='humble', root=None, robot_model=None, source_model_sha256=None,
             protocol_sha256=None, software_versions=None):
    """BM25 over matching versions/boards, with no unrelated-result padding."""
    if task_type not in {*_TASKS, '', None}:
        return []
    if not isinstance(query, str):
        raise ValueError('查询必须是文字。')
    terms = _query_terms(query[:12000])
    if not terms:
        return []
    count = max(0, min(int(limit), 20))
    if not count:
        return []
    expression = ' OR '.join('"' + term + '"' for term in terms)
    results = []
    with _database(root) as connection:
        rows = connection.execute('''SELECT chunks.payload,bm25(search,5.0,3.0,1.0)
            FROM search JOIN chunks ON chunks.rowid=search.rowid
            WHERE search MATCH ? ORDER BY bm25(search,5.0,3.0,1.0),chunks.rowid''', (expression,))
        per_document = {}
        for payload, score in rows:
            item = json.loads(payload)
            if not _known_version(item.get('version')):
                continue
            if not _compatible(item, task_type, board, str(ros_distro or 'unknown').lower()):
                continue
            if item.get('origin') == 'experience' and robot_model != 'any':
                # Experience is narrower than a general manual: do not mix
                # protocol or SDK versions, and never infer omitted applicability.
                if not protocol_sha256 or protocol_sha256 != item.get('protocol_sha256'):
                    continue
                if not isinstance(software_versions, dict) or any(
                        software_versions.get(key) != value for key, value in item.get('software_versions', {}).items()):
                    continue
            if robot_model != 'any':
                if not _model_scope_known(item):
                    continue
                if not _upload_software_known(item):
                    continue
                if item.get('origin') == 'upload' and any(
                        version != 'any' and (software_versions or {}).get(key) != version
                        for key, version in item['software_versions'].items()):
                    continue
                if item.get('robot_model') and item['robot_model'] not in {'any', robot_model}:
                    continue
                if item.get('source_model_sha256') and item['source_model_sha256'] != source_model_sha256:
                    continue
            document_id = item['document_id']
            if per_document.get(document_id, 0) >= 2:
                continue
            per_document[document_id] = per_document.get(document_id, 0) + 1
            item.update(score=round(-score, 8), retrieval_mode=MODE,
                        citation={'document_id': document_id, 'chunk_id': item['id'], 'source_hash': item['source_hash'],
                                  'page_start': item['page_start'], 'page_end': item['page_end'],
                                  'line_start': item['line_start'], 'line_end': item['line_end']})
            results.append(item)
            if len(results) >= count:
                break
    return results


def stats(root=None):
    with _database(root) as connection:
        documents = [json.loads(row[0]) for row in connection.execute('SELECT metadata FROM documents')]
        return {'documents': len(documents), 'chunks': connection.execute('SELECT count(*) FROM chunks').fetchone()[0],
                'builtin_documents': sum(x['origin'] == 'builtin' for x in documents),
                'uploaded_documents': sum(x['origin'] == 'upload' for x in documents),
                'experience_documents': sum(x['origin'] == 'experience' for x in documents),
                'original_documents': sum(x['content_kind'] == 'original' for x in documents),
                'summary_documents': sum(x['content_kind'] == 'summary' for x in documents),
                'retrieval_mode': MODE, 'embedding_enabled': False, 'ocr_enabled': False,
                'max_upload_bytes': MAX_UPLOAD_BYTES, 'max_documents': MAX_DOCUMENTS,
                'notice': '按关键词、同义词和BM25找原文；不是语义向量检索，找不到时返回空结果。'}


def evaluate(root=None):
    """Deterministic retrieval checks; these are not LLM or firmware pass rates."""
    path = _home(root) / 'evaluation.json'
    if not path.is_file():
        path = ROOT / 'knowledge' / 'evaluation.json'
    cases = json.loads(path.read_text(encoding='utf-8')).get('cases', [])
    if len(cases) > 100:
        raise ValueError('检索检查最多100题。')
    results = []
    for case in cases:
        hits = retrieve(case['query'], case.get('task_type', ''), 5, board=case.get('board'),
                        ros_distro=case.get('ros_distro', 'humble'), root=root, robot_model=case.get('robot_model'), source_model_sha256=case.get('source_model_sha256'))
        ids = [x['document_id'] for x in hits]
        expected = case.get('expected_ids', [])
        excluded = case.get('excluded_ids', [])
        passed = not hits if case.get('expect_empty') else bool(set(ids) & set(expected)) if expected else bool(excluded)
        passed = passed and not bool(set(ids) & set(excluded))
        results.append({'id': case['id'], 'query': case['query'], 'passed': passed,
                        'expected_ids': expected, 'excluded_ids': excluded, 'returned_ids': ids,
                        'expect_empty': bool(case.get('expect_empty'))})
    passed = sum(x['passed'] for x in results)
    return {'total': len(results), 'passed': passed, 'failed': len(results) - passed, 'results': results,
            'retrieval_mode': MODE, 'generation_tested': False, 'checked_at': _now(),
            'notice': '只检查资料能否被找对、错版本能否排除；不代表生成或硬件通过率。'}
