"""Exclusive browser USB ownership; this service never opens or writes a device.

Expiry invalidates a token but deliberately retains the shared hardware exclusion:
the backend cannot prove that a browser USB write stopped. Only the originating
browser's explicit stop after transport cleanup, or process shutdown, releases it.
"""
from __future__ import annotations

import secrets
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field, StrictInt, StrictStr

from .foldbot_arbiter import FoldBotArbiter
from .foldbot_control import SessionRequest, StrictRequest, _local_request


class FlashSessionRequest(StrictRequest):
    project_id: Annotated[StrictStr, Field(min_length=1, max_length=100, pattern=r'^[A-Za-z0-9_-]+$')]
    revision: Annotated[StrictInt, Field(gt=0, le=9007199254740991)]
    generation_id: Annotated[StrictStr, Field(min_length=1, max_length=100, pattern=r'^[A-Za-z0-9_-]+$')]
    source_hash: Annotated[StrictStr, Field(pattern=r'^[a-f0-9]{64}$')]


@dataclass
class _FlashSession:
    token: str
    binding: FlashSessionRequest
    expires_at: float
    phase: str = 'reserved'
    reason: str = 'exclusive_usb_reserved'


class FoldBotFlashSessions:
    def __init__(self, require_current_generation, *, arbiter=None, clock=time.monotonic,
                 lease_seconds=8., on_event=None):
        if not 0 < lease_seconds <= 8.:
            raise ValueError('invalid_flash_lease')
        self.require_current_generation = require_current_generation
        self.arbiter = arbiter if arbiter is not None else FoldBotArbiter()
        self.clock, self.lease_seconds, self.on_event = clock, lease_seconds, on_event
        self.active = None
        self.retired = OrderedDict()
        self.closing = False
        self._lock = threading.RLock()

    def _event(self, session, operation, reason):
        if self.on_event is None:
            return
        # Tokens, source contents, AP passwords and user prompts are never logged.
        event = dict(mode='usb_flash', operation=operation, reason=reason,
                     project_id=session.binding.project_id, revision=session.binding.revision,
                     generation_id=session.binding.generation_id, time_ms=int(time.time() * 1000),
                     physical_completion_verified=False, transport_closed_verified=False)
        try:
            self.on_event(event)
        except Exception:
            # Audit storage failure must not release a live hardware exclusion.
            pass

    def _validate_binding(self, binding):
        current = self.require_current_generation(binding.project_id, binding.revision)
        generation = current.get('generation') or {}
        if (generation.get('id') != binding.generation_id or
                generation.get('sha256') != binding.source_hash):
            raise HTTPException(409, 'flash_generation_binding_mismatch')

    def _invalidate(self, session, reason):
        if session.phase != 'stale':
            session.phase, session.reason = 'stale', reason
            self.arbiter.stopping(session.token)
            self._event(session, 'invalidated_exclusion_retained', reason)

    def _refresh(self):
        session = self.active
        if session is not None and session.phase != 'stale':
            if self.clock() >= session.expires_at:
                self._invalidate(session, 'flash_lease_expired_usb_outcome_unknown')
            else:
                try:
                    self._validate_binding(session.binding)
                except Exception:
                    self._invalidate(session, 'flash_generation_changed_usb_outcome_unknown')
        return session

    def _status(self):
        session = self._refresh()
        return {
            'active': session is not None,
            'phase': session.phase if session else 'idle',
            'reason': session.reason if session else 'no_flash_session',
            'mode': 'usb_flash' if session else None,
            'project_id': session.binding.project_id if session else None,
            'revision': session.binding.revision if session else None,
            'exclusion_retained': session is not None,
            'remaining_ms': max(0, int((session.expires_at - self.clock()) * 1000)) if session else 0,
            'recovery_required': session is not None and session.phase == 'stale',
            'recovery': ('先关闭原烧录页面的串口连接。页面已丢失时，关闭相关页面并拔下 USB，'
                         '确认设备停止后重启本机 AE 后台；租约到期不会自动解除占用。') if session and session.phase == 'stale' else None,
            'physical_completion_verified': False,
            'transport_closed_verified': False,
        }

    def status(self):
        with self._lock:
            return self._status()

    def create_session(self, body):
        body = body if isinstance(body, FlashSessionRequest) else FlashSessionRequest.model_validate(body)
        with self._lock:
            if self.closing:
                raise HTTPException(409, 'flash_service_closing')
            existing = self._refresh()
            if existing is not None:
                reason = ('flash_recovery_required_close_usb_then_restart_backend' if existing.phase == 'stale'
                          else 'flash_session_already_active')
                raise HTTPException(409, reason)
            self._validate_binding(body)
            token = secrets.token_urlsafe(32)
            if not self.arbiter.reserve(token, 'usb_flash'):
                raise HTTPException(409, 'foldbot_control_or_flash_already_active')
            session = _FlashSession(token, body.model_copy(deep=True), self.clock() + self.lease_seconds)
            self.active = session
            self._event(session, 'reserved', session.reason)
            return {'ok': True, 'session_id': token, 'lease_ms': int(self.lease_seconds * 1000),
                    **self._status()}

    def heartbeat(self, token):
        with self._lock:
            session = self._refresh()
            if session is None or not isinstance(token, str) or not token.isascii() or not secrets.compare_digest(session.token, token):
                raise HTTPException(404, 'flash_session_not_found')
            if session.phase == 'stale':
                raise HTTPException(409, session.reason + '_close_transport_then_stop')
            if not self.arbiter.owns(session.token):
                self._invalidate(session, 'flash_exclusion_lost')
                raise HTTPException(409, 'flash_exclusion_lost_close_transport_then_stop')
            session.expires_at = self.clock() + self.lease_seconds
            return {'ok': True, 'lease_ms': int(self.lease_seconds * 1000), **self._status()}

    def stop(self, token):
        """Called only after browser transport cleanup; cannot independently verify USB."""
        with self._lock:
            if token in self.retired:
                return dict(self.retired[token])
            session = self.active
            if session is None or not isinstance(token, str) or not token.isascii() or not secrets.compare_digest(session.token, token):
                raise HTTPException(404, 'flash_session_not_found')
            self.arbiter.release(session.token)
            self.active = None
            self._event(session, 'released', 'browser_explicit_release_after_transport_cleanup')
            result = {'ok': True, 'phase': 'closed', 'reason': 'flash_exclusion_released',
                      'physical_completion_verified': False, 'transport_closed_verified': False}
            self.retired[token] = result
            while len(self.retired) > 100:
                self.retired.popitem(last=False)
            return dict(result)

    async def close(self):
        with self._lock:
            self.closing = True
            if self.active is not None:
                session = self.active
                self.arbiter.release(session.token)
                self.active = None
                self._event(session, 'released', 'backend_shutdown_usb_outcome_unknown')


def create_foldbot_flash_router(sessions: FoldBotFlashSessions):
    router = APIRouter(prefix='/api/foldbot/flash', tags=['foldbot-flash'],
                       dependencies=[Depends(_local_request)])

    @router.post('/sessions')
    def create(body: FlashSessionRequest):
        return sessions.create_session(body)

    @router.post('/heartbeat')
    def heartbeat(body: SessionRequest):
        return sessions.heartbeat(body.session_id)

    @router.post('/stop')
    def stop(body: SessionRequest):
        return sessions.stop(body.session_id)

    @router.get('/status')
    def status():
        return sessions.status()

    return router
