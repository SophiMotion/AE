import type { Draft } from "./draft";
import type { RecommendationRecord, Structure } from "./api";
import { clearAssistRecord } from "./intakeAssistant.ts";

const answerKeys = new Set([
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
]);
export const recommendationPathAllowed = (path: string) =>
  ["name", "prd.use_case", "prd.intake.intent"].includes(path) ||
  (path.startsWith("prd.intake.answers.") && answerKeys.has(path.slice(19)));
export const isBlank = (value: unknown) =>
  value == null || (typeof value === "string" && !value.trim());
export function recommendationValue(draft: Draft, path: string): unknown {
  if (path === "name") return draft.name;
  if (path === "prd.use_case") return draft.prd.use_case;
  if (path === "prd.intake.intent") return draft.prd.intake?.intent;
  if (path.startsWith("prd.intake.answers."))
    return draft.prd.intake?.answers[
      path.slice(19) as keyof NonNullable<Draft["prd"]["intake"]>["answers"]
    ];
  return undefined;
}
export function clearRecommendation(draft: Draft, path: string): Draft {
  draft = clearAssistRecord(draft, path);
  const intake = draft.prd.intake;
  if (!intake?.recommendation_records?.some((row) => row.path === path))
    return draft;
  return {
    ...draft,
    prd: {
      ...draft.prd,
      intake: {
        ...intake,
        recommendation_records: intake.recommendation_records.filter(
          (row) => row.path !== path,
        ),
      },
    },
  };
}
export function applyRecommendations(
  draft: Draft,
  suggestions: RecommendationRecord[],
) {
  if (draft.prd.intake?.schema_version !== 2)
    return { draft, applied: [] as RecommendationRecord[] };
  const next = structuredClone(draft);
  const intake = next.prd.intake!;
  const applied: RecommendationRecord[] = [];
  for (const record of suggestions) {
    if (
      !recommendationPathAllowed(record.path) ||
      !isBlank(recommendationValue(next, record.path))
    )
      continue;
    if (
      typeof record.value !== "string" &&
      (typeof record.value !== "number" || !Number.isFinite(record.value))
    )
      continue;
    if (record.path === "name") next.name = String(record.value);
    else if (record.path === "prd.use_case")
      next.prd.use_case = String(record.value);
    else if (record.path === "prd.intake.intent") {
      if (
        !["position", "oscillate", "threshold", "other"].includes(
          String(record.value),
        )
      )
        continue;
      intake.intent = record.value as NonNullable<typeof intake.intent>;
    } else {
      const field = record.path.slice(19) as keyof typeof intake.answers;
      if (field === "end_behavior") {
        if (
          !["return_start", "hold_end", "custom"].includes(String(record.value))
        )
          continue;
      } else if (typeof record.value !== "number") continue;
      Object.assign(intake.answers, { [field]: record.value });
      intake.accepted_suggestions = intake.accepted_suggestions.filter(
        (path) => path !== `answers.${field}`,
      );
    }
    applied.push(structuredClone(record));
  }
  if (applied.length)
    intake.recommendation_records = [
      ...(intake.recommendation_records || []).filter(
        (old) => !applied.some((row) => row.path === old.path),
      ),
      ...applied,
    ];
  return { draft: applied.length ? next : draft, applied };
}
export function recommendationSource(
  draft: Draft,
  path: string,
  structure?: Structure | null,
) {
  const record = draft.prd.intake?.recommendation_records?.find(
    (row) =>
      row.path === path &&
      Object.is(row.value, recommendationValue(draft, path)),
  );
  if (!record) return null;
  const intake = draft.prd.intake!;
  const currentHash =
    structure?.id === intake.answers.structure_id
      ? structure.mapping_source_sha256 || structure.content_sha256 || null
      : null;
  const sameModel = record.basis.model_source_sha256
    ? record.basis.model_source_sha256 === currentHash
    : record.basis.structure_id === intake.answers.structure_id;
  const stale =
    record.basis.request_text !== draft.request ||
    record.basis.intent !== intake.intent ||
    record.basis.joint_name !== intake.answers.joint_name ||
    !sameModel;
  const label = record.source === "request" ? "从需求提取" : "示例建议";
  return {
    record,
    stale,
    label: stale ? `先前建议，需重新核对 · ${label}` : label,
  };
}
// Each mounted form owns a gate. Invalidate on unmount or replacement request.
export function createRecommendationGate() {
  let sequence = 0;
  return {
    begin: (key: string) => ({ sequence: ++sequence, key }),
    accepts: (ticket: { sequence: number; key: string }, currentKey: string) =>
      ticket.sequence === sequence && ticket.key === currentKey,
    active: (ticket: { sequence: number }) => ticket.sequence === sequence,
    cancel: () => {
      sequence++;
    },
  };
}
