import type {
  ActionDraft,
  AssistConflict,
  AssistProvenance,
  AssistRecord,
  Structure,
} from "./api";
import type { Draft } from "./draft";
import {
  emptyDetails,
  hasDetailExtras,
  type DetailGroupKey,
} from "./intakeDetails.ts";

const answers = new Set([
  "structure_id",
  "joint_name",
  "board",
  "target_rad",
  "tolerance_rad",
  "max_velocity_rad_s",
  "duration_s",
  "threshold",
  "wave_start_rad",
  "wave_end_rad",
  "repetitions",
  "dwell_s",
  "end_behavior",
  "end_position_rad",
  "other_action",
]);
const groups = Object.keys(emptyDetails()) as DetailGroupKey[];
export const assistantPathAllowed = (path: string) =>
  [
    "name",
    "prd.use_case",
    "prd.constraints",
    "prd.acceptance",
    "prd.intake.intent",
    "prd.intake.mode",
    "prd.intake.action_draft",
  ].includes(path) ||
  (path.startsWith("prd.intake.answers.") && answers.has(path.slice(19))) ||
  groups.some((group) => path === `prd.intake.details.${group}`);
export function assistantValue(draft: Draft, path: string): unknown {
  if (path === "prd.intake.motion_plan") return draft.prd.intake?.motion_plan;
  if (!assistantPathAllowed(path)) return undefined;
  if (path === "name") return draft.name;
  if (["prd.use_case", "prd.constraints", "prd.acceptance"].includes(path))
    return draft.prd[path.slice(4) as "use_case"];
  const intake = draft.prd.intake;
  if (!intake) return undefined;
  if (path.startsWith("prd.intake.answers."))
    return intake.answers[path.slice(19) as keyof typeof intake.answers];
  if (path.startsWith("prd.intake.details."))
    return intake.details?.[path.slice(19) as DetailGroupKey];
  return intake[path.slice(11) as "intent"];
}
export function clearAssistRecord(draft: Draft, path: string): Draft {
  const bundle = draft.prd.intake?.recommendation_bundle;
  if (!bundle?.records.some((row) => row.path === path)) return draft;
  return {
    ...draft,
    prd: {
      ...draft.prd,
      intake: {
        ...draft.prd.intake!,
        recommendation_bundle: {
          ...bundle,
          records: bundle.records.filter((row) => row.path !== path),
        },
      },
    },
  };
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const blank = (value: unknown) =>
  value == null || (typeof value === "string" && !value.trim());
function eligible(draft: Draft, path: string): boolean {
  const value = assistantValue(draft, path);
  if (!path.startsWith("prd.intake.details.")) return blank(value);
  const group = path.slice(19) as DetailGroupKey;
  return !value || same(value, emptyDetails()[group]);
}
function validValue(path: string, value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "number") return Number.isFinite(value);
  if (path === "prd.intake.action_draft") {
    const action = value as ActionDraft;
    return (
      typeof action === "object" &&
      action.schema_version === 1 &&
      Array.isArray(action.stages) &&
      Array.isArray(action.related_joints) &&
      Array.isArray(action.unresolved) &&
      action.requires_review === true
    );
  }
  if (path.startsWith("prd.intake.details."))
    return typeof value === "object" && !Array.isArray(value);
  return typeof value === "string";
}
export function applyAssistant(
  draft: Draft,
  records: AssistRecord[],
  provenance: AssistProvenance,
  conflict?: AssistConflict,
) {
  if (draft.prd.intake?.schema_version !== 2)
    return { draft, applied: [] as AssistRecord[] };
  let next = structuredClone(draft);
  const applied: AssistRecord[] = [];
  for (const record of records) {
    if (
      !assistantPathAllowed(record.path) ||
      !validValue(record.path, record.value)
    )
      continue;
    const isConflict =
      conflict === record &&
      same(assistantValue(next, record.path), conflict.current_value);
    if (conflict && !isConflict) continue;
    if (!isConflict && !eligible(next, record.path)) continue;
    // A whole details group with user supplements must never be replaced.
    if (record.path.startsWith("prd.intake.details.") && isConflict) {
      const group = record.path.slice(19) as DetailGroupKey;
      const existing = next.prd.intake!.details?.[group];
      if (existing && hasDetailExtras(group, existing)) continue;
    }
    if (record.path === "name") next.name = record.value as string;
    else if (
      ["prd.use_case", "prd.constraints", "prd.acceptance"].includes(
        record.path,
      )
    )
      Object.assign(next.prd, {
        [record.path.slice(4)]: structuredClone(record.value),
      });
    else if (record.path.startsWith("prd.intake.answers.")) {
      Object.assign(next.prd.intake!.answers, {
        [record.path.slice(19)]: structuredClone(record.value),
      });
      next.prd.intake!.accepted_suggestions =
        next.prd.intake!.accepted_suggestions.filter(
          (path) => path !== `answers.${record.path.slice(19)}`,
        );
    } else if (record.path.startsWith("prd.intake.details.")) {
      next.prd.intake!.details ??= emptyDetails();
      Object.assign(next.prd.intake!.details, {
        [record.path.slice(19)]: structuredClone(record.value),
      });
    } else
      Object.assign(next.prd.intake!, {
        [record.path.slice(11)]: structuredClone(record.value),
      });
    next.prd.intake!.recommendation_records =
      next.prd.intake!.recommendation_records?.filter(
        (row) => row.path !== record.path,
      );
    applied.push(structuredClone(record));
  }
  if (applied.length) {
    const previous = next.prd.intake!.recommendation_bundle;
    const records = [
      ...(previous?.records || []).filter(
        (old) => !applied.some((row) => row.path === old.path),
      ),
      ...applied,
    ];
    const usedCalls = new Set(
      records.map((record) => record.invocation_id).filter(Boolean),
    );
    if (provenance.invocation_id) usedCalls.add(provenance.invocation_id);
    const history = [
      ...(previous?.history || []),
      ...(previous ? [previous.provenance] : []),
      provenance,
    ].filter(
      (entry, index, all) =>
        entry.invocation_id &&
        usedCalls.has(entry.invocation_id) &&
        !all
          .slice(index + 1)
          .some((item) => item.invocation_id === entry.invocation_id),
    );
    if (history.length > 20)
      return {
        draft,
        applied: [] as AssistRecord[],
        error:
          "本草稿已保留 20 次不同建议的来源。为避免丢失来源，本次未填入；可直接手动编辑。",
      };
    next.prd.intake!.recommendation_bundle = {
      schema_version: 1,
      provenance,
      records,
      history,
    };
  }
  return { draft: applied.length ? next : draft, applied };
}
export const assistSourceLabels = {
  request: "从原话提取",
  model: "来自参考模型",
  platform: "平台开发设置",
  example: "可修改的示例",
  ai: "AI 整理建议",
};
export function formatAssistValue(
  path: string,
  value: unknown,
  angleUnit: "deg" | "rad" = "deg",
): string {
  if (typeof value === "object")
    return value === null ? "空白" : "完整内容（展开查看）";
  if (typeof value !== "number") return String(value ?? "空白");
  if (!Number.isFinite(value)) return "无效数值";
  const field = path.split(".").pop();
  const angle = [
    "target_rad",
    "tolerance_rad",
    "wave_start_rad",
    "wave_end_rad",
    "end_position_rad",
  ].includes(field || "");
  const speed = field === "max_velocity_rad_s";
  const displayed =
    (angle || speed) && angleUnit === "deg" ? (value * 180) / Math.PI : value;
  const number = new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: 3,
    useGrouping: false,
  }).format(displayed);
  const unit = angle
    ? angleUnit === "deg"
      ? "°"
      : " rad"
    : speed
      ? angleUnit === "deg"
        ? "°/秒"
        : " rad/秒"
      : ["duration_s", "dwell_s"].includes(field || "")
        ? " 秒"
        : field === "repetitions"
          ? " 次"
          : "";
  return `${number}${unit}`;
}
export function assistSource(
  draft: Draft,
  path: string,
  structure?: Structure | null,
) {
  const record = draft.prd.intake?.recommendation_bundle?.records.find(
    (row) =>
      row.path === path &&
      (path === "prd.intake.motion_plan"
        ? same(
            { ...(row.value as object), reviewed: false },
            { ...(assistantValue(draft, path) as object), reviewed: false },
          )
        : same(row.value, assistantValue(draft, path))),
  );
  if (!record) return null;
  const hash =
    structure?.id === draft.prd.intake?.answers.structure_id
      ? structure?.mapping_source_sha256 || structure?.content_sha256
      : null;
  const stale =
    record.basis.request_text !== draft.request ||
    (record.basis.model_source_sha256
      ? hash !== record.basis.model_source_sha256
      : record.basis.structure_id !== draft.prd.intake?.answers.structure_id);
  return {
    record,
    stale,
    provenance: record.invocation_id
      ? [
          ...(draft.prd.intake!.recommendation_bundle!.history || []),
          draft.prd.intake!.recommendation_bundle!.provenance,
        ].find((entry) => entry.invocation_id === record.invocation_id) || null
      : null,
    label: `${stale ? "先前建议，需重新核对 · " : ""}${assistSourceLabels[record.source]}`,
  };
}
