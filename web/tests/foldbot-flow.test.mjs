import test from "node:test";
import assert from "node:assert/strict";
import { defaultFoldBotFlow, normalizeFoldBotFlow, normalizeFoldBotDraftFlow, validateFoldBotFlow, FOLDBOT_SOURCE_WIRING } from "../src/foldbotFlow.ts";
import { draftMatchesProject, restoreFoldBotDraft, validateFoldBotDraft, createFoldBotApi, mergeFoldBotSavedCache } from "../src/foldbotApi.ts";

const legacy = { name: "FoldBot", request: "Fold and unfold", drive_level: 10, drive_duration_ms: 200 };
const workflow = { ...defaultFoldBotFlow(), wiring_reviewed: true };
const draft = { ...legacy, workflow };
const project = { ...draft, id: "p1", revision: 2 };

test("defaults and legacy cache work without silently accepting invalid workflow", () => {
  assert.equal(defaultFoldBotFlow().wiring_reviewed, false);
  assert.deepEqual(normalizeFoldBotFlow(), defaultFoldBotFlow());
  const defaults = defaultFoldBotFlow();
  defaults.control = "ros";
  assert.equal(defaultFoldBotFlow().control, "esp");
  assert.equal(validateFoldBotDraft(legacy), true);
  assert.equal(draftMatchesProject(legacy, { ...legacy, id: "p", revision: 1 }), true);
  assert.equal(draftMatchesProject(legacy, project), false);
  const restored = restoreFoldBotDraft(null, [{ ...legacy, id: "p", revision: 1 }], legacy);
  assert.deepEqual(restored.draft, legacy);
  for (const value of [null, {}, [], "esp", { ...workflow, execute: true }, { ...workflow, wiring_reviewed: 1 }]) {
    assert.equal(validateFoldBotFlow(value), false);
    assert.throws(() => normalizeFoldBotFlow(value), /invalid_foldbot_workflow/);
    assert.equal(validateFoldBotDraft({ ...legacy, workflow: value }), false);
  }
});

test("all mutable workflow choices invalidate a prior generated revision", () => {
  assert.equal(draftMatchesProject(draft, project), true);
  for (const [key, value] of Object.entries({ control: "ros", wiring_reviewed: false, ros_host: "jetson", ros_version: "jazzy", ros_serial: "COM3", action_group: "arm-demo" })) {
    const changed = { ...draft, workflow: { ...workflow, [key]: value } };
    assert.equal(draftMatchesProject(changed, project), false, key);
    const result = restoreFoldBotDraft({ projectId: "p1", baseRevision: 1, draft: changed }, [project], legacy);
    assert.equal(result.conflict, true, key);
    assert.equal(result.baseline.baseRevision, 1);
    assert.deepEqual(result.draft.workflow, changed.workflow);
  }
});

test("key order is immaterial but missing/unknown keys are not normalized away", () => {
  const reordered = Object.fromEntries(Object.entries(workflow).reverse());
  assert.equal(draftMatchesProject({ ...draft, workflow: reordered }, project), true);
  assert.deepEqual(normalizeFoldBotFlow(reordered), workflow);
  for (const key of Object.keys(workflow)) {
    const partial = { ...workflow };
    delete partial[key];
    assert.equal(validateFoldBotFlow(partial), false, key);
  }
});

test("serial labels reject command injection and allow known platform formats", () => {
  for (const ros_serial of ["", "COM3", "COM9999", "/dev/ttyUSB0", "/dev/ttyACM12", "/dev/cu.usbserial-110"]) {
    assert.equal(validateFoldBotFlow({ ...workflow, ros_serial }), true, ros_serial);
  }
  for (const ros_serial of ["COM0", "COM3\n", "/dev/ttyUSB0; touch file", "$(command)", "../secret", "a".repeat(121), 3]) {
    assert.equal(validateFoldBotFlow({ ...workflow, ros_serial }), false, String(ros_serial));
  }
});

test("workflow is transmitted and source wiring retains unresolved physical state", async () => {
  let sent;
  const api = createFoldBotApi({ fetcher: async (_url, options) => {
    sent = JSON.parse(options.body);
    return new Response(JSON.stringify(project));
  } });
  await api.save(draft, project);
  assert.deepEqual(sent.workflow, workflow);
  assert.equal(sent.revision, 2);
  assert.equal(sent.reviewed, false);
  assert.ok(FOLDBOT_SOURCE_WIRING.every((item) => item.verified === false));
  assert.ok(FOLDBOT_SOURCE_WIRING.find((item) => item.id === "chassis").connection.includes("GPIO35–37"));
});

test("a late save advances its exact baseline after navigation without replacing newer typing", () => {
  const previous = { ...project, revision: 2 };
  const saved = { ...project, revision: 3, request: "First edit was saved" };
  const newerDraft = { ...draft, request: "Second edit typed before navigation", workflow: { ...workflow, ros_host: "jetson" } };
  const cached = { projectId: "p1", baseRevision: 2, draft: newerDraft };
  const before = structuredClone(cached);
  assert.equal(restoreFoldBotDraft(cached, [saved], legacy).conflict, true, "unmerged acknowledgement causes a false conflict");
  const merged = mergeFoldBotSavedCache(cached, previous, saved);
  assert.deepEqual(cached, before, "input cache is never mutated");
  assert.equal(merged.baseRevision, 3);
  assert.deepEqual(merged.draft, newerDraft);
  const restored = restoreFoldBotDraft(merged, [saved], legacy);
  assert.equal(restored.conflict, false);
  assert.equal(restored.draft.request, newerDraft.request);
  assert.equal(draftMatchesProject(restored.draft, saved), false, "newer typing is still unsaved, not acknowledged as server content");
});

test("late baseline merge preserves incomplete edits, including an invalid serial label", () => {
  const cached = { projectId: "p1", baseRevision: 2, draft: { ...draft, workflow: { ...workflow, ros_serial: "COM" } } };
  const merged = mergeFoldBotSavedCache(cached, project, { ...project, revision: 3 });
  assert.equal(merged.draft.workflow.ros_serial, "COM");
  assert.equal(validateFoldBotDraft(merged.draft), false);
  assert.equal(merged.baseRevision, 3);
});

test("late save never changes another project, newer baseline or unrelated server response", () => {
  const saved = { ...project, revision: 3 };
  for (const cached of [
    null,
    { projectId: "another", baseRevision: 2, draft },
    { projectId: "p1", baseRevision: 1, draft },
    { projectId: "p1", baseRevision: 3, draft },
    { projectId: null, baseRevision: null, draft },
  ]) assert.equal(mergeFoldBotSavedCache(cached, project, saved), null);
  const cached = { projectId: "p1", baseRevision: 2, draft };
  for (const unrelated of [
    { ...saved, id: "another" }, { ...saved, revision: 1 },
    { ...saved, revision: 4 }, { ...saved, revision: "3" },
  ]) assert.equal(mergeFoldBotSavedCache(cached, project, unrelated), null);
});

test("creation acknowledgement binds only an unbound draft and cannot overwrite an existing baseline", () => {
  const typed = { ...draft, name: "Name typed while create was pending" };
  const cached = { projectId: null, baseRevision: null, draft: typed };
  const created = { ...project, revision: 1 };
  assert.deepEqual(mergeFoldBotSavedCache(cached, null, created), { projectId: "p1", baseRevision: 1, draft: typed });
  assert.equal(mergeFoldBotSavedCache(cached, null, { ...created, revision: 2 }), null);
  assert.equal(mergeFoldBotSavedCache({ ...cached, projectId: "p1", baseRevision: 1 }, null, created), null);
  assert.equal(mergeFoldBotSavedCache({ ...cached, baseRevision: 1 }, null, created), null);
});

test("two ordered save acknowledgements advance monotonically and a repeated old reply cannot roll back", () => {
  const next = { ...project, revision: 3 };
  const newest = { ...project, revision: 4 };
  const cached = { projectId: "p1", baseRevision: 2, draft: { ...draft, request: "Most recent typing" } };
  const first = mergeFoldBotSavedCache(cached, project, next);
  const second = mergeFoldBotSavedCache(first, next, newest);
  assert.equal(second.baseRevision, 4);
  assert.equal(second.draft.request, "Most recent typing");
  assert.equal(mergeFoldBotSavedCache(second, project, next), null);
  const noop = mergeFoldBotSavedCache(second, newest, newest);
  assert.equal(noop.baseRevision, 4);
});

test("reloading incomplete serial text preserves every selection without making it savable", () => {
  for (const ros_serial of ["/dev/tt", "COM", " ", "COM3\n", "x".repeat(120)]) {
    const flow = { ...workflow, control: "ros", ros_host: "jetson", ros_version: "jazzy", action_group: "arm-demo", ros_serial };
    assert.deepEqual(normalizeFoldBotDraftFlow(flow), flow);
    assert.throws(() => normalizeFoldBotFlow(flow));
    const cached = { projectId: "p1", baseRevision: 2, draft: { ...draft, workflow: flow } };
    const restored = restoreFoldBotDraft(cached, [project], legacy);
    assert.deepEqual(restored.draft.workflow, flow);
    assert.equal(restored.conflict, false);
    assert.equal(validateFoldBotDraft(restored.draft), false);
    assert.equal(draftMatchesProject(restored.draft, project), false);
    const finished = { ...restored.draft, workflow: { ...flow, ros_serial: "/dev/ttyUSB0" } };
    assert.equal(validateFoldBotDraft(finished), true);
  }
});

test("draft hydration permits serial text only, rejecting malformed shape without truncation", () => {
  assert.deepEqual(normalizeFoldBotDraftFlow(), defaultFoldBotFlow());
  const missingSerial = { ...workflow };
  delete missingSerial.ros_serial;
  for (const value of [
    null, [], {}, "ros", missingSerial, { ...workflow, ros_serial: 3 },
    { ...workflow, ros_serial: "x".repeat(121) },
    { ...workflow, ros_serial: "COM", control: "other" },
    { ...workflow, ros_serial: "COM", extra: true },
    { ...workflow, wiring_reviewed: "true" },
  ]) assert.throws(() => normalizeFoldBotDraftFlow(value), /invalid_foldbot_workflow/);
});
