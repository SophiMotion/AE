import type {
  IntakeAnswers,
  PRDIntake,
  HardwareNoteKey,
  IntakeReadiness,
} from "./api";
import type { Draft } from "./draft";
import { emptyDetails } from "./intakeDetails.ts";
import { clearRecommendation } from "./intakeRecommendations.ts";

export const guideSteps = [
  "想做什么",
  "控制哪里",
  "动作细节",
  "硬件与资料",
  "成功标准与核对",
];
export const intentLabels = {
  position: "转到一个位置",
  oscillate: "来回摆动 / 招手",
  threshold: "达到条件后触发",
  other: "其他动作",
};
export const hardwareNoteLabels: Record<HardwareNoteKey, string> = {
  board_model: "实物控制板的完整型号",
  flash_psram: "板载 Flash / PSRAM",
  motor_model: "电机或舵机型号",
  driver_model: "驱动器型号",
  feedback_model: "反馈传感器型号",
  supply: "供电电压和电源",
  wiring: "接线记录",
  docs: "说明书、代码或资料链接",
};
export function emptyIntake(): PRDIntake {
  return {
    schema_version: 2,
    mode: null,
    intent: null,
    answers: {
      structure_id: null,
      joint_name: null,
      board: null,
      target_rad: null,
      tolerance_rad: null,
      max_velocity_rad_s: null,
      duration_s: null,
      threshold: null,
      wave_start_rad: null,
      wave_end_rad: null,
      repetitions: null,
      dwell_s: null,
      end_behavior: null,
      end_position_rad: null,
      other_action: "",
    },
    hardware_notes: Object.fromEntries(
      Object.keys(hardwareNoteLabels).map((key) => [
        key,
        { value: "", source: "", status: "unknown" },
      ]),
    ) as PRDIntake["hardware_notes"],
    accepted_suggestions: [],
    details: emptyDetails(),
  };
}
export function changeIntent(draft: Draft, intent: PRDIntake["intent"]): Draft {
  draft = clearRecommendation(draft, "prd.intake.intent");
  return {
    ...draft,
    prd: {
      ...draft.prd,
      intake: { ...(draft.prd.intake || emptyIntake()), intent },
    },
  };
}
export function changeAnswer<K extends keyof IntakeAnswers>(
  draft: Draft,
  key: K,
  value: IntakeAnswers[K],
): Draft {
  draft = clearRecommendation(draft, `prd.intake.answers.${key}`);
  const intake = draft.prd.intake || emptyIntake();
  return {
    ...draft,
    prd: {
      ...draft.prd,
      intake: {
        ...intake,
        answers: { ...intake.answers, [key]: value },
        accepted_suggestions: intake.accepted_suggestions.filter(
          (path) => path !== `answers.${key}`,
        ),
      },
    },
  };
}
export function acceptSuggestions(
  draft: Draft,
  values: Partial<IntakeAnswers>,
): Draft {
  const intake = draft.prd.intake || emptyIntake();
  return {
    ...draft,
    prd: {
      ...draft.prd,
      intake: {
        ...intake,
        answers: { ...intake.answers, ...values },
        accepted_suggestions: [
          ...new Set([
            ...intake.accepted_suggestions,
            ...Object.keys(values).map((key) => `answers.${key}`),
          ]),
        ],
      },
    },
  };
}
export function migrateLegacyIntake(draft: Draft): Draft {
  if (draft.prd.intake) return draft;
  const intake = emptyIntake();
  intake.mode = "simulation";
  intake.intent =
    draft.task_type === "joint_position" ? "position" : "threshold";
  intake.answers = {
    ...intake.answers,
    structure_id: draft.prd.structure_id,
    joint_name: draft.prd.joint_name,
    board: ["esp32", "esp32s3"].includes(draft.hardware.board || "")
      ? (draft.hardware.board as "esp32" | "esp32s3")
      : null,
    target_rad: draft.parameters.target,
    tolerance_rad: draft.parameters.tolerance,
    max_velocity_rad_s: draft.parameters.max_velocity,
    duration_s: draft.parameters.duration,
    threshold: draft.parameters.threshold,
  };
  return { ...draft, prd: { ...draft.prd, intake } };
}
export function parseDisplayNumber(
  text: string,
  unit: "deg" | "rad" | "number",
): number | null {
  if (!text.trim()) return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  return unit === "deg" ? (value * Math.PI) / 180 : value;
}
export function formatDisplayNumber(
  value: number | null,
  unit: "deg" | "rad" | "number",
): string {
  if (value === null) return "";
  return unit === "deg"
    ? String(Number(((value * 180) / Math.PI).toPrecision(12)))
    : String(value);
}
export function matchingPreview<T>(
  key: string,
  preview: { key: string; data: T } | null,
): T | null {
  return preview?.key === key ? preview.data : null;
}
export function readinessIssues(readiness: IntakeReadiness | null) {
  return readiness
    ? [...readiness.invalid, ...readiness.missing, ...readiness.unsupported]
    : [];
}
