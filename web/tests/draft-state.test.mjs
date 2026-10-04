import assert from "node:assert/strict";
import test from "node:test";
import {
  newDraft,
  fromProject,
  selectTask,
  draftIsChanged,
} from "../src/draft.ts";

const project = () => ({
  ...newDraft(),
  id: "existing",
  spec_revision: 3,
  status: "approved",
  approval: { spec_revision: 3 },
  plan: {},
  latest_run_id: "run-1",
});

test("切换任务会更换模拟对象和结构，保留用户选定板型与限制", () => {
  const draft = newDraft();
  draft.hardware.board = "esp32s3";
  draft.prd.structure_id = "structure-imported";
  draft.prd.joint_name = "shoulder_l";
  draft.prd.constraints = "不得驱动实体设备";
  const result = selectTask(draft, {
    id: "sensor_threshold",
    label: "传感器阈值",
    default_request: "数值超过阈值后触发",
    parameters: { ...draft.parameters, threshold: 0.7 },
  });
  assert.equal(result.hardware.board, "esp32s3");
  assert.equal(result.hardware.actuator, "virtual_switch");
  assert.equal(result.hardware.sensor, "simulated_scalar");
  assert.equal(result.hardware.physical_io, false);
  assert.equal(result.prd.structure_id, "builtin-sensor");
  assert.equal(result.prd.joint_name, null);
  assert.equal(result.prd.constraints, "不得驱动实体设备");
  assert.match(result.prd.acceptance, /阈值/);
  assert.equal(draft.prd.structure_id, "structure-imported");
});

test("板型、通信、结构或验收被修改，都不能继续沿用已批准规格", () => {
  const saved = project();
  const edits = [
    (d) => {
      d.hardware.board = "esp32s3";
    },
    (d) => {
      d.hardware.transport = "simulated";
    },
    (d) => {
      d.parameters.target = 0.8;
    },
    (d) => {
      d.prd.structure_id = "sophicore-reference";
    },
    (d) => {
      d.prd.joint_name = "test_joint";
    },
    (d) => {
      d.prd.acceptance = "要求更严格的误差";
    },
    (d) => {
      d.prd.constraints = "调整测试限制";
    },
    (d) => {
      d.request = "改变测试需求";
    },
  ];
  for (const edit of edits) {
    const draft = fromProject(saved);
    edit(draft);
    assert.equal(draftIsChanged(draft, saved), true);
  }
  assert.equal(saved.hardware.board, "esp32");
  assert.equal(saved.parameters.target, 0.6);
});

test("后台状态刷新及JSON键顺序变化，不会误报用户修改", () => {
  const saved = project(),
    draft = fromProject(saved);
  saved.status = "testing";
  saved.hardware = Object.fromEntries(Object.entries(saved.hardware).reverse());
  assert.equal(draftIsChanged(draft, saved), false);
});

test("旧传感器工程只补需求表，不冒充已选真实板型", () => {
  const saved = project();
  delete saved.prd;
  saved.task_type = "sensor_threshold";
  saved.hardware = {
    board: "未指定（模拟）",
    transport: "simulated",
    ros_distro: "humble",
  };
  const draft = fromProject(saved);
  assert.equal(draft.hardware.board, "未指定（模拟）");
  assert.equal(draft.prd.structure_id, "builtin-sensor");
  assert.match(draft.prd.acceptance, /阈值/);
  assert.equal(draftIsChanged(draft, saved), false);
  assert.equal(saved.prd, undefined);
});

test("新建工程的参数独立，不会把上一份草稿的值带过去", () => {
  const first = newDraft();
  first.parameters.target = 1;
  first.hardware.board = "esp32s3";
  first.prd.acceptance = "自定义";
  const second = newDraft();
  assert.equal(second.parameters.target, 0.6);
  assert.equal(second.hardware.board, "esp32");
  assert.notEqual(second.prd.acceptance, "自定义");
  assert.equal(draftIsChanged(second, null), true);
});
