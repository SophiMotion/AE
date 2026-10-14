"""Explicit, non-retrying ESP WebSocket control. No I/O at import/construction.

Software ceilings are not validated physical limits. Status is a firmware snapshot,
not fresh servo measurements; accepted commands never claim physical completion.
"""
import asyncio
import copy
import json
import time
from urllib.parse import urlsplit

EXPECTED_FIRMWARE_BUILD = 'foldbot-20260929-sophicar-external-driver-no-limits'


def result(ok, reason, **data):
    return {'ok': bool(ok), 'reason': reason, 'data': data}


class ESPBackend:
    def __init__(self, transport_factory=None, clock=time.monotonic, *, external_arm=False):
        if type(external_arm) is not bool:
            raise ValueError('invalid_arm_mode')
        self.external_arm = external_arm
        self.factory = transport_factory or self._open
        self.clock = clock
        self.ws = None
        self.snapshot = None
        self.received = None
        self.fault = None
        self.enabled = False
        self.receiver = self.supervisor = self.driver = None
        self.pending = None
        self.pending_command = None
        self.state_event = asyncio.Event()
        self.command_lock = asyncio.Lock()
        self.generation = 0
        self.connecting = False
        self.arm_sequence = 0
        self.arm_barrier = None
        self.arm_applying = False
        self.home_pending = False

    @staticmethod
    async def _open(url):
        from websockets.asyncio.client import connect
        return await connect(url, proxy=None, open_timeout=2, close_timeout=.3,
                             max_size=65536, max_queue=4, ping_interval=None)

    def status(self):
        age = None if self.received is None else max(0., (self.clock() - self.received) * 1000)
        return {'connected': self.ws is not None, 'enabled': self.enabled,
                'fault': self.fault, 'frame_age_ms': age,
                'fresh': age is not None and age <= 500,
                'firmware': self.snapshot, 'physical_completion_verified': False}

    async def _send(self, frame):
        if self.ws is None:
            raise ConnectionError('disconnected')
        await asyncio.wait_for(self.ws.send(json.dumps(frame, allow_nan=False)), .3)

    @staticmethod
    def _fold_axes(frame):
        return ([frame['stepper'], frame['stepper2']] if frame.get('foldAxisCount') == 2
                else [frame['stepper']])

    def _validate_status(self, frame):
        if 'limits' in frame or 'homing' in frame:
            limits, homing = frame.get('limits'), frame.get('homing')
            if (type(limits) is not dict or type(homing) is not dict or
                    limits.get('wiring') != 'NC' or
                    any(type(limits.get(k)) is not bool for k in ('enabled','fold1','unfold1','fold2','unfold2')) or
                    type(limits.get('fault')) is not str or
                    type(homing.get('active')) is not bool or
                    type(homing.get('axis')) is not int or homing['axis'] not in (0,1,2) or
                    any(type(homing.get(k)) is not str for k in ('state','error'))):
                raise ValueError('malformed_limit_homing_status')
        if (self.snapshot is not None and 'limits' in self.snapshot and
                'limits' not in frame):
            raise ValueError('limit_capability_lost')
        if (frame.get('protocol') != 'suzhou-foldbot-web-v1' or
                type(frame.get('rosControlVersion')) is not int or frame['rosControlVersion'] != 1 or
                not isinstance(frame.get('firmwareBuild'), str) or not frame['firmwareBuild'] or
                type(frame.get('controlSession')) is not int or
                type(frame.get('statusSeq')) is not int or
                type(frame.get('uptimeMs')) is not int or
                type(frame.get('externalArm')) is not bool or
                type(frame.get('motionEnabled')) is not bool or
                type(frame.get('estop')) is not bool or
                type(frame.get('controlBusy')) is not bool or
                not isinstance(frame.get('action'), str) or
                not isinstance(frame.get('stepper'), dict)):
            raise ValueError('unsupported_or_malformed_firmware')
        axis_count = frame.get('foldAxisCount', 1)
        if (type(axis_count) is not int or axis_count not in (1, 2) or
                (axis_count == 1 and 'stepper2' in frame)):
            raise ValueError('unsupported_fold_axis_count')
        if axis_count == 2:
            for key in ('stepper', 'stepper2'):
                axis = frame.get(key)
                if (type(axis) is not dict or
                        any(type(axis.get(field)) is not int for field in ('position', 'target', 'travel')) or
                        any(type(axis.get(field)) is not bool for field in
                            ('travelValid', 'homed', 'active', 'driverEnabled', 'enableControl',
                             'directionInverted', 'pulseEngineReady', 'nvsReady')) or
                        any(type(axis.get(field)) is not str for field in ('state', 'error'))):
                    raise ValueError('malformed_dual_stepper_status')
        if self.snapshot is not None:
            if frame['controlSession'] != self.snapshot['controlSession']:
                raise ValueError('firmware_session_changed')
            if axis_count != self.snapshot.get('foldAxisCount', 1):
                raise ValueError('fold_axis_count_changed')
            delta = (frame['statusSeq'] - self.snapshot['statusSeq']) & 0xffffffff
            if not 0 < delta < 0x80000000:
                raise ValueError('status_sequence_not_new')

    async def _receive(self):
        try:
            while self.ws is not None:
                frame = json.loads(await self.ws.recv())
                if not isinstance(frame, dict):
                    raise ValueError('invalid_frame')
                if frame.get('type') == 'status':
                    self._validate_status(frame)
                    self.snapshot, self.received = frame, self.clock()
                    if frame.get('homing', {}).get('active') is True:
                        self.home_pending = False
                    self.state_event.set()
                    if self.enabled and (frame['estop'] or frame['externalArm'] != self.external_arm or
                                         not frame['motionEnabled'] or
                                         any(axis.get('state') == 'fault' for axis in self._fold_axes(frame)) or
                                         bool(frame.get('limits', {}).get('fault')) or
                                         frame.get('homing', {}).get('state') == 'fault'):
                        raise ValueError('active_firmware_fault')
                elif frame.get('type') == 'error':
                    raise ValueError('firmware_error:' + str(frame.get('reason', 'unknown')))
                elif frame.get('type') == 'ack' and self.pending is not None:
                    if frame.get('command') == self.pending_command and not self.pending.done():
                        self.pending.set_result(frame)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await self._trip(str(exc))

    async def _trip(self, reason):
        self.fault = reason
        await self._shutdown(send_stop=True)

    async def _shutdown(self, send_stop):
        self.home_pending = False
        self.generation += 1
        self.enabled = False
        self.arm_barrier = None
        self.arm_applying = False
        current = asyncio.current_task()
        for task in (self.driver, self.supervisor, self.receiver):
            if task is not None and task is not current:
                task.cancel()
        self.driver = self.supervisor = self.receiver = None
        if self.pending is not None and not self.pending.done():
            self.pending.set_result({'ok': False, 'message': self.fault or 'cancelled'})
        socket, self.ws = self.ws, None
        self.state_event.set()
        outcome = dict(connection_was_open=socket is not None, stop_command_sent=False,
                       transport_closed=socket is None, physical_stop_verified=False)
        if socket is not None:
            if send_stop:
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
        return outcome

    async def _wait_state(self, predicate, timeout=.8):
        async def wait():
            while True:
                self.state_event.clear()
                if self.fault or self.ws is None:
                    raise ConnectionError(self.fault or 'disconnected')
                if predicate():
                    return
                await self.state_event.wait()
        await asyncio.wait_for(wait(), timeout)

    async def _command(self, frame, command):
        if self.command_lock.locked():
            return result(False, 'command_busy')
        async with self.command_lock:
            if self.ws is None or self.fault:
                return result(False, self.fault or 'disconnected')
            self.pending = asyncio.get_running_loop().create_future()
            self.pending_command = command
            try:
                await self._send(frame)
                ack = await asyncio.wait_for(self.pending, .7)
                if ack.get('ok') is not True:
                    await self._trip('command_rejected:' + str(ack.get('message', 'unknown')))
                    return result(False, self.fault)
                return result(True, 'accepted', phase='accepted', ack=ack,
                              mechanical_endpoint_verified=False)
            except (Exception, asyncio.CancelledError) as exc:
                await self._trip('command_uncertain:' + type(exc).__name__)
                if isinstance(exc, asyncio.CancelledError):
                    raise
                return result(False, self.fault)
            finally:
                self.pending = self.pending_command = None

    async def connect(self, url):
        if self.ws is not None or self.connecting:
            return result(False, 'already_connected_or_connecting')
        if not isinstance(url, str):
            return result(False, 'invalid_url')
        parsed = urlsplit(url)
        if parsed.scheme not in ('ws', 'wss') or not parsed.hostname or parsed.username or parsed.password:
            return result(False, 'invalid_url')
        self.connecting = True
        generation = self.generation
        self.fault = self.snapshot = self.received = None
        try:
            socket = await asyncio.wait_for(self.factory(url), 2.5)
            if generation != self.generation:
                await socket.close()
                return result(False, 'connection_cancelled')
            self.ws = socket
            self.receiver = asyncio.create_task(self._receive())
            hello = await self._command({'type': 'hello', 'version': 1}, 'hello')
            if not hello['ok']:
                return hello
            await self._wait_state(lambda: self.snapshot is not None)
            if self.snapshot['firmwareBuild'] != EXPECTED_FIRMWARE_BUILD:
                raise ValueError('firmware_build_mismatch')
            if self.snapshot['motionEnabled'] or self.snapshot['controlBusy'] or self.snapshot['action'] != 'idle':
                raise ValueError('connection_not_disabled_and_idle')
            if self.external_arm:
                arm = await self._command({'type': 'arm_external', 'enabled': True}, 'arm_external')
                if not arm['ok']:
                    return arm
                await self._wait_state(lambda: self.snapshot is not None and self.snapshot['externalArm'])
            elif self.snapshot['externalArm']:
                raise ValueError('external_arm_active_operator_restart_required')
            self.arm_sequence = 0
            speed = await self._command({'type': 'drive_speed', 'percent': 30}, 'drive_speed')
            if not speed['ok']:
                return speed
            self.supervisor = asyncio.create_task(self._watch())
            return result(True, 'connected_disabled', software_drive_power_percent=30)
        except asyncio.CancelledError:
            await self._trip('connect_cancelled')
            raise
        except Exception as exc:
            await self._trip(str(exc))
            return result(False, self.fault)
        finally:
            self.connecting = False

    def _ready(self, require_enabled=True):
        status = self.status()
        if self.fault or self.ws is None:
            return self.fault or 'disconnected'
        if not status['fresh'] or not self.snapshot:
            return 'state_not_fresh'
        if self.snapshot['externalArm'] != self.external_arm:
            return 'arm_control_mode_mismatch'
        if self.snapshot['estop']:
            return 'firmware_estop'
        if self.snapshot.get('limits', {}).get('fault'):
            return 'limit_fault:' + self.snapshot['limits']['fault']
        if any(axis.get('state') == 'fault' for axis in self._fold_axes(self.snapshot)):
            return 'active_firmware_fault'
        if require_enabled and not self.enabled:
            return 'motion_disabled'
        return None

    def _joint(self, joint):
        joints = (self.snapshot or {}).get('joints')
        if not isinstance(joints, list):
            return None
        matches = [j for j in joints if isinstance(j, dict) and type(j.get('id')) is int and j['id'] == joint]
        return matches[0] if len(matches) == 1 else None

    @staticmethod
    def _joint_error(joint):
        if not joint:
            return 'joint_missing_or_duplicate'
        if (joint.get('online') is not True or joint.get('available') is not True or
                joint.get('fault') != 'none'):
            return 'joint_offline_or_fault'
        if joint.get('position_valid') is not True or joint.get('stale') is not False:
            return 'joint_position_stale'
        if type(joint.get('direction')) is not int or joint['direction'] != 0:
            return 'joint_motion_active'
        if any(type(joint.get(k)) is not int for k in ('position', 'position_seq', 'min', 'max')):
            return 'invalid_joint_position_or_limits'
        if not (-10000 <= joint['min'] < joint['max'] <= 10000 and
                joint['min'] <= joint['position'] <= joint['max'] and
                0 <= joint['position_seq'] <= 0xffffffff):
            return 'joint_position_outside_limits'
        return None

    def _refresh_arm_barrier(self):
        if self.arm_barrier is None:
            return
        joint_id, baseline, started = self.arm_barrier
        joint = self._joint(joint_id)
        if self.clock() - started >= 1. and self.status()['fresh'] and not self._joint_error(joint):
            delta = (joint['position_seq'] - baseline) & 0xffffffff
            if 0 < delta < 0x80000000:
                self.arm_barrier = None

    def _motion_idle(self):
        if self.home_pending:
            return 'homing_start_pending'
        if self.snapshot.get('homing', {}).get('active'):
            return 'homing_active'
        self._refresh_arm_barrier()
        if self.arm_applying or self.arm_barrier is not None:
            return 'arm_step_cooldown_or_feedback_pending'
        if (self.command_lock.locked() or (self.driver is not None and not self.driver.done()) or
                self.snapshot['controlBusy'] or self.snapshot['action'] != 'idle' or
                any(axis.get('active') is not False for axis in self._fold_axes(self.snapshot))):
            return 'motion_busy'
        return None

    def arm_status(self):
        self._refresh_arm_barrier()
        state = self.status()
        snapshot = self.snapshot or {}
        raw_joints = snapshot.get('joints')
        joints = [copy.deepcopy(j) for j in (raw_joints if isinstance(raw_joints, list) else [])
                  if isinstance(j, dict) and type(j.get('id')) is int and 1 <= j['id'] <= 6]
        supported = (type(snapshot.get('armProtocol')) is int and snapshot['armProtocol'] == 1 and
                     snapshot.get('armStepRangeGuard') is True)
        allowed = (not self.external_arm and supported and not self._ready() and
                   not self._motion_idle() and any(not self._joint_error(j) for j in joints))
        return dict(backend='esp32', connected=state['connected'], enabled=state['enabled'],
                    fresh=state['fresh'], frame_age_ms=state['frame_age_ms'],
                    cached_snapshot=True, position_age_ms=None, joints=joints,
                    motion_allowed=bool(allowed), arm_protocol_supported=supported,
                    step_pending=self.arm_applying or self.arm_barrier is not None,
                    reason=state['fault'], physical_completion_verified=False)

    async def arm_step(self, joint, direction):
        if type(joint) is not int or not 1 <= joint <= 6 or type(direction) is not int or direction not in (-1, 1):
            return result(False, 'invalid_arm_step_arguments')
        if self.external_arm:
            return result(False, 'esp_arm_unavailable_in_usb_mode')
        error = self._ready()
        if error:
            return result(False, error)
        error = self._motion_idle()
        if error:
            return result(False, error)
        if type(self.snapshot.get('armProtocol')) is not int or self.snapshot['armProtocol'] != 1:
            return result(False, 'arm_protocol_unsupported')
        if self.snapshot.get('armStepRangeGuard') is not True:
            return result(False, 'arm_range_guard_firmware_upgrade_required')
        error = self._joint_error(self._joint(joint))
        if error:
            return result(False, error)
        counters = [self.snapshot.get('applied_jog_seq'), self.snapshot.get('jog_step_seq')]
        if any(type(n) is not int or not 0 <= n < 2147483647 for n in counters):
            return result(False, 'invalid_or_exhausted_arm_sequence')
        sequence = max(self.arm_sequence, *counters) + 1
        if sequence > 2147483647:
            return result(False, 'arm_sequence_exhausted_reconnect_required')
        self.arm_sequence = sequence
        directions = [0] * 6
        directions[joint - 1] = direction
        self.arm_applying = True
        generation = self.generation
        try:
            response = await self._command({'type': 'jog_step', 'seq': sequence, 'dir': directions}, 'jog_step')
            if not response['ok']:
                return response
            await self._wait_state(lambda: self.snapshot.get('jog_step_seq') == sequence and
                                   self.snapshot.get('jog_step_status') == 'applied')
            if generation != self.generation:
                return result(False, 'arm_step_cancelled')
            measured = self._joint(joint)
            error = self._joint_error(measured)
            if error:
                raise ValueError(error)
            # Baseline AFTER the applied status, not the pre-target measurement.
            self.arm_barrier = (joint, measured['position_seq'], self.clock())
            return result(True, 'arm_step_applied_not_completed', sequence=sequence,
                          firmware_step_raw_units=8, cooldown_ms=1000,
                          awaiting_followup_measurement=True, physical_completion_verified=False)
        except (Exception, asyncio.CancelledError) as exc:
            await self._trip('arm_step_uncertain:' + type(exc).__name__)
            if isinstance(exc, asyncio.CancelledError):
                raise
            return result(False, self.fault)
        finally:
            self.arm_applying = False

    async def enable(self):
        error = self._ready(False)
        if error:
            return result(False, error)
        generation = self.generation
        response = await self._command({'type': 'motion_enable', 'enabled': True}, 'motion_enable')
        if response['ok'] and generation == self.generation:
            try:
                await self._wait_state(lambda: self.snapshot is not None and self.snapshot['motionEnabled'])
                if generation != self.generation or self._ready(False):
                    return result(False, 'enable_cancelled')
                self.enabled = True
            except Exception as exc:
                await self._trip('enable_state_uncertain:' + str(exc))
                return result(False, self.fault)
        return response

    async def home(self):
        error = self._ready()
        if error:
            return result(False, error)
        limits = self.snapshot.get('limits', {})
        if (self.snapshot.get('foldAxisCount') != 2 or limits.get('enabled') is not True or
                limits.get('wiring') != 'NC' or 'homing' not in self.snapshot):
            return result(False, 'limit_homing_unsupported')
        error = self._motion_idle()
        if error:
            return result(False, error)
        for number, axis in enumerate(self._fold_axes(self.snapshot), 1):
            if (not axis['travelValid'] or axis['travel'] <= 0 or not axis['pulseEngineReady'] or
                    not axis['nvsReady'] or not axis['enableControl']):
                return result(False, f'fold_axis_{number}_homing_not_ready')
            if limits[f'fold{number}'] and limits[f'unfold{number}']:
                return result(False, f'fold_axis_{number}_contradictory_limits')
        self.home_pending = True
        return await self._command({'type': 'fold_home'}, 'fold_home')

    async def fold(self, direction):
        if direction not in ('fold', 'unfold'):
            return result(False, 'invalid_direction')
        error = self._ready()
        if error:
            return result(False, error)
        error = self._motion_idle()
        if error:
            return result(False, error)
        if self.snapshot.get('foldAxisCount') == 2:
            for number, axis in enumerate(self._fold_axes(self.snapshot), 1):
                prefix = f'fold_axis_{number}_'
                if not axis['homed']:
                    return result(False, prefix + 'reference_required')
                if not axis['travelValid'] or axis['travel'] <= 0:
                    return result(False, prefix + 'travel_required')
                if not 0 <= axis['position'] <= axis['travel']:
                    return result(False, prefix + 'position_outside_travel')
                if (axis['state'] == 'fault' or not axis['pulseEngineReady'] or
                        not axis['nvsReady'] or not axis['enableControl']):
                    return result(False, prefix + 'not_ready')
        name = 'torso_' + direction
        return await self._command({'type': 'action', 'name': name}, name)

    async def confirm(self, endpoint, axis=None):
        if endpoint not in ('folded', 'unfolded'):
            return result(False, 'invalid_endpoint')
        if axis is not None and (type(axis) is not int or axis not in (1, 2)):
            return result(False, 'invalid_fold_axis')
        error = self._ready()
        if error:
            return result(False, error)
        error = self._motion_idle()
        if error:
            return result(False, error)
        dual = self.snapshot.get('foldAxisCount') == 2
        if dual and axis is None:
            return result(False, 'explicit_fold_axis_required')
        if not dual and axis == 2:
            return result(False, 'second_fold_axis_unsupported')
        limits = self.snapshot.get('limits', {})
        if limits.get('enabled') is True:
            selected = axis or 1
            target = ('fold' if endpoint == 'folded' else 'unfold') + str(selected)
            other = ('unfold' if endpoint == 'folded' else 'fold') + str(selected)
            if limits.get(target) is not True or limits.get(other) is not False:
                return result(False, 'matching_endpoint_limit_required')
        frame = {'type': 'stepper_zero'} if endpoint == 'folded' else {
            'type': 'stepper_confirm_unfolded', 'confirmed': True}
        if dual:
            frame['axis'] = axis
        return await self._command(frame, frame['type'])

    async def drive(self, linear, turn, duration_ms):
        if any(type(x) is not int for x in (linear, turn, duration_ms)) or not (
                abs(linear) <= 20 and abs(turn) <= 20 and 1 <= duration_ms <= 2000):
            return result(False, 'invalid_software_ceiling')
        error = self._ready()
        if error:
            return result(False, error)
        error = self._motion_idle()
        if error:
            return result(False, error)
        deadline = self.clock() + duration_ms / 1000
        generation = self.generation
        async def drive_loop():
            try:
                while self.clock() < deadline and generation == self.generation:
                    if self._ready():
                        raise RuntimeError('drive_state_lost')
                    await self._send({'type': 'drive', 'linear': linear, 'turn': turn})
                    await asyncio.sleep(min(.1, max(0., deadline - self.clock())))
                if generation == self.generation:
                    await self._send({'type': 'drive_stop'})
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                await self._trip(str(exc))
        self.driver = asyncio.create_task(drive_loop())
        return result(True, 'scheduled_not_acknowledged', phase='scheduled', duration_ms=duration_ms,
                      physical_motion_verified=False)

    async def _watch(self):
        heartbeat = 0.
        try:
            while self.ws is not None:
                self._refresh_arm_barrier()
                if self.arm_barrier is not None and self.clock() - self.arm_barrier[2] > 3.:
                    raise RuntimeError('arm_followup_measurement_timeout')
                if not self.status()['fresh']:
                    raise RuntimeError('status_stale')
                if self.clock() >= heartbeat:
                    await self._send({'type': 'heartbeat'})
                    heartbeat = self.clock() + .25
                await asyncio.sleep(.05)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await self._trip(str(exc))

    async def stop(self):
        # Closing is a generation barrier; no queued ACK can re-enable this socket.
        outcome = await self._shutdown(send_stop=True)
        ok = not outcome['connection_was_open'] or (outcome['stop_command_sent'] and outcome['transport_closed'])
        reason = ('no_connection_physical_stop_unverified' if not outcome['connection_was_open'] else
                  'stop_sent_transport_closed_physical_stop_unverified' if ok else
                  'stop_transport_uncertain_physical_stop_unverified')
        return result(ok, reason, **outcome)

    async def disconnect(self):
        return await self.stop()

    async def confirm_endpoint(self, endpoint, axis):
        return await self.confirm(endpoint, axis)

    async def stop_and_disconnect(self):
        return await self.stop()
