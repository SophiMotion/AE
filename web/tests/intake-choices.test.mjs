import test from "node:test";
import assert from "node:assert/strict";
import {
  numberChoices,
  matchesNumberChoice,
  blankNumberRecommendations,
} from "../src/intakeChoices.ts";
import {
  changeAnswer,
  parseDisplayNumber,
  formatDisplayNumber,
} from "../src/intakeGuide.ts";
import { newDraft } from "../src/draft.ts";

test("速度和误差预设保存弧度，切换显示后仍是相同程序值", () => {
  const speed = numberChoices("max_velocity_rad_s").find(
    (x) => x.recommended,
  ).value;
  const tolerance = numberChoices("tolerance_rad").find(
    (x) => x.recommended,
  ).value;
  assert.ok(Math.abs(speed - Math.PI / 6) < 1e-14);
  assert.ok(Math.abs(tolerance - (2 * Math.PI) / 180) < 1e-14);
  assert.ok(
    matchesNumberChoice(
      parseDisplayNumber(formatDisplayNumber(speed, "deg"), "deg"),
      speed,
    ),
  );
  assert.equal(formatDisplayNumber(speed, "rad"), String(speed));
});
test("推荐的数值适合已定义的范围，多阶段有独立观察窗口", () => {
  const ranges = {
    max_velocity_rad_s: [0.1, 2],
    tolerance_rad: [0.005, 0.15],
    duration_s: [4, 30],
    repetitions: [1, 1000],
    dwell_s: [0, 60],
    threshold: [0.1, 0.9],
  };
  for (const [key, [lo, hi]] of Object.entries(ranges)) {
    const options = numberChoices(key);
    assert.equal(options.filter((x) => x.recommended).length, 1, key);
    for (const item of options)
      assert.ok(item.value >= lo && item.value <= hi, key);
  }
  assert.equal(numberChoices("duration_s").find((x) => x.recommended).value, 8);
  assert.equal(
    numberChoices("duration_s", true).find((x) => x.recommended).value,
    15,
  );
});
test("采用本组推荐只补空白，保留0、自定义值，不猜角度和实物信息", () => {
  const answers = {
    duration_s: null,
    max_velocity_rad_s: 0.417,
    tolerance_rad: null,
    repetitions: 0,
    dwell_s: 0,
    target_rad: null,
    wave_start_rad: null,
    board: null,
    pin: null,
  };
  const before = structuredClone(answers);
  const result = blankNumberRecommendations(
    answers,
    Object.keys(answers),
    true,
  );
  assert.deepEqual(Object.keys(result), ["duration_s", "tolerance_rad"]);
  assert.equal(result.duration_s, 15);
  assert.deepEqual(answers, before);
  for (const key of [
    "target_rad",
    "wave_start_rad",
    "end_position_rad",
    "board",
    "pin",
    "missing",
  ])
    assert.deepEqual(numberChoices(key), []);
});
test("点击本地选项走手动编辑，不冒充AI，也不改变执行参数或动作", () => {
  let draft = newDraft();
  draft.prd.intake.accepted_suggestions = ["answers.duration_s"];
  draft.prd.intake.answers.duration_s = 8;
  const parameters = structuredClone(draft.parameters);
  const next = changeAnswer(
    draft,
    "duration_s",
    numberChoices("duration_s", true).find((x) => x.recommended).value,
  );
  assert.equal(next.prd.intake.answers.duration_s, 15);
  assert.ok(
    !next.prd.intake.accepted_suggestions.includes("answers.duration_s"),
  );
  assert.deepEqual(next.parameters, parameters);
  assert.equal(next.prd.intake.answers.target_rad, null);
  assert.equal(
    next.prd.intake.recommendation_bundle,
    draft.prd.intake.recommendation_bundle,
  );
});
test("当前值和空白严格区分，0可以是选择值但不会自动生成来源", () => {
  assert.equal(matchesNumberChoice(null, 0), false);
  assert.equal(matchesNumberChoice(0, 0), true);
  assert.equal(matchesNumberChoice(0.417, Math.PI / 6), false);
  assert.equal(matchesNumberChoice(NaN, 0), false);
});
