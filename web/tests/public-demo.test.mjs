import test from "node:test";
import assert from "node:assert/strict";
import { newDraft } from "../src/draft.ts";
import { fromProject } from "../src/draft.ts";
import { applyAssistant } from "../src/intakeAssistant.ts";
import { publicDemoApi, previewDraft, assistDraft } from "../src/publicDemo.ts";

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) || null,
  setItem: (key, value) => storage.set(key, value),
};
const structure = {
  id: "sophicore-reference",
  name: "Sophicore",
  format: "json",
  mapping_source_sha256: "model-safe",
  links: [],
  joints: [
    {
      name: "right_shoulder",
      label: "右肩",
      type: "revolute",
      lower: -1,
      upper: 1,
      parent: "body",
      child: "arm",
      xyz: [0, 0, 0],
      rpy: [0, 0, 0],
      axis: [1, 0, 0],
    },
  ],
  warnings: [],
};
const draft = newDraft();
draft.name = "公开原始示例";
draft.request = "让机器人抬起右手并招手三次，然后把手臂放到身体旁边";
const sample = {
  ...draft,
  id: "public-sample",
  status: "passed",
  plan: null,
  approval: {},
  latest_run_id: "public-run",
  spec_revision: 1,
  created_at: "2026-10-04T00:00:00Z",
  updated_at: "2026-10-04T00:00:00Z",
};
const run = {
  id: "public-run",
  project_id: "public-sample",
  spec_snapshot: sample,
  result: { passed: true, checks: [] },
  status: "passed",
  events: [],
  artifacts: [],
  code_versions: [],
  provenance: [],
};
const recipe = {
  structure_id: structure.id,
  label: "右臂参考配方",
  notes: [],
  source: "public upstream",
  motion_plan: {
    recipe_id: "sophicore-right-wave-v1",
    model_source_sha256: "model-safe",
    joint_names: ["right_shoulder"],
    waypoints: [],
  },
};
const fixture = {
  schema_version: 1,
  catalog: { tasks: [] },
  settings: { key_configured: false, codex_available: false },
  structures: [structure],
  projects: [sample],
  runs: [run],
  sources: [],
  recipes: { "sophicore-reference:right:3": recipe },
  files: { "public-run": { "algorithm.cpp": "// actual public source" } },
};
const requests = [];
globalThis.fetch = async (url) => {
  requests.push(String(url));
  return { ok: true, json: async () => structuredClone(fixture) };
};

test("published sample is immutable; saving changes creates unrelated browser draft", async () => {
  const changed = fromProject(sample);
  changed.request = "新的需求";
  const saved = await publicDemoApi("/projects/public-sample", changed, "PUT");
  assert.match(saved.id, /^browser-draft-/);
  assert.equal(saved.latest_run_id, null);
  assert.equal(saved.status, "draft");
  assert.equal(saved.plan, null);
  assert.equal(saved.approval, null);
  const original = await publicDemoApi("/projects/public-sample");
  assert.equal(original.request, sample.request);
  assert.equal(original.latest_run_id, "public-run");
  assert.deepEqual(await publicDemoApi(`/projects/${saved.id}/runs`), {
    items: [],
  });
  const retrieved = await publicDemoApi(`/projects/${saved.id}`);
  assert.equal(retrieved.request, "新的需求");
});
test("caller cannot forge execution evidence through save body", async () => {
  const body = {
    ...newDraft(),
    status: "passed",
    latest_run_id: "public-run",
    approval: { ok: true },
    result: { passed: true },
    manifest: { passed: true },
  };
  const saved = await publicDemoApi("/projects", body);
  assert.equal(saved.status, "draft");
  assert.equal(saved.latest_run_id, null);
  assert.equal(saved.approval, null);
  assert.equal(saved.result, undefined);
  assert.equal(saved.manifest, undefined);
});
test("recommendation uses browser rules, preserves supplied zeros and never guesses wiring", () => {
  const own = structuredClone(draft);
  own.prd.intake.answers.repetitions = 5;
  own.prd.intake.answers.dwell_s = 0;
  own.prd.intake.hardware_notes.wiring.value = "user supplied";
  const response = assistDraft(fixture, own);
  const filled = applyAssistant(
    own,
    response.suggestions,
    response.provenance,
  ).draft;
  assert.equal(filled.prd.intake.answers.repetitions, 5);
  assert.equal(filled.prd.intake.answers.dwell_s, 0);
  assert.equal(filled.prd.intake.hardware_notes.wiring.value, "user supplied");
  assert.equal(filled.prd.intake.hardware_notes.motor_model.value, "");
  assert.match(response.provenance.tool, /非 AI/);
  assert.equal(
    response.suggestions.some((s) => s.source === "ai"),
    false,
  );
  assert.equal(
    filled.prd.intake.action_draft.related_joints[0].name,
    "right_shoulder",
  );
  assert.equal(
    filled.prd.intake.action_draft.stages[0].confirmation_needed,
    true,
  );
});
test("draft validation distinguishes missing data from frozen sample success", () => {
  const result = previewDraft(fixture, newDraft());
  assert.equal(result.can_plan, false);
  assert.equal(result.execution_task, null);
  assert.ok(result.missing.length);
  assert.ok(result.unsupported.some((i) => i.path === "public_demo.execution"));
  const own = structuredClone(draft);
  own.prd.intake.answers.max_velocity_rad_s = -1;
  assert.ok(
    previewDraft(fixture, own).invalid.some((i) =>
      i.path.endsWith("max_velocity_rad_s"),
    ),
  );
});
test("explicit repetition count in request overrides example default but needs review", () => {
  const own = structuredClone(draft);
  own.request = "让机器人右臂招手五次，然后放到身体旁边";
  const response = assistDraft(fixture, own);
  const filled = applyAssistant(own, response.suggestions, response.provenance).draft;
  assert.equal(filled.prd.intake.answers.repetitions, 5);
  assert.equal(filled.prd.intake.action_draft.stages[1].repetitions, 5);
  assert.equal(filled.prd.intake.action_draft.stages[1].confirmation_needed, true);
});
test("run/export/upload/AI settings and unknown routes fail closed with no API request", async () => {
  for (const [path, body, method] of [
    ["/projects/public-sample/run", {}, "POST"],
    ["/runs/public-run/repair", {}, "POST"],
    ["/runs/public-run/deploy", {}, "POST"],
    ["/settings", { api_key: "secret" }, "PUT"],
    ["/structures", {}, "POST"],
    ["/knowledge/documents", {}, "POST"],
    ["/unknown", undefined, "GET"],
  ])
    await assert.rejects(publicDemoApi(path, body, method), /分享版|本机|公开/);
  assert.ok(requests.every((url) => !url.includes("/api")));
  assert.equal(requests.length, 1);
});
test("only exported public files can be read; returned objects do not mutate bundle", async () => {
  const found = await publicDemoApi("/runs/public-run/file?path=algorithm.cpp");
  assert.equal(found.content, "// actual public source");
  await assert.rejects(
    publicDemoApi("/runs/public-run/file?path=..%2F.env"),
    /未包含/,
  );
  const got = await publicDemoApi("/projects/public-sample");
  got.request = "tampered clone";
  assert.equal(
    (await publicDemoApi("/projects/public-sample")).request,
    sample.request,
  );
});
test("aborted request does not mutate browser storage", async () => {
  const before = JSON.stringify([...storage]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    publicDemoApi("/projects", newDraft(), "POST", controller.signal),
    { name: "AbortError" },
  );
  assert.equal(JSON.stringify([...storage]), before);
});
