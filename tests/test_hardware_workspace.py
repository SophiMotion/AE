"""Hardware drafts are data; export and AI must not silently repair them."""
import asyncio
import copy
import importlib
import io
import json
import shutil
import subprocess
import threading
import time
import zipfile
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.requests import Request

from server import providers


def module():
    # Keep the initial failure about the missing capability, not collection.
    try:
        return importlib.import_module('server.hardware_workspace')
    except ModuleNotFoundError:
        pytest.fail('The hardware workspace backend is not implemented yet.')


def program():
    return {'schema_version': 1, 'name': '硬件实验', 'board': 'esp32',
            'request': '串口打印后点亮信号输出',
            'bindings': [{'id': 'signal', 'label': '输出信号', 'pin': 4}],
            'setup': [{'kind': 'serial_print', 'text': '你好 "AE"\\\n'}],
            'loop': [{'kind': 'digital_write', 'binding': 'signal', 'value': 1},
                     {'kind': 'delay', 'ms': 1000}]}


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(module().create_router(Path(__file__).resolve().parents[1],
        lambda: {'provider': 'codex', 'model': 'fixture', 'api_key': 'private-test-key',
                 'timeout_seconds': 1}))
    with TestClient(app) as value:
        yield value


@pytest.fixture
def ai(monkeypatch):
    holder = {'candidate': {'program': program(), 'summary': '待采用的候选草稿',
                           'changes': ['修改串口内容'], 'unresolved': []}}

    def invoke(prompt, schema, config, workdir, cancel):
        holder.update(prompt=prompt, schema=schema, config=config, workdir=workdir)
        return copy.deepcopy(holder['candidate']), {
            'tool': 'test fixture (not real AI)', 'model': 'fixture', 'prompt': prompt,
            'response': json.dumps(holder['candidate'], ensure_ascii=False),
            'status': 'completed', 'invocation_id': 'fixture-call',
            'api_key': 'private-test-key', 'unknown': 'must not leak'}

    monkeypatch.setattr(providers, 'generate_assistance', invoke)
    return holder


def test_export_has_safe_paths_and_truthful_manifest(client):
    draft = program()
    draft['name'] = '../../unsafe\\name'
    response = client.post('/api/hardware/export', json=draft)
    assert response.status_code == 200, response.text
    assert response.headers['content-type'] == 'application/zip'
    assert 'hardware_project.zip' in response.headers['content-disposition']
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert set(archive.namelist()) == {
            'hardware_project/hardware_project.ino', 'config.json', 'manifest.json', 'README.md'}
        assert json.loads(archive.read('config.json')) == draft
        manifest = json.loads(archive.read('manifest.json'))
        assert manifest['project_name'] == draft['name']
        assert manifest['source_only'] is True
        assert manifest['compiled'] is False
        assert manifest['uploaded'] is False
        assert manifest['physical_tested'] is False
        assert manifest['fqbn'] == 'esp32:esp32:esp32'
        code = archive.read('hardware_project/hardware_project.ino').decode()
    assert code == ('#include <Arduino.h>\n\nvoid setup() {\n'
        '  Serial.begin(115200);\n  pinMode(4, OUTPUT);\n'
        '  Serial.println("你好 \\"AE\\"\\\\\\n");\n}\n\nvoid loop() {\n'
        '  digitalWrite(4, HIGH);\n  delay(1000);\n}\n')


@pytest.mark.parametrize('value', [True, 4.0, '4', -1, 0, 35, 99])
def test_invalid_pin_never_reaches_export(client, value):
    draft = program()
    draft['bindings'][0]['pin'] = value
    assert client.post('/api/hardware/export', json=draft).status_code == 422


@pytest.mark.parametrize('path,value', [
    ('schema_version', True), ('schema_version', 1.0), ('board', 'esp32-s3'),
    ('name', ''), ('name', 'a' * 101), ('request', 'a' * 6001),
    ('setup', [{'kind': 'shell', 'command': 'echo unsafe'}]),
    ('setup', [{'kind': 'delay', 'ms': True}]),
    ('setup', [{'kind': 'delay', 'ms': 1.5}]),
    ('setup', [{'kind': 'delay', 'ms': 0}]),
    ('setup', [{'kind': 'delay', 'ms': 60001}]),
    ('setup', [{'kind': 'digital_write', 'binding': 'signal', 'value': True}]),
    ('setup', [{'kind': 'digital_write', 'binding': 'unknown', 'value': 0}]),
    ('setup', [{'kind': 'serial_print', 'text': 'a' * 501}]),
    ('setup', [{'kind': 'serial_print', 'text': '\ud800'}]),
    ('setup', [{'kind': 'serial_print', 'text': 'hi', 'code': 'evil()'}]),
    ('setup', [{'kind': 'repeat', 'count': 101, 'steps': []}]),
    ('bindings', [{'id': 'bad-id', 'label': 'signal', 'pin': 4}]),
    ('bindings', [{'id': 'signal', 'label': 'x', 'pin': 4},
                  {'id': 'other', 'label': 'y', 'pin': 4}]),
    ('bindings', [{'id': 'signal', 'label': 'x', 'pin': 4},
                  {'id': 'signal', 'label': 'y', 'pin': 13}]),
])
def test_malformed_program_rejected(client, path, value):
    draft = program()
    draft[path] = value
    # Raw escaped JSON allows lone surrogates to reach our validator.
    response = client.post('/api/hardware/export', content=json.dumps(draft),
                           headers={'content-type': 'application/json'})
    assert response.status_code == 422, response.text


def test_json_constants_duplicate_keys_and_extra_properties_rejected(client):
    encoded = json.dumps(program())
    for payload in [encoded.replace('"pin": 4', '"pin": NaN'),
                    encoded.replace('"pin": 4', '"pin": Infinity'),
                    encoded.replace('"pin": 4', '"pin": 4, "pin": 13'),
                    encoded[:-1] + ', "code": "arbitrary code"}']:
        assert client.post('/api/hardware/export', content=payload,
                           headers={'content-type': 'application/json'}).status_code == 422


def test_missing_pin_draft_can_be_assisted_but_not_exported(client, ai):
    draft = program()
    draft['bindings'][0]['pin'] = None
    ai['candidate']['program'] = copy.deepcopy(draft)
    response = client.post('/api/hardware/assist', json={'program': draft, 'instruction': '整理程序'})
    assert response.status_code == 200, response.text
    assert response.json()['program']['bindings'][0]['pin'] is None
    assert response.json()['unresolved']
    assert client.post('/api/hardware/export', json=draft).status_code == 422


def test_unused_missing_pin_and_s3_conservative_pin_export(client):
    draft = program()
    draft['board'] = 'esp32s3'
    draft['bindings'][0]['pin'] = 5
    draft['bindings'].append({'id': 'unused', 'label': '未选择', 'pin': None})
    assert client.post('/api/hardware/export', json=draft).status_code == 200
    draft['bindings'][0]['pin'] = 35
    assert client.post('/api/hardware/export', json=draft).status_code == 422


def test_instruction_nesting_total_and_expansion_budgets(client):
    draft = program()
    draft['setup'] = []
    nested = {'kind': 'delay', 'ms': 1}
    for _ in range(4):
        nested = {'kind': 'repeat', 'count': 1, 'steps': [nested]}
    draft['loop'] = [nested]
    assert client.post('/api/hardware/export', json=draft).status_code == 200
    draft['loop'] = [{'kind': 'repeat', 'count': 1, 'steps': [nested]}]
    assert client.post('/api/hardware/export', json=draft).status_code == 422
    draft['loop'] = [{'kind': 'delay', 'ms': 1}] * 100
    assert client.post('/api/hardware/export', json=draft).status_code == 200
    draft['setup'] = [{'kind': 'delay', 'ms': 1}]
    assert client.post('/api/hardware/export', json=draft).status_code == 422
    draft['setup'] = []
    draft['loop'] = [{'kind': 'repeat', 'count': 100, 'steps': [
        {'kind': 'repeat', 'count': 100, 'steps': [{'kind': 'delay', 'ms': 1}]}]}]
    assert client.post('/api/hardware/export', json=draft).status_code == 422


def test_repeat_numbering_and_control_characters_are_literal_cpp_data(client):
    draft = program()
    draft['setup'] = [{'kind': 'repeat', 'count': 2, 'steps': [
        {'kind': 'serial_print', 'text': '\x00a\x01f\x7f??/\b\f\t\r'}]}]
    draft['loop'] = [{'kind': 'repeat', 'count': 3, 'steps': [{'kind': 'delay', 'ms': 1}]}]
    response = client.post('/api/hardware/export', json=draft)
    assert response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        code = archive.read('hardware_project/hardware_project.ino').decode()
    assert 'for (int repeat_0 = 0; repeat_0 < 2; repeat_0++) {' in code
    assert 'for (int repeat_1 = 0; repeat_1 < 3; repeat_1++) {' in code
    assert 'Serial.println("\\000a\\001f\\177\\?\\?/\\b\\f\\t\\r");' in code


def test_assist_returns_only_validated_candidate_and_bounded_provenance(client, ai):
    original = program()
    ai['candidate']['program']['setup'][0]['text'] = 'new message'
    ai['candidate']['summary'] = 'private-test-key'
    response = client.post('/api/hardware/assist', json={'program': original, 'instruction': '更新串口信息'})
    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == {'program', 'summary', 'changes', 'unresolved', 'provenance'}
    assert body['program']['setup'][0]['text'] == 'new message'
    assert original['setup'][0]['text'] == '你好 "AE"\\\n'
    assert body['provenance']['prompt']
    assert body['provenance']['status'] == 'completed'
    assert 'private-test-key' not in response.text
    assert 'unknown' not in body['provenance']
    assert ai['workdir'].is_dir()
    assert ai['config']['timeout_seconds'] <= 120
    assert ai['schema']['additionalProperties'] is False


@pytest.mark.parametrize('mutation', ['board', 'pin', 'binding', 'invented', 'unknown_block'])
def test_ai_cannot_change_hardware_or_return_unknown_operations(client, ai, mutation):
    result = ai['candidate']['program']
    if mutation == 'board':
        result['board'] = 'esp32s3'
    elif mutation == 'pin':
        result['bindings'][0]['pin'] = 13
    elif mutation == 'binding':
        result['bindings'][0]['label'] = 'renamed physical output'
    elif mutation == 'invented':
        result['bindings'].append({'id': 'invented', 'label': '猜测输出', 'pin': 14})
    else:
        result['loop'].append({'kind': 'motor_move', 'degrees': 90})
    response = client.post('/api/hardware/assist', json={'program': program(), 'instruction': '调整程序'})
    assert response.status_code == 502, response.text
    assert 'program' not in response.json()


def test_unsupported_ai_request_retains_unresolved_without_fake_solution(client, ai):
    ai['candidate']['summary'] = '当前积木无法实现摄像头识别'
    ai['candidate']['changes'] = []
    ai['candidate']['unresolved'] = ['摄像头和视觉识别不在当前积木范围内']
    response = client.post('/api/hardware/assist', json={'program': program(), 'instruction': '摄像头识别人脸'})
    assert response.status_code == 200
    assert response.json()['unresolved'] == ['摄像头和视觉识别不在当前积木范围内']
    assert response.json()['program'] == program()


def test_provider_failure_has_no_fallback_and_redacts_secrets(client, monkeypatch):
    def fail(*args):
        raise providers.ProviderError('provider failed private-test-key', {'response': 'private-test-key'})
    monkeypatch.setattr(providers, 'generate_assistance', fail)
    response = client.post('/api/hardware/assist', json={'program': program(), 'instruction': '调整'})
    assert response.status_code == 502
    assert 'program' not in response.json()
    assert 'private-test-key' not in response.text


@pytest.mark.parametrize('provenance', [
    {'status': {'api_key': 'private-test-key'}}, {'status': 'private-test-key' * 1000},
    ['private-test-key'], {'status': 'completed'}, {'status': None}])
def test_provider_error_metadata_cannot_escape_provenance_bounds(client, monkeypatch, provenance):
    def fail(*args):
        raise providers.ProviderError('provider unavailable', provenance)
    monkeypatch.setattr(providers, 'generate_assistance', fail)
    response = client.post('/api/hardware/assist', json={'program': program(), 'instruction': '调整'})
    assert response.status_code == 502
    assert response.json()['provenance']['status'] == 'failed'
    assert 'private-test-key' not in response.text


@pytest.mark.parametrize('payload', [None, {}, [], {'program': program(), 'instruction': True},
    {'program': program(), 'instruction': ''}, {'program': program(), 'instruction': 'x' * 6001},
    {'program': program(), 'instruction': 'x', 'command': 'whoami'}])
def test_assist_input_types_are_422(client, payload):
    assert client.post('/api/hardware/assist', json=payload).status_code == 422


def test_provider_timeout_sets_cancel_event(client, monkeypatch):
    seen = threading.Event()
    def blocked(prompt, schema, config, workdir, cancel):
        if cancel.wait(2):
            seen.set()
            raise providers.ProviderCancelled('cancelled')
        raise RuntimeError('timeout did not cancel provider')
    monkeypatch.setattr(providers, 'generate_assistance', blocked)
    started = time.monotonic()
    response = client.post('/api/hardware/assist', json={'program': program(), 'instruction': '调整'})
    assert response.status_code == 502
    assert time.monotonic() - started < 2
    assert seen.wait(0.5)


def test_client_disconnect_cancels_provider_and_returns_no_candidate(monkeypatch):
    cancelled = threading.Event()
    def blocked(prompt, schema, config, workdir, cancel):
        if cancel.wait(1):
            cancelled.set()
        raise providers.ProviderCancelled('client disconnected')
    monkeypatch.setattr(providers, 'generate_assistance', blocked)
    async def receive():
        return {'type': 'http.disconnect'}
    response = asyncio.run(module()._assist(Request({'type': 'http'}, receive), program(), '调整',
        Path(__file__).resolve().parents[1], {'provider': 'codex', 'timeout_seconds': 1}))
    assert response.status_code == 499
    assert 'program' not in json.loads(response.body)
    assert cancelled.is_set()


def test_excessive_body_and_recursion_return_validation_error(client):
    for payload in [' ' * 512001, '[' * 2000 + '0' + ']' * 2000]:
        assert client.post('/api/hardware/export', content=payload).status_code == 422


def test_more_than_eight_bindings_rejected(client):
    draft = program()
    draft['bindings'] = [{'id': f'output_{i}', 'label': 'output', 'pin': None} for i in range(9)]
    draft['loop'] = []
    assert client.post('/api/hardware/export', json=draft).status_code == 422


def test_provenance_unknown_fields_dropped_and_optional_fields_clipped(client, monkeypatch):
    def invoke(prompt, *args):
        return {'program': program(), 'summary': '候选', 'changes': [], 'unresolved': []}, {
            'prompt': prompt, 'model': 'm' * 1000, 'tool': 't' * 1000,
            'invocation_id': 'i' * 1000, 'response': 'r' * 150000,
            'secret': 'private-test-key', 'api_key': 'private-test-key'}
    monkeypatch.setattr(providers, 'generate_assistance', invoke)
    response = client.post('/api/hardware/assist', json={'program': program(), 'instruction': '调整'})
    assert response.status_code == 200
    provenance = response.json()['provenance']
    assert len(provenance['model']) <= 200
    assert len(provenance['tool']) <= 200
    assert len(provenance['invocation_id']) <= 128
    assert len(provenance['response']) <= 120000
    assert 'api_key' not in provenance and 'secret' not in provenance


def test_secret_redaction_cannot_change_preserved_pin_metadata(client, ai):
    draft = program()
    draft['bindings'][0]['label'] = 'private-test-key'
    ai['candidate']['program'] = draft
    response = client.post('/api/hardware/assist', json={'program': draft, 'instruction': '整理'})
    assert response.status_code == 502
    assert 'private-test-key' not in response.text


def test_typescript_preview_and_python_export_generate_identical_files():
    node = shutil.which('node')
    if not node:
        pytest.skip('Node is not installed; run the frontend contract checks separately.')
    version = subprocess.check_output([node, '--version'], text=True).strip().lstrip('v')
    if tuple(map(int, version.split('.')[:2])) < (22, 18):
        pytest.skip('Direct TypeScript contract checks need Node 22.18 or later.')
    fixtures = []
    for text in ['plain', '你好 🦾 "quotes" \\ \n\r\t\b\f\x00a\x01f\x7f??/',
                 ''.join(chr(i) for i in range(128))]:
        draft = program()
        draft['setup'] = [{'kind': 'repeat', 'count': 2, 'steps': [
            {'kind': 'serial_print', 'text': text}, {'kind': 'repeat', 'count': 3,
                'steps': [{'kind': 'delay', 'ms': 60000}]}]}]
        draft['loop'] = [{'kind': 'repeat', 'count': 1, 'steps': [
            {'kind': 'digital_write', 'binding': 'signal', 'value': 0}]}]
        fixtures.append(draft)
    fixtures.extend([dict(program(), setup=[], loop=[]), dict(program(), board='esp32s3')])
    script = ("import {hardwareProgramFiles} from './web/src/hardwareProgram.ts';"
              "let s='';for await(const chunk of process.stdin)s+=chunk;"
              "process.stdout.write(JSON.stringify(JSON.parse(s).map(hardwareProgramFiles)));")
    result = subprocess.run([node, '--input-type=module', '-e', script],
        input=json.dumps(fixtures), capture_output=True, text=True, encoding='utf-8',
        cwd=Path(__file__).resolve().parents[1], timeout=20, check=True)
    expected = json.loads(result.stdout)
    assert [module().hardware_program_files(draft) for draft in fixtures] == expected
