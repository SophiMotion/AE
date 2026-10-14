import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  defaultGuidedConfig, validateGuidedConfig, normalizeGuidedConfig,
  guidedRequirementsReady, guidedHardwareReady, guidedWiringCurrent, buildGuidedWiringPreview,
} from "../src/guidedFlow.ts";
import {
  createFoldBotApi, draftMatchesProject, restoreFoldBotDraft, validateFoldBotDraft,
} from "../src/foldbotApi.ts";
import { defaultFoldBotFlow } from "../src/foldbotFlow.ts";

const provenance = JSON.parse(readFileSync(new URL("../../worker/foldbot_source_provenance.json", import.meta.url), "utf8"));
const source = { id: provenance.template_id, source_provenance: provenance.sources };
const guided = {
  schema_version: 1, robot_choice: "foldbot", purpose: "能展开双板并收回，保留底盘和机械臂",
  primary_task: "fold-cycle",
  hardware: { controller: "sophicar-s3", fold_driver: "external-step-dir", arm_bus: "buslinker-hx", chassis: "sophicar-m1-m2", notes: "保持现有线束，电源待现场核对" },
  wiring_binding_sha256: null,
};
const legacy = { name: "My robot", request: "制作一个折叠机器人", drive_level: 10, drive_duration_ms: 200 };
const draft = { ...legacy, guided, workflow: { ...defaultFoldBotFlow(), wiring_reviewed: true } };

test("new guidance is truly undecided and legacy restoration does not choose a robot or hardware", () => {
  const defaults = defaultGuidedConfig();
  assert.equal(defaults.robot_choice, "undecided");
  assert.equal(defaults.hardware.controller, "unselected");
  defaults.hardware.controller = "sophicar-s3";
  assert.equal(defaultGuidedConfig().hardware.controller, "unselected");
  assert.equal(validateGuidedConfig(defaultGuidedConfig()), true);
  assert.equal(guidedRequirementsReady({ request: "", guided: defaultGuidedConfig() }), false);
  assert.equal(guidedHardwareReady(defaultGuidedConfig()), false);
  assert.deepEqual(restoreFoldBotDraft(null, [{ ...legacy, id: "p", revision: 1 }], legacy).draft, legacy);
  assert.equal(validateFoldBotDraft(legacy), true);
});

test("strict guidance rejects partial/extra/type-coerced fields instead of guessing", () => {
  const malformed = [null, [], {}, "foldbot", { ...guided, schema_version: true }, { ...guided, schema_version: 2 },
    { ...guided, robot_choice: "quad" }, { ...guided, purpose: 3 }, { ...guided, purpose: "x".repeat(2001) },
    { ...guided, purpose: "x\0" }, { ...guided, wiring_binding_sha256: "a".repeat(63) },
    { ...guided, wiring_binding_sha256: "A".repeat(64) }, { ...guided, wiring_binding_sha256: "a".repeat(64) + "\n" }, { ...guided, execute: true },
    { ...guided, hardware: {} }, { ...guided, hardware: { ...guided.hardware, notes: 3 } },
    { ...guided, hardware: { ...guided.hardware, pins: [3, 8, 10] } },
    { ...guided, hardware: { ...guided.hardware, arm_bus: "pwm" } },
    { ...guided, hardware: { ...guided.hardware, notes: "\0" } }];
  for (const value of malformed) {
    assert.equal(validateGuidedConfig(value), false);
    assert.throws(() => normalizeGuidedConfig(value));
    assert.equal(validateFoldBotDraft({ ...draft, guided: value }), false);
  }
  for (const key of Object.keys(guided)) {
    const missing = { ...guided };
    delete missing[key];
    assert.equal(validateGuidedConfig(missing), false, key);
  }
});

test("complete unknown demand can save but cannot get a FoldBot pinout", async () => {
  const other = { ...draft, guided: { ...guided, robot_choice: "other" } };
  assert.equal(validateFoldBotDraft(other), true);
  assert.equal(guidedRequirementsReady(other), true);
  assert.equal(guidedHardwareReady(other.guided), false);
  await assert.rejects(buildGuidedWiringPreview(other, source), /guided_hardware_not_adapted/);
  for (const field of ["controller", "fold_driver", "arm_bus", "chassis"]) {
    const unknown = { ...draft, guided: { ...guided, hardware: { ...guided.hardware, [field]: "other" } } };
    assert.equal(validateFoldBotDraft(unknown), true);
    await assert.rejects(buildGuidedWiringPreview(unknown, source), /guided_hardware_not_adapted/);
  }
  for (const config of [{ ...guided, purpose: " " }, { ...guided, primary_task: "unselected" }, defaultGuidedConfig()]) {
    assert.equal(guidedRequirementsReady({ ...draft, guided: config }), false);
    await assert.rejects(buildGuidedWiringPreview({ ...draft, guided: config }, source), /guided_requirements_incomplete/);
  }
});

test("generated wiring is source-only and matches only the current bound inputs", async () => {
  const preview = await buildGuidedWiringPreview(draft, source);
  // Shared fixture with the Python preview API: UTF-8, key ordering and source hashes must agree.
  assert.equal(preview.binding_sha256, "58e4ea7c861b100bb45e46cfbb8b6a06bdc3dc0d4647d8c4a5fcec7f537ac63d");
  assert.equal(preview.connections.length, 5);
  assert.equal(preview.physical_verified, false);
  assert.ok(preview.warnings.join(" ").includes("GPIO35–37"));
  assert.equal(guidedWiringCurrent(draft, preview), false, "generating a preview is not confirming its binding");
  const bound = { ...draft, guided: { ...guided, wiring_binding_sha256: preview.binding_sha256 } };
  assert.equal(guidedWiringCurrent(bound, preview), true);
  assert.equal(guidedWiringCurrent(bound), false, "stored binding alone is not enough");
  for (const changed of [
    { ...bound, request: "改成只测试机械臂" },
    { ...bound, guided: { ...bound.guided, purpose: "不同验收结果" } },
    { ...bound, guided: { ...bound.guided, primary_task: "arm-demo" } },
    { ...bound, guided: { ...bound.guided, hardware: { ...guided.hardware, notes: "接线备注变化" } } },
  ]) {
    assert.equal(guidedWiringCurrent(changed, preview), false, "old async preview becomes stale synchronously");
    assert.notEqual((await buildGuidedWiringPreview(changed, source)).binding_sha256, preview.binding_sha256);
  }
  assert.equal(guidedWiringCurrent(bound, { ...preview, physical_verified: true }), false);
  assert.equal(guidedWiringCurrent(bound, { ...preview, source_key: "other" }), false);
});

test("control route changes preserve source wiring but invalidate generated project", async () => {
  const preview = await buildGuidedWiringPreview(draft, source);
  const bound = { ...draft, guided: { ...guided, wiring_binding_sha256: preview.binding_sha256 } };
  const project = { ...bound, id: "p", revision: 2 };
  const ros = { ...bound, workflow: { ...bound.workflow, control: "ros", ros_host: "jetson", ros_version: "jazzy", ros_serial: "COM3" } };
  assert.equal(guidedWiringCurrent(ros, preview), true);
  assert.deepEqual(await buildGuidedWiringPreview(ros, source), preview);
  assert.equal(draftMatchesProject(ros, project), false);
  assert.equal(draftMatchesProject(bound, project), true);
});

test("source digest change cannot silently keep an old wiring acknowledgement", async () => {
  const initial = await buildGuidedWiringPreview(draft, source);
  const changed = { ...source, source_provenance: source.source_provenance.map((item, index) => index ? item : { ...item, sanitized_sha256: "0".repeat(64) }) };
  const updated = await buildGuidedWiringPreview(draft, changed);
  assert.notEqual(initial.binding_sha256, updated.binding_sha256);
  const bound = { ...draft, guided: { ...guided, wiring_binding_sha256: initial.binding_sha256 } };
  assert.equal(guidedWiringCurrent(bound, updated), false);
  await assert.rejects(buildGuidedWiringPreview(draft, { ...source, source_provenance: [] }), /guided_source_unavailable/);
});

test("normalization keeps user wording and ignores only object key order for equality", () => {
  const typed = { ...guided, purpose: "  用户自己的中文  ", hardware: { ...guided.hardware, notes: "  原文不翻译 " } };
  const reordered = Object.fromEntries(Object.entries(typed).reverse());
  reordered.hardware = Object.fromEntries(Object.entries(typed.hardware).reverse());
  assert.deepEqual(normalizeGuidedConfig(reordered), typed);
  const project = { ...draft, guided: typed, id: "p", revision: 2 };
  assert.equal(draftMatchesProject({ ...draft, guided: reordered }, project), true);
  const cached = { projectId: "p", baseRevision: 1, draft: { ...draft, guided: typed } };
  const newer = { ...project, guided: { ...typed, purpose: "其他人更新" } };
  const restored = restoreFoldBotDraft(cached, [newer], legacy);
  assert.deepEqual(restored.draft.guided, typed);
  assert.equal(restored.baseline.baseRevision, 1);
  assert.equal(restored.conflict, true);
});

test("local preview API sends current draft while public mode cannot call the backend", async () => {
  let sent;
  const expected = await buildGuidedWiringPreview(draft, source);
  const api = createFoldBotApi({ fetcher: async (url, options) => {
    sent = { url, body: JSON.parse(options.body) };
    return new Response(JSON.stringify(expected));
  } });
  assert.deepEqual(await api.wiringPreview(draft), expected);
  assert.equal(sent.url, "/api/foldbot/wiring/preview");
  assert.deepEqual(sent.body, draft);
  const publicApi = createFoldBotApi({ publicMode: true, fetcher: () => { throw new Error("should not fetch"); } });
  await assert.rejects(publicApi.wiringPreview(draft), /public_reference_only/);
});
