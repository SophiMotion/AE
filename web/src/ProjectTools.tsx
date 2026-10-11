import { useI18n } from "./i18n";
import { t } from "./localeStore.ts";
import "./i18nPanels";
import { useEffect, useRef, useState } from "react";
import { CircleNotch, Copy, UploadSimple, X } from "@phosphor-icons/react";
import {
  api,
  localTime,
  printable,
  statusLabels,
  type Project,
  type Run,
} from "./api";

interface HistoryEntry {
  id: string;
  project_id: string;
  revision: number;
  event: string;
  created_at: string;
  snapshot: Project;
}
interface ImportPreview {
  preview_hash: string;
  name: string;
  task_type: string | null;
  board: string | null;
  joint_name?: string;
  source_run_id?: string;
  warnings: string[];
  has_integrity: boolean;
}

export default function ProjectTools({
  mode,
  project,
  run,
  onCreated,
  onClose,
  dirty,
}: {
  mode: "history" | "import";
  project: Project | null;
  run: Run | null;
  onCreated: (project: Project) => void;
  onClose: () => void;
  dirty: boolean;
}) {
  useI18n();
  const [items, setItems] = useState<HistoryEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [payload, setPayload] = useState<{
    filename: string;
    content_base64: string;
  } | null>(null);
  const [checked, setChecked] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setError("");
    setItems([]);
    if (mode !== "history" || !project) return;
    let live = true;
    setBusy(true);
    api<{ items: HistoryEntry[] }>(`/projects/${project.id}/history`)
      .then((data) => {
        if (live) setItems(data.items);
      })
      .catch((e) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [
    mode,
    project?.id,
    project?.spec_revision,
    project?.plan?.plan_id,
    project?.status,
  ]);
  const clone = async (path: string) => {
    setBusy(true);
    setError("");
    try {
      onCreated(await api<Project>(path, {}));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const readZip = async (file?: File) => {
    setPreview(null);
    setPayload(null);
    setChecked(false);
    setError("");
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".zip") || file.size > 30_000_000) {
      setError(t("请选择不超过 30 MB 的工程 ZIP。"));
      return;
    }
    setBusy(true);
    try {
      const encoded = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () =>
          reject(new Error(t("文件读取失败，请重新选择。")));
        reader.readAsDataURL(file);
      });
      const next = { filename: file.name, content_base64: encoded };
      const data = await api<ImportPreview>("/projects/import/preview", next);
      setPayload(next);
      setPreview(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };
  return (
    <section
      className="panel project-tools"
      aria-label={mode === "history" ? t("工程版本历史") : t("导入工程包")}
    >
      <header className="panel-heading">
        <div>
          <h2>{mode === "history" ? t("工程版本历史") : t("导入工程包")}</h2>
          <p>{t("保留原记录，创建新的草稿。生成、编译前仍需重新核对。")}</p>
        </div>
        <button
          className="icon-button"
          aria-label={t("关闭工程工具")}
          disabled={busy}
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </header>
      {dirty && (
        <div className="notice warning">
          {t(
            "当前页面有未保存内容。打开新草稿会离开这些修改；需要保留时，请先关闭这里并保存。",
          )}
        </div>
      )}
      {error && (
        <div className="notice warning" role="alert">
          {error}
        </div>
      )}
      {mode === "history" ? (
        <div className="history-content">
          {run && (
            <div className="history-reuse">
              <div>
                <strong>{t("以当前查看的运行开始下一轮")}</strong>
                <p>
                  {run.spec_snapshot.name} {t("· 规格 v")}
                  {run.spec_snapshot.spec_revision} · {run.id.slice(0, 8)}
                </p>
              </div>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => void clone(`/runs/${run.id}/clone`)}
              >
                <Copy size={17} />
                {t("复制本轮为新草稿")}
              </button>
            </div>
          )}
          {!project ? (
            <p>{t("先选择一个已保存的工程。")}</p>
          ) : busy && !items.length ? (
            <p>
              <CircleNotch className="spin" />
              {t("正在读取版本…")}
            </p>
          ) : !items.length ? (
            <p>
              {t(
                "这份历史工程尚未保存需求版本；之后每次保存和拆分都会留下记录。已执行的版本仍可从历史运行查看。",
              )}
            </p>
          ) : (
            items.map((item) => (
              <details className="history-entry" key={item.id}>
                <summary>
                  <strong>
                    v{item.revision} · {eventLabel(item.event)}
                  </strong>
                  <time>{localTime(item.created_at)}</time>
                </summary>
                <div className="history-summary">
                  <strong>{item.snapshot.name || t("未命名需求")}</strong>
                  <p>{item.snapshot.request}</p>
                  <p>
                    {item.snapshot.hardware.board?.toUpperCase() ||
                      t("板型待选")}{" "}
                    ·{" "}
                    {item.snapshot.prd?.intake?.answers.joint_name ||
                      item.snapshot.prd?.joint_name ||
                      (item.snapshot.task_type === "sensor_threshold"
                        ? t("模拟传感器")
                        : t("控制对象待选"))}{" "}
                    · {statusLabels[item.snapshot.status]}
                  </p>
                </div>
                <details>
                  <summary>{t("当时的参数和需求")}</summary>
                  <pre>
                    {printable({
                      parameters: item.snapshot.parameters,
                      hardware: item.snapshot.hardware,
                      prd: item.snapshot.prd,
                      workflow: item.snapshot.workflow,
                    })}
                  </pre>
                </details>
                {item.snapshot.plan && (
                  <div className="ai-content">
                    <p className="ai-label">
                      {t("这版拆分由 AI 生成 ·")}{" "}
                      {item.snapshot.plan.provenance?.tool} /{" "}
                      {item.snapshot.plan.provenance?.model}
                    </p>
                    <pre>{printable(item.snapshot.plan)}</pre>
                  </div>
                )}
                {item.snapshot.plan_failure_provenance && (
                  <div className="ai-content">
                    <p className="ai-label">
                      {t("这版失败调用 · 工具、提示词与原回答")}
                    </p>
                    <pre>
                      {printable(item.snapshot.plan_failure_provenance)}
                    </pre>
                  </div>
                )}
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() =>
                    void clone(
                      `/projects/${item.project_id}/history/${item.id}/clone`,
                    )
                  }
                >
                  <Copy size={16} />
                  {t("从这个版本新建")}
                </button>
              </details>
            ))
          )}
        </div>
      ) : (
        <div className="import-content">
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
          >
            <UploadSimple size={18} />
            {preview ? t("更换工程包") : t("选择工程 ZIP")}
          </button>
          <input
            hidden
            ref={fileInput}
            type="file"
            accept=".zip"
            aria-label={t("选择工程 ZIP 文件")}
            onChange={(e) => void readZip(e.target.files?.[0])}
          />
          {busy && (
            <p>
              <CircleNotch className="spin" />
              {t("正在检查工程包…")}
            </p>
          )}
          {preview && (
            <div className="import-preview">
              <h3>{preview.name}</h3>
              <dl>
                <div>
                  <dt>{t("任务 / 板型")}</dt>
                  <dd>
                    {preview.task_type === "joint_position"
                      ? t("关节位置控制")
                      : preview.task_type === "joint_sequence"
                        ? t("多关节顺序动作")
                        : preview.task_type === "sensor_threshold"
                          ? t("传感器触发")
                          : t("待整理 / 仅保存需求")}{" "}
                    / {preview.board?.toUpperCase() || t("板型待选")}
                  </dd>
                </div>
                <div>
                  <dt>{t("控制对象")}</dt>
                  <dd>
                    {preview.joint_name ||
                      (preview.task_type === "sensor_threshold"
                        ? t("模拟传感器")
                        : t("控制对象待选"))}
                  </dd>
                </div>
                <div>
                  <dt>{t("来源运行")}</dt>
                  <dd>{preview.source_run_id || t("包内未提供")}</dd>
                </div>
                <div>
                  <dt>{t("版本记录")}</dt>
                  <dd>
                    {preview.has_integrity
                      ? t("包内文件 SHA256 校验通过；作为新草稿仍需重检")
                      : t("历史包没有逐文件 SHA256 清单")}
                  </dd>
                </div>
              </dl>
              {!!preview.warnings.length && (
                <div className="notice warning">
                  <ul>
                    {preview.warnings.map((text, i) => (
                      <li key={i}>{text}</li>
                    ))}
                  </ul>
                </div>
              )}
              <label className="import-confirm">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => setChecked(e.target.checked)}
                />
                {t("已核对，作为新草稿导入；不继承旧批准或通过状态")}
              </label>
              <button
                className="button primary"
                disabled={busy || !checked || !payload}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    onCreated(
                      await api<Project>("/projects/import", {
                        ...payload,
                        preview_hash: preview.preview_hash,
                        confirm: true,
                      }),
                    );
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {t("导入为新草稿")}
              </button>
            </div>
          )}
          <p className="field-hint">
            {t(
              "只读取本平台导出的工程。不会执行包内程序、烧录固件或自动开始任务。",
            )}
          </p>
        </div>
      )}
    </section>
  );
}
function eventLabel(event: string) {
  return (
    (
      {
        created: t("创建", "Created"),
        before_edit: t("修改前保留"),
        saved: t("保存需求", "Requirements saved"),
        updated: t("保存需求", "Requirements saved"),
        planning: t("开始拆分", "Planning started"),
        before_plan: t("拆分前保留"),
        planned: t("拆分完成"),
        plan_ready: t("拆分完成"),
        plan_failed: t("拆分失败"),
        plan_cancelled: t("拆分取消"),
        approved: t("人工核对"),
        imported: t("导入工程", "Project imported"),
        cloned: t("复制工程", "Project copied"),
        created_from_copy: t("从已有版本创建"),
      } as Record<string, string>
    )[event] || event
  );
}
