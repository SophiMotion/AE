import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { runInNewContext } from "node:vm";
import * as THREE from "three";
import {
  actionVisualPose,
  initialVisualPose,
  isVisualPose,
  MODEL_CHANNEL,
  groupForPreviewAction,
  previewActionForGroup,
  visualPoseMessage,
  visualReadings,
  PREVIEW_SECONDS,
} from "../src/foldbotSimulationModel.ts";

const html = readFileSync(
  new URL("../public/foldbot-model-preview.html", import.meta.url),
  "utf8",
);
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(
  (match) => match[1],
);
const runtime = scripts.at(-1);

test("workflow action groups select the same family in the preview", () => {
  assert.equal(previewActionForGroup("fold-cycle"), "unfold");
  assert.equal(previewActionForGroup("arm-demo"), "arm");
  assert.equal(previewActionForGroup("chassis-demo"), "drive");
  assert.equal(groupForPreviewAction("fold"), "fold-cycle");
  assert.equal(groupForPreviewAction("unfold"), "fold-cycle");
  assert.equal(groupForPreviewAction("arm"), "arm-demo");
  assert.equal(groupForPreviewAction("drive"), "chassis-demo");
  assert.equal(
    previewActionForGroup("fold-cycle", "fold"),
    "fold",
    "parent group update must preserve selected fold sub-action",
  );
  assert.equal(
    previewActionForGroup("arm-demo", "fold"),
    "arm",
    "an external different group must switch the preview",
  );
});

test("pose contract rejects unbounded, non-finite or foreign commands", () => {
  assert.equal(isVisualPose(initialVisualPose()), true);
  for (const bad of [
    null,
    [],
    {},
    { ...initialVisualPose(), fold1: NaN },
    { ...initialVisualPose(), fold2: -1 },
    { ...initialVisualPose(), joints: [0, 0, 0, 0, 0, -0.1] },
    { ...initialVisualPose(), tracks: [Infinity, 0] },
    { ...initialVisualPose(), tracks: [1001, 0] },
    { ...initialVisualPose(), command: "motion_enable" },
    { ...initialVisualPose(), joints: [0, 0] },
  ]) {
    assert.equal(isVisualPose(bad), false);
    assert.throws(() => visualPoseMessage(bad, "en"));
  }
});

test("each action stays bounded for every frame and does not mutate caller state", () => {
  const before = initialVisualPose();
  for (const action of ["unfold", "fold", "arm", "drive"]) {
    for (let i = 0; i <= 1000; i++)
      assert.equal(isVisualPose(actionVisualPose(action, i / 1000)), true);
  }
  assert.deepEqual(before, initialVisualPose());
  assert.equal(actionVisualPose("unfold", -1).fold1, 0);
  assert.equal(actionVisualPose("unfold", 2).fold2, 1);
  assert.equal(actionVisualPose("fold", 1).fold1, 0);
  assert.equal(actionVisualPose("drive", 1).tracks[0], 10);
  assert.throws(() => actionVisualPose("arm", NaN));
  assert.throws(() => actionVisualPose("unknown", 0.5));
});

test("telemetry stays explicitly visual and never invents torque or physical speed", () => {
  const pose = actionVisualPose("unfold", 0.5);
  const readings = visualReadings(pose);
  assert.equal(readings.length, 10);
  for (const row of readings) {
    assert.equal(row.source, "visual_preview");
    assert.equal(row.torque, null);
    assert.equal(row.velocity, null);
  }
  assert.equal(readings[0].value, 45);
  assert.equal(readings[1].value, -90);
  assert.equal(readings[7].unit, "%");
  assert.equal(readings[8].unit, "phase");
  const moving = visualReadings(
    pose,
    actionVisualPose("unfold", 0.4),
    0.1 * PREVIEW_SECONDS,
  );
  assert.ok(moving[0].velocity < 0);
  assert.ok(moving[1].velocity > 0);
  for (const seconds of [0, -1, NaN, Infinity])
    assert.equal(
      visualReadings(pose, initialVisualPose(), seconds)[0].velocity,
      null,
    );
});

test("standalone asset preserves exact audited FoldBot geometry and forbids network", () => {
  const header = readFileSync(
    new URL("../../worker/foldbot_web_ui.h", import.meta.url),
    "utf8",
  );
  const source = gunzipSync(
    Buffer.from(
      [...header.matchAll(/0x([0-9a-fA-F]{2})/g)].map((match) =>
        parseInt(match[1], 16),
      ),
    ),
  ).toString("utf8");
  const geometry = source.match(
    /<!-- FOLDBOT_REALISTIC_MODEL_BEGIN -->([\s\S]*?)<!-- FOLDBOT_REALISTIC_MODEL_END -->/,
  )[1];
  assert.ok(html.includes(geometry));
  assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(
    html,
    /ae-foldbot-console|new WebSocket|status_request|motion_enable|ws:\/\/192/,
  );
});

test("model geometry rotations agree with reported display angles", () => {
  const scope = {};
  const modelScript = scripts.find((script) =>
    script.includes("scope.FoldBotModel={create}"),
  );
  runInNewContext(modelScript, { window: scope, Map, Set });
  const model = scope.FoldBotModel.create(THREE, { stage: "final" });
  const pose = actionVisualPose("arm", 0.37);
  model.setPose(pose);
  model.setTrackPhase(...pose.tracks);
  const rows = visualReadings(pose);
  const angles = [
    model.pivots.lower.rotation.x,
    model.pivots.upper.rotation.x,
    model.pivots.base.rotation.y,
    model.pivots.shoulder.rotation.x,
    model.pivots.elbow.rotation.x,
    model.pivots.wristPitch.rotation.x,
    model.pivots.wristRoll.rotation.y,
  ];
  angles.forEach((angle, index) =>
    assert.ok(Math.abs((angle * 180) / Math.PI - rows[index].value) < 1e-9),
  );
  assert.ok(model.partsManifest().parts.length > 30);
  model.dispose();
});

function viewerHarness() {
  const handlers = {};
  const poses = [],
    tracks = [],
    outgoing = [];
  const parent = {
    postMessage: (message, origin) => outgoing.push({ message, origin }),
  };
  const canvas = {
    clientWidth: 640,
    clientHeight: 420,
    addEventListener() {},
    setAttribute() {},
    setPointerCapture() {},
  };
  const nodes = {
    model: canvas,
    label: { textContent: "" },
    reset: { addEventListener() {} },
  };
  const vector = { set() {} };
  class Renderer {
    setPixelRatio() {}
    setSize() {}
    render() {}
    dispose() {}
    shadowMap = {};
  }
  class Camera {
    position = vector;
    lookAt() {}
    updateProjectionMatrix() {}
  }
  class Light {
    position = vector;
    shadow = { mapSize: vector, camera: {} };
  }
  const window = {
    addEventListener: (name, fn) => {
      handlers[name] = fn;
    },
  };
  runInNewContext(runtime, {
    window,
    parent,
    location: { origin: "https://ae.example" },
    devicePixelRatio: 1,
    document: { getElementById: (id) => nodes[id], documentElement: {} },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    FoldBotModel: {
      create: () => ({
        root: {},
        setPose: (pose) => poses.push(pose),
        setTrackPhase: (...phase) => tracks.push(phase),
        getBounds: () => ({ getCenter: () => ({ y: 2 }) }),
        dispose() {},
      }),
    },
    THREE: {
      WebGLRenderer: Renderer,
      PerspectiveCamera: Camera,
      Scene: class {
        add() {}
      },
      Color: class {},
      Vector3: class {},
      HemisphereLight: Light,
      DirectionalLight: Light,
      PlaneGeometry: class {},
      MeshStandardMaterial: class {},
      Mesh: class {
        rotation = {};
        position = {};
      },
      GridHelper: class {
        position = {};
      },
    },
  });
  return { handlers, parent, poses, tracks, outgoing, nodes };
}

test("only parent same-origin strictly valid pose messages can update the isolated model", () => {
  const h = viewerHarness();
  assert.equal(h.outgoing[0].message.type, "ready");
  const initialCalls = h.poses.length;
  const message = visualPoseMessage(actionVisualPose("arm", 0.5), "en");
  for (const event of [
    { source: {}, origin: "https://ae.example", data: message },
    { source: h.parent, origin: "https://evil.example", data: message },
    {
      source: h.parent,
      origin: "https://ae.example",
      data: { ...message, channel: "ae-foldbot-console", type: "attach" },
    },
    {
      source: h.parent,
      origin: "https://ae.example",
      data: { ...message, pose: { ...message.pose, fold1: Infinity } },
    },
    {
      source: h.parent,
      origin: "https://ae.example",
      data: { ...message, locale: "unknown" },
    },
  ])
    h.handlers.message(event);
  assert.equal(h.poses.length, initialCalls);
  h.handlers.message({
    source: h.parent,
    origin: "https://ae.example",
    data: message,
  });
  assert.equal(h.poses.length, initialCalls + 1);
  assert.equal(h.nodes.label.textContent, "FoldBot · Visual preview");
  assert.equal(h.tracks.length, 1);
  assert.equal(h.outgoing[0].message.channel, MODEL_CHANNEL);
});
