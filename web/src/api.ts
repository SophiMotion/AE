import type { IntakeDetails, DetailGroupKey } from "./intakeDetails";
export type TaskType = "joint_position" | "sensor_threshold" | "joint_sequence";
export type Status =
  | "draft"
  | "planning"
  | "awaiting_approval"
  | "approved"
  | "queued"
  | "generating"
  | "building"
  | "testing"
  | "repairing"
  | "passed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "deploying"
  | "deployed";
export interface Parameters {
  target: number;
  threshold: number;
  tolerance: number;
  duration: number;
  max_velocity: number;
}
export interface Provenance {
  tool?: string;
  model?: string;
  prompt?: string;
  response?: unknown;
  started_at?: string;
  finished_at?: string;
  sources?: string[];
  [key: string]: unknown;
}
export interface Plan {
  plan_id?: string;
  summary: string;
  ros_tasks: string[];
  esp32_tasks: string[];
  communication: string[];
  checks: string[];
  missing_information: string[];
  blocking_issues?: string[];
  citations: string[];
  provenance: Provenance;
  requirement_coverage?: RequirementCoverage;
}
export interface RequirementCoverage {
  schema_version: number;
  scope: string;
  checks: { id: string; label: string; expected: unknown }[];
  items: {
    id: string;
    source_field: string;
    text: string;
    status: "covered" | "manual_review" | "unsupported" | "conflict";
    check_ids: string[];
    reason: string;
  }[];
  blocking_issues: string[];
  review_note: string;
}
export interface PRD {
  use_case: string;
  environment: "desktop_simulation";
  constraints: string;
  acceptance: string;
  structure_id: string | null;
  joint_name: string | null;
  intake?: PRDIntake | null;
}
export interface IntakeAnswers {
  structure_id: string | null;
  joint_name: string | null;
  board: "esp32" | "esp32s3" | null;
  target_rad: number | null;
  tolerance_rad: number | null;
  max_velocity_rad_s: number | null;
  duration_s: number | null;
  threshold: number | null;
  wave_start_rad: number | null;
  wave_end_rad: number | null;
  repetitions: number | null;
  dwell_s: number | null;
  end_behavior: "return_start" | "hold_end" | "custom" | null;
  end_position_rad: number | null;
  other_action: string;
}
export type HardwareNoteKey =
  | "board_model"
  | "flash_psram"
  | "motor_model"
  | "driver_model"
  | "feedback_model"
  | "supply"
  | "wiring"
  | "docs";
export interface HardwareNote {
  value: string;
  source: string;
  status: "unknown" | "provided" | "documented";
}
export interface PRDIntake {
  schema_version: 1 | 2;
  mode: "simulation" | "hardware_notes" | null;
  intent: "position" | "oscillate" | "threshold" | "other" | null;
  answers: IntakeAnswers;
  hardware_notes: Record<HardwareNoteKey, HardwareNote>;
  accepted_suggestions: string[];
  details?: IntakeDetails;
  recommendation_records?: RecommendationRecord[] | null;
  action_draft?: ActionDraft | null;
  motion_plan?: MotionPlan | null;
  recommendation_bundle?: {
    schema_version: 1;
    records: AssistRecord[];
    provenance: AssistProvenance;
    history?: AssistProvenance[];
  } | null;
}
export interface MotionPlan {
  schema_version: 1;
  recipe_id: "sophicore-right-wave-v1" | "sophicore-left-wave-v1" | "custom";
  model_source_sha256: string;
  reviewed: boolean;
  joint_names: string[];
  waypoints: {
    positions: number[];
    time_from_start_s: number;
    stage_id: string;
    cycle_index: number;
  }[];
  tolerance_rad: number;
  max_velocity_rad_s: number;
  max_acceleration_rad_s2: number;
  timeout_s: number;
}
export interface MotionRecipe {
  motion_plan: MotionPlan;
  label: string;
  notes: string[];
  source: unknown;
  structure_id: string;
}
export interface ActionDraft {
  schema_version: 1;
  structure_id: string | null;
  model_source_sha256: string | null;
  summary: string;
  scope: "single_joint" | "multi_joint" | "other" | "uncertain";
  reference_joint: string | null;
  related_joints: {
    name: string;
    label: string;
    role: string;
    reason: string;
  }[];
  stages: {
    id: string;
    title: string;
    description: string;
    joint_names: string[];
    repetitions: number | null;
    target_rad: number | null;
    confirmation_needed: boolean;
  }[];
  end_pose_text: string;
  unresolved: string[];
  requires_review: true;
}
export interface AssistProvenance {
  invocation_id?: string | null;
  tool: string;
  model: string;
  prompt: string;
  response: string;
  status: string;
}
export interface AssistRecord {
  invocation_id?: string | null;
  path: string;
  label: string;
  value: unknown;
  source: "request" | "model" | "platform" | "example" | "ai";
  reason: string;
  section: number;
  basis: {
    request_text: string;
    structure_id: string | null;
    model_source_sha256: string | null;
  };
}
export interface AssistConflict extends AssistRecord {
  current_value: unknown;
}
export interface PRDAssistance {
  schema_version: 2;
  base_draft_hash: string;
  suggestions: AssistRecord[];
  conflicts: AssistConflict[];
  not_filled: {
    path: string;
    label: string;
    reason: string;
    section: number;
  }[];
  warnings: string[];
  notice: string;
  provenance: AssistProvenance;
}
export interface RecommendationRecord {
  path: string;
  label: string;
  value: string | number;
  source: "request" | "example";
  reason: string;
  section: number;
  unit: string | null;
  rule_version: "prd-fill-v1";
  tool: "平台规则推荐（非 AI）";
  basis: {
    request_text: string;
    intent: PRDIntake["intent"];
    structure_id: string | null;
    joint_name: string | null;
    model_source_sha256: string | null;
  };
}
export interface PRDRecommendations {
  schema_version: 1;
  base_draft_hash: string;
  suggestions: RecommendationRecord[];
  not_filled: {
    path: string;
    label: string;
    reason: string;
    section: number;
  }[];
  warnings: string[];
  notice: string;
}
export interface IntakeIssue {
  path: string;
  label: string;
  message: string;
  section: number;
}
export interface IntakeReadiness {
  schema_version: 1 | 2;
  status: "incomplete" | "unsupported" | "ready_for_plan";
  can_save: boolean;
  can_plan: boolean;
  execution_task: TaskType | null;
  missing: IntakeIssue[];
  invalid: IntakeIssue[];
  unsupported: IntakeIssue[];
  resolved: {
    path: string;
    label: string;
    value: unknown;
    unit?: string;
    origin: "user" | "model" | "platform" | "suggested";
    source_ref?: string;
  }[];
  summary: {
    action: string;
    device: string;
    model: string;
    criteria: string;
    scope: string;
    details?: unknown[];
  };
  detail_coverage?: {
    group: DetailGroupKey;
    label: string;
    section: number;
    status: "confirmed" | "reference_only" | "missing" | "unsupported";
    summary: string;
  }[];
  notice: string;
}
export interface Hardware {
  board: string | null;
  transport: string;
  ros_distro: string;
  actuator?: string | null;
  sensor?: string | null;
  baudrate?: number;
  physical_io?: boolean;
}
export interface Structure {
  id: string;
  content_sha256?: string;
  mapping_source_sha256?: string;
  name: string;
  format: string;
  links: {
    name: string;
    mesh_ids?: number[];
    mesh_origin_m?: number[];
    visuals: {
      type: "box" | "cylinder" | "sphere";
      size?: number[];
      radius?: number;
      length?: number;
      xyz: number[];
      rpy: number[];
      color: number[];
    }[];
  }[];
  joints: {
    name: string;
    label?: string;
    initial_position?: number;
    source_parameter?: string;
    source?: Record<string, unknown>;
    type: string;
    parent: string;
    child: string;
    xyz: number[];
    rpy: number[];
    origin?: { xyz: number[]; rpy: number[] };
    limits?: { lower?: number; upper?: number };
    axis: number[];
    lower?: number;
    upper?: number;
  }[];
  warnings: string[];
  source_url?: string;
  mesh_url?: string;
  assumptions?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
  source_sha256?: string;
  model_sha256?: string;
  simulation_binding?: string;
}
export type WorkflowStep =
  | "requirements"
  | "rag"
  | "plan"
  | "review"
  | "generate"
  | "ros_build"
  | "esp_build"
  | "communication"
  | "simulation"
  | "report";
export interface EngineeringWorkflow {
  schema_version: 1;
  nodes: {
    id: WorkflowStep;
    type: WorkflowStep;
    position: { x: number; y: number };
  }[];
  edges: { id?: string; source: string; target: string }[];
  execution_order?: string[];
  hash?: string;
}
export interface ExecutionModel {
  schema_version: number;
  model_id: string;
  model_sha256: string;
  selected_joint: string;
  links: Structure["links"];
  joints: Structure["joints"];
  held_positions?: Record<string, number>;
  assumptions?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
  hardware_verified?: boolean;
  [key: string]: unknown;
}
export interface FirmwareEvidence {
  passed: boolean;
  compiled?: boolean;
  flashed?: boolean;
  board?: string;
  fqbn?: string;
  core_version?: string;
  artifacts?: unknown;
  [key: string]: unknown;
}
export interface CommunicationEvidence {
  passed: boolean;
  checks?: Check[];
  scope?: string;
  [key: string]: unknown;
}
export interface Project {
  id: string;
  name: string;
  request: string;
  task_type: TaskType | null;
  parameters: { [K in keyof Parameters]: number | null };
  hardware: Hardware;
  prd?: PRD;
  pipeline_version?: number;
  workflow?: EngineeringWorkflow;
  structure?: Structure | null;
  execution_model?: ExecutionModel | null;
  contract?: Record<string, unknown>;
  communication?: Record<string, unknown>;
  simulation?: Record<string, unknown>;
  manifest?: EngineeringManifest | null;
  spec_revision: number;
  status: Status;
  plan: Plan | null;
  approval: object | null;
  latest_run_id: string | null;
  created_at: string;
  updated_at: string;
  error?: string | null;
  plan_failure_provenance?: Provenance | null;
  intake_readiness?: IntakeReadiness | null;
}
export interface EngineeringManifest {
  schema_version: number;
  modules: {
    id: string;
    label: string;
    role?: string;
    runtime?: string;
    fqbn?: string;
    ai_file?: string;
    identity?: Record<string, string>;
    physical_io?: boolean;
    pins?: unknown;
  }[];
  dependencies: Record<string, string>;
  selected_joint?: Structure["joints"][number] | null;
  model_sha256: string;
  protocol_sha256: string;
  execution_order?: string[];
  preflight: {
    passed: boolean;
    scope: string;
    checks: { id: string; label: string; detail: string; passed: boolean }[];
  };
  missing_for_hardware: string[];
  hash: string;
}
export interface Check {
  name: string;
  passed: boolean;
  detail: unknown;
}
export interface Run {
  id: string;
  project_id: string;
  status: Status;
  attempt: number;
  created_at: string;
  updated_at: string;
  spec_snapshot: Project;
  plan_snapshot?: Plan | null;
  approval?: {
    spec_hash?: string;
    plan_id?: string;
    spec_revision?: number;
    approved_at?: string;
  } | null;
  previous_run_id?: string | null;
  previous_code_snapshot?: Record<string, unknown> | null;
  integrity?: { fingerprint: string; [key: string]: unknown } | null;
  events: { time: string; stage: string; message: string; level: string }[];
  result: null | {
    passed: boolean;
    engine: string;
    checks: Check[];
    metrics: Record<string, unknown>;
    series: {
      time: number;
      t?: number;
      value: number;
      target: number;
      command: number;
      positions?: Record<string, number>;
      targets?: Record<string, number>;
      velocities?: Record<string, number>;
      stage_id?: string;
      cycle_index?: number;
    }[];
    motion_program?: {
      program_sha256: string;
      joint_names: string[];
      waypoints: MotionPlan["waypoints"];
      [key: string]: unknown;
    };
    ros_verified: boolean;
    esp32_status: string;
    physical_verified: boolean;
    firmware?: FirmwareEvidence;
    communication_test?: CommunicationEvidence;
    execution_order?: string[];
    model_sha256?: string;
    joint_name?: string;
  };
  artifacts: { path: string; size: number }[];
  error: string | null;
  code_versions: Record<string, unknown>[];
  provenance: Provenance[];
  deployment: Record<string, unknown> | null;
}
export interface Task {
  id: TaskType;
  label: string;
  description: string;
  default_request: string;
  parameters: Parameters;
}
export interface Catalog {
  tasks: Task[];
  hardware_options: unknown[];
  environment: Record<string, unknown>;
  communication?: Record<string, unknown>;
  simulation?: Record<string, unknown>;
  boards?: { id: string; label: string; fqbn?: string }[];
  actuators?: { id: string; label: string }[];
  sensors?: { id: string; label: string }[];
  transports?: { id: string; label: string }[];
  default_workflow?: EngineeringWorkflow;
}
export interface Settings {
  provider: "codex" | "openai";
  model: string;
  base_url: string;
  key_configured: boolean;
  codex_available: boolean;
  key_storage?: string;
}
export interface Source {
  id: string;
  title: string;
  url: string;
  version: string;
  content: string;
  tags: string[];
  license: string;
  checked_at: string;
  document_id?: string;
  board?: string;
  ros_distro?: string;
  score?: number;
  chunk_index?: number;
  uploaded?: boolean;
  origin?: "builtin" | "upload" | "experience";
  experience_kind?: "success" | "failure" | "repair";
  retrieval_use?: "validated_example" | "diagnostic_only";
  content_kind?: "summary" | "original" | "experience";
  verification_status?: string;
  warnings?: string[];
  retrieval_mode?: string;
  source_hash?: string;
  page_start?: number;
  page_end?: number;
  line_start?: number;
  line_end?: number;
}
export const busyStatuses: Status[] = [
  "planning",
  "queued",
  "generating",
  "building",
  "testing",
  "repairing",
  "deploying",
];
export const statusLabels: Record<Status, string> = {
  draft: "尚未拆分",
  planning: "正在拆分需求",
  awaiting_approval: "等待人工核对",
  approved: "已核对，待生成",
  queued: "等待执行",
  generating: "正在生成程序",
  building: "正在编译",
  testing: "正在运行检查",
  repairing: "正在修改程序",
  passed: "检查通过",
  failed: "检查失败",
  cancelled: "已取消",
  interrupted: "执行中断",
  deploying: "正在部署复测",
  deployed: "本地部署已复测",
};
export async function api<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ detail: `服务返回 ${response.status}` }));
    throw new Error(
      typeof error.detail === "string"
        ? error.detail
        : JSON.stringify(error.detail),
    );
  }
  return response.json() as Promise<T>;
}
export const printable = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);
export const localTime = (value?: string) =>
  value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
