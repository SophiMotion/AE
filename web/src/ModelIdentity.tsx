import { useI18n } from "./i18n";
import { t } from "./localeStore";
import "./i18nCore";
import type { Project } from "./api";
import { stepLabels } from "./workflowModel";
import { jointBounds, snapshotStructure } from "./modelView";
export default function ModelIdentity({
  spec,
  actualOrder,
}: {
  spec: Project;
  actualOrder?: string[];
}) {
  const { locale } = useI18n();

  const model = spec.execution_model,
    structure = snapshotStructure(spec);
  const name = model?.selected_joint || spec.prd?.joint_name;
  const joint = structure?.joints.find((j) => j.name === name);
  const range = jointBounds(joint);
  const order = actualOrder || spec.workflow?.execution_order;
  const protocol = spec.communication?.protocol_sha256;
  const sequence = spec.task_type === "joint_sequence";
  const program = spec.prd?.intake?.motion_plan;
  if (!model && !order?.length) return null;
  return (
    <div className="model-identity">
      <h3>{t("本轮控制对象与顺序")}</h3>
      {model && (
        <>
          <dl>
            <div>
              <dt>{t("模型与关节")}</dt>
              <dd>
                {structure?.name} ·{" "}
                {sequence
                  ? program?.joint_names.join("、") || t("全组关节见冻结程序")
                  : joint?.label || name}
              </dd>
            </div>
            <div>
              <dt>{t("初始与目标")}</dt>
              <dd>
                {sequence ? (
                  t(
                    `${program?.waypoints.length ?? t("未读取")} 个逐关节姿势，按累计时间执行`,
                    `${program?.waypoints.length ?? t("未读取")} joint poses, executed by cumulative time`,
                  )
                ) : (
                  <>
                    {(joint?.initial_position ?? 0).toFixed(3)} →{" "}
                    {spec.parameters.target} rad
                  </>
                )}
              </dd>
            </div>
            <div>
              <dt>{t("允许范围")}</dt>
              <dd>
                {sequence
                  ? t("每个关节分别按冻结模型限位校验，未做实物确认")
                  : t(
                      `${range.lower.toFixed(3)} ～ ${range.upper.toFixed(3)} rad · 来自模型，未做实物确认`,
                      `${range.lower.toFixed(3)} – ${range.upper.toFixed(3)} rad · Model limits, not physically verified`,
                    )}
              </dd>
            </div>
            <div>
              <dt>{t("模型标识")}</dt>
              <dd>
                <code title={model.model_sha256}>
                  {model.model_sha256.slice(0, 16)}
                </code>{" "}
                ·{" "}
                {sequence
                  ? t("参与关节按完整姿势程序运动，其余保持模型姿态")
                  : t("其他轴保持保存姿态")}
              </dd>
            </div>
            {typeof protocol === "string" && (
              <div>
                <dt>{t("通信协议标识")}</dt>
                <dd>
                  <code title={protocol}>{protocol.slice(0, 16)}</code>
                  {t("· 两端必须一致")}
                </dd>
              </div>
            )}
          </dl>
          <details>
            <summary>{t("模型依据与本轮仿真假设")}</summary>
            <ul>
              {Object.entries(model.assumptions || {}).map(([key, value]) => (
                <li key={key}>
                  {typeof value === "string"
                    ? value
                    : `${key}：${JSON.stringify(value)}`}
                </li>
              ))}
            </ul>
            <p>{t("本机近似运动检查，不验证实体负载、碰撞、力控或引脚。")}</p>
          </details>
        </>
      )}
      {order?.length ? (
        <>
          <p className="field-hint">
            {actualOrder ? t("本轮记录的执行顺序") : t("已保存的流程顺序")}
          </p>
          <ol className="workflow-order">
            {order.map((id, i) => (
              <li key={`${id}-${i}`}>{t(stepLabels[id] || id)}</li>
            ))}
          </ol>
        </>
      ) : null}
    </div>
  );
}
