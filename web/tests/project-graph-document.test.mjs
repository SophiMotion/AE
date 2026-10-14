import test from "node:test";
import assert from "node:assert/strict";
import { exportGraphDocument, parseGraphDocument, validateEditorLayout, emptyEditorLayout } from "../src/projectGraphDocument.ts";
import { defaultGuidedConfig } from "../src/guidedFlow.ts";
import { defaultFoldBotFlow } from "../src/foldbotFlow.ts";
import { defaultProjectGraphs } from "../src/projectGraphs.ts";

const draft = { name: "My canvas", request: "Build my folding robot", drive_level: 10, drive_duration_ms: 200, guided: defaultGuidedConfig(), workflow: defaultFoldBotFlow() };

test("canvas document preserves graph edits and positions but drops trust when imported", () => {
  const graphs = defaultProjectGraphs(draft);
  graphs.behavior.edges.pop(); // Incomplete plans are importable and fixable.
  const value = { ...draft, graphs, guided: { ...draft.guided, wiring_binding_sha256: "a".repeat(64) }, workflow: { ...draft.workflow, wiring_reviewed: true } };
  const layout = { wiring: {}, behavior: { "stage-requirements": { x: 240, y: 90 } } };
  const parsed = parseGraphDocument(JSON.stringify(exportGraphDocument(value, layout)));
  assert.deepEqual(parsed.draft.graphs, graphs);
  assert.deepEqual(parsed.editor_layout, layout);
  assert.equal(parsed.draft.workflow.wiring_reviewed, false);
  assert.equal(parsed.draft.guided.wiring_binding_sha256, null);
  assert.equal(Object.hasOwn(parsed.draft, "projectId"), false);
});

test("exporting an old draft does not mutate the original or silently save a graph", () => {
  const before = JSON.stringify(draft);
  const document = exportGraphDocument(draft, emptyEditorLayout());
  assert.equal(JSON.stringify(draft), before);
  assert.equal(document.draft.graphs.behavior.nodes.length, 7);
  assert.equal(document.draft.graphs.wiring.nodes.length, 0);
});

test("in-progress fields survive draft export and reimport without being authorized for generation", () => {
  const value = { ...draft, name: "", request: "", workflow: { ...draft.workflow, ros_serial: "/dev/tty" } };
  const parsed = parseGraphDocument(JSON.stringify(exportGraphDocument(value, emptyEditorLayout())));
  assert.equal(parsed.draft.name, "");
  assert.equal(parsed.draft.request, "");
  assert.equal(parsed.draft.workflow.ros_serial, "/dev/tty");
  assert.equal(parsed.draft.workflow.wiring_reviewed, false);
});

test("reject extra metadata, forged state, scripts, and oversized graph documents", () => {
  const make = () => exportGraphDocument(draft, emptyEditorLayout());
  for (const extra of ["id", "generation", "reviewed", "session_id", "physical_verified"]) {
    const value = make(); value.draft[extra] = true;
    assert.throws(() => parseGraphDocument(JSON.stringify(value)), /invalid_graph_draft/);
  }
  const code = make(); code.draft.graphs.behavior.nodes.push({ id: "script", kind: "script", code: "alert(1)" });
  assert.throws(() => parseGraphDocument(JSON.stringify(code)), /invalid_graph_draft/);
  assert.throws(() => parseGraphDocument(" ".repeat(1024 * 1024 + 1)), /too_large/);
  assert.throws(() => parseGraphDocument(JSON.stringify({ ...make(), version: 2 })), /invalid_graph_document/);
});

test("layout is bounded, typed, and separate from graph semantics", () => {
  assert.equal(validateEditorLayout(emptyEditorLayout()), true);
  for (const value of [null, [], {}, { wiring: [], behavior: {} }, { wiring: { id: { x: Infinity, y: 0 } }, behavior: {} },
    { wiring: { id: { x: 100001, y: 0 } }, behavior: {} }, { wiring: {}, behavior: { id: { x: 0, y: 0, execute: true } } },
    JSON.parse('{"wiring":{"__proto__":{"x":0,"y":0}},"behavior":{}}')]) assert.equal(validateEditorLayout(value), false);
});
