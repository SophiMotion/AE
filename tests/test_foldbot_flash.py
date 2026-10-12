"""Exclusive USB admission tests; no hardware or browser serial is opened."""
import asyncio
import copy
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from server.foldbot_arbiter import FoldBotArbiter
from server.foldbot_flash import FoldBotFlashSessions, create_foldbot_flash_router


BODY = {'project_id': 'project1', 'revision': 1, 'generation_id': 'generation1', 'source_hash': 'a' * 64}


def fixture_sessions(**kwargs):
    state = {'id': 'project1', 'revision': 1, 'reviewed': True,
             'generation': {'id': 'generation1', 'sha256': 'a' * 64}}
    clock, events = [0.], []

    def require_current(project_id, revision):
        if state['id'] != project_id or state['revision'] != revision or not state['reviewed']:
            raise HTTPException(409, 'not_current')
        return copy.deepcopy(state)

    session = FoldBotFlashSessions(require_current, clock=lambda: clock[0], on_event=events.append, **kwargs)
    return session, state, clock, events


def test_construct_and_reserve_only_admit_exclusive_owner_without_hardware_io():
    sessions, _, _, events = fixture_sessions()
    assert sessions.status()['active'] is False
    result = sessions.create_session(BODY)
    assert result['ok'] is True and result['lease_ms'] == 8000
    assert result['phase'] == 'reserved' and result['exclusion_retained'] is True
    assert sessions.arbiter.status() == {'mode': 'usb_flash', 'phase': 'reserved', 'occupied': True}
    assert result['session_id'] not in str(events)
    assert events[0]['operation'] == 'reserved'
    assert events[0]['physical_completion_verified'] is False


@pytest.mark.parametrize('field,value', [('revision', 2), ('project_id', 'project2'), ('generation_id', 'generation2'), ('source_hash', 'b' * 64)])
def test_generation_binding_mismatch_cannot_reserve(field, value):
    sessions, _, _, _ = fixture_sessions()
    with pytest.raises(HTTPException):
        sessions.create_session({**BODY, field: value})
    assert sessions.arbiter.status()['occupied'] is False


@pytest.mark.parametrize('mode', ['console', 'simplified', 'usb_flash'])
def test_shared_arbiter_denies_existing_control_and_other_flash_owner(mode):
    arbiter = FoldBotArbiter()
    assert arbiter.reserve('another_owner', mode)
    sessions, _, _, _ = fixture_sessions(arbiter=arbiter)
    with pytest.raises(HTTPException) as error:
        sessions.create_session(BODY)
    assert error.value.status_code == 409
    assert arbiter.owns('another_owner')


def test_atomic_reservation_allows_only_one_simultaneous_client():
    sessions, _, _, _ = fixture_sessions()

    def attempt(_):
        try:
            return sessions.create_session(BODY)['session_id']
        except HTTPException:
            return None

    with ThreadPoolExecutor(max_workers=8) as executor:
        results = list(executor.map(attempt, range(8)))
    assert sum(value is not None for value in results) == 1


def test_heartbeat_renews_but_expiry_retains_exclusion_and_cannot_resume():
    sessions, _, clock, events = fixture_sessions()
    token = sessions.create_session(BODY)['session_id']
    clock[0] = 7.
    assert sessions.heartbeat(token)['ok'] is True
    clock[0] = 14.
    assert sessions.status()['phase'] == 'reserved'
    clock[0] = 15.
    with pytest.raises(HTTPException) as error:
        sessions.heartbeat(token)
    assert 'expired' in error.value.detail
    assert sessions.arbiter.owns(token)
    status = sessions.status()
    assert status['recovery_required'] is True and status['exclusion_retained'] is True
    assert 'USB' in status['recovery'] and '重启' in status['recovery']
    assert token not in str(status)
    assert not sessions.arbiter.reserve('another', 'console')
    with pytest.raises(HTTPException):
        sessions.create_session(BODY)
    # Even a clock rollback cannot restore an invalidated USB lease.
    clock[0] = 1.
    with pytest.raises(HTTPException):
        sessions.heartbeat(token)
    assert len([event for event in events if event['operation'] == 'invalidated_exclusion_retained']) == 1
    assert sessions.stop(token)['ok'] is True
    assert not sessions.arbiter.status()['occupied']


@pytest.mark.parametrize('mutate', [
    lambda state: state.update(revision=2),
    lambda state: state.update(reviewed=False),
    lambda state: state['generation'].update(id='generation2'),
    lambda state: state['generation'].update(sha256='b' * 64),
])
def test_every_heartbeat_rechecks_current_revision_and_artifact_but_keeps_usb_owner(mutate):
    sessions, state, _, _ = fixture_sessions()
    token = sessions.create_session(BODY)['session_id']
    mutate(state)
    with pytest.raises(HTTPException) as error:
        sessions.heartbeat(token)
    assert 'generation_changed' in error.value.detail
    assert sessions.arbiter.owns(token)
    assert sessions.stop(token)['ok'] is True


def test_wrong_token_cannot_renew_or_release_and_old_stop_cannot_release_next_session():
    sessions, _, _, _ = fixture_sessions()
    first = sessions.create_session(BODY)['session_id']
    for operation in [sessions.heartbeat, sessions.stop]:
        for wrong in ['incorrect', '错误令牌']:
            with pytest.raises(HTTPException):
                operation(wrong)
            assert sessions.arbiter.owns(first)
    result = sessions.stop(first)
    assert result['transport_closed_verified'] is False
    second = sessions.create_session(BODY)['session_id']
    assert sessions.stop(first) == result
    assert sessions.arbiter.owns(second)


def test_shutdown_releases_without_claiming_physical_stop_and_prevents_new_session():
    sessions, _, _, events = fixture_sessions()
    sessions.create_session(BODY)
    asyncio.run(sessions.close())
    assert sessions.arbiter.status()['occupied'] is False
    assert events[-1]['reason'] == 'backend_shutdown_usb_outcome_unknown'
    assert events[-1]['physical_completion_verified'] is False
    with pytest.raises(HTTPException):
        sessions.create_session(BODY)


def test_event_failure_does_not_drop_ownership():
    sessions, _, _, _ = fixture_sessions()

    def failed(_):
        raise RuntimeError('storage unavailable')

    sessions.on_event = failed
    token = sessions.create_session(BODY)['session_id']
    assert sessions.arbiter.owns(token)
    sessions.stop(token)
    assert sessions.arbiter.status()['occupied'] is False


def test_flash_owner_denies_real_controller_and_original_console_before_transport():
    from server.foldbot_console import ConsoleSessionRequest, FoldBotConsoleBridge
    from server.foldbot_control import ConnectRequest
    from test_foldbot_control import fixture_controller

    async def run():
        arbiter = FoldBotArbiter()
        sessions, _, _, _ = fixture_sessions(arbiter=arbiter)
        token = sessions.create_session(BODY)['session_id']
        controller, backend, _ = fixture_controller(arbiter=arbiter)
        console = FoldBotConsoleBridge(arbiter=arbiter)
        with pytest.raises(HTTPException):
            await controller.connect(ConnectRequest(project_id='project1', revision=1, address='192.168.4.1', confirmed=True))
        with pytest.raises(HTTPException):
            await console.create_session(ConsoleSessionRequest(address='192.168.4.1', confirmed=True))
        assert backend.calls == []
        assert arbiter.owns(token)
        await controller.close()
        await console.close()
        assert arbiter.owns(token), 'closing unrelated control endpoints must not release flash'
        await sessions.close()

    asyncio.run(run())


def test_router_is_local_only_strict_and_exposes_recovery_without_secret_token():
    sessions, _, clock, _ = fixture_sessions()
    app = FastAPI()
    app.include_router(create_foldbot_flash_router(sessions))
    with TestClient(app, base_url='http://127.0.0.1:8877') as client:
        endpoint = '/api/foldbot/flash'
        for body in [{**BODY, 'revision': True}, {**BODY, 'source_hash': 'x'}, {**BODY, 'confirmed': True}]:
            assert client.post(endpoint + '/sessions', json=body).status_code == 422
        for headers in [{'origin': 'https://evil.example'}, {'sec-fetch-site': 'cross-site'}, {'host': 'robot.example'}]:
            assert client.post(endpoint + '/sessions', json=BODY, headers=headers).status_code == 403
        response = client.post(endpoint + '/sessions', json=BODY)
        assert response.status_code == 200
        token = response.json()['session_id']
        assert client.post(endpoint + '/heartbeat', json={'session_id': token}).json()['ok'] is True
        clock[0] = 8.
        status = client.get(endpoint + '/status')
        assert status.json()['recovery_required'] is True
        assert token not in status.text
        assert client.post(endpoint + '/heartbeat', json={'session_id': token}).status_code == 409
        assert client.post(endpoint + '/stop', json={'session_id': token}).json()['ok'] is True
