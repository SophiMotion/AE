import { useI18n } from "./i18n";
import { t } from "./localeStore.ts";
import "./i18nPanels";
import {
  CheckCircle,
  CircleNotch,
  ClipboardText,
  Info,
  Play,
  WarningCircle,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { isPublicDemo, type Project } from "./api";
import ModelIdentity from "./ModelIdentity";
import ProjectManifest from "./ProjectManifest";
import RequirementCoverage from "./RequirementCoverage";
import MotionPlanEditor from "./MotionPlanEditor";
import { snapshotStructure } from "./modelView";
import { assistSource } from "./intakeAssistant";
import { fromProject } from "./draft";
export default function PlanPanel({
  project,
  environment,
  onApprove,
  onPlan,
  busy,
  dirty,
  onSaveAndPlan,
  communication,
  simulation,
}: {
  project: Project | null;
  environment: Record<string, unknown> | null;
  onApprove: () => void;
  onPlan: () => void;
  busy: boolean;
  dirty: boolean;
  onSaveAndPlan: () => void;
  communication: Record<string, unknown> | null;
  simulation: Record<string, unknown> | null;
}) {
  useI18n();
  const [checked, setChecked] = useState(false);
  const plan = project?.plan;
  const blocked = !isPublicDemo && !!plan?.blocking_issues?.length;
  const motionSource = project
    ? assistSource(
        fromProject(project),
        "prd.intake.motion_plan",
        snapshotStructure(project),
      )
    : null;
  useEffect(() => {
    setChecked(false);
  }, [plan?.plan_id]);
  return (
    <section className="panel plan-panel">
      <header className="panel-heading">
        <ClipboardText size={24} />
        <div>
          <h2>{t("核对拆分结果")}</h2>
          <p>
            {isPublicDemo
              ? t("体验核对两端分工、通信约定和检查条件；实际生成在本机进行。")
              : t("确认两端分工和通信约定，再开始生成、编译。")}
          </p>
        </div>
      </header>
      {dirty && project && (
        <div className="notice warning">
          <WarningCircle size={19} />
          <div>
            <strong>{t("需求有尚未保存的修改")}</strong>
            <p>
              {t(
                "下面仍是旧版拆分，不能用它生成程序。先保存新需求，重新拆分并核对。",
              )}
            </p>
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
      {!plan ? (
        <div className="empty-state">
          <Info size={32} />
          <h3>
            {project?.status === "planning"
              ? t("AI 正在整理需求")
              : project?.error
                ? t("这次拆分没有完成")
                : t("先填写并拆分需求")}
          </h3>
          <p>
            {project?.status === "planning"
              ? t("后台会查询资料，并保存这次使用的提示词和来源。")
              : t("这里将显示 ROS 和 ESP32 各自做什么、双方怎么通信。")}
          </p>
          {project?.error && (
            <div className="notice warning">{project.error}</div>
          )}
          {project?.status === "planning" ? (
            <CircleNotch className="spin" size={23} />
          ) : (
            <button className="button secondary" onClick={onPlan}>
              {t("返回需求")}
            </button>
          )}
        </div>
      ) : (
        <>
          {!plan.plan_id && (
            <div className="notice warning">
              <Info size={19} />
              <div>
                <strong>{t("这份旧拆分需要重新核对")}</strong>
                <p>{t("缺少本轮核对标识，请重新拆分后再确认。")}</p>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={onPlan}
                >
                  {t("返回需求")}
                </button>
              </div>
            </div>
          )}
          {blocked && (
            <div
              className="notice warning blocking-issues ai-content"
              role="alert"
            >
              <WarningCircle size={21} />
              <div>
                <p className="ai-label">
                  {isPublicDemo
                    ? t("分享范围说明 · 实际生成需要本机平台")
                    : t("AI 提出的阻止项 · 请结合实际规格核对")}
                </p>
                <strong>{t("先处理这些问题")}</strong>
                <p>
                  {isPublicDemo
                    ? t(
                        "以下是分享版的使用范围，补齐表单也不会新增在线执行服务。",
                      )
                    : t(
                        "以下要求尚不能按当前方案完成，先修改需求，再重新拆分。",
                      )}
                </p>
                <ul>
                  {plan.blocking_issues!.map((issue, index) => (
                    <li key={index}>{issue}</li>
                  ))}
                </ul>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={onPlan}
                >
                  {t("返回修改需求")}
                </button>
              </div>
            </div>
          )}
          <div className="execution-contract">
            <h3>
              {isPublicDemo ? t("这份规格说明什么") : t("这轮实际按什么执行")}
            </h3>
            <p>
              {isPublicDemo
                ? project?.latest_run_id
                  ? t(
                      "以下是已有本机验收示例的冻结规格，修改草稿不会改变历史结果。",
                    )
                  : t("以下来自当前浏览器草稿，尚未生成或运行验证。")
                : t("以下参数直接来自执行程序，请与需求一起核对。")}
            </p>
            {project && <ModelIdentity spec={project} />}
            {project?.prd?.intake?.motion_plan && (
              <MotionPlanEditor
                source={motionSource?.record}
                provenance={motionSource?.provenance}
                sourceStale={motionSource?.stale}
                summary
                plan={project.prd.intake.motion_plan}
                structure={snapshotStructure(project)}
                request={project.request}
                disabled
                onChange={() => {}}
              />
            )}
            <dl>
              <div>
                <dt>{t("需求用途")}</dt>
                <dd>{project?.prd?.use_case || project?.name}</dd>
              </div>
              <div>
                <dt>{t("目标控制板")}</dt>
                <dd>
                  {project?.hardware.board === "esp32s3"
                    ? "ESP32-S3"
                    : project?.hardware.board === "esp32"
                      ? "ESP32"
                      : project?.hardware.board}{" "}
                  · {project?.hardware.ros_distro}
                </dd>
              </div>
              <div>
                <dt>{t("控制与反馈")}</dt>
                <dd>
                  {project?.task_type === "joint_sequence"
                    ? t("全组虚拟关节 / 仿真测量反馈")
                    : project?.task_type === "joint_position"
                      ? t("虚拟关节 / 模拟编码器")
                      : t("虚拟开关 / 模拟传感器")}
                  {t("，不接实体设备")}
                </dd>
              </div>
              <div>
                <dt>{t("任务目标")}</dt>
                <dd>
                  {project?.task_type === "joint_sequence"
                    ? t(
                        "按上方全部关节的姿势、顺序与往返编号执行；最后一行是结束姿势",
                      )
                    : project?.task_type === "joint_position"
                      ? t(
                          `${project.parameters.target} rad；误差 ≤ ${project.parameters.tolerance} rad；速度 ≤ ${project.parameters.max_velocity} rad/s`,
                          `${project.parameters.target} rad; error ≤ ${project.parameters.tolerance} rad; speed ≤ ${project.parameters.max_velocity} rad/s`,
                        )
                      : t(
                          `传感器值 ≥ ${project?.parameters.threshold} 时输出 1，否则输出 0`,
                          `Output 1 when sensor value ≥ ${project?.parameters.threshold}; otherwise output 0`,
                        )}
                </dd>
              </div>
              <div>
                <dt>{t("观察时长")}</dt>
                <dd>
                  {project?.task_type === "joint_sequence"
                    ? t(
                        `${project.prd?.intake?.motion_plan?.timeout_s ?? t("未读取")} 秒完整动作超时；姿势采用累计仿真时间`,
                        `${project.prd?.intake?.motion_plan?.timeout_s ?? t("未读取")} s timeout for the complete action; poses use cumulative simulation time`,
                      )
                    : t(
                        `${project?.parameters.duration} 秒，从 ROS 端点连接完成后计时`,
                        `${project?.parameters.duration} s, timed from ROS endpoint connection`,
                      )}
                </dd>
              </div>
              <div>
                <dt>{t("反馈频率 / 失联")}</dt>
                <dd>
                  {project?.task_type === "joint_sequence" ? (
                    t(
                      "频率、带宽、反馈年龄与失联处理以冻结批量协议和本轮检查为准",
                    )
                  ) : (
                    <>
                      {String(communication?.state_frequency_hz ?? t("未读取"))}{" "}
                      Hz；
                      {String(
                        communication?.watchdog_seconds ?? t("未读取"),
                      )}{" "}
                      {t("秒收不到有效消息就输出零")}
                    </>
                  )}
                </dd>
              </div>
              <div>
                <dt>{t("消息格式")}</dt>
                <dd>
                  {project?.task_type === "joint_sequence" ? (
                    t(
                      "会话、序号、阶段、时间和全组通道目标 / 反馈；整组校验后接受",
                    )
                  ) : (
                    <>
                      {String(communication?.ros_message_type ?? t("未读取"))}
                      {t("；包含 seq、time、value")}
                      {project?.execution_model
                        ? t("，并核对关节名、模型标识与协议标识")
                        : ""}
                    </>
                  )}
                </dd>
              </div>
              <div>
                <dt>{t("序号与单位")}</dt>
                <dd>
                  {t("序号严格递增，重复或过期指令不执行。")}
                  {project?.task_type === "joint_sequence"
                    ? t(
                        "位置用 rad、速度用 rad/s、加速度用 rad/s²；同一关节只有一个仿真写入者。",
                      )
                    : project?.task_type === "joint_position"
                      ? t("位置用 rad，速度用 rad/s。")
                      : t("传感器值为 0–1，指令为 0 或 1。")}
                </dd>
              </div>
              <div>
                <dt>{t("ESP32 范围")}</dt>
                <dd>
                  {t(
                    "生成并编译所选板型的固件；串口收发逻辑在主机测试。编译是否通过见本轮结果，不烧录控制板。",
                  )}
                </dd>
              </div>
              <div>
                <dt>{t("通信通道")}</dt>
                <dd>
                  {project?.task_type === "joint_sequence"
                    ? t("批量紧凑协议通过主机虚拟串口测试，实物串口吞吐未验证")
                    : project?.hardware.transport === "serial_jsonl"
                      ? t(
                          `JSON 按行发送，${project.hardware.baudrate || 115200} 波特率；测试时使用主机虚拟串口`,
                          `Line-delimited JSON at ${project.hardware.baudrate || 115200} baud; tests use a host virtual serial port`,
                        )
                      : t("ROS 模拟设备通信")}
                </dd>
              </div>
              {project?.prd?.structure_id && (
                <div>
                  <dt>{t("结构用途")}</dt>
                  <dd>
                    {project.execution_model
                      ? t("按本轮冻结关节树进行近似运动检查，未做实物标定")
                      : project.prd.structure_id.startsWith("builtin-")
                        ? t("内置测试台架")
                        : t("导入 / 参考结构只用于预览，未作为动力学模型运行")}
                    {project.prd.joint_name
                      ? t(
                          `；所选关节 ${project.prd.joint_name}`,
                          `; selected joint ${project.prd.joint_name}`,
                        )
                      : ""}
                  </dd>
                </div>
              )}
              {project?.prd?.constraints && (
                <div>
                  <dt>{t("必须遵守")}</dt>
                  <dd>{project.prd.constraints}</dd>
                </div>
              )}
              {project?.prd?.acceptance && (
                <div>
                  <dt>{t("验收要求")}</dt>
                  <dd>{project.prd.acceptance}</dd>
                </div>
              )}
            </dl>
            <details>
              <summary>{t("展开完整通信与模拟约定")}</summary>
              <pre>
                {JSON.stringify({ communication, simulation }, null, 2)}
              </pre>
            </details>
          </div>
          <div className="ai-content">
            <div className="ai-label">
              {isPublicDemo ? t("公开示例 / 浏览器摘要 · ") : t("AI 生成 · ")}
              {plan.provenance?.tool || t("已记录工具")}
              {plan.provenance?.model ? ` / ${plan.provenance.model}` : ""}
            </div>
            <p className="plan-summary">{plan.summary}</p>
          </div>
          <RequirementCoverage coverage={plan.requirement_coverage} />
          {project && (
            <ProjectManifest manifest={project.manifest} stale={dirty} />
          )}
          <div className="ai-content ai-plan-fields">
            <p className="ai-label">
              {isPublicDemo
                ? t(
                    "以下是公开示例说明或浏览器规则摘要，不是新的 AI 拆分或执行结果。",
                  )
                : t(
                    "以下分工、通信建议、检查建议和缺失项均由 AI 生成 · 完整工具与提示词见下方“AI 记录”",
                  )}
            </p>
            <div className="plan-columns">
              <PlanList title={t("ROS 端")} items={plan.ros_tasks} />
              <PlanList title={t("ESP32 端")} items={plan.esp32_tasks} />
            </div>
            <PlanList
              title={t("两端共同的通信约定")}
              items={plan.communication}
            />
            <PlanList title={t("怎样检查是否完成")} items={plan.checks} />
            {!!plan.missing_information?.length && (
              <div className="notice warning">
                <WarningCircle size={19} />
                <div>
                  <strong>{t("还要留意")}</strong>
                  <ul>
                    {plan.missing_information.map((x, i) => (
                      <li key={i}>{x}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </div>
          {!!plan.citations?.length && (
            <details className="source-details">
              <summary>
                {t("本次参考资料 ·")} {plan.citations.length}
              </summary>
              {plan.citations.map((x, i) => (
                <p key={i}>
                  {/^https?:\/\//.test(x) ? (
                    <a href={x} target="_blank" rel="noreferrer">
                      {x}
                    </a>
                  ) : x.startsWith("project://") ? (
                    t("本项目通信约定，见上方“这轮实际按什么执行”。")
                  ) : (
                    x
                  )}
                </p>
              ))}
            </details>
          )}
          {project?.status === "awaiting_approval" ? (
            <div className="approval-box">
              <label>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={blocked || !plan.plan_id}
                  onChange={(e) => setChecked(e.target.checked)}
                />
                <span>
                  {t("已核对本版需求、两端分工和通信参数")}{" "}
                  <small>
                    {t("规格版本")} {project.spec_revision}
                  </small>
                </span>
              </label>
              <button
                className="button primary"
                disabled={
                  !checked ||
                  busy ||
                  dirty ||
                  !communication ||
                  blocked ||
                  !plan.plan_id
                }
                onClick={onApprove}
              >
                {busy ? (
                  <CircleNotch className="spin" size={17} />
                ) : (
                  <Play size={17} />
                )}
                {isPublicDemo
                  ? t("我已阅读，查看生成流程")
                  : t("确认，生成并检查")}
              </button>
            </div>
          ) : (
            <div className="notice">
              <CheckCircle size={19} />
              <span>
                {project?.approval
                  ? t("本版规格已人工核对。修改需求后，需要重新核对。")
                  : t("本次拆分暂不可执行，请查看工程状态。")}
              </span>
              {project?.status === "approved" && (
                <button
                  className="button primary"
                  disabled={
                    busy || dirty || !communication || blocked || !plan.plan_id
                  }
                  onClick={onApprove}
                >
                  {isPublicDemo ? t("查看生成流程") : t("生成并检查")}
                </button>
              )}
            </div>
          )}
        </>
      )}
      <details className="source-details">
        <summary>
          {isPublicDemo ? t("示例验证环境 / 分享范围") : t("本机环境信息")}
        </summary>
        <pre>
          {environment
            ? JSON.stringify(environment, null, 2)
            : t("正在读取本机环境…")}
        </pre>
      </details>
    </section>
  );
}
function PlanList({ title, items }: { title: string; items: string[] }) {
  useI18n();
  return (
    <div className="plan-list">
      <h3>{title}</h3>
      <ul>
        {items?.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
