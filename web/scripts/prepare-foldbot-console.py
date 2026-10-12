"""Build the original console's local bridge and network-free preview copies.

Only audited repository assets are read. This script never connects to a robot.
"""
from __future__ import annotations

import gzip
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'worker' / 'foldbot_web_ui.h'
EXPECTED_HTML_SHA256 = '2a6fdec202481a80ed9554e4adc73bec3f5d17ab97f5121c6d08e5715cb2b89b'


def replace_once(text: str, old: str, new: str) -> str:
    if text.count(old) != 1:
        raise ValueError(f'Console source drift: expected one marker {old[:75]!r}')
    return text.replace(old, new, 1)


def replace_region(text: str, start: str, end: str, replacement: str) -> str:
    if text.count(start) != 1 or text.count(end) != 1:
        raise ValueError(f'Console source region drift: {start!r}')
    left, right = text.index(start), text.index(end)
    if right <= left:
        raise ValueError('Console source markers reversed')
    return text[:left] + replacement + '\n\n' + text[right:]


BRIDGE = r'''
      // AE bridge adapter. Original presentation/model and command controls follow.
      const AE_MODE = __MODE__;
      const AE_CHANNEL = "ae-foldbot-console";
      const AE_MAINTENANCE = new Set(["stepper_save", "stepper_reset", "stepper_direction", "pose_capture", "arm_path_confirm"]);
      let aeAuthorized = false;
      let aeEpoch = 0;
      let aePendingMaintenance = null;

      function aeNotify(type, detail) {
        if (parent !== window && location.origin !== "null") {
          parent.postMessage(Object.assign({channel: AE_CHANNEL, type}, detail || {}), location.origin);
        }
      }

      function aeCancelMaintenance() {
        aePendingMaintenance = null;
        document.getElementById("aeMaintenanceConfirm").hidden = true;
      }

      function aeSnapshot() {
        return JSON.stringify([endpointSnapshot(), state.armPoseSaved, state.showcasePathVerified,
          state.armReturnState, state.joints.map(j => [j.id, j.position, j.online, j.calibrated, j.stale])]);
      }

      function aeAskMaintenance(payload) {
        if (!aeAuthorized || !dualStatusFresh() || !state.motionEnabled || !foldingIdle()) return false;
        const descriptions = {
          stepper_save: "将选中轴当前脉冲位置覆盖保存为展开行程。请确认实物确在展开端。",
          stepper_reset: "清除选中轴已保存的行程。旧行程将丢失，需要重新标定。",
          stepper_direction: "切换选中轴方向并清除其旧行程。旧行程将丢失，需要重新标定。",
          pose_capture: "保存当前六关节姿态，将覆盖这个名称原来保存的姿态。",
          arm_path_confirm: "只在实物上逐段低速验证过全部示教路径后确认。保存姿态不代表路径已验证。"
        };
        aePendingMaintenance = {payload: Object.assign({}, payload), epoch: aeEpoch, snapshot: aeSnapshot()};
        document.getElementById("aeMaintenanceText").textContent =
          (payload.axis ? "轴 " + payload.axis + "：" : "") + descriptions[payload.type] +
          (payload.name ? " 姿态：" + (ARM_POSE_LABELS[payload.name] || payload.name) : "");
        document.getElementById("aeMaintenanceConfirm").hidden = false;
        showNotice("尚未发送：请核对本次维护操作，再点击确认。", "warn");
        updateUI();
        return true;
      }

      function aeConfirmMaintenance() {
        const pending = aePendingMaintenance;
        aeCancelMaintenance();
        if (!pending || pending.epoch !== aeEpoch || !aeAuthorized || !dualStatusFresh() ||
            pending.snapshot !== aeSnapshot()) {
          showNotice("状态已经变化，本次维护未发送；请重新核对后操作。", "danger");
          updateUI();
          return;
        }
        const sent = sendSocketMessage(Object.assign({}, pending.payload, {ae_confirmed: true}));
        showNotice(sent ? "维护请求已发送，等待主控确认；不代表实物验证完成。" : "维护请求未发送，请检查连接。", sent ? "info" : "danger");
        updateUI();
      }

      function aeClose(reason, stopResult, notify) {
        const hadSession = !!socket || aeAuthorized;
        ++aeEpoch;
        aeAuthorized = false;
        aeCancelMaintenance();
        cancelEndpointReference();
        stopSocketTimers();
        clearTimeout(armInput.holdTimer);
        clearInterval(armInput.repeatTimer);
        armInput.holdTimer = null;
        armInput.repeatTimer = null;
        armInput.active = null;
        armInput.directions.fill(0);
        keyboardDrive.clear();
        state.joystick.active = false;
        state.joystick.keyboardActive = false;
        state.joystick.pointerId = null;
        resetJoystickVisual();
        clearSimulationSequence();
        const old = socket;
        socket = null;
        if (old) { try { old.close(); } catch (_) {} }
        state.connection = "disconnected";
        state.motionEnabled = false;
        state.liveSocketOpen = false;
        state.linear = 0;
        state.turn = 0;
        state.lastStatusAt = 0;
        state.joints.forEach(j => { j.online = false; j.stale = true; });
        updateUI();
        if (notify !== false && hadSession) aeNotify("closed", {reason: reason || "connection_closed", stop_result: stopResult || null});
      }

      function aeAttach(sessionId, wsPath) {
        if (AE_MODE !== "local" || document.hidden || aeAuthorized || socket ||
            !["127.0.0.1", "localhost", "[::1]"].includes(location.hostname) ||
            !["8877", "5178"].includes(location.port) || location.protocol !== "http:" ||
            typeof sessionId !== "string" || !sessionId || sessionId.length > 200 ||
            wsPath !== "/api/foldbot/console/ws") {
          aeNotify("error", {reason: "attach_not_allowed"});
          return;
        }
        const epoch = ++aeEpoch;
        state.connection = "connecting";
        updateUI();
        let ws;
        try { ws = new WebSocket("ws://" + location.host + wsPath); }
        catch (_) { aeNotify("error", {reason: "bridge_open_failed"}); aeClose("bridge_open_failed", null); return; }
        socket = ws;
        ws.addEventListener("open", () => {
          if (socket !== ws || epoch !== aeEpoch) return;
          try { ws.send(JSON.stringify({type: "ae_auth", session_id: sessionId})); }
          catch (_) { aeClose("bridge_auth_failed", null); }
          sessionId = "";
        });
        ws.addEventListener("message", event => {
          if (socket !== ws || epoch !== aeEpoch) return;
          let message;
          try { message = JSON.parse(String(event.data)); } catch (_) { return; }
          if (!message || typeof message !== "object") return;
          if (message.type === "ae_ready") {
            if (aeAuthorized) return;
            aeAuthorized = true;
            state.connection = "live";
            state.liveSocketOpen = true;
            state.simReason = "";
            startSocketTimers();
            sendSocketMessage({type: "hello", version: 1});
            requestStatus();
            updateUI();
            aeNotify("connected");
            return;
          }
          if (message.type === "ae_closed" || message.type === "ae_error") {
            const reason = typeof message.reason === "string" ? message.reason : "bridge_closed";
            if (message.type === "ae_error") aeNotify("error", {reason});
            showNotice("连接已结束：" + reason + "。停止结果请现场核对，不会自动重连。", "danger");
            aeClose(reason, message.stop_result);
            return;
          }
          if (!aeAuthorized) return;
          state.lastReceiveAt = performance.now();
          if (message.type === "status") applyStatus(message);
          else if (message.type === "error") showNotice(errorLabel(message.reason || "command_rejected"), "danger");
          else if (message.type === "ack" && message.command !== "heartbeat") {
            showNotice((message.command || "命令") + "：" + (message.message || message.reason || "已接收") +
              "；不代表实物到位。", message.ok === false ? "danger" : "info");
            if (message.command === "pose_capture" || message.command === "arm_path_confirm") requestStatus();
          }
        });
        ws.addEventListener("close", () => {
          if (socket !== ws || epoch !== aeEpoch) return;
          showNotice("与控制器断开，停止结果未知；请现场核对，重新连接后再使能。", "danger");
          aeClose("transport_closed", null);
        });
        ws.addEventListener("error", () => {
          if (socket !== ws || epoch !== aeEpoch) return;
          aeNotify("error", {reason: "bridge_transport_error"});
          aeClose("bridge_transport_error", null);
        });
      }

      function aeRequestStop(reason) {
        if (socket && socket.readyState === WebSocket.OPEN && aeAuthorized) {
          try { socket.send(JSON.stringify({type: "stop_all"})); } catch (_) {}
        }
        aeClose(reason || "operator_stop", null);
      }

      function aeInit() {
        state.connection = "disconnected";
        state.joints.forEach(j => { j.online = false; j.stale = true; });
        document.getElementById("aeMaintenanceAccept").addEventListener("click", aeConfirmMaintenance);
        document.getElementById("aeMaintenanceCancel").addEventListener("click", () => { aeCancelMaintenance(); updateUI(); });
        window.addEventListener("message", event => {
          if (event.source !== parent || event.origin !== location.origin || parent === window ||
              !event.data || event.data.channel !== AE_CHANNEL) return;
          if (event.data.type === "detach") aeRequestStop("parent_detach");
          if (event.data.type === "attach") aeAttach(event.data.session_id, event.data.ws_path);
        });
        if (document.readyState === "complete") setTimeout(() => aeNotify("ready"), 0);
        else window.addEventListener("load", () => aeNotify("ready"), {once: true});
      }

      function updateUI() {
        renderOriginalUI();
        const live = AE_MODE === "local" && aeAuthorized && dualStatusFresh();
        document.querySelectorAll("button").forEach(button => {
          if (!live && !["stopBtn", "aeMaintenanceCancel"].includes(button.id)) button.disabled = true;
          if (aePendingMaintenance && !["stopBtn", "aeMaintenanceAccept", "aeMaintenanceCancel"].includes(button.id)) button.disabled = true;
        });
        if (live) {
          document.getElementById("aeMaintenanceAccept").disabled = !aePendingMaintenance;
          document.getElementById("aeMaintenanceCancel").disabled = false;
        }
        if (aePendingMaintenance && (!live || aePendingMaintenance.snapshot !== aeSnapshot())) aeCancelMaintenance();
        dom.reconnectBtn.disabled = true;
        dom.reconnectBtn.textContent = "请在 AE 上方连接";
        dom.motionToggle.disabled = !live || anotherControllerOwnsMotion() || !!aePendingMaintenance;
        dom.stopBtn.disabled = AE_MODE === "preview" || (!socket && !aeAuthorized);
        document.getElementById("endpointConfirmApply").disabled = !live || !!aePendingMaintenance ||
          !pendingEndpointReference || !endpointReferenceAllowed(pendingEndpointReference.type, pendingEndpointReference.axis) ||
          pendingEndpointReference.snapshot !== endpointSnapshot();
        document.getElementById("endpointConfirmCancel").disabled = !live || !pendingEndpointReference;
        dom.joystick.setAttribute("aria-disabled", String(!live));
        dom.joystick.tabIndex = live ? 0 : -1;
        document.getElementById("maintenanceAxis").disabled = !live || !foldingIdle() || !!aePendingMaintenance;
        if (!live) {
          dom.modeValue.textContent = AE_MODE === "preview" ? "只读展示 · 未连接机器人" : "未连接或状态过期 · 操作已禁用";
          dom.protocolValue.textContent = "AE 本机桥 · 未授权不连接";
          dom.jointModeValue.textContent = "未连接或状态过期，不能控制实物";
          dom.latencyValue.textContent = "无有效实时状态";
        }
      }
'''


def build_console(source: str, mode: str) -> str:
    if mode not in {'local', 'preview'}:
        raise ValueError('Unknown console mode')
    connect = "'none'" if mode == 'preview' else (
        "ws://127.0.0.1:8877 ws://localhost:8877 ws://[::1]:8877 "
        "ws://127.0.0.1:5178 ws://localhost:5178 ws://[::1]:5178")
    csp = ("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
           f"img-src data:; connect-src {connect}; object-src 'none'; base-uri 'none'; form-action 'none'")
    text = replace_once(source, '<meta charset="utf-8">', '<meta charset="utf-8">\n  '
                        + f'<meta http-equiv="Content-Security-Policy" content="{csp}">')
    panel = '''<section id="aeMaintenanceConfirm" class="mode-banner" hidden role="region" aria-label="本次维护确认" style="position:sticky;top:80px;z-index:25;flex-wrap:wrap">
      <strong>本次维护确认</strong><span id="aeMaintenanceText"></span>
      <button id="aeMaintenanceAccept" type="button" class="btn tonal">确认本次操作</button>
      <button id="aeMaintenanceCancel" type="button" class="btn tonal">取消</button>
    </section>'''
    text = replace_once(text, '    <div class="dashboard">', panel + '\n    <div class="dashboard">')
    text = replace_once(text, '      init();', BRIDGE.replace('__MODE__', json.dumps(mode)) + '\n      init();')
    text = replace_once(text, '''        if (location.protocol === "file:") {
          activateSimulation("file");
        } else {
          connectSocket();
        }''', '        aeInit();')
    text = replace_region(text, '        dom.reconnectBtn.addEventListener("click", () => {',
                          '        document.querySelectorAll("[data-action]").forEach((button) => {\n          button.addEventListener',
                          '        dom.reconnectBtn.disabled = true;')
    text = replace_region(text, '      function connectSocket(force) {', '      function startSocketTimers()', '')
    text = replace_region(text, '      function cleanupSocket() {', '      function sendSocketMessage(payload)', '')
    text = replace_region(text, '      function sendSocketMessage(payload) {', '      function applyStatus(message)', r'''
      function sendSocketMessage(payload) {
        if (!aeAuthorized || AE_MODE !== "local" || !socket || socket.readyState !== WebSocket.OPEN) return false;
        if (AE_MAINTENANCE.has(payload.type) && payload.ae_confirmed !== true) return false;
        if (payload.type === "stop_all" || payload.type === "stop") { aeRequestStop("operator_stop"); return true; }
        if (!["hello", "heartbeat", "status_request", "drive_stop"].includes(payload.type) && !dualStatusFresh()) {
          aeRequestStop("status_stale");
          return false;
        }
        if (payload.type === "jog_state" && !payload.dir.some(Boolean) && socket.bufferedAmount > 0) {
          aeRequestStop("arm_stop_transport_buffered");
          return false;
        }
        if (["drive", "jog_state"].includes(payload.type) && socket.bufferedAmount > 0) return false;
        try { socket.send(JSON.stringify(payload)); return true; }
        catch (_) { aeNotify("error", {reason: "command_send_failed"}); aeClose("command_send_failed", null); return false; }
      }

      function sendCommand(payload) {
        if (AE_MAINTENANCE.has(payload.type)) return aeAskMaintenance(payload);
        const sent = sendSocketMessage(payload);
        if (!sent) showNotice("命令未发送，不能用演示状态代替实物反馈。", "danger");
        return sent;
      }

      function requestStatus() {
        if (aeAuthorized) sendSocketMessage({type: "status_request"});
      }
''')
    text = replace_once(text, '''        if (state.connection !== "live") {
          applySimulationCommand({ type: "motion_enable", enabled: next });
          return;
        }''', '''        if (!aeAuthorized || !dualStatusFresh()) return;''')
    text = replace_region(text, '      function applySimulationCommand(payload) {', '      function applySimulationArmDirections',
                          '      function applySimulationCommand() { return false; }')
    text = replace_region(text, '      function handleVisibilityChange() {', '      function releaseDrivePointer(event)', r'''
      function handleVisibilityChange() {
        if (document.hidden) aeRequestStop("page_hidden");
      }

      function handlePageHide() { aeRequestStop("page_hidden"); }
''')
    text = replace_once(text, '      function updateUI() {\n        const onlineCount', '      function renderOriginalUI() {\n        const onlineCount')
    text = replace_once(text, '''        panel.hidden = false;
        panel.scrollIntoView({block:"nearest",behavior:"auto"});''', '''        panel.hidden = false;
        updateUI();
        panel.scrollIntoView({block:"nearest",behavior:"auto"});''')
    text = replace_once(text, '''        document.getElementById("endpointConfirmCancel").addEventListener("click", cancelEndpointReference);''',
                        '''        document.getElementById("endpointConfirmCancel").addEventListener("click", () => { cancelEndpointReference(); updateUI(); });''')
    for name in ['ensureMotionGuard', 'ensureArmGuard', 'ensureDriveGuard']:
        text = replace_once(text, f'      function {name}() {{', f'      function {name}() {{\n        if (!aeAuthorized || !dualStatusFresh() || aePendingMaintenance) return false;')
    text = replace_once(text, '''        if (!sendSocketMessage({type:"pose_capture", name})) {
          showNotice("姿态保存未送达主控，请检查连接后重试。", "danger");
          return;
        }
        showNotice("已发送“" + ARM_POSE_LABELS[name] + "”保存请求，等待主控确认。", "info");''',
                        '        aeAskMaintenance({type: "pose_capture", name});')
    text = replace_once(text, '''        if (!sendSocketMessage({type:"arm_path_confirm"})) {
          showNotice("路径确认未送达主控，请检查连接后重试。", "danger");
          return;
        }
        showNotice("路径确认已发送，等待主控反馈；请只在实物逐段验证后使用。", "info");''',
                        '        aeAskMaintenance({type: "arm_path_confirm"});')
    text = replace_region(text, '      function connectionLabel() {', '      function heartbeatAgeLabel()', r'''
      function connectionLabel() {
        if (aeAuthorized && dualStatusFresh()) return "实时在线";
        if (state.connection === "connecting") return "等待本机桥核验";
        return AE_MODE === "preview" ? "只读展示" : "未连接 / 状态失效";
      }
''')
    text = replace_once(text, '''    const preview = location.protocol === 'file:' || window.__FOLDBOT_UI_TEST__;''',
                        f'''    const preview = {str(mode == 'preview').lower()};''')
    text = replace_region(text, "    banner.textContent = window.__FOLDBOT_UI_TEST__", '    const ready = !action.disabled;',
                          '''    banner.textContent = preview
      ? '只读展示 · 未连接机器人。3D 可旋转查看；所有实物操作均被禁用。'
      : '未建立有效实物连接 · 请在 AE 上方连接 ESP。模型不是实物测量，停止结果需要现场核对。';''')
    text = replace_once(text, '限位显示“触发或断线”时需结合实物检查。首次先保存两轴行程；上电保持不动，点击回零才运动。',
                        '当前适配无限位固件，不能自动回零。上电保持不动，按实物分别确认两块板的实际端位；保留已有行程。')
    text = replace_once(text, '(state.limits ? " 位置参考未知：请先执行上方“双板依次回零”。"',
                        '(state.limits && state.limits.enabled ? " 位置参考未知：请先执行上方“双板依次回零”。"')
    text = replace_once(text, '(state.limits ? "位置参考未知：请先点击上方“双板依次回零”；首次需保存各轴行程。"',
                        '(state.limits && state.limits.enabled ? "位置参考未知：请先点击上方“双板依次回零”；首次需保存各轴行程。"')
    text = replace_once(text, 'heartbeat_timeout: "控制心跳中断，机器人已停车"',
                        'heartbeat_timeout: "控制心跳中断，主控请求停止；请现场确认"')
    if 'ws://192.168.4.1/ws' in text or 'scheduleReconnect(' in text or 'connectSocket(' in text:
        raise ValueError('Unadapted robot transport remains')
    return text


def read_source() -> bytes:
    header = SOURCE.read_text(encoding='utf-8')
    data = gzip.decompress(bytes(int(value, 16) for value in re.findall(r'0x([0-9a-fA-F]{2})', header)))
    if hashlib.sha256(data).hexdigest() != EXPECTED_HTML_SHA256:
        raise ValueError('Audited FoldBot console hash changed; inspect source before regenerating')
    return data


def main() -> None:
    original = read_source()
    target = ROOT / 'web' / 'public'
    outputs = []
    for mode in ('local', 'preview'):
        data = build_console(original.decode('utf-8'), mode).encode('utf-8')
        name = f'foldbot-console-{mode}.html'
        (target / name).write_bytes(data)
        outputs.append({'path': name, 'mode': mode, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    provenance = {
        'schema_version': 1, 'source': 'worker/foldbot_web_ui.h',
        'source_html_sha256': EXPECTED_HTML_SHA256,
        'source_build': 'foldbot-20260929-sophicar-external-driver-no-limits',
        'transformations': ['preserve original model and controls', 'explicit same-origin AE bridge attach',
                            'no automatic reconnect or simulation command fallback',
                            'nonblocking per-operation maintenance confirmation',
                            'read-only preview with connect-src none'],
        'outputs': outputs, 'robot_accessed': False, 'hardware_verified': False,
    }
    (target / 'foldbot-console-provenance.json').write_text(json.dumps(provenance, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'generated': len(outputs), 'source_verified': True, 'hardware_verified': False}))


if __name__ == '__main__':
    main()
