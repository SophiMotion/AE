import test from "node:test";
import assert from "node:assert/strict";
import { newDraft, fromProject } from "../src/draft.ts";
import { changeAnswer, changeIntent } from "../src/intakeGuide.ts";
import {
  applyRecommendations,
  clearRecommendation,
  recommendationSource,
  createRecommendationGate,
} from "../src/intakeRecommendations.ts";

const record = (path, value, draft, source = "example") => ({
  path,
  value,
  label: "测试字段",
  source,
  reason: "明确来源",
  section: 3,
  unit: null,
  rule_version: "prd-fill-v1",
  tool: "平台规则推荐（非 AI）",
  basis: {
    request_text: draft.request,
    intent: draft.prd.intake.intent,
    structure_id: draft.prd.intake.answers.structure_id,
    joint_name: draft.prd.intake.answers.joint_name,
    model_source_sha256: null,
  },
});
test("一键仅补空白，保留0、文字、硬件与八组设置", () => {
  const draft = newDraft();
  draft.request = "来回三次";
  draft.name = "我的名字";
  draft.prd.intake.intent = "oscillate";
  draft.prd.intake.answers.dwell_s = 0;
  const before = structuredClone(draft);
  const result = applyRecommendations(draft, [
    record("name", "新名", draft),
    record("prd.intake.answers.dwell_s", 0.3, draft),
    record("prd.intake.answers.repetitions", 3, draft, "request"),
    record("prd.intake.answers.board", "esp32", draft),
    record("prd.intake.mode", "simulation", draft),
    record("prd.intake.details.communication.selection", "platform", draft),
  ]);
  assert.deepEqual(draft, before);
  assert.equal(result.applied.length, 1);
  assert.equal(result.draft.name, "我的名字");
  assert.equal(result.draft.prd.intake.answers.dwell_s, 0);
  assert.equal(result.draft.prd.intake.answers.repetitions, 3);
  assert.equal(result.draft.prd.intake.answers.board, null);
  assert.deepEqual(result.draft.prd.intake.details, before.prd.intake.details);
  assert.deepEqual(result.draft.hardware, before.hardware);
});
test("用户修改一个字段仅清它的来源，其他记录仍保留", () => {
  let draft = newDraft();
  draft.prd.intake.intent = "oscillate";
  draft = applyRecommendations(draft, [
    record("prd.intake.answers.repetitions", 3, draft),
    record("prd.intake.answers.dwell_s", 0.3, draft),
    record("name", "往返", draft),
  ]).draft;
  draft.prd.intake.accepted_suggestions = ["answers.repetitions"];
  const edited = changeAnswer(draft, "repetitions", 5);
  assert.equal(edited.prd.intake.recommendation_records.length, 2);
  assert.deepEqual(edited.prd.intake.accepted_suggestions, []);
  const named = clearRecommendation({ ...edited, name: "我的名称" }, "name");
  assert.equal(named.prd.intake.recommendation_records.length, 1);
});
test("需求/关节/模型/意图改变留下值，但旧来源必须提示重新核对", () => {
  let draft = newDraft();
  draft.request = "摆动";
  draft.prd.intake.intent = "oscillate";
  draft = applyRecommendations(draft, [
    record("prd.intake.answers.repetitions", 3, draft, "request"),
  ]).draft;
  assert.equal(
    recommendationSource(draft, "prd.intake.answers.repetitions").stale,
    false,
  );
  for (const changed of [
    { ...draft, request: "摆动五次" },
    changeAnswer(draft, "joint_name", "other"),
    changeAnswer(draft, "structure_id", "other"),
    changeIntent(draft, "position"),
  ]) {
    assert.equal(changed.prd.intake.answers.repetitions, 3);
    assert.equal(
      recommendationSource(changed, "prd.intake.answers.repetitions").stale,
      true,
    );
  }
});
test("相同配置别名使用配置指纹，不同配置不能用上游hash冒充", () => {
  const draft = newDraft();
  draft.prd.intake.intent = "position";
  draft.prd.intake.answers.structure_id = "frozen";
  const rec = record("prd.intake.answers.target_rad", 0.6, draft);
  rec.basis.structure_id = "alias";
  rec.basis.model_source_sha256 = "config-a";
  const recommended = applyRecommendations(draft, [rec]).draft;
  assert.equal(
    recommendationSource(recommended, rec.path, {
      id: "frozen",
      mapping_source_sha256: "config-a",
    }).stale,
    false,
  );
  assert.equal(
    recommendationSource(recommended, rec.path, {
      id: "frozen",
      mapping_source_sha256: "config-b",
      source_sha256: "config-a",
    }).stale,
    true,
  );
});
test("不隐式升级V1，不重复写记录，重新打开保留来源", () => {
  const old = newDraft();
  old.prd.intake.schema_version = 1;
  delete old.prd.intake.details;
  assert.equal(
    applyRecommendations(old, [record("name", "建议", old)]).draft,
    old,
  );
  const draft = newDraft();
  const suggestions = [record("name", "建议", draft)];
  const first = applyRecommendations(draft, suggestions).draft;
  assert.equal(applyRecommendations(first, suggestions).applied.length, 0);
  assert.deepEqual(
    fromProject({ ...first, id: "test" }).prd.intake.recommendation_records,
    first.prd.intake.recommendation_records,
  );
});
test("迟到响应无法覆盖改过的草稿、其他工程或后发请求", () => {
  const gate = createRecommendationGate();
  const first = gate.begin("draft-a");
  assert.equal(gate.accepts(first, "draft-a"), true);
  assert.equal(gate.accepts(first, "draft-b"), false);
  const second = gate.begin("draft-a");
  assert.equal(gate.accepts(first, "draft-a"), false);
  assert.equal(gate.accepts(second, "draft-a"), true);
  gate.cancel();
  assert.equal(gate.accepts(second, "draft-a"), false);
  assert.equal(gate.active(second), false);
});
