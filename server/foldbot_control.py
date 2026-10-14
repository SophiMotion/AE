"""Explicit local FoldBot control with one browser lease and no automatic reconnect.

Construction and imports perform no hardware I/O. A generated, reviewed project and
an explicit connect request are required before opening the fixed private /ws target.
All transport outcomes remain software evidence, never physical arrival or stopping.
"""
from __future__ import annotations

import asyncio
import copy
import hashlib
import ipaddress
import json
import secrets
import time
from collections import OrderedDict, deque
from dataclasses import dataclass, field
from typing import Annotated, Callable, Literal, Union
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StrictBool, StrictInt, StrictStr, TypeAdapter, field_validator

from .foldbot_esp import ESPBackend, EXPECTED_FIRMWARE_BUILD
from .foldbot_arbiter import FoldBotArbiter


def _confirmed(value):
    if value is not True:
        raise ValueError('explicit_confirmation_required')
    return value


Confirmed = Annotated[StrictBool, AfterValidator(_confirmed)]
Sequence = Annotated[StrictInt, Field(gt=0, le=2147483647)]


class StrictRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')


class ConnectRequest(StrictRequest):
    project_id: Annotated[StrictStr, Field(min_length=1, max_length=128)]
    revision: Annotated[StrictInt, Field(gt=0)]
    address: Annotated[StrictStr, Field(min_length=1, max_length=32)]
    confirmed: Confirmed


class SessionRequest(StrictRequest):
    session_id: Annotated[StrictStr, Field(min_length=1, max_length=128)]


class CommandRequest(SessionRequest):
    seq: Sequence


class EnableCommand(CommandRequest):
    operation: Literal['enable']
    confirmed: Confirmed


class DriveCommand(CommandRequest):
    operation: Literal['drive']
    linear: Annotated[StrictInt, Field(ge=-20, le=20)]
    turn: Annotated[StrictInt, Field(ge=-20, le=20)]
    duration_ms: Annotated[StrictInt, Field(ge=1, le=2000)]


class FoldCommand(CommandRequest):
    operation: Literal['fold']
    direction: Literal['fold', 'unfold']


class ConfirmEndpointCommand(CommandRequest):
    operation: Literal['confirm_endpoint']
    axis: Annotated[StrictInt, Field(ge=1, le=2)]
    endpoint: Literal['folded', 'unfolded']
    confirmed: Confirmed


class ArmStepCommand(CommandRequest):
    operation: Literal['arm_step']
    joint: Annotated[StrictInt, Field(ge=1, le=6)]
    direction: Annotated[StrictInt, Field(ge=-1, le=1)]

    @field_validator('direction')
    @classmethod
    def _nonzero(cls, value):
        if value == 0:
            raise ValueError('direction_must_be_plus_or_minus_one')
        return value


ControlCommand = Annotated[Union[EnableCommand, DriveCommand, FoldCommand,
                                ConfirmEndpointCommand, ArmStepCommand], Field(discriminator='operation')]
COMMAND_ADAPTER = TypeAdapter(ControlCommand)


def device_url(address: str) -> str:
    """RFC1918 IPv4 literals only: no DNS, URL, proxy, port, path or credentials."""
    if not isinstance(address, str) or address != address.strip():
        raise ValueError('private_ipv4_literal_required')
    try:
        ip = ipaddress.IPv4Address(address)
    except ipaddress.AddressValueError as error:
        raise ValueError('private_ipv4_literal_required') from error
    private = ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')
    if str(ip) != address or not any(ip in ipaddress.IPv4Network(net) for net in private):
        raise ValueError('private_ipv4_literal_required')
    return f'ws://{address}/ws'


def _binding(project):
    return hashlib.sha256(json.dumps(project['generation'], ensure_ascii=True,
                                    sort_keys=True, separators=(',', ':')).encode()).hexdigest()


@dataclass
class _Session:
    token: str
    project_id: str
    revision: int
    binding: str
    config: dict
    backend: object
    expires_at: float
    phase: str = 'connecting'
    last_sequence: int = 0
    reason: str = 'connecting'
    connect_task: asyncio.Task | None = None
    monitor_task: asyncio.Task | None = None
    command_task: asyncio.Task | None = None
    cleanup_task: asyncio.Task | None = None
    draining_task: asyncio.Task | None = None
    late_socket_closed: bool = True
    opening_socket: object = None
    stop_result: dict | None = None
    events: deque = field(default_factory=lambda: deque(maxlen=100))


class FoldBotController:
    def __init__(self, require_current_generation: Callable, *, backend_factory=ESPBackend,
                 clock=time.monotonic, lease_seconds=2., monitor_interval=.05, on_event=None, arbiter=None):
        if not 0 < lease_seconds <= 2. or not 0 < monitor_interval <= .1:
            raise ValueError('invalid_lease_monitor_limits')
        self.require_current_generation = require_current_generation
        self.backend_factory, self.clock = backend_factory, clock
        self.lease_seconds, self.monitor_interval = lease_seconds, monitor_interval
        self.on_event = on_event
        self.active = None
        self.retired = OrderedDict()
        self.closing = False
        self.event_tasks = set()
        self.arbiter = arbiter if arbiter is not None else FoldBotArbiter()

    def _event(self, session, operation, reason):
        event = dict(project_id=session.project_id, revision=session.revision,
                     time_ms=int(time.time() * 1000), operation=operation, reason=reason,
                     physical_completion_verified=False)
        session.events.append(event)
        if self.on_event:
            task = asyncio.create_task(self._persist_event(session, copy.deepcopy(event)))
            self.event_tasks.add(task)
            task.add_done_callback(self.event_tasks.discard)

    async def _persist_event(self, session, event):
        try:
            await asyncio.wait_for(asyncio.to_thread(self.on_event, event), .25)
        except Exception:
            session.events.append(dict(operation='log', reason='persistence_failed',
                                       physical_completion_verified=False))

    async def _approved_project(self, project_id, revision):
        def read():
            project = self.require_current_generation(project_id, revision)
            return project, _binding(project)
        try:
            return await asyncio.wait_for(asyncio.to_thread(read), .25)
        except asyncio.TimeoutError:
            raise HTTPException(409, 'project_approval_read_timeout') from None

    async def _project_error(self, session):
        try:
            _, binding = await self._approved_project(session.project_id, session.revision)
            if binding != session.binding:
                return 'generation_changed'
        except Exception:
            return 'project_changed_or_unapproved'
        return None

    def _state(self, session):
        state = copy.deepcopy(session.backend.status())
        state.update(phase=session.phase, reason=session.reason, project_id=session.project_id,
                     revision=session.revision, lease_remaining_ms=max(0, int((session.expires_at - self.clock()) * 1000)),
                     events=list(session.events), physical_completion_verified=False)
        if session.phase == 'closed':
            state.update(connected=False, enabled=False)
        if session.stop_result is not None:
            state['stop_result'] = copy.deepcopy(session.stop_result)
        return state

    def _answer(self, session, ok=True, reason=None, **extra):
        return dict(ok=ok, reason=reason or session.reason, state=self._state(session),
                    physical_completion_verified=False, **extra)

    def _find(self, token):
        if self.active and secrets.compare_digest(self.active.token, token):
            return self.active
        if token in self.retired:
            old = self.retired[token]
            raise HTTPException(409, self._answer(old, False, old.reason))
        raise HTTPException(403, 'invalid_control_session')

    def _invalid_reason(self, session):
        if self.active is not session or not self.arbiter.owns(session.token):
            return 'session_revoked'
        if self.clock() >= session.expires_at:
            return 'browser_lease_expired'
        if session.phase == 'connected':
            state = session.backend.status()
            if not state.get('connected') or state.get('fault'):
                return 'device_disconnected_or_fault'
            if state.get('fresh') is not True:
                return 'device_status_stale'
            return self._firmware_error(state)
        return None

    @staticmethod
    def _firmware_error(state):
        frame = state.get('firmware') or {}
        if (frame.get('firmwareBuild') != EXPECTED_FIRMWARE_BUILD or
                frame.get('protocol') != 'suzhou-foldbot-web-v1' or
                type(frame.get('rosControlVersion')) is not int or frame.get('rosControlVersion') != 1 or
                frame.get('externalArm') is not False or frame.get('foldAxisCount') != 2):
            return 'firmware_contract_mismatch'
        limits = frame.get('limits') or {}
        if limits.get('enabled') is not False:
            return 'expected_no_limits_firmware_required'
        if (frame.get('estop') is not False or limits.get('fault') or
                frame.get('homing', {}).get('active') or
                frame.get('homing', {}).get('state') == 'fault'):
            return 'firmware_fault_or_homing'
        for name in ('stepper', 'stepper2'):
            if not isinstance(frame.get(name), dict) or frame[name].get('state') == 'fault':
                return 'fold_axis_missing_or_fault'
        return None

    async def _checked(self, token):
        session = self._find(token)
        error = self._invalid_reason(session) or await self._project_error(session)
        error = error or self._invalid_reason(session)
        if error:
            await self._revoke(session, error)
            raise HTTPException(409, self._answer(session, False, error))
        return session

    async def connect(self, request: ConnectRequest):
        try:
            url = device_url(request.address)
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        if self.closing:
            raise HTTPException(409, 'controller_shutting_down')
        if self.active or any(s.cleanup_task and not s.cleanup_task.done() for s in self.retired.values()):
            raise HTTPException(409, 'single_operator_session_busy')
        project, binding = await self._approved_project(request.project_id, request.revision)
        if self.closing or self.active or any(s.cleanup_task and not s.cleanup_task.done() for s in self.retired.values()):
            raise HTTPException(409, 'single_operator_session_busy')
        config = copy.deepcopy(project['generation']['config']['local_control'])
        token = secrets.token_urlsafe(32)
        if not self.arbiter.reserve(token, 'simplified'):
            raise HTTPException(409, 'single_operator_session_busy')
        try:
            session = _Session(token, request.project_id, request.revision,
                               binding, config, self.backend_factory(), self.clock() + self.lease_seconds)
        except BaseException:
            self.arbiter.release(token)
            raise
        self.active = session
        if isinstance(session.backend, ESPBackend):
            factory = session.backend.factory
            async def owned_transport(address):
                socket = await factory(address)
                if self.active is not session:
                    session.late_socket_closed = False
                    await asyncio.wait_for(socket.close(), .4)
                    session.late_socket_closed = True
                    raise ConnectionError('connection_revoked_before_transport_adoption')
                session.opening_socket = socket
                return socket
            session.backend.factory = owned_transport
        self._event(session, 'connect', 'connecting_initializes_drive_power_30_percent')
        session.connect_task = asyncio.create_task(self._connect_device(session, url))
        session.monitor_task = asyncio.create_task(self._monitor(session))
        return self._answer(session, session_id=session.token, lease_ms=int(self.lease_seconds * 1000),
                            heartbeat_interval_ms=500)

    async def _connect_device(self, session, url):
        try:
            response = await asyncio.wait_for(session.backend.connect(url), 5.)
            if self.active is not session:
                await session.backend.stop_and_disconnect()
                return
            error = self._invalid_reason(session) or await self._project_error(session)
            error = error or self._invalid_reason(session)
            state = session.backend.status()
            frame = state.get('firmware') or {}
            error = error or (None if response.get('ok') else response.get('reason', 'connection_failed'))
            error = error or self._firmware_error(state)
            if (not state.get('connected') or state.get('fresh') is not True or state.get('enabled') or
                    frame.get('motionEnabled') is not False or self._busy(frame)):
                error = error or 'connection_not_fresh_disabled_and_idle'
            if error:
                await self._revoke(session, error)
                return
            session.phase, session.reason = 'connected', 'connected_disabled'
            self._event(session, 'connect', session.reason)
        except asyncio.CancelledError:
            raise
        except Exception:
            await self._revoke(session, 'connection_outcome_unknown_do_not_retry')

    async def _monitor(self, session):
        try:
            while self.active is session:
                error = self._invalid_reason(session) or await self._project_error(session)
                error = error or self._invalid_reason(session)
                if error:
                    await self._revoke(session, error)
                    return
                await asyncio.sleep(self.monitor_interval)
        except asyncio.CancelledError:
            raise
        except Exception:
            await self._revoke(session, 'control_supervisor_failed')

    async def heartbeat(self, token):
        session = await self._checked(token)
        session.expires_at = self.clock() + self.lease_seconds
        return self._answer(session, reason='browser_lease_renewed')

    async def status(self, token):
        return self._answer(await self._checked(token))

    @staticmethod
    def _busy(frame):
        return (frame.get('controlBusy') is not False or frame.get('action') != 'idle' or
                any((frame.get(name) or {}).get('active') is not False for name in ('stepper', 'stepper2')))

    def _admit_command(self, session, request):
        if session.phase != 'connected':
            raise HTTPException(409, 'connection_initialization_pending')
        state = session.backend.status()
        frame = state['firmware']
        if self._busy(frame):
            raise HTTPException(409, 'firmware_motion_busy')
        if request.operation == 'enable':
            if state.get('enabled') or frame.get('motionEnabled') is not False:
                raise HTTPException(409, 'enable_requires_disabled_firmware')
            return session.backend.enable()
        if state.get('enabled') is not True or frame.get('motionEnabled') is not True:
            raise HTTPException(409, 'motion_disabled')
        modules = session.config.get('modules') or {}
        if request.operation == 'drive':
            if modules.get('chassis') is not True:
                raise HTTPException(409, 'chassis_not_in_approved_project')
            if (abs(request.linear) > session.config['drive_level'] or
                    abs(request.turn) > session.config['drive_level'] or
                    request.duration_ms > session.config['drive_duration_ms']):
                raise HTTPException(422, 'drive_exceeds_approved_project')
            return session.backend.drive(request.linear, request.turn, request.duration_ms)
        if request.operation in ('fold', 'confirm_endpoint'):
            if modules.get('fold') is not True or session.config.get('fold', {}).get('axes') != 2:
                raise HTTPException(409, 'dual_fold_not_in_approved_project')
            for name in ('stepper', 'stepper2'):
                axis = frame[name]
                if any(axis.get(key) is not True for key in ('pulseEngineReady', 'nvsReady', 'enableControl')):
                    raise HTTPException(409, name + '_configuration_required')
                if request.operation == 'fold' and (axis.get('homed') is not True or
                        axis.get('travelValid') is not True or type(axis.get('travel')) is not int or
                        axis['travel'] <= 0 or type(axis.get('position')) is not int or
                        not 0 <= axis['position'] <= axis['travel']):
                    raise HTTPException(409, name + '_live_reference_and_travel_required')
            if request.operation == 'fold':
                return session.backend.fold(request.direction)
            return session.backend.confirm_endpoint(request.endpoint, request.axis)
        if modules.get('arm') is not True or session.config.get('arm', {}).get('max_step_raw') != 8:
            raise HTTPException(409, 'arm_not_in_approved_project')
        if request.direction not in (-1, 1):
            raise HTTPException(422, 'arm_direction_must_be_plus_or_minus_one')
        return session.backend.arm_step(request.joint, request.direction)

    async def command(self, request: ControlCommand):
        session = await self._checked(request.session_id)
        if request.seq <= session.last_sequence:
            raise HTTPException(409, 'duplicate_or_stale_command_sequence')
        session.last_sequence = request.seq
        if session.command_task and not session.command_task.done():
            raise HTTPException(409, 'command_in_flight')
        operation = self._admit_command(session, request)
        session.command_task = asyncio.create_task(operation)
        self._event(session, request.operation, 'requested_not_physically_verified')
        try:
            response = await asyncio.wait_for(asyncio.shield(session.command_task), 2.)
            error = self._invalid_reason(session) or await self._project_error(session)
            error = error or self._invalid_reason(session)
            if error:
                await self._revoke(session, error)
                raise HTTPException(409, self._answer(session, False, error))
            self._event(session, request.operation, response.get('reason', 'unknown_result'))
            if not response.get('ok') and not session.backend.status().get('connected'):
                await self._revoke(session, response.get('reason', 'device_disconnected'))
            return self._answer(session, bool(response.get('ok')), response.get('reason'),
                                result=response.get('data', {}))
        except asyncio.CancelledError:
            if self.active is session:
                await self._revoke(session, 'request_cancelled_outcome_unknown_do_not_retry')
            raise HTTPException(409, self._answer(session, False, 'session_revoked')) from None
        except HTTPException:
            raise
        except Exception:
            await self._revoke(session, 'command_outcome_unknown_do_not_retry')
            raise HTTPException(409, self._answer(session, False, 'command_outcome_unknown_do_not_retry')) from None

    async def _revoke(self, session, reason):
        if session.cleanup_task:
            if session.cleanup_task is not asyncio.current_task():
                await asyncio.shield(session.cleanup_task)
            return
        # Revoke synchronously BEFORE any await: STOP never waits for command ACK.
        if self.active is session:
            self.active = None
        session.phase, session.reason = 'closed', reason
        self.arbiter.stopping(session.token)
        session.expires_at = 0.
        self.retired[session.token] = session
        while len(self.retired) > 32:
            first = next(iter(self.retired))
            if self.retired[first].cleanup_task and not self.retired[first].cleanup_task.done():
                break
            self.retired.pop(first)
        self._event(session, 'stop', reason)
        current = asyncio.current_task()
        for task in (session.connect_task, session.monitor_task, session.command_task):
            if task and task is not current and not task.done():
                task.cancel()
        session.cleanup_task = asyncio.create_task(self._cleanup(session, current))
        await asyncio.shield(session.cleanup_task)

    async def _stop_backend(self, session):
        opening, session.opening_socket = session.opening_socket, None
        adopted = opening is not None and getattr(session.backend, 'ws', None) is opening
        try:
            response = await asyncio.wait_for(session.backend.stop_and_disconnect(), 1.2)
            result = copy.deepcopy(response)
            data = result.setdefault('data', {})
            # Injected legacy test backends may report closure through status only.
            data.setdefault('transport_closed', session.backend.status().get('connected') is False)
            data['physical_stop_verified'] = False
        except Exception:
            result = dict(ok=False, reason='stop_outcome_unknown_physical_stop_unverified',
                          data=dict(stop_command_sent=None, transport_closed=None, physical_stop_verified=False))
        if opening is not None and not adopted:
            try:
                await asyncio.wait_for(opening.close(), .4)
            except Exception:
                result.update(ok=False, reason='transport_cleanup_failed_controller_blocked')
                result['data']['transport_closed'] = False
        return result

    async def _cleanup(self, session, revoker):
        session.stop_result = await self._stop_backend(session)
        initial_transport_closed = session.stop_result['data']['transport_closed']
        pending = session.connect_task is not None and session.connect_task is not revoker and not session.connect_task.done()
        if pending:
            done, _ = await asyncio.wait({session.connect_task}, timeout=.4)
            pending = not done
        if pending:
            session.stop_result.update(ok=False, reason='connection_cleanup_pending_do_not_reconnect')
            session.stop_result['data']['transport_closed'] = None
            async def finish_pending():
                await asyncio.gather(session.connect_task, return_exceptions=True)
                # A cancelled transport factory can still return. Close the late
                # backend before allowing either frontend to reserve a new owner.
                session.stop_result = await self._stop_backend(session)
                if initial_transport_closed is not True or not session.late_socket_closed:
                    session.stop_result.update(ok=False, reason='transport_cleanup_failed_controller_blocked')
                    session.stop_result['data']['transport_closed'] = initial_transport_closed if session.late_socket_closed else False
                self._event(session, 'stop_result', session.stop_result.get('reason', 'stop_requested'))
                if session.stop_result['data']['transport_closed'] is True:
                    self.arbiter.release(session.token)
            session.draining_task = asyncio.create_task(finish_pending())
        elif not session.late_socket_closed:
            session.stop_result.update(ok=False, reason='transport_cleanup_failed_controller_blocked')
            session.stop_result['data']['transport_closed'] = False
        elif session.backend.status().get('connected'):
            session.stop_result = await self._stop_backend(session)
            if initial_transport_closed is not True:
                session.stop_result.update(ok=False, reason='transport_cleanup_failed_controller_blocked')
                session.stop_result['data']['transport_closed'] = initial_transport_closed
        self._event(session, 'stop_result', session.stop_result.get('reason', 'stop_requested'))
        if session.stop_result['data']['transport_closed'] is True:
            self.arbiter.release(session.token)

    async def stop(self, token):
        if token in self.retired:
            session = self.retired[token]
            await self._revoke(session, session.reason)
        else:
            session = self._find(token)
            await self._revoke(session, 'operator_stopped')
        return self._answer(session, reason='control_revoked_stop_requested', physical_stop_verified=False)

    async def shutdown(self):
        self.closing = True
        if self.active:
            await self._revoke(self.active, 'server_shutdown')
        pending = [s.cleanup_task for s in self.retired.values() if s.cleanup_task and not s.cleanup_task.done()]
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        if self.event_tasks:
            await asyncio.gather(*tuple(self.event_tasks), return_exceptions=True)

    async def close(self):
        await self.shutdown()


async def _local_request(request: Request):
    def local_url(value, *, origin=False):
        try:
            parsed = urlsplit(value if origin else 'http://' + value)
            return (parsed.scheme in ('http', 'https') and
                    parsed.hostname in ('localhost', '127.0.0.1', '::1') and
                    not parsed.username and not parsed.password and not parsed.query and
                    not parsed.fragment and parsed.path in ('', '/') and
                    (parsed.port is None or 1 <= parsed.port <= 65535))
        except ValueError:
            return False
    if not local_url(request.headers.get('host', '')):
        raise HTTPException(403, 'local_host_required')
    origin = request.headers.get('origin')
    if origin is not None and not local_url(origin, origin=True):
        raise HTTPException(403, 'local_origin_required')
    if request.headers.get('sec-fetch-site') == 'cross-site':
        raise HTTPException(403, 'cross_site_control_rejected')


def create_foldbot_router(controller: FoldBotController):
    router = APIRouter(prefix='/api/foldbot/control', tags=['foldbot-control'],
                       dependencies=[Depends(_local_request)])

    @router.post('/connect')
    async def connect(request: ConnectRequest):
        return await controller.connect(request)

    @router.post('/heartbeat')
    async def heartbeat(request: SessionRequest):
        return await controller.heartbeat(request.session_id)

    @router.post('/status')
    async def status(request: SessionRequest):
        return await controller.status(request.session_id)

    @router.post('/command')
    async def command(request: ControlCommand):
        return await controller.command(request)

    @router.post('/stop')
    async def stop(request: SessionRequest):
        return await controller.stop(request.session_id)

    return router
