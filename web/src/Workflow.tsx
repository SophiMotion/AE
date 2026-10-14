import { useI18n } from "./i18n";
import { t } from "./localeStore";
import "./i18nCore";
import { ArrowCounterClockwise, Check } from "@phosphor-icons/react";
import type { Status } from "./api";

const steps = [
  ["机器人与需求", "明确任务与硬件"],
  ["环境与检查", "核对拆分和通信"],
  ["程序生成", "生成 ROS 与 ESP32 工程"],
  ["运行与评估", "编译、运行、修改"],
];
function currentStage(status: Status, hasPlan: boolean, hasResult: boolean) {
  if (!hasPlan) return 0;
  if (status === "draft" || status === "planning") return 0;
  if (status === "awaiting_approval" || status === "approved") return 1;
  if (["queued", "generating", "building", "repairing"].includes(status))
    return 2;
  if (["failed", "cancelled", "interrupted"].includes(status))
    return hasResult ? 3 : 2;
  return 3;
}
export default function Workflow({
  selected,
  status,
  onSelect,
  hasPlan,
  hasResult,
}: {
  selected: number;
  status: Status;
  onSelect: (n: number) => void;
  hasPlan: boolean;
  hasResult: boolean;
}) {
  const { locale } = useI18n();

  const current = currentStage(status, hasPlan, hasResult);
  return (
    <section className="workflow" aria-label={t("工程流程")}>
      <nav className="workflow-steps" aria-label={t("工程阶段")}>
        {steps.map(([title, description], index) => (
          <button
            key={title}
            type="button"
            className={`workflow-step ${selected === index ? "selected" : ""} ${current > index ? "completed" : ""}`}
            onClick={() => onSelect(index)}
            aria-pressed={selected === index}
            aria-current={selected === index ? "step" : undefined}
          >
            <span className="step-number" aria-hidden="true">
              {current > index ? (
                <Check size={20} />
              ) : (
                String(index + 1).padStart(2, "0")
              )}
            </span>
            <span className="workflow-step-label">
              <strong>{t(title)}</strong>
              <small>{t(description)}</small>
            </span>
          </button>
        ))}
      </nav>
      <div className="feedback-caption">
        <ArrowCounterClockwise size={14} aria-hidden="true" />
        <span>{t("根据检查结果修改，再跑一遍")}</span>
      </div>
    </section>
  );
}
