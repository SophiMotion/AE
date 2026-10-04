import GuideNumber from "./GuideNumber";
import GuideOptions from "./GuideOptions";
import { blankNumberRecommendations, numberChoices } from "./intakeChoices";
import {
  issueDestination,
  reviewIssueGroups,
  usesCompleteAction,
} from "./intakeIssues";
import ActionDraftEditor from "./ActionDraftEditor";
import MotionPlanEditor from "./MotionPlanEditor";
import { adoptMotionRecipe } from "./motionPlan";
import {
  applyAssistant,
  assistSource,
  clearAssistRecord,
  formatAssistValue,
} from "./intakeAssistant";
import PRDDetails, {
  DetailCoverage,
  PlatformDetailsAction,
} from "./PRDDetails";
import { upgradeIntake } from "./intakeDetails";
import {
  clearRecommendation,
  createRecommendationGate,
  recommendationSource,
} from "./intakeRecommendations";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleNotch,
  FloppyDisk,
  Info,
  PencilSimple,
  SlidersHorizontal,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState, type ComponentProps } from "react";
import {
  api,
  isPublicDemo,
  type HardwareNoteKey,
  type IntakeAnswers,
  type IntakeReadiness,
  type IntakeIssue,
  type PRDIntake,
  type Structure,
  type PRDAssistance,
  type AssistConflict,
  type ActionDraft,
} from "./api";
import LegacyRequirements from "./LegacyRequirements";
import StructurePanel from "./StructurePanel";
import WorkflowEditor from "./WorkflowEditor";
import ProjectManifest from "./ProjectManifest";
import {
  changeAnswer,
  changeIntent,
  formatDisplayNumber,
  guideSteps,
  hardwareNoteLabels,
  intentLabels,
  matchingPreview,
  migrateLegacyIntake,
  parseDisplayNumber,
} from "./intakeGuide";

type Props = ComponentProps<typeof LegacyRequirements>;
export default function Requirements(props: Props) {
  if (!props.draft.prd.intake)
    return (
      <>
        <div className="notice legacy-guide-notice">
          <Info size={22} />
          <div>
            <strong>这是一份已有工程</strong>
            <p>
              仍按原表单查看和修改。切换到新引导会保留原话与现有参数，之后需要重新拆分、核对。
            </p>
            <button
              className="button secondary"
              disabled={props.locked || props.saving}
              onClick={() => props.setDraft(migrateLegacyIntake(props.draft))}
            >
              按新表单整理
            </button>
          </div>
        </div>
        <LegacyRequirements {...props} />
      </>
    );
  return <IntakeGuide {...props} />;
}

function IntakeGuide({
  draft,
  setDraft,
  catalog,
  locked: externalLocked,
  saving,
  onSave,
  onPlan,
  manifest,
  manifestStale,
}: Props) {
  const intake = draft.prd.intake!;
  const answers = intake.answers;
  const [step, setStep] = useState(0);
  const [angleUnit, setAngleUnit] = useState<"deg" | "rad">("deg");
  const [structure, setStructure] = useState<Structure | null>(null);
  const [structureBusy, setStructureBusy] = useState(false);
  const [recommending, setRecommending] = useState(false);
  const [recommendationResult, setRecommendationResult] = useState<{
    response: PRDAssistance;
    count: number;
    key: string;
  } | null>(null);
  const [recommendationError, setRecommendationError] = useState("");
  const recommendationGate = useRef(createRecommendationGate());
  const recommendationAbort = useRef<AbortController | null>(null);
  const currentDraft = useRef(draft);
  currentDraft.current = draft;
  const [preview, setPreview] = useState<{
    key: string;
    data: IntakeReadiness;
  } | null>(null);
  const [previewError, setPreviewError] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const formRef = useRef<HTMLElement>(null);
  const [issueFocus, setIssueFocus] = useState<{
    issue: IntakeIssue;
    nonce: number;
  } | null>(null);
  const locked = externalLocked || structureBusy || saving || recommending;
  const key = JSON.stringify(draft);
  const readiness = matchingPreview(key, preview);
  const error = previewError?.key === key ? previewError.message : "";
  const checking = !readiness && !error;
  useEffect(
    () => () => {
      recommendationGate.current.cancel();
      recommendationAbort.current?.abort();
    },
    [],
  );
  const cancelRecommendation = () => {
    recommendationGate.current.cancel();
    recommendationAbort.current?.abort();
    setRecommending(false);
    setRecommendationError("已取消，本次建议没有填入");
  };
  const recommend = async () => {
    if (locked || intake.schema_version !== 2 || !draft.request.trim()) return;
    const ticket = recommendationGate.current.begin(JSON.stringify(draft));
    const controller = new AbortController();
    recommendationAbort.current = controller;
    setRecommending(true);
    setRecommendationError("");
    try {
      const response = await api<PRDAssistance>(
        "/prd/assist",
        draft,
        "POST",
        controller.signal,
      );
      if (
        !recommendationGate.current.accepts(
          ticket,
          JSON.stringify(currentDraft.current),
        )
      )
        return;
      const result = applyAssistant(
        currentDraft.current,
        response.suggestions,
        response.provenance,
      );
      setDraft(result.draft);
      if (result.error) setRecommendationError(result.error);
      setRecommendationResult({
        response,
        count: result.applied.length,
        key: JSON.stringify(result.draft),
      });
    } catch (error) {
      if (
        recommendationGate.current.accepts(
          ticket,
          JSON.stringify(currentDraft.current),
        )
      )
        setRecommendationError((error as Error).message);
    } finally {
      // Unmount invalidates the ticket; don't send state to another project.
      if (recommendationGate.current.active(ticket)) setRecommending(false);
    }
  };
  const adoptConflict = (record: AssistConflict) => {
    if (
      locked ||
      !recommendationResult ||
      recommendationResult.key !== JSON.stringify(draft)
    )
      return;
    const result = applyAssistant(
      draft,
      [record],
      recommendationResult.response.provenance,
      record,
    );
    if (!result.applied.length) {
      setRecommendationError(
        "这项内容已变化，或包含你填写的补充；请直接编辑后重新推荐",
      );
      return;
    }
    setDraft(result.draft);
    setRecommendationResult({
      ...recommendationResult,
      key: JSON.stringify(result.draft),
      count: recommendationResult.count + 1,
      response: {
        ...recommendationResult.response,
        conflicts: recommendationResult.response.conflicts.filter(
          (row) => row.path !== record.path,
        ),
      },
    });
  };
  const sourceFor = (path: string) =>
    assistSource(draft, path, structure) ||
    recommendationSource(draft, path, structure);
  const motionSource = assistSource(draft, "prd.intake.motion_plan", structure);
  const sourceNote = (path: string) => {
    const source = sourceFor(path);
    return source ? (
      <small className="recommendation-field-source">
        <strong>{source.label}</strong> · {source.record.reason}
      </small>
    ) : null;
  };
  useEffect(() => {
    let active = true;
    setStructure(null);
    if (answers.structure_id)
      api<Structure>(`/structures/${encodeURIComponent(answers.structure_id)}`)
        .then((value) => {
          if (active) setStructure(value);
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [answers.structure_id]);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      api<IntakeReadiness>("/prd/preview", JSON.parse(key))
        .then((data) => {
          if (active) {
            setPreview({ key, data });
            setPreviewError(null);
          }
        })
        .catch((e) => {
          if (active) setPreviewError({ key, message: (e as Error).message });
        });
    }, 300);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [key]);
  const { actionable: issues, unsupported: capabilityIssues } =
    reviewIssueGroups(readiness);
  const goStep = (next: number) => {
    setIssueFocus(null);
    setStep(next);
    requestAnimationFrame(() => {
      titleRef.current?.focus({ preventScroll: true });
      titleRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
  };
  const goIssue = (issue: IntakeIssue) => {
    setStep(issueDestination(issue).step);
    setIssueFocus({ issue, nonce: Date.now() });
  };
  useEffect(() => {
    if (!issueFocus) return;
    let highlight: HTMLElement | undefined;
    const frame = requestAnimationFrame(() => {
      const container = formRef.current;
      if (!container) return;
      const { path } = issueDestination(issueFocus.issue);
      const labels: Record<string, string[]> = {
        "prd.intake.answers.structure_id": ["结构模型"],
        "prd.intake.answers.joint_name": ["参考预览关节", "本轮控制的关节"],
        request: ["你希望机器人做什么"],
        name: ["工程名称"],
        "prd.acceptance": ["怎样才算完成"],
        "prd.constraints": ["必须遵守的限制"],
        "prd.intake.answers.board": ["目标控制板"],
      };
      const input = [
        ...container.querySelectorAll<HTMLElement>("[aria-label]"),
      ].find((node) =>
        labels[path]?.includes(node.getAttribute("aria-label") || ""),
      );
      const candidates = [
        ...container.querySelectorAll<HTMLElement>("[data-intake-path]"),
      ];
      highlight =
        input ||
        candidates.find((node) => node.dataset.intakePath === path) ||
        candidates
          .filter((node) =>
            path.startsWith((node.dataset.intakePath || "") + "."),
          )
          .sort(
            (a, b) =>
              (b.dataset.intakePath?.length || 0) -
              (a.dataset.intakePath?.length || 0),
          )[0];
      if (!highlight) {
        titleRef.current?.scrollIntoView({
          block: "start",
          behavior: "smooth",
        });
        return;
      }
      let parent: HTMLElement | null = highlight;
      while (parent && parent !== container) {
        if (parent instanceof HTMLDetailsElement) parent.open = true;
        parent = parent.parentElement;
      }
      highlight.classList.add("issue-focus-target");
      const focus = highlight.matches("input,select,textarea,button")
        ? highlight
        : highlight.querySelector<HTMLElement>(
            "textarea:not(:disabled),input:not(:disabled),select:not(:disabled)",
          ) ||
          highlight.querySelector<HTMLElement>("button:not(:disabled)") ||
          highlight;
      focus.scrollIntoView({ block: "center", behavior: "smooth" });
      focus.focus({ preventScroll: true });
    });
    return () => {
      cancelAnimationFrame(frame);
      highlight?.classList.remove("issue-focus-target");
    };
  }, [issueFocus, step]);
  const updateIntake = (value: Partial<PRDIntake>) => {
    let next: typeof draft = {
      ...draft,
      prd: { ...draft.prd, intake: { ...intake, ...value } },
    };
    for (const field of Object.keys(value)) {
      if (field === "details" && value.details) {
        for (const group of Object.keys(value.details)) {
          if (
            JSON.stringify(
              value.details[group as keyof typeof value.details],
            ) !==
            JSON.stringify(
              intake.details?.[group as keyof typeof value.details],
            )
          )
            next = clearAssistRecord(next, `prd.intake.details.${group}`);
        }
      } else if (
        field === "motion_plan" &&
        value.motion_plan &&
        intake.motion_plan &&
        JSON.stringify({ ...value.motion_plan, reviewed: false }) ===
          JSON.stringify({ ...intake.motion_plan, reviewed: false })
      ) {
        // Reviewing the same poses retains their actual reference source.
      } else next = clearAssistRecord(next, `prd.intake.${field}`);
    }
    setDraft(next);
  };
  const updateAnswer = <K extends keyof IntakeAnswers>(
    field: K,
    value: IntakeAnswers[K],
  ) => setDraft(changeAnswer(draft, field, value));
  const updateText = (
    field: "constraints" | "acceptance" | "use_case",
    value: string,
  ) =>
    setDraft(
      clearRecommendation(
        { ...draft, prd: { ...draft.prd, [field]: value } },
        `prd.${field}`,
      ),
    );
  const joint =
    structure?.id === answers.structure_id
      ? structure.joints.find((item) => item.name === answers.joint_name)
      : null;
  const motion = intake.intent === "position" || intake.intent === "oscillate";
  const action = intake.action_draft;
  const completeAction = !!intake.motion_plan || usesCompleteAction(action);
  const currentModelHash =
    structure?.mapping_source_sha256 || structure?.content_sha256;
  const actionStale =
    !!action &&
    (action.model_source_sha256
      ? action.model_source_sha256 !== currentModelHash
      : action.structure_id !== answers.structure_id);
  const suggestCommon = () => {
    const fields: (keyof IntakeAnswers)[] = ["duration_s"];
    if (motion || action?.related_joints.length)
      fields.push("tolerance_rad", "max_velocity_rad_s");
    if (intake.intent === "threshold" && !completeAction)
      fields.push("threshold");
    if (intake.intent === "oscillate" && !completeAction)
      fields.push("repetitions", "dwell_s");
    let next = draft;
    for (const [field, value] of Object.entries(
      blankNumberRecommendations(answers, fields, completeAction),
    )) {
      next = changeAnswer(next, field as keyof IntakeAnswers, value);
    }
    setDraft(next);
  };
  const numberField = (
    field: keyof IntakeAnswers,
    label: string,
    unit: "angle" | "speed" | "seconds" | "count" | "scalar",
    hint?: string,
  ) => {
    const numeric = answers[field] as number | null;
    const source = sourceFor(`prd.intake.answers.${field}`);
    return (
      <div
        key={field}
        className="guide-field-anchor"
        data-intake-path={`prd.intake.answers.${field}`}
        tabIndex={-1}
      >
        <GuideNumber
          label={label}
          value={numeric}
          unit={unit === "angle" || unit === "speed" ? angleUnit : "number"}
          suffix={
            unit === "angle"
              ? angleUnit === "deg"
                ? "°"
                : "rad"
              : unit === "speed"
                ? angleUnit === "deg"
                  ? "°/s"
                  : "rad/s"
                : unit === "seconds"
                  ? "秒"
                  : unit === "count"
                    ? "次"
                    : "0–1"
          }
          disabled={locked}
          hint={
            hint ||
            ([
              "target_rad",
              "wave_start_rad",
              "wave_end_rad",
              "end_position_rad",
            ].includes(field)
              ? "这个角度取决于所选关节和姿势，没有通用推荐值。先看模型；不清楚就留待确认。"
              : field === "duration_s"
                ? "这是观察时长，不保证所有动作会在这段时间内做完。"
                : undefined)
          }
          choices={numberChoices(field, completeAction)}
          suggested={intake.accepted_suggestions.includes(`answers.${field}`)}
          source={
            source
              ? { label: source.label, reason: source.record.reason }
              : null
          }
          onChange={(value) => updateAnswer(field, value)}
        />
      </div>
    );
  };
  return (
    <section
      ref={formRef}
      className="panel requirement-panel intake-guide"
      aria-label="需求引导表单"
    >
      <header className="panel-heading">
        <SlidersHorizontal size={24} />
        <div>
          <h2>把需求说明白，再生成程序</h2>
          <p>
            先选看得懂的选项；不知道的留空。保存不会调用 AI，也不会启动机器人。
          </p>
        </div>
        <span className="scope-badge">需求准备</span>
      </header>
      {intake.schema_version === 1 && (
        <div className="notice legacy-guide-notice">
          <Info size={20} />
          <div>
            <strong>这份需求仍使用原来的五步表单</strong>
            <p>
              可以继续查看和保存。需要补充动作顺序、设备对应、异常和环境时，再明确升级；原话和已有答案会保留，新问题先留空。
            </p>
            <button
              type="button"
              className="button secondary"
              disabled={locked}
              onClick={() => updateIntake(upgradeIntake(intake))}
            >
              补全详细需求
            </button>
          </div>
        </div>
      )}
      <nav className="guide-steps" aria-label="填写步骤">
        {guideSteps.map((label, index) => {
          const count = issues.filter(
            (issue) => issueDestination(issue).step === index,
          ).length;
          return (
            <button
              key={label}
              type="button"
              disabled={locked}
              className={step === index ? "active" : ""}
              aria-current={step === index ? "step" : undefined}
              onClick={() => goStep(index)}
            >
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{label}</strong>
              {readiness && count > 0 ? <small>{count} 项待补</small> : null}
            </button>
          );
        })}
      </nav>
      <aside className="recommendation-panel" aria-label="按需求智能填写">
        <div className="recommendation-heading">
          <div>
            <strong>说出需求，帮你整理能确定的内容</strong>
            <p>
              可推荐参考模型、相关关节、动作步骤和测试参数。已有内容保留，冲突由你决定。
            </p>
          </div>
          <div className="recommendation-actions">
            <button
              type="button"
              className="button secondary"
              disabled={
                locked || intake.schema_version !== 2 || !draft.request.trim()
              }
              onClick={recommend}
            >
              {recommending && <CircleNotch size={17} className="spin" />}
              {recommending ? "正在整理需求…" : isPublicDemo ? "按需求填写参考建议" : "按需求智能填写"}
            </button>
            {recommending && (
              <button
                type="button"
                className="button secondary"
                onClick={cancelRecommendation}
              >
                取消本次推荐
              </button>
            )}
          </div>
        </div>
        <small>
          {intake.schema_version !== 2
            ? "请先点击上方“补全详细需求”。"
            : !draft.request.trim()
              ? "先在第 1 步用自己的话写出需求。"
              : isPublicDemo ? "使用浏览器内的参考规则整理草稿，不调用 AI。仅推荐可识别的任务；已有内容保留，未知硬件不猜。" : "调用当前配置的 AI，可能需要一点时间。建议填入草稿后可以改；未知实物接线和姿势角度不会猜。"}
        </small>
        {recommending && (
          <p role="status">
            正在结合需求和模型目录整理内容。期间不会保存、编译或运行程序。
          </p>
        )}
        {recommendationError && (
          <p className="recommendation-error" role="alert">
            {recommendationError}
          </p>
        )}
        {recommendationResult && (
          <div className="recommendation-result" aria-live="polite">
            <strong>
              {recommendationResult.count
                ? `本次已补 ${recommendationResult.count} 项`
                : "本次没有可直接补入的空白，请查看下面的说明"}
            </strong>
            <p>{recommendationResult.response.notice}</p>
            {recommendationResult.response.warnings.map((warning, index) => (
              <p className="assistant-warning" key={index}>
                {warning}
              </p>
            ))}
            {!!recommendationResult.response.conflicts.length && (
              <div className="assistant-conflicts">
                <strong>这些建议与已填内容不同，先由你确认</strong>
                {recommendationResult.response.conflicts.map(
                  (record, index) => (
                    <article key={`${record.path}-${index}`}>
                      <div>
                        <strong>{record.label}</strong>
                        <p>{record.reason}</p>
                        <small>
                          目前：
                          {formatAssistValue(
                            record.path,
                            record.current_value,
                            angleUnit,
                          )}{" "}
                          → 建议：
                          {formatAssistValue(
                            record.path,
                            record.value,
                            angleUnit,
                          )}
                        </small>
                        {record.path === "prd.intake.action_draft" && (
                          <details>
                            <summary>采用前查看建议的完整动作</summary>
                            <ActionDraftEditor
                              action={record.value as ActionDraft}
                              structure={structure}
                              disabled
                              section="summary"
                              onChange={() => {}}
                            />
                          </details>
                        )}
                      </div>
                      <button
                        type="button"
                        className="button secondary"
                        disabled={
                          locked ||
                          recommendationResult.key !== JSON.stringify(draft)
                        }
                        onClick={() => adoptConflict(record)}
                      >
                        采用此建议：{record.label}
                      </button>
                    </article>
                  ),
                )}
                {recommendationResult.key !== JSON.stringify(draft) && (
                  <p>草稿已修改，请重新推荐后再采用纠正建议。</p>
                )}
              </div>
            )}
            {!!recommendationResult.response.not_filled.length && (
              <div className="assistant-missing">
                <strong>还需要你确认</strong>
                <ul>
                  {recommendationResult.response.not_filled.map(
                    (item, index) => (
                      <li key={`${item.path}-${index}`}>
                        <strong>{item.label}：</strong>
                        {item.reason}{" "}
                        <button
                          type="button"
                          className="text-button"
                          disabled={locked}
                          onClick={() =>
                            goIssue({ ...item, message: item.reason })
                          }
                        >
                          去查看
                        </button>
                      </li>
                    ),
                  )}
                </ul>
              </div>
            )}
            <details className="assistant-provenance">
              <summary>这次用的工具、模型和提示词</summary>
              <p>
                工具：{recommendationResult.response.provenance.tool} · 模型：
                {recommendationResult.response.provenance.model} · 状态：
                {recommendationResult.response.provenance.status}
              </p>
              <pre>{recommendationResult.response.provenance.prompt}</pre>
            </details>
          </div>
        )}
        {!!intake.recommendation_bundle && (
          <details className="recommendation-records">
            <summary>
              已采用的智能建议 · {intake.recommendation_bundle.records.length}{" "}
              项
            </summary>
            <ul>
              {intake.recommendation_bundle.records.map((record) => {
                const source = sourceFor(record.path);
                return source ? (
                  <li key={record.path}>
                    <strong>
                      {record.label} · {source.label}
                    </strong>
                    <p>{record.reason}</p>
                    {"provenance" in source && source.provenance ? (
                      <details>
                        <summary>这项建议的工具与提示词</summary>
                        <p>
                          {source.provenance.tool} · {source.provenance.model}
                        </p>
                        <pre>{source.provenance.prompt}</pre>
                      </details>
                    ) : (
                      <small>
                        这条历史建议没有对应的调用记录，不归到最近一次提示词。
                      </small>
                    )}
                    <button
                      type="button"
                      className="text-button"
                      disabled={locked}
                      onClick={() =>
                        goStep(Math.max(0, Math.min(4, record.section - 1)))
                      }
                    >
                      查看 / 修改
                    </button>
                  </li>
                ) : null;
              })}
            </ul>
            <p>
              最近一次采用建议的工具：
              {intake.recommendation_bundle.provenance.tool} · 模型：
              {intake.recommendation_bundle.provenance.model}
            </p>
            <details>
              <summary>查看最近一次采用建议的提示词</summary>
              <pre>{intake.recommendation_bundle.provenance.prompt}</pre>
            </details>
          </details>
        )}
        {!!intake.recommendation_records?.length && (
          <details className="recommendation-records">
            <summary>
              以前采用的规则建议 · {intake.recommendation_records.length} 项
            </summary>
            <ul>
              {intake.recommendation_records.map((record) => {
                const source = sourceFor(record.path);
                return source ? (
                  <li key={record.path}>
                    <strong>
                      {record.label} · {source.label}
                    </strong>
                    <p>{record.reason}</p>
                  </li>
                ) : null;
              })}
            </ul>
          </details>
        )}
        {action && (
          <>
            <ActionDraftEditor
              action={action}
              structure={structure}
              disabled={locked}
              section="summary"
              onChange={(value) => updateIntake({ action_draft: value })}
            />
            {actionStale && (
              <p className="assistant-warning">
                参考结构已变化或仍在读取，请重新核对完整动作里的关节；旧动作不会自动套到新模型。
              </p>
            )}
            {sourceNote("prd.intake.action_draft")}
          </>
        )}
      </aside>
      <div className="guide-body">
        <div className="guide-step-heading">
          <span>第 {step + 1} 步 / 共 5 步</span>
          <h3 ref={titleRef} tabIndex={-1}>
            {
              [
                "先说你想实现什么",
                "选出要控制的对象",
                "把动作说具体一点",
                "准备在哪儿运行，用什么板",
                "检查这份需求是否说清楚",
              ][step]
            }
          </h3>
        </div>
        {issueFocus && (
          <p className="guide-focus-notice" role="status">
            正在查看：{issueFocus.issue.label}。
            {issueFocus.issue.path.includes("action_draft") &&
            /待确认|待核对/.test(issueFocus.issue.message)
              ? "请整理下方待核对清单，不需要另找一组隐藏的参数。"
              : "已定位到相关填写位置，改完后可以回第 5 步重新检查。"}
          </p>
        )}
        {step === 0 && (
          <>
            <div className="guide-choice-intro">
              <strong>先用自己的话说清动作</strong>
              <p>
                可以照这个顺序写：哪一边、做什么、做几次、最后停在哪里。例如“右臂抬起，招手三次，最后放到身体旁边”。不需要先知道专业名词。
              </p>
              <small>
                “推荐”是可选的填写建议；点击选项后才会改变草稿。AI
                整理需求和保存仍是分开的操作。
              </small>
            </div>
            <label className="field request-field">
              <span>
                你希望机器人做什么 <small>保留你的原话</small>
              </span>
              <textarea
                aria-label="你希望机器人做什么"
                rows={4}
                maxLength={4000}
                value={draft.request}
                disabled={locked}
                onChange={(e) =>
                  setDraft({ ...draft, request: e.target.value })
                }
                placeholder="例如：让机器人抬起右手，来回招手三次，最后放回原位。"
              />
              <small>
                先描述意图。后面再选部位、填动作细节；AI 不会仅凭一句话猜接线。
              </small>
            </label>
            <div className="field">
              <span data-intake-path="prd.intake.intent" tabIndex={-1}>
                它更接近哪类动作？
              </span>
              <div
                className="intent-options"
                role="radiogroup"
                aria-label="动作类型"
              >
                {(
                  Object.keys(intentLabels) as Exclude<
                    PRDIntake["intent"],
                    null
                  >[]
                ).map((intent) => (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={intake.intent === intent}
                    className={intake.intent === intent ? "selected" : ""}
                    key={intent}
                    disabled={locked}
                    onClick={() => setDraft(changeIntent(draft, intent))}
                  >
                    <strong>{intentLabels[intent]}</strong>
                    <small>
                      {intent === "position"
                        ? "只做一次定位，例如抬起一个关节后停住。"
                        : intent === "threshold"
                          ? "例如数值升到某个大小后，把开关打开。"
                          : intent === "oscillate"
                            ? "例如招手、摆动；要说明次数和结束姿势。"
                            : "例如几个部位依次配合；先保留完整需求。"}
                    </small>
                    <span>
                      {intent === "position" || intent === "threshold"
                        ? "可接现有本机测试"
                        : intake.motion_plan
                          ? "已采用逐关节程序，核对后检查执行条件"
                          : "Sophicore 动作可转换为逐关节姿势程序"}
                    </span>
                  </button>
                ))}
              </div>
              {sourceNote("prd.intake.intent")}
              <small className="guide-choice-help">
                拿不准时，先保留原话，再点“按需求智能填写”整理；不用把完整动作硬改成单个关节。
              </small>
            </div>
            <label className="field">
              <span>
                给这份需求起个名字 <small>可以稍后再填</small>
              </span>
              <input
                aria-label="工程名称"
                maxLength={80}
                value={draft.name}
                disabled={locked}
                onChange={(e) =>
                  setDraft(
                    clearRecommendation(
                      { ...draft, name: e.target.value },
                      "name",
                    ),
                  )
                }
                placeholder="例如：右手招手需求"
              />
              {sourceNote("name")}
            </label>
            <details className="guide-extra">
              <summary>补充使用场景（选填）</summary>
              <label className="field">
                <span>用在什么场景</span>
                <textarea
                  aria-label="使用场景"
                  rows={2}
                  maxLength={500}
                  value={draft.prd.use_case}
                  disabled={locked}
                  onChange={(e) => updateText("use_case", e.target.value)}
                  placeholder="例如：迎宾时打招呼"
                />
                {sourceNote("prd.use_case")}
              </label>
            </details>
          </>
        )}
        {intake.schema_version === 2 && intake.details && step === 0 && (
          <PlatformDetailsAction
            v5Motion={!!intake.motion_plan}
            details={intake.details}
            intent={intake.intent}
            disabled={locked}
            onChange={(details) => updateIntake({ details })}
          />
        )}
        {step === 1 && (
          <>
            {!intake.intent && !action && !intake.motion_plan ? (
              <div className="notice">
                <Info size={19} />
                <div>
                  先选动作类型，才能知道需要哪种控制对象。
                  <button className="text-button" onClick={() => goStep(0)}>
                    返回选动作
                  </button>
                </div>
              </div>
            ) : motion ||
              action ||
              intake.motion_plan ||
              intake.intent === "other" ? (
              <>
                <p className="guide-intro">
                  {action || intake.motion_plan || intake.intent === "other"
                    ? "先核对参考模型和涉及的关节。预览关节只用来查看模型，完整动作可以涉及多个关节。"
                    : "从已有结构中选择一个关节。可以先查看 3D，再确认部位；没选清楚也能保存。"}
                </p>
                <div className="guide-choice-intro">
                  <strong>还没有自己的模型，也能先整理需求</strong>
                  <p>
                    可以用下方参考结构看部位，再核对左右侧和关节名称。参考结构可用于核对部位并生成本机仿真程序，不代表你的实物尺寸或接线。
                  </p>
                  <small>
                    招手等动作可由多个关节配合；预览下拉框只决定你正在看哪个关节。
                  </small>
                </div>
                <StructurePanel
                  id={answers.structure_id}
                  jointName={answers.joint_name}
                  jointLabel={
                    action || intake.motion_plan || intake.intent === "other"
                      ? "参考预览关节"
                      : undefined
                  }
                  target={answers.target_rad ?? joint?.initial_position ?? 0}
                  locked={locked}
                  onBusyChange={setStructureBusy}
                  onStructure={setStructure}
                  onChange={(id, jointName) => {
                    let next = changeAnswer(draft, "structure_id", id);
                    next = changeAnswer(next, "joint_name", jointName);
                    setDraft(next);
                  }}
                />
                {sourceNote("prd.intake.answers.structure_id")}
                {sourceNote("prd.intake.answers.joint_name")}
                {action && (
                  <ActionDraftEditor
                    action={action}
                    structure={structure}
                    disabled={locked}
                    section="joints"
                    onChange={(value) => updateIntake({ action_draft: value })}
                  />
                )}
                <p className="field-hint">
                  更换模型后需要重新选关节；已填角度会保留，后台会检查是否超出新模型范围。
                </p>
              </>
            ) : intake.intent === "threshold" ? (
              <div className="guide-fact">
                <strong>本轮使用模拟传感器和虚拟开关</strong>
                <p>
                  传感器提供 0–1 的测试数值。达到阈值输出 1，低于阈值输出
                  0；无需选择机械关节。
                </p>
                <span className="origin-tag">平台固定设置</span>
                <p>
                  真实传感器型号可在“硬件与资料”记录；填写型号不会自动适配驱动。
                </p>
              </div>
            ) : (
              <div className="guide-fact">
                <strong>先记录要控制的对象</strong>
                <p>
                  请在动作描述中写清机器人、部位和设备。Sophicore
                  的多关节顺序和往返动作可以在第 3
                  步显式采用逐关节姿势程序；其他要求继续保留并交给后台检查支持范围。
                </p>
                <button className="text-button" onClick={() => goStep(2)}>
                  继续写动作细节
                </button>
              </div>
            )}
          </>
        )}
        {step === 2 && (
          <>
            {intake.schema_version === 2 &&
              (intake.intent !== "threshold" ||
                motion ||
                completeAction ||
                /招手|挥手|手臂|关节|姿势/.test(draft.request)) && (
                <MotionPlanEditor
                  source={motionSource?.record}
                  provenance={motionSource?.provenance}
                  sourceStale={motionSource?.stale}
                  onAdopt={(recipe, endpoint) => {
                    const next = adoptMotionRecipe(draft, recipe, endpoint);
                    if (next === draft)
                      setRecommendationError(
                        "来源记录达到容量上限或已有程序，当前姿势保留；不能覆盖原有内容。",
                      );
                    else setDraft(next);
                  }}
                  plan={intake.motion_plan}
                  structure={structure}
                  request={draft.request}
                  disabled={locked}
                  onChange={(motion_plan) => updateIntake({ motion_plan })}
                />
              )}
            {(motion || completeAction) && (
              <div className="angle-unit-control">
                <span>角度显示</span>
                <div role="group" aria-label="角度单位">
                  <button
                    type="button"
                    className={angleUnit === "deg" ? "active" : ""}
                    aria-pressed={angleUnit === "deg"}
                    disabled={locked}
                    onClick={() => setAngleUnit("deg")}
                  >
                    度 °
                  </button>
                  <button
                    type="button"
                    className={angleUnit === "rad" ? "active" : ""}
                    aria-pressed={angleUnit === "rad"}
                    disabled={locked}
                    onClick={() => setAngleUnit("rad")}
                  >
                    弧度 rad
                  </button>
                </div>
                <small>
                  不熟悉弧度可以用“度”。只改变通用参数的显示，程序统一使用
                  rad；阶段角度会注明自己的单位。
                </small>
              </div>
            )}
            {action && (
              <ActionDraftEditor
                action={action}
                structure={structure}
                disabled={locked}
                section="stages"
                onChange={(value) => updateIntake({ action_draft: value })}
              />
            )}
            {completeAction ? (
              <>
                <p className="notice">
                  {intake.motion_plan
                    ? "执行采用上面的逐关节姿势程序。下面仍保留原始动作草稿和补充要求；有冲突或未决项需要人工处理。"
                    : "这份需求按完整动作保存。可以显式采用上面的逐关节姿势建议并核对，再检查能否执行。"}
                </p>
                {intake.motion_plan ? (
                  <details className="source-details">
                    <summary>
                      保留的旧草稿通用参数（只读，不用于当前执行）
                    </summary>
                    <p>
                      当前执行速度、误差、加速度和超时均以上方“逐关节姿势程序”为准；下面仅保留以前填写的草稿值。
                    </p>
                    <dl>
                      <dt>旧最快转速 (rad/s)</dt>
                      <dd>{answers.max_velocity_rad_s ?? "未填写"}</dd>
                      <dt>旧允许误差 (rad)</dt>
                      <dd>{answers.tolerance_rad ?? "未填写"}</dd>
                      <dt>旧观察时长 (s)</dt>
                      <dd>{answers.duration_s ?? "未填写"}</dd>
                    </dl>
                  </details>
                ) : (
                  <>
                    <h4>整套动作的通用参数建议</h4>
                    <p className="field-hint">
                      不知道数字怎么填，可以点下面的选项。推荐只用于本机需求草稿；每个阶段和关节的具体参数还要核对。
                    </p>
                    <div className="guide-fields">
                      {!!action?.related_joints.length &&
                        numberField(
                          "max_velocity_rad_s",
                          "最快每秒转多少",
                          "speed",
                        )}
                      {!!action?.related_joints.length &&
                        numberField("tolerance_rad", "允许多大误差", "angle")}
                      {numberField("duration_s", "预计观察多久", "seconds")}
                    </div>
                  </>
                )}
              </>
            ) : !intake.intent ? (
              <div className="notice">先在第 1 步选择动作类型。</div>
            ) : intake.intent === "other" ? (
              <label className="field">
                <span>动作还需要哪些步骤和条件</span>
                <textarea
                  aria-label="其他动作细节"
                  rows={5}
                  maxLength={2000}
                  value={answers.other_action}
                  onChange={(e) => updateAnswer("other_action", e.target.value)}
                  disabled={locked}
                  placeholder="谁来触发、先做什么、后做什么、什么情况下停下……不知道的写待确认。"
                />
              </label>
            ) : (
              <>
                {intake.intent === "oscillate" && (
                  <div className="notice guide-scope-note">
                    <Info size={18} />
                    <span>
                      这里保留单轴 A / B 的原始描述。Sophicore
                      招手可以显式采用上方逐关节姿势建议，并核对全部关节、时间和结束姿势；这组原始描述不会自动升级成完整执行程序。
                    </span>
                  </div>
                )}
                <div className="guide-fields">
                  {intake.intent === "position" &&
                    numberField(
                      "target_rad",
                      "转到哪个角度",
                      "angle",
                      "相对模型的零位，不是“再转多少度”。",
                    )}
                  {intake.intent === "oscillate" && (
                    <>
                      {numberField("wave_start_rad", "位置 A", "angle")}
                      {numberField("wave_end_rad", "位置 B", "angle")}
                      {numberField(
                        "repetitions",
                        "来回几次",
                        "count",
                        "A → B → A 算一次。",
                      )}
                      {numberField("dwell_s", "每到一个位置停多久", "seconds")}
                      <div className="field">
                        <GuideOptions
                          label="结束姿态"
                          value={answers.end_behavior}
                          disabled={locked}
                          onChange={(value) =>
                            updateAnswer(
                              "end_behavior",
                              value as IntakeAnswers["end_behavior"],
                            )
                          }
                          options={[
                            {
                              value: "return_start",
                              label: "回到位置 A",
                              description:
                                "只表示回到你填写的位置 A，不等于手臂自然下垂。",
                            },
                            {
                              value: "hold_end",
                              label: "停在位置 B",
                              description: "动作做完后停在你填写的位置 B。",
                            },
                            {
                              value: "custom",
                              label: "停在另一个位置",
                              description:
                                "在下方填写最后的角度；不知道可以先留空。",
                            },
                          ]}
                        />
                        {sourceNote("prd.intake.answers.end_behavior")}
                      </div>
                      {answers.end_behavior === "custom" &&
                        numberField("end_position_rad", "结束角度", "angle")}
                    </>
                  )}
                  {intake.intent === "threshold" &&
                    numberField(
                      "threshold",
                      "达到多少时触发",
                      "scalar",
                      "数值 ≥ 阈值时输出 1，低于时输出 0。",
                    )}
                  {motion &&
                    numberField(
                      "max_velocity_rad_s",
                      "最快每秒转多少",
                      "speed",
                    )}
                  {numberField(
                    "duration_s",
                    intake.intent === "oscillate"
                      ? "预计观察多久"
                      : "本轮观察多久",
                    "seconds",
                  )}
                  {motion &&
                    numberField(
                      "tolerance_rad",
                      "允许多大误差",
                      motion ? "angle" : "scalar",
                      intake.intent === "threshold"
                        ? "归一化数值的测试误差。"
                        : undefined,
                    )}
                </div>
              </>
            )}
            {!intake.motion_plan &&
              (completeAction || motion || intake.intent === "threshold") && (
                <div className="guide-suggestions">
                  <div>
                    <strong>想先填一组参考值？</strong>
                    <p>
                      {motion || action?.related_joints.length
                        ? "普通演示：30°/秒，允许差 2°；"
                        : intake.intent === "threshold" && !completeAction
                          ? "模拟触发值 0.5；"
                          : ""}
                      观察 {completeAction ? 15 : 8} 秒。
                      {intake.intent === "oscillate" && !completeAction
                        ? "往返 3 次，端点不停留。"
                        : ""}
                      只补本组空白，保留已填内容。
                    </p>
                    <small>
                      这是可修改的本机草稿示例，不是实物参数。不会填写目标角度、改变动作步骤或确认未知信息。
                    </small>
                  </div>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={locked}
                    onClick={suggestCommon}
                  >
                    采用本组推荐参数
                  </button>
                </div>
              )}
          </>
        )}
        {step === 2 && intake.schema_version === 2 && intake.details && (
          <PRDDetails
            v5Motion={!!intake.motion_plan}
            step={3}
            completeAction={completeAction}
            details={intake.details}
            answers={answers}
            intent={intake.intent}
            structure={structure}
            angleUnit={angleUnit}
            disabled={locked}
            onChange={(details) => updateIntake({ details })}
          />
        )}
        {step === 3 && (
          <>
            <div data-intake-path="prd.intake.mode" tabIndex={-1}>
              <GuideOptions
                label="这次准备做什么"
                value={intake.mode}
                disabled={locked}
                onChange={(value) =>
                  updateIntake({ mode: value as PRDIntake["mode"] })
                }
                options={[
                  {
                    value: "simulation",
                    label: "先在电脑里验证",
                    description:
                      "推荐从这里开始：受支持的任务可以编译并用模拟设备检查；不接真实电机。",
                    recommended: true,
                  },
                  {
                    value: "hardware_notes",
                    label: "先整理实物资料",
                    description:
                      "记录板子、电机、供电与接线。本轮只保存资料，暂不执行。",
                  },
                ]}
              />
            </div>
            <label className="field">
              <span>为哪种板型编译程序</span>
              <select
                aria-label="目标控制板"
                value={answers.board || ""}
                disabled={locked}
                onChange={(e) =>
                  updateAnswer(
                    "board",
                    (e.target.value || null) as IntakeAnswers["board"],
                  )
                }
              >
                <option value="">还没确定</option>
                {(catalog?.boards?.length
                  ? catalog.boards
                  : [
                      { id: "esp32", label: "ESP32" },
                      { id: "esp32s3", label: "ESP32-S3" },
                    ]
                ).map((board) => (
                  <option key={board.id} value={board.id}>
                    {board.label}
                    {board.id === "esp32s3" ? " · 无实物时可用作编译参考" : ""}
                  </option>
                ))}
              </select>
              <small>
                还没有板子时，推荐先选 ESP32-S3
                作为本机编译参考。已有实物就按实物选，不确定可以留空。这里不能确定具体开发板型号、Flash
                / PSRAM 或接线。
              </small>
              {sourceNote("prd.intake.answers.board")}
            </label>
            {sourceNote("prd.intake.mode")}
            <div className="guide-fact compact">
              <strong>电脑环境和通信由平台提供</strong>
              <p>
                ROS 2
                Humble；串口消息格式；主机虚拟串口测试。确认拆分后，两端会按同一份通信约定生成。
              </p>
              <span className="origin-tag">平台固定设置</span>
            </div>
            <details
              className="guide-extra hardware-notes"
              open={intake.mode === "hardware_notes"}
            >
              <summary>实物资料档案 · 可以先留空</summary>
              <p className="field-hint">
                模拟模式不要求填写电机型号或引脚。有出处只表示资料已提供，不表示驱动已适配或实物验证通过。
              </p>
              {(Object.keys(hardwareNoteLabels) as HardwareNoteKey[]).map(
                (field) => {
                  const note = intake.hardware_notes[field];
                  const patch = (value: string, source: string) =>
                    updateIntake({
                      hardware_notes: {
                        ...intake.hardware_notes,
                        [field]: {
                          value,
                          source,
                          status: !value.trim()
                            ? "unknown"
                            : source.trim()
                              ? "documented"
                              : "provided",
                        },
                      },
                    });
                  return (
                    <div
                      className="hardware-note-row"
                      key={field}
                      data-intake-path={`prd.intake.hardware_notes.${field}`}
                      tabIndex={-1}
                    >
                      <label className="field">
                        <span>
                          {hardwareNoteLabels[field]}{" "}
                          <small>
                            {note.status === "unknown"
                              ? "待补"
                              : note.status === "documented"
                                ? "已填资料出处"
                                : "你填写的，待核对"}
                          </small>
                        </span>
                        <input
                          aria-label={hardwareNoteLabels[field]}
                          maxLength={2000}
                          value={note.value}
                          disabled={locked}
                          onChange={(e) => patch(e.target.value, note.source)}
                          placeholder="不知道先留空，不用猜"
                        />
                      </label>
                      <label className="field">
                        <span>资料出处</span>
                        <input
                          aria-label={`${hardwareNoteLabels[field]}的出处`}
                          maxLength={2000}
                          value={note.source}
                          disabled={locked}
                          onChange={(e) => patch(note.value, e.target.value)}
                          placeholder="手册链接、文件名或实物标签"
                        />
                      </label>
                    </div>
                  );
                },
              )}
            </details>
          </>
        )}
        {step === 3 && intake.schema_version === 2 && intake.details && (
          <PRDDetails
            v5Motion={!!intake.motion_plan}
            step={4}
            completeAction={completeAction}
            details={intake.details}
            answers={answers}
            intent={intake.intent}
            structure={structure}
            angleUnit={angleUnit}
            disabled={locked}
            onChange={(details) => updateIntake({ details })}
          />
        )}
        {step === 4 && (
          <>
            {!!intake.motion_plan && (
              <MotionPlanEditor
                source={motionSource?.record}
                provenance={motionSource?.provenance}
                sourceStale={motionSource?.stale}
                summary
                plan={intake.motion_plan}
                structure={structure}
                request={draft.request}
                disabled={locked}
                onChange={(motion_plan) => updateIntake({ motion_plan })}
              />
            )}
            <div className="guide-choice-intro">
              <strong>先检查动作结果，再看程序能不能运行</strong>
              <p>
                写清做了几次、最后停在哪里、误差允许多少。下面的选项可以帮助你补充检查方式；没有把握的条件保留待确认。
              </p>
            </div>
            <label className="field">
              <span>
                怎样才算完成 <small>保留你的要求</small>
              </span>
              <textarea
                aria-label="怎样才算完成"
                rows={3}
                value={draft.prd.acceptance}
                maxLength={2000}
                disabled={locked}
                onChange={(e) => updateText("acceptance", e.target.value)}
                placeholder="例如：往返三次后回到原位。不要只写‘效果正常’。"
              />
              {sourceNote("prd.acceptance")}
            </label>
            <label className="field">
              <span>
                必须遵守的限制 <small>选填</small>
              </span>
              <textarea
                aria-label="必须遵守的限制"
                rows={2}
                value={draft.prd.constraints}
                maxLength={2000}
                disabled={locked}
                onChange={(e) => updateText("constraints", e.target.value)}
                placeholder="例如：其他关节不动；暂时不连接实物。"
              />
              {sourceNote("prd.constraints")}
            </label>
            {intake.schema_version === 2 && intake.details && (
              <PRDDetails
                v5Motion={!!intake.motion_plan}
                step={5}
                completeAction={completeAction}
                details={intake.details}
                answers={answers}
                intent={intake.intent}
                structure={structure}
                angleUnit={angleUnit}
                disabled={locked}
                onChange={(details) => updateIntake({ details })}
              />
            )}
            <div className="guide-review" aria-live="polite">
              <div
                className={`guide-readiness ${readiness?.status || "checking"}`}
              >
                <strong>
                  {checking
                    ? "正在检查这份需求…"
                    : error
                      ? "暂时无法检查"
                      : readiness?.can_plan
                        ? isPublicDemo ? "可以预览需求摘要；实际生成需在本机核对" : "必要信息已齐，可以交给 AI 拆分"
                        : readiness?.status === "unsupported"
                          ? "这份需求可以保存，当前还不能执行"
                          : "还需要补充一些信息"}
                </strong>
                <p>
                  {error ||
                    readiness?.notice ||
                    "只检查填写内容，不调用 AI，也不启动程序。"}
                </p>
              </div>
              {issues.length > 0 && (
                <section
                  className="readiness-issue-section"
                  aria-label="还需要填写或核对"
                >
                  <h4>还需要填写或核对 · {issues.length} 项</h4>
                  <p>
                    这些是可以补充或需要人工核对的内容。点击按钮会定位到对应位置。
                  </p>
                  <ul className="guide-issues">
                    {issues.map((issue, index) => (
                      <li key={`${issue.path}-${index}`}>
                        <div>
                          <strong>{issue.label}</strong>
                          <p>{issue.message}</p>
                        </div>
                        <button
                          className="text-button"
                          type="button"
                          aria-label={`填写/核对${issue.label}`}
                          onClick={() => goIssue(issue)}
                        >
                          填写 / 核对
                          <PencilSimple size={14} />
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {capabilityIssues.length > 0 && (
                <section
                  className="readiness-issue-section capability-issues"
                  aria-label="当前功能还不支持"
                >
                  <h4>当前功能还不支持 · {capabilityIssues.length} 项</h4>
                  <p>
                    下面说明的是平台现阶段做不到的部分。继续补数值、移除待核对提醒，都不会自动增加这些执行能力；完整需求仍然可以保存。
                  </p>
                  <ul className="guide-issues">
                    {capabilityIssues.map((issue, index) => (
                      <li key={`${issue.path}-${index}`}>
                        <div>
                          <strong>{issue.label}</strong>
                          <p>{issue.message}</p>
                        </div>
                        <button
                          type="button"
                          className="text-button"
                          aria-label={`查看功能限制相关要求：${issue.label}`}
                          onClick={() => goIssue(issue)}
                        >
                          查看相关要求
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {readiness && (
                <>
                  {readiness.detail_coverage && (
                    <DetailCoverage
                      coverage={readiness.detail_coverage}
                      details={intake.details}
                      disabled={locked}
                      onStep={goStep}
                    />
                  )}
                  <dl className="guide-summary">
                    {[
                      ["动作", readiness.summary.action, 0],
                      ["结构与部位", readiness.summary.model, 1],
                      [
                        "硬件与范围",
                        `${readiness.summary.device} · ${readiness.summary.scope}`,
                        3,
                      ],
                      ["完成标准", readiness.summary.criteria, 4],
                    ].map(([label, value, index]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>{value || "还没填写"}</dd>
                        <button
                          className="text-button"
                          onClick={() => goStep(Number(index))}
                          aria-label={`修改${label}`}
                        >
                          <PencilSimple size={15} />
                        </button>
                      </div>
                    ))}
                  </dl>
                  <details className="guide-extra">
                    <summary>
                      查看字段和来源 · {readiness.resolved.length} 项
                    </summary>
                    <div className="guide-sources">
                      {readiness.resolved
                        .filter(
                          (item) =>
                            !item.path.startsWith("prd.intake.details."),
                        )
                        .map((item, index) => (
                          <div key={`${item.path}-${index}`}>
                            <strong>{item.label}</strong>
                            <span>
                              {typeof item.value === "object"
                                ? JSON.stringify(item.value)
                                : String(item.value ?? "待补")}{" "}
                              {item.unit}
                            </span>
                            <small className="origin-tag">
                              {
                                {
                                  user: "你填写的",
                                  model: "结构提供",
                                  platform: "平台设置",
                                  suggested: "已采用建议",
                                }[item.origin]
                              }
                            </small>
                            {item.source_ref && (
                              <small>{item.source_ref}</small>
                            )}
                          </div>
                        ))}
                    </div>
                  </details>
                </>
              )}
            </div>
            <div className="notice">
              <Info size={18} />
              <span>
                资料齐全只表示可以拆分。拆分后还要人工核对 ROS / ESP32
                分工、通信和检查标准，确认后才生成、编译。
              </span>
            </div>
            <details
              className="guide-extra technical-settings"
              data-intake-path="workflow"
              tabIndex={-1}
            >
              <summary>查看工程设置与执行顺序</summary>
              <p className="field-hint">
                这些设置用于受支持的本机任务。修改后也要重新核对，不会让未适配动作自动变成可执行。
              </p>
              <WorkflowEditor
                value={draft.workflow}
                onChange={(workflow) => setDraft({ ...draft, workflow })}
                locked={locked}
                defaultValue={catalog?.default_workflow}
              />
              {manifest ? (
                <ProjectManifest manifest={manifest} stale={manifestStale} />
              ) : (
                <p>保存可执行需求后，后台才会生成对应的工程清单。</p>
              )}
            </details>
          </>
        )}
        {step !== 4 && readiness && (
          <section className="guide-step-note" aria-label="本步待核对清单">
            {issues.some((issue) => issueDestination(issue).step === step) ? (
              <>
                <strong>
                  本步还有{" "}
                  {
                    issues.filter(
                      (issue) => issueDestination(issue).step === step,
                    ).length
                  }{" "}
                  项需要填写或核对
                </strong>
                <ul>
                  {issues
                    .filter((issue) => issueDestination(issue).step === step)
                    .map((issue, index) => (
                      <li key={`${issue.path}-${index}`}>
                        <div>
                          <strong>{issue.label}</strong>
                          <p>{issue.message}</p>
                        </div>
                        <button
                          type="button"
                          className="text-button"
                          aria-label={`去核对：${issue.label}`}
                          onClick={() => goIssue(issue)}
                        >
                          去核对
                        </button>
                      </li>
                    ))}
                </ul>
                <small>
                  可以先保存，之后再补。这份清单不包含平台暂未支持的功能。
                </small>
              </>
            ) : (
              <>
                <strong>本步填写和核对已完成</strong>
                <p>
                  这只表示本步没有待填、待改或待核对项。还需到第 5
                  步查看整份需求和执行范围。
                </p>
              </>
            )}
          </section>
        )}
      </div>
      <footer className="guide-footer">
        <div className="guide-save">
          <button
            className="button secondary"
            disabled={locked || saving}
            onClick={onSave}
          >
            {saving ? (
              <CircleNotch size={16} className="spin" />
            ) : (
              <FloppyDisk size={16} />
            )}
            保存需求
          </button>
          <small>空白项和未支持的动作都能保留</small>
        </div>
        <div className="guide-navigation">
          {step > 0 && (
            <button
              className="button secondary"
              disabled={locked || saving}
              onClick={() => goStep(step - 1)}
            >
              <ArrowLeft size={15} />
              上一步
            </button>
          )}
          {step < 4 ? (
            <button
              className="button primary"
              disabled={locked || saving}
              onClick={() => goStep(step + 1)}
            >
              下一步
              <ArrowRight size={16} />
            </button>
          ) : (
            <button
              className="button primary"
              disabled={locked || saving || !readiness?.can_plan}
              onClick={onPlan}
            >
              {checking ? (
                <CircleNotch size={16} className="spin" />
              ) : (
                <Check size={16} />
              )}
              {isPublicDemo ? "预览分工与核对流程" : "让 AI 拆分"}
            </button>
          )}
        </div>
      </footer>
    </section>
  );
}
