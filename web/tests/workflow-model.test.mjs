import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultWorkflow,
  sequenceWorkflow,
  validateWorkflow,
} from "../src/workflowModel.ts";
import { jointBounds, snapshotStructure } from "../src/modelView.ts";
import { draftIsChanged, fromProject, newDraft } from "../src/draft.ts";

test("调换两端编译、通信和仿真后，实际待执行顺序随连线改变", () => {
  const graph = sequenceWorkflow(defaultWorkflow(), true, true);
  assert.deepEqual(validateWorkflow(graph), {
    error: "",
    order: [
      "requirements",
      "rag",
      "plan",
      "review",
      "generate",
      "esp_build",
      "ros_build",
      "simulation",
      "communication",
      "report",
    ],
  });
});
test("删掉审核依赖或让检查提前，不能作为可保存流程", () => {
  const graph = defaultWorkflow();
  graph.edges = graph.edges.filter((e) => e.source !== "review");
  graph.edges.push({ source: "plan", target: "generate" });
  assert.match(validateWorkflow(graph).error, /人工核对/);
  const early = sequenceWorkflow(defaultWorkflow(), false, false);
  early.edges = early.edges.filter(
    (e) => !(e.source === "esp_build" && e.target === "communication"),
  );
  early.edges.push({ source: "ros_build", target: "communication" });
  assert.match(validateWorkflow(early).error, /ESP32/);
});
test("循环、缺失节点和自连接给出错误，完整分支图能使用", () => {
  const loop = defaultWorkflow();
  loop.edges.push({ source: "report", target: "review" });
  assert.match(validateWorkflow(loop).error, /绕成了圈/);
  const missing = defaultWorkflow();
  missing.nodes = missing.nodes.filter((n) => n.id !== "review");
  assert.match(validateWorkflow(missing).error, /十个必要步骤/);
  const branch = defaultWorkflow();
  branch.edges = branch.edges.filter(
    (e) =>
      ![
        "ros_build",
        "esp_build",
        "communication",
        "simulation",
        "generate",
      ].includes(e.source),
  );
  for (const [source, target] of [
    ["generate", "ros_build"],
    ["generate", "esp_build"],
    ["ros_build", "communication"],
    ["ros_build", "simulation"],
    ["esp_build", "communication"],
    ["esp_build", "simulation"],
    ["communication", "report"],
    ["simulation", "report"],
  ])
    branch.edges.push({ source, target });
  assert.equal(validateWorkflow(branch).error, "");
});
test("工作流布局或连线更改均使旧规格变脏", () => {
  const saved = { ...newDraft(), id: "saved" };
  const layout = fromProject(saved);
  layout.workflow.nodes[0].position.x += 20;
  assert.equal(draftIsChanged(layout, saved), true);
  const order = fromProject(saved);
  order.workflow = sequenceWorkflow(order.workflow, true, false);
  assert.equal(draftIsChanged(order, saved), true);
});
test("回放只用给定运行快照，绝不自动换成内置台架", () => {
  assert.equal(snapshotStructure({ ...newDraft() }), null);
  const spec = {
    ...newDraft(),
    structure: {
      id: "source",
      name: "历史模型",
      format: "urdf",
      links: [],
      joints: [],
      warnings: [],
      mesh_url: "/api/meshes/frozen-sha",
    },
    execution_model: {
      model_id: "source",
      model_sha256: "hash-old",
      selected_joint: "left_elbow",
      links: [{ name: "base", visuals: [] }],
      joints: [
        {
          name: "left_elbow",
          origin: { xyz: [1, 2, 3], rpy: [0, 0, 0] },
          limits: { lower: -0.5, upper: 1 },
          initial_position: 0.3,
        },
      ],
      assumptions: {},
    },
  };
  const value = snapshotStructure(spec);
  assert.equal(value.mesh_url, "/api/meshes/frozen-sha");
  assert.equal(value.model_sha256, "hash-old");
  assert.equal(value.joints[0].initial_position, 0.3);
  assert.deepEqual(value.joints[0].xyz, [1, 2, 3]);
});
test("目标范围沿用所选关节，并受正负两圈弧度包络约束", () => {
  assert.deepEqual(jointBounds({ lower: -0.2, upper: 0.9 }), {
    lower: -0.2,
    upper: 0.9,
  });
  assert.deepEqual(jointBounds({ limits: { lower: -20, upper: 20 } }), {
    lower: -2 * Math.PI,
    upper: 2 * Math.PI,
  });
});
