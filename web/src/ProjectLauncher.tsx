import { useEffect, useState } from "react";
import { ArrowRight, ClockCounterClockwise, Plus } from "@phosphor-icons/react";
import { isPublicDemo } from "./api";
import { useI18n } from "./i18n";
import RequestInput from "./RequestInput";
import {
  foldbotApi,
  type FoldBotCachedDraft,
  type FoldBotProject,
} from "./foldbotApi";
import { normalizeGuidedConfig } from "./guidedFlow";
import { normalizeFoldBotDraftFlow } from "./foldbotFlow";
import { validateProjectGraphs } from "./projectGraphs";
import { graphLayoutKey, parseGraphDocument } from "./projectGraphDocument";
import "./guidedJourney.css";

export const guidedDraftPrefix = `ae.guided.draft.v1.${isPublicDemo ? "public" : "local"}.`;
export const legacyDraftKey = `ae.foldbot.draft.v1.${isPublicDemo ? "public" : "local"}`;
export type ProjectEntry = {
  mode: "new" | "resume";
  cacheKey: string;
  sourceCacheKey?: string;
  copyLegacy?: boolean;
  request?: string;
  projectId?: string;
};
export function readProjectCache(key: string): FoldBotCachedDraft | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    if (value?.draft) {
      normalizeGuidedConfig(value.draft.guided);
      normalizeFoldBotDraftFlow(value.draft.workflow);
      if (
        value.draft.graphs !== undefined &&
        !validateProjectGraphs(value.draft.graphs)
      )
        return null;
      if (
        typeof value.draft.drive_level !== "number" ||
        typeof value.draft.drive_duration_ms !== "number"
      )
        return null;
    }
    return value &&
      typeof value.draft?.name === "string" &&
      typeof value.draft?.request === "string"
      ? value
      : null;
  } catch {
    return null;
  }
}
function browserDrafts() {
  const entries: { key: string; cache: FoldBotCachedDraft }[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!;
      if (!key.startsWith(guidedDraftPrefix) && key !== legacyDraftKey)
        continue;
      const cache = readProjectCache(key);
      if (cache) entries.push({ key, cache });
    }
  } catch {
    /* The new request still works with unavailable storage. */
  }
  return entries;
}
export default function ProjectLauncher({
  onOpen,
}: {
  onOpen: (entry: ProjectEntry) => void;
}) {
  const { t } = useI18n();
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, []);
  const [request, setRequest] = useState("");
  const [overflow, setOverflow] = useState("");
  const [projects, setProjects] = useState<FoldBotProject[]>([]);
  const [drafts] = useState(browserDrafts);
  const [error, setError] = useState("");
  const [importError, setImportError] = useState("");
  useEffect(() => {
    let active = true;
    if (!isPublicDemo)
      void foldbotApi
        .projects()
        .then((items) => {
          if (active) setProjects(items);
        })
        .catch(() => {
          if (active)
            setError(
              t(
                "历史工程暂时无法读取，本地草稿仍可继续。",
                "Project history is unavailable; browser drafts remain available.",
              ),
            );
        });
    return () => {
      active = false;
    };
  }, [t]);
  const newKey = () => `${guidedDraftPrefix}${crypto.randomUUID()}`;
  return (
    <section className="ae-project-launcher">
      <div className="ae-launcher-intro">
        <span className="ae-launcher-eyebrow">AUTO ENGINEERING</span>
        <h1>{t("你想制作什么？", "What would you like to build?")}</h1>
        <p>
          {t(
            "从一个想法开始，一步步选好硬件、生成接线与程序。",
            "Start with an idea. Choose hardware, then create wiring and a program, one step at a time.",
          )}
        </p>
      </div>
      <section className="ae-launcher-input">
        <RequestInput
          value={request}
          onChange={setRequest}
          disabled={false}
          rows={4}
          placeholder={t(
            "例如：制作一个折叠机器人，可以展开平台、移动和控制机械臂。",
            "For example: build a folding robot with an unfolding platform, mobile base and arm.",
          )}
          overflow={overflow}
          onOverflowChange={setOverflow}
        />
        <div className="ae-launcher-bottom">
          <span>
            {t(
              "不需要先写技术参数，我们会引导你补齐。",
              "No technical specification needed yet. We will guide you.",
            )}
          </span>
          <button
            className="button primary"
            disabled={!request.trim() || !!overflow}
            onClick={() => onOpen({ mode: "new", cacheKey: newKey(), request })}
          >
            {t("开始梳理需求", "Shape this idea")}
            <ArrowRight size={18} />
          </button>
        </div>
      </section>
      <div className="ae-launcher-examples">
        <span>{t("试试这样描述", "Try a starting point")}</span>
        {[
          [
            t("折叠机器人", "Folding robot"),
            t(
              "制作一个折叠机器人，可以展开两块折叠板，通过网页控制底盘和机械臂。",
              "Build a folding robot with two folding panels and web control of its chassis and arm.",
            ),
          ],
          [
            t("我的其他想法", "Another idea"),
            t(
              "我想制作一个机器人，用来……",
              "I would like to build a robot that…",
            ),
          ],
        ].map(([label, text]) => (
          <button key={label} onClick={() => setRequest(text)}>
            <Plus size={14} />
            {label}
          </button>
        ))}
      </div>
      <div
        className="ae-launcher-journey"
        aria-label={t("开发步骤", "Development stages")}
      >
        {[
          t("需求", "Idea"),
          t("硬件", "Hardware"),
          t("接线", "Wiring"),
          t("仿真", "Preview"),
          t("程序", "Program"),
          t("部署", "Deploy"),
          t("控制", "Control"),
        ].map((label, index) => (
          <span key={label}>
            <b>{String(index + 1).padStart(2, "0")}</b>
            {label}
          </span>
        ))}
      </div>
      <div className="ae-launcher-import">
        <label className="button secondary">
          {t("导入画布工程 JSON", "Import canvas project JSON")}
          <input
            type="file"
            accept=".json,application/json"
            aria-label={t("导入画布工程 JSON", "Import canvas project JSON")}
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              setImportError("");
              try {
                if (file.size > 1024 * 1024)
                  throw new Error("graph_document_too_large");
                const imported = parseGraphDocument(await file.text());
                const key = newKey();
                localStorage.setItem(
                  key,
                  JSON.stringify({
                    draft: imported.draft,
                    projectId: null,
                    baseRevision: null,
                  }),
                );
                localStorage.setItem(
                  graphLayoutKey(key),
                  JSON.stringify(imported.editor_layout),
                );
                onOpen({ mode: "resume", cacheKey: key });
              } catch {
                setImportError(
                  t(
                    "无法导入：请使用 AE 导出的画布工程 JSON（不超过 1 MB）。现有工程没有改变。",
                    "Could not import. Choose an AE canvas project JSON under 1 MB. Existing projects are unchanged.",
                  ),
                );
              }
            }}
          />
        </label>
        <small>
          {t(
            "导入为新草稿，接线核对和部署状态会重新确认。",
            "Imports as a new draft; wiring review and deployment must be confirmed again.",
          )}
        </small>
        {importError && <p role="alert">{importError}</p>}
      </div>
      <details className="ae-launcher-history">
        <summary>
          <ClockCounterClockwise size={20} />
          {t("继续已有工程与草稿", "Continue a project or draft")}{" "}
          <small>{projects.length + drafts.length}</small>
        </summary>
        {error && <p role="status">{error}</p>}
        {!projects.length && !drafts.length && (
          <p>
            {t(
              "还没有工程，从上方描述你的想法开始。",
              "No projects yet. Describe your idea above.",
            )}
          </p>
        )}
        <div className="ae-history-grid">
          {projects.map((project) => (
            <div className="ae-history-item" key={project.id}>
              <button
                onClick={() => {
                  const key = drafts.find(
                    (d) => d.cache.projectId === project.id,
                  )?.key;
                  onOpen({
                    mode: "resume",
                    projectId: project.id,
                    copyLegacy: !project.guided,
                    cacheKey: project.guided ? (key ?? newKey()) : newKey(),
                    sourceCacheKey: !project.guided ? key : undefined,
                  });
                }}
              >
                <strong>{project.name}</strong>
                <span>{project.request}</span>
                <small>
                  {t("工程修订", "Project revision")} {project.revision} ·{" "}
                  {project.generation
                    ? t("已有生成记录", "Source available")
                    : t("需求草稿", "Draft")}
                </small>
                {!project.guided && (
                  <small>
                    {t(
                      "以副本进入新引导，保留原工程",
                      "Start a guided copy; keep the original",
                    )}
                  </small>
                )}
              </button>
              {project.generation && project.reviewed && (
                <a
                  href={foldbotApi.exportUrl(project.id) ?? undefined}
                  download
                >
                  {t("下载已有工程", "Download existing project")}
                </a>
              )}
            </div>
          ))}
          {drafts.map(({ key, cache }) => (
            <button
              key={key}
              onClick={() => {
                const linkedProject = projects.find(
                  (project) => project.id === cache.projectId,
                );
                const copyLegacy =
                  !cache.draft.guided ||
                  !!(linkedProject && !linkedProject.guided);
                onOpen({
                  mode: "resume",
                  cacheKey: copyLegacy ? newKey() : key,
                  sourceCacheKey: copyLegacy ? key : undefined,
                  copyLegacy,
                  projectId: cache.projectId ?? undefined,
                });
              }}
            >
              <strong>
                {cache.draft.name || t("未命名草稿", "Untitled draft")}
              </strong>
              <span>{cache.draft.request}</span>
              <small>{t("浏览器草稿", "Browser draft")}</small>
            </button>
          ))}
        </div>
      </details>
      <p className="ae-launcher-footnote">
        {t(
          "当前可完整继续折叠机器人方案；其他想法可记录需求与硬件，等待适配。",
          "The folding robot is currently supported. Other ideas can be recorded with hardware details for later adaptation.",
        )}
      </p>
    </section>
  );
}
