import { useI18n } from "./i18n";
import { t } from "./localeStore.ts";
import "./i18nPanels";
import { useEffect, useRef, useState } from "react";
import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  Title,
  Tooltip,
  Legend,
  CategoryScale,
} from "chart.js";
import {
  CheckCircle,
  CircleNotch,
  DownloadSimple,
  Flask,
  Info,
  Play,
  WarningCircle,
  Wrench,
} from "@phosphor-icons/react";
import { isPublicDemo, printable, type Run } from "./api";
import { recordDownloadUrl } from "./demoDownload";
import ChecksView, { engineName, espStatus } from "./ChecksView";
import { StructureReplay } from "./StructurePanel";
import ModelIdentity from "./ModelIdentity";
import { deploymentConfirmationKey } from "./codeDiff";
import ExperiencePanel from "./ExperiencePanel";
import { motionCaseSummary, motionCaseCheckLabel } from "./motionResults";
Chart.register(
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  Title,
  Tooltip,
  Legend,
  CategoryScale,
);

export default function ResultPanel({
  run,
  busy,
  onRepair,
  onDeploy,
  dirty,
  onSaveAndPlan,
}: {
  run: Run | null;
  busy: boolean;
  onRepair: () => void;
  onDeploy: () => void;
  dirty: boolean;
  onSaveAndPlan: () => void;
}) {
  useI18n();
  const [confirmedKey, setConfirmedKey] = useState<string | null>(null);
  const confirmationKey = deploymentConfirmationKey(run);
  const confirmed = !!confirmationKey && confirmedKey === confirmationKey;
  useEffect(() => setConfirmedKey(null), [confirmationKey, dirty, run?.status]);
  const result = run?.result;
  const deploymentResult = run?.deployment?.result as Run["result"] | undefined;
  const deploymentChecks = deploymentResult?.checks || [];
  return (
    <section className="panel result-panel">
      <header className="panel-heading">
        <Flask size={24} />
        <div>
          <h2>{t("运行与评估")}</h2>
          <p>
            {isPublicDemo
              ? t(
                  "展示已有本机执行记录；当前网页没有再次运行。编译通过与实物验证分别记录。",
                )
              : t("结果来自实际执行。编译通过与实物验证分别记录。")}
          </p>
        </div>
        {run && (
          <a
            className="button secondary"
            href={recordDownloadUrl(run)}
            download={isPublicDemo ? "AE-公开示例记录.json" : undefined}
          >
            <DownloadSimple size={17} />
            {isPublicDemo ? t("下载公开示例记录") : t("导出工程")}
          </a>
        )}
      </header>
      {dirty && run && (
        <div className="notice warning">
          <WarningCircle size={19} />
          <div>
            <strong>{t("需求有尚未保存的修改")}</strong>
            <p>{t("这里是原保存版本的结果，不能据此重试或部署新需求。")}</p>
            <button
              className="button secondary"
              disabled={busy}
              onClick={onSaveAndPlan}
            >
              {t("保存修改并重新拆分")}
            </button>
          </div>
        </div>
      )}
      {run && (
        <p className="run-spec-note">
          {t("当前查看：规格 v")}
          {run.spec_snapshot?.spec_revision} · {run.spec_snapshot?.name}{" "}
          {t("· 运行")} {run.id.slice(0, 8)}
        </p>
      )}
      {!result ? (
        <div className="empty-state">
          <Flask size={32} />
          <h3>{run ? t("等待这轮检查结果") : t("还没有运行结果")}</h3>
          <p>
            {isPublicDemo
              ? t("浏览器草稿没有运行结果，可选择左侧公开示例查看历史验收。")
              : run
                ? t("日志会记录编译、启动和检查过程。")
                : t("核对拆分结果后，生成程序并开始第一轮检查。")}
          </p>
          {run?.error && <div className="notice warning">{run.error}</div>}
        </div>
      ) : (
        <>
          <div className={`result-summary ${result.passed ? "good" : "bad"}`}>
            {result.passed ? (
              <CheckCircle size={27} />
            ) : (
              <WarningCircle size={27} />
            )}
            <div>
              <strong>
                {result.passed
                  ? t("本轮运行检查通过")
                  : t("本轮运行检查未通过")}
              </strong>
              <span>{engineName(result.engine || "")}</span>
            </div>
            <span className="run-number">
              {t(`第 ${run?.attempt} 次执行`, `Execution ${run?.attempt}`)}
            </span>
          </div>
          <div className="verification-strip">
            <span>
              {t("ROS 通信")}{" "}
              <strong>
                {result.ros_verified ? t("已验证") : t("未通过 / 未验证")}
              </strong>
            </span>
            <span>
              ESP32{" "}
              <strong>
                {result.firmware
                  ? result.firmware.passed
                    ? t("固件编译通过")
                    : t("固件编译未通过")
                  : espStatus(result.esp32_status || "simulated")}
              </strong>
            </span>
            <span>
              {t("实物")}{" "}
              <strong>
                {result.physical_verified ? t("已验证") : t("未验证")}
              </strong>
            </span>
          </div>
          {run && (
            <ModelIdentity
              spec={run.spec_snapshot}
              actualOrder={result.execution_order}
            />
          )}
          {!!run?.integrity?.fingerprint && (
            <details className="source-details">
              <summary>
                {t("通过版本指纹 ·")} {run.integrity.fingerprint.slice(0, 16)}
              </summary>
              <p>
                {t(
                  "用于确认部署复测采用哪一版源码、模型、协议和工具模板。这项校验不代替实物验收。",
                )}
              </p>
              <pre>{printable(run.integrity)}</pre>
            </details>
          )}
          <div className="execution-evidence">
            <div className={result.firmware?.passed ? "verified" : ""}>
              <h3>{t("ESP32 固件")}</h3>
              <strong>
                {result.firmware
                  ? result.firmware.passed
                    ? t("编译通过")
                    : t("编译未通过")
                  : t("本次没有固件编译记录")}
              </strong>
              <p>
                {result.firmware?.fqbn
                  ? t(
                      `编译目标：${result.firmware.fqbn}`,
                      `Build target: ${result.firmware.fqbn}`,
                    )
                  : t("以后台编译记录为准")}
              </p>
              <small>
                {result.firmware?.core_version
                  ? t(
                      `ESP32 核心 ${result.firmware.core_version} · `,
                      `ESP32 core ${result.firmware.core_version} · `,
                    )
                  : ""}
                {t("未烧录 · 未验证实体引脚")}
              </small>
            </div>
            <div
              className={result.communication_test?.passed ? "verified" : ""}
            >
              <h3>{t("两端通信")}</h3>
              <strong>
                {result.communication_test
                  ? result.communication_test.passed
                    ? t("主机通信测试通过")
                    : t("主机通信测试未通过")
                  : t("本次没有独立通信记录")}
              </strong>
              <p>{t("ROS ↔ 虚拟串口 ↔ 主机运行的固件通信逻辑")}</p>
              <small>{t("不等同于 ESP32 板上通信已验证")}</small>
            </div>
          </div>
          {result.communication_test?.checks?.length ? (
            <details className="source-details">
              <summary>
                {t("查看独立通信检查 ·")}{" "}
                {
                  result.communication_test.checks.filter((x) => x.passed)
                    .length
                }{" "}
                / {result.communication_test.checks.length} {t("通过")}
              </summary>
              <ChecksView checks={result.communication_test.checks} />
            </details>
          ) : null}
          {result.firmware && (
            <details className="source-details">
              <summary>{t("固件编译记录与产物")}</summary>
              <pre>{printable(result.firmware)}</pre>
            </details>
          )}
          {run && <StructureReplay key={run.id} run={run} />}
          {run?.spec_snapshot.task_type === "joint_sequence" ? (
            <MultiJointResults run={run} />
          ) : (
            !!result.series?.length && <Trajectory points={result.series} />
          )}
          {run?.spec_snapshot.task_type === "joint_sequence" && (
            <details className="source-details">
              <summary>
                {t("本轮代码、完整轨迹与构建产物 ·")} {run.artifacts.length}{" "}
                {t("个文件")}
              </summary>
              <p>
                {isPublicDemo
                  ? t(
                      "这是已有示例公开的源码与轨迹清单。可在下方“生成文件”查看；下载的是公开记录，不是新需求的工程。完整项目源码见页面顶部链接。",
                    )
                  : t(
                      "文件与当前运行及冻结规格绑定。上方“导出工程”包含 ROS 工程、固件工程、构建日志和全部运行轨迹；“生成文件”可逐份查看源码。",
                    )}
              </p>
              <ul>
                {run.artifacts.map((file) => (
                  <li key={file.path}>
                    <code>{file.path}</code> · {(file.size / 1024).toFixed(1)}{" "}
                    KB
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div className="check-list">
            <ChecksView checks={result.checks || []} />
          </div>
          {!!result.metrics && (
            <details className="source-details">
              <summary>
                {isPublicDemo ? t("公开检查记录") : t("原始检查记录")}
              </summary>
              <pre>
                {printable({
                  ...result,
                  series: t(
                    `${result.series?.length || 0} 个采样点，完整数据见生成文件`,
                    `${result.series?.length || 0} samples; see generated files for complete data`,
                  ),
                })}
              </pre>
            </details>
          )}
        </>
      )}
      {run?.error && result && (
        <div className="notice warning">
          <WarningCircle size={19} />
          <span>{run.error}</span>
        </div>
      )}
      {!isPublicDemo &&
        run &&
        ["failed", "cancelled", "interrupted"].includes(run.status) && (
          <div className="form-actions">
            <p>{t("用这轮记录修改程序，保留原来的验收标准。")}</p>
            <button
              className="button primary"
              disabled={busy || dirty}
              onClick={onRepair}
            >
              <Wrench size={17} />
              {run.status === "failed" ? t("修改并重试") : t("重新执行")}
            </button>
          </div>
        )}
      {!isPublicDemo &&
        run?.status === "passed" &&
        !run.integrity?.fingerprint && (
          <div className="notice warning">
            {t(
              "这份历史记录没有通过版本指纹，可以查看和导出；重新生成并检查后才能部署复测。",
            )}
          </div>
        )}
      {!isPublicDemo &&
        run?.status === "passed" &&
        !!run.integrity?.fingerprint && (
          <div className="approval-box">
            <label>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) =>
                  setConfirmedKey(e.target.checked ? confirmationKey : null)
                }
              />
              <span>
                {t("已检查规格 v")}
                {run.spec_snapshot?.spec_revision}{" "}
                {t("的结果，同意在本机隔离 ROS 环境中部署复测")}
                <small>
                  {t("运行")} {run.id.slice(0, 8)} {t("· 版本指纹")}{" "}
                  {run.integrity.fingerprint.slice(0, 12)}{" "}
                  {t("· 只运行模拟设备，不连接实物或烧录 ESP32")}
                </small>
              </span>
            </label>
            <button
              className="button primary"
              disabled={!confirmed || busy || dirty}
              onClick={() => {
                if (confirmedKey === confirmationKey && !dirty) onDeploy();
              }}
            >
              {busy ? (
                <CircleNotch className="spin" size={17} />
              ) : (
                <Play size={17} />
              )}
              {t("部署并复测")}
            </button>
          </div>
        )}
      {!!run?.deployment && (
        <div className="deployment-record">
          <div
            className={`notice ${deploymentResult?.passed ? "success" : deploymentResult ? "warning" : ""}`}
          >
            {deploymentResult?.passed ? (
              <CheckCircle size={19} />
            ) : (
              <Info size={19} />
            )}
            <div>
              <strong>{t("本机部署复测")}</strong>
              <p>
                {deploymentResult
                  ? t(
                      `${deploymentChecks.filter((check) => check.passed).length} / ${deploymentChecks.length} 项通过`,
                      `${deploymentChecks.filter((check) => check.passed).length} / ${deploymentChecks.length} passed`,
                    )
                  : t("等待检查结果")}{" "}
                {t("· 模拟设备")}
              </p>
            </div>
          </div>
          <details className="source-details">
            <summary>{t("原始部署记录")}</summary>
            <pre>{printable(run.deployment)}</pre>
          </details>
        </div>
      )}
      {!isPublicDemo &&
        run &&
        ["passed", "failed", "cancelled", "interrupted", "deployed"].includes(
          run.status,
        ) && <ExperiencePanel key={run.id} run={run} />}
    </section>
  );
}
function Trajectory({
  points,
  title = "运行轨迹",
}: {
  points: NonNullable<Run["result"]>["series"];
  title?: string;
}) {
  const { locale } = useI18n();
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!canvas.current) return;
    const chart = new Chart(canvas.current, {
      type: "line",
      data: {
        labels: points.map((p) => p.time.toFixed(2)),
        datasets: [
          {
            label: t("实际值（实线）"),
            data: points.map((p) => p.value),
            borderColor: "#002fa7",
            backgroundColor: "#002fa7",
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.15,
          },
          {
            label: t("目标 / 阈值（虚线）"),
            data: points.map((p) => p.target),
            borderColor: "#188038",
            backgroundColor: "#188038",
            borderDash: [5, 5],
            borderWidth: 1.8,
            pointRadius: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: {
            align: "end",
            labels: {
              color: "#5f6368",
              usePointStyle: true,
              pointStyle: "line",
              font: {
                family: "system-ui, Segoe UI, Microsoft YaHei",
                size: 12,
              },
            },
          },
          tooltip: {
            backgroundColor: "#ffffff",
            titleColor: "#202124",
            bodyColor: "#5f6368",
            borderColor: "#e3e7ef",
            borderWidth: 1,
            padding: 12,
          },
        },
        scales: {
          x: {
            ticks: { color: "#5f6368", maxTicksLimit: 6 },
            grid: { color: "#e3e7ef" },
            border: { color: "#e3e7ef" },
            title: { display: true, text: t("时间（s）"), color: "#5f6368" },
          },
          y: {
            ticks: { color: "#5f6368" },
            grid: { color: "#e3e7ef" },
            border: { color: "#e3e7ef" },
          },
        },
      },
    });
    return () => chart.destroy();
  }, [points, locale]);
  return (
    <div className="trajectory">
      <h3>{t(title)}</h3>
      <div>
        <canvas
          ref={canvas}
          aria-label={t(
            `${title}：实际运行值与目标值随时间变化的曲线`,
            `${t(title)}: measured values and targets over time`,
          )}
          role="img"
        />
      </div>
    </div>
  );
}

// Keep raw check classifications intact; localize only the presentation fields.
function localizedMotionCaseSummary(
  name: string,
  checks: Parameters<typeof motionCaseSummary>[1],
) {
  const summary = motionCaseSummary(name, checks);
  const normal = /^motion_([1-3])$/.exec(name);
  const label = normal
    ? t(summary.label, `Normal action ${normal[1]}`)
    : summary.kind === "unknown"
      ? t(summary.label, `Other check: ${name || t("未记录")}`)
      : t(summary.label);
  return { ...summary, label, outcome: t(summary.outcome) };
}
function localizedMotionCaseCheckLabel(
  name: string,
  check: Parameters<typeof motionCaseCheckLabel>[1],
) {
  const label = motionCaseCheckLabel(name, check);
  return label.startsWith("检查项 ")
    ? t(label, `Check ${check.name.slice(name.length + 1)}`)
    : t(label);
}

function MultiJointResults({ run }: { run: Run }) {
  useI18n();
  const result = run.result!;
  const names =
    result.motion_program?.joint_names ||
    run.spec_snapshot.prd?.intake?.motion_plan?.joint_names ||
    [];
  const samples = (result.series || []).filter((point) => !!point.positions);
  const cases = Array.isArray(result.metrics?.cases)
    ? (result.metrics.cases as Record<string, unknown>[])
    : [];
  const stages = samples.filter(
    (point, index) =>
      index === 0 ||
      point.stage_id !== samples[index - 1].stage_id ||
      point.cycle_index !== samples[index - 1].cycle_index,
  );
  return (
    <section aria-label={t("全组关节动作实际结果")}>
      <h3>{t("全组关节的实际动作与往返次数")}</h3>
      <p className="field-hint">
        {t(
          "曲线来自第一轮正常运行的实际位置采样。每个关节分别显示，其他运行与计划中断测试见完整轨迹文件；发送了目标不表示已经到位。停机测试故意中断动作，不要求做完整套招手。",
        )}
      </p>
      {!!cases.length && (
        <div className="motion-table-scroll">
          <table className="motion-table">
            <thead>
              <tr>
                <th>{t("实际运行")}</th>
                <th>{t("本场景检查结果")}</th>
                <th>{t("到位姿势")}</th>
                <th>{t("实际 / 要求往返次数")}</th>
                <th>{t("最后反馈时刻（仿真秒）")}</th>
                <th>{t("完整数据")}</th>
              </tr>
            </thead>
            <tbody>
              {cases.map((item, index) => {
                const summary = localizedMotionCaseSummary(
                  String(item.name ?? ""),
                  result.checks || [],
                );
                return (
                  <tr key={index}>
                    <td>{summary.label}</td>
                    <td>{summary.outcome}</td>
                    <td>
                      {summary.kind === "normal"
                        ? `${String(item.waypoints_reached ?? t("未记录"))} / ${String(item.total_waypoints ?? t("未记录"))}`
                        : summary.kind === "stop"
                          ? t("不适用（停机测试）")
                          : t("检查类型待确认")}
                    </td>
                    <td>
                      {summary.kind === "normal"
                        ? `${String(item.completed_cycles ?? t("未记录"))} / ${String(item.expected_cycles ?? t("未记录"))}`
                        : summary.kind === "stop"
                          ? t("不适用（停机测试）")
                          : t("检查类型待确认")}
                    </td>
                    <td>
                      {String(item.duration_s ?? t("未记录"))} s
                      {summary.name === "measurement_loss" && (
                        <small>{t("测量中断后反馈时间戳冻结")}</small>
                      )}
                    </td>
                    <td>
                      <code>{String(item.trace_file ?? t("未记录"))}</code>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {!!cases.length && (
        <p className="field-hint">
          {t(
            "最后反馈时刻按每轮动作的仿真时间从 0 计数，表示采样记录到了哪里；停止反馈测量后时间戳会冻结。它不表示整个停机场景在现实中耗费了多少秒。",
          )}
        </p>
      )}
      {cases.map((item, caseIndex) => {
        const summary = localizedMotionCaseSummary(
          String(item.name ?? ""),
          result.checks || [],
        );
        if (summary.kind !== "normal")
          return (
            <details
              className="source-details"
              key={caseIndex}
              open={summary.passed !== true}
            >
              <summary>
                {summary.label} ·{" "}
                {summary.kind === "stop" ? t("停机/取消检查") : t("本场景检查")}
              </summary>
              <p>
                {summary.outcome}。
                {summary.kind === "stop" &&
                  t(
                    "本场景核对中断后的停机或取消行为，不以完成招手次数为标准。",
                  )}
              </p>
              {summary.checks.length ? (
                <ul>
                  {summary.checks.map((check) => (
                    <li key={check.name}>
                      <strong>
                        {localizedMotionCaseCheckLabel(summary.name, check)}:
                        {check.passed === true ? t("通过") : t("未通过")}
                      </strong>
                      <details>
                        <summary>{t("查看实际检查依据")}</summary>
                        <pre>{printable(check.detail)}</pre>
                      </details>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>{t("本场景没有可核对的检查记录。")}</p>
              )}
            </details>
          );
        const waypoints = Array.isArray(item.waypoints)
          ? (item.waypoints as Record<string, unknown>[])
          : [];
        return waypoints.length ? (
          <details className="source-details" key={caseIndex}>
            <summary>
              {summary.label} {t("· 各姿势实际到位检查")}
            </summary>
            <p>
              {t(
                "按约定路点时间附近的实际反馈计算全部参与关节最大位置误差，并与冻结容差比较；计划阶段随时间变化不表示已经到位。",
              )}
            </p>
            <div className="motion-table-scroll">
              <table className="motion-table">
                <thead>
                  <tr>
                    <th>{t("路点")}</th>
                    <th>{t("计划阶段 / 往返编号")}</th>
                    <th>{t("全部关节最大位置误差 (rad)")}</th>
                    <th>{t("实际到位检查")}</th>
                  </tr>
                </thead>
                <tbody>
                  {waypoints.map((point, index) => (
                    <tr key={index}>
                      <td>
                        {typeof point.index === "number"
                          ? point.index + 1
                          : index + 1}
                      </td>
                      <td>
                        {String(point.stage_id ?? t("未记录"))} /{" "}
                        {String(point.cycle_index ?? t("未记录"))}
                      </td>
                      <td>
                        {typeof point.max_position_error_rad === "number" &&
                        Number.isFinite(point.max_position_error_rad)
                          ? point.max_position_error_rad.toFixed(5)
                          : t("缺少检查窗口内反馈")}
                      </td>
                      <td>
                        {point.passed === true
                          ? t("通过")
                          : point.passed === false
                            ? t("未通过")
                            : t("未记录")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        ) : null;
      })}
      {!samples.length ? (
        <div className="notice warning">
          {t(
            "本轮没有全组关节实际采样，无法显示多关节曲线或回放。不会使用单条标量曲线代表整套动作。",
          )}
        </div>
      ) : (
        <>
          <div className="motion-table-scroll">
            <table className="motion-table">
              <thead>
                <tr>
                  <th>{t("采样时对应的计划阶段")}</th>
                  <th>{t("计划往返编号")}</th>
                  <th>{t("时间 (s)")}</th>
                  {names.map((name) => (
                    <th key={name}>
                      {name} {t("实际角度 (rad)")}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stages.map((point, index) => (
                  <tr key={index}>
                    <td>{point.stage_id || t("未记录")}</td>
                    <td>{point.cycle_index ?? t("未记录")}</td>
                    <td>{(point.t ?? point.time).toFixed(2)}</td>
                    {names.map((name) => (
                      <td key={name}>
                        {point.positions?.[name]?.toFixed(4) ?? t("缺少反馈")}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {names.map((name) => {
            const points = samples
              .filter(
                (point) =>
                  Number.isFinite(point.positions?.[name]) &&
                  Number.isFinite(point.targets?.[name]),
              )
              .map((point) => ({
                time: point.t ?? point.time,
                value: point.positions![name],
                target: point.targets![name],
                command: point.velocities?.[name] ?? 0,
              }));
            return points.length ? (
              <Trajectory
                key={name}
                title={t(
                  `${name} · 实际 / 目标角度 (rad)`,
                  `${name} · measured / target angle (rad)`,
                )}
                points={points}
              />
            ) : (
              <p className="notice warning" key={name}>
                {name} {t("缺少实际位置或目标采样，无法绘图。")}
              </p>
            );
          })}
        </>
      )}
    </section>
  );
}
