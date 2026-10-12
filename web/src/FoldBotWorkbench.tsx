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
  Check,
  DownloadSimple,
  Info,
  Robot,
  WarningCircle,
} from "@phosphor-icons/react";
import { isPublicDemo } from "./api";
import { useI18n } from "./i18n";
import RequestInput from "./RequestInput";
import FoldBotConsole from "./FoldBotConsole";
import FoldBotSimulation, { FoldBotModelPreview } from "./FoldBotSimulation";
import {
  defaultFoldBotFlow,
  normalizeFoldBotDraftFlow,
  FOLDBOT_SOURCE_WIRING,
  type FoldBotFlowConfig,
} from "./foldbotFlow";
const FoldBotFlash = lazy(() => import("./FoldBotFlash"));
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

const defaults: FoldBotDraft = {
  name: "FoldBot 整机工程",
  request:
    "让折叠机器人展开两块折叠板，用机械臂完成动作，并能在网页中控制履带底盘。",
  drive_level: 10,
  drive_duration_ms: 200,
  workflow: defaultFoldBotFlow(),
};
const storageKey = `ae.foldbot.draft.v1.${isPublicDemo ? "public" : "local"}`;
function readCache(): FoldBotCachedDraft | null {
  try {
    const cached = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (
      cached &&
      typeof cached.draft?.name === "string" &&
      typeof cached.draft?.request === "string" &&
      typeof cached.draft?.drive_level === "number" &&
      typeof cached.draft?.drive_duration_ms === "number"
    ) {
      normalizeFoldBotDraftFlow(cached.draft.workflow);
      return cached;
    }
  } catch {
    /* A storage failure must not prevent editing or downloading. */
  }
  return null;
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
  const { t, locale } = useI18n();
  const [cache] = useState(readCache);
  const [draft, setDraft] = useState<FoldBotDraft>(cache?.draft ?? defaults);
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
          const restored = restoreFoldBotDraft(
            cache,
            projects,
            catalog.defaults,
          );
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
  }, [cache]);

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
  }, [draft, draftBaseline, loading]);

  function updateDraft(patch: Partial<FoldBotDraft>) {
    if (generationLock.current) return;
    const next = { ...draftRef.current, ...patch };
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
  }, []);
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
    if (!project && !cache && editVersion.current === 0) return;
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
      !validateFoldBotDraft(draftRef.current) ||
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
        setStage(3);
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
  const files = generation?.files ?? [];
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
    ? generation
      ? reference?.archive_url
      : null
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
  const stepLabels = [
    t("需求与接线", "Request & wiring"),
    t("控制方案", "Control route"),
    t("仿真预览", "Simulation preview"),
    t("工程代码", "Source project"),
    t("部署与烧录", "Deploy & flash"),
    t("机器人控制", "Robot control"),
  ];
  const blocked = loading || generating || flashBusy;
  const next = () => {
    if (!blocked) setStage(Math.min(5, stage + 1));
  };
  return (
    <section className="foldbot-workbench foldflow">
      <header className="foldflow-heading">
        <div>
          <div className="foldbot-eyebrow">
            <span className="foldbot-square" /> FOLDBOT / AUTO ENGINEERING
          </div>
          <h1>{t("把想法变成机器人动作", "From an idea to a robot action")}</h1>
          <p>
            {t(
              "一台折叠机器人，一份需求，从接线到控制。",
              "One FoldBot. One request. From wiring to control.",
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
        aria-label={t("折叠机器人流程", "FoldBot workflow")}
      >
        {stepLabels.map((label, i) => (
          <button
            type="button"
            key={i}
            disabled={blocked}
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
        <span>FoldBot · Sophicar ESP32-S3</span>
        <span>
          {flow.control === "esp" ? "ESP32 + Web" : `ROS 2 ${flow.ros_version}`}
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
              <h2>{t("想让它做什么？", "What should FoldBot do?")}</h2>
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
                "说一句话，或选一个起点…",
                "Describe an action, or choose a starting point…",
              )}
              overflow={overflow}
              onOverflowChange={setOverflow}
            />
            <div className="foldflow-suggestions">
              {[
                [
                  t("展开与收拢", "Fold & unfold"),
                  t(
                    "展开两块折叠板，完成操作后收拢。",
                    "Unfold both panels, then fold them after the task.",
                  ),
                  "fold-cycle",
                ],
                [
                  t("机械臂动作", "Arm action"),
                  t(
                    "让机械臂按动作组运动，夹爪张开后合拢。",
                    "Move the arm through an action group, then open and close the gripper.",
                  ),
                  "arm-demo",
                ],
                [
                  t("底盘点动", "Chassis drive"),
                  t(
                    "在网页中低速点动履带底盘，松开立即停止。",
                    "Jog the tracked chassis slowly from the web page and stop on release.",
                  ),
                  "chassis-demo",
                ],
              ].map(([label, request, group]) => (
                <button
                  type="button"
                  disabled={blocked}
                  key={group}
                  onClick={() =>
                    updateDraft({
                      request,
                      workflow: {
                        ...flow,
                        action_group:
                          group as FoldBotFlowConfig["action_group"],
                      },
                    })
                  }
                >
                  {label}
                  <ArrowRight size={14} />
                </button>
              ))}
            </div>
            <details className="foldflow-detail">
              <summary>
                {t("查看生成依据与提示词", "Generation basis & prompt")}
              </summary>
              <p>
                {t(
                  "本流程复用已有 FoldBot 整机源码。上方文字保存为需求；动作组先用于视觉预览，不会自动改写标定或电机运动逻辑。",
                  "This flow reuses the existing full FoldBot source. Your text becomes the requirement; action groups are visual previews and do not rewrite calibration or motor logic.",
                )}
              </p>
              <pre>
                {t(
                  "以现有 FoldBot 模板整理需求，保留底盘、双折叠板、六轴机械臂与原网页；不猜测引脚、行程或扭矩。未核对内容标记待确认。",
                  "Use the existing FoldBot template. Keep the chassis, both folding panels, six-joint arm and original web console. Do not invent pins, travel or torque. Mark unresolved information.",
                )}
              </pre>
            </details>
          </section>
          <div className="foldflow-robot-grid">
            <section className="foldbot-card foldflow-model-card">
              <div className="foldflow-section-heading">
                <h2>{t("你的折叠机器人", "Your folding robot")}</h2>
                <span>{t("原版模型", "Original model")}</span>
              </div>
              <FoldBotModelPreview />
              <div className="foldflow-modules">
                <span>{t("履带底盘", "Tracked chassis")}</span>
                <span>{t("双折叠板", "Two panels")}</span>
                <span>{t("六轴机械臂", "Six-joint arm")}</span>
              </div>
            </section>
            <section className="foldbot-card foldflow-wiring">
              <div className="foldflow-section-heading">
                <h2>{t("硬件连接", "Hardware connections")}</h2>
                <span>{t("源码接线图", "Source wiring")}</span>
              </div>
              <div className="foldflow-board">
                Sophicar <strong>ESP32-S3</strong>
                <small>USB · Wi-Fi · GPIO</small>
              </div>
              <div className="foldflow-wires">
                {FOLDBOT_SOURCE_WIRING.map((item) => (
                  <details
                    key={item.id}
                    className={item.id === "chassis" ? "pending" : ""}
                  >
                    <summary>
                      <span className="foldflow-wire-dot" />
                      <strong>
                        {locale === "en" ? item.labelEn : item.label}
                      </strong>
                      <code>{item.pins}</code>
                    </summary>
                    <p>
                      {locale === "en" ? item.connectionEn : item.connection}
                    </p>
                  </details>
                ))}
              </div>
              <p className="foldflow-hardware-note">
                <WarningCircle size={18} />
                {t(
                  "GPIO35–37 与 N16R8 存储器兼容性待现场确认。此图说明源码连接，不代表已验证接线。",
                  "GPIO35–37 / N16R8 memory compatibility needs an on-site check. This diagram describes source connections, not verified wiring.",
                )}
              </p>
              <label className="foldbot-check">
                <input
                  type="checkbox"
                  checked={flow.wiring_reviewed}
                  disabled={blocked}
                  onChange={(e) =>
                    changeFlow({ wiring_reviewed: e.target.checked })
                  }
                />
                <span>
                  {t(
                    "已核对模型与接线来源，待确认项保留在工程中",
                    "Reviewed model and wiring sources; retain unresolved items in the project",
                  )}
                </span>
              </label>
            </section>
          </div>
        </>
      )}
      {stage === 1 && (
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
      {stage === 2 && (
        <FoldBotSimulation
          actionGroup={flow.action_group}
          onActionGroupChange={(group) => changeFlow({ action_group: group })}
        />
      )}
      {stage === 3 && (
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
                    "请先核对第 1 步的模型与接线",
                    "Review the model and wiring in step 1",
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
            </div>
          ) : (
            <div className="foldflow-generate">
              <label className="foldbot-check">
                <input
                  type="checkbox"
                  checked={reviewed}
                  disabled={blocked || !valid || !flow.wiring_reviewed}
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
                  blocked ||
                  !valid ||
                  !reviewed ||
                  !flow.wiring_reviewed ||
                  conflict
                }
                onClick={() => void generate()}
              >
                {generating
                  ? t("正在生成…", "Generating…")
                  : t("生成完整工程", "Generate complete project")}
              </button>
            </div>
          )}
          {generation && (
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
                  <pre
                    tabIndex={0}
                    aria-label={t("文件内容预览", "File contents")}
                  >
                    {previewLoading
                      ? t("正在读取…", "Loading…")
                      : previewError ||
                        preview?.content.slice(0, 24000) ||
                        t(
                          "此文件无文本预览，请下载完整工程。",
                          "No text preview; download the complete project.",
                        )}
                  </pre>
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
          {!generation && (
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
      {stage === 4 && (
        <>
          {flow.control === "ros" && (
            <section className="foldbot-card foldflow-ros">
              <h2>{t("ROS 部署接口", "ROS deployment interface")}</h2>
              <div className="foldflow-fields">
                <p>
                  {t("主机", "Host")}
                  <strong>{flow.ros_host}</strong>
                </p>
                <p>
                  {t("版本", "Version")}
                  <strong>ROS 2 {flow.ros_version}</strong>
                </p>
                <p>
                  {t("通信串口", "Communication port")}
                  <strong>
                    {flow.ros_serial ||
                      (isPublicDemo
                        ? t(
                            "示例 /dev/ttyUSB0（未连接）",
                            "Example /dev/ttyUSB0 (disconnected)",
                          )
                        : t("未指定", "Not specified"))}
                  </strong>
                </p>
              </div>
              <p>
                {t(
                  "下载第 4 步工程，在目标主机按 deployment.md 配置。此处展示 ROS 源码与部署参数；尚未运行 ROS 或通过 ROS 控制实物。ESP32 设备端仍可在下方更新固件。",
                  "Download the step-4 project and follow deployment.md on the target host. This shows ROS source and deployment settings; ROS execution and real control are unverified. ESP32 firmware can still be updated below.",
                )}
              </p>
            </section>
          )}
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
              current={current && !draftDirty && !saving}
            />
          </Suspense>
        </>
      )}
      {stage === 5 && (
        <>
          <div className="foldflow-control-context">
            <Robot size={22} />
            <div>
              <strong>{draft.name}</strong>
              <p>
                {t(
                  "连接 ESP 热点后，在下方原版控制台核验并连接。这里使用板上现有固件，生成源码或预览动作不会自动发送到机器人。",
                  "After joining the ESP hotspot, check and connect in the original console below. It uses the firmware on the board; generated source and visual actions are not automatically sent.",
                )}
              </p>
            </div>
          </div>
          <FoldBotConsole onBack={() => setStage(4)} />
        </>
      )}
      {!valid && (
        <p className="foldflow-stale" role="alert">
          {t(
            "请检查名称、需求、参数范围或串口格式；无效配置不会保存或生成。",
            "Check the name, request, parameter ranges or serial format. Invalid configuration cannot save or generate.",
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
            disabled={stage === 5 || blocked || !valid}
            onClick={next}
          >
            {stage < 5
              ? `${t("下一步", "Next")} · ${stepLabels[stage + 1]}`
              : t("当前为控制步骤", "Control step")}
            <ArrowRight size={18} />
          </button>
        </div>
      </footer>
    </section>
  );
}
