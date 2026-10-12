"""Leased local relay for the original console. No I/O before explicit WS auth.

The original protocol is checked, not translated into simplified jog commands.
Only browser heartbeat frames renew the lease; no server heartbeat is generated.
All socket operations are injected in tests. STOP revokes before awaiting any I/O.
"""
from __future__ import annotations

import asyncio
import copy
import json
import secrets
import time
from collections import OrderedDict, deque
from dataclasses import dataclass, field
from typing import Annotated
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, WebSocket
from pydantic import Field, StrictStr
from starlette.websockets import WebSocketDisconnect

from .foldbot_arbiter import FoldBotArbiter
from .foldbot_control import Confirmed, SessionRequest, StrictRequest, _local_request, device_url, FoldBotController
from .foldbot_esp import ESPBackend


class ConsoleSessionRequest(StrictRequest):
    address: Annotated[StrictStr, Field(min_length=1, max_length=32)]
    confirmed: Confirmed


MAINTENANCE = frozenset(('stepper_save', 'stepper_reset', 'stepper_direction', 'pose_capture', 'arm_path_confirm'))
POSES = frozenset(('arm_initial', 'arm_raised', 'arm_left', 'arm_right', 'gripper_open'))
ACTIONS = frozenset(('torso_fold', 'torso_unfold', 'showcase_demo'))


def _object_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate_json_key')
        result[key] = value
    return result


def _decode(raw, limit=512):
    if not isinstance(raw, str) or len(raw.encode('utf-8')) > limit:
        raise ValueError('frame_too_large')
    def nonfinite(value):
        raise ValueError('nonfinite_json_number')
    value = json.loads(raw, object_pairs_hook=_object_pairs, parse_constant=nonfinite)
    if type(value) is not dict:
        raise ValueError('object_frame_required')
    return value


def validate_frame(raw):
    """Reject unknown fields/types, then remove proxy-only maintenance consent."""
    frame = _decode(raw)
    kind = frame.get('type')
    if type(kind) is not str:
        raise ValueError('command_type_required')
    fields = {
        'hello': {'version'}, 'heartbeat': set(), 'status_request': set(),
        'motion_enable': {'enabled'}, 'drive_speed': {'percent'}, 'drive': {'linear', 'turn'},
        'drive_stop': set(), 'stop': set(), 'stop_all': set(),
        'jog_step': {'seq', 'dir'}, 'jog_state': {'seq', 'dir'}, 'action': {'name'},
        'stepper_zero': {'axis'}, 'stepper_confirm_unfolded': {'axis', 'confirmed'},
        'stepper_jog': {'axis', 'steps'}, 'stepper_save': {'axis'}, 'stepper_reset': {'axis'},
        'stepper_direction': {'axis'}, 'stepper_rescan': {'axis'},
        'pose_capture': {'name'}, 'arm_path_confirm': set(),
    }
    if kind not in fields:
        raise ValueError('unsupported_command')
    required = fields[kind] | {'type'}
    optional = {'seq'} if kind in ('stop', 'stop_all') else set()
    if kind in MAINTENANCE:
        optional.add('ae_confirmed')
    if not required.issubset(frame) or set(frame) - required - optional:
        raise ValueError('invalid_command_fields')
    if kind in MAINTENANCE:
        if frame.pop('ae_confirmed', None) is not True:
            raise ValueError('maintenance_confirmation_required')
    def integer(name, lower, upper):
        return type(frame.get(name)) is int and lower <= frame[name] <= upper
    valid = True
    if kind == 'hello': valid = integer('version', 1, 1)
    if kind == 'motion_enable': valid = type(frame['enabled']) is bool
    if kind == 'drive_speed': valid = type(frame['percent']) is int and frame['percent'] in (30, 60, 100)
    if kind == 'drive': valid = integer('linear', -100, 100) and integer('turn', -100, 100)
    if kind.startswith('stepper_'): valid = integer('axis', 1, 2)
    if kind == 'stepper_confirm_unfolded': valid = valid and frame['confirmed'] is True
    if kind == 'stepper_jog': valid = valid and integer('steps', -2000, 2000) and frame['steps'] != 0
    if kind == 'action': valid = type(frame['name']) is str and frame['name'] in ACTIONS
    if kind == 'pose_capture': valid = type(frame['name']) is str and frame['name'] in POSES
    if kind in ('jog_step', 'jog_state'):
        directions = frame['dir']
        valid = (integer('seq', 1, 2147483647) and type(directions) is list and len(directions) == 6 and
                 all(type(x) is int and x in (-1, 0, 1) for x in directions))
        if valid and kind == 'jog_step': valid = sum(x != 0 for x in directions) == 1
    if kind in ('stop', 'stop_all') and 'seq' in frame: valid = integer('seq', 1, 2147483647)
    if not valid:
        raise ValueError('invalid_command_values')
    return frame


@dataclass
class _ConsoleSession:
    token: str
    url: str
    expires: float
    phase: str = 'reserved'
    reason: str = 'reserved'
    consumed: bool = False
    socket: object = None
    browser: object = None
    received: float | None = None
    validator: ESPBackend = field(default_factory=ESPBackend)
    last_arm_sequence: int = 0
    last_sent_arm_sequence: int = 0
    pending: deque = field(default_factory=deque)
    latest: dict = field(default_factory=dict)
    urgent: dict = field(default_factory=dict)
    wake: asyncio.Event = field(default_factory=asyncio.Event)
    tasks: set = field(default_factory=set)
    cleanup: asyncio.Task | None = None
    connect_task: asyncio.Task | None = None
    draining: asyncio.Task | None = None
    late_socket_closed: bool = True
    stop_result: dict | None = None


class FoldBotConsoleBridge:
    def __init__(self, *, arbiter=None, on_event=None, transport_factory=None, clock=time.monotonic):
        self.arbiter = arbiter if arbiter is not None else FoldBotArbiter()
        self.on_event, self.clock = on_event, clock
        self.factory = transport_factory or ESPBackend._open
        self.active = None
        self.retired = OrderedDict()
        self.closing = False
        self.event_tasks = set()

    def _event(self, session, operation, reason):
        if self.on_event is None:
            return
        event = dict(mode='console', capability_profile='original_console_v1', operation=operation,
                     reason=reason, time_ms=int(time.time() * 1000), physical_completion_verified=False)
        async def persist():
            try:
                await asyncio.wait_for(asyncio.to_thread(self.on_event, event), .25)
            except Exception:
                pass
        task = asyncio.create_task(persist())
        self.event_tasks.add(task)
        task.add_done_callback(self.event_tasks.discard)

    def _task(self, session, coroutine):
        task = asyncio.create_task(coroutine)
        session.tasks.add(task)
        task.add_done_callback(session.tasks.discard)
        return task

    def _invalid(self, session):
        if self.active is not session or not self.arbiter.owns(session.token):
            return 'session_revoked'
        if self.clock() >= session.expires:
            return 'attach_timeout' if session.phase == 'reserved' else 'browser_lease_expired'
        if session.phase == 'connected' and (session.received is None or self.clock() - session.received > .5):
            return 'device_status_stale'
        return None

    async def create_session(self, request: ConsoleSessionRequest):
        try:
            url = device_url(request.address)
        except ValueError as error:
            raise HTTPException(422, str(error)) from None
        if self.closing:
            raise HTTPException(409, 'console_bridge_shutting_down')
        token = secrets.token_urlsafe(32)
        if not self.arbiter.reserve(token, 'console'):
            raise HTTPException(409, 'single_operator_session_busy')
        session = _ConsoleSession(token, url, self.clock() + 2.)
        self.active = session
        self._task(session, self._monitor(session))
        self._event(session, 'reserve', 'reserved_no_device_io')
        return dict(ok=True, session_id=token, ws_path='/api/foldbot/console/ws', lease_ms=2000,
                    attach_timeout_ms=2000, phase='reserved', capability_profile='original_console_v1')

    async def _browser_send(self, browser, frame):
        await asyncio.wait_for(browser.send_json(frame), .2)

    async def run_socket(self, browser):
        session = None
        try:
            await _local_request(browser)
            origin = urlsplit(browser.headers.get('origin', ''))
            host = urlsplit('http://' + browser.headers.get('host', ''))
            expected_scheme = 'https' if getattr(browser, 'scope', {}).get('scheme') == 'wss' else 'http'
            if (origin.scheme != expected_scheme or not origin.hostname or
                    origin.hostname != host.hostname or origin.port != host.port):
                raise HTTPException(403, 'same_origin_websocket_required')
            await browser.accept()
            auth = _decode(await asyncio.wait_for(browser.receive_text(), 1.))
            if set(auth) != {'type', 'session_id'} or auth.get('type') != 'ae_auth' or type(auth.get('session_id')) is not str:
                raise ValueError('first_frame_authentication_required')
            candidate = self.active
            if (candidate is None or not secrets.compare_digest(candidate.token, auth['session_id']) or
                    candidate.consumed or self._invalid(candidate)):
                raise ValueError('invalid_expired_or_consumed_session')
            session = candidate
            session.consumed, session.browser, session.phase = True, browser, 'connecting'
            session.expires = self.clock() + 3.
            session.tasks.add(asyncio.current_task())
            session.connect_task = self._task(session, self._connect(session))
            while self.active is session:
                raw = await browser.receive_text()
                reason = self._invalid(session)
                if reason:
                    await self._revoke(session, reason)
                    break
                try:
                    frame = validate_frame(raw)
                    await self._receive_command(session, frame)
                except ValueError as error:
                    await self._browser_send(browser, dict(type='ae_error', reason=str(error)))
        except asyncio.CancelledError:
            pass
        except (WebSocketDisconnect, ConnectionError):
            pass
        except Exception as error:
            if session is None:
                try:
                    await self._browser_send(browser, dict(type='ae_error', reason=(str(error.detail) if isinstance(error, HTTPException) else str(error))))
                except Exception:
                    pass
        finally:
            if session is not None:
                await self._revoke(session, 'browser_disconnected')
                session.tasks.discard(asyncio.current_task())
            else:
                try:
                    await browser.close(code=1008)
                except Exception:
                    pass

    async def _connect(self, session):
        async def open_owned_socket():
            socket = await self.factory(session.url)
            # A cancelled transport factory may finish late. Never leak or adopt it.
            if self.active is not session:
                session.late_socket_closed = False
                await asyncio.wait_for(socket.close(), .4)
                session.late_socket_closed = True
                return None
            # Register ownership before returning across wait_for's scheduling
            # boundary; cancellation must not discard an unowned live socket.
            session.socket = socket
            return socket
        try:
            socket = await asyncio.wait_for(open_owned_socket(), 2.5)
            if socket is None:
                return
            if self.active is not session:
                return
            self._task(session, self._read_device(session))
            # Read-only handshake. In particular, never initialize a power selector.
            await asyncio.wait_for(socket.send('{"type":"hello","version":1}'), .1)
            if self.active is not session:
                return
            await asyncio.wait_for(socket.send('{"type":"status_request"}'), .1)
            if self.active is session:
                self._task(session, self._write_device(session))
        except asyncio.CancelledError:
            raise
        except Exception:
            await self._revoke(session, 'connection_outcome_unknown_do_not_retry')

    async def _read_device(self, session):
        try:
            while self.active is session:
                frame = _decode(await session.socket.recv(), 65536)
                invalid = self._invalid(session)
                if invalid:
                    await self._revoke(session, invalid)
                    return
                kind = frame.get('type')
                if kind == 'status':
                    session.validator._validate_status(frame)
                    error = FoldBotController._firmware_error({'firmware': frame})
                    if error:
                        raise ValueError(error)
                    initial = session.phase == 'connecting'
                    if initial and (frame['motionEnabled'] is not False or FoldBotController._busy(frame)):
                        raise ValueError('initial_status_must_be_disabled_and_idle')
                    session.validator.snapshot = copy.deepcopy(frame)
                    session.received = self.clock()
                    if initial:
                        session.phase, session.reason = 'connected', 'connected_disabled'
                        session.expires = self.clock() + 2.
                        await self._browser_send(session.browser, dict(type='ae_ready', lease_ms=2000,
                                                    capability_profile='original_console_v1', physical_completion_verified=False))
                        self._event(session, 'connect', 'first_status_verified_disabled_idle')
                elif kind not in ('ack', 'error'):
                    raise ValueError('unsupported_device_frame')
                elif kind == 'ack':
                    if type(frame.get('command')) is not str or type(frame.get('ok')) is not bool:
                        raise ValueError('malformed_device_ack')
                    self._event(session, 'ack:' + frame['command'][:64],
                                ('accepted:' if frame['ok'] else 'rejected:') + str(frame.get('message', ''))[:120])
                if self.active is session:
                    await self._browser_send(session.browser, frame)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            await self._revoke(session, 'device_stream_failed:' + type(error).__name__ + ':' + str(error)[:120])

    async def _receive_command(self, session, frame):
        kind = frame['type']
        if kind in ('stop', 'stop_all') or (kind == 'motion_enable' and frame['enabled'] is False):
            await self._revoke(session, 'operator_stopped')
            return
        if session.phase != 'connected':
            raise ValueError('first_status_validation_pending')
        state = session.validator.snapshot
        if kind == 'heartbeat':
            session.expires = self.clock() + 2.
        safety = kind == 'drive_stop' or (kind == 'jog_state' and not any(frame['dir']))
        if kind not in ('hello', 'heartbeat', 'status_request', 'drive_speed', 'motion_enable') and not safety:
            if state['motionEnabled'] is not True:
                raise ValueError('motion_disabled')
        if kind == 'motion_enable' and FoldBotController._busy(state):
            raise ValueError('enable_requires_idle_firmware')
        if kind in ('jog_state', 'jog_step'):
            if frame['seq'] <= session.last_arm_sequence:
                raise ValueError('stale_arm_sequence')
            session.last_arm_sequence = frame['seq']
        item = (frame, self.clock())
        if kind == 'drive_stop':
            session.latest.pop('drive', None)
            session.urgent['drive_stop'] = item
        elif kind == 'jog_state' and not any(frame['dir']):
            session.latest.pop('jog_state', None)
            session.urgent['jog_state'] = item
        elif kind == 'heartbeat':
            session.urgent['heartbeat'] = item
        elif kind in ('drive', 'jog_state'):
            session.latest[kind] = item
        else:
            if len(session.pending) >= 4:
                raise ValueError('discrete_command_queue_full')
            session.pending.append(item)
            if kind not in ('hello', 'status_request'):
                self._event(session, kind, 'requested_not_physically_verified')
        session.wake.set()

    async def _write_device(self, session):
        try:
            while self.active is session:
                session.wake.clear()
                if session.urgent:
                    key = next(iter(session.urgent))
                    frame, received = session.urgent[key]
                    # The original tap sends jog_step(N) then zero jog_state(N+1).
                    # Sending zero first would make firmware reject the tap as old.
                    preceding_tap = next((item for item in session.pending if key == 'jog_state' and
                                          item[0]['type'] == 'jog_step' and item[0]['seq'] < frame['seq']), None)
                    if preceding_tap is not None:
                        session.pending.remove(preceding_tap)
                        frame, received = preceding_tap
                    else:
                        session.urgent.pop(key)
                elif session.pending:
                    frame, received = session.pending.popleft()
                elif session.latest:
                    key = next(iter(session.latest))
                    frame, received = session.latest.pop(key)
                else:
                    await session.wake.wait()
                    continue
                if self._invalid(session):
                    await self._revoke(session, self._invalid(session))
                    return
                limit = .08 if frame['type'] in ('jog_state', 'jog_step') else .15 if frame['type'] == 'drive' else .5
                if self.clock() - received > limit:
                    continue
                if frame['type'] in ('jog_step', 'jog_state'):
                    if frame['seq'] <= session.last_sent_arm_sequence:
                        continue
                    session.last_sent_arm_sequence = frame['seq']
                await asyncio.wait_for(session.socket.send(json.dumps(frame, separators=(',', ':'), allow_nan=False)), .1)
        except asyncio.CancelledError:
            raise
        except Exception:
            await self._revoke(session, 'write_outcome_unknown_do_not_retry')

    async def _monitor(self, session):
        try:
            while self.active is session:
                reason = self._invalid(session)
                if reason:
                    await self._revoke(session, reason)
                    return
                await asyncio.sleep(.025)
        except asyncio.CancelledError:
            raise

    async def _revoke(self, session, reason):
        if session.cleanup is not None:
            if session.cleanup is not asyncio.current_task():
                await asyncio.shield(session.cleanup)
            return
        if self.active is session:
            self.active = None
        session.phase, session.reason = 'closed', reason
        self.arbiter.stopping(session.token)
        session.pending.clear()
        session.latest.clear()
        session.urgent.clear()
        self.retired[session.token] = session
        while len(self.retired) > 32:
            first = next(iter(self.retired))
            if self.retired[first].cleanup and not self.retired[first].cleanup.done():
                break
            self.retired.pop(first)
        for task in tuple(session.tasks):
            if task is not asyncio.current_task() and not task.done():
                task.cancel()
        session.cleanup = asyncio.create_task(self._cleanup(session, asyncio.current_task()))
        await asyncio.shield(session.cleanup)

    async def _cleanup(self, session, revoker):
        socket, session.socket = session.socket, None
        outcome = dict(connection_was_open=socket is not None, stop_command_sent=False,
                       transport_closed=socket is None, physical_stop_verified=False)
        if socket is not None:
            try:
                await asyncio.wait_for(socket.send('{"type":"stop"}'), .3)
                outcome['stop_command_sent'] = True
            except Exception:
                pass
            try:
                await asyncio.wait_for(socket.close(), .4)
                outcome['transport_closed'] = True
            except Exception:
                pass
        pending_connect = session.connect_task is not None and session.connect_task is not revoker and not session.connect_task.done()
        if pending_connect:
            done, _ = await asyncio.wait({session.connect_task}, timeout=.4)
            pending_connect = not done
        closed_transport = outcome['transport_closed']
        if pending_connect:
            outcome['transport_closed'] = None
        elif not session.late_socket_closed:
            outcome['transport_closed'] = False
        ok = (outcome['transport_closed'] is True and
              (not outcome['connection_was_open'] or outcome['stop_command_sent']))
        session.stop_result = dict(ok=ok, reason='stop_requested_physical_stop_unverified' if ok else
                                   'stop_transport_uncertain_physical_stop_unverified', **outcome)
        if pending_connect:
            session.stop_result['reason'] = 'connection_cleanup_pending_do_not_reconnect'
            async def finish_pending():
                await asyncio.gather(session.connect_task, return_exceptions=True)
                complete = closed_transport is True and session.late_socket_closed
                session.stop_result['transport_closed'] = complete
                session.stop_result['ok'] = complete and (not outcome['connection_was_open'] or outcome['stop_command_sent'])
                session.stop_result['reason'] = ('late_connection_closed_physical_stop_unverified' if complete else
                                                 'transport_cleanup_failed_controller_blocked')
                self._event(session, 'stop_result', session.stop_result['reason'])
                if complete:
                    self.arbiter.release(session.token)
            session.draining = asyncio.create_task(finish_pending())
        self._event(session, 'stop', session.reason)
        self._event(session, 'stop_result', session.stop_result['reason'])
        # Keep both frontends excluded until transport cleanup has finished.
        if outcome['transport_closed'] is True:
            self.arbiter.release(session.token)
        if session.browser:
            try:
                await self._browser_send(session.browser, dict(type='ae_closed', reason=session.reason,
                                                               stop_result=session.stop_result))
            except Exception:
                pass
            try:
                await asyncio.wait_for(session.browser.close(), .2)
            except Exception:
                pass

    async def stop(self, token):
        session = self.active if self.active and secrets.compare_digest(self.active.token, token) else self.retired.get(token)
        if session is None:
            raise HTTPException(403, 'invalid_control_session')
        await self._revoke(session, 'operator_stopped')
        return dict(ok=True, phase='closed', reason=session.reason, stop_result=session.stop_result,
                    physical_stop_verified=False)

    async def close(self):
        self.closing = True
        if self.active:
            await self._revoke(self.active, 'server_shutdown')
        pending = [s.cleanup for s in self.retired.values() if s.cleanup and not s.cleanup.done()]
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        if self.event_tasks:
            await asyncio.gather(*tuple(self.event_tasks), return_exceptions=True)


def create_foldbot_console_router(bridge: FoldBotConsoleBridge):
    router = APIRouter(prefix='/api/foldbot/console', tags=['foldbot-console'])

    @router.post('/sessions', dependencies=[Depends(_local_request)])
    async def sessions(request: ConsoleSessionRequest):
        return await bridge.create_session(request)

    @router.post('/stop', dependencies=[Depends(_local_request)])
    async def stop(request: SessionRequest):
        return await bridge.stop(request.session_id)

    @router.websocket('/ws')
    async def websocket(websocket: WebSocket):
        await bridge.run_socket(websocket)

    return router
