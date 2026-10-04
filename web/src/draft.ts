import type {
  EngineeringWorkflow,
  Parameters,
  PRD,
  Project,
  Task,
  TaskType,
} from "./api";
import { defaultWorkflow } from "./workflowModel.ts";
import { emptyIntake } from "./intakeGuide.ts";

export interface Draft {
  name: string;
  request: string;
  task_type: TaskType | null;
  parameters: Project["parameters"];
  hardware: Project["hardware"];
  prd: PRD;
  workflow: EngineeringWorkflow;
}
export const emptyPRD: PRD = {
  use_case: "关节位置控制",
  environment: "desktop_simulation",
  constraints: "在本机模拟设备中验证，不连接实物，不烧录控制板。",
  acceptance:
    "达到指定目标、误差符合要求；失联后停止输出；两端消息能正确收发。",
  structure_id: "builtin-joint",
  joint_name: null,
};
const sensorAcceptance =
  "传感器达到阈值时触发，低于阈值时关闭；失联后归零；两端消息能正确收发。";
export const emptyDraft: Draft & { parameters: Parameters } = {
  name: "关节位置控制",
  request: "让模拟关节转到指定位置，检查是否达到目标。",
  task_type: "joint_position",
  parameters: {
    target: 0.6,
    threshold: 0.5,
    tolerance: 0.04,
    duration: 8,
    max_velocity: 0.8,
  },
  hardware: {
    board: "esp32",
    transport: "serial_jsonl",
    ros_distro: "humble",
    actuator: "virtual_joint",
    sensor: "simulated_encoder",
    baudrate: 115200,
    physical_io: false,
  },
  prd: emptyPRD,
  workflow: defaultWorkflow(),
};
export function newDraft(): Draft {
  return {
    ...emptyDraft,
    name: "",
    request: "",
    parameters: { ...emptyDraft.parameters },
    hardware: { ...emptyDraft.hardware },
    prd: {
      ...emptyPRD,
      use_case: "",
      constraints: "",
      acceptance: "",
      structure_id: null,
      joint_name: null,
      intake: emptyIntake(),
    },
    workflow: defaultWorkflow(),
  };
}
export function fromProject(project: Project): Draft {
  const isJoint = project.task_type === "joint_position";
  return {
    name: project.name,
    request: project.request,
    task_type: project.task_type,
    parameters: { ...project.parameters },
    hardware: { ...project.hardware },
    workflow: project.workflow
      ? structuredClone(project.workflow)
      : defaultWorkflow(),
    prd: project.prd
      ? structuredClone(project.prd)
      : {
          ...emptyPRD,
          use_case: isJoint ? "关节位置控制" : "传感器阈值",
          structure_id: isJoint ? "builtin-joint" : "builtin-sensor",
          acceptance: isJoint ? emptyPRD.acceptance : sensorAcceptance,
        },
  };
}
export function selectTask(draft: Draft, task: Task): Draft {
  const isJoint = task.id === "joint_position";
  return {
    ...draft,
    name: task.label,
    task_type: task.id,
    request: task.default_request,
    parameters: { ...draft.parameters, ...task.parameters },
    hardware: {
      ...draft.hardware,
      actuator: isJoint ? "virtual_joint" : "virtual_switch",
      sensor: isJoint ? "simulated_encoder" : "simulated_scalar",
      baudrate: 115200,
      physical_io: false,
    },
    prd: {
      ...draft.prd,
      use_case: task.label,
      structure_id: isJoint ? "builtin-joint" : "builtin-sensor",
      joint_name: null,
      acceptance: isJoint ? emptyPRD.acceptance : sensorAcceptance,
    },
  };
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
export function draftIsChanged(draft: Draft, project: Project | null): boolean {
  return (
    !project ||
    JSON.stringify(canonical(draft)) !==
      JSON.stringify(canonical(fromProject(project)))
  );
}
