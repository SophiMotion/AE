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


MODEL_VIEWER = r'''
<script>
(function(){
  "use strict";
  const channel = "ae-foldbot-model-preview";
  const canvas = document.getElementById("model");
  const label = document.getElementById("label");
  const notify = type => { if(parent !== window && location.origin !== "null") parent.postMessage({channel,type}, location.origin); };
  function validPose(p) {
    const finite=(v,a,b)=>typeof v === "number" && Number.isFinite(v) && v>=a && v<=b;
    return p && typeof p === "object" && !Array.isArray(p) &&
      Object.keys(p).sort().join(",") === "fold1,fold2,joints,tracks" &&
      finite(p.fold1,0,1) && finite(p.fold2,0,1) &&
      Array.isArray(p.joints) && p.joints.length===6 && p.joints.every((v,i)=>finite(v,i===5?0:-1,1)) &&
      Array.isArray(p.tracks) && p.tracks.length===2 && p.tracks.every(v=>finite(v,-1000,1000));
  }
  let renderer, scene, camera, model, resizeObserver;
  let yaw=.72,pitch=.30,distance=10.8,targetY=1.5,drag=null;
  function render(){ if(!renderer)return; camera.position.set(Math.sin(yaw)*Math.cos(pitch)*distance, targetY+Math.sin(pitch)*distance, Math.cos(yaw)*Math.cos(pitch)*distance);camera.lookAt(0,targetY,0);renderer.render(scene,camera); }
  function resize(){ if(!renderer)return;const w=Math.max(1,canvas.clientWidth),h=Math.max(1,canvas.clientHeight);renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();render(); }
  try {
    renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:false});
    renderer.setPixelRatio(Math.min(devicePixelRatio||1,1.5));
    renderer.outputColorSpace=THREE.SRGBColorSpace;
    renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
    scene=new THREE.Scene();scene.background=new THREE.Color(0xf3f6fb);
    camera=new THREE.PerspectiveCamera(42,1,.1,100);
    scene.add(new THREE.HemisphereLight(0xffffff,0x8191a2,2.4));
    const light=new THREE.DirectionalLight(0xffffff,3);light.position.set(5,10,6);light.castShadow=true;light.shadow.mapSize.set(1024,1024);light.shadow.camera.left=-6;light.shadow.camera.right=6;light.shadow.camera.top=9;light.shadow.camera.bottom=-6;scene.add(light);
    const floor=new THREE.Mesh(new THREE.PlaneGeometry(40,40),new THREE.MeshStandardMaterial({color:0xecf0f5,roughness:1}));floor.rotation.x=-Math.PI/2;floor.position.y=-.03;floor.receiveShadow=true;scene.add(floor);
    const grid=new THREE.GridHelper(30,30,0xb3bfd2,0xdde3ed);grid.position.y=-.02;scene.add(grid);
    model=FoldBotModel.create(THREE,{stage:"final"});scene.add(model.root);
    model.setPose({fold1:0,fold2:0,joints:[0,0,0,0,0,.4]});
    targetY=model.getBounds().getCenter(new THREE.Vector3()).y;
    resizeObserver=new ResizeObserver(resize);resizeObserver.observe(canvas);resize();
    canvas.addEventListener("pointerdown",e=>{if(e.button!==0)return;drag={id:e.pointerId,x:e.clientX,y:e.clientY};canvas.setPointerCapture(e.pointerId);});
    canvas.addEventListener("pointermove",e=>{if(!drag||drag.id!==e.pointerId)return;yaw-=(e.clientX-drag.x)*.007;pitch=Math.max(-.15,Math.min(1.2,pitch+(e.clientY-drag.y)*.007));drag={id:e.pointerId,x:e.clientX,y:e.clientY};render();});
    const release=()=>{drag=null;};canvas.addEventListener("pointerup",release);canvas.addEventListener("pointercancel",release);canvas.addEventListener("lostpointercapture",release);
    canvas.addEventListener("wheel",e=>{e.preventDefault();distance=Math.max(6,Math.min(22,distance*Math.exp(e.deltaY*.001)));render();},{passive:false});
    canvas.addEventListener("keydown",e=>{if(["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","+","-"].includes(e.key)){e.preventDefault();if(e.key==="ArrowLeft")yaw-=.12;if(e.key==="ArrowRight")yaw+=.12;if(e.key==="ArrowUp")pitch=Math.min(1.2,pitch+.08);if(e.key==="ArrowDown")pitch=Math.max(-.15,pitch-.08);if(e.key==="+")distance=Math.max(6,distance-1);if(e.key==="-")distance=Math.min(22,distance+1);render();}});
    document.getElementById("reset").addEventListener("click",()=>{yaw=.72;pitch=.30;distance=10.8;render();});
    window.addEventListener("message",event=>{
      const data=event.data;
      if(event.source!==parent||event.origin!==location.origin||parent===window||!data||data.channel!==channel||data.type!=="pose"||!validPose(data.pose)||!["zh-CN","en"].includes(data.locale))return;
      model.setPose(data.pose);model.setTrackPhase(...data.pose.tracks);targetY=model.getBounds().getCenter(new THREE.Vector3()).y;render();
      const english=data.locale==="en";
      document.documentElement.lang=english?"en":"zh-CN";
      label.textContent=english?"FoldBot · Visual preview":"FoldBot · 模型预览";
      canvas.setAttribute("aria-label",english?"FoldBot 3D model. Drag or use arrow keys to orbit; plus/minus to zoom.":"FoldBot 三维模型。拖动或方向键旋转，加减键缩放。");
      document.getElementById("reset").textContent=english?"Reset view":"复位视角";
    });
    window.addEventListener("pagehide",()=>{resizeObserver.disconnect();model.dispose();renderer.dispose();});
    notify("ready");
  } catch(error) {
    label.textContent="3D unavailable / 三维视图不可用";notify("render-error");
  }
})();
</script>'''


def build_model_preview(source: str) -> str:
    """Only geometry and a display-only viewer; never include the console transport."""
    scripts = re.findall(r'<script[^>]*>(.*?)</script>', source, re.S)
    three = [s for s in scripts if 'Copyright 2010-2023 Three.js Authors' in s]
    model = re.findall(r'<!-- FOLDBOT_REALISTIC_MODEL_BEGIN -->(.*?)<!-- FOLDBOT_REALISTIC_MODEL_END -->', source, re.S)
    if len(three) != 1 or len(model) != 1:
        raise ValueError('Audited model or THREE source region drift')
    csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
    return f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="{csp}">
<title>FoldBot model preview</title><style>
*{{box-sizing:border-box}}html,body{{margin:0;width:100%;height:100%;overflow:hidden;font-family:system-ui,sans-serif;color:#243144;background:#f3f6fb}}
canvas{{width:100%;height:100%;display:block;touch-action:none;outline-offset:-4px}}canvas:focus-visible{{outline:3px solid #002fa7}}
.bar{{position:absolute;left:16px;right:16px;top:14px;display:flex;align-items:center;justify-content:space-between;gap:8px;pointer-events:none}}#label{{font-size:12px;font-weight:600;background:#ffffffdb;padding:7px 10px;border-radius:7px}}button{{pointer-events:auto;font:inherit;font-size:12px;border:1px solid #cbd5e1;background:#fff;border-radius:7px;padding:7px 10px;color:#002fa7;cursor:pointer}}button:focus-visible{{outline:3px solid #002fa7}}
</style></head><body><canvas id="model" tabindex="0" aria-label="FoldBot 三维模型。拖动或方向键旋转，加减键缩放。"></canvas>
<div class="bar"><span id="label">FoldBot · 模型预览</span><button id="reset" type="button">复位视角</button></div>
<script>{three[0]}</script>{model[0]}{MODEL_VIEWER}</body></html>'''


def main() -> None:
    original = read_source()
    target = ROOT / 'web' / 'public'
    outputs = []
    for mode in ('local', 'preview'):
        data = build_console(original.decode('utf-8'), mode).encode('utf-8')
        name = f'foldbot-console-{mode}.html'
        (target / name).write_bytes(data)
        outputs.append({'path': name, 'mode': mode, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    model_data = build_model_preview(original.decode('utf-8')).encode('utf-8')
    (target / 'foldbot-model-preview.html').write_bytes(model_data)
    outputs.append({'path': 'foldbot-model-preview.html', 'mode': 'model-only', 'bytes': len(model_data), 'sha256': hashlib.sha256(model_data).hexdigest()})
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
