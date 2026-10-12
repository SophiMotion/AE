/** The flow config describes a source snapshot, never a hardware command. */
export interface FoldBotFlowConfig {
  schema_version: 1;
  robot: "foldbot";
  control: "esp" | "ros";
  wiring_reviewed: boolean;
  ros_host: "local" | "jetson" | "raspberrypi";
  ros_version: "humble" | "jazzy";
  ros_serial: string;
  action_group: "fold-cycle" | "arm-demo" | "chassis-demo";
}

export function defaultFoldBotFlow(): FoldBotFlowConfig {
  return {
    schema_version: 1, robot: "foldbot", control: "esp",
    wiring_reviewed: false, ros_host: "local", ros_version: "humble",
    ros_serial: "", action_group: "fold-cycle",
  };
}

const keys = Object.keys(defaultFoldBotFlow());
/** Serial labels are configuration data only. Never interpolate into a shell. */
export function validateFoldBotFlow(value: unknown): value is FoldBotFlowConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const flow = value as Record<string, unknown>;
  return Object.keys(flow).length === keys.length && keys.every((key) => Object.hasOwn(flow, key)) &&
    flow.schema_version === 1 && flow.robot === "foldbot" &&
    (flow.control === "esp" || flow.control === "ros") &&
    typeof flow.wiring_reviewed === "boolean" &&
    ["local", "jetson", "raspberrypi"].includes(flow.ros_host as string) &&
    ["humble", "jazzy"].includes(flow.ros_version as string) &&
    typeof flow.ros_serial === "string" && flow.ros_serial.length <= 120 &&
    /^(?:|COM[1-9][0-9]{0,3}|\/dev\/(?:ttyUSB[0-9]{1,3}|ttyACM[0-9]{1,3}|cu\.[A-Za-z0-9_.-]{1,80}))$/.test(flow.ros_serial) &&
    ["fold-cycle", "arm-demo", "chassis-demo"].includes(flow.action_group as string);
}

/** Missing legacy values get defaults; malformed saved values are never silently accepted. */
export function normalizeFoldBotFlow(value?: unknown): FoldBotFlowConfig {
  if (value === undefined) return defaultFoldBotFlow();
  if (!validateFoldBotFlow(value)) throw new Error("invalid_foldbot_workflow");
  return Object.fromEntries(keys.map((key) => [key, value[key as keyof FoldBotFlowConfig]])) as unknown as FoldBotFlowConfig;
}

/** Preserve an incomplete serial edit during cache hydration, never for save or generation. */
export function normalizeFoldBotDraftFlow(value?: unknown): FoldBotFlowConfig {
  if (value === undefined) return defaultFoldBotFlow();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_foldbot_workflow");
  const draft = value as Record<string, unknown>;
  if (typeof draft.ros_serial !== "string" || draft.ros_serial.length > 120) throw new Error("invalid_foldbot_workflow");
  const normalized = normalizeFoldBotFlow({ ...draft, ros_serial: "" });
  return { ...normalized, ros_serial: draft.ros_serial };
}

/** Read from the existing Sophicar source; these are not verified physical connections. */
export const FOLDBOT_SOURCE_WIRING = [
  { id: "fold1", label: "第一折叠板", labelEn: "Fold plate 1", pins: "DIR GPIO3 · STEP GPIO8 · EN GPIO10", connection: "外置驱动器 DIR+ / PUL+ / ENA+；控制负端接逻辑 GND", connectionEn: "External driver DIR+ / PUL+ / ENA+; negative inputs to logic GND", verified: false },
  { id: "fold2", label: "第二折叠板", labelEn: "Fold plate 2", pins: "DIR GPIO4 · STEP GPIO5 · EN GPIO9", connection: "外置驱动器 DIR+ / PUL+ / ENA+；控制负端接逻辑 GND", connectionEn: "External driver DIR+ / PUL+ / ENA+; negative inputs to logic GND", verified: false },
  { id: "arm", label: "机械臂总线", labelEn: "Arm bus", pins: "TX GPIO6 → RX · RX GPIO7 ← TX", connection: "BusLinker TTL + 共地；舵机使用独立适配电源", connectionEn: "BusLinker TTL and common ground; appropriate separate servo supply", verified: false },
  { id: "chassis", label: "履带底盘", labelEn: "Tracked chassis", pins: "M1 GPIO38 / 37 · M2 GPIO36 / 35", connection: "GPIO35–37 与 N16R8 存储器兼容性待确认，勿作为已验证接线", connectionEn: "GPIO35–37 / N16R8 memory compatibility is unresolved, not verified wiring", verified: false },
  { id: "limits", label: "限位开关", labelEn: "Limit switches", pins: "GPIO16 / 17 / 18 / 39", connection: "当前源码禁用；上电后需按实物确认端位，不能自动归零", connectionEn: "Disabled in source; confirm physical endpoints after power-on, no automatic homing", verified: false },
] as const;
