import test from "node:test";
import assert from "node:assert/strict";
import {
  issueDestination,
  reviewIssueGroups,
  usesCompleteAction,
  recommendedStageRepetitions,
} from "../src/intakeIssues.ts";

const action = () => ({
  scope: "single_joint",
  related_joints: [{ name: "shoulder" }],
  stages: [{ repetitions: 1 }],
});
test("完整动作分类与后台一致，单个阶段重复也不能使用隐藏的单目标表单", () => {
  assert.equal(usesCompleteAction(null), false);
  assert.equal(usesCompleteAction(action()), false);
  for (const patch of [
    { scope: "multi_joint" },
    { related_joints: [] },
    { stages: [] },
    { related_joints: [{}, {}] },
    { stages: [{}, {}] },
    { stages: [{ repetitions: 3 }] },
  ])
    assert.equal(usesCompleteAction({ ...action(), ...patch }), true);
});
test("可补填项与平台暂不支持项分开，不能把执行限制当成缺少数字", () => {
  const invalid = { path: "a", label: "参数", message: "修改数值", section: 3 };
  const missing = {
    path: "b",
    label: "待核对",
    message: "人工确认",
    section: 3,
  };
  const unsupported = {
    path: "c",
    label: "多关节",
    message: "执行器未支持",
    section: 3,
  };
  const source = {
    invalid: [invalid],
    missing: [missing],
    unsupported: [unsupported],
  };
  const before = structuredClone(source);
  assert.deepEqual(reviewIssueGroups(source), {
    actionable: [invalid, missing],
    unsupported: [unsupported],
  });
  assert.deepEqual(source, before);
  assert.deepEqual(reviewIssueGroups(null), {
    actionable: [],
    unsupported: [],
  });
});
test("问题跳转定位真实动作清单、阶段和模型，不退回隐藏A/B输入", () => {
  const go = (path, message = "", section = 3) =>
    issueDestination({ path, label: "test", message, section });
  assert.deepEqual(go("prd.intake.action_draft.unresolved"), {
    path: "prd.intake.action_draft.unresolved",
    step: 2,
  });
  assert.deepEqual(go("prd.intake.action_draft", "完整动作还有待确认事项"), {
    path: "prd.intake.action_draft.unresolved",
    step: 2,
  });
  assert.deepEqual(go("prd.intake.action_draft.stages[1].target_rad"), {
    path: "prd.intake.action_draft.stages.1.target_rad",
    step: 2,
  });
  assert.deepEqual(go("prd.intake.action_draft.model_source_sha256"), {
    path: "prd.intake.answers.structure_id",
    step: 1,
  });
  assert.deepEqual(go("prd.intake.action_draft.reference_joint"), {
    path: "prd.intake.answers.joint_name",
    step: 1,
  });
  assert.deepEqual(go("prd.intake.action_draft.related_joints.0"), {
    path: "prd.intake.action_draft.related_joints.0",
    step: 1,
  });
  assert.deepEqual(go("prd.intake.answers.max_velocity_rad_s"), {
    path: "prd.intake.answers.max_velocity_rad_s",
    step: 2,
  });
});
test("准备招手与抬起放下推荐一次，不擅自改原有次数", () => {
  for (const title of [
    "准备招手姿势",
    "抬起右手准备挥手",
    "结束招手后放下",
    "回到招手前的位置",
  ])
    assert.equal(recommendedStageRepetitions(title), 1);
  for (const title of ["招手", "来回摆动", "重复挥手"])
    assert.equal(recommendedStageRepetitions(title), 3);
  const existing = { title: "准备招手姿势", repetitions: 3 };
  recommendedStageRepetitions(existing.title);
  assert.equal(existing.repetitions, 3);
});
