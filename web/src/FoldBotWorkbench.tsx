import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowRight,
  DownloadSimple,
  Info,
  Robot,
  WarningCircle,
} from "@phosphor-icons/react";
import { isPublicDemo } from "./api";
import { useI18n } from "./i18n";
import RequestInput from "./RequestInput";
import FoldBotConsole from "./FoldBotConsole";
import FoldBotSimulation from "./FoldBotSimulation";
import {
  defaultFoldBotFlow,
  normalizeFoldBotDraftFlow,
  type FoldBotFlowConfig,
} from "./foldbotFlow";
const FoldBotFlash = lazy(() => import("./FoldBotFlash"));
const CodeCraftSourceViewer = lazy(() => import("./CodeCraftSourceViewer"));
import "./foldbotFlow.css";
import {
  draftMatchesProject,
  mergeFoldBotSavedCache,
  foldbotApi,
  FoldBotApiError,
  restoreFoldBotDraft,
  validateFoldBotDraft,
  type FoldBotCachedDraft,
  type FoldBotDraft,
  type FoldBotDraftBaseline,
  type FoldBotPreview,
  type FoldBotProject,
  type FoldBotReference,
  type FoldBotTemplate,
} from "./foldbotApi";
import "./foldbot.css";
import ProjectLauncher, {
  readProjectCache,
  type ProjectEntry,
} from "./ProjectLauncher";
import { RequirementSteps, HardwareSelector } from "./GuidedSetup";
import GuidedWiring from "./GuidedWiring";
import {
  defaultGuidedConfig,
  normalizeGuidedConfig,
  guidedRequirementsReady,
  guidedHardwareReady,
  guidedWiringCurrent,
  buildGuidedWiringPreview,
  type GuidedWiringPreview,
  type GuidedConfig,
} from "./guidedFlow";
import "./guidedJourney.css";
import ProjectGraphWorkspace, {
  type GraphWorkspaceView,
} from "./ProjectGraphWorkspace";
import {
  defaultProjectGraphs,
  normalizedWiringKey,
  reconcileGraphsFromForm,
  validateGraphReadiness,
} from "./projectGraphs";
import {
  readEditorLayout,
  graphLayoutKey,
  exportGraphDocument,
  type ProjectEditorLayout,
} from "./projectGraphDocument";

const defaults: FoldBotDraft = {
  name: "新机器人方案",
  request: "",
  drive_level: 10,
  drive_duration_ms: 200,
  workflow: defaultFoldBotFlow(),
  guided: defaultGuidedConfig(),
};
function upgradeDraft(draft: FoldBotDraft): FoldBotDraft {
  return {
    ...draft,
    guided: normalizeGuidedConfig(draft.guided),
    workflow: {
      ...normalizeFoldBotDraftFlow(draft.workflow),
      wiring_reviewed: draft.guided
        ? (draft.workflow?.wiring_reviewed ?? false)
        : false,
    },
  };
}
function downloadText(
  name: string,
  content: string,
  type = "application/json",
) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function FoldBotWorkbench() {
  const [entry, setEntry] = useState<ProjectEntry | null>(null);
  return entry ? (
    <GuidedProjectFlow
      key={entry.cacheKey}
      entry={entry}
      onHome={() => setEntry(null)}
    />
  ) : (
    <ProjectLauncher onOpen={setEntry} />
  );
}
function GuidedProjectFlow({
  entry,
  onHome,
}: {
  entry: ProjectEntry;
  onHome: () => void;
}) {
  const [storageKey, setStorageKey] = useState(entry.cacheKey);
  const { t, locale } = useI18n();
  const [cache] = useState(() =>
    entry.mode === "resume"
      ? readProjectCache(entry.sourceCacheKey ?? storageKey)
      : null,
  );
  const [draft, setDraft] = useState<FoldBotDraft>(() =>
    upgradeDraft(cache?.draft ?? { ...defaults, request: entry.request ?? "" }),
  );
  const [draftBaseline, setDraftBaseline] = useState<FoldBotDraftBaseline>({
    projectId: cache?.projectId ?? null,
    baseRevision: cache?.baseRevision ?? null,
  });
  const draftRef = useRef(draft);
  const [project, setProject] = useState<FoldBotProject | null>(null);
  const projectRef = useRef<FoldBotProject | null>(null);
  const [template, setTemplate] = useState<FoldBotTemplate | null>(null);
  const [reference, setReference] = useState<FoldBotReference | null>(null);
  const [stage, setStage] = useState(0);
  const [graphView, setGraphView] = useState<GraphWorkspaceView>("process");
  const [editorLayout, setEditorLayout] = useState<ProjectEditorLayout>(() =>
    readEditorLayout(entry.sourceCacheKey ?? entry.cacheKey),
  );
  const [layoutError, setLayoutError] = useState(false);
  const layoutStorageOrigin = useRef(entry.sourceCacheKey ?? entry.cacheKey);
  const [graphNavigationMessage, setGraphNavigationMessage] = useState("");
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
    setGraphView((previous) =>
      previous === "form"
        ? previous
        : stage === 1 || stage === 2
          ? "hardware"
          : stage === 0
            ? "process"
            : "form",
    );
    setGraphNavigationMessage("");
  }, [stage]);
  function changeLayout(next: ProjectEditorLayout) {
    setEditorLayout(next);
    try {
      localStorage.setItem(graphLayoutKey(storageKey), JSON.stringify(next));
      setLayoutError(false);
    } catch {
      setLayoutError(true);
    }
  }
  useEffect(() => {
    if (layoutStorageOrigin.current === storageKey) return;
    try {
      localStorage.setItem(
        graphLayoutKey(storageKey),
        JSON.stringify(editorLayout),
      );
      layoutStorageOrigin.current = storageKey;
      setLayoutError(false);
    } catch {
      setLayoutError(true);
    }
  }, [storageKey, editorLayout]);
  const [wiringPreview, setWiringPreview] =
    useState<GuidedWiringPreview | null>(null);
  const [wiringBusy, setWiringBusy] = useState(false);
  const [previewSeen, setPreviewSeen] = useState(false);
  const [deploymentAcknowledged, setDeploymentAcknowledged] = useState(false);
  const [referenceShown, setReferenceShown] = useState(false);
  const [flashBusy, setFlashBusy] = useState(false);
  useEffect(() => {
    const receive = (event: Event) =>
      setFlashBusy((event as CustomEvent).detail?.busy === true);
    window.addEventListener("ae-foldbot-flash-busy", receive);
    return () => window.removeEventListener("ae-foldbot-flash-busy", receive);
  }, []);
  const [reviewed, setReviewed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [conflict, setConflict] = useState(false);
  const conflictRef = useRef(false);
  const [error, setError] = useState("");
  const [storageFailed, setStorageFailed] = useState(false);
  const [overflow, setOverflow] = useState("");
  const [filePath, setFilePath] = useState("");
  const [preview, setPreview] = useState<FoldBotPreview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const alive = useRef(true);
  const editVersion = useRef(0);
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const generationLock = useRef(false);

  useEffect(() => {
    alive.current = true;
    let active = true;
    const initialize = async () => {
      try {
        if (isPublicDemo) {
          const data = await foldbotApi.reference();
          if (!active) return;
          setReference(data);
          setTemplate(data.template);
        } else {
          const [catalog, projects] = await Promise.all([
            foldbotApi.template(),
            foldbotApi.projects(),
          ]);
          if (!active) return;
          const selected =
            entry.mode === "resume"
              ? projects.filter(
                  (p) => p.id === (entry.projectId ?? cache?.projectId),
                )
              : [];
          if (
            entry.mode === "resume" &&
            entry.projectId &&
            !selected.length &&
            !cache
          )
            throw new Error("project_not_found");
          const restored = restoreFoldBotDraft(cache, selected, {
            ...defaults,
            request: entry.request ?? "",
          });
          if (
            entry.copyLegacy ||
            !restored.draft.guided ||
            (selected[0] && !selected[0].guided)
          ) {
            // A legacy snapshot stays untouched; continuing creates an explicit guided copy.
            // The launcher history may still be loading when a cached draft is opened.
            // Allocate a new storage key here too, preserving that source cache.
            if (!entry.copyLegacy)
              setStorageKey(`ae.guided.draft.v1.local.${crypto.randomUUID()}`);
            restored.project = null;
            restored.baseline = { projectId: null, baseRevision: null };
            restored.conflict = false;
          }
          restored.draft = upgradeDraft(restored.draft);
          projectRef.current = restored.project;
          setProject(restored.project);
          setTemplate(catalog);
          draftRef.current = restored.draft;
          setDraft(restored.draft);
          setDraftBaseline(restored.baseline);
          conflictRef.current = restored.conflict;
          setConflict(restored.conflict);
        }
      } catch (cause) {
        if (active)
          setError(cause instanceof Error ? cause.message : "load_failed");
      } finally {
        if (active) setLoading(false);
      }
    };
    void initialize();
    return () => {
      active = false;
      alive.current = false;
    };
  }, [cache, entry]);

  useEffect(() => {
    if (loading) return;
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify({
          draft,
          ...draftBaseline,
        } satisfies FoldBotCachedDraft),
      );
      setStorageFailed(false);
    } catch {
      setStorageFailed(true);
    }
  }, [draft, draftBaseline, loading, storageKey]);

  function updateDraft(patch: Partial<FoldBotDraft>) {
    if (generationLock.current) return;
    const previous = draftRef.current;
    const next = { ...previous, ...patch };
    if (
      patch.guided &&
      !patch.workflow &&
      patch.guided.primary_task !== previous.guided?.primary_task &&
      ["fold-cycle", "arm-demo", "chassis-demo"].includes(
        patch.guided.primary_task,
      )
    )
      next.workflow = {
        ...(previous.workflow ?? defaultFoldBotFlow()),
        action_group: patch.guided
          .primary_task as FoldBotFlowConfig["action_group"],
      };
    const hardwareSelectionChanged =
      patch.guided !== undefined &&
      (patch.guided.robot_choice !== previous.guided?.robot_choice ||
        ["controller", "fold_driver", "arm_bus", "chassis"].some(
          (key) =>
            patch.guided!.hardware[key as keyof GuidedConfig["hardware"]] !==
            previous.guided?.hardware[key as keyof GuidedConfig["hardware"]],
        ));
    if (
      patch.graphs === undefined &&
      patch.guided !== undefined &&
      (previous.graphs !== undefined || hardwareSelectionChanged)
    )
      next.graphs = reconcileGraphsFromForm(previous, next);
    const comparable = (g?: GuidedConfig) =>
      JSON.stringify({
        ...normalizeGuidedConfig(g),
        wiring_binding_sha256: null,
      });
    const wiringChanged =
      (patch.request !== undefined && patch.request !== previous.request) ||
      (patch.guided !== undefined &&
        comparable(patch.guided) !== comparable(previous.guided)) ||
      (previous.graphs === undefined) !== (next.graphs === undefined) ||
      normalizedWiringKey(
        (next.graphs ?? defaultProjectGraphs(next)).wiring,
      ) !==
        normalizedWiringKey(
          (previous.graphs ?? defaultProjectGraphs(previous)).wiring,
        );
    if (wiringChanged) {
      next.guided = {
        ...normalizeGuidedConfig(next.guided),
        wiring_binding_sha256: null,
      };
      next.workflow = {
        ...(next.workflow ?? defaultFoldBotFlow()),
        wiring_reviewed: false,
      };
      setWiringPreview(null);
      setPreviewSeen(false);
    }
    if (patch.graphs !== undefined) setPreviewSeen(false);
    setDeploymentAcknowledged(false);
    setReferenceShown(false);
    editVersion.current++;
    draftRef.current = next;
    setDraft(next);
    setReviewed(false);
  }
  const saveDraft = useCallback((): Promise<FoldBotProject | null> => {
    const operation = saveQueue.current
      .catch(() => undefined)
      .then(async () => {
        if (isPublicDemo || !alive.current || conflictRef.current) return null;
        const snapshot = { ...draftRef.current };
        if (!validateFoldBotDraft(snapshot)) return null;
        const current = projectRef.current;
        if (draftMatchesProject(snapshot, current)) return current;
        setSaving(true);
        try {
          const saved = await foldbotApi.save(snapshot, current);
          // Only server metadata advances. A save reply never replaces newer typed text.
          projectRef.current = saved;
          if (!alive.current) {
            try {
              const cached = JSON.parse(
                localStorage.getItem(storageKey) ?? "null",
              );
              const merged = mergeFoldBotSavedCache(cached, current, saved);
              if (merged)
                localStorage.setItem(storageKey, JSON.stringify(merged));
            } catch {
              /* Keep the existing cached draft when storage is unavailable. */
            }
          }
          if (alive.current) {
            setProject(saved);
            setDraftBaseline({
              projectId: saved.id,
              baseRevision: saved.revision,
            });
            setError("");
          }
          return saved;
        } catch (cause) {
          if (alive.current) {
            if (cause instanceof FoldBotApiError && cause.status === 409) {
              conflictRef.current = true;
              setConflict(true);
            }
            setError(cause instanceof Error ? cause.message : "save_failed");
          }
          throw cause;
        } finally {
          if (alive.current) setSaving(false);
        }
      });
    saveQueue.current = operation;
    return operation;
  }, [storageKey]);
  useEffect(() => {
    if (
      isPublicDemo ||
      loading ||
      conflict ||
      generating ||
      !validateFoldBotDraft(draft) ||
      draftMatchesProject(draft, project)
    )
      return;
    // Untouched defaults remain a draft until the user edits or explicitly generates.
    if (editVersion.current === 0) return;
    const timer = setTimeout(() => {
      void saveDraft().catch(() => undefined);
    }, 650);
    return () => clearTimeout(timer);
  }, [draft, project, loading, conflict, generating, cache, saveDraft]);

  async function generate() {
    if (
      isPublicDemo ||
      generationLock.current ||
      !reviewed ||
      !draftRef.current.workflow?.wiring_reviewed ||
      !guidedWiringCurrent(draftRef.current, wiringPreview) ||
      !validateFoldBotDraft(draftRef.current) ||
      validateGraphReadiness(
        draftRef.current.graphs ?? defaultProjectGraphs(draftRef.current),
      ).length > 0 ||
      conflictRef.current
    )
      return;
    generationLock.current = true;
    setGenerating(true);
    setError("");
    try {
      const saved = await saveDraft();
      if (!saved || !alive.current) return;
      const generated = await foldbotApi.generate(saved);
      projectRef.current = generated;
      if (alive.current) {
        setProject(generated);
        setStage(4);
      }
    } catch (cause) {
      if (alive.current)
        setError(cause instanceof Error ? cause.message : "generation_failed");
    } finally {
      generationLock.current = false;
      if (alive.current) setGenerating(false);
    }
  }

  const shownProject = isPublicDemo ? (reference?.project ?? null) : project;
  const generation = shownProject?.generation;
  const files = (generation?.files ?? []).filter(
    (file) =>
      !isPublicDemo ||
      (draft.workflow?.control === "ros"
        ? !file.path.startsWith("firmware/")
        : !file.path.startsWith("ros2/")),
  );
  const current =
    !!project?.generation &&
    project.reviewed &&
    project.generation.revision === project.revision &&
    draftMatchesProject(draft, project) &&
    !conflict;
  const selectedPath = files.some((file) => file.path === filePath)
    ? filePath
    : (files[0]?.path ?? "");
  useEffect(() => {
    let active = true;
    setPreview(null);
    setPreviewError("");
    if (!selectedPath || !shownProject?.id) {
      setPreviewLoading(false);
      return;
    }
    if (isPublicDemo) {
      setPreview(reference?.previews[selectedPath] ?? null);
      setPreviewLoading(false);
      return;
    }
    setPreviewLoading(true);
    void foldbotApi
      .file(shownProject.id, selectedPath)
      .then((data) => {
        if (active) setPreview(data);
      })
      .catch((cause) => {
        if (active)
          setPreviewError(
            cause instanceof Error ? cause.message : "preview_failed",
          );
      })
      .finally(() => {
        if (active) setPreviewLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selectedPath, shownProject?.id, generation?.id, reference]);

  const valid = validateFoldBotDraft(draft);
  const draftDirty = !draftMatchesProject(draft, project);
  const downloadDraft = () =>
    downloadText(
      "foldbot-prd-draft.json",
      JSON.stringify(
        {
          kind: "foldbot_prd_draft",
          status: "draft_only",
          generated: false,
          hardware_verified: false,
          ...draftRef.current,
        },
        null,
        2,
      ),
    );
  const status = isPublicDemo
    ? t("浏览器草稿", "Browser draft")
    : saving
      ? t("正在保存…", "Saving…")
      : loading
        ? t("正在读取…", "Loading…")
        : draftDirty
          ? t("草稿待保存", "Draft changes")
          : `${t("已保存修订", "Saved revision")} ${project?.revision ?? "—"}`;
  const exportUrl = isPublicDemo
    ? null
    : shownProject && current && !generating && !saving
      ? foldbotApi.exportUrl(shownProject.id)
      : null;
  // Reference downloads are same-site static files only, never hardware/API URLs.
  const safeExport =
    exportUrl &&
    (!isPublicDemo || /^(?:\.\/)?[a-zA-Z0-9_.-]+\.zip$/.test(exportUrl))
      ? exportUrl
      : null;

  const flow = draft.workflow ?? defaultFoldBotFlow();
  const changeFlow = (patch: Partial<FoldBotFlowConfig>) =>
    updateDraft({ workflow: { ...flow, ...patch } });
  const guided = normalizeGuidedConfig(draft.guided);
  const graphIssues = validateGraphReadiness(
    draft.graphs ?? defaultProjectGraphs(draft),
  );
  const wiringGraphReady = !graphIssues.some(
    (issue) => issue.scope === "wiring",
  );
  const processGraphReady = !graphIssues.some(
    (issue) => issue.scope === "behavior",
  );
  const requirementsReady = valid && guidedRequirementsReady(draft);
  const hardwareReady = requirementsReady && guidedHardwareReady(guided);
  const wiringReady =
    hardwareReady &&
    wiringGraphReady &&
    processGraphReady &&
    flow.wiring_reviewed &&
    guidedWiringCurrent(draft, wiringPreview);
  const codeReady =
    wiringReady && (isPublicDemo ? referenceShown && !!generation : current);
  const stepLabels = [
    t("说明需求", "Describe"),
    t("选择硬件", "Hardware"),
    t("生成接线", "Wiring"),
    t("仿真预览", "Preview"),
    t("生成程序", "Program"),
    t("部署程序", "Deploy"),
    t("机器人控制", "Control"),
  ];
  const canVisit = [
    true,
    requirementsReady && processGraphReady,
    hardwareReady && processGraphReady,
    wiringReady,
    wiringReady && (previewSeen || current),
    codeReady,
    codeReady && deploymentAcknowledged,
  ];
  const blocked = loading || generating || flashBusy || wiringBusy;
  const next = () => {
    if (!blocked && canVisit[stage + 1]) setStage(Math.min(6, stage + 1));
  };
  useEffect(() => {
    if (stage === 3) setPreviewSeen(true);
  }, [stage]);
  // Recover only a previously bound plan, never generate/confirm it on first entry.
  useEffect(() => {
    if (!template || !draft.guided?.wiring_binding_sha256) return;
    let active = true;
    void buildGuidedWiringPreview(draft, template)
      .then((plan) => {
        if (active && guidedWiringCurrent(draft, plan)) setWiringPreview(plan);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [template, draft.guided?.wiring_binding_sha256, draft.request]);
  async function generateWiring() {
    if (
      !hardwareReady ||
      !wiringGraphReady ||
      !processGraphReady ||
      blocked ||
      !template
    )
      return;
    const snapshot = draftRef.current;
    const version = editVersion.current;
    setWiringBusy(true);
    setError("");
    try {
      const plan = isPublicDemo
        ? await buildGuidedWiringPreview(snapshot, template)
        : await foldbotApi.wiringPreview(snapshot);
      if (!alive.current || editVersion.current !== version) return;
      updateDraft({
        guided: {
          ...normalizeGuidedConfig(snapshot.guided),
          wiring_binding_sha256: plan.binding_sha256,
        },
        workflow: {
          ...(snapshot.workflow ?? defaultFoldBotFlow()),
          wiring_reviewed: false,
        },
      });
      setWiringPreview(plan);
    } catch (cause) {
      if (alive.current)
        setError(cause instanceof Error ? cause.message : "wiring_failed");
    } finally {
      if (alive.current) setWiringBusy(false);
    }
  }
  function changeGuided(value: GuidedConfig) {
    const task = value.primary_task;
    updateDraft({
      guided: value,
      workflow: {
        ...flow,
        wiring_reviewed: false,
        action_group:
          task === "unselected" || task === "custom" ? flow.action_group : task,
      },
    });
  }
  return (
    <section className="foldbot-workbench foldflow guided-journey">
      <header className="foldflow-heading">
        <div>
          <div className="foldbot-eyebrow">
            <span className="foldbot-square" /> AUTO ENGINEERING / PROJECT
          </div>
          <button
            className="ae-back-entry"
            disabled={blocked || saving}
            onClick={onHome}
          >
            {t("← 返回工程入口", "← Back to projects")}
          </button>
          <h1>{stepLabels[stage]}</h1>
          <p>
            {t(
              "先说明需求，再一步步完成你的方案。",
              "Shape the requirement, then build your solution step by step.",
            )}
          </p>
        </div>
        <div className="foldflow-summary">
          <span className="foldflow-dot" />
          {isPublicDemo
            ? t("分享体验 · 无硬件连接", "Shared preview · no hardware")
            : t("本机工作台", "Local workbench")}
          <small role="status">{status}</small>
        </div>
      </header>
      <nav
        className="foldflow-steps"
        aria-label={t("机器人开发流程", "Robot development workflow")}
      >
        {stepLabels.map((label, i) => (
          <button
            type="button"
            key={i}
            disabled={blocked || !canVisit[i]}
            onClick={() => setStage(i)}
            className={stage === i ? "active" : ""}
            aria-current={stage === i ? "step" : undefined}
          >
            <span>{String(i + 1).padStart(2, "0")}</span>
            {label}
          </button>
        ))}
      </nav>
      <div className="foldflow-context">
        <span>{draft.name}</span>
        <span>
          {guided.robot_choice === "foldbot"
            ? t("折叠机器人方案", "Folding robot")
            : t("需求草稿", "Requirement draft")}
        </span>
        <span>
          {t("配置随需求自动保存", "Configuration autosaves with the request")}
        </span>
      </div>
      {flashBusy && (
        <div className="foldbot-notice warning" role="status">
          {t(
            "USB 会话正在使用中。请先在烧录面板断开串口，再切换页面。",
            "USB session active. Disconnect in the flash panel before navigating.",
          )}
        </div>
      )}
      {error && (
        <div className="foldbot-notice warning" role="alert">
          <WarningCircle size={22} />
          <p>
            {t(
              "操作未完成，当前草稿保留：",
              "Action did not finish; draft retained: ",
            )}
            {error}
          </p>
        </div>
      )}
      {storageFailed && (
        <div className="foldbot-notice warning">
          <p>
            {t(
              "浏览器暂存失败，离开前请下载草稿。",
              "Browser storage failed. Download the draft before leaving.",
            )}
          </p>
          <button className="button secondary" onClick={downloadDraft}>
            {t("下载草稿", "Download draft")}
          </button>
        </div>
      )}
      {conflict && (
        <div className="foldbot-notice warning">
          <p>
            {t(
              "服务器版本已经变化，自动保存已暂停。",
              "Server revision changed. Autosave paused.",
            )}
          </p>
          <button
            className="button secondary"
            onClick={() => {
              conflictRef.current = false;
              setConflict(false);
              projectRef.current = null;
              setProject(null);
              setDraftBaseline({ projectId: null, baseRevision: null });
              setReviewed(false);
              setError("");
              editVersion.current++;
            }}
          >
            {t("保留输入，另存新工程", "Keep inputs as a new project")}
          </button>
        </div>
      )}
      {stage === 0 && (
        <>
          <section className="foldbot-card foldflow-request">
            <div className="foldflow-section-heading">
              <h2>{t("先说说你的想法", "Tell us your idea")}</h2>
              <label className="foldflow-project-name">
                {t("工程", "Project")}
                <input
                  aria-label={t("工程名称", "Project name")}
                  value={draft.name}
                  maxLength={120}
                  disabled={blocked}
                  onChange={(e) => updateDraft({ name: e.target.value })}
                />
              </label>
            </div>
            <RequestInput
              value={draft.request}
              onChange={(request) => updateDraft({ request })}
              disabled={blocked}
              rows={3}
              placeholder={t(
                "你想制作什么，希望它完成什么？",
                "What would you like to build, and what should it do?",
              )}
              overflow={overflow}
              onOverflowChange={setOverflow}
            />
            <details className="foldflow-detail">
              <summary>
                {t("查看整理依据与提示词", "View guidance and prompt")}
              </summary>
              <p>
                {t(
                  "按你的描述逐项确认机器人、功能与硬件。当前引导使用固定问答与现有模板；不会把未实现的能力写成已完成。",
                  "Confirm robot, task and hardware from your description. This guide uses structured questions and existing templates; it does not claim unsupported capabilities.",
                )}
              </p>
              <pre>
                {t(
                  "保留用户需求原文；询问机器人类型、主要任务、预期效果与硬件组合。未知型号保留待适配，不猜测引脚、标定或扭矩。",
                  "Keep the original request. Ask about robot type, task, expected outcome and hardware. Mark unknown models for adaptation; do not invent pins, calibration or torque.",
                )}
              </pre>
            </details>
          </section>
          {graphView === "form" && (
            <RequirementSteps
              request={draft.request}
              value={guided}
              onChange={changeGuided}
              disabled={blocked}
            />
          )}
        </>
      )}
      <ProjectGraphWorkspace
        draft={draft}
        layout={editorLayout}
        view={graphView}
        disabled={blocked}
        onViewChange={setGraphView}
        onDraftPatch={updateDraft}
        onGraphsChange={(graphs) => updateDraft({ graphs })}
        onLayoutChange={changeLayout}
        onOpenStage={(index) => {
          if (!blocked && canVisit[index]) {
            setStage(index);
            setGraphNavigationMessage("");
          } else
            setGraphNavigationMessage(
              t(
                "请先补齐前面的需求、连接和核对。可以继续在画布里修改参数。",
                "Complete the earlier requirements, connections and reviews first. You can keep editing node parameters here.",
              ),
            );
        }}
        onExport={() =>
          downloadText(
            "ae-canvas-project.json",
            JSON.stringify(
              exportGraphDocument(draftRef.current, editorLayout),
              null,
              2,
            ),
          )
        }
      />
      {layoutError && (
        <p className="foldbot-notice warning" role="status">
          {t(
            "布局暂存失败，请导出工程 JSON 保留画布位置。",
            "Layout storage failed. Export the project JSON to keep node positions.",
          )}
        </p>
      )}
      {graphNavigationMessage && (
        <p className="foldbot-notice warning" role="status">
          {graphNavigationMessage}
        </p>
      )}
      {graphIssues.length > 0 && (draft.graphs || stage > 0) && (
        <details className="foldbot-notice warning graph-pending-issues">
          <summary>
            {t(
              `画布还有 ${graphIssues.length} 项待补齐，可继续编辑并自动保存`,
              `${graphIssues.length} canvas items remain; continue editing and autosaving`,
            )}
          </summary>
          <ul>
            {graphIssues.map((issue, index) => (
              <li key={index}>{t(issue.message, issue.messageEn)}</li>
            ))}
          </ul>
        </details>
      )}
      {stage === 1 && graphView === "form" && (
        <HardwareSelector
          value={guided}
          onChange={changeGuided}
          disabled={blocked}
        />
      )}
      {stage === 2 && (
        <>
          <section className="foldbot-card guided-wiring-placeholder">
            <h2>{t("把选好的硬件连起来", "Connect your selected hardware")}</h2>
            <p>
              {t(
                "根据已确认的需求与现有组合整理接线。先看清信号线和引脚，再继续模型预览。",
                "Create a wiring proposal for your confirmed requirements and hardware. Review signals and pins before moving to the model preview.",
              )}
            </p>
            <button
              className="button primary"
              disabled={
                blocked ||
                !hardwareReady ||
                !wiringGraphReady ||
                !processGraphReady
              }
              onClick={() => void generateWiring()}
            >
              {wiringBusy
                ? t("正在整理接线…", "Preparing wiring…")
                : wiringPreview
                  ? t("重新生成接线方案", "Regenerate wiring")
                  : t("生成硬件接线方案", "Create wiring proposal")}
            </button>
          </section>
          {wiringPreview && guidedWiringCurrent(draft, wiringPreview) && (
            <GuidedWiring
              preview={wiringPreview}
              reviewed={flow.wiring_reviewed}
              disabled={blocked}
              onReviewedChange={(wiring_reviewed) =>
                changeFlow({ wiring_reviewed })
              }
            />
          )}
        </>
      )}
      {stage === 3 && (
        <FoldBotSimulation
          actionGroup={flow.action_group}
          onActionGroupChange={(group) => changeFlow({ action_group: group })}
        />
      )}
      {stage === 4 && (
        <section className="foldbot-card">
          <div className="foldflow-section-heading">
            <div>
              <h2>{t("选择控制方案", "Choose a control route")}</h2>
              <p>
                {t(
                  "硬件保持同一台 FoldBot，选择代码与部署的入口。",
                  "Keep the same FoldBot; choose the source and deployment route.",
                )}
              </p>
            </div>
          </div>
          <div className="foldflow-route-grid">
            {(["esp", "ros"] as const).map((route) => (
              <button
                type="button"
                disabled={blocked}
                aria-pressed={flow.control === route}
                className={flow.control === route ? "selected" : ""}
                key={route}
                onClick={() => changeFlow({ control: route })}
              >
                <span>{route === "esp" ? "01 / MCU" : "02 / HOST"}</span>
                <h3>{route === "esp" ? "ESP32 + Web" : "ROS 2"}</h3>
                <p>
                  {route === "esp"
                    ? t(
                        "生成完整 ESP32 工程，用 USB 更新固件，再连接热点控制。",
                        "Generate full ESP32 source, update firmware over USB, then control through its hotspot.",
                      )
                    : t(
                        "生成 ROS 演示源码和部署配置，保留 ESP32 作为设备端。",
                        "Generate ROS demonstration source and deployment configuration, keeping ESP32 as the device.",
                      )}
                </p>
                <strong>
                  {flow.control === route
                    ? t("已选择", "Selected")
                    : t("选择方案", "Select route")}
                </strong>
              </button>
            ))}
          </div>
          {flow.control === "ros" && (
            <div className="foldflow-fields">
              <label>
                {t("部署主机", "Deployment host")}
                <select
                  value={flow.ros_host}
                  onChange={(e) =>
                    changeFlow({
                      ros_host: e.target.value as FoldBotFlowConfig["ros_host"],
                    })
                  }
                >
                  <option value="local">{t("本机", "This computer")}</option>
                  <option value="jetson">Jetson</option>
                  <option value="raspberrypi">Raspberry Pi</option>
                </select>
              </label>
              <label>
                {t("ROS 版本目标", "ROS target version")}
                <select
                  value={flow.ros_version}
                  onChange={(e) =>
                    changeFlow({
                      ros_version: e.target
                        .value as FoldBotFlowConfig["ros_version"],
                    })
                  }
                >
                  <option value="humble">ROS 2 Humble</option>
                  <option value="jazzy">ROS 2 Jazzy</option>
                </select>
              </label>
              <label>
                {t("通信串口（可选）", "Communication serial port (optional)")}
                <input
                  value={flow.ros_serial}
                  placeholder="COM3 / /dev/ttyUSB0"
                  maxLength={120}
                  onChange={(e) => changeFlow({ ros_serial: e.target.value })}
                />
                <small>
                  {t(
                    "仅配置，未连接。现有 FoldBot 控制使用 Wi-Fi。",
                    "Configuration only, disconnected. Existing FoldBot control uses Wi-Fi.",
                  )}
                </small>
              </label>
            </div>
          )}
          <details className="foldflow-detail">
            <summary>
              {t("点动参数与部署说明", "Jog settings & deployment details")}
            </summary>
            <div className="foldflow-fields">
              <label>
                {t("底盘驱动档位", "Chassis drive level")}
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={draft.drive_level}
                  onChange={(e) =>
                    updateDraft({ drive_level: Number(e.target.value) })
                  }
                />
              </label>
              <label>
                {t("单次点动时长（毫秒）", "Jog duration (ms)")}
                <input
                  type="number"
                  min={1}
                  max={2000}
                  value={draft.drive_duration_ms}
                  onChange={(e) =>
                    updateDraft({ drive_duration_ms: Number(e.target.value) })
                  }
                />
              </label>
            </div>
            <p>
              {t(
                "档位不代表实测速度。ROS 程序部署到电脑或 Jetson，不通过 COM 口烧录；串口可作为通信参数。主机与 ROS 版本选择不是环境已验证。",
                "Drive level is not measured speed. ROS software is deployed to a computer or Jetson, not flashed through a COM port. A serial port can be a communication setting; selecting a host/version does not verify the environment.",
              )}
            </p>
          </details>
        </section>
      )}
      {stage === 4 && (
        <section className="foldbot-card foldflow-code">
          <div className="foldflow-section-heading">
            <div>
              <h2>
                {t(
                  "生成属于这份需求的工程",
                  "Generate a project for this request",
                )}
              </h2>
              <p>
                {t(
                  "需求、接线来源、动作组选择和部署配置记录在同一修订。",
                  "The request, wiring sources, action group selection and deployment configuration share one revision.",
                )}
              </p>
            </div>
            <span>{flow.control === "esp" ? "ESP32" : "ROS 2"}</span>
          </div>
          <div className="foldflow-code-summary">
            <strong>{draft.name}</strong>
            <p>{draft.request}</p>
            <span>
              {flow.wiring_reviewed
                ? t("接线来源已核对", "Wiring sources reviewed")
                : t(
                    "请先核对第 3 步的模型与接线",
                    "Review the model and wiring in step 3",
                  )}
            </span>
          </div>
          {isPublicDemo ? (
            <div className="foldbot-notice">
              <Info size={20} />
              <p>
                {t(
                  "以下为已有参考工程，不是用当前草稿新生成的源码。可下载当前配置，在本机继续生成。",
                  "The files below are an existing reference, not newly generated from your draft. Download your configuration to continue locally.",
                )}
              </p>
              <button
                className="button primary"
                onClick={() => setReferenceShown(true)}
              >
                {t("查看所选方案参考程序", "View selected route reference")}
              </button>
            </div>
          ) : (
            <div className="foldflow-generate">
              <label className="foldbot-check">
                <input
                  type="checkbox"
                  checked={reviewed}
                  disabled={blocked || !valid || !wiringReady}
                  onChange={(e) => setReviewed(e.target.checked)}
                />
                {t(
                  "按当前需求、配置和待确认项生成源码",
                  "Generate source with the current request, configuration and unresolved items",
                )}
              </label>
              <button
                className="button primary"
                disabled={
                  blocked || !valid || !reviewed || !wiringReady || conflict
                }
                onClick={() => void generate()}
              >
                {generating
                  ? t("正在生成…", "Generating…")
                  : t("生成所选程序", "Generate selected program")}
              </button>
            </div>
          )}
          {generation && (!isPublicDemo || referenceShown) && (
            <>
              <div className="foldbot-evidence">
                <span className="source">
                  {t("源码已生成", "Source generated")}
                </span>
                <span>{t("构建待验证", "Build unverified")}</span>
                <span>{t("ROS 未运行", "ROS not executed")}</span>
                <span>{t("实物未验收", "Hardware unverified")}</span>
              </div>
              <p>
                {isPublicDemo
                  ? t("参考修订", "Reference revision")
                  : t("生成修订", "Generated revision")}{" "}
                {generation.revision} · {files.length} {t("个文件", "files")}
                {!isPublicDemo && !current && (
                  <strong className="foldflow-stale">
                    {" "}
                    ·{" "}
                    {t("需求已变化，请重新生成", "Request changed; regenerate")}
                  </strong>
                )}
              </p>
              <div className="foldbot-file-browser">
                <div
                  className="foldbot-file-tree"
                  aria-label={t("工程文件", "Project files")}
                >
                  {files.map((file) => (
                    <button
                      type="button"
                      key={file.path}
                      className={selectedPath === file.path ? "active" : ""}
                      onClick={() => setFilePath(file.path)}
                    >
                      <code>{file.path}</code>
                      <small>
                        {file.type} · {file.bytes} B
                      </small>
                    </button>
                  ))}
                </div>
                <div className="foldbot-code-preview">
                  <div className="foldflow-file-title">
                    <code>{selectedPath}</code>
                    {preview && (
                      <button
                        className="button secondary"
                        onClick={() =>
                          downloadText(
                            preview.path.split("/").at(-1) ?? "source.txt",
                            preview.content,
                            "text/plain;charset=utf-8",
                          )
                        }
                      >
                        <DownloadSimple size={16} />
                        {t("下载文件", "Download file")}
                      </button>
                    )}
                  </div>
                  <p>{files.find((f) => f.path === selectedPath)?.purpose}</p>
                  {previewLoading || previewError || !preview ? (
                    <p role="status">
                      {previewLoading
                        ? t("正在读取…", "Loading…")
                        : previewError ||
                          t(
                            "此文件无文本预览，请下载完整工程。",
                            "No text preview; download the complete project.",
                          )}
                    </p>
                  ) : (
                    <Suspense
                      fallback={<pre tabIndex={0}>{preview.content}</pre>}
                    >
                      <CodeCraftSourceViewer
                        path={preview.path}
                        content={preview.content}
                      />
                    </Suspense>
                  )}
                  {preview && (
                    <small className="foldflow-hash">
                      SHA-256 {preview.sha256}
                    </small>
                  )}
                </div>
              </div>
              <details className="foldflow-detail">
                <summary>
                  {t(
                    "文件来源、构建与版本说明",
                    "Sources, build & revision details",
                  )}
                </summary>
                <p>
                  {t(
                    "当前复用完整整机模板，生成不是从文字自动编写新的运动控制器。动作预览不会被当作实机动作下发。",
                    "The current generator reuses the full robot template. It does not write a new motion controller from text or transmit visual previews as physical actions.",
                  )}
                </p>
                <code className="foldflow-hash">{generation.sha256}</code>
                {(
                  generation.source_provenance ??
                  template?.source_provenance ??
                  []
                ).map((source) => (
                  <p key={source.path}>
                    {source.path}
                    <code className="foldflow-hash">
                      {source.sanitized_sha256}
                    </code>
                  </p>
                ))}
              </details>
            </>
          )}
          {(!generation || (isPublicDemo && !referenceShown)) && (
            <p className="foldflow-empty">
              {t(
                "完成上方核对后，文件名、类型、用途与目录会显示在这里。",
                "After review, generated filenames, types, purposes and directories will appear here.",
              )}
            </p>
          )}
          {safeExport && (
            <a className="button secondary" href={safeExport} download>
              <DownloadSimple size={18} />
              {isPublicDemo
                ? t("下载参考工程 ZIP", "Download reference ZIP")
                : t("下载当前工程 ZIP", "Download current project ZIP")}
            </a>
          )}
        </section>
      )}

      {stage === 5 && (
        <>
          {flow.control === "ros" ? (
            <section className="foldbot-card foldflow-ros">
              <h2>{t("ROS 部署说明", "ROS deployment guide")}</h2>
              <div className="foldflow-fields">
                <p>
                  {t("目标主机", "Target host")}
                  <strong>{flow.ros_host}</strong>
                </p>
                <p>
                  {t("版本", "Version")}
                  <strong>ROS 2 {flow.ros_version}</strong>
                </p>
                <p>
                  {t("通信串口（配置）", "Serial port (configuration)")}
                  <strong>
                    {flow.ros_serial || t("未指定", "Not specified")}
                  </strong>
                </p>
              </div>
              <p>
                {t(
                  "所选 ROS 工程提供源码与部署参数演示，按工程中的 deployment.md 在目标主机配置。ROS 不通过 COM 口烧录到 ESP32；折叠机器人 ROS 实机控制尚未完成。",
                  "The selected ROS project demonstrates source and deployment settings. Follow deployment.md on the target host. ROS is not flashed onto ESP32 over COM; real FoldBot ROS control is not yet implemented.",
                )}
              </p>
            </section>
          ) : (
            <Suspense
              fallback={
                <p>{t("正在加载 USB 烧录工具…", "Loading USB flasher…")}</p>
              }
            >
              <FoldBotFlash
                projectId={project?.id ?? null}
                revision={project?.revision ?? null}
                generationId={project?.generation?.id ?? null}
                sourceHash={project?.generation?.sha256 ?? null}
                current={current && wiringReady && !draftDirty && !saving}
              />
            </Suspense>
          )}
          <section className="foldbot-card guided-complete-choice">
            <h2>{t("下一步：机器人控制", "Next: robot control")}</h2>
            <p>
              {flow.control === "ros"
                ? t(
                    "下一步查看控制接入状态，当前 ROS 路线仅演示。",
                    "Continue to the control integration status; the ROS route is demonstration only.",
                  )
                : isPublicDemo
                  ? t(
                      "分享版可以查看原版控制台，设备保持未连接。",
                      "The shared version previews the original console with the device disconnected.",
                    )
                  : t(
                      "烧录完成或沿用已核对的板上固件后，可进入控制台。连接与运动仍由你手动操作。",
                      "After flashing, or when reusing verified firmware already on the board, continue to the console. Connection and motion remain manual.",
                    )}
            </p>
            <label className="foldbot-check">
              <input
                type="checkbox"
                checked={deploymentAcknowledged}
                disabled={blocked}
                onChange={(e) => setDeploymentAcknowledged(e.target.checked)}
              />
              {flow.control === "ros"
                ? t(
                    "已阅读 ROS 部署与接入状态",
                    "I have reviewed the ROS deployment status",
                  )
                : isPublicDemo
                  ? t("继续查看离线控制台", "Continue to the offline console")
                  : t(
                      "我会使用板上现有固件，并在连接前核对版本",
                      "I will use the firmware on the board and check its version before connecting",
                    )}
            </label>
          </section>
        </>
      )}
      {stage === 6 &&
        (flow.control === "ros" ? (
          <section className="foldbot-card">
            <h2>{t("ROS 控制待接入", "ROS control pending")}</h2>
            <p>
              {t(
                "本工程已展示 ROS 源码与部署配置。真实 ROS 运动控制尚未完成；需要使用现有网页控制时，请回到第 5 步选择 ESP32 + Web 并重新生成。",
                "This project demonstrates ROS source and deployment configuration. Real ROS motion control is pending. To use the existing web console, return to step 5, select ESP32 + Web and regenerate.",
              )}
            </p>
          </section>
        ) : (
          <>
            <div className="foldflow-control-context">
              <Robot size={22} />
              <div>
                <strong>{draft.name}</strong>
                <p>
                  {t(
                    "连接 ESP 热点，在下方核对板上版本后手动连接。预览动作不会自动发送到实物。",
                    "Join the ESP hotspot, check the board firmware below, then connect manually. Preview actions are never automatically sent to hardware.",
                  )}
                </p>
              </div>
            </div>
            <FoldBotConsole onBack={() => setStage(5)} />
          </>
        ))}
      {!valid && (
        <p className="foldflow-stale" role="alert">
          {t(
            "请检查名称、需求、参数范围或串口格式；无效配置不会保存或生成。",
            "Check the name, request, parameter ranges or serial format. Invalid configuration cannot save or generate.",
          )}
        </p>
      )}
      {stage < 6 && !canVisit[stage + 1] && (
        <p className="guided-stage-hint" role="status">
          {stage === 0
            ? t(
                "请补齐上方三个问题，再选择硬件。",
                "Complete the three questions above to select hardware.",
              )
            : stage === 1
              ? t(
                  "请选齐已适配组合；其他硬件可保存，完成适配后再生成接线。",
                  "Select the supported combination. Other hardware can be saved and adapted before wiring generation.",
                )
              : stage === 2
                ? t(
                    "先生成接线方案并核对，再继续。",
                    "Create and review a wiring proposal to continue.",
                  )
                : stage === 4
                  ? t(
                      "先生成当前方案的程序，再进入部署。",
                      "Generate the current program before deployment.",
                    )
                  : t(
                      "完成本步骤后即可继续。",
                      "Complete this step to continue.",
                    )}
        </p>
      )}
      <footer className="foldflow-footer">
        <button
          className="button secondary"
          disabled={blocked}
          onClick={downloadDraft}
        >
          <DownloadSimple size={18} />
          {t("下载需求 JSON", "Download request JSON")}
        </button>
        <div>
          <button
            className="button secondary"
            disabled={stage === 0 || blocked}
            onClick={() => setStage(stage - 1)}
          >
            {t("上一步", "Back")}
          </button>
          <button
            className="button primary"
            disabled={stage === 6 || blocked || !canVisit[stage + 1]}
            onClick={next}
          >
            {stage < 6
              ? `${t("下一步", "Next")} · ${stepLabels[stage + 1]}`
              : t("当前为控制步骤", "Control step")}
            <ArrowRight size={18} />
          </button>
        </div>
      </footer>
    </section>
  );
}
