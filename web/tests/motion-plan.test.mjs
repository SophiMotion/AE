import test from "node:test";
import assert from "node:assert/strict";
import {
  invalidateMotionReview,
  motionPlanIssues,
  repeatMotionSegment,
  adoptMotionRecipe,
} from "../src/motionPlan.ts";
import { newDraft } from "../src/draft.ts";
import { assistSource } from "../src/intakeAssistant.ts";

const structure = {
  id: "arm",
  content_sha256: "model",
  joints: [
    { name: "shoulder", type: "revolute", lower: -2, upper: 2 },
    { name: "elbow", type: "revolute", limits: { lower: -1, upper: 1 } },
  ],
};
const plan = () => ({
  schema_version: 1,
  recipe_id: "custom",
  model_source_sha256: "model",
  reviewed: true,
  joint_names: ["shoulder", "elbow"],
  waypoints: [
    {
      positions: [0.4, 0.1],
      time_from_start_s: 0,
      stage_id: "A",
      cycle_index: 0,
    },
    {
      positions: [0.6, 0.3],
      time_from_start_s: 2,
      stage_id: "B",
      cycle_index: 1,
    },
    {
      positions: [0.4, 0.1],
      time_from_start_s: 4,
      stage_id: "A",
      cycle_index: 1,
    },
    {
      positions: [-0.3, 0.2],
      time_from_start_s: 7,
      stage_id: "body-side",
      cycle_index: 0,
    },
  ],
  tolerance_rad: 0.05,
  max_velocity_rad_s: 0.7,
  max_acceleration_rad_s2: 1,
  timeout_s: 10,
});
const draft = () => {
  const value = newDraft();
  value.request = "抬臂，招手，放到身体旁";
  value.prd.intake.motion_plan = plan();
  return value;
};

test("明确采用才保存参考程序及真实接口来源，不覆盖现有程序或零值，核对不伪称AI生成", () => {
  const previous = newDraft();
  previous.request = "右臂招手三次";
  previous.prd.intake.answers.target_rad = 0;
  previous.prd.intake.answers.structure_id = "arm";
  previous.prd.intake.action_draft = { unresolved: ["需确认真实供电"] };
  const recipe = {
    label: "模型参考姿势",
    structure_id: "arm",
    notes: ["实物未验证"],
    source: { ai_generated: false },
    motion_plan: plan(),
  };
  const adopted = adoptMotionRecipe(
    previous,
    recipe,
    "/api/motion-v5/recipe?side=right",
  );
  assert.equal(adopted.prd.intake.motion_plan.reviewed, false);
  assert.equal(adopted.prd.intake.answers.target_rad, 0);
  assert.deepEqual(adopted.prd.intake.action_draft.unresolved, [
    "需确认真实供电",
  ]);
  assert.equal(previous.prd.intake.motion_plan, undefined);
  assert.equal(adoptMotionRecipe(adopted, recipe, "/ignored"), adopted);
  const source = assistSource(adopted, "prd.intake.motion_plan", structure);
  assert.equal(source.stale, false);
  assert.match(source.provenance.tool, /^GET \/api\/motion-v5/);
  assert.deepEqual(JSON.parse(source.provenance.response), recipe);
  adopted.prd.intake.motion_plan.reviewed = true;
  assert.ok(assistSource(adopted, "prd.intake.motion_plan", structure));
  adopted.prd.intake.motion_plan.waypoints[1].positions[0] = 0.7;
  assert.equal(
    assistSource(adopted, "prd.intake.motion_plan", structure),
    null,
  );
});

test("所有参与关节和模型配置都要校验，身体旁姿势保留非零向量", () => {
  assert.deepEqual(motionPlanIssues(plan(), structure), []);
  for (const mutate of [
    (p) => p.waypoints[1].positions.pop(),
    (p) => (p.waypoints[2].positions[1] = 1.1),
    (p) => (p.model_source_sha256 = "different"),
    (p) => p.joint_names.push("missing"),
    (p) => (p.waypoints[1].time_from_start_s = 0),
    (p) => (p.timeout_s = 6),
  ]) {
    const value = plan();
    mutate(value);
    assert.ok(motionPlanIssues(value, structure).length);
  }
  assert.deepEqual(plan().waypoints.at(-1).positions, [-0.3, 0.2]);
});
test("闭合区段展开三次，保存两关节完整向量和末尾姿势，不把发布编号当验收", () => {
  const original = plan();
  const expanded = repeatMotionSegment(original, 0, 2, 3);
  assert.equal(expanded.waypoints.length, 8);
  assert.deepEqual(
    expanded.waypoints.map((p) => p.time_from_start_s),
    [0, 2, 4, 6, 8, 10, 12, 15],
  );
  assert.deepEqual(
    expanded.waypoints.map((p) => p.cycle_index),
    [0, 1, 1, 2, 2, 3, 3, 0],
  );
  assert.deepEqual(
    expanded.waypoints.at(-1).positions,
    original.waypoints.at(-1).positions,
  );
  assert.equal(expanded.reviewed, false);
  assert.equal(expanded.timeout_s, 18);
  assert.deepEqual(original, plan());
  assert.equal(repeatMotionSegment(original, 0, 1, 3), null);
});
test("原话、模型、姿势、配置和验收变化均使核对失效，只勾选核对允许生效", () => {
  for (const mutate of [
    (d) => (d.request += "再停两秒"),
    (d) => (d.prd.intake.answers.structure_id = "another"),
    (d) => (d.prd.intake.motion_plan.waypoints[0].positions[1] = 0.2),
    (d) => (d.hardware.board = "esp32s3"),
    (d) => (d.prd.acceptance = "新的验收"),
  ]) {
    const previous = draft();
    const next = structuredClone(previous);
    mutate(next);
    assert.equal(
      invalidateMotionReview(previous, next).prd.intake.motion_plan.reviewed,
      false,
    );
    assert.equal(previous.prd.intake.motion_plan.reviewed, true);
  }
  const previous = draft();
  previous.prd.intake.motion_plan.reviewed = false;
  const next = structuredClone(previous);
  next.prd.intake.motion_plan.reviewed = true;
  assert.equal(
    invalidateMotionReview(previous, next).prd.intake.motion_plan.reviewed,
    true,
  );
});

const threeCycles = () => {
  const value = plan();
  const [prepare, b, a, finish] = value.waypoints;
  value.waypoints = [
    prepare,
    ...[1, 2, 3].flatMap((cycle) => [
      {
        ...structuredClone(b),
        cycle_index: cycle,
        time_from_start_s: cycle * 4 - 2,
      },
      {
        ...structuredClone(a),
        cycle_index: cycle,
        time_from_start_s: cycle * 4,
      },
    ]),
    { ...finish, time_from_start_s: 15 },
  ];
  value.timeout_s = 20;
  return value;
};
test("现有三次配方展开首组为三次，保留后两组并连续编号为整套五次", () => {
  const original = threeCycles();
  const expanded = repeatMotionSegment(original, 0, 2, 3);
  assert.deepEqual(
    expanded.waypoints.map((point) => point.cycle_index),
    [0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 0],
  );
  assert.deepEqual(
    expanded.waypoints
      .slice(-5)
      .map(({ positions, stage_id }) => ({ positions, stage_id })),
    original.waypoints
      .slice(-5)
      .map(({ positions, stage_id }) => ({ positions, stage_id })),
  );
  assert.deepEqual(
    expanded.waypoints.slice(-5).map((point) => point.time_from_start_s),
    [14, 16, 18, 20, 23],
  );
  assert.equal(expanded.timeout_s, 28);
  assert.deepEqual(original, threeCycles());
});
test("展开中间或末尾现有组也保留前序编号，后序组不会与新组撞号", () => {
  for (const [start, end] of [
    [2, 4],
    [4, 6],
  ]) {
    const original = threeCycles();
    const expanded = repeatMotionSegment(original, start, end, 3);
    assert.deepEqual(
      expanded.waypoints.map((point) => point.cycle_index),
      [0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 0],
    );
    assert.deepEqual(
      expanded.waypoints.slice(0, start + 1),
      original.waypoints.slice(0, start + 1),
    );
    assert.deepEqual(
      expanded.waypoints.at(-1).positions,
      original.waypoints.at(-1).positions,
    );
    assert.equal(expanded.reviewed, false);
  }
});
test("不截断现有循环组，不合并多个现有组，不把静止姿势标成往返", () => {
  const value = threeCycles();
  assert.equal(repeatMotionSegment(value, 1, 3, 3), null);
  assert.equal(repeatMotionSegment(value, 0, 4, 3), null);
  const stationary = plan();
  stationary.waypoints[1].positions = [...stationary.waypoints[0].positions];
  assert.equal(repeatMotionSegment(stationary, 0, 2, 3), null);
});
