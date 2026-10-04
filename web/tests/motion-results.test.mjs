import test from "node:test";
import assert from "node:assert/strict";
import {
  motionCaseSummary,
  motionCaseCheckLabel,
} from "../src/motionResults.ts";
const check = (name, passed = true) => ({ name, passed, detail: "observed" });

test("六种真实场景分别显示中文用途，不把故意中断标成招手需求失败", () => {
  const labels = {
    motion_1: "正常动作 1",
    motion_2: "正常动作 2",
    motion_3: "正常动作 3",
    command_loss: "停止发送指令",
    measurement_loss: "停止反馈测量",
    cancel: "中途取消",
  };
  for (const [name, label] of Object.entries(labels)) {
    const result = motionCaseSummary(name, [
      check(`${name}_observed_all_channels`),
      check(`${name}_watchdog_zero`),
    ]);
    assert.equal(result.label, label);
    assert.equal(result.passed, true);
    assert.match(
      result.outcome,
      name.startsWith("motion_")
        ? /实际到位与往返次数检查通过/
        : /按计划中断，停机\/取消检查通过/,
    );
    assert.equal(result.kind, name.startsWith("motion_") ? "normal" : "stop");
  }
});
test("检查记录必须存在且当前场景全部通过；缺记录和失败不能报通过", () => {
  for (const name of [
    "motion_1",
    "command_loss",
    "measurement_loss",
    "cancel",
  ]) {
    assert.equal(motionCaseSummary(name, []).passed, null);
    assert.match(motionCaseSummary(name, []).outcome, /缺少/);
    const value = motionCaseSummary(name, [
      check(`${name}_observed_all_channels`),
      check(`${name}_simulator_stopped`, false),
    ]);
    assert.equal(value.passed, false);
    assert.match(value.outcome, /未通过/);
  }
  assert.equal(
    motionCaseSummary("motion_1", [check("motion_10_all_waypoints")]).passed,
    null,
  );
  assert.equal(
    motionCaseSummary("motion_1", [
      check("motion_1_all_waypoints"),
      check("motion_2_all_waypoints", false),
    ]).passed,
    true,
  );
});
test("正常动作以实际位置和次数检查为准，停机关键证据使用中文", () => {
  const normal = motionCaseSummary("motion_1", [
    check("motion_1_jtc_succeeded"),
    check("motion_1_all_waypoints", false),
    check("motion_1_all_cycles", false),
  ]);
  assert.equal(normal.passed, false);
  assert.equal(
    motionCaseCheckLabel(
      "command_loss",
      check("command_loss_simulator_stopped"),
    ),
    "实际仿真关节停稳",
  );
  assert.equal(
    motionCaseCheckLabel("cancel", check("cancel_cancel_hold")),
    "取消后实际关节位置稳定",
  );
  assert.equal(
    motionCaseSummary("unrecognized", [check("unrecognized_observed")]).kind,
    "unknown",
  );
});
