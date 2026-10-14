"""Original console packaging checks; no robot, ROS or network is accessed."""
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('prepare_foldbot_console', ROOT / 'web/scripts/prepare-foldbot-console.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


@pytest.fixture(scope='module')
def source():
    return builder.read_source().decode('utf-8')


@pytest.mark.parametrize('mode', ['local', 'preview'])
def test_generated_assets_match_builder_and_preserve_model(source, mode):
    built = builder.build_console(source, mode)
    actual = (ROOT / f'web/public/foldbot-console-{mode}.html').read_text(encoding='utf-8')
    assert built == actual
    model = re.search(r'<!-- FOLDBOT_REALISTIC_MODEL_BEGIN -->.*?<!-- FOLDBOT_REALISTIC_MODEL_END -->', source, re.S).group(0)
    assert model in built
    for key in ['data-action', 'data-stepper-command', 'data-steps', 'data-pose-capture', 'data-drive-speed']:
        assert set(re.findall(key + r'="([^"]+)"', source)) == set(re.findall(key + r'="([^"]+)"', built))
    assert 'ws://192.168.4.1/ws' not in built
    assert 'scheduleReconnect(' not in built
    assert '固件已执行失联停车' not in built
    assert 'connectSocket(' not in built


def test_preview_is_read_only_and_attach_is_guarded(source):
    preview = builder.build_console(source, 'preview')
    local = builder.build_console(source, 'local')
    assert "connect-src 'none'" in preview
    assert 'const AE_MODE = "preview";' in preview
    assert 'if (AE_MODE !== "local"' in preview
    assert 'event.source !== parent || event.origin !== location.origin' in local
    assert 'wsPath !== "/api/foldbot/console/ws"' in local
    assert 'socket.send(JSON.stringify({type: "ae_auth"' not in local  # auth uses the new socket only
    assert 'ws.send(JSON.stringify({type: "ae_auth", session_id: sessionId}))' in local
    assert 'if (message.type === "ae_ready")' in local
    assert local.index('if (message.type === "ae_ready")') < local.index('startSocketTimers();')
    assert 'function applySimulationCommand() { return false; }' in local
    assert 'if (document.hidden) aeRequestStop("page_hidden")' in local


def test_maintenance_is_explicit_nonblocking_and_token_not_persisted(source):
    local = builder.build_console(source, 'local')
    assert '旧行程将丢失，需要重新标定' in local
    assert '{ae_confirmed: true}' in local
    assert 'payload.ae_confirmed !== true' in local
    assert 'pending.snapshot !== aeSnapshot()' in local
    assert 'setTimeout(() => aeNotify("ready"), 0)' in local
    assert 'window.confirm(' not in local
    assert 'localStorage' not in local
    assert 'sessionStorage' not in local


def test_source_drift_fails_closed(source):
    with pytest.raises(ValueError, match='source drift'):
        builder.build_console(source.replace('      init();', '      changedInit();'), 'local')
    with pytest.raises(ValueError, match='Unknown console mode'):
        builder.build_console(source, 'live')


def test_endpoint_confirmation_recovers_after_initial_disconnected_render(source):
    local = builder.build_console(source, 'local')
    assert 'document.getElementById("endpointConfirmApply").disabled = !live' in local
    assert 'document.getElementById("endpointConfirmCancel").disabled = !live || !pendingEndpointReference' in local
    assert 'panel.hidden = false;\n        updateUI();\n        panel.scrollIntoView' in local
    assert '(state.limits && state.limits.enabled ? " 位置参考未知' in local
    assert '(state.limits && state.limits.enabled ? "位置参考未知' in local
    assert '机器人已停车' not in local


def test_buffered_arm_release_revokes_instead_of_dropping_stop(source):
    local = builder.build_console(source, 'local')
    safety = 'payload.type === "jog_state" && !payload.dir.some(Boolean) && socket.bufferedAmount > 0'
    assert safety in local
    assert local.index(safety) < local.index('if (["drive", "jog_state"].includes(payload.type) && socket.bufferedAmount > 0)')
    assert 'aeRequestStop("arm_stop_transport_buffered")' in local


def test_provenance_tracks_outputs():
    import hashlib
    record = json.loads((ROOT / 'web/public/foldbot-console-provenance.json').read_text(encoding='utf-8'))
    assert record['source_html_sha256'] == builder.EXPECTED_HTML_SHA256
    assert record['hardware_verified'] is False
    for output in record['outputs']:
        data = (ROOT / 'web/public' / output['path']).read_bytes()
        assert output['sha256'] == hashlib.sha256(data).hexdigest()
        assert output['bytes'] == len(data)


@pytest.mark.parametrize('mode', ['local', 'preview'])
def test_javascript_syntax(source, mode):
    node = shutil.which('node')
    if not node:
        pytest.skip('Node is not installed')
    scripts = re.findall(r'<script[^>]*>(.*?)</script>', builder.build_console(source, mode), re.S)
    result = subprocess.run([node, '--check'], input='\n'.join(scripts), text=True,
                            encoding='utf-8', capture_output=True, timeout=30)
    assert result.returncode == 0, result.stderr
