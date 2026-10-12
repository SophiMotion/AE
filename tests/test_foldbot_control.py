"""Offline admission and lease tests; the only device transport is an in-memory fake."""
import asyncio
import copy

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient


BUILD = 'foldbot-20260929-sophicar-external-driver-no-limits'


def firmware():
    axis = dict(position=0, target=0, travel=1200, travelValid=True, homed=True,
                active=False, driverEnabled=False, enableControl=True,
                directionInverted=False, pulseEngineReady=True, nvsReady=True,
                state='idle', error='')
    return dict(protocol='suzhou-foldbot-web-v1', rosControlVersion=1, firmwareBuild=BUILD,
                controlSession=19, statusSeq=1, uptimeMs=3000, externalArm=False,
                motionEnabled=False, estop=False, controlBusy=False, action='idle',
                foldAxisCount=2, stepper=copy.deepcopy(axis), stepper2=copy.deepcopy(axis),
                limits=dict(enabled=False, wiring='NC', fold1=False, unfold1=False,
                            fold2=False, unfold2=False, fault=''),
                homing=dict(active=False, axis=0, state='idle', error=''))


def project():
    return dict(id='project1', revision=1, reviewed=True, generation=dict(id='generation1', config={
        'local_control': dict(drive_level=10, drive_duration_ms=700,
                             modules=dict(chassis=True, fold=True, arm=True),
                             fold=dict(axes=2, manual_reference_required=True),
                             arm=dict(max_step_raw=8))}))


class FakeBackend:
    def __init__(self):
        self.frame = firmware()
        self.connected = self.enabled = False
        self.fresh = True
        self.calls = []
        self.connect_gate = None
        self.enable_gate = None
        self.stops = 0
        self.stopped = asyncio.Event()

    def status(self):
        return dict(connected=self.connected, enabled=self.enabled, fault=None,
                    fresh=self.fresh, frame_age_ms=0 if self.fresh else 1000,
                    firmware=copy.deepcopy(self.frame), physical_completion_verified=False)

    async def connect(self, url):
        self.calls.append(('connect', url))
        if self.connect_gate:
            await self.connect_gate.wait()
        self.connected = True
        return dict(ok=True, reason='connected_disabled', data={})

    async def enable(self):
        self.calls.append(('enable',))
        if self.enable_gate:
            await self.enable_gate.wait()
        self.enabled = self.frame['motionEnabled'] = True
        return dict(ok=True, reason='accepted', data={})

    async def drive(self, linear, turn, duration_ms):
        self.calls.append(('drive', linear, turn, duration_ms))
        return dict(ok=True, reason='scheduled_not_acknowledged', data={})

    async def fold(self, direction):
        self.calls.append(('fold', direction))
        return dict(ok=True, reason='accepted', data={})

    async def confirm_endpoint(self, endpoint, axis):
        self.calls.append(('confirm_endpoint', endpoint, axis))
        return dict(ok=True, reason='accepted', data={})

    async def arm_step(self, joint, direction):
        self.calls.append(('arm_step', joint, direction))
        return dict(ok=True, reason='accepted', data={})

    async def stop_and_disconnect(self):
        self.stops += 1
        self.stopped.set()
        self.connected = self.enabled = self.frame['motionEnabled'] = False
        return dict(ok=True, reason='stop_sent_connection_closed', physical_stop_verified=False)


def fixture_controller(**kwargs):
    from server.foldbot_control import FoldBotController
    backend = FakeBackend()
    current = project()
    def validate(project_id, revision):
        if project_id != current['id'] or revision != current['revision'] or not current['reviewed']:
            raise HTTPException(409, 'generation_not_current')
        return copy.deepcopy(current)
    controller = FoldBotController(validate, backend_factory=lambda: backend, **kwargs)
    return controller, backend, current


async def connected(controller):
    from server.foldbot_control import ConnectRequest
    answer = await controller.connect(ConnectRequest(project_id='project1', revision=1,
                                                       address='192.168.4.1', confirmed=True))
    for _ in range(10):
        await asyncio.sleep(0)
        if (await controller.status(answer['session_id']))['state']['phase'] == 'connected':
            return answer['session_id']
    raise AssertionError('fake connection did not become ready')


def command(token, seq, operation, **fields):
    from server.foldbot_control import COMMAND_ADAPTER
    return COMMAND_ADAPTER.validate_python(dict(session_id=token, seq=seq,
                                                 operation=operation, **fields))


def test_network_target_admission_is_private_literal_only():
    from server.foldbot_control import device_url
    assert device_url('192.168.4.1') == 'ws://192.168.4.1/ws'
    assert device_url('10.2.3.4') == 'ws://10.2.3.4/ws'
    for address in ('example.com', '127.0.0.1', '8.8.8.8', '169.254.1.2', '192.0.0.1',
                    'ws://192.168.4.1/ws', '192.168.4.1:80', '192.168.04.1',
                    '192.168.4.1/path', '192.168.4.1@evil.com', ' 192.168.4.1', '::1'):
        with pytest.raises(ValueError):
            device_url(address)


def test_controller_constructor_never_opens_transport():
    controller, backend, _ = fixture_controller()
    assert backend.calls == []
    assert controller is not None


def test_explicit_enable_and_strict_sequence_prevent_replay_and_enforce_project_caps():
    async def run():
        controller, backend, _ = fixture_controller()
        token = await connected(controller)
        try:
            with pytest.raises(HTTPException):
                await controller.command(command(token, 1, 'drive', linear=5, turn=0, duration_ms=300))
            await controller.command(command(token, 2, 'enable', confirmed=True))
            await controller.command(command(token, 3, 'drive', linear=10, turn=-10, duration_ms=700))
            with pytest.raises(HTTPException):
                await controller.command(command(token, 3, 'drive', linear=10, turn=0, duration_ms=700))
            with pytest.raises(HTTPException):
                await controller.command(command(token, 4, 'drive', linear=11, turn=0, duration_ms=700))
            with pytest.raises(HTTPException):
                await controller.command(command(token, 5, 'drive', linear=10, turn=0, duration_ms=701))
            assert [x for x in backend.calls if x[0] == 'drive'] == [('drive', 10, -10, 700)]
        finally:
            await controller.shutdown()
    asyncio.run(run())


@pytest.mark.parametrize('mutation', ['lease', 'revision', 'stale', 'generation'])
def test_independent_supervisor_revokes_without_browser_calls(mutation):
    async def run():
        now = [10.]
        controller, backend, current = fixture_controller(clock=lambda: now[0], monitor_interval=.005)
        token = await connected(controller)
        await controller.command(command(token, 1, 'enable', confirmed=True))
        if mutation == 'lease': now[0] = 13.
        if mutation == 'revision': current['revision'] = 2
        if mutation == 'generation': current['generation']['id'] = 'replacement'
        if mutation == 'stale': backend.fresh = False
        await asyncio.wait_for(backend.stopped.wait(), .4)
        try:
            assert backend.stops >= 1
            assert not backend.enabled
            with pytest.raises(HTTPException):
                await controller.heartbeat(token)
        finally:
            await controller.shutdown()
    asyncio.run(run())


def test_stop_preempts_pending_connect_and_prevents_late_connection():
    async def run():
        from server.foldbot_control import ConnectRequest
        controller, backend, _ = fixture_controller()
        backend.connect_gate = asyncio.Event()
        response = await controller.connect(ConnectRequest(project_id='project1', revision=1,
                                                            address='192.168.4.1', confirmed=True))
        await asyncio.sleep(0)
        stop = await asyncio.wait_for(controller.stop(response['session_id']), .2)
        backend.connect_gate.set()
        await asyncio.sleep(.01)
        assert not backend.connected
        assert not stop['physical_completion_verified']
        with pytest.raises(HTTPException):
            await controller.heartbeat(response['session_id'])
        await controller.shutdown()
    asyncio.run(run())


def test_stop_preempts_inflight_enable_and_cannot_be_undone_by_result():
    async def run():
        controller, backend, _ = fixture_controller()
        token = await connected(controller)
        backend.enable_gate = asyncio.Event()
        enable = asyncio.create_task(controller.command(command(token, 1, 'enable', confirmed=True)))
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        await asyncio.wait_for(controller.stop(token), .2)
        backend.enable_gate.set()
        result = await asyncio.gather(enable, return_exceptions=True)
        assert isinstance(result[0], HTTPException)
        assert not backend.enabled
        with pytest.raises(HTTPException):
            await controller.command(command(token, 2, 'enable', confirmed=True))
        await controller.shutdown()
    asyncio.run(run())


@pytest.mark.parametrize('bad', ['firmwareBuild', 'controlBusy', 'foldAxisCount', 'limits'])
def test_enable_requires_matching_live_disabled_firmware(bad):
    async def run():
        controller, backend, _ = fixture_controller()
        token = await connected(controller)
        backend.frame[bad] = {'firmwareBuild': 'old', 'controlBusy': True,
                              'foldAxisCount': 1, 'limits': dict(enabled=True)}[bad]
        try:
            with pytest.raises(HTTPException):
                await controller.command(command(token, 1, 'enable', confirmed=True))
            assert ('enable',) not in backend.calls
        finally:
            await controller.shutdown()
    asyncio.run(run())


def test_fold_requires_each_live_reference_and_manual_confirmation_is_explicit():
    async def run():
        controller, backend, _ = fixture_controller()
        token = await connected(controller)
        await controller.command(command(token, 1, 'enable', confirmed=True))
        backend.frame['stepper2']['homed'] = False
        try:
            with pytest.raises(HTTPException):
                await controller.command(command(token, 2, 'fold', direction='unfold'))
            await controller.command(command(token, 3, 'confirm_endpoint', axis=2,
                                             endpoint='folded', confirmed=True))
            assert ('confirm_endpoint', 'folded', 2) in backend.calls
            assert ('fold', 'unfold') not in backend.calls
        finally:
            await controller.shutdown()
    asyncio.run(run())


def test_router_rejects_public_origins_wrong_tokens_and_untyped_or_extra_commands():
    from server.foldbot_control import create_foldbot_router
    controller, backend, _ = fixture_controller()
    app = FastAPI()
    app.include_router(create_foldbot_router(controller))
    body = dict(project_id='project1', revision=1, address='192.168.4.1', confirmed=True)
    with TestClient(app, base_url='http://127.0.0.1:8000') as client:
        assert client.post('/api/foldbot/control/connect', json=body,
                           headers={'origin': 'https://evil.example'}).status_code == 403
        assert client.post('/api/foldbot/control/connect', json=body,
                           headers={'host': 'evil.example'}).status_code == 403
        for fields in [dict(operation='home'), dict(operation='drive', linear=True, turn=0, duration_ms=50),
                       dict(operation='arm_step', joint=1, direction=1, raw_units=50),
                       dict(operation='enable', confirmed=False),
                       dict(operation='confirm_endpoint', axis=1, endpoint='folded', confirmed=False)]:
            response = client.post('/api/foldbot/control/command', json=dict(session_id='wrongtoken', seq=1, **fields))
            assert response.status_code == 422
        assert client.post('/api/foldbot/control/status', json={'session_id': 'wrongtoken'}).status_code == 403
    assert backend.calls == []


def test_slow_approval_storage_cannot_block_stop_or_revive_a_pending_command():
    async def run():
        import threading
        controller, backend, _ = fixture_controller()
        token = await connected(controller)
        original = controller.require_current_generation
        entered, release = threading.Event(), threading.Event()
        def blocked_read(*args):
            entered.set()
            release.wait(.4)
            return original(*args)
        controller.require_current_generation = blocked_read
        pending = asyncio.create_task(controller.command(command(token, 1, 'enable', confirmed=True)))
        try:
            await asyncio.sleep(.02)
            assert entered.is_set()
            await asyncio.wait_for(controller.stop(token), .1)
            assert backend.stops >= 1
            assert ('enable',) not in backend.calls
        finally:
            release.set()
            result = await asyncio.gather(pending, return_exceptions=True)
            assert isinstance(result[0], HTTPException)
            await controller.shutdown()
    asyncio.run(run())


def test_zero_arm_direction_is_not_an_accepted_api_payload():
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        command('token', 1, 'arm_step', joint=1, direction=0)


def test_concurrent_connect_requests_only_admit_one_operator():
    async def run():
        from server.foldbot_control import ConnectRequest
        controller, backend, _ = fixture_controller()
        request = ConnectRequest(project_id='project1', revision=1, address='192.168.4.1', confirmed=True)
        answers = await asyncio.gather(controller.connect(request), controller.connect(request), return_exceptions=True)
        assert sum(isinstance(x, dict) and x.get('ok') is True for x in answers) == 1
        assert sum(isinstance(x, HTTPException) and x.status_code == 409 for x in answers) == 1
        await controller.shutdown()
        assert sum(x[0] == 'connect' for x in backend.calls) <= 1
    asyncio.run(run())


def test_heartbeat_cannot_renew_lease_that_expired_during_approval_read():
    async def run():
        import threading
        now = [10.]
        controller, backend, _ = fixture_controller(clock=lambda: now[0])
        token = await connected(controller)
        original = controller.require_current_generation
        entered, release = threading.Event(), threading.Event()
        def delayed_read(*args):
            entered.set()
            release.wait(.2)
            return original(*args)
        controller.require_current_generation = delayed_read
        heartbeat = asyncio.create_task(controller.heartbeat(token))
        for _ in range(10):
            if entered.is_set(): break
            await asyncio.sleep(.002)
        now[0] = 13.
        release.set()
        with pytest.raises(HTTPException):
            await heartbeat
        assert backend.stops >= 1
        await controller.shutdown()
    asyncio.run(run())


class MemoryWire:
    """Protocol peer, without sockets: ACK correlation and live status are exercised."""
    def __init__(self):
        self.queue = asyncio.Queue()
        self.sent = []
        self.closed = False
        self.seq = 0
        self.ack_enable = True
        self.frame = firmware()
        self.frame.update(armProtocol=1, armStepRangeGuard=True, applied_jog_seq=0, jog_step_seq=0,
                          jog_step_status='idle', joints=[dict(id=i, position=100, position_seq=1,
                          min=0, max=1000, online=True, available=True, fault='none',
                          position_valid=True, stale=False, direction=0) for i in range(1, 7)])

    async def snapshot(self):
        import json
        self.seq += 1
        await self.queue.put(json.dumps(dict(self.frame, type='status', statusSeq=self.seq)))

    async def send(self, raw):
        import json
        frame = json.loads(raw)
        self.sent.append(frame)
        kind = frame['type']
        if kind in ('drive', 'drive_stop'):
            return
        if kind == 'heartbeat':
            await self.snapshot()
            return
        if kind == 'motion_enable':
            if not self.ack_enable:
                return
            self.frame['motionEnabled'] = frame['enabled']
        if kind == 'stop':
            self.frame['motionEnabled'] = False
        if kind == 'jog_step':
            self.frame.update(jog_step_seq=frame['seq'], jog_step_status='applied')
        await self.queue.put(json.dumps(dict(type='ack', command=frame.get('name', kind), ok=True)))
        await self.snapshot()

    async def recv(self):
        return await self.queue.get()

    async def close(self):
        self.closed = True


def wire_backend(wire, **kwargs):
    from server.foldbot_esp import ESPBackend
    async def factory(url):
        assert url == 'ws://192.168.4.1/ws'
        return wire
    return ESPBackend(transport_factory=factory, **kwargs)


def test_real_protocol_keeps_initialization_explicit_and_rejects_build_before_power_setting():
    async def run():
        wire = MemoryWire()
        backend = wire_backend(wire)
        assert wire.sent == []
        assert (await backend.connect('ws://192.168.4.1/ws'))['ok']
        assert {'type': 'drive_speed', 'percent': 30} in wire.sent
        assert not any(x['type'] == 'motion_enable' for x in wire.sent)
        await backend.stop_and_disconnect()
        wrong_wire = MemoryWire()
        wrong_wire.frame['firmwareBuild'] = 'unknown-build'
        wrong = wire_backend(wrong_wire)
        assert not (await wrong.connect('ws://192.168.4.1/ws'))['ok']
        assert wrong_wire.closed
        assert not any(x['type'] == 'drive_speed' for x in wrong_wire.sent)
    asyncio.run(run())


def test_real_protocol_wrong_ack_is_ignored_and_stop_preempts_ack_wait():
    async def run():
        import json
        wire = MemoryWire()
        backend = wire_backend(wire)
        await backend.connect('ws://192.168.4.1/ws')
        wire.ack_enable = False
        enable = asyncio.create_task(backend.enable())
        await asyncio.sleep(.01)
        await wire.queue.put(json.dumps(dict(type='ack', command='drive_speed', ok=True)))
        await asyncio.sleep(.01)
        assert not enable.done()
        busy = await backend._command({'type': 'motion_enable', 'enabled': True}, 'motion_enable')
        assert not busy['ok']
        await asyncio.wait_for(backend.stop_and_disconnect(), .2)
        response = await enable
        assert not response['ok']
        assert wire.closed and not backend.enabled
        assert sum(x['type'] == 'motion_enable' for x in wire.sent) == 1
    asyncio.run(run())


@pytest.mark.parametrize('failure', ['stale', 'duplicate_status', 'firmware_reboot'])
def test_real_protocol_status_failure_independently_stops_transport(failure):
    async def run():
        import json
        now = [10.]
        wire = MemoryWire()
        backend = wire_backend(wire, clock=lambda: now[0])
        await backend.connect('ws://192.168.4.1/ws')
        await backend.enable()
        if failure == 'stale':
            now[0] = 11.
        elif failure == 'duplicate_status':
            await wire.queue.put(json.dumps(copy.deepcopy(backend.snapshot)))
        else:
            wire.frame['controlSession'] += 1
            await wire.snapshot()
        await asyncio.sleep(.08)
        assert wire.closed
        assert not backend.enabled
        assert any(x['type'] == 'stop' for x in wire.sent)
    asyncio.run(run())


def test_real_protocol_arm_step_uses_raw_eight_units_and_blocks_until_followup():
    async def run():
        wire = MemoryWire()
        backend = wire_backend(wire)
        await backend.connect('ws://192.168.4.1/ws')
        await backend.enable()
        response = await backend.arm_step(3, -1)
        assert response['ok'] and response['data']['firmware_step_raw_units'] == 8
        assert not response['data']['physical_completion_verified']
        assert {'type': 'jog_step', 'seq': 1, 'dir': [0, 0, -1, 0, 0, 0]} in wire.sent
        assert not (await backend.arm_step(2, 1))['ok']
        assert not (await backend.fold('fold'))['ok']
        assert not (await backend.drive(1, 0, 100))['ok']
        await backend.stop_and_disconnect()
    asyncio.run(run())


def test_real_stop_reports_transport_failure_without_claiming_sent_or_closed():
    async def run():
        from server.foldbot_esp import ESPBackend
        class BrokenWire:
            async def send(self, raw):
                raise ConnectionError('transport lost')
            async def close(self):
                raise ConnectionError('close failed')
        backend = ESPBackend()
        backend.ws = BrokenWire()
        response = await backend.stop_and_disconnect()
        assert not response['ok']
        assert response['data']['stop_command_sent'] is False
        assert response['data']['transport_closed'] is False
        assert response['data']['physical_stop_verified'] is False
        assert 'uncertain' in response['reason']
    asyncio.run(run())
