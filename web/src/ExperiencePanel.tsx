import { useEffect, useState } from "react";
import { BookOpenText, CircleNotch } from "@phosphor-icons/react";
import { api, printable, type Run } from "./api";

interface Experience {
  run_id: string;
  kind: "success" | "failure" | "repair";
  title: string;
  summary: string;
  applicability: {
    task_type: string;
    board: string;
    ros_distro: string;
    version: string;
    robot_model?: string;
    source_model_sha256?: string;
  };
  result: {
    passed: boolean;
    total_checks: number;
    passed_checks: number;
    failed_checks: unknown[];
    firmware_compiled: boolean;
    communication_verified: boolean;
  };
  code_versions: {
    attempt: number;
    ros_sha256: string;
    esp32_sha256: string;
    ros_excerpt: string;
    esp32_excerpt: string;
  }[];
  evidence: { label: string; path: string }[];
  repair_baselines?: unknown[];
  physical_verified: false;
  publishable: boolean;
  preview_hash: string;
  published_document_id?: string | null;
  notice: string;
  integrity?: { verified: boolean; mode: string; notice: string };
}

export default function ExperiencePanel({ run }: { run: Run }) {
  const [open, setOpen] = useState(false);
  const [item, setItem] = useState<Experience | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [checked, setChecked] = useState(false);
  const [published, setPublished] = useState(false);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setBusy(true);
    setError("");
    setChecked(false);
    api<Experience>(`/runs/${run.id}/experience`)
      .then((value) => {
        if (live) {
          setItem(value);
          setPublished(!!value.published_document_id);
        }
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
  }, [open, run.id, run.status]);
  return (
    <section className="experience-panel">
      <div className="section-intro">
        <div>
          <h3>把这轮结果留给下一次</h3>
          <p>先核对适用范围和证据，再存入资料库；成功、失败与修复分别标记。</p>
        </div>
        <button
          className="button secondary"
          onClick={() => setOpen((value) => !value)}
        >
          <BookOpenText size={17} />
          {open ? "收起经验" : "查看并保存经验"}
        </button>
      </div>
      {open && (
        <div className="experience-content">
          {busy && (
            <p>
              <CircleNotch className="spin" size={18} />
              正在读取记录…
            </p>
          )}
          {error && (
            <div className="notice warning" role="alert">
              {error}
            </div>
          )}
          {item && (
            <>
              <div className="experience-kind">
                {
                  {
                    success: "通过记录",
                    failure: "失败教训",
                    repair: "修复与复测",
                  }[item.kind]
                }{" "}
                · 实物未验证
              </div>
              <h3>{item.title}</h3>
              <p>{item.summary}</p>
              <dl>
                <div>
                  <dt>适用板型</dt>
                  <dd>
                    {item.applicability.board.toUpperCase()} · ROS{" "}
                    {item.applicability.ros_distro}
                  </dd>
                </div>
                <div>
                  <dt>适用任务</dt>
                  <dd>
                    {item.applicability.task_type === "joint_position"
                      ? "关节位置控制"
                      : "传感器触发"}
                  </dd>
                </div>
                <div>
                  <dt>检查记录</dt>
                  <dd>
                    {item.result.passed_checks} / {item.result.total_checks}{" "}
                    项通过
                  </dd>
                </div>
              </dl>
              <p className="field-hint">{item.notice}</p>
              {item.integrity?.notice && (
                <p className="field-hint">{item.integrity.notice}</p>
              )}
              {!!item.result.failed_checks?.length && (
                <details>
                  <summary>失败项</summary>
                  <pre>{printable(item.result.failed_checks)}</pre>
                </details>
              )}
              <details>
                <summary>源码版本和证据</summary>
                <pre>
                  {printable({
                    applicability: item.applicability,
                    code_versions: item.code_versions.map(
                      ({ ros_excerpt, esp32_excerpt, ...version }) => version,
                    ),
                    repair_baselines: item.repair_baselines || [],
                    evidence: item.evidence,
                  })}
                </pre>
                {item.code_versions.some(
                  (version) => version.ros_excerpt || version.esp32_excerpt,
                ) && (
                  <div className="ai-content">
                    <p className="ai-label">
                      以下程序摘录来自本轮 AI 生成源码 ·
                      工具和提示词见页面下方“AI 记录” · 摘录不包含完整驱动
                    </p>
                    {item.code_versions.map((version) => (
                      <div key={version.attempt}>
                        <strong>第 {version.attempt} 次保存</strong>
                        {version.ros_excerpt && (
                          <pre>{version.ros_excerpt}</pre>
                        )}
                        {version.esp32_excerpt && (
                          <pre>{version.esp32_excerpt}</pre>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </details>
              {published ? (
                <div className="notice success">
                  已存入资料库。后续匹配任务可查到此记录；如不再适用，可在资料库移除。已有运行引用不会改变。
                </div>
              ) : (
                <>
                  <label className="import-confirm">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={busy || !item.publishable}
                      onChange={(e) => setChecked(e.target.checked)}
                    />
                    已核对范围、代码和结果，允许后续匹配任务作为参考
                  </label>
                  <button
                    className="button primary"
                    disabled={busy || !checked || !item.publishable}
                    onClick={async () => {
                      setBusy(true);
                      setError("");
                      try {
                        await api(`/runs/${run.id}/experience`, {
                          confirm: true,
                          preview_hash: item.preview_hash,
                        });
                        setPublished(true);
                        setChecked(false);
                      } catch (e) {
                        setError((e as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    核对后存入资料库
                  </button>
                  {!item.publishable && (
                    <p className="field-hint">
                      这份记录暂不满足入库条件，请查看上方说明。
                    </p>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
