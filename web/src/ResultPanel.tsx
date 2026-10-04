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
import { printable, type Run } from "./api";
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
          <h2>运行与评估</h2>
          <p>结果来自实际执行。编译通过与实物验证分别记录。</p>
        </div>
        {run && (
          <a className="button secondary" href={`/api/runs/${run.id}/export`}>
            <DownloadSimple size={17} />
            导出工程
          </a>
        )}
      </header>
      {dirty && run && (
        <div className="notice warning">
          <WarningCircle size={19} />
          <div>
            <strong>需求有尚未保存的修改</strong>
            <p>这里是原保存版本的结果，不能据此重试或部署新需求。</p>
            <button
              className="button secondary"
              disabled={busy}
              onClick={onSaveAndPlan}
            >
              保存修改并重新拆分
            </button>
          </div>
        </div>
      )}
      {run && (
        <p className="run-spec-note">
          当前查看：规格 v{run.spec_snapshot?.spec_revision} ·{" "}
          {run.spec_snapshot?.name} · 运行 {run.id.slice(0, 8)}
        </p>
      )}
      {!result ? (
        <div className="empty-state">
          <Flask size={32} />
          <h3>{run ? "等待这轮检查结果" : "还没有运行结果"}</h3>
          <p>
            {run
              ? "日志会记录编译、启动和检查过程。"
              : "核对拆分结果后，生成程序并开始第一轮检查。"}
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
                {result.passed ? "本轮运行检查通过" : "本轮运行检查未通过"}
              </strong>
              <span>{engineName(result.engine || "")}</span>
            </div>
            <span className="run-number">第 {run?.attempt} 次执行</span>
          </div>
          <div className="verification-strip">
            <span>
              ROS 通信{" "}
              <strong>
                {result.ros_verified ? "已验证" : "未通过 / 未验证"}
              </strong>
            </span>
            <span>
              ESP32{" "}
              <strong>
                {result.firmware
                  ? result.firmware.passed
                    ? "固件编译通过"
                    : "固件编译未通过"
                  : espStatus(result.esp32_status || "simulated")}
              </strong>
            </span>
            <span>
              实物{" "}
              <strong>{result.physical_verified ? "已验证" : "未验证"}</strong>
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
                通过版本指纹 · {run.integrity.fingerprint.slice(0, 16)}
              </summary>
              <p>
                用于确认部署复测采用哪一版源码、模型、协议和工具模板。这项校验不代替实物验收。
              </p>
              <pre>{printable(run.integrity)}</pre>
            </details>
          )}
          <div className="execution-evidence">
            <div className={result.firmware?.passed ? "verified" : ""}>
              <h3>ESP32 固件</h3>
              <strong>
                {result.firmware
                  ? result.firmware.passed
                    ? "编译通过"
                    : "编译未通过"
                  : "本次没有固件编译记录"}
              </strong>
              <p>
                {result.firmware?.fqbn
                  ? `编译目标：${result.firmware.fqbn}`
                  : "以后台编译记录为准"}
              </p>
              <small>
                {result.firmware?.core_version
                  ? `ESP32 核心 ${result.firmware.core_version} · `
                  : ""}
                未烧录 · 未验证实体引脚
              </small>
            </div>
            <div
              className={result.communication_test?.passed ? "verified" : ""}
            >
              <h3>两端通信</h3>
              <strong>
                {result.communication_test
                  ? result.communication_test.passed
                    ? "主机通信测试通过"
                    : "主机通信测试未通过"
                  : "本次没有独立通信记录"}
              </strong>
              <p>ROS ↔ 虚拟串口 ↔ 主机运行的固件通信逻辑</p>
              <small>不等同于 ESP32 板上通信已验证</small>
            </div>
          </div>
          {result.communication_test?.checks?.length ? (
            <details className="source-details">
              <summary>
                查看独立通信检查 ·{" "}
                {
                  result.communication_test.checks.filter((x) => x.passed)
                    .length
                }{" "}
                / {result.communication_test.checks.length} 通过
              </summary>
              <ChecksView checks={result.communication_test.checks} />
            </details>
          ) : null}
          {result.firmware && (
            <details className="source-details">
              <summary>固件编译记录与产物</summary>
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
                本轮代码、完整轨迹与构建产物 · {run.artifacts.length} 个文件
              </summary>
              <p>
                文件与当前运行及冻结规格绑定。上方“导出工程”包含 ROS
                工程、固件工程、构建日志和全部运行轨迹；“生成文件”可逐份查看源码。
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
              <summary>原始检查记录</summary>
              <pre>
                {printable({
                  ...result,
                  series: `${result.series?.length || 0} 个采样点，完整数据见生成文件`,
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
      {run && ["failed", "cancelled", "interrupted"].includes(run.status) && (
        <div className="form-actions">
          <p>用这轮记录修改程序，保留原来的验收标准。</p>
          <button
            className="button primary"
            disabled={busy || dirty}
            onClick={onRepair}
          >
            <Wrench size={17} />
            {run.status === "failed" ? "修改并重试" : "重新执行"}
          </button>
        </div>
      )}
      {run?.status === "passed" && !run.integrity?.fingerprint && (
        <div className="notice warning">
          这份历史记录没有通过版本指纹，可以查看和导出；重新生成并检查后才能部署复测。
        </div>
      )}
      {run?.status === "passed" && !!run.integrity?.fingerprint && (
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
              已检查规格 v{run.spec_snapshot?.spec_revision}{" "}
              的结果，同意在本机隔离 ROS 环境中部署复测
              <small>
                运行 {run.id.slice(0, 8)} · 版本指纹{" "}
                {run.integrity.fingerprint.slice(0, 12)} ·
                只运行模拟设备，不连接实物或烧录 ESP32
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
            部署并复测
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
              <strong>本机部署复测</strong>
              <p>
                {deploymentResult
                  ? `${deploymentChecks.filter((check) => check.passed).length} / ${deploymentChecks.length} 项通过`
                  : "等待检查结果"}{" "}
                · 模拟设备
              </p>
            </div>
          </div>
          <details className="source-details">
            <summary>原始部署记录</summary>
            <pre>{printable(run.deployment)}</pre>
          </details>
        </div>
      )}
      {run &&
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
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!canvas.current) return;
    const chart = new Chart(canvas.current, {
      type: "line",
      data: {
        labels: points.map((p) => p.time.toFixed(2)),
        datasets: [
          {
            label: "实际值",
            data: points.map((p) => p.value),
            borderColor: "#ed634b",
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.15,
          },
          {
            label: "目标 / 阈值",
            data: points.map((p) => p.target),
            borderColor: "#9aa6b0",
            borderDash: [5, 5],
            borderWidth: 1.3,
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
              color: "#a3aeb7",
              usePointStyle: true,
              pointStyle: "line",
              font: { family: "Segoe UI, Microsoft YaHei", size: 11 },
            },
          },
        },
        scales: {
          x: {
            ticks: { color: "#7f8c96", maxTicksLimit: 6 },
            grid: { color: "#22292e" },
            title: { display: true, text: "时间（s）", color: "#8e99a3" },
          },
          y: { ticks: { color: "#7f8c96" }, grid: { color: "#22292e" } },
        },
      },
    });
    return () => chart.destroy();
  }, [points]);
  return (
    <div className="trajectory">
      <h3>{title}</h3>
      <div>
        <canvas
          ref={canvas}
          aria-label={`${title}：实际运行值与目标值随时间变化的曲线`}
          role="img"
        />
      </div>
    </div>
  );
}

function MultiJointResults({ run }: { run: Run }) {
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
    <section aria-label="全组关节动作实际结果">
      <h3>全组关节的实际动作与往返次数</h3>
      <p className="field-hint">
        曲线来自第一轮正常运行的实际位置采样。每个关节分别显示，其他运行与计划中断测试见完整轨迹文件；发送了目标不表示已经到位。停机测试故意中断动作，不要求做完整套招手。
      </p>
      {!!cases.length && (
        <div className="motion-table-scroll">
          <table className="motion-table">
            <thead>
              <tr>
                <th>实际运行</th>
                <th>本场景检查结果</th>
                <th>到位姿势</th>
                <th>实际 / 要求往返次数</th>
                <th>最后反馈时刻（仿真秒）</th>
                <th>完整数据</th>
              </tr>
            </thead>
            <tbody>
              {cases.map((item, index) => {
                const summary = motionCaseSummary(
                  String(item.name ?? ""),
                  result.checks || [],
                );
                return (
                  <tr key={index}>
                    <td>{summary.label}</td>
                    <td>{summary.outcome}</td>
                    <td>
                      {summary.kind === "normal"
                        ? `${String(item.waypoints_reached ?? "未记录")} / ${String(item.total_waypoints ?? "未记录")}`
                        : summary.kind === "stop"
                          ? "不适用（停机测试）"
                          : "检查类型待确认"}
                    </td>
                    <td>
                      {summary.kind === "normal"
                        ? `${String(item.completed_cycles ?? "未记录")} / ${String(item.expected_cycles ?? "未记录")}`
                        : summary.kind === "stop"
                          ? "不适用（停机测试）"
                          : "检查类型待确认"}
                    </td>
                    <td>
                      {String(item.duration_s ?? "未记录")} s
                      {summary.name === "measurement_loss" && (
                        <small>测量中断后反馈时间戳冻结</small>
                      )}
                    </td>
                    <td>
                      <code>{String(item.trace_file ?? "未记录")}</code>
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
          最后反馈时刻按每轮动作的仿真时间从 0
          计数，表示采样记录到了哪里；停止反馈测量后时间戳会冻结。它不表示整个停机场景在现实中耗费了多少秒。
        </p>
      )}
      {cases.map((item, caseIndex) => {
        const summary = motionCaseSummary(
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
                {summary.kind === "stop" ? "停机/取消检查" : "本场景检查"}
              </summary>
              <p>
                {summary.outcome}。
                {summary.kind === "stop" &&
                  "本场景核对中断后的停机或取消行为，不以完成招手次数为标准。"}
              </p>
              {summary.checks.length ? (
                <ul>
                  {summary.checks.map((check) => (
                    <li key={check.name}>
                      <strong>
                        {motionCaseCheckLabel(summary.name, check)}：
                        {check.passed === true ? "通过" : "未通过"}
                      </strong>
                      <details>
                        <summary>查看实际检查依据</summary>
                        <pre>{printable(check.detail)}</pre>
                      </details>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>本场景没有可核对的检查记录。</p>
              )}
            </details>
          );
        const waypoints = Array.isArray(item.waypoints)
          ? (item.waypoints as Record<string, unknown>[])
          : [];
        return waypoints.length ? (
          <details className="source-details" key={caseIndex}>
            <summary>{summary.label} · 各姿势实际到位检查</summary>
            <p>
              按约定路点时间附近的实际反馈计算全部参与关节最大位置误差，并与冻结容差比较；计划阶段随时间变化不表示已经到位。
            </p>
            <div className="motion-table-scroll">
              <table className="motion-table">
                <thead>
                  <tr>
                    <th>路点</th>
                    <th>计划阶段 / 往返编号</th>
                    <th>全部关节最大位置误差 (rad)</th>
                    <th>实际到位检查</th>
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
                        {String(point.stage_id ?? "未记录")} /{" "}
                        {String(point.cycle_index ?? "未记录")}
                      </td>
                      <td>
                        {typeof point.max_position_error_rad === "number" &&
                        Number.isFinite(point.max_position_error_rad)
                          ? point.max_position_error_rad.toFixed(5)
                          : "缺少检查窗口内反馈"}
                      </td>
                      <td>
                        {point.passed === true
                          ? "通过"
                          : point.passed === false
                            ? "未通过"
                            : "未记录"}
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
          本轮没有全组关节实际采样，无法显示多关节曲线或回放。不会使用单条标量曲线代表整套动作。
        </div>
      ) : (
        <>
          <div className="motion-table-scroll">
            <table className="motion-table">
              <thead>
                <tr>
                  <th>采样时对应的计划阶段</th>
                  <th>计划往返编号</th>
                  <th>时间 (s)</th>
                  {names.map((name) => (
                    <th key={name}>{name} 实际角度 (rad)</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stages.map((point, index) => (
                  <tr key={index}>
                    <td>{point.stage_id || "未记录"}</td>
                    <td>{point.cycle_index ?? "未记录"}</td>
                    <td>{(point.t ?? point.time).toFixed(2)}</td>
                    {names.map((name) => (
                      <td key={name}>
                        {point.positions?.[name]?.toFixed(4) ?? "缺少反馈"}
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
                title={`${name} · 实际 / 目标角度 (rad)`}
                points={points}
              />
            ) : (
              <p className="notice warning" key={name}>
                {name} 缺少实际位置或目标采样，无法绘图。
              </p>
            );
          })}
        </>
      )}
    </section>
  );
}
