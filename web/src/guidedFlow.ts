import { FOLDBOT_SOURCE_WIRING } from "./foldbotFlow.ts";
import { normalizedWiringKey, validateGraphReadiness, validateProjectGraphs, type ProjectGraphs } from "./projectGraphs.ts";

/** User intent and chosen source hardware. None of these fields proves physical compatibility. */
export interface GuidedConfig {
  schema_version: 1;
  robot_choice: "undecided" | "foldbot" | "other";
  purpose: string;
  primary_task: "unselected" | "fold-cycle" | "arm-demo" | "chassis-demo" | "custom";
  hardware: {
    controller: "unselected" | "sophicar-s3" | "other";
    fold_driver: "unselected" | "external-step-dir" | "other";
    arm_bus: "unselected" | "buslinker-hx" | "other";
    chassis: "unselected" | "sophicar-m1-m2" | "other";
    notes: string;
  };
  wiring_binding_sha256: string | null;
}

export interface GuidedDraftInput { request: string; guided?: GuidedConfig; graphs?: ProjectGraphs; }
export interface GuidedWiringPreview {
  binding_sha256: string;
  input_key: string;
  source_key: string;
  connections: { id: string; label: string; label_en: string; pins: string; connection: string; connection_en: string }[];
  warnings: string[];
  physical_verified: false;
}
export interface GuidedWiringSource {
  id: string;
  source_provenance: { path: string; sanitized_sha256: string }[];
}

export function defaultGuidedConfig(): GuidedConfig {
  return {
    schema_version: 1, robot_choice: "undecided", purpose: "", primary_task: "unselected",
    hardware: { controller: "unselected", fold_driver: "unselected", arm_bus: "unselected", chassis: "unselected", notes: "" },
    wiring_binding_sha256: null,
  };
}

function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function textField(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max && !value.includes("\0");
}

export function validateGuidedConfig(value: unknown): value is GuidedConfig {
  if (!exactKeys(value, Object.keys(defaultGuidedConfig()))) return false;
  const hardware = value.hardware;
  return value.schema_version === 1 &&
    ["undecided", "foldbot", "other"].includes(value.robot_choice as string) &&
    textField(value.purpose, 2000) &&
    ["unselected", "fold-cycle", "arm-demo", "chassis-demo", "custom"].includes(value.primary_task as string) &&
    (value.wiring_binding_sha256 === null || (typeof value.wiring_binding_sha256 === "string" && value.wiring_binding_sha256.length === 64 && /^[a-f0-9]{64}$/.test(value.wiring_binding_sha256))) &&
    exactKeys(hardware, Object.keys(defaultGuidedConfig().hardware)) &&
    ["unselected", "sophicar-s3", "other"].includes(hardware.controller as string) &&
    ["unselected", "external-step-dir", "other"].includes(hardware.fold_driver as string) &&
    ["unselected", "buslinker-hx", "other"].includes(hardware.arm_bus as string) &&
    ["unselected", "sophicar-m1-m2", "other"].includes(hardware.chassis as string) &&
    textField(hardware.notes, 2000);
}

export function normalizeGuidedConfig(value?: unknown): GuidedConfig {
  if (value === undefined) return defaultGuidedConfig();
  if (!validateGuidedConfig(value)) throw new Error("invalid_guided_config");
  return {
    schema_version: 1, robot_choice: value.robot_choice, purpose: value.purpose,
    primary_task: value.primary_task,
    hardware: {
      controller: value.hardware.controller, fold_driver: value.hardware.fold_driver,
      arm_bus: value.hardware.arm_bus, chassis: value.hardware.chassis, notes: value.hardware.notes,
    },
    wiring_binding_sha256: value.wiring_binding_sha256,
  };
}

export function guidedRequirementsReady(draft: GuidedDraftInput): boolean {
  return textField(draft.request, 12000) && !!draft.request.trim() &&
    (draft.graphs === undefined || validateProjectGraphs(draft.graphs)) &&
    validateGuidedConfig(draft.guided) && draft.guided.robot_choice !== "undecided" &&
    !!draft.guided.purpose.trim() && draft.guided.primary_task !== "unselected";
}

export function guidedHardwareReady(guided?: GuidedConfig): boolean {
  return validateGuidedConfig(guided) && guided.robot_choice === "foldbot" &&
    guided.hardware.controller === "sophicar-s3" &&
    guided.hardware.fold_driver === "external-step-dir" &&
    guided.hardware.arm_bus === "buslinker-hx" &&
    guided.hardware.chassis === "sophicar-m1-m2";
}

/** A stored digest alone is not evidence that the current draft still matches it. */
export function guidedWiringCurrent(draft: GuidedDraftInput, preview?: GuidedWiringPreview | null): boolean {
  return guidedRequirementsReady(draft) && guidedHardwareReady(draft.guided) &&
    !!preview && preview.source_key === "foldbot-existing-firmware-v1" && preview.physical_verified === false &&
    preview.input_key === canonical(wiringInputs(draft)) &&
    typeof preview.binding_sha256 === "string" && preview.binding_sha256.length === 64 && /^[a-f0-9]{64}$/.test(preview.binding_sha256) &&
    draft.guided!.wiring_binding_sha256 === preview.binding_sha256;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function wiringInputs(draft: GuidedDraftInput) {
  const guided = normalizeGuidedConfig(draft.guided);
  return {
    request: draft.request.trim(), robot_choice: guided.robot_choice,
    purpose: guided.purpose.trim(), primary_task: guided.primary_task,
    hardware: { ...guided.hardware, notes: guided.hardware.notes.trim() },
    ...(draft.graphs === undefined ? {} : { wiring_graph: JSON.parse(normalizedWiringKey(draft.graphs.wiring)) }),
  };
}

/** Same deterministic source binding as the local API. Public builds use this as a reference only. */
export async function buildGuidedWiringPreview(draft: GuidedDraftInput, source: GuidedWiringSource): Promise<GuidedWiringPreview> {
  if (!guidedRequirementsReady(draft)) throw new Error("guided_requirements_incomplete");
  if (!guidedHardwareReady(draft.guided)) throw new Error("guided_hardware_not_adapted");
  if (draft.graphs && validateGraphReadiness(draft.graphs).some((issue) => issue.scope === "wiring")) throw new Error("wiring_graph_not_ready");
  if (source.id !== "foldbot-existing-firmware-v1" || !Array.isArray(source.source_provenance) ||
      source.source_provenance.length !== 2 ||
      !["espkuozhanban.ino", "web_ui.h"].every((path) => source.source_provenance.some((item) => item.path === path)) ||
      source.source_provenance.some((item) => typeof item.sanitized_sha256 !== "string" || item.sanitized_sha256.length !== 64 || !/^[a-f0-9]{64}$/.test(item.sanitized_sha256))) {
    throw new Error("guided_source_unavailable");
  }
  const inputs = wiringInputs(draft);
  const binding = {
    schema_version: 1, source_key: source.id, ...inputs,
    source_sha256: source.source_provenance.map(({ path, sanitized_sha256 }) => ({ path, sanitized_sha256 }))
      .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  };
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(binding)));
  return {
    binding_sha256: Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    input_key: canonical(inputs),
    source_key: source.id,
    connections: FOLDBOT_SOURCE_WIRING.map(({ id, label, labelEn, pins, connection, connectionEn }) =>
      ({ id, label, label_en: labelEn, pins, connection, connection_en: connectionEn })),
    warnings: [
      "此接线来自已选硬件的现有源码，是待核对方案，不代表实物已连接或验证。",
      "GPIO35–37 与 ESP32-S3 N16R8 内部存储器的兼容性待确认。",
      "外置驱动型号、电流与电源、舵机波特率及实际行程须现场核对；不推测未知参数。",
    ],
    physical_verified: false,
  };
}
