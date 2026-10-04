import { useEffect, useState } from "react";
import {
  BracketsCurly,
  CheckCircle,
  CircleNotch,
  DownloadSimple,
  FileCode,
  ListBullets,
  Terminal,
  WarningCircle,
} from "@phosphor-icons/react";
import { api, localTime, printable, type Plan, type Run } from "./api";
import ChecksView from "./ChecksView";
import ModelIdentity from "./ModelIdentity";
import { lineDiff } from "./codeDiff";
type Tab = "logs" | "files" | "code" | "checks" | "ai";
const tabs = [
  { id: "logs" as Tab, label: "运行日志", icon: Terminal },
  { id: "files" as Tab, label: "生成文件", icon: FileCode },
  { id: "code" as Tab, label: "两端代码", icon: BracketsCurly },
  { id: "checks" as Tab, label: "检查结果", icon: CheckCircle },
  { id: "ai" as Tab, label: "AI 记录", icon: ListBullets },
];
export default function Evidence({
  run,
  plan,
  failedProvenance,
}: {
  run: Run | null;
  plan: Plan | null;
  failedProvenance?: import("./api").Provenance | null;
}) {
  const [tab, setTab] = useState<Tab>("logs");
  const [path, setPath] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setPath("");
    setContent("");
    setError("");
  }, [run?.id]);
  useEffect(() => {
    if (!path || !run) return;
    let live = true;
    setLoading(true);
    setError("");
    api<{ path: string; content: string }>(
      `/runs/${run.id}/file?path=${encodeURIComponent(path)}`,
    )
      .then((x) => {
        if (live) setContent(x.content);
      })
      .catch((e) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [path, run?.id]);
  const records = [
    ...(plan?.provenance ? [plan.provenance] : []),
    ...(run?.provenance || []),
    ...(failedProvenance ? [failedProvenance] : []),
  ];
  return (
    <section className="panel evidence">
      <div className="evidence-tabs" role="tablist" aria-label="工程记录">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? "active" : ""}
            onClick={() => setTab(id)}
          >
            <Icon size={19} />
            {label}
            {id === "files" && !!run?.artifacts?.length && (
              <small>{run.artifacts.length}</small>
            )}
          </button>
        ))}
        {run && (
          <a
            className="icon-button export-action"
            title="下载完整工程"
            aria-label="下载完整工程"
            href={`/api/runs/${run.id}/export`}
          >
            <DownloadSimple size={18} />
          </a>
        )}
      </div>
      {tab === "logs" &&
        (run?.events?.length ? (
          <div className="log-list" aria-live="polite">
            {run.events.map((event, index) => (
              <div
                key={index}
                className={`log-row ${event.level === "error" ? "error" : ""}`}
              >
                <time>
                  {event.time
                    ? new Date(event.time).toLocaleTimeString("zh-CN", {
                        hour12: false,
                      })
                    : "—"}
                </time>
                <span className="log-stage">{event.stage}</span>
                <span>{event.message}</span>
              </div>
            ))}
          </div>
        ) : (
          <Empty
            icon="log"
            text="生成和运行后，这里会保留真实记录。"
            detail="编译输出、启动过程和报错都可以在这里查看。"
          />
        ))}
      {tab === "files" &&
        (run?.artifacts?.length ? (
          <div>
            <ModelIdentity
              spec={run.spec_snapshot}
              actualOrder={run.result?.execution_order}
            />
            <div className="file-workspace">
              <div className="file-list">
                {run.artifacts.map((file) => (
                  <button
                    key={file.path}
                    className={path === file.path ? "active" : ""}
                    onClick={() => setPath(file.path)}
                    title={file.path}
                  >
                    <FileCode size={15} />
                    <span>{file.path}</span>
                    <small>
                      {file.size < 1024
                        ? `${file.size} B`
                        : `${(file.size / 1024).toFixed(1)} K`}
                    </small>
                  </button>
                ))}
              </div>
              <div className="file-preview">
                {path ? (
                  <>
                    <div className="file-toolbar">{path}</div>
                    {loading ? (
                      <div className="empty-state">
                        <CircleNotch size={23} className="spin" />
                      </div>
                    ) : error ? (
                      <div className="notice warning">{error}</div>
                    ) : (
                      <pre>{content}</pre>
                    )}
                  </>
                ) : (
                  <Empty
                    text="选择左侧文件查看"
                    detail="可下载完整工程，在本机继续开发。"
                  />
                )}
              </div>
            </div>
          </div>
        ) : (
          <Empty
            text="还没有生成文件"
            detail="程序、通信约定和检查结果都会保存到这一轮工程。"
          />
        ))}
      {tab === "checks" &&
        (run?.result ? (
          <div className="compact-checks">
            <ChecksView checks={run.result.checks} />
          </div>
        ) : (
          <Empty
            text="还没有检查结果"
            detail="只有后台真正执行之后，才会显示通过或失败。"
          />
        ))}
      {tab === "code" && <GeneratedCode key={run?.id} run={run} />}
      {tab === "ai" &&
        (records.length ? (
          <div className="ai-records">
            {records.map((record, index) => (
              <details
                key={index}
                className="ai-record"
                open={index === records.length - 1}
              >
                <summary>
                  <span>
                    AI 生成 · {record.tool || "工具已记录"} {record.model || ""}
                  </span>
                  <time>{localTime(record.started_at)}</time>
                </summary>
                <label>使用的提示词</label>
                <pre>{record.prompt || "本轮未提供提示词记录"}</pre>
                {record.response !== undefined && (
                  <>
                    <label>原始回答</label>
                    <pre>{printable(record.response)}</pre>
                  </>
                )}
                {!!record.sources?.length && (
                  <>
                    <label>参考来源</label>
                    <ul>
                      {record.sources.map((source, i) => (
                        <li key={i}>
                          {/^https?:\/\//.test(source) ? (
                            <a href={source} target="_blank" rel="noreferrer">
                              {source}
                            </a>
                          ) : (
                            source
                          )}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </details>
            ))}
          </div>
        ) : (
          <Empty
            text="还没有调用 AI"
            detail="拆分需求和写代码的工具、模型、提示词与来源会保留在这里。"
          />
        ))}
    </section>
  );
}
function GeneratedCode({ run }: { run: Run | null }) {
  const versions = run?.code_versions || [];
  const [index, setIndex] = useState(Math.max(0, versions.length - 1));
  const [side, setSide] = useState<"ros" | "esp32">("ros");
  const [showDiff, setShowDiff] = useState(false);
  const [baseline, setBaseline] = useState<Record<string, unknown> | null>(
    null,
  );
  const [baselineError, setBaselineError] = useState("");
  const baselineId = String(
    versions[index]?.baseline_run_id || run?.previous_run_id || "",
  );
  useEffect(() => {
    setBaseline(null);
    setBaselineError("");
    if (
      !baselineId ||
      index !== 0 ||
      typeof versions[index]?.baseline_code === "string"
    )
      return;
    let live = true;
    api<Run>(`/runs/${encodeURIComponent(baselineId)}`)
      .then((previous) => {
        if (live) setBaseline(previous.code_versions.at(-1) || null);
      })
      .catch((error) => {
        if (live) setBaselineError(error.message);
      });
    return () => {
      live = false;
    };
  }, [baselineId, index]);
  useEffect(() => {
    setIndex(Math.max(0, versions.length - 1));
  }, [versions.length]);
  const version = versions[index];
  if (!version)
    return (
      <Empty
        text="两端代码还没有生成"
        detail="这里保留每次生成或修复的 Python 与 C++ 原文。"
      />
    );
  const code = side === "ros" ? version.code : version.firmware_code;
  const previous =
    index > 0
      ? versions[index - 1]
      : typeof version.baseline_code === "string"
        ? {
            code: version.baseline_code,
            firmware_code: version.baseline_firmware_code,
          }
        : run?.previous_code_snapshot || baseline;
  const before = side === "ros" ? previous?.code : previous?.firmware_code;
  const diff =
    typeof before === "string" && typeof code === "string"
      ? lineDiff(before, code)
      : null;
  const added = diff?.filter((line) => line.kind === "added").length || 0;
  const removed = diff?.filter((line) => line.kind === "removed").length || 0;
  const rejected =
    version.validation_status === "rejected" || version.status === "rejected";
  return (
    <div className="generated-code">
      <div className="generated-code-toolbar">
        <div className="code-side-selector">
          <button
            className={side === "ros" ? "active" : ""}
            onClick={() => setSide("ros")}
          >
            ROS · Python
          </button>
          <button
            className={side === "esp32" ? "active" : ""}
            onClick={() => setSide("esp32")}
          >
            ESP32 · C++
          </button>
        </div>
        <label>
          生成版本
          <select
            aria-label="选择代码版本"
            value={index}
            onChange={(e) => setIndex(Number(e.target.value))}
          >
            {versions.map((v, i) => (
              <option key={i} value={i}>
                第 {String(v.attempt || i + 1)} 次
                {v.validation_status === "rejected" || v.status === "rejected"
                  ? " · 检查拒绝"
                  : ""}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="ai-label">
        AI 生成 · {side === "ros" ? "algorithm.py" : "device_logic.cpp"} ·
        编译与执行结果另行查看
      </p>
      {rejected && (
        <div className="notice warning">
          这版 AI 源码未通过代码检查，没有当作可执行程序使用。
          {String(
            version.diagnostic ||
              version.validation_error ||
              version.error ||
              "",
          )}
        </div>
      )}
      {baselineError && (
        <div className="notice warning">
          上一轮源码读取失败：{baselineError}
        </div>
      )}
      {index === 0 && baselineId && (
        <p className="field-hint">
          比较来源：运行 {baselineId.slice(0, 8)} 的最后一版保存源码。
        </p>
      )}
      <div className="code-diff-toolbar">
        <button
          className={`button secondary ${!showDiff ? "selected" : ""}`}
          onClick={() => setShowDiff(false)}
        >
          完整源码
        </button>
        <button
          className={`button secondary ${showDiff ? "selected" : ""}`}
          disabled={!diff}
          onClick={() => setShowDiff(true)}
        >
          与上一版比较
        </button>
        {diff ? (
          <span>
            增加 {added} 行 · 删除 {removed} 行
            {!added && !removed ? " · 源码未改动" : ""}
          </span>
        ) : (
          <span>这是当前记录中的第一版，没有可比较的上一版。</span>
        )}
      </div>
      {showDiff && diff ? (
        <div className="code-diff" aria-label="真实源码差异">
          {diff.map((line, i) => (
            <div key={i} className={`diff-line ${line.kind}`}>
              <span className="line-number">{line.before ?? ""}</span>
              <span className="line-number">{line.after ?? ""}</span>
              <span className="diff-sign">
                {line.kind === "added"
                  ? "+"
                  : line.kind === "removed"
                    ? "−"
                    : " "}
              </span>
              <code>{line.text || " "}</code>
            </div>
          ))}
        </div>
      ) : typeof code === "string" && code ? (
        <pre>{code}</pre>
      ) : (
        <div className="empty-state compact">
          这份历史记录没有保存 {side === "ros" ? "Python" : "C++"}{" "}
          生成片段，请在“生成文件”中查看当时的完整工程。
        </div>
      )}
      {typeof version.explanation === "string" && version.explanation && (
        <details>
          <summary>AI 对这次改动的说明</summary>
          <p>{version.explanation}</p>
        </details>
      )}
    </div>
  );
}
function Empty({
  text,
  detail,
  icon,
}: {
  text: string;
  detail: string;
  icon?: string;
}) {
  return (
    <div className="empty-state compact">
      {icon === "log" ? <Terminal size={29} /> : <BracketsCurly size={29} />}
      <h3>{text}</h3>
      <p>{detail}</p>
    </div>
  );
}
