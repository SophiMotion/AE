import { useEffect, useRef, useState } from "react";
import {
  ArrowSquareOut,
  BookOpenText,
  CircleNotch,
  Flask,
  MagnifyingGlass,
  Trash,
  UploadSimple,
  X,
} from "@phosphor-icons/react";
import { api, printable, type Source, type Project } from "./api";
type Summary = Record<string, unknown>;
interface Evaluation {
  total: number;
  passed: number;
  failed: number;
  results: {
    id: string;
    query: string;
    passed: boolean;
    expected_ids: string[];
    returned_ids: string[];
    expect_empty: boolean;
  }[];
  retrieval_mode: string;
  generation_tested: boolean;
  checked_at: string;
  notice: string;
}
export default function Library({ project }: { project: Project | null }) {
  const [query, setQuery] = useState("");
  const [task, setTask] = useState("");
  const [board, setBoard] = useState("");
  const [rosFilter, setRosFilter] = useState("any");
  const [items, setItems] = useState<Source[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [stats, setStats] = useState<Summary | null>(null);
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [message, setMessage] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    document: Source;
    pages: { page: number | null; text: string }[];
    chunks: unknown[];
    source_bytes_sha256: string;
    original_available: boolean;
    notice: string;
  } | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [origin, setOrigin] = useState("all");
  useEffect(() => {
    let live = true;
    api<Summary>("/knowledge/stats")
      .then((data) => {
        if (live) setStats(data);
      })
      .catch(() => {
        if (live) setStats(null);
      });
    return () => {
      live = false;
    };
  }, [revision]);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      setLoading(true);
      api<{ items: Source[] }>(
        `/knowledge?q=${encodeURIComponent(query)}&task_type=${task}&board=${board}&ros_distro=${rosFilter}`,
      )
        .then((result) => {
          if (live) {
            setItems(result.items);
            setError("");
          }
        })
        .catch((e) => {
          if (live) setError(e.message);
        })
        .finally(() => {
          if (live) setLoading(false);
        });
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, task, board, rosFilter, revision]);
  const evaluate = async () => {
    setEvaluating(true);
    setError("");
    try {
      setEvaluation(await api<Evaluation>("/knowledge/evaluate", {}));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setEvaluating(false);
    }
  };
  const remove = async (id: string) => {
    setError("");
    try {
      await api(
        `/knowledge/documents/${encodeURIComponent(id)}`,
        undefined,
        "DELETE",
      );
      setDeleting(null);
      setRevision((v) => v + 1);
      setMessage("该文档已从资料库移除。");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="library-page">
      <header className="page-heading">
        <div>
          <h1>资料库</h1>
          <p>把适用板型、版本和来源一起交给 AI。</p>
        </div>
        <div className="heading-actions">
          <button
            className="button secondary"
            onClick={() => void evaluate()}
            disabled={evaluating}
          >
            {evaluating ? (
              <CircleNotch size={17} className="spin" />
            ) : (
              <Flask size={17} />
            )}
            检查检索效果
          </button>
          <button
            className="button primary"
            onClick={() => setShowImport(!showImport)}
          >
            <UploadSimple size={17} />
            导入资料
          </button>
        </div>
      </header>
      {showImport && (
        <ImportDocument
          project={project}
          onClose={() => setShowImport(false)}
          onImported={() => {
            setRevision((v) => v + 1);
            setShowImport(false);
            setMessage("资料已导入，可按关键词、板型和任务查找。");
          }}
        />
      )}
      {stats && (
        <div className="knowledge-overview">
          <BookOpenText size={22} />
          <div>
            <strong>本机资料与检索记录</strong>
            <p>{statsText(stats)}</p>
          </div>
          <details>
            <summary>查看索引信息</summary>
            <pre>{printable(stats)}</pre>
          </details>
        </div>
      )}
      <div className="library-toolbar">
        <select
          aria-label="按资料来源筛选"
          value={origin}
          onChange={(e) => setOrigin(e.target.value)}
        >
          <option value="all">全部来源</option>
          <option value="experience">已核对的运行经验</option>
          <option value="builtin">内置资料</option>
          <option value="upload">上传资料</option>
        </select>
        <label className="search">
          <MagnifyingGlass size={18} />
          <input
            aria-label="搜索资料"
            placeholder="搜索串口、失联停车、ESP32…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <select
          aria-label="按任务筛选资料"
          value={task}
          onChange={(e) => setTask(e.target.value)}
        >
          <option value="">全部任务</option>
          <option value="joint_position">关节位置</option>
          <option value="sensor_threshold">传感器阈值</option>
        </select>
        <select
          aria-label="按板型筛选资料"
          value={board}
          onChange={(e) => setBoard(e.target.value)}
        >
          <option value="">全部板型</option>
          <option value="esp32">ESP32</option>
          <option value="esp32s3">ESP32-S3</option>
        </select>
        <select
          aria-label="按 ROS 版本筛选资料"
          value={rosFilter}
          onChange={(e) => setRosFilter(e.target.value)}
        >
          <option value="any">全部 ROS 版本</option>
          <option value="humble">Humble</option>
          <option value="jazzy">Jazzy</option>
          <option value="lyrical">Lyrical</option>
          <option value="not_applicable">不涉及 ROS</option>
          <option value="unknown">版本未核对</option>
        </select>
      </div>
      <div className="notice">
        <BookOpenText size={19} />
        <span>
          生成程序前，后台会查适用的资料。没有明确版本的资料可供浏览，是否用于生成以检索记录为准。
        </span>
      </div>
      {message && (
        <div className="notice success library-message">
          {message}
          <button
            className="icon-button"
            aria-label="关闭资料提示"
            onClick={() => setMessage("")}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {error && <div className="notice warning library-message">{error}</div>}
      {detailBusy && (
        <div className="notice">
          <CircleNotch className="spin" size={18} />
          正在读取原文…
        </div>
      )}
      {detail && (
        <section className="panel document-detail">
          <header className="panel-heading">
            <div>
              <h2>{detail.document.title}</h2>
              <p>{detail.notice}</p>
            </div>
            <button
              className="icon-button"
              aria-label="关闭资料原文"
              onClick={() => setDetail(null)}
            >
              <X size={20} />
            </button>
          </header>
          <div className="document-pages">
            {detail.document.origin === "experience" && (
              <p className="field-hint">
                这份经验由工具整理运行结果；其中程序摘录来自原运行的 AI
                源码，已单独标注。工具、提示词与完整回答保留在原运行的“AI
                记录”中。
              </p>
            )}
            {detail.pages.map((page, index) => (
              <details open={index === 0} key={index}>
                <summary>
                  {page.page == null
                    ? detail.document.origin === "experience"
                      ? "经验摘要与程序摘录"
                      : "原始文本"
                    : `第 ${page.page} 页`}
                </summary>
                {detail.document.origin === "experience" ? (
                  <ExperienceText text={page.text} />
                ) : (
                  <pre>{page.text}</pre>
                )}
              </details>
            ))}
            <details>
              <summary>适用范围和来源记录</summary>
              <pre>
                {printable({
                  ...documentMetadata(detail.document),
                  source_bytes_sha256: detail.source_bytes_sha256,
                  original_available: detail.original_available,
                })}
              </pre>
            </details>
          </div>
        </section>
      )}
      {evaluation && (
        <div className="evaluation-result">
          <div className="section-intro">
            <div>
              <h3>检索检查结果</h3>
              <p>
                {evaluation.passed} / {evaluation.total} 个问题检索通过，
                {evaluation.failed}{" "}
                个未通过。此检查只验证能否找到资料，不验证生成代码。
              </p>
            </div>
          </div>
          <details>
            <summary>查看测试问题与结果</summary>
            <div className="retrieval-cases">
              {evaluation.results?.map((item) => (
                <div key={item.id}>
                  <span>
                    {item.query}
                    <small>
                      {item.expect_empty
                        ? "预期不使用不匹配资料"
                        : `要求命中 ${item.expected_ids.length} 份指定资料`}
                    </small>
                  </span>
                  <strong className={item.passed ? "good-text" : "bad-text"}>
                    {item.passed ? "通过" : "未通过"}
                  </strong>
                </div>
              ))}
            </div>
          </details>
          <details className="retrieval-raw">
            <summary>原始评测记录</summary>
            <pre>{printable(evaluation)}</pre>
          </details>
        </div>
      )}
      {loading ? (
        <div className="empty-state">
          <CircleNotch size={26} className="spin" />
        </div>
      ) : (
        <div className="source-list">
          {items
            .filter((item) => origin === "all" || item.origin === origin)
            .map((item, index) => (
              <article className="source-item" key={`${item.id}-${index}`}>
                <div className="source-top">
                  <h2>{item.title}</h2>
                  <div className="source-actions">
                    <button
                      className="button secondary"
                      disabled={detailBusy}
                      onClick={async () => {
                        setDetailBusy(true);
                        setDetail(null);
                        setError("");
                        try {
                          setDetail(
                            await api(
                              `/knowledge/documents/${encodeURIComponent(item.document_id || item.id)}`,
                            ),
                          );
                        } catch (e) {
                          setError((e as Error).message);
                        } finally {
                          setDetailBusy(false);
                        }
                      }}
                    >
                      查看完整内容
                    </button>
                    {/^https?:\/\//.test(item.url) ? (
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noreferrer"
                        className="button secondary"
                      >
                        查看原文
                        <ArrowSquareOut size={16} />
                      </a>
                    ) : (
                      <span className="local-source">
                        {item.url?.startsWith("project://")
                          ? "本项目约定，见核对页"
                          : "本机导入资料"}
                      </span>
                    )}
                    {(item.uploaded || item.origin === "experience") &&
                      item.document_id && (
                        <button
                          className="icon-button"
                          aria-label={`删除资料 ${item.title}`}
                          onClick={() => setDeleting(item.document_id!)}
                        >
                          <Trash size={17} />
                        </button>
                      )}
                  </div>
                </div>
                <div className="source-meta">
                  {item.experience_kind && (
                    <span>
                      {
                        {
                          success: "通过记录",
                          failure: "失败教训 · 仅供排错",
                          repair: "修复与复测",
                        }[item.experience_kind]
                      }
                    </span>
                  )}
                  <span>{item.version || "版本未填写"}</span>
                  {item.content_kind && (
                    <span>
                      {item.origin === "experience"
                        ? "已核对的运行经验"
                        : item.content_kind === "original"
                          ? "原文资料"
                          : "整理摘要"}
                    </span>
                  )}
                  {item.board && (
                    <span>
                      {item.board === "any"
                        ? "通用资料"
                        : item.board === "unknown"
                          ? "板型未核对"
                          : item.board.toUpperCase()}
                    </span>
                  )}
                  {item.ros_distro && (
                    <span>
                      {item.ros_distro === "not_applicable"
                        ? "不涉及 ROS"
                        : item.ros_distro === "any"
                          ? "不限定 ROS 版本"
                          : item.ros_distro === "unknown"
                            ? "ROS 版本未标注"
                            : `ROS ${item.ros_distro}`}
                    </span>
                  )}
                  {typeof item.score === "number" && query && (
                    <span>相关得分 {item.score.toFixed(3)}</span>
                  )}
                  {item.tags?.map((tag) => (
                    <span key={tag}>{tag}</span>
                  ))}
                </div>
                {!!item.warnings?.length && (
                  <div className="source-warnings">
                    {item.warnings.map((warning, i) => (
                      <p key={i}>{warning}</p>
                    ))}
                  </div>
                )}
                {(item.page_start != null || item.line_start != null) && (
                  <p className="citation-location">
                    {item.page_start != null
                      ? `第 ${item.page_start}${item.page_end && item.page_end !== item.page_start ? `–${item.page_end}` : ""} 页`
                      : ""}
                    {item.line_start != null
                      ? ` 第 ${item.line_start}${item.line_end && item.line_end !== item.line_start ? `–${item.line_end}` : ""} 行`
                      : ""}
                  </p>
                )}
                {item.origin === "experience" ? (
                  <p className="field-hint">
                    这份记录包含工具检查摘要和 AI
                    程序摘录。请点“查看完整内容”，按来源分别查看；失败记录仅供排错。
                  </p>
                ) : (
                  <>
                    <p>
                      {item.content?.slice(0, 500)}
                      {item.content?.length > 500 ? "…" : ""}
                    </p>
                    {item.content?.length > 500 && (
                      <details className="source-excerpt">
                        <summary>展开这段资料</summary>
                        <pre>{item.content}</pre>
                      </details>
                    )}
                  </>
                )}
                <small>
                  来源标识 {item.id} · {item.license || "许可见来源"}
                  {item.checked_at
                    ? ` · 核对于 ${item.checked_at.slice(0, 10)}`
                    : ""}
                </small>
                {deleting === item.document_id && (
                  <div className="delete-confirm">
                    <span>从本机资料库移除整份文档及其片段？</span>
                    <button
                      className="button secondary"
                      onClick={() => setDeleting(null)}
                    >
                      取消
                    </button>
                    <button
                      className="button secondary"
                      onClick={() => void remove(item.document_id!)}
                    >
                      确认移除
                    </button>
                  </div>
                )}
              </article>
            ))}
          {!items.filter((item) => origin === "all" || item.origin === origin)
            .length && (
            <div className="empty-state">
              <MagnifyingGlass size={28} />
              <h3>没有匹配的资料</h3>
              <p>换一个关键词、取消筛选，或导入对应版本的资料。</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
function documentMetadata(source: Source): Record<string, unknown> {
  const result = { ...source } as Record<string, unknown>;
  delete result.content;
  if (Array.isArray(result.code_versions))
    result.code_versions = result.code_versions.map((entry) => {
      const value = { ...entry };
      delete value.ros_excerpt;
      delete value.esp32_excerpt;
      return value;
    });
  return result;
}
function ExperienceText({ text }: { text: string }) {
  const parts: { text: string; code: boolean }[] = [];
  const fences = /```[^\n]*\n([\s\S]*?)```/g;
  let start = 0;
  for (const match of text.matchAll(fences)) {
    if (match.index > start)
      parts.push({ text: text.slice(start, match.index), code: false });
    parts.push({ text: match[1], code: true });
    start = match.index + match[0].length;
  }
  if (start < text.length) parts.push({ text: text.slice(start), code: false });
  return (
    <>
      {parts.map((part, index) =>
        part.code ? (
          <div key={index} className="ai-content">
            <p className="ai-label">
              AI 生成程序摘录 · 原运行记录保留工具与提示词
            </p>
            <pre>{part.text}</pre>
          </div>
        ) : (
          <pre key={index}>{part.text}</pre>
        ),
      )}
    </>
  );
}
function statsText(stats: Summary) {
  const values: string[] = [];
  const documents =
    stats.documents ?? stats.document_count ?? stats.total_documents;
  const chunks = stats.chunks ?? stats.chunk_count ?? stats.total_chunks;
  if (typeof documents === "number") values.push(`${documents} 份文档`);
  if (typeof chunks === "number") values.push(`${chunks} 段资料`);
  if (typeof stats.experience_documents === "number")
    values.push(`${stats.experience_documents} 份运行经验`);
  const method =
    stats.retrieval_mode ??
    stats.method ??
    stats.retrieval_method ??
    stats.backend;
  if (typeof method === "string")
    values.push(
      method === "sqlite_fts5_bm25"
        ? "全文检索（BM25）"
        : `检索方式：${method}`,
    );
  return values.length
    ? values.join(" · ")
    : "索引状态来自后台，展开可查看当前资料和检索方式。";
}
function ImportDocument({
  onClose,
  onImported,
  project,
}: {
  onClose: () => void;
  onImported: () => void;
  project: Project | null;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [version, setVersion] = useState("");
  const [board, setBoard] = useState("unknown");
  const [rosDistro, setRosDistro] = useState("unknown");
  const [tasks, setTasks] = useState(["joint_position", "sensor_threshold"]);
  const [modelScope, setModelScope] = useState("unknown");
  const [customModel, setCustomModel] = useState("");
  const [customHash, setCustomHash] = useState("");
  const [sdkModes, setSdkModes] = useState<Record<string, string>>({
    esp32_core: "unknown",
    arduinojson: "unknown",
  });
  const [sdkValues, setSdkValues] = useState<Record<string, string>>({
    esp32_core: "",
    arduinojson: "",
  });
  const softwareVersions = Object.fromEntries(
    ["esp32_core", "arduinojson"].map((key) => [
      key,
      sdkModes[key] === "current"
        ? project?.manifest?.dependencies[key] || "unknown"
        : sdkModes[key] === "custom"
          ? sdkValues[key].trim()
          : sdkModes[key],
    ]),
  );
  const validSDK = Object.values(softwareVersions).every(
    (value) =>
      ["unknown", "any"].includes(value) ||
      /^[0-9][A-Za-z0-9_.+-]{0,99}$/.test(value),
  );
  const currentModel =
    project?.structure?.format === "sophicore-kinematic"
      ? "sophicore_506"
      : String(project?.execution_model?.model_id || "");
  const currentHash = String(project?.execution_model?.source_sha256 || "");
  const modelId =
    modelScope === "current"
      ? currentModel
      : modelScope === "custom"
        ? customModel.trim()
        : modelScope;
  const modelHash =
    modelScope === "current"
      ? currentHash
      : modelScope === "custom"
        ? customHash.trim().toLowerCase()
        : null;
  const validModel = ["unknown", "any"].includes(modelId)
    ? modelHash === null
    : /^[A-Za-z0-9_.:-]{1,100}$/.test(modelId) &&
      /^[a-f0-9]{64}$/.test(modelHash || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const submit = async () => {
    if (!file) return;
    setError("");
    setBusy(true);
    try {
      if (file.size > 10_000_000)
        throw new Error("文件不能超过 10 MB（10,000,000 字节）。");
      const content = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () => reject(new Error("文件读取失败"));
        reader.readAsDataURL(file);
      });
      await api("/knowledge/documents", {
        filename: file.name,
        content_base64: content,
        title: title.trim(),
        url: url.trim(),
        version: version.trim(),
        board,
        ros_distro: rosDistro,
        task_types: tasks,
        robot_model: modelId,
        source_model_sha256: modelHash,
        software_versions: softwareVersions,
      });
      onImported();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel knowledge-import">
      <div className="section-intro">
        <div>
          <h2>导入开发资料</h2>
          <p>
            支持文字、含文字的
            PDF、源码和机器人配置；导入只读取内容，不执行文件。
          </p>
        </div>
        <button
          className="icon-button"
          aria-label="关闭资料导入"
          disabled={busy}
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      <div className="document-picker">
        <button
          className="button secondary"
          disabled={busy}
          onClick={() => input.current?.click()}
        >
          <UploadSimple size={17} />
          {file ? "更换文件" : "选择文件"}
        </button>
        <span>
          {file
            ? `${file.name} · ${(file.size / 1024).toFixed(0)} KB`
            : "TXT / MD / PDF / Python / C++ / Arduino / YAML / JSON / URDF · 最大 10 MB"}
        </span>
        <input
          hidden
          ref={input}
          type="file"
          accept=".txt,.md,.pdf,.py,.cpp,.h,.hpp,.ino,.c,.cc,.cxx,.yaml,.yml,.json,.xml,.urdf,.sdf"
          aria-label="选择知识资料文件"
          onChange={(e) => {
            const selected = e.target.files?.[0];
            if (selected) {
              setFile(selected);
              if (!title) setTitle(selected.name.replace(/\.[^.]+$/, ""));
            }
          }}
        />
      </div>
      <div className="prd-grid">
        <label className="field">
          <span>资料名称</span>
          <input
            value={title}
            maxLength={200}
            disabled={busy}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label className="field">
          <span>适用版本</span>
          <input
            value={version}
            maxLength={100}
            placeholder="例如：Arduino-ESP32 3.3.12；不清楚填待确认"
            disabled={busy}
            onChange={(e) => setVersion(e.target.value)}
          />
        </label>
        <label className="field">
          <span>适用板型</span>
          <select
            aria-label="适用板型"
            value={board}
            disabled={busy}
            onChange={(e) => setBoard(e.target.value)}
          >
            <option value="unknown">板型未核对</option>
            <option value="any">通用资料</option>
            <option value="esp32">ESP32</option>
            <option value="esp32s3">ESP32-S3</option>
          </select>
        </label>
        <label className="field">
          <span>适用 ROS 版本</span>
          <select
            aria-label="适用 ROS 版本"
            value={rosDistro}
            disabled={busy}
            onChange={(e) => setRosDistro(e.target.value)}
          >
            <option value="unknown">版本未核对</option>
            <option value="humble">ROS 2 Humble</option>
            <option value="jazzy">ROS 2 Jazzy</option>
            <option value="lyrical">ROS 2 Lyrical</option>
            <option value="not_applicable">不涉及 ROS</option>
            <option value="any">通用，不限定版本</option>
          </select>
        </label>
        <label className="field">
          <span>来源网址（可选）</span>
          <input
            value={url}
            disabled={busy}
            type="url"
            placeholder="https://…"
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
      </div>
      <div className="task-checkboxes">
        <span>用于哪些任务</span>
        {[
          { id: "joint_position", label: "关节位置" },
          { id: "sensor_threshold", label: "传感器阈值" },
        ].map((task) => (
          <label key={task.id}>
            <input
              type="checkbox"
              disabled={busy}
              checked={tasks.includes(task.id)}
              onChange={(e) =>
                setTasks(
                  e.target.checked
                    ? [...tasks, task.id]
                    : tasks.filter((x) => x !== task.id),
                )
              }
            />
            {task.label}
          </label>
        ))}
      </div>
      <details
        className="source-details model-scope"
        open={modelScope !== "unknown"}
      >
        <summary>
          资料适用的结构与软件 ·{" "}
          {modelScope === "unknown"
            ? "尚未确认，先存档"
            : modelScope === "any"
              ? "已确认通用"
              : modelId || "待填写"}
        </summary>
        <p className="field-hint">
          结构资料必须和项目模型对应。没有确认版本或适用结构时，只保存资料供查看，不交给
          AI 生成程序。
        </p>
        <label className="field">
          <span>适用结构</span>
          <select
            aria-label="资料适用结构"
            disabled={busy}
            value={modelScope}
            onChange={(e) => setModelScope(e.target.value)}
          >
            <option value="unknown">尚未确认（只保存和查看）</option>
            <option value="any">通用资料（确认不限制结构）</option>
            <option
              value="current"
              disabled={!currentModel || !/^[a-f0-9]{64}$/.test(currentHash)}
            >
              当前工程结构{project ? ` · ${project.name}` : "（先选择工程）"}
            </option>
            <option value="custom">其他指定结构</option>
          </select>
        </label>
        {modelScope === "current" && (
          <p className="field-hint">
            模型 {currentModel} · 源文件校验值 {currentHash}
            。来自当前工程已保存的结构，不从资料内容猜测。
          </p>
        )}
        {modelScope === "custom" && (
          <div className="prd-grid">
            <label className="field">
              <span>模型标识</span>
              <input
                aria-label="资料模型标识"
                value={customModel}
                onChange={(e) => setCustomModel(e.target.value)}
                placeholder="填写结构的准确编号"
                maxLength={100}
                disabled={busy}
              />
            </label>
            <label className="field">
              <span>源模型 SHA256（64位）</span>
              <input
                aria-label="源模型校验值"
                value={customHash}
                onChange={(e) => setCustomHash(e.target.value)}
                placeholder="从结构来源记录复制，用于匹配同一份模型"
                maxLength={64}
                disabled={busy}
              />
            </label>
          </div>
        )}
        {!validModel && (
          <p className="input-error">
            指定结构需要准确的模型标识和 64
            位源文件校验值；还不清楚时请选择“尚未确认”。
          </p>
        )}
        <p className="field-hint">
          文档版本与程序依赖版本分开填写。以下两项尚未确认时也只存档；资料确实不涉及该依赖时，明确选“通用资料”。
        </p>
        <div className="prd-grid">
          {[
            { id: "esp32_core", label: "ESP32 核心版本" },
            { id: "arduinojson", label: "ArduinoJson 版本" },
          ].map((sdk) => (
            <div key={sdk.id}>
              <label className="field">
                <span>{sdk.label}</span>
                <select
                  aria-label={sdk.label}
                  value={sdkModes[sdk.id]}
                  disabled={busy}
                  onChange={(e) =>
                    setSdkModes((previous) => ({
                      ...previous,
                      [sdk.id]: e.target.value,
                    }))
                  }
                >
                  <option value="unknown">尚未确认（只存档）</option>
                  <option value="any">通用资料（不限制该依赖）</option>
                  <option
                    value="current"
                    disabled={!project?.manifest?.dependencies[sdk.id]}
                  >
                    当前工程 ·{" "}
                    {project?.manifest?.dependencies[sdk.id] || "未读取"}
                  </option>
                  <option value="custom">填写准确版本</option>
                </select>
              </label>
              {sdkModes[sdk.id] === "custom" && (
                <label className="field">
                  <span>{sdk.label}具体值</span>
                  <input
                    aria-label={`${sdk.label}具体值`}
                    value={sdkValues[sdk.id]}
                    maxLength={100}
                    disabled={busy}
                    onChange={(e) =>
                      setSdkValues((previous) => ({
                        ...previous,
                        [sdk.id]: e.target.value,
                      }))
                    }
                    placeholder={
                      sdk.id === "esp32_core" ? "例如 3.3.12" : "例如 7.4.3"
                    }
                  />
                </label>
              )}
            </div>
          ))}
        </div>
        {!validSDK && (
          <p className="input-error">
            请填写明确的数字版本；不知道版本时请选择“尚未确认”。
          </p>
        )}
      </details>
      <p className="field-hint">
        只填写资料实际适用的版本和板型。空白、unknown、待确认、latest
        等不视为已核对版本，只能保存和浏览，不用于生成程序。扫描图片类 PDF
        需先转成文字；本次导入不训练模型。
      </p>
      {error && <div className="notice warning">{error}</div>}
      <div className="form-actions">
        <button
          className="button primary"
          disabled={
            busy ||
            !file ||
            !title.trim() ||
            !version.trim() ||
            !tasks.length ||
            !validModel ||
            !validSDK ||
            (!!url && !/^https?:\/\//.test(url))
          }
          onClick={() => void submit()}
        >
          {busy ? (
            <CircleNotch size={17} className="spin" />
          ) : (
            <UploadSimple size={17} />
          )}
          导入并建立索引
        </button>
      </div>
    </section>
  );
}
