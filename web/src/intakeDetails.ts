import type { PRDIntake } from "./api";

export type DetailSelection = null | "platform" | "custom";
export interface MotionStep {
  id: string;
  kind: "move" | "wait" | "condition" | "other";
  joint_name: string | null;
  target_rad: number | null;
  duration_s: number | null;
  condition: string;
  timeout_s: number | null;
  on_failure: string;
  description: string;
}
export interface DeviceMapping {
  id: string;
  structure_id: string | null;
  joint_name: string | null;
  source_sha256: string | null;
  device: string;
  driver: string;
  interface: string;
  address: string;
  wiring: string;
  feedback: string;
  source: string;
  status: "unknown" | "provided" | "documented";
}
export interface IntakeDetails {
  motion: {
    pattern: null | "from_answers" | "sequence" | "parallel";
    completion: null | "all" | "custom";
    completion_note: string;
    steps: MotionStep[];
  };
  lifecycle: {
    selection: DetailSelection;
    start: string;
    finish: string;
    cancel: string;
  };
  device_mapping: {
    scope: null | "simulation_only" | "reference_only" | "required";
    entries: DeviceMapping[];
  };
  coordinates: {
    selection: DetailSelection;
    zero: string;
    direction: string;
    command_unit: string;
    feedback: string;
    conversion: string;
    source: string;
  };
  communication: {
    selection: DetailSelection;
    transport: string;
    ros_role: string;
    esp_role: string;
    message: string;
    rate_hz: number | null;
    timeout_ms: number | null;
  };
  faults: {
    selection: DetailSelection;
    disconnect: string;
    invalid_data: string;
    limit_hit: string;
    recovery: string;
  };
  acceptance: {
    selection: DetailSelection;
    criteria: {
      id: string;
      metric: string;
      expected: string;
      method: string;
    }[];
  };
  environment: {
    selection: DetailSelection;
    mounting: string;
    load_kg: number | null;
    obstacles: string;
    space: string;
    notes: string;
  };
}
export type DetailGroupKey = keyof IntakeDetails;
export const detailLabels: Record<DetailGroupKey, string> = {
  motion: "动作步骤",
  lifecycle: "开始、结束和取消",
  device_mapping: "关节与设备对应",
  coordinates: "零位、方向和单位",
  communication: "ROS / ESP32 分工与通信",
  faults: "出错以后怎么办",
  acceptance: "怎样检查结果",
  environment: "在什么条件下测试",
};
export const detailSections: Record<DetailGroupKey, number> = {
  motion: 3,
  lifecycle: 3,
  device_mapping: 4,
  coordinates: 4,
  communication: 4,
  faults: 5,
  acceptance: 5,
  environment: 5,
};
export function emptyDetails(): IntakeDetails {
  return {
    motion: { pattern: null, completion: null, completion_note: "", steps: [] },
    lifecycle: { selection: null, start: "", finish: "", cancel: "" },
    device_mapping: { scope: null, entries: [] },
    coordinates: {
      selection: null,
      zero: "",
      direction: "",
      command_unit: "",
      feedback: "",
      conversion: "",
      source: "",
    },
    communication: {
      selection: null,
      transport: "",
      ros_role: "",
      esp_role: "",
      message: "",
      rate_hz: null,
      timeout_ms: null,
    },
    faults: {
      selection: null,
      disconnect: "",
      invalid_data: "",
      limit_hit: "",
      recovery: "",
    },
    acceptance: { selection: null, criteria: [] },
    environment: {
      selection: null,
      mounting: "",
      load_kg: null,
      obstacles: "",
      space: "",
      notes: "",
    },
  };
}
function hasValue(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.values(value).some(hasValue);
  return true; // 0 is a user supplied value, not an empty field.
}
export function hasDetailExtras<K extends DetailGroupKey>(
  group: K,
  value: IntakeDetails[K],
): boolean {
  const ignored =
    group === "motion"
      ? ["pattern", "completion"]
      : group === "device_mapping"
        ? ["scope"]
        : ["selection"];
  return Object.entries(value).some(
    ([key, item]) => !ignored.includes(key) && hasValue(item),
  );
}
export function clearDetailGroup<K extends DetailGroupKey>(
  details: IntakeDetails,
  group: K,
): IntakeDetails {
  const next = structuredClone(details),
    clean = emptyDetails();
  if (group === "motion")
    clean.motion = {
      ...clean.motion,
      pattern: "from_answers",
      completion: "all",
    };
  else if (group === "device_mapping")
    clean.device_mapping.scope = "simulation_only";
  else (clean[group] as { selection: DetailSelection }).selection = "platform";
  return { ...next, [group]: clean[group] };
}
export function adoptPlatformDetails(details: IntakeDetails): IntakeDetails {
  let next = structuredClone(details);
  for (const group of Object.keys(details) as DetailGroupKey[]) {
    const value = details[group];
    if (hasDetailExtras(group, value)) continue;
    if (group === "motion") {
      if (
        (details.motion.pattern === null ||
          details.motion.pattern === "from_answers") &&
        (details.motion.completion === null ||
          details.motion.completion === "all")
      )
        next.motion = {
          ...next.motion,
          pattern: "from_answers",
          completion: "all",
        };
    } else if (group === "device_mapping") {
      if (details.device_mapping.scope === null)
        next.device_mapping.scope = "simulation_only";
    } else if (details[group].selection === null)
      next = clearDetailGroup(next, group);
  }
  return next;
}
export function upgradeIntake(intake: PRDIntake): PRDIntake {
  return intake.schema_version === 2
    ? structuredClone(intake)
    : {
        ...structuredClone(intake),
        schema_version: 2,
        details: emptyDetails(),
      };
}
export function newMotionStep(): MotionStep {
  return {
    id: crypto.randomUUID(),
    kind: "move",
    joint_name: null,
    target_rad: null,
    duration_s: null,
    condition: "",
    timeout_s: null,
    on_failure: "",
    description: "",
  };
}
export function newDeviceMapping(): DeviceMapping {
  return {
    id: crypto.randomUUID(),
    structure_id: null,
    joint_name: null,
    source_sha256: null,
    device: "",
    driver: "",
    interface: "",
    address: "",
    wiring: "",
    feedback: "",
    source: "",
    status: "unknown",
  };
}
export function reorderRow<T>(
  items: T[],
  index: number,
  direction: -1 | 1,
): T[] {
  const next = [...items],
    target = index + direction;
  if (
    index < 0 ||
    index >= items.length ||
    target < 0 ||
    target >= items.length
  )
    return next;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
