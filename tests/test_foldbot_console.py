"""Original-console protocol tests use memory queues only, never network or robots."""
import asyncio
import copy
import json

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from test_foldbot_control import firmware, fixture_controller, connected


class Browser:
    def __init__(self):
        self.input = asyncio.Queue()
        self.output = asyncio.Queue()
        self.closed = False
        self.headers = {'host': '127.0.0.1:8877', 'origin': 'http://127.0.0.1:8877'}

    async def accept(self):
        pass

    async def receive_text(self):
        item = await self.input.get()
        if item is None:
            raise WebSocketDisconnect()
        return item

    async def send_json(self, frame):
        await self.output.put(copy.deepcopy(frame))

    async def close(self, code=1000):
        self.closed = True

    async def send(self, frame):
        await self.input.put(json.dumps(frame))

    async def until(self, kind):
        async def wait():
            while True:
                frame = await self.output.get()
                if frame.get('type') == kind:
                    return frame
        return await asyncio.wait_for(wait(), 1.)


class Wire:
    def __init__(self):
        self.frame = firmware()
        self.frame.update(armProtocol=1, armStepRangeGuard=True, applied_jog_seq=0,
                          jog_step_seq=0, drivePowerPercent=60)
        self.frames = asyncio.Queue()
        self.sent = []
        self.closed = False
        self.seq = 0
        self.send_gate = None
        self.block_type = None

    async def snapshot(self):
        self.seq += 1
        await self.frames.put(json.dumps(dict(self.frame, type='status', statusSeq=self.seq)))

    async def send(self, raw):
        frame = json.loads(raw)
        if frame['type'] == self.block_type and self.send_gate:
            await self.send_gate.wait()
        self.sent.append(frame)
        if frame['type'] == 'motion_enable':
            self.frame['motionEnabled'] = frame['enabled']
        if frame['type'] in ('hello', 'status_request', 'heartbeat', 'motion_enable'):
            await self.snapshot()

    async def recv(self):
        return await self.frames.get()

    async def close(self):
        self.closed = True


def bridge_fixture(**options):
    from server.foldbot_console import FoldBotConsoleBridge
    wire, calls = Wire(), []
    async def factory(url):
        calls.append(url)
        return wire
    bridge = FoldBotConsoleBridge(transport_factory=factory, **options)
    return bridge, wire, calls


async def reserve(bridge):
    from server.foldbot_console import ConsoleSessionRequest
    return await bridge.create_session(ConsoleSessionRequest(address='192.168.4.1', confirmed=True))


async def attach(bridge):
    info = await reserve(bridge)
    browser = Browser()
    await browser.send({'type': 'ae_auth', 'session_id': info['session_id']})
    task = asyncio.create_task(bridge.run_socket(browser))
    await browser.until('ae_ready')
    await browser.until('status')
    return info, browser, task


async def enable(browser):
    await browser.send({'type': 'motion_enable', 'enabled': True})
    for _ in range(6):
        state = await browser.until('status')
        if state['motionEnabled']:
            return
    raise AssertionError('enable status not observed')


def test_reservation_performs_no_io_and_only_one_console_can_reserve():
    async def run():
        bridge, wire, calls = bridge_fixture()
        info = await reserve(bridge)
        assert info['phase'] == 'reserved' and info['lease_ms'] == 2000
        assert calls == [] and wire.sent == []
        with pytest.raises(HTTPException):
            await reserve(bridge)
        stop = await bridge.stop(info['session_id'])
        assert stop['stop_result']['connection_was_open'] is False
        assert stop['physical_stop_verified'] is False
        await bridge.close()
    asyncio.run(run())


def test_first_handshake_is_read_only_and_consumed_token_cannot_reconnect():
    async def run():
        bridge, wire, calls = bridge_fixture()
        info, browser, task = await attach(bridge)
        try:
            assert calls == ['ws://192.168.4.1/ws']
            assert {x['type'] for x in wire.sent} <= {'hello', 'status_request'}
            assert wire.frame['drivePowerPercent'] == 60
            await bridge.stop(info['session_id'])
            again = Browser()
            await again.send({'type': 'ae_auth', 'session_id': info['session_id']})
            await bridge.run_socket(again)
            assert (await again.until('ae_error'))['reason']
            assert len(calls) == 1
        finally:
            await bridge.close()
            await asyncio.gather(task, return_exceptions=True)
    asyncio.run(run())


@pytest.mark.parametrize('change', [{'firmwareBuild': 'other'}, {'motionEnabled': True},
                                   {'controlBusy': True}, {'action': 'torso_fold'}])
def test_invalid_first_state_never_reaches_ready_or_sends_motion(change):
    async def run():
        bridge, wire, _ = bridge_fixture()
        wire.frame.update(change)
        info = await reserve(bridge)
        browser = Browser()
        await browser.send({'type': 'ae_auth', 'session_id': info['session_id']})
        await asyncio.wait_for(bridge.run_socket(browser), 1.)
        replies = []
        while not browser.output.empty(): replies.append(browser.output.get_nowait())
        assert not any(x['type'] == 'ae_ready' for x in replies)
        assert wire.closed
        assert {x['type'] for x in wire.sent} <= {'hello', 'status_request', 'stop'}
        await bridge.close()
    asyncio.run(run())


def test_simple_and_full_console_share_reservation_until_cleanup_finishes():
    async def run():
        from server.foldbot_arbiter import FoldBotArbiter
        arbiter = FoldBotArbiter()
        controller, backend, _ = fixture_controller(arbiter=arbiter)
        bridge, wire, calls = bridge_fixture(arbiter=arbiter)
        token = await connected(controller)
        with pytest.raises(HTTPException):
            await reserve(bridge)
        assert calls == []
        await controller.stop(token)
        info = await reserve(bridge)
        with pytest.raises(HTTPException):
            await connected(controller)
        await bridge.stop(info['session_id'])
        await connected(controller)
        await controller.close()
        await bridge.close()
    asyncio.run(run())


def test_full_ranges_and_maintenance_confirmation_are_preserved_and_stripped():
    async def run():
        bridge, wire, _ = bridge_fixture()
        info, browser, task = await attach(bridge)
        await enable(browser)
        await browser.send({'type': 'drive', 'linear': 100, 'turn': -100})
        await browser.send({'type': 'drive_speed', 'percent': 100})
        await browser.send({'type': 'stepper_save', 'axis': 2})
        assert (await browser.until('ae_error'))['reason'] == 'maintenance_confirmation_required'
        await browser.send({'type': 'stepper_save', 'axis': 2, 'ae_confirmed': True})
        await asyncio.sleep(.04)
        assert {'type': 'drive', 'linear': 100, 'turn': -100} in wire.sent
        assert {'type': 'drive_speed', 'percent': 100} in wire.sent
        assert [x for x in wire.sent if x['type'] == 'stepper_save'] == [{'type': 'stepper_save', 'axis': 2}]
        await bridge.stop(info['session_id'])
        await bridge.close()
        await asyncio.gather(task, return_exceptions=True)
    asyncio.run(run())


@pytest.mark.parametrize('frame', [
    {'type': 'fold_home'}, {'type': 'arm_external', 'enabled': True},
    {'type': 'action', 'name': 'base_forward'}, {'type': 'drive', 'linear': True, 'turn': 0},
    {'type': 'drive', 'linear': 101, 'turn': 0}, {'type': 'drive_speed', 'percent': 50},
    {'type': 'stepper_jog', 'axis': 3, 'steps': 20}, {'type': 'stepper_jog', 'axis': 1, 'steps': 2001},
    {'type': 'jog_step', 'seq': 1, 'dir': [1, 1, 0, 0, 0, 0]},
    {'type': 'jog_state', 'seq': 0, 'dir': [0, 0, 0, 0, 0, 0]},
    {'type': 'heartbeat', 'extra': True}, {'type': 'pose_capture', 'name': 'unknown', 'ae_confirmed': True},
    {'type': 'stepper_confirm_unfolded', 'axis': 1, 'confirmed': 1},
    {'type': 'stepper_direction', 'axis': 1, 'ae_confirmed': 1},
])
def test_protocol_whitelist_is_strict(frame):
    from server.foldbot_console import validate_frame
    with pytest.raises(ValueError):
        validate_frame(json.dumps(frame))


def test_large_or_nonfinite_protocol_frames_are_rejected():
    from server.foldbot_console import validate_frame
    for raw in (' ' * 513, '{"type":"drive","linear":NaN,"turn":0}',
                '{"type":"heartbeat","type":"drive"}'):
        with pytest.raises(ValueError): validate_frame(raw)


@pytest.mark.parametrize('lost', ['heartbeat', 'status', 'browser'])
def test_loss_revokes_and_server_never_generates_heartbeat(lost):
    async def run():
        now = [10.]
        bridge, wire, _ = bridge_fixture(clock=lambda: now[0])
        info, browser, task = await attach(bridge)
        if lost == 'browser':
            await browser.input.put(None)
        elif lost == 'status':
            now[0] += .6
            await browser.send({'type': 'heartbeat'})
        else:
            now[0] += 2.1
            await wire.snapshot()
        closed = await browser.until('ae_closed')
        assert not closed['stop_result']['physical_stop_verified']
        assert wire.closed
        if lost != 'status':
            assert not any(x['type'] == 'heartbeat' for x in wire.sent)
        await bridge.close()
        await asyncio.gather(task, return_exceptions=True)
    asyncio.run(run())


def test_stop_discards_pending_stream_frames_and_does_not_wait_for_ack():
    async def run():
        bridge, wire, _ = bridge_fixture()
        info, browser, task = await attach(bridge)
        await enable(browser)
        wire.block_type, wire.send_gate = 'drive', asyncio.Event()
        await browser.send({'type': 'drive', 'linear': 10, 'turn': 0})
        await asyncio.sleep(.01)
        for value in range(11, 20):
            await browser.send({'type': 'drive', 'linear': value, 'turn': 0})
        await browser.send({'type': 'stop_all', 'seq': 1})
        await browser.until('ae_closed')
        wire.send_gate.set()
        await asyncio.sleep(.01)
        assert wire.closed
        assert not any(x['type'] == 'drive' for x in wire.sent)
        assert wire.sent[-1]['type'] == 'stop'
        await bridge.close()
        await asyncio.gather(task, return_exceptions=True)
    asyncio.run(run())


def test_apis_reject_public_origin_missing_confirmation_and_bad_address():
    from server.foldbot_console import create_foldbot_console_router
    bridge, wire, calls = bridge_fixture()
    app = FastAPI()
    app.include_router(create_foldbot_console_router(bridge))
    with TestClient(app, base_url='http://127.0.0.1:8877') as client:
        for body in ({'address': '192.168.4.1', 'confirmed': False},
                     {'address': '8.8.8.8', 'confirmed': True},
                     {'address': 'localhost', 'confirmed': True}):
            assert client.post('/api/foldbot/console/sessions', json=body).status_code == 422
        assert client.post('/api/foldbot/console/sessions', json={'address': '192.168.4.1', 'confirmed': True},
                           headers={'origin': 'https://evil.example'}).status_code == 403
    assert calls == [] and wire.sent == []


def test_original_short_tap_is_not_overtaken_by_following_zero_jog_state():
    async def run():
        bridge, wire, _ = bridge_fixture()
        info, browser, task = await attach(bridge)
        await enable(browser)
        await browser.send({'type': 'jog_step', 'seq': 1, 'dir': [1, 0, 0, 0, 0, 0]})
        await browser.send({'type': 'jog_state', 'seq': 2, 'dir': [0, 0, 0, 0, 0, 0]})
        await asyncio.sleep(.04)
        arm = [x for x in wire.sent if x['type'] in ('jog_step', 'jog_state')]
        assert [x['seq'] for x in arm] == [1, 2]
        await bridge.stop(info['session_id'])
        await bridge.close()
        await asyncio.gather(task, return_exceptions=True)
    asyncio.run(run())


def test_late_factory_keeps_owner_until_late_socket_is_closed():
    async def run():
        from server.foldbot_arbiter import FoldBotArbiter
        from server.foldbot_console import FoldBotConsoleBridge
        arbiter, wire = FoldBotArbiter(), Wire()
        entered, cancelled, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
        async def late_factory(url):
            entered.set()
            try:
                await release.wait()
            except asyncio.CancelledError:
                cancelled.set()
                await release.wait()
            return wire
        bridge = FoldBotConsoleBridge(arbiter=arbiter, transport_factory=late_factory)
        info = await reserve(bridge)
        browser = Browser()
        await browser.send({'type': 'ae_auth', 'session_id': info['session_id']})
        task = asyncio.create_task(bridge.run_socket(browser))
        await entered.wait()
        stop = await bridge.stop(info['session_id'])
        assert cancelled.is_set()
        assert arbiter.status()['occupied']
        assert stop['stop_result']['transport_closed'] is None
        with pytest.raises(HTTPException):
            await reserve(bridge)
        release.set()
        for _ in range(50):
            if not arbiter.status()['occupied']: break
            await asyncio.sleep(.01)
        assert wire.closed
        assert not arbiter.status()['occupied']
        await bridge.close()
        await asyncio.gather(task, return_exceptions=True)
    asyncio.run(run())


@pytest.mark.parametrize('close_succeeds', [True, False])
def test_stop_between_factory_return_and_outer_adoption_still_closes_socket(close_succeeds):
    async def run():
        from server.foldbot_console import FoldBotConsoleBridge
        wire = Wire()
        if not close_succeeds:
            async def failed_close():
                raise ConnectionError('close failed')
            wire.close = failed_close
        stops = []
        async def factory(url):
            stops.append(asyncio.create_task(bridge.stop(info['session_id'])))
            return wire
        bridge = FoldBotConsoleBridge(transport_factory=factory)
        info = await reserve(bridge)
        browser = Browser()
        await browser.send({'type': 'ae_auth', 'session_id': info['session_id']})
        task = asyncio.create_task(bridge.run_socket(browser))
        await browser.until('ae_closed')
        await asyncio.gather(task, *stops, return_exceptions=True)
        assert wire.closed is close_succeeds
        assert bridge.arbiter.status()['occupied'] is (not close_succeeds)
        await bridge.close()
    asyncio.run(run())
