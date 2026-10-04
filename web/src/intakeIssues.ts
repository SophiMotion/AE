import type { ActionDraft, IntakeIssue, IntakeReadiness } from "./api";

export function usesCompleteAction(
  action: ActionDraft | null | undefined,
): boolean {
  return (
    !!action &&
    (action.scope !== "single_joint" ||
      action.related_joints.length !== 1 ||
      action.stages.length !== 1 ||
      action.stages.some((stage) => (stage.repetitions || 1) > 1))
  );
}

export function reviewIssueGroups(readiness: IntakeReadiness | null) {
  return {
    actionable: readiness ? [...readiness.invalid, ...readiness.missing] : [],
    unsupported: readiness?.unsupported || [],
  };
}

export function issueDestination(issue: IntakeIssue) {
  const action = "prd.intake.action_draft";
  let path = issue.path.replace(/\[(\d+)\]/g, ".$1");
  let step = Math.max(0, Math.min(4, issue.section - 1));
  if (path.startsWith("prd.intake.motion_plan"))
    step = path.endsWith(".reviewed") ? 4 : 2;
  if (path.startsWith(action)) {
    if (/\.(structure_id|model_source_sha256)/.test(path)) {
      step = 1;
      path = "prd.intake.answers.structure_id";
    } else if (/\.reference_joint/.test(path)) {
      step = 1;
      path = "prd.intake.answers.joint_name";
    } else if (/\.related_joints/.test(path)) {
      step = 1;
    } else if (path === action) {
      if (/模型|参考预览关节|相关关节清单|关节不在/.test(issue.message)) {
        step = 1;
        path = `${action}.related_joints`;
      } else {
        step = 2;
        path = /待确认|待核对/.test(issue.message)
          ? `${action}.unresolved`
          : `${action}.stages`;
      }
    } else step = 2;
  }
  return { step, path };
}

/** This only recommends a choice. Existing repetition values never change. */
export function recommendedStageRepetitions(title: string): 1 | 3 {
  if (/准备|预备|抬起|抬臂|放下|放回|复位|收回|回到|结束/.test(title)) return 1;
  return /招手|挥手|往返|摆动/.test(title) ? 3 : 1;
}
