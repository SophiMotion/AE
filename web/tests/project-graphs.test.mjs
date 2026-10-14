import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { defaultProjectGraphs, recommendedHardwareWiring, validateProjectGraphs, normalizeProjectGraphs,
  normalizedWiringKey, validateGraphReadiness, validateHardwareConnection, reconcileGraphsFromForm,
  hardwareSelectionFromGraph, HARDWARE_CATALOG } from "../src/projectGraphs.ts";
import { defaultGuidedConfig, buildGuidedWiringPreview, guidedWiringCurrent } from "../src/guidedFlow.ts";
import { defaultFoldBotFlow } from "../src/foldbotFlow.ts";
import { validateFoldBotDraft, restoreFoldBotDraft, draftMatchesProject, createFoldBotApi } from "../src/foldbotApi.ts";

const provenance = JSON.parse(readFileSync(new URL("../../worker/foldbot_source_provenance.json", import.meta.url), "utf8"));
const source = { id: provenance.template_id, source_provenance: provenance.sources };
const guided = {
  schema_version: 1, robot_choice: "foldbot", purpose: "能展开双板并收回，保留底盘和机械臂", primary_task: "fold-cycle",
  hardware: { controller: "sophicar-s3", fold_driver: "external-step-dir", arm_bus: "buslinker-hx", chassis: "sophicar-m1-m2", notes: "保持现有线束，电源待现场核对" },
  wiring_binding_sha256: null,
};
const legacy = { name: "FoldBot", request: "制作一个折叠机器人", drive_level: 10, drive_duration_ms: 200 };
const draft = () => { const d = { ...legacy, guided: structuredClone(guided), workflow: { ...defaultFoldBotFlow(), wiring_reviewed: true } }; return { ...d, graphs: defaultProjectGraphs(d) }; };
function insert(graphs, after, node) {
  const edge = graphs.behavior.edges.find(e => e.source === `stage-${after}`);
  const target = edge.target;
  edge.target = node.id;
  graphs.behavior.nodes.push(node);
  graphs.behavior.edges.push({ id: `from-${node.id}`, source: node.id, sourcePort: node.kind === "condition" ? "true" : "next", target, targetPort: "in" });
  return graphs;
}
const codes = (graphs) => validateGraphReadiness(graphs).map(i => i.code);

test("new and unadapted projects have no preselected FoldBot wiring; known selections create only matching parts", () => {
  for (const d of [{}, { guided: defaultGuidedConfig() }, { guided: { ...guided, robot_choice: "other" } }]) {
    const graph = defaultProjectGraphs(d);
    assert.deepEqual(graph.wiring, { nodes: [], edges: [] });
    assert.equal(graph.behavior.nodes.length, 7);
    assert.equal(validateProjectGraphs(graph), true);
    assert.ok(codes(graph).includes("required_component"));
  }
  const only = defaultProjectGraphs({ guided: { ...defaultGuidedConfig(), robot_choice: "foldbot", hardware: { ...defaultGuidedConfig().hardware, controller: "sophicar-s3" } } });
  assert.deepEqual(only.wiring.nodes.map(n => n.component), ["controller"]);
  assert.equal(only.wiring.edges.length, 0);
  assert.deepEqual(draft().graphs.wiring, recommendedHardwareWiring());
  assert.equal(draft().graphs.wiring.edges.length, 17);
  assert.deepEqual(codes(draft().graphs), []);
});

test("catalog labels, signal directions and exact existing source terminals are present without invented power pins", () => {
  assert.equal(HARDWARE_CATALOG.length, 7);
  for (const c of HARDWARE_CATALOG) {
    assert.ok(c.label && c.labelEn && c.description && c.descriptionEn);
    for (const p of c.ports) assert.ok(p.label && p.labelEn && p.signal && p.direction);
  }
  const controller = HARDWARE_CATALOG.find(c => c.id === "controller");
  assert.deepEqual(controller.ports.map(p => p.id), ["gpio3", "gpio8", "gpio10", "gpio4", "gpio5", "gpio9", "gpio6", "gpio7", "gnd", "m1", "m2"]);
  assert.match(controller.description, /N16R8/);
  assert.equal(HARDWARE_CATALOG.find(c => c.id === "custom").ports.length, 0);
  assert.deepEqual(HARDWARE_CATALOG.find(c => c.id === "fold-driver-1").ports.map(p => p.id), ["dir+", "pul+", "ena+", "dir-", "pul-", "ena-"]);
});

test("strict graph validation rejects hidden layout/executable parameters, invalid IDs, versions and duplicates", () => {
  const mutations = [
    g => g.schema_version = true, g => g.schema_version = 2, g => g.layout = {},
    g => g.wiring.nodes[0].id = "bad\n", g => g.wiring.nodes[0].id = "x".repeat(81),
    g => g.wiring.nodes[0].label = 1, g => g.wiring.nodes[0].label = "x\0",
    g => g.wiring.nodes[0].component = "generic-esp32", g => g.wiring.nodes[0].pins = [],
    g => g.wiring.nodes.push(structuredClone(g.wiring.nodes[0])),
    g => g.wiring.edges[0].sourcePort = "gpio3\n", g => g.wiring.edges.push(structuredClone(g.wiring.edges[0])),
    g => g.behavior.nodes[0] = { id: "action", kind: "action", ref: "robot.move" },
    g => g.behavior.nodes[0] = { id: "condition", kind: "condition", check: "eval(x)" },
    g => g.behavior.nodes[0].code = "move()",
    g => g.behavior.nodes = Array.from({ length: 65 }, (_, i) => ({ id: `a${i}`, kind: "action", ref: "workflow.action_group" })),
  ];
  for (const mutate of mutations) { const d = draft(); mutate(d.graphs); assert.equal(validateProjectGraphs(d.graphs), false); assert.throws(() => normalizeProjectGraphs(d.graphs)); assert.equal(validateFoldBotDraft(d), false); }
  for (const missing of ["workflow", "guided"]) { const d = draft(); delete d[missing]; assert.equal(validateFoldBotDraft(d), false); }
});

test("unsupported/dangling/missing/repeated wiring remains editable but cannot generate a pinout", async () => {
  const mutations = [
    [g => g.wiring.edges.pop(), "missing_connection"],
    [g => g.wiring.edges[0].sourcePort = "gpio4", "unadapted_connection"],
    [g => g.wiring.edges[0].sourcePort = "gpio999", "unknown_port"],
    [g => g.wiring.edges[0].source = "missing", "missing_endpoint"],
    [g => g.wiring.edges[0].sourcePort = "gnd", "port_mismatch"],
    [g => g.wiring.nodes.push({ id: "extra", component: "custom", label: "未知驱动" }), "unadapted_component"],
    [g => g.wiring.edges.push({ ...g.wiring.edges[0], id: "duplicate" }), "duplicate_connection"],
  ];
  for (const [mutate, code] of mutations) { const d = draft(); mutate(d.graphs); assert.equal(validateFoldBotDraft(d), true); assert.ok(codes(d.graphs).includes(code)); await assert.rejects(buildGuidedWiringPreview(d, source), /wiring_graph_not_ready/); }
  assert.equal(validateHardwareConnection(draft().graphs.wiring, draft().graphs.wiring.edges[0]).length, 0);
});

test("wire identity normalizes label/edge ID/array order/direction and matches the Python digest", async () => {
  const d = draft(), first = await buildGuidedWiringPreview(d, source);
  assert.equal(first.binding_sha256, "a92ed8fd1153ccb7eac0cb3095dff03e185b32de82eea6367a5c593196625d13");
  d.guided.wiring_binding_sha256 = first.binding_sha256;
  assert.equal(guidedWiringCurrent(d, first), true);
  const changed = structuredClone(d);
  changed.graphs.wiring.nodes.reverse(); changed.graphs.wiring.nodes[0].label = "renamed";
  changed.graphs.wiring.edges.reverse();
  for (const e of changed.graphs.wiring.edges) { [e.source, e.target] = [e.target, e.source]; [e.sourcePort, e.targetPort] = [e.targetPort, e.sourcePort]; e.id += "-renamed"; }
  assert.equal(normalizedWiringKey(changed.graphs.wiring), normalizedWiringKey(d.graphs.wiring));
  assert.deepEqual(await buildGuidedWiringPreview(changed, source), first);
  assert.equal(guidedWiringCurrent(changed, first), true);
  changed.graphs.wiring.edges.pop();
  assert.equal(guidedWiringCurrent(changed, first), false);
  assert.notEqual(normalizedWiringKey(changed.graphs.wiring), normalizedWiringKey(d.graphs.wiring));
});

test("mandatory dependencies reject bypasses, cycles, false continuation and misplaced checks", () => {
  const mutations = [
    [g => g.behavior.nodes.pop(), "required_stage"], [g => g.behavior.edges.pop(), "incomplete_flow"],
    [g => g.behavior.edges[0].target = "stage-program", "stage_order"],
    [g => g.behavior.edges.at(-1).target = "stage-requirements", "cycle_or_disconnected"],
    [g => g.behavior.edges[0].sourcePort = "false", "invalid_flow_port"],
    [g => insert(g, "hardware", { id: "wrong", kind: "condition", check: "requirements_ready" }), "node_position"],
    [g => insert(g, "deploy", { id: "wrong", kind: "action", ref: "workflow.action_group" }), "node_position"],
  ];
  for (const [mutate, code] of mutations) { const d = draft(); mutate(d.graphs); assert.equal(validateProjectGraphs(d.graphs), true); assert.ok(codes(d.graphs).includes(code)); }
});

test("checks and action nodes hold only shared parameter refs and leave wiring binding intact", async () => {
  const d = draft(), first = await buildGuidedWiringPreview(d, source);
  insert(d.graphs, "requirements", { id: "req", kind: "condition", check: "requirements_ready" });
  insert(d.graphs, "wiring", { id: "wire", kind: "condition", check: "wiring_reviewed" });
  insert(d.graphs, "preview", { id: "act", kind: "action", ref: "workflow.action_group" });
  assert.deepEqual(codes(d.graphs), []);
  assert.deepEqual(await buildGuidedWiringPreview(d, source), first);
  const project = { ...structuredClone(d), id: "p", revision: 1 };
  d.workflow.action_group = "arm-demo";
  assert.equal(draftMatchesProject(d, project), false);
  assert.deepEqual(await buildGuidedWiringPreview(d, source), first);
  insert(d.graphs, "preview", { id: "act2", kind: "action", ref: "workflow.action_group" });
  assert.ok(codes(d.graphs).includes("duplicate_action"));
});

test("form request/flow/notes edits preserve manual connections; changed hardware affects only its own roles", () => {
  const before = draft();
  before.graphs.wiring.edges[0].sourcePort = "gpio4";
  before.graphs.wiring.nodes.push({ id: "custom-added", component: "custom", label: "待适配传感器" });
  const notes = { ...before, request: "新需求", workflow: { ...before.workflow, action_group: "arm-demo" }, guided: { ...before.guided, hardware: { ...before.guided.hardware, notes: "新备注" } } };
  assert.deepEqual(reconcileGraphsFromForm(before, notes), before.graphs);
  const next = { ...before, guided: { ...before.guided, hardware: { ...before.guided.hardware, arm_bus: "other" } } };
  const reconciled = reconcileGraphsFromForm(before, next);
  assert.equal(reconciled.wiring.edges.find(e => e.id === "wire-1").sourcePort, "gpio4");
  assert.equal(reconciled.wiring.nodes.find(n => n.id === "hw-arm-bus").component, "custom");
  assert.ok(reconciled.wiring.nodes.some(n => n.id === "custom-added"));
  assert.ok(reconciled.wiring.edges.every(e => e.target !== "hw-arm-bus"));
  assert.deepEqual(reconciled.behavior, before.graphs.behavior);
  assert.deepEqual(reconcileGraphsFromForm(before, { ...before, guided: { ...before.guided, robot_choice: "other" } }).wiring, { nodes: [], edges: [] });
});

test("graph deletion updates role selection, notes persist and one remaining axis still fails readiness", () => {
  const w = recommendedHardwareWiring();
  w.nodes = w.nodes.filter(n => n.component !== "fold-driver-1");
  assert.equal(hardwareSelectionFromGraph(w, guided.hardware).fold_driver, "external-step-dir");
  assert.ok(codes({ ...draft().graphs, wiring: w }).includes("required_component"));
  w.nodes = w.nodes.filter(n => n.component !== "fold-driver-2");
  const selection = hardwareSelectionFromGraph(w, guided.hardware);
  assert.equal(selection.fold_driver, "unselected");
  assert.equal(selection.notes, guided.hardware.notes);
  assert.equal(selection.controller, "sophicar-s3");
  w.nodes.push({ id: "hw-fold-driver-1", component: "custom", label: "another driver" });
  assert.equal(hardwareSelectionFromGraph(w, guided.hardware).fold_driver, "other");
});

test("restore carries exact graph and baseline without upgrading legacy; graph edits make output stale", () => {
  const d = draft(), project = { ...structuredClone(d), id: "p", revision: 4 };
  assert.deepEqual(restoreFoldBotDraft(null, [project], legacy).draft, d);
  assert.equal(restoreFoldBotDraft(null, [{ ...legacy, id: "old", revision: 1 }], legacy).draft.graphs, undefined);
  const edited = structuredClone(d); edited.graphs.behavior.edges.pop();
  const cache = { draft: edited, projectId: "p", baseRevision: 3 };
  const restored = restoreFoldBotDraft(cache, [project], legacy);
  assert.equal(restored.conflict, true); assert.equal(restored.baseline.baseRevision, 3);
  assert.deepEqual(restored.draft.graphs, edited.graphs);
  assert.equal(draftMatchesProject(edited, project), false);
  const reordered = structuredClone(d); reordered.graphs.wiring.nodes.reverse();
  assert.equal(draftMatchesProject(reordered, project), true);
});

test("public mode cannot submit graphs to backend", async () => {
  let count = 0;
  const api = createFoldBotApi({ publicMode: true, fetcher: async () => { count++; throw new Error("network"); } });
  await assert.rejects(api.wiringPreview(draft()), /public_reference_only/);
  assert.equal(count, 0);
});
