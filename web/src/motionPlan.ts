import type { MotionPlan, MotionRecipe, Structure } from "./api";
import type { Draft } from "./draft";

export function adoptMotionRecipe(
  draft: Draft,
  recipe: MotionRecipe,
  endpoint: string,
): Draft {
  const intake = draft.prd.intake;
  if (!intake || intake.schema_version !== 2 || intake.motion_plan)
    return draft;
  const motion_plan = {
    ...structuredClone(recipe.motion_plan),
    reviewed: false,
  };
  const previous = intake.recommendation_bundle;
  const invocation_id = crypto.randomUUID().replaceAll("-", "");
  const provenance = {
    invocation_id,
    tool: `GET ${endpoint}`,
    model: "确定性参考配方（非 AI）",
    prompt: `GET ${endpoint}`,
    response: JSON.stringify(recipe),
    status: "succeeded",
  };
  const retained =
    previous?.records.filter(
      (record) => record.path !== "prd.intake.motion_plan",
    ) || [];
  const usedCalls = new Set([
    ...retained.map((record) => record.invocation_id),
    invocation_id,
  ]);
  const history = [
    ...(previous?.history || []),
    ...(previous ? [previous.provenance] : []),
    provenance,
  ].filter(
    (row, index, all) =>
      usedCalls.has(row.invocation_id) &&
      all.findIndex((other) => other.invocation_id === row.invocation_id) ===
        index,
  );
  if (history.length > 20 || retained.length >= 50) return draft;
  return {
    ...draft,
    prd: {
      ...draft.prd,
      intake: {
        ...intake,
        motion_plan,
        recommendation_bundle: {
          schema_version: 1,
          provenance,
          history,
          records: [
            ...retained,
            {
              invocation_id,
              path: "prd.intake.motion_plan",
              label: recipe.label,
              value: structuredClone(motion_plan),
              source: "model",
              reason: `${recipe.label}；来源 ${JSON.stringify(recipe.source)}；${recipe.notes.join("；")}`,
              section: 3,
              basis: {
                request_text: draft.request,
                structure_id: recipe.structure_id,
                model_source_sha256: motion_plan.model_source_sha256,
              },
            },
          ],
        },
      },
    },
  };
}

/** Approval is attached to the exact editable draft; even changes outside poses require review. */
export function invalidateMotionReview(previous: Draft, next: Draft): Draft {
  if (!previous.prd.intake?.motion_plan || !next.prd.intake?.motion_plan)
    return next;
  const key = (draft: Draft) => {
    const copy = structuredClone(draft);
    if (copy.prd.intake?.motion_plan)
      copy.prd.intake.motion_plan.reviewed = false;
    return JSON.stringify(copy);
  };
  if (key(previous) === key(next)) return next;
  return {
    ...next,
    prd: {
      ...next.prd,
      intake: {
        ...next.prd.intake!,
        motion_plan: { ...next.prd.intake!.motion_plan!, reviewed: false },
      },
    },
  };
}

export function motionPlanIssues(
  plan: MotionPlan,
  structure: Structure | null,
): string[] {
  const issues: string[] = [];
  if (
    !plan.joint_names.length ||
    new Set(plan.joint_names).size !== plan.joint_names.length
  )
    issues.push("参与关节不能为空或重复。");
  const fingerprint =
    structure?.mapping_source_sha256 || structure?.content_sha256;
  if (!structure || !fingerprint || fingerprint !== plan.model_source_sha256)
    issues.push("姿势程序与当前模型配置不一致，请重新关联并核对。");
  if (plan.waypoints.length < 2)
    issues.push("至少需要起始姿势和一个目标姿势。");
  let last = -1;
  plan.waypoints.forEach((point, index) => {
    if (
      !Number.isFinite(point.time_from_start_s) ||
      point.time_from_start_s < 0 ||
      point.time_from_start_s <= last
    )
      issues.push(`第 ${index + 1} 个姿势的累计时间必须递增。`);
    last = point.time_from_start_s;
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(point.stage_id))
      issues.push(
        `第 ${index + 1} 个姿势的阶段代号需为 1～80 个英文字母、数字、下划线或短横线。`,
      );
    if (!Number.isInteger(point.cycle_index) || point.cycle_index < 0)
      issues.push(`第 ${index + 1} 个姿势的往返编号应为非负整数。`);
    if (point.positions.length !== plan.joint_names.length)
      issues.push(`第 ${index + 1} 个姿势必须包含全部参与关节。`);
    plan.joint_names.forEach((name, jointIndex) => {
      const joint = structure?.joints.find(
        (row) => row.name === name && row.type !== "fixed",
      );
      const value = point.positions[jointIndex];
      const lower = joint?.limits?.lower ?? joint?.lower;
      const upper = joint?.limits?.upper ?? joint?.upper;
      if (!joint) issues.push(`关节 ${name} 不在当前可动关节中。`);
      else if (
        !Number.isFinite(value) ||
        (lower != null && value < lower) ||
        (upper != null && value > upper)
      )
        issues.push(
          `第 ${index + 1} 个姿势的 ${joint.label || name} 超出模型范围或缺少角度。`,
        );
    });
  });
  for (const field of [
    "tolerance_rad",
    "max_velocity_rad_s",
    "max_acceleration_rad_s2",
    "timeout_s",
  ] as const)
    if (!Number.isFinite(plan[field]) || plan[field] <= 0)
      issues.push("误差、速度、加速度和超时必须为正数。");
  if ((plan.waypoints.at(-1)?.time_from_start_s ?? 0) >= plan.timeout_s)
    issues.push("超时应大于完整动作累计时间。");
  return [...new Set(issues)];
}

export const motionCycleCount = (plan: MotionPlan) =>
  new Set(
    plan.waypoints
      .map((point) => point.cycle_index)
      .filter((cycle) => cycle > 0),
  ).size;

/** Repeat a whole closed excursion; retain every surrounding action and renumber all groups. */
export function repeatMotionSegment(
  plan: MotionPlan,
  start: number,
  end: number,
  count: number,
): MotionPlan | null {
  if (
    !Number.isInteger(count) ||
    count < 2 ||
    count > 20 ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end - start < 2 ||
    end >= plan.waypoints.length
  )
    return null;
  const segment = plan.waypoints.slice(start, end + 1);
  // A boundary row is retained before the repeated excursion. Never split an
  // existing numbered group, because its remaining half would no longer close.
  if (
    (segment[0].cycle_index > 0 &&
      segment[0].cycle_index === segment[1].cycle_index) ||
    (segment.at(-1)!.cycle_index > 0 &&
      segment.at(-1)!.cycle_index === plan.waypoints[end + 1]?.cycle_index)
  )
    return null;
  if (
    new Set(
      segment
        .slice(1)
        .map((point) => point.cycle_index)
        .filter((cycle) => cycle > 0),
    ).size > 1
  )
    return null;
  if (
    JSON.stringify(segment[0].positions) !==
    JSON.stringify(segment.at(-1)!.positions)
  )
    return null;
  if (
    !segment
      .slice(1)
      .some((point) =>
        point.positions.some(
          (value, index) =>
            Math.abs(value - segment[0].positions[index]) > 1e-6,
        ),
      )
  )
    return null;
  const span = segment.at(-1)!.time_from_start_s - segment[0].time_from_start_s;
  if (span <= 0) return null;
  const shift = span * (count - 1);
  const existing = (point: MotionPlan["waypoints"][number], offset = 0) => ({
    point: {
      ...structuredClone(point),
      time_from_start_s: point.time_from_start_s + offset,
    },
    group: point.cycle_index > 0 ? `original-${point.cycle_index}` : null,
  });
  const entries = [
    ...plan.waypoints.slice(0, start + 1).map((point) => existing(point)),
    ...Array.from({ length: count }, (_, round) =>
      segment
        .slice(1)
        .map((point) => ({
          point: {
            ...structuredClone(point),
            time_from_start_s: point.time_from_start_s + span * round,
          },
          group: `repeated-${round}`,
        })),
    ).flat(),
    ...plan.waypoints.slice(end + 1).map((point) => existing(point, shift)),
  ];
  if (entries.length > 256) return null;
  let cycle = 0;
  let previousGroup: string | null = null;
  const waypoints = entries.map(({ point, group }) => {
    if (group && group !== previousGroup) cycle++;
    previousGroup = group;
    return { ...point, cycle_index: group ? cycle : 0 };
  });
  return {
    ...plan,
    recipe_id: "custom",
    reviewed: false,
    waypoints,
    timeout_s: plan.timeout_s + shift,
  };
}
