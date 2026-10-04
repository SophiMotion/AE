import type {
  ActionDraft,
  AssistRecord,
  Catalog,
  EngineeringWorkflow,
  IntakeIssue,
  IntakeReadiness,
  MotionRecipe,
  PRDAssistance,
  Project,
  Run,
  Settings,
  Source,
  Structure,
} from "./api";
import { fromProject, type Draft } from "./draft.ts";
import { assistantValue } from "./intakeAssistant.ts";
import {
  adoptPlatformDetails,
  detailLabels,
  detailSections,
  emptyDetails,
  type DetailGroupKey,
} from "./intakeDetails.ts";
import { numberChoices } from "./intakeChoices.ts";
import { motionPlanIssues } from "./motionPlan.ts";
import { validateWorkflow } from "./workflowModel.ts";

const env = (
  import.meta as ImportMeta & {
    env?: { VITE_PUBLIC_DEMO?: string; BASE_URL?: string };
  }
).env;
export const isPublicDemo = env?.VITE_PUBLIC_DEMO === "true";
export const publicDemoNotice =
  "这是完整界面分享版。需求和流程草稿只保存在当前浏览器；验收结果属于原始示例，不会在线调用 AI、编译或运行 ROS。";
export interface PublicDemoBundle {
  schema_version: 1;
  catalog: Catalog;
  settings: Settings;
  environment?: Record<string, unknown>;
  structures: Structure[];
  projects: Project[];
  runs: Run[];
  sources: Source[];
  recipes: Record<string, MotionRecipe>;
  files?: Record<string, Record<string, string>>;
  knowledge_stats?: Record<string, unknown>;
  knowledge_evaluation?: Record<string, unknown>;
  experiences?: Record<string, unknown>;
}
const storageKey = "ae-public-demo-drafts-v1";
const draftPrefix = "browser-draft-";
type BrowserStore = {
  schema_version: 1;
  projects: Project[];
  history: Record<string, unknown[]>;
};
let bundlePromise: Promise<PublicDemoBundle> | undefined;
const copy = <T>(value: T): T => structuredClone(value);
const blank = (value: unknown) =>
  value == null || (typeof value === "string" && !value.trim());
const fail = (
  message = "此操作需要完整本机平台。分享版不会调用 AI、编译、运行 ROS、烧录或修改服务设置。",
) => {
  throw new Error(message);
};
const checkAbort = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new DOMException("操作已取消", "AbortError");
};
async function bundle(signal?: AbortSignal): Promise<PublicDemoBundle> {
  checkAbort(signal);
  // One immutable public download. Cancelling one view must not poison other views.
  bundlePromise ??= fetch(`${env?.BASE_URL || "./"}public-demo.json`)
    .then(async (response) => {
      if (!response.ok)
        throw new Error(`演示资料读取失败（${response.status}）`);
      const data = (await response.json()) as PublicDemoBundle;
      if (
        data.schema_version !== 1 ||
        !Array.isArray(data.projects) ||
        !Array.isArray(data.runs) ||
        !Array.isArray(data.structures) ||
        !Array.isArray(data.sources)
      )
        throw new Error("演示资料格式不正确，请刷新或联系发布者。");
      return data;
    })
    .catch((error) => {
      bundlePromise = undefined;
      throw error;
    });
  if (!signal) return bundlePromise;
  return new Promise((resolve, reject) => {
    const cancel = () => {
      cleanup();
      reject(new DOMException("操作已取消", "AbortError"));
    };
    const cleanup = () => signal.removeEventListener("abort", cancel);
    signal.addEventListener("abort", cancel, { once: true });
    bundlePromise!.then(
      (data) => {
        cleanup();
        if (!signal.aborted) resolve(data);
        else cancel();
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}
function store(): BrowserStore {
  try {
    const saved = JSON.parse(
      localStorage.getItem(storageKey) || "null",
    ) as BrowserStore | null;
    if (
      saved?.schema_version === 1 &&
      Array.isArray(saved.projects) &&
      saved.history &&
      typeof saved.history === "object"
    )
      return {
        ...saved,
        projects: saved.projects
          .filter(
            (p) => typeof p.id === "string" && p.id.startsWith(draftPrefix),
          )
          .map((p) => ({
            ...p,
            latest_run_id: null,
            approval: null,
            status: p.plan ? "awaiting_approval" : "draft",
          })),
      };
  } catch {
    /* Invalid/old local drafts do not hide the immutable published sample. */
  }
  return { schema_version: 1, projects: [], history: {} };
}
function writeStore(value: BrowserStore) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    fail(
      "浏览器无法保存草稿，可能是存储空间不足或隐私设置限制。请导出需求，或允许此网站使用本地存储后重试。",
    );
  }
}
function getProject(data: PublicDemoBundle, id: string): Project {
  const item =
    store().projects.find((p) => p.id === id) ||
    data.projects.find((p) => p.id === id);
  if (!item)
    return fail("找不到这个工程。浏览器草稿只在创建它的浏览器中保存。");
  return copy(item);
}
function getRun(data: PublicDemoBundle, id: string): Run {
  const item = data.runs.find((r) => r.id === id);
  if (!item)
    return fail("找不到公开的原始验收记录。修改后的需求没有新的运行结果。");
  return copy(item);
}
function remember(project: Project, event: string) {
  const saved = store();
  saved.projects = [
    project,
    ...saved.projects.filter((p) => p.id !== project.id),
  ].slice(0, 30);
  saved.history[project.id] = [
    {
      id: crypto.randomUUID(),
      project_id: project.id,
      revision: project.spec_revision,
      event,
      created_at: project.updated_at,
      snapshot: copy(project),
    },
    ...(saved.history[project.id] || []),
  ].slice(0, 30);
  writeStore(saved);
}
function sanitizedDraft(raw: unknown): Draft {
  if (!raw || typeof raw !== "object") return fail("请先填写需求。");
  const draft = raw as Draft;
  if (
    !draft.prd ||
    !draft.parameters ||
    !draft.hardware ||
    !draft.workflow ||
    typeof draft.request !== "string" ||
    typeof draft.name !== "string"
  )
    return fail("需求格式不完整，请使用表单填写。");
  if (JSON.stringify(raw).length > 500_000)
    return fail("草稿内容过大，请减少补充内容。");
  // Never let caller-provided status/result/latest_run_id become acceptance evidence.
  return copy({
    name: draft.name,
    request: draft.request,
    task_type: draft.task_type,
    parameters: draft.parameters,
    hardware: draft.hardware,
    prd: draft.prd,
    workflow: draft.workflow,
  });
}
function saveDraft(data: PublicDemoBundle, raw: unknown, id?: string): Project {
  const draft = sanitizedDraft(raw);
  const previous = id ? getProject(data, id) : null;
  const now = new Date().toISOString();
  const next: Project = {
    ...draft,
    id: previous?.id.startsWith(draftPrefix)
      ? previous.id
      : `${draftPrefix}${crypto.randomUUID()}`,
    name: draft.name.trim() || "我的需求草稿",
    spec_revision: (previous?.spec_revision || 0) + 1,
    status: "draft",
    plan: null,
    approval: null,
    latest_run_id: null,
    created_at: previous?.id.startsWith(draftPrefix)
      ? previous.created_at
      : now,
    updated_at: now,
    structure:
      data.structures.find(
        (s) =>
          s.id === draft.prd.intake?.answers.structure_id ||
          s.id === draft.prd.structure_id,
      ) || null,
    intake_readiness: previewDraft(data, draft),
    error: null,
  };
  remember(next, previous ? "updated" : "created");
  return next;
}
export function previewDraft(
  data: PublicDemoBundle,
  draft: Draft,
): IntakeReadiness {
  const missing: IntakeIssue[] = [],
    invalid: IntakeIssue[] = [];
  const issue = (
    path: string,
    label: string,
    section: number,
    message = `请填写或明确选择${label}。`,
  ) => missing.push({ path, label, section, message });
  if (!draft.request.trim()) issue("request", "机器人要做什么", 1);
  const intake = draft.prd.intake,
    answers = intake?.answers;
  const structure = data.structures.find(
    (s) => s.id === (answers?.structure_id || draft.prd.structure_id),
  );
  if (intake) {
    if (!intake.intent) issue("prd.intake.intent", "动作类型", 1);
    if (!intake.mode) issue("prd.intake.mode", "本轮用途", 1);
    if (!structure) issue("prd.intake.answers.structure_id", "机器人结构", 2);
    const num = (
      key: keyof NonNullable<typeof answers>,
      label: string,
      section: number,
      minimum: number,
      integer = false,
    ) => {
      const value = answers?.[key];
      const path = `prd.intake.answers.${key}`;
      if (value == null) issue(path, label, section);
      else if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < minimum ||
        (integer && !Number.isInteger(value))
      )
        invalid.push({
          path,
          label,
          section,
          message: `${label}必须是${integer ? "整数" : "有效数值"}，且不能小于 ${minimum}。`,
        });
    };
    const motion = intake.motion_plan;
    if (motion) {
      for (const message of motionPlanIssues(motion, structure || null))
        invalid.push({
          path: "prd.intake.motion_plan",
          label: "逐关节姿势程序",
          section: 3,
          message,
        });
      if (!motion.reviewed)
        issue("prd.intake.motion_plan.reviewed", "姿势程序人工核对", 5);
    } else {
      const action = intake.action_draft;
      if (action) {
        if (!action.related_joints.length)
          issue("prd.intake.action_draft.related_joints", "相关关节", 2);
        action.related_joints.forEach((row, index) => {
          if (
            !structure?.joints.some(
              (j) => j.name === row.name && j.type !== "fixed",
            )
          )
            invalid.push({
              path: `prd.intake.action_draft.related_joints.${index}`,
              label: "相关关节",
              section: 2,
              message: `关节 ${row.name} 不在当前可动关节中。`,
            });
        });
        if (!action.stages.length)
          issue("prd.intake.action_draft.stages", "动作阶段", 3);
        action.stages.forEach((row, index) => {
          if (!row.description.trim() || row.confirmation_needed)
            issue(
              `prd.intake.action_draft.stages.${index}`,
              `${row.title || `阶段 ${index + 1}`}核对`,
              3,
            );
        });
        if (action.unresolved.length)
          issue(
            "prd.intake.action_draft.unresolved",
            "完整动作待核对事项",
            3,
            `${action.unresolved.length} 项待核对内容仍需逐项整理。`,
          );
        if (!action.end_pose_text.trim())
          issue("prd.intake.action_draft.end_pose_text", "结束姿势", 3);
      } else if (intake.intent !== "threshold") {
        if (!answers?.joint_name)
          issue("prd.intake.answers.joint_name", "本轮关节", 2);
        else if (
          !structure?.joints.some(
            (j) => j.name === answers.joint_name && j.type !== "fixed",
          )
        )
          invalid.push({
            path: "prd.intake.answers.joint_name",
            label: "本轮关节",
            section: 2,
            message: "选中的关节不在当前模型可动关节中。",
          });
        if (intake.intent === "position")
          num("target_rad", "目标角度", 3, -Infinity);
        if (intake.intent === "oscillate") {
          num("wave_start_rad", "摆动起点", 3, -Infinity);
          num("wave_end_rad", "摆动终点", 3, -Infinity);
          num("repetitions", "往返次数", 3, 1, true);
          num("dwell_s", "端点停留", 3, 0);
          if (!answers?.end_behavior)
            issue("prd.intake.answers.end_behavior", "结束位置", 3);
          else if (answers.end_behavior === "custom")
            num("end_position_rad", "自定结束角度", 3, -Infinity);
        }
      }
      if (intake.intent === "threshold") num("threshold", "触发阈值", 3, 0);
      if (
        intake.intent === "threshold" &&
        answers?.threshold != null &&
        answers.threshold > 1
      )
        invalid.push({
          path: "prd.intake.answers.threshold",
          label: "触发阈值",
          section: 3,
          message: "模拟传感器阈值必须在 0～1 之间。",
        });
      const controlled = structure?.joints.find(
        (j) => j.name === answers?.joint_name,
      );
      for (const key of [
        "target_rad",
        "wave_start_rad",
        "wave_end_rad",
        "end_position_rad",
      ] as const) {
        const value = answers?.[key],
          lower = controlled?.limits?.lower ?? controlled?.lower,
          upper = controlled?.limits?.upper ?? controlled?.upper;
        if (
          value != null &&
          controlled &&
          ((lower != null && value < lower) || (upper != null && value > upper))
        )
          invalid.push({
            path: `prd.intake.answers.${key}`,
            label: "关节角度",
            section: 3,
            message: "填写的角度超出当前模型关节范围，请调整。",
          });
      }
      num("max_velocity_rad_s", "速度上限", 3, Number.MIN_VALUE);
      num("tolerance_rad", "允许误差", 3, Number.MIN_VALUE);
      num("duration_s", "观察时长", 3, Number.MIN_VALUE);
      if (intake.intent === "other" && !answers?.other_action.trim())
        issue("prd.intake.answers.other_action", "其他动作说明", 3);
    }
    if (!answers?.board) issue("prd.intake.answers.board", "固件编译目标", 4);
    if (intake.mode === "hardware_notes") {
      for (const [key, note] of Object.entries(intake.hardware_notes))
        if (!note.value.trim())
          issue(
            `prd.intake.hardware_notes.${key}`,
            `硬件资料：${key}`,
            4,
            "未知实物信息不能由分享版推测，请补充厂家资料或保留待确认。",
          );
    }
    if (intake.details)
      for (const group of Object.keys(detailLabels) as DetailGroupKey[]) {
        const detail = intake.details[group];
        const selected =
          group === "motion"
            ? intake.details.motion.pattern
            : group === "device_mapping"
              ? intake.details.device_mapping.scope
              : (detail as { selection?: string }).selection;
        if (!selected)
          issue(
            `prd.intake.details.${group}`,
            detailLabels[group],
            detailSections[group],
          );
        else if (selected === "custom") {
          const empty = emptyDetails()[group];
          if (
            Object.entries(detail).every(
              ([key, value]) =>
                key === "selection" ||
                JSON.stringify(value) ===
                  JSON.stringify(
                    (empty as unknown as Record<string, unknown>)[key],
                  ),
            )
          )
            issue(
              `prd.intake.details.${group}`,
              `${detailLabels[group]}的补充`,
              detailSections[group],
              "已选择补充需求，请填写具体内容。",
            );
        }
      }
  } else {
    if (!draft.prd.structure_id) issue("prd.structure_id", "机器人结构", 2);
    if (!draft.prd.acceptance.trim()) issue("prd.acceptance", "验收标准", 5);
  }
  if (draft.workflow) {
    const checked = validateWorkflow(draft.workflow);
    if (checked.error)
      invalid.push({
        path: "workflow",
        label: "工程流程",
        section: 5,
        message: checked.error,
      });
  }
  const ready = !missing.length && !invalid.length;
  return {
    schema_version: intake?.schema_version || 1,
    status: ready ? "ready_for_plan" : "incomplete",
    can_save: true,
    can_plan: ready,
    execution_task: null,
    missing,
    invalid,
    unsupported: [
      {
        path: "public_demo.execution",
        label: "在线生成与运行",
        section: 5,
        message:
          "分享版可整理需求和预览分工；实际 AI、代码生成、编译与 ROS 验收需要完整本机平台。",
      },
    ],
    resolved: [],
    summary: {
      action: draft.request || "待填写",
      device: answers?.board
        ? `${answers.board} 编译目标（不是实物型号确认）`
        : "待选择",
      model: structure?.name || "待选择",
      criteria: draft.prd.acceptance || "查看已填写的误差、动作阶段与检查条件",
      scope: "浏览器需求草稿；信息齐全只允许预览分工，不证明代码或动作正确",
    },
    notice: publicDemoNotice,
  };
}

export function assistDraft(
  data: PublicDemoBundle,
  draft: Draft,
): PRDAssistance {
  const suggestions: AssistRecord[] = [];
  const request = draft.request;
  const wave = /招手|挥手/.test(request),
    side = /左/.test(request) ? "left" : "right";
  const intent =
    wave || /来回|往返|摆动/.test(request)
      ? "oscillate"
      : /阈值|触发/.test(request)
        ? "threshold"
        : /转到|转至|抬起|角度/.test(request)
          ? "position"
          : null;
  const selected = data.structures.find(
    (s) => s.id === draft.prd.intake?.answers.structure_id,
  );
  const reference = data.structures.find((s) => s.id === "sophicore-reference");
  const structure = selected || (wave ? reference : undefined);
  const recipe = Object.values(data.recipes).find(
    (r) =>
      r.structure_id === structure?.id &&
      r.motion_plan.recipe_id === `sophicore-${side}-wave-v1`,
  );
  const count = wave
    ? request.match(/(?:招手|挥手)\s*([一二三四五六七八九十\d]+)\s*次/)
    : null;
  const cn: Record<string, number> = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  const requestedRepetitions = count ? cn[count[1]] || Number(count[1]) : null;
  const add = (
    path: string,
    label: string,
    value: unknown,
    section: number,
    reason: string,
    source: AssistRecord["source"] = "example",
  ) => {
    const current = assistantValue(draft, path);
    const emptyGroup =
      path.startsWith("prd.intake.details.") &&
      JSON.stringify(current) ===
        JSON.stringify(emptyDetails()[path.slice(19) as DetailGroupKey]);
    if (value != null && (blank(current) || emptyGroup))
      suggestions.push({
        path,
        label,
        value,
        section,
        reason,
        source,
        basis: {
          request_text: request,
          structure_id: structure?.id || null,
          model_source_sha256:
            structure?.mapping_source_sha256 ||
            structure?.content_sha256 ||
            null,
        },
      });
  };
  add(
    "name",
    "工程名称",
    request.trim().slice(0, 45),
    1,
    "根据你的原话生成可修改的草稿标题",
    "request",
  );
  add("prd.use_case", "用途", request.trim(), 1, "保留你的原话", "request");
  add(
    "prd.intake.intent",
    "动作类型",
    intent,
    1,
    "仅识别页面内置关键词，没有调用 AI",
    "request",
  );
  if (!/实物|接线|真实电机|烧录/.test(request))
    add(
      "prd.intake.mode",
      "本轮用途",
      "simulation",
      1,
      "分享版的电脑仿真需求示例；不是实物确认",
      "platform",
    );
  if (structure)
    add(
      "prd.intake.answers.structure_id",
      "参考机器人",
      structure.id,
      2,
      "公开 Sophicore 模型参考，可自行更改",
      "model",
    );
  if (recipe)
    add(
      "prd.intake.answers.joint_name",
      "预览参考关节",
      recipe.motion_plan.joint_names[0],
      2,
      "只选择模型预览关节，完整动作仍保留全部相关关节",
      "model",
    );
  if (intent)
    for (const field of [
      "max_velocity_rad_s",
      "tolerance_rad",
      "duration_s",
      ...(intent === "oscillate" ? ["repetitions", "dwell_s"] : []),
      ...(intent === "threshold" ? ["threshold"] : []),
    ]) {
      const recommended = numberChoices(field, wave).find((c) => c.recommended);
      if (field === "repetitions" && requestedRepetitions != null)
        add(
          `prd.intake.answers.${field}`,
          "往返次数",
          requestedRepetitions,
          3,
          "来自你的原话，完整往返算一次",
          "request",
        );
      else if (recommended)
        add(
          `prd.intake.answers.${field}`,
          field,
          recommended.value,
          3,
          `可修改的草稿示例：${recommended.label}；${recommended.description}`,
        );
    }
  const angle = request.match(
    /(?:转到|转至|抬起)[^\d-]*(-?\d+(?:\.\d+)?)\s*(?:度|°)/,
  );
  if (angle && intent === "position")
    add(
      "prd.intake.answers.target_rad",
      "目标角度",
      (Number(angle[1]) * Math.PI) / 180,
      3,
      "来自用户明确给出的角度",
      "request",
    );
  if (wave && recipe && structure) {
    const repetitions = requestedRepetitions || 3;
    const jointNames = recipe.motion_plan.joint_names;
    const action: ActionDraft = {
      schema_version: 1,
      structure_id: structure.id,
      model_source_sha256: recipe.motion_plan.model_source_sha256,
      summary: request,
      scope: "multi_joint",
      reference_joint: jointNames[0],
      related_joints: jointNames.map((name) => ({
        name,
        label: structure.joints.find((j) => j.name === name)?.label || name,
        role: "参与参考招手动作",
        reason: "公开模型参考配方，仍需人工核对",
      })),
      stages: [
        {
          id: "prepare",
          title: "准备招手",
          description: `抬起${side === "left" ? "左" : "右"}臂，进入准备姿势；具体姿势需核对。`,
          joint_names: jointNames,
          repetitions: 1,
          target_rad: null,
          confirmation_needed: true,
        },
        {
          id: "wave",
          title: `招手 ${repetitions} 次`,
          description: "在核对后的两个姿势之间往返，一次完整往返算一次。",
          joint_names: jointNames,
          repetitions,
          target_rad: null,
          confirmation_needed: true,
        },
        {
          id: "finish",
          title: "结束动作",
          description: /身体旁|手臂放下|放到.*旁边/.test(request)
            ? "手臂放下并自然垂在身体旁边；各关节角度需核对。"
            : "按你填写的结束姿势结束，尚未确定时请补充。",
          joint_names: jointNames,
          repetitions: 1,
          target_rad: null,
          confirmation_needed: true,
        },
      ],
      end_pose_text: /身体旁|手臂放下|放到.*旁边/.test(request)
        ? "手臂自然垂在身体旁边。"
        : "",
      unresolved: [
        "请核对各阶段的关节角度、范围、起始和结束姿势。可明确采用公开参考配方后逐项检查。",
      ],
      requires_review: true,
    };
    add(
      "prd.intake.action_draft",
      "完整动作草稿",
      action,
      3,
      "浏览器规则整理公开示例，阶段和关节仍需核对；没有运行或验证",
      "model",
    );
  }
  const intake = draft.prd.intake;
  if (intake?.mode !== "hardware_notes" && !/实物|烧录|接线/.test(request)) {
    add(
      "prd.constraints",
      "本轮限制",
      "只整理电脑仿真需求；不连接实物，不烧录控制板。",
      5,
      "公开演示边界",
      "platform",
    );
    const defaults = adoptPlatformDetails(emptyDetails());
    for (const group of Object.keys(defaults) as DetailGroupKey[])
      add(
        `prd.intake.details.${group}`,
        detailLabels[group],
        defaults[group],
        detailSections[group],
        "采用可修改的平台仿真说明；不确认任何未知实物参数",
        "platform",
      );
  }
  return {
    schema_version: 2,
    base_draft_hash: "browser-snapshot-only",
    suggestions,
    conflicts: [],
    not_filled: [
      {
        path: "prd.intake.hardware_notes",
        label: "实物型号、供电、驱动和接线",
        section: 4,
        reason: "缺少实物和厂家资料，不能猜测。",
      },
      {
        path: "prd.intake.motion_plan",
        label: "姿势程序",
        section: 3,
        reason:
          "需主动选择参考配方并核对每个姿势，不根据招手文字自动确认角度。",
      },
    ],
    warnings: [
      "推荐只补空白。陌生动作没有规则时保留原话和待填写内容；已有记录不会成为你修改后需求的验收结果。",
    ],
    notice:
      "浏览器规则推荐（非 AI）。建议均可修改，实际生成与运行请使用完整本机平台。",
    provenance: {
      invocation_id: crypto.randomUUID(),
      tool: "分享版浏览器规则（非 AI）",
      model: "公开参考配方与固定选项",
      prompt: request,
      response: JSON.stringify(suggestions),
      status: "browser_rule_preview",
    },
  };
}

export async function publicDemoApi<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
  signal?: AbortSignal,
): Promise<T> {
  checkAbort(signal);
  const input = body === undefined ? undefined : copy(body);
  const data = await bundle(signal);
  checkAbort(signal);
  const url = new URL(path, "https://public-demo.invalid");
  if (url.origin !== "https://public-demo.invalid")
    return fail("分享版不允许访问外部服务接口。");
  const route = url.pathname.replace(/\/$/, ""),
    segments = route.split("/").filter(Boolean).map(decodeURIComponent);
  let result: unknown;
  if (method === "GET") {
    if (route === "/health")
      result = {
        environment: {
          ...data.environment,
          public_demo: true,
          scope: publicDemoNotice,
        },
      };
    else if (route === "/catalog") result = data.catalog;
    else if (route === "/settings") result = data.settings;
    else if (route === "/structures") result = { items: data.structures };
    else if (segments[0] === "structures" && segments.length === 2)
      result =
        data.structures.find((s) => s.id === segments[1]) ||
        fail("公开演示中没有这个结构。");
    else if (route === "/projects")
      result = { items: [...store().projects, ...data.projects] };
    else if (segments[0] === "projects" && segments.length === 2)
      result = getProject(data, segments[1]);
    else if (
      segments[0] === "projects" &&
      segments[2] === "runs" &&
      segments.length === 3
    ) {
      getProject(data, segments[1]);
      result = { items: data.runs.filter((r) => r.project_id === segments[1]) };
    } else if (
      segments[0] === "projects" &&
      segments[2] === "history" &&
      segments.length === 3
    ) {
      const p = getProject(data, segments[1]);
      result = {
        items: store().history[p.id] || [
          {
            id: "published-snapshot",
            project_id: p.id,
            revision: p.spec_revision,
            event: "created",
            created_at: p.created_at,
            snapshot: p,
          },
        ],
      };
    } else if (segments[0] === "runs" && segments.length === 2)
      result = getRun(data, segments[1]);
    else if (
      segments[0] === "runs" &&
      segments[2] === "file" &&
      segments.length === 3
    ) {
      getRun(data, segments[1]);
      const filePath = url.searchParams.get("path") || "";
      const files = data.files?.[segments[1]];
      const content = files && Object.hasOwn(files, filePath) ? files[filePath] : undefined;
      if (typeof content !== "string")
        return fail("此文件未包含在公开证据包内，不会访问本机文件。");
      result = { path: filePath, content };
    } else if (
      segments[0] === "runs" &&
      segments[2] === "experience" &&
      segments.length === 3
    ) {
      getRun(data, segments[1]);
      result =
        data.experiences?.[segments[1]] ||
        fail("此运行未公开整理后的经验条目，请查看检查结果和日志。");
    } else if (route === "/knowledge/stats")
      result = {
        documents: data.sources.length,
        ...data.knowledge_stats,
        retrieval_mode: "浏览器公开资料筛选（不是服务器 RAG 检索）",
      };
    else if (route === "/knowledge") {
      const query = (url.searchParams.get("q") || "").toLowerCase(),
        board = url.searchParams.get("board"),
        ros = url.searchParams.get("ros_distro"),
        task = url.searchParams.get("task_type");
      result = {
        items: data.sources.filter(
          (s) =>
            (!query ||
              `${s.title} ${s.content} ${s.tags.join(" ")}`
                .toLowerCase()
                .includes(query)) &&
            (!board || !s.board || s.board === board) &&
            (!ros || ros === "any" || !s.ros_distro || s.ros_distro === ros) &&
            (!task || s.tags.includes(task) || s.content.includes(task)),
        ),
      };
    } else if (
      segments[0] === "knowledge" &&
      segments[1] === "documents" &&
      segments.length === 3
    ) {
      const source = data.sources.find(
        (s) => s.id === segments[2] || s.document_id === segments[2],
      );
      if (!source) return fail("找不到这份公开资料。");
      result = {
        document: source,
        pages: [{ page: null, text: source.content }],
        chunks: [],
        source_bytes_sha256: source.source_hash || "",
        original_available: false,
        notice: "公开资料摘要。原文请查看来源链接。",
      };
    } else if (route === "/motion-v5/recipe") {
      const structure = url.searchParams.get("structure_id"),
        side = url.searchParams.get("side") || "right",
        cycles = url.searchParams.get("cycles") || "3";
      result = data.recipes[`${structure}:${side}:${cycles}`];
      if (!result)
        return fail(
          "分享版只提供已导出的参考配方。请选择三次招手，或在已采用的姿势程序中手动编辑往返区段。",
        );
    } else return fail("分享版没有这个公开读取接口，不会转发到本机后台。");
  } else if (method === "POST" && route === "/prd/preview")
    result = previewDraft(data, sanitizedDraft(input));
  else if (method === "POST" && route === "/prd/assist")
    result = assistDraft(data, sanitizedDraft(input));
  else if (method === "POST" && route === "/workflow/validate") {
    const workflow = copy(input) as EngineeringWorkflow;
    const checked = validateWorkflow(workflow);
    if (checked.error) return fail(checked.error);
    result = { workflow: { ...workflow, execution_order: checked.order } };
  } else if (method === "POST" && route === "/projects")
    result = saveDraft(data, input);
  else if (
    method === "PUT" &&
    segments[0] === "projects" &&
    segments.length === 2
  )
    result = saveDraft(data, input, segments[1]);
  else if (
    method === "POST" &&
    segments[0] === "runs" &&
    segments[2] === "clone" &&
    segments.length === 3
  )
    result = saveDraft(
      data,
      fromProject(getRun(data, segments[1]).spec_snapshot),
    );
  else if (
    method === "POST" &&
    segments[0] === "projects" &&
    segments[2] === "history" &&
    segments[4] === "clone" &&
    segments.length === 5
  ) {
    const p = getProject(data, segments[1]);
    const history = store().history[p.id] as
      { id: string; snapshot: Project }[] | undefined;
    const snapshot =
      history?.find((h) => h.id === segments[3])?.snapshot ||
      (segments[3] === "published-snapshot" ? p : null);
    if (!snapshot) return fail("找不到这个历史草稿。");
    result = saveDraft(data, fromProject(snapshot));
  } else if (
    method === "POST" &&
    segments[0] === "projects" &&
    segments[2] === "plan" &&
    segments.length === 3
  ) {
    let project = getProject(data, segments[1]);
    if (!project.id.startsWith(draftPrefix))
      project = saveDraft(data, fromProject(project));
    const ready = previewDraft(data, fromProject(project));
    if (!ready.can_plan)
      return fail("请先处理需求核对页中的空项和无效数据，再预览分工。");
    project.plan = {
      plan_id: `browser-outline-${crypto.randomUUID()}`,
      summary: `浏览器分工草稿：${project.request}`,
      ros_tasks: [
        "根据已填写的动作阶段安排目标和反馈；此处仅预览分工，不生成代码。",
      ],
      esp32_tasks: [
        "按选定编译目标处理通信、范围和指令；实物驱动仍需接线与设备资料。",
      ],
      communication: ["使用表单中明确选择的通信协议；本页不会建立实际通信。"],
      checks: [
        "人工核对各关节、姿势顺序、结束姿势和验收标准。",
        "返回完整本机平台后分别编译并检查 ROS 仿真与共享固件通信。",
      ],
      missing_information: [],
      blocking_issues: [
        "分享版未连接代码生成与执行服务。请使用完整本机平台运行此需求。",
      ],
      citations: [],
      provenance: {
        tool: "分享版浏览器规则（非 AI）",
        model: "固定分工模板",
        prompt: project.request,
        response: "仅预览需求分工；没有生成、编译或运行",
        sources: [],
      },
    };
    project.status = "awaiting_approval";
    project.latest_run_id = null;
    project.approval = null;
    project.updated_at = new Date().toISOString();
    remember(project, "planned");
    result = project;
  } else return fail();
  checkAbort(signal);
  return copy(result) as T;
}
