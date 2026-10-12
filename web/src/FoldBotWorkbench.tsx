import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  Code,
  DownloadSimple,
  FileCode,
  FolderOpen,
  Info,
  Robot,
  ShieldCheck,
  WarningCircle,
} from "@phosphor-icons/react";
import { isPublicDemo } from "./api";
import { useI18n } from "./i18n";
import RequestInput from "./RequestInput";
import FoldBotControls from "./FoldBotControls";
import {
  draftMatchesProject,
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
    "基于现有折叠机器人整机模板，保留底盘、双折叠板、机械臂与嵌入网页。生成完整 ESP32 工程与 ROS 演示源码；在本机通过 AE 明确触发短点动、端位确认、折叠和机械臂单轴小步。",
  drive_level: 10,
  drive_duration_ms: 200,
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
    )
      return cached;
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

export default function FoldBotWorkbench({ onOpenConsole }: { onOpenConsole: () => void }) {
  const { t } = useI18n();
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
        setStage(1);
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

  return (
    <section className="foldbot-workbench">
      <header className="foldbot-hero">
        <div>
          <div className="foldbot-eyebrow">
            <span className="foldbot-square" /> FOLDBOT /{" "}
            {t("已有整机模板", "Existing robot template")}
          </div>
          <h1>{t("从需求到折叠机器人", "From a request to FoldBot")}</h1>
          <p>
            {t(
              "把底盘、双板与机械臂放进同一份工程。先写清需求，再核对源码，最后由你在本机明确发起操作。",
              "Bring the chassis, folding panels and arm into one project. Define the request, review the source, then explicitly operate from your local machine.",
            )}
          </p>
          <button type="button" className="button primary" onClick={onOpenConsole}>
            <Robot size={20} aria-hidden="true" />
            {t("打开原版完整控制台", "Open original full console")}
          </button>
        </div>
        <div className="foldbot-hero-mark" aria-hidden="true">
          <Robot size={48} weight="duotone" />
          <span>ESP32 ↔ AE</span>
          <small>ROS · {t("源码演示", "source demo")}</small>
        </div>
      </header>
      <div className={`foldbot-mode-strip ${isPublicDemo ? "public" : ""}`}>
        <Info size={19} />
        <p>
          {isPublicDemo
            ? t(
                "分享展示模式：新需求只形成浏览器草稿；下方参考工程来自已有模板，不随草稿变化，也不调用硬件。",
                "Shared showcase: new requests create browser drafts only. The template reference below stays unchanged and never calls hardware.",
              )
            : t(
                "本机模式：工程生成与设备控制分开执行。ROS 仅展示生成代码；此页不安装 ROS、不烧录固件。",
                "Local mode: source generation and device control are separate actions. ROS is source-only; this page does not install ROS or flash firmware.",
              )}
        </p>
      </div>
      <nav
        className="foldbot-steps"
        aria-label={t("折叠机器人流程", "FoldBot workflow")}
      >
        {[
          t("需求与配置", "Request & configuration"),
          t("工程与来源", "Engineering & sources"),
          isPublicDemo
            ? t("展示说明", "Showcase details")
            : t("本机控制", "Local control"),
        ].map((label, i) => (
          <button
            key={i}
            type="button"
            className={stage === i ? "active" : ""}
            aria-current={stage === i ? "step" : undefined}
            onClick={() => setStage(i)}
          >
            <span>{i + 1}</span>
            <strong>{label}</strong>
            {i < 2 && <ArrowRight size={17} />}
          </button>
        ))}
      </nav>
      {error && (
        <div className="foldbot-notice warning" role="alert">
          <WarningCircle size={21} />
          <div>
            <strong>
              {t(
                "当前操作未完成，草稿已保留",
                "The action did not finish; your draft is kept",
              )}
            </strong>
            <p>{error}</p>
          </div>
        </div>
      )}
      {storageFailed && (
        <div className="foldbot-notice warning" role="alert">
          <p>
            {t(
              "浏览器暂存不可用。离开前请下载需求草稿。",
              "Browser storage is unavailable. Download your draft before leaving.",
            )}
          </p>
          <button
            type="button"
            className="button secondary"
            onClick={downloadDraft}
          >
            {t("下载草稿", "Download draft")}
          </button>
        </div>
      )}
      {conflict && (
        <div className="foldbot-notice warning">
          <div>
            <strong>
              {t(
                "服务器修订已变化，自动保存已暂停",
                "The server revision changed; autosave paused",
              )}
            </strong>
            <p>
              {t(
                "保留当前输入，另存为独立工程后再核对生成。",
                "Keep these inputs and save a separate project before reviewing and generating.",
              )}
            </p>
          </div>
          <button
            type="button"
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
            {t("将此草稿另存为新工程", "Save draft as a new project")}
          </button>
        </div>
      )}

      {stage === 0 && (
        <div className="foldbot-prd-layout">
          <section className="foldbot-card foldbot-request">
            <div className="foldbot-card-heading">
              <span className="foldbot-kicker">
                PRD / {t("你要完成的工作", "Your task")}
              </span>
              <span className="foldbot-save-state" role="status">
                {status}
              </span>
            </div>
            <label className="foldbot-field">
              <span>{t("工程名称", "Project name")}</span>
              <input
                value={draft.name}
                maxLength={120}
                disabled={loading || generating}
                onChange={(e) => updateDraft({ name: e.target.value })}
              />
            </label>
            <RequestInput
              value={draft.request}
              onChange={(request) => updateDraft({ request })}
              disabled={loading || generating}
              placeholder={t(
                "描述机器人需要做什么，以及现场操作约束。",
                "Describe what the robot should do and the on-site constraints.",
              )}
              rows={7}
              hint={t(
                "这段需求会写入 PRD。当前生成器按固定整机模板输出；自由描述不会自动改写控制逻辑或标定参数。",
                "This request is included in the PRD. The generator uses the complete fixed template; free text does not rewrite control logic or calibration.",
              )}
              overflow={overflow}
              onOverflowChange={setOverflow}
            />
            <div className="foldbot-config-title">
              <h3>{t("本机底盘点动约束", "Local chassis drive limits")}</h3>
              <span>
                {t(
                  "来源：此接入流程的保守默认值",
                  "Source: conservative integration defaults",
                )}
              </span>
            </div>
            <div className="foldbot-two-fields">
              <label className="foldbot-field">
                <span>{t("驱动档位 · 1–20", "Drive level · 1–20")}</span>
                <input
                  type="number"
                  min={1}
                  max={20}
                  step={1}
                  value={draft.drive_level}
                  disabled={loading || generating}
                  onChange={(e) =>
                    updateDraft({ drive_level: Number(e.target.value) })
                  }
                />
                <small>
                  {t(
                    "协议档位，不代表实测速度。",
                    "Protocol level, not measured speed.",
                  )}
                </small>
              </label>
              <label className="foldbot-field">
                <span>{t("单次时长 · 1–2000 ms", "Duration · 1–2000 ms")}</span>
                <input
                  type="number"
                  min={1}
                  max={2000}
                  step={1}
                  value={draft.drive_duration_ms}
                  disabled={loading || generating}
                  onChange={(e) =>
                    updateDraft({ drive_duration_ms: Number(e.target.value) })
                  }
                />
                <small>
                  {t(
                    "默认 200 ms，每次操作单独触发。",
                    "Default 200 ms; every move is explicit.",
                  )}
                </small>
              </label>
            </div>
            {!valid && (
              <p className="foldbot-error">
                {t(
                  "请填写名称和需求，并把驱动档位、时长设为范围内的整数。",
                  "Enter a name and request, then use whole numbers within the drive and duration limits.",
                )}
              </p>
            )}
            <div className="foldbot-footer-actions">
              <button
                type="button"
                className="button secondary"
                onClick={downloadDraft}
              >
                <DownloadSimple size={18} />
                {t("下载需求草稿", "Download draft")}
              </button>
              <button
                type="button"
                className="button primary"
                disabled={!valid || loading}
                onClick={() => setStage(1)}
              >
                {t("下一步：核对工程", "Next: review engineering")}
                <ArrowRight size={18} />
              </button>
            </div>
          </section>
          <aside className="foldbot-card foldbot-scope">
            <span className="foldbot-kicker">
              {t("整机范围", "Complete robot scope")}
            </span>
            <h2>{t("保留已有能力", "Retain the existing robot")}</h2>
            <p className="foldbot-caption">
              {t(
                "复用完整固件与嵌入网页，生成时保留这些模块。",
                "Reuse the complete firmware and embedded web page, retaining these modules.",
              )}
            </p>
            <div className="foldbot-module-list">
              {[
                [
                  t("底盘", "Chassis"),
                  t(
                    "短点动、停止与驱动限制",
                    "Short drive, stop and drive limits",
                  ),
                ],
                [
                  t("双折叠板", "Dual panels"),
                  t(
                    "两板端位确认、折叠与展开",
                    "Panel endpoint confirmation, fold and unfold",
                  ),
                ],
                [
                  t("机械臂", "Robot arm"),
                  t(
                    "六轴原始单位小步控制",
                    "Six-joint small steps in raw units",
                  ),
                ],
                [
                  t("嵌入网页", "Embedded web UI"),
                  t("完整保留 web_ui.h", "Complete web_ui.h retained"),
                ],
                [
                  t("ROS 演示包", "ROS demo package"),
                  t(
                    "生成代码，默认无运动输出",
                    "Generated code; no motion output by default",
                  ),
                ],
              ].map(([label, description]) => (
                <div key={label}>
                  <Check size={17} />
                  <div>
                    <strong>{label}</strong>
                    <small>{description}</small>
                  </div>
                </div>
              ))}
            </div>
            <div className="foldbot-inline-boundary">
              <Info size={19} />
              <p>
                {t(
                  "板卡、接线、行程和零点需要现场核对，不从需求文字猜测。",
                  "Board, wiring, travel and zero points need on-site checks; they are not inferred from request text.",
                )}
              </p>
            </div>
          </aside>
        </div>
      )}

      {stage === 1 && (
        <div className="foldbot-engineering">
          <section className="foldbot-card foldbot-review">
            <div className="foldbot-card-heading">
              <div>
                <span className="foldbot-kicker">
                  {isPublicDemo ? "REFERENCE" : "REVIEW"} /{" "}
                  {t("生成前核对", "Before generation")}
                </span>
                <h2>
                  {isPublicDemo
                    ? t(
                        "已有模板参考工程",
                        "Existing-template reference project",
                      )
                    : t(
                        "把需求与源码来源对齐",
                        "Review the request against the source",
                      )}
                </h2>
              </div>
              <ShieldCheck size={29} />
            </div>
            <div className="foldbot-review-columns">
              <div>
                <h3>
                  {isPublicDemo
                    ? (reference?.project.name ??
                      t("正在读取参考工程", "Loading reference"))
                    : draft.name}
                </h3>
                <p>
                  {isPublicDemo ? reference?.project.request : draft.request}
                </p>
                <div className="foldbot-review-meta">
                  <span>
                    {t("档位", "Level")}{" "}
                    {isPublicDemo
                      ? shownProject?.drive_level
                      : draft.drive_level}
                  </span>
                  <span>
                    {isPublicDemo
                      ? shownProject?.drive_duration_ms
                      : draft.drive_duration_ms}{" "}
                    ms
                  </span>
                  <span>{t("完整整机模板", "Complete robot template")}</span>
                </div>
              </div>
              <div>
                <h3>{t("实现与边界", "Implementation & boundaries")}</h3>
                <ul className="foldbot-review-list">
                  <li>
                    {t(
                      "复用 espkuozhanban.ino 与 web_ui.h，保留来源哈希并脱敏 AP 口令。",
                      "Reuse espkuozhanban.ino and web_ui.h, retain source hashes and redact the AP password.",
                    )}
                  </li>
                  <li>
                    {t(
                      "输出 PRD、配置、完整固件、ROS 演示与清单；生成不等于编译、烧录或验收。",
                      "Output the PRD, configuration, full firmware, ROS demo and manifest. Generation does not mean build, flashing or acceptance.",
                    )}
                  </li>
                  <li>
                    {t(
                      "当前模板禁用限位。N16R8 存储与 GPIO35–38 接线兼容性、行程及参考点待现场确认。",
                      "Limits are disabled in the template. N16R8 memory/GPIO35–38 compatibility, travel and reference points require on-site confirmation.",
                    )}
                  </li>
                </ul>
              </div>
            </div>
            {isPublicDemo ? (
              <div className="foldbot-notice">
                <Info size={20} />
                <p>
                  {t(
                    "这是预先生成的模板参考。你在第 1 步填写的草稿只保存在浏览器，不会生成新的固件或改变本记录。",
                    "This template reference was generated in advance. Your step-1 draft stays in the browser and does not generate new firmware or alter this record.",
                  )}
                </p>
              </div>
            ) : (
              <div className="foldbot-review-action">
                <label className="foldbot-check">
                  <input
                    type="checkbox"
                    checked={reviewed}
                    disabled={generating || loading || !valid}
                    onChange={(e) => setReviewed(e.target.checked)}
                  />
                  <span>
                    {t(
                      "我已核对本页需求、模板来源与未确认项；按这些约束生成当前修订。",
                      "I reviewed this request, the template sources and unresolved items; generate this revision with these constraints.",
                    )}
                  </span>
                </label>
                <button
                  type="button"
                  className="button primary"
                  disabled={
                    !reviewed || !valid || loading || generating || conflict
                  }
                  onClick={() => void generate()}
                >
                  <Code size={19} />
                  {generating
                    ? t("正在生成…", "Generating…")
                    : t("确认并生成工程", "Confirm & generate")}
                </button>
              </div>
            )}
          </section>
          <section className="foldbot-card">
            <div className="foldbot-card-heading">
              <div>
                <span className="foldbot-kicker">
                  {t("工程快照", "Project snapshot")}
                </span>
                <h2>
                  {generation
                    ? t("文件、用途与来源", "Files, purpose & provenance")
                    : t(
                        "核对后生成完整工程",
                        "Review to generate the full project",
                      )}
                </h2>
              </div>
              {safeExport && (
                <a className="button secondary" href={safeExport} download>
                  <DownloadSimple size={18} />
                  {isPublicDemo
                    ? t("下载参考工程", "Download reference")
                    : t("下载工程 ZIP", "Download project ZIP")}
                </a>
              )}
            </div>
            {generation ? (
              <>
                <div className="foldbot-evidence">
                  <span className="source">
                    <Check size={16} />
                    {t("源码已生成", "Source generated")}
                  </span>
                  {[
                    t("未编译", "Not compiled"),
                    t("未烧录", "Not flashed"),
                    t("ROS 未执行", "ROS not executed"),
                    t("实物未验收", "Hardware not verified"),
                  ].map((label) => (
                    <span key={label}>{label}</span>
                  ))}
                </div>
                <div className="foldbot-snapshot-meta">
                  <span>
                    {isPublicDemo
                      ? t("参考修订", "Reference revision")
                      : t("生成修订", "Generated revision")}{" "}
                    {generation.revision}
                  </span>
                  <span>
                    {files.length} {t("个文件", "files")}
                  </span>
                  {!isPublicDemo && !current && (
                    <strong>
                      {t(
                        "当前需求已变化，请重新生成",
                        "Request changed; regenerate",
                      )}
                    </strong>
                  )}
                </div>
                <div className="foldbot-file-browser">
                  <div
                    className="foldbot-file-tree"
                    aria-label={t("工程文件", "Project files")}
                  >
                    {files.map((file) => (
                      <button
                        type="button"
                        key={file.path}
                        className={file.path === selectedPath ? "active" : ""}
                        onClick={() => setFilePath(file.path)}
                      >
                        <FileCode size={17} />
                        <span>
                          <strong>{file.path}</strong>
                          <small>
                            {file.type} · {file.bytes.toLocaleString()} B
                          </small>
                        </span>
                      </button>
                    ))}
                  </div>
                  <div className="foldbot-file-preview">
                    <div className="foldbot-preview-heading">
                      <div>
                        <strong>{selectedPath}</strong>
                        <small>
                          {
                            files.find((file) => file.path === selectedPath)
                              ?.purpose
                          }
                        </small>
                      </div>
                      {preview && (
                        <button
                          className="button ghost"
                          type="button"
                          aria-label={t(
                            "下载当前文件",
                            "Download selected file",
                          )}
                          onClick={() =>
                            downloadText(
                              preview.path.split("/").at(-1) ??
                                "foldbot-file.txt",
                              preview.content,
                              "text/plain;charset=utf-8",
                            )
                          }
                        >
                          <DownloadSimple size={18} />
                        </button>
                      )}
                    </div>
                    <pre
                      tabIndex={0}
                      aria-label={t("文件内容预览", "File contents")}
                    >
                      {previewLoading
                        ? t("正在读取文件…", "Loading file…")
                        : previewError ||
                          preview?.content.slice(0, 24000) ||
                          t(
                            "参考包尚未包含此文件的文本预览，可下载完整工程查看。",
                            "A text preview is not included for this file. Download the project to inspect it.",
                          )}
                    </pre>
                    {preview && preview.content.length > 24000 && (
                      <p className="foldbot-preview-truncated">
                        {t(
                          "预览显示前 24,000 个字符；下载当前文件或 ZIP 获取完整内容。",
                          "Preview shows the first 24,000 characters. Download this file or ZIP for the complete source.",
                        )}
                      </p>
                    )}
                    {preview && (
                      <div className="foldbot-file-hash">
                        SHA-256 <code>{preview.sha256}</code>
                      </div>
                    )}
                  </div>
                </div>
                <details className="foldbot-sources">
                  <summary>
                    {t(
                      "查看来源与版本记录",
                      "Inspect sources & version record",
                    )}
                  </summary>
                  <p>
                    {t("生成快照哈希", "Generated snapshot hash")}:{" "}
                    <code>{generation.sha256}</code>
                  </p>
                  {(
                    generation.source_provenance ??
                    template?.source_provenance ??
                    []
                  ).map((source) => (
                    <div key={source.path}>
                      <strong>{source.path}</strong>
                      <small>
                        {t("原始来源 SHA-256", "Original source SHA-256")}
                      </small>
                      <code>{source.original_sha256}</code>
                      <small>
                        {t("脱敏源码 SHA-256", "Sanitized source SHA-256")}
                      </small>
                      <code>{source.sanitized_sha256}</code>
                      <p>{source.transformation}</p>
                    </div>
                  ))}
                </details>
              </>
            ) : (
              <div className="foldbot-empty">
                <FolderOpen size={42} />
                <div>
                  <h3>
                    {t("还没有当前工程的生成记录", "No generated snapshot yet")}
                  </h3>
                  <p>
                    {t(
                      "核对上方实现说明后，生成完整源码。生成结果会绑定需求修订并列出来源。",
                      "Review the implementation above, then generate the complete source. The snapshot will bind the request revision and list its sources.",
                    )}
                  </p>
                </div>
              </div>
            )}
          </section>
          <div className="foldbot-footer-actions">
            <button
              type="button"
              className="button secondary"
              onClick={() => setStage(0)}
            >
              {t("返回修改需求", "Edit request")}
            </button>
            <button
              type="button"
              className="button primary"
              onClick={() => setStage(2)}
            >
              {isPublicDemo
                ? t("查看展示说明", "Showcase details")
                : t("进入本机控制", "Open local control")}
              <ArrowRight size={18} />
            </button>
          </div>
        </div>
      )}

      {stage === 2 &&
        (isPublicDemo ? (
          <section className="foldbot-card foldbot-public-explain">
            <span className="foldbot-kicker">
              {t("分享版能力边界", "Shared showcase boundaries")}
            </span>
            <h2>
              {t(
                "展示工程，保留真实边界",
                "Explore the project with clear boundaries",
              )}
            </h2>
            <p>
              {t(
                "你可以填写和下载自己的 PRD 草稿，浏览已有模板参考工程、源码与来源记录。本页面不连接 ESP32，也不执行 ROS、编译、烧录或运动控制。",
                "Write and download your own PRD draft, and inspect the existing-template project, source and provenance. This page does not connect to ESP32, execute ROS, compile, flash or control motion.",
              )}
            </p>
            <div className="foldbot-public-grid">
              <article>
                <span>01</span>
                <h3>{t("需求属于你", "Your own request")}</h3>
                <p>
                  {t(
                    "浏览器自动保存当前草稿。下载 JSON 可带回本机继续核对。",
                    "Your draft is saved in this browser. Download the JSON to review it locally.",
                  )}
                </p>
              </article>
              <article>
                <span>02</span>
                <h3>
                  {t("源码来自已有模板", "Source from the existing template")}
                </h3>
                <p>
                  {t(
                    "参考工程不随访客输入变化。来源与哈希可追溯，不代表 AI 从零开发整机。",
                    "Visitor edits do not change the reference. Source hashes preserve provenance; this is not a claim of an AI-built robot from scratch.",
                  )}
                </p>
              </article>
              <article>
                <span>03</span>
                <h3>
                  {t("控制回到本机与现场", "Control stays local and on site")}
                </h3>
                <p>
                  {t(
                    "本机服务经核对生成后才开放显式连接。设备反馈与物理验收分别确认。",
                    "The local service permits an explicit connection after review and generation. Device feedback and physical acceptance are checked separately.",
                  )}
                </p>
              </article>
            </div>
            <div className="foldbot-button-row">
              <button
                type="button"
                className="button primary"
                onClick={downloadDraft}
              >
                <DownloadSimple size={18} />
                {t("下载我的需求草稿", "Download my request draft")}
              </button>
              <button
                type="button"
                className="button secondary"
                onClick={() => setStage(1)}
              >
                {t("返回参考工程", "Back to reference")}
              </button>
            </div>
          </section>
        ) : (
          <FoldBotControls
            project={project}
            ready={current && !generating && !saving}
          />
        ))}
    </section>
  );
}
