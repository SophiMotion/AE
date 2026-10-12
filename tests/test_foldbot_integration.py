"""Mounted API tests. No hardware connection, ROS process or firmware build."""
import asyncio
import io
import zipfile

import pytest
from fastapi.testclient import TestClient

from server.app import create_app
from server.foldbot_projects import DEFAULTS


def test_generated_project_is_isolated_and_live_routes_require_review(tmp_path, monkeypatch):
    def no_device(*args, **kwargs):
        pytest.fail('API read/generation must not construct a hardware client')

    app = create_app(tmp_path)
    app.state.foldbot_control.backend_factory = no_device
    with TestClient(app, base_url='http://127.0.0.1:8877') as client:
        assert client.get('/api/foldbot/template').status_code == 200
        created = client.post('/api/foldbot/projects', json=DEFAULTS).json()
        assert client.get('/api/projects').json()['items'] == []
        address = dict(project_id=created['id'], revision=1, address='192.168.4.1', confirmed=True)
        assert client.post('/api/foldbot/control/connect', json=address).status_code == 409
        assert client.post('/api/foldbot/control/connect', json=address,
                           headers={'Origin': 'https://sophimotion.github.io'}).status_code == 403
        assert client.post('/api/foldbot/control/connect', json={**address, 'address': '8.8.8.8'}).status_code == 422
        base = '/api/foldbot/projects/' + created['id']
        generated = client.post(base + '/generate', json={'revision': 1, 'reviewed': True}).json()
        assert generated['generation']['evidence']['ros_executed'] is False
        assert generated['generation']['evidence']['hardware_verified'] is False
        preview = client.get(base + '/file', params={'path': 'config/foldbot_config.json'})
        assert preview.status_code == 200
        assert client.get(base + '/file', params={'path': '../settings.json'}).status_code == 404
        bundle = zipfile.ZipFile(io.BytesIO(client.get(base + '/export').content))
        assert 'firmware/foldbot/web_ui.h' in bundle.namelist()
        assert len(bundle.namelist()) == 14
        events = client.get(base + '/control-events').json()
        assert events == {'items': [], 'physical_completion_verified': False}
        edited = client.put(base, json={**DEFAULTS, 'revision': 1, 'request': '改变的需求'}).json()
        assert edited['revision'] == 2 and edited['generation'] is None
        assert client.post('/api/foldbot/control/connect', json=address).status_code == 409


def test_lifespan_closes_control_even_when_context_raises(tmp_path):
    app = create_app(tmp_path)
    called = []

    async def close():
        called.append(True)

    app.state.foldbot_control.close = close

    async def exercise():
        with pytest.raises(RuntimeError):
            async with app.router.lifespan_context(app):
                raise RuntimeError('test shutdown')
        assert called == [True]

    asyncio.run(exercise())


def test_console_reserves_without_device_access_and_shares_control_arbiter(tmp_path):
    app = create_app(tmp_path)

    async def no_device(*args, **kwargs):
        pytest.fail('A reservation must not connect a device')

    app.state.foldbot_console.factory = no_device
    with TestClient(app, base_url='http://127.0.0.1:8877') as client:
        assert client.get('/api/foldbot/console/events').json()['items'] == []
        body = {'address': '192.168.4.1', 'confirmed': True}
        assert client.post('/api/foldbot/console/sessions', json=body,
                           headers={'Origin': 'https://sophimotion.github.io'}).status_code == 403
        reserved = client.post('/api/foldbot/console/sessions', json=body)
        assert reserved.status_code == 200
        session = reserved.json()
        assert session['phase'] == 'reserved'
        assert session['ws_path'] == '/api/foldbot/console/ws'
        assert client.post('/api/foldbot/console/sessions', json=body).status_code == 409
        result = client.post('/api/foldbot/console/stop', json={'session_id': session['session_id']})
        assert result.status_code == 200
        events = client.get('/api/foldbot/console/events').json()
        assert events['physical_completion_verified'] is False
        assert session['session_id'] not in str(events)


def test_console_is_closed_even_if_simple_control_shutdown_fails(tmp_path):
    app = create_app(tmp_path)
    called = []

    async def broken_close():
        raise RuntimeError('simple close failed')

    async def console_close():
        called.append('console')

    app.state.foldbot_control.close = broken_close
    app.state.foldbot_console.close = console_close

    async def exercise():
        with pytest.raises(RuntimeError, match='simple close failed'):
            async with app.router.lifespan_context(app):
                pass
        assert called == ['console']

    asyncio.run(exercise())


def test_mounted_console_websocket_uses_fake_wire_and_closes_on_stop(tmp_path):
    from test_foldbot_console import Wire

    app = create_app(tmp_path)
    wire = Wire()

    async def fake_factory(url):
        return wire

    app.state.foldbot_console.factory = fake_factory
    with TestClient(app, base_url='http://127.0.0.1:8877') as client:
        token = client.post('/api/foldbot/console/sessions', json={
            'address': '192.168.4.1', 'confirmed': True,
        }).json()['session_id']
        assert wire.sent == []
        with client.websocket_connect('ws://127.0.0.1:8877/api/foldbot/console/ws',
                                      headers={'origin': 'http://127.0.0.1:8877'}) as websocket:
            websocket.send_json({'type': 'ae_auth', 'session_id': token})
            assert websocket.receive_json()['type'] == 'ae_ready'
            assert websocket.receive_json()['motionEnabled'] is False
            websocket.send_json({'type': 'motion_enable', 'enabled': True})
            while True:
                message = websocket.receive_json()
                if message['type'] == 'status' and message['motionEnabled']:
                    break
            websocket.send_json({'type': 'stop_all'})
            while True:
                message = websocket.receive_json()
                if message['type'] == 'ae_closed':
                    assert message['stop_result']['physical_stop_verified'] is False
                    break
        assert wire.closed
        assert wire.sent[-1]['type'] == 'stop'
