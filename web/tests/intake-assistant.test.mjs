import test from "node:test";
import assert from "node:assert/strict";
import { newDraft, fromProject } from "../src/draft.ts";
import { changeAnswer } from "../src/intakeGuide.ts";
import {
  applyAssistant,
  assistantValue,
  clearAssistRecord,
  assistSource,
  assistantPathAllowed,
  formatAssistValue,
} from "../src/intakeAssistant.ts";
const provenance = {
  tool: "AI test fixture",
  model: "test",
  prompt: "test prompt",
  response: "{}",
  status: "test_fixture",
};
test('冲突数值按显示单位取三位小数，带单位但不改变原值',()=>{
 const speed=20*Math.PI/180;
 assert.equal(formatAssistValue('prd.intake.answers.max_velocity_rad_s',speed,'deg'),'20°/秒');
 assert.equal(formatAssistValue('prd.intake.answers.max_velocity_rad_s',speed,'rad'),'0.349 rad/秒');
 assert.equal(formatAssistValue('prd.intake.answers.target_rad',Math.PI/6,'deg'),'30°');
 assert.equal(formatAssistValue('prd.intake.answers.tolerance_rad',.04,'rad'),'0.04 rad');
 assert.equal(formatAssistValue('prd.intake.answers.duration_s',15),'15 秒');
 assert.equal(formatAssistValue('prd.intake.answers.repetitions',3),'3 次');
 assert.equal(formatAssistValue('prd.intake.answers.dwell_s',0),'0 秒');
 assert.equal(formatAssistValue('prd.intake.action_draft',{}),'完整内容（展开查看）');
 assert.equal(speed,20*Math.PI/180);
});
const rec = (path, value, draft) => ({
  path,
  value,
  label: "测试",
  source: "ai",
  reason: "测试依据",
  section: 2,
  basis: {
    request_text: draft.request,
    structure_id: draft.prd.intake.answers.structure_id,
    model_source_sha256: null,
  },
});
const action = {
  schema_version: 1,
  structure_id: "model",
  model_source_sha256: null,
  summary: "抬起右手招手三次再放到旁边",
  scope: "multi_joint",
  reference_joint: "right_shoulder",
  related_joints: [
    { name: "right_shoulder", label: "右肩", role: "抬臂", reason: "模型名称" },
    { name: "right_elbow", label: "右肘", role: "屈肘", reason: "模型名称" },
  ],
  stages: [
    {
      id: "up",
      title: "抬右臂",
      description: "先抬起",
      joint_names: ["right_shoulder"],
      repetitions: null,
      target_rad: null,
      confirmation_needed: true,
    },
    {
      id: "wave",
      title: "招手",
      description: "往返三次",
      joint_names: ["right_shoulder", "right_elbow"],
      repetitions: 3,
      target_rad: null,
      confirmation_needed: true,
    },
    {
      id: "down",
      title: "放下",
      description: "身体旁边",
      joint_names: ["right_shoulder"],
      repetitions: null,
      target_rad: null,
      confirmation_needed: true,
    },
  ],
  end_pose_text: "手臂在身体旁边",
  unresolved: ["姿势角度待核对"],
  requires_review: true,
};
test("智能填写保留已有0和左肩，补完整动作但不改原话或硬件", () => {
  const draft = newDraft();
  draft.request = "右臂招手三次";
  draft.prd.intake.answers.joint_name = "left";
  draft.prd.intake.answers.dwell_s = 0;
  const before = structuredClone(draft);
  const result = applyAssistant(
    draft,
    [
      rec("prd.intake.answers.joint_name", "right", draft),
      rec("prd.intake.answers.dwell_s", 0.3, draft),
      rec("prd.intake.action_draft", action, draft),
      rec("request", "changed", draft),
      rec("hardware.physical_io", true, draft),
      rec("prd.intake.answers.board", "esp32s3", draft),
    ],
    provenance,
  );
  assert.deepEqual(draft, before);
  assert.equal(result.draft.request, "右臂招手三次");
  assert.equal(result.draft.prd.intake.answers.joint_name, "left");
  assert.equal(result.draft.prd.intake.answers.dwell_s, 0);
  assert.deepEqual(result.draft.prd.intake.action_draft, action);
  assert.equal(result.draft.prd.intake.answers.board, "esp32s3");
  assert.deepEqual(result.draft.hardware, before.hardware);
});
test("冲突只能显式采用且目前值必须与结果一致", () => {
  const draft = newDraft();
  draft.prd.intake.answers.joint_name = "left";
  const conflict = {
    ...rec("prd.intake.answers.joint_name", "right", draft),
    current_value: "left",
  };
  assert.equal(applyAssistant(draft, [conflict], provenance).applied.length, 0);
  assert.equal(
    applyAssistant(draft, [conflict], provenance, conflict).draft.prd.intake
      .answers.joint_name,
    "right",
  );
  draft.prd.intake.answers.joint_name = "elbow";
  assert.equal(
    applyAssistant(draft, [conflict], provenance, conflict).applied.length,
    0,
  );
});
test("不能替换有补充内容的八组字段和重复覆盖完整动作", () => {
  const draft = newDraft();
  draft.prd.intake.details.communication.message = "用户通信格式";
  draft.prd.intake.action_draft = action;
  const candidate = {
    ...draft.prd.intake.details.communication,
    selection: "platform",
    message: "",
  };
  const conflict = {
    ...rec("prd.intake.details.communication", candidate, draft),
    current_value: draft.prd.intake.details.communication,
  };
  assert.equal(
    applyAssistant(draft, [conflict], provenance, conflict).applied.length,
    0,
  );
  assert.equal(
    applyAssistant(
      draft,
      [rec("prd.intake.action_draft", { ...action, summary: "另一个" }, draft)],
      provenance,
    ).applied.length,
    0,
  );
});
test("手工修改清除对应来源，保存刷新保留其他来源和完整动作", () => {
  let draft = newDraft();
  draft.request = "右手招手";
  draft = applyAssistant(
    draft,
    [
      rec("prd.intake.answers.repetitions", 3, draft),
      rec("prd.intake.action_draft", action, draft),
    ],
    provenance,
  ).draft;
  draft = changeAnswer(draft, "repetitions", 5);
  assert.deepEqual(
    draft.prd.intake.recommendation_bundle.records.map((x) => x.path),
    ["prd.intake.action_draft"],
  );
  const restored = fromProject({ ...draft, id: "test" });
  assert.deepEqual(restored.prd.intake.action_draft, action);
  assert.deepEqual(
    restored.prd.intake.recommendation_bundle,
    draft.prd.intake.recommendation_bundle,
  );
  const changed = clearAssistRecord(
    {
      ...draft,
      prd: {
        ...draft.prd,
        intake: {
          ...draft.prd.intake,
          action_draft: { ...action, summary: "手改" },
        },
      },
    },
    "prd.intake.action_draft",
  );
  assert.equal(changed.prd.intake.recommendation_bundle.records.length, 0);
});
test("原话/模型变化旧建议需核对，规则v1及任意路径保持阻挡", () => {
  const draft = newDraft();
  const filled = applyAssistant(
    draft,
    [rec("name", "建议", draft)],
    provenance,
  ).draft;
  assert.equal(assistSource(filled, "name").stale, false);
  assert.equal(assistSource({ ...filled, request: "new" }, "name").stale, true);
  assert.equal(assistantValue(filled, "__proto__.polluted"), undefined);
  assert.equal(
    assistantPathAllowed("prd.intake.details.motion.__proto__"),
    false,
  );
  draft.prd.intake.schema_version = 1;
  assert.equal(
    applyAssistant(draft, [rec("name", "不填", draft)], provenance).applied
      .length,
    0,
  );
});
test("多次填写保留每个字段对应的工具提示词，不误归到最新调用", () => {
  const first = {
    ...provenance,
    invocation_id: "a".repeat(32),
    prompt: "first prompt",
  };
  const second = {
    ...provenance,
    invocation_id: "b".repeat(32),
    prompt: "second prompt",
  };
  let draft = newDraft();
  draft = applyAssistant(
    draft,
    [
      {
        ...rec("name", "第一个字段", draft),
        invocation_id: first.invocation_id,
      },
    ],
    first,
  ).draft;
  draft = applyAssistant(
    draft,
    [
      {
        ...rec("prd.intake.answers.repetitions", 3, draft),
        invocation_id: second.invocation_id,
      },
    ],
    second,
  ).draft;
  assert.equal(assistSource(draft, "name").provenance.prompt, "first prompt");
  assert.equal(
    assistSource(draft, "prd.intake.answers.repetitions").provenance.prompt,
    "second prompt",
  );
  assert.equal(draft.prd.intake.recommendation_bundle.history.length, 2);
  const legacy = applyAssistant(
    newDraft(),
    [rec("name", "旧建议", newDraft())],
    provenance,
  ).draft;
  assert.equal(assistSource(legacy, "name").provenance, null);
});
