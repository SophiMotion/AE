import { useEffect, useId, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle,
  PencilSimple,
  WarningCircle,
} from "@phosphor-icons/react";
import { useI18n } from "./i18n";
import type { GuidedConfig } from "./guidedFlow";
import "./guidedSetup.css";

type GuidedProps = {
  value: GuidedConfig;
  onChange: (next: GuidedConfig) => void;
  disabled: boolean;
};

type Task = GuidedConfig["primary_task"];

export function RequirementSteps({
  request,
  value,
  onChange,
  disabled,
}: GuidedProps & { request: string }) {
  const { t } = useI18n();
  const fieldId = useId();
  const [question, setQuestion] = useState(() =>
    value.robot_choice === "undecided"
      ? 0
      : value.primary_task === "unselected"
        ? 1
        : !value.purpose.trim()
          ? 2
          : 3,
  );
  const [touchedPurpose, setTouchedPurpose] = useState(false);
  const suggestsFoldBot = /折叠|fold\s*bot|folding\s+robot/i.test(request);
  const answered = [
    value.robot_choice !== "undecided",
    value.primary_task !== "unselected",
    !!value.purpose.trim(),
  ];
  const completed = answered.every(Boolean);
  const titles = [
    t("机器人类型", "Robot type"),
    t("主要动作", "Main task"),
    t("期望结果", "Expected result"),
  ];
  const tasks: { id: Task; title: string; detail: string }[] =
    value.robot_choice === "other"
      ? [
          {
            id: "custom",
            title: t("描述自己的功能", "Describe my own task"),
            detail: t(
              "记录你想做的设备和功能，保留待适配。",
              "Keep your device and task requirements for adaptation.",
            ),
          },
        ]
      : [
          {
            id: "fold-cycle",
            title: t("展开与收拢", "Unfold and fold"),
            detail: t(
              "让两块折叠板按顺序完成展开、收拢。",
              "Unfold and fold the two panels in sequence.",
            ),
          },
          {
            id: "arm-demo",
            title: t("机械臂动作", "Arm movement"),
            detail: t(
              "先描述机械臂要做什么，再核对动作范围。",
              "Describe the arm task, then review its motion range.",
            ),
          },
          {
            id: "chassis-demo",
            title: t("底盘移动", "Chassis movement"),
            detail: t(
              "说明前进、后退、转向和怎样停下。",
              "Describe forward, reverse, turning and stopping.",
            ),
          },
          {
            id: "custom",
            title: t("我来描述", "Describe another task"),
            detail: t(
              "组合多个动作，或填写其他想法。",
              "Combine actions or add a different idea.",
            ),
          },
        ];
  const taskTitle =
    tasks.find((task) => task.id === value.primary_task)?.title ??
    t("尚未选择", "Not selected");
  const purposeSuggestions: Record<
    Exclude<Task, "unselected">,
    [string, string]
  > = {
    "fold-cycle": [
      "先在页面预览双板展开与收拢，再通过控制台逐步操作，并能随时停止。",
      "Preview both panels unfolding and folding, then operate them step by step from the console with stop available.",
    ],
    "arm-demo": [
      "先在页面预览机械臂动作，再逐关节检查方向和范围，最后在控制台手动操作。",
      "Preview arm movement, check each joint's direction and range, then operate it manually from the console.",
    ],
    "chassis-demo": [
      "通过控制台让底盘短距离前进、后退和转向，松开操作后停止。",
      "Move the chassis a short distance forward, backward and around from the console, stopping when the control is released.",
    ],
    custom: [
      "先看接线和动作预览，确认方案后查看工程代码，再进行设备部署与操作。",
      "Review the wiring and motion preview, inspect the generated source, then prepare device deployment and operation.",
    ],
  };
  const suggestion =
    value.primary_task === "unselected"
      ? ""
      : t(...purposeSuggestions[value.primary_task]);

  useEffect(() => {
    if (value.robot_choice === "undecided") setQuestion(0);
    else if (value.primary_task === "unselected")
      setQuestion((current) => Math.min(current, 1));
    else if (!value.purpose.trim())
      setQuestion((current) => Math.min(current, 2));
  }, [value.robot_choice, value.primary_task, value.purpose]);

  function update(next: Partial<GuidedConfig>) {
    if (!disabled) onChange({ ...value, ...next, wiring_binding_sha256: null });
  }

  function nextQuestion() {
    if (disabled || !answered[question]) return;
    setQuestion((current) => Math.min(3, current + 1));
  }

  return (
    <section
      className="guided-setup guided-requirements"
      aria-label={t("逐步整理需求", "Clarify requirements step by step")}
    >
      <div className="guided-question-heading">
        <div>
          <span className="guided-eyebrow">
            {question < 3
              ? t(`问题 ${question + 1} / 3`, `Question ${question + 1} / 3`)
              : t("需求摘要", "Requirement summary")}
          </span>
          <h2>
            {question === 0
              ? t("先确认，你想制作什么？", "What would you like to build?")
              : question === 1
                ? t(
                    "最先想实现哪个动作？",
                    "Which task would you like to start with?",
                  )
                : question === 2
                  ? t(
                      "做到什么程度，你会觉得完成了？",
                      "What result would count as done?",
                    )
                  : t("你的需求已整理好", "Your requirements are organized")}
          </h2>
        </div>
        <ol
          className="guided-question-progress"
          aria-label={t("需求整理进度", "Requirements progress")}
        >
          {titles.map((title, index) => (
            <li
              key={title}
              className={
                question === index
                  ? "is-current"
                  : answered[index]
                    ? "is-answered"
                    : ""
              }
            >
              <button
                type="button"
                disabled={
                  disabled ||
                  (index > 0 && !answered.slice(0, index).every(Boolean))
                }
                onClick={() => setQuestion(index)}
                aria-current={question === index ? "step" : undefined}
                aria-label={`${title}${answered[index] ? t("，已填写", ", completed") : ""}`}
              >
                {answered[index] ? (
                  <CheckCircle size={18} weight="fill" aria-hidden="true" />
                ) : (
                  <span>{index + 1}</span>
                )}
                <small>{title}</small>
              </button>
            </li>
          ))}
        </ol>
      </div>

      {question === 0 && (
        <div
          className="guided-answer-options"
          role="group"
          aria-label={t("选择机器人类型", "Choose a robot type")}
        >
          <button
            type="button"
            className={`guided-choice ${value.robot_choice === "foldbot" ? "is-selected" : ""}`}
            disabled={disabled}
            aria-pressed={value.robot_choice === "foldbot"}
            onClick={() =>
              value.robot_choice !== "foldbot" &&
              update({ robot_choice: "foldbot", primary_task: "unselected" })
            }
          >
            <span className="guided-choice-top">
              <strong>{t("折叠机器人", "Folding robot")}</strong>
              {suggestsFoldBot && (
                <em>{t("与你的描述匹配", "Matches your description")}</em>
              )}
            </span>
            <span>
              {t(
                "包含履带底盘、双折叠板和机械臂的现有方案。",
                "An existing design with a tracked chassis, two folding panels and an arm.",
              )}
            </span>
            <small>
              {value.robot_choice === "foldbot"
                ? t("已选择", "Selected")
                : t("选择这个方案", "Choose this design")}
            </small>
          </button>
          <button
            type="button"
            className={`guided-choice ${value.robot_choice === "other" ? "is-selected" : ""}`}
            disabled={disabled}
            aria-pressed={value.robot_choice === "other"}
            onClick={() =>
              value.robot_choice !== "other" &&
              update({ robot_choice: "other", primary_task: "unselected" })
            }
          >
            <span className="guided-choice-top">
              <strong>
                {t("其他设备或机器人", "Another device or robot")}
              </strong>
            </span>
            <span>
              {t(
                "继续整理自己的需求，缺少的硬件适配留待补充。",
                "Continue with your own requirements and leave missing hardware support for later.",
              )}
            </span>
            <small>
              {value.robot_choice === "other"
                ? t("已选择 · 待适配", "Selected · adaptation needed")
                : t("保留我的方案", "Keep my own design")}
            </small>
          </button>
        </div>
      )}

      {question === 1 && (
        <div
          className="guided-answer-options"
          role="group"
          aria-label={t("选择主要动作", "Choose the main task")}
        >
          {tasks.map((task) => (
            <button
              type="button"
              key={task.id}
              className={`guided-choice ${value.primary_task === task.id ? "is-selected" : ""}`}
              disabled={disabled}
              aria-pressed={value.primary_task === task.id}
              onClick={() =>
                value.primary_task !== task.id &&
                update({ primary_task: task.id })
              }
            >
              <span className="guided-choice-top">
                <strong>{task.title}</strong>
              </span>
              <span>{task.detail}</span>
              <small>
                {value.primary_task === task.id
                  ? t("已选择", "Selected")
                  : t("选择", "Choose")}
              </small>
            </button>
          ))}
        </div>
      )}

      {question === 2 && (
        <div className="guided-purpose">
          <label htmlFor={fieldId}>
            {t("用自己的话描述结果", "Describe the result in your own words")}
          </label>
          <textarea
            id={fieldId}
            rows={3}
            maxLength={2000}
            disabled={disabled}
            value={value.purpose}
            placeholder={t(
              "例如：能展开、移动、收拢，并在网页上随时停止。",
              "For example: unfold, move and fold, with a stop control on the webpage.",
            )}
            onChange={(event) => update({ purpose: event.target.value })}
            onBlur={() => setTouchedPurpose(true)}
            aria-invalid={
              touchedPurpose && !value.purpose.trim() ? true : undefined
            }
            aria-describedby={`${fieldId}-help`}
          />
          <div className="guided-purpose-help" id={`${fieldId}-help`}>
            <span>
              {touchedPurpose && !value.purpose.trim()
                ? t(
                    "补充一句期望的结果，就能继续。",
                    "Add your expected result to continue.",
                  )
                : t(
                    "不用写提示词或技术参数，可以随时修改。",
                    "No prompt writing or technical parameters needed. You can edit this later.",
                  )}
            </span>
            <small>{value.purpose.length} / 2000</small>
          </div>
          {suggestion && (
            <div className="guided-suggestion">
              <div>
                <small>{t("参考说法", "Suggested wording")}</small>
                <p>{suggestion}</p>
              </div>
              <button
                type="button"
                className="guided-button"
                disabled={disabled}
                onClick={() => update({ purpose: suggestion })}
              >
                {t("填入这句话", "Use this wording")}
              </button>
            </div>
          )}
        </div>
      )}

      {question === 3 && (
        <div className="guided-completed" aria-live="polite">
          <dl>
            {[
              [
                titles[0],
                value.robot_choice === "foldbot"
                  ? t("折叠机器人", "Folding robot")
                  : t(
                      "其他设备 · 待适配",
                      "Another device · adaptation needed",
                    ),
              ],
              [titles[1], taskTitle],
              [titles[2], value.purpose],
            ].map(([title, content], index) => (
              <div className="guided-summary-row" key={title}>
                <dt>{title}</dt>
                <dd>{content}</dd>
                <button
                  type="button"
                  className="guided-edit"
                  disabled={disabled}
                  onClick={() => setQuestion(index)}
                  aria-label={t(`修改${title}`, `Edit ${title}`)}
                >
                  <PencilSimple size={16} aria-hidden="true" />
                  <span>{t("修改", "Edit")}</span>
                </button>
              </div>
            ))}
          </dl>
          {value.robot_choice === "foldbot" && completed && (
            <p className="guided-complete-note">
              <CheckCircle size={18} aria-hidden="true" />
              {t(
                "接下来选择硬件，再生成属于这份需求的接线方案。",
                "Next, choose the hardware and generate a wiring plan for these requirements.",
              )}
            </p>
          )}
        </div>
      )}

      {value.robot_choice === "other" && (
        <p className="guided-pending-note">
          <WarningCircle size={18} aria-hidden="true" />
          {t(
            "这份需求可以保存；硬件、代码和控制方式仍需适配，不会自动改成折叠机器人。",
            "You can save this requirement. Hardware, code and controls still need adaptation; it will not be changed into a folding robot.",
          )}
        </p>
      )}

      {question < 3 && (
        <div className="guided-question-actions">
          <button
            type="button"
            className="guided-button"
            disabled={disabled || question === 0}
            onClick={() => setQuestion((current) => Math.max(0, current - 1))}
          >
            <ArrowLeft size={17} aria-hidden="true" />
            {t("上个问题", "Previous question")}
          </button>
          <button
            type="button"
            className="guided-button primary"
            disabled={disabled || !answered[question]}
            onClick={nextQuestion}
          >
            {question === 2
              ? t("查看需求摘要", "Review requirements")
              : t("下个问题", "Next question")}
            <ArrowRight size={17} aria-hidden="true" />
          </button>
        </div>
      )}
    </section>
  );
}

type HardwareKey = Exclude<keyof GuidedConfig["hardware"], "notes">;

export function HardwareSelector({ value, onChange, disabled }: GuidedProps) {
  const { t } = useI18n();
  const notesId = useId();
  const cards: {
    key: HardwareKey;
    recommended: string;
    name: string;
    detail: string;
    source: string;
    color: string;
  }[] = [
    {
      key: "controller",
      recommended: "sophicar-s3",
      name: t("主控板", "Controller"),
      detail: "Sophicar ESP32-S3",
      source: t(
        "复用现有整机固件的主控目标。确认实物型号和模组规格后，再进行编译与部署。",
        "Use the existing full-robot firmware target. Confirm the actual board and module before building and deploying.",
      ),
      color: "blue",
    },
    {
      key: "fold_driver",
      recommended: "external-step-dir",
      name: t("双板驱动", "Panel drivers"),
      detail: t("外置 STEP / DIR 驱动器", "External STEP / DIR drivers"),
      source: t(
        "原方案使用脉冲、方向与使能信号控制两轴；驱动器具体型号、电流和供电仍需核对。",
        "The source uses step, direction and enable signals for two axes. Driver model, current and power still need verification.",
      ),
      color: "green",
    },
    {
      key: "arm_bus",
      recommended: "buslinker-hx",
      name: t("机械臂连接", "Arm connection"),
      detail: "BusLinker + HX",
      source: t(
        "保留 BusLinker 与 HX 总线舵机方案；通过 TTL 串口连接，实物波特率和舵机供电需核对。",
        "Keep the BusLinker and HX bus-servo design over TTL serial. Verify the actual baud rate and servo supply.",
      ),
      color: "yellow",
    },
    {
      key: "chassis",
      recommended: "sophicar-m1-m2",
      name: t("底盘连接", "Chassis connection"),
      detail: "Sophicar M1 / M2",
      source: t(
        "原方案使用扩展板 M1、M2 接口。GPIO35–37 与 N16R8 内部存储器的兼容性仍待确认。",
        "The source uses the expansion board's M1 and M2. GPIO35–37 compatibility with N16R8 internal memory remains unresolved.",
      ),
      color: "red",
    },
  ];
  const selected = cards.filter(
    (card) => value.hardware[card.key] !== "unselected",
  ).length;
  const allRecommended = cards.every(
    (card) => value.hardware[card.key] === card.recommended,
  );
  const hasOther = cards.some((card) => value.hardware[card.key] === "other");

  function choose(key: HardwareKey, next: string) {
    if (disabled || value.hardware[key] === next) return;
    onChange({
      ...value,
      hardware: { ...value.hardware, [key]: next },
      wiring_binding_sha256: null,
    });
  }

  function useExistingSet() {
    if (disabled || allRecommended || value.robot_choice !== "foldbot") return;
    onChange({
      ...value,
      hardware: {
        ...value.hardware,
        controller: "sophicar-s3",
        fold_driver: "external-step-dir",
        arm_bus: "buslinker-hx",
        chassis: "sophicar-m1-m2",
      },
      wiring_binding_sha256: null,
    });
  }

  return (
    <section
      className="guided-setup guided-hardware"
      aria-label={t("选择硬件组合", "Choose the hardware set")}
    >
      <div className="guided-hardware-heading">
        <div>
          <span className="guided-eyebrow">
            {t(
              "先选硬件，再生成接线",
              "Choose hardware before generating wiring",
            )}
          </span>
          <h2>{t("你准备使用哪套硬件？", "Which hardware will you use?")}</h2>
          <p>
            {t(
              "按实际设备选择；不确定的地方可以先留空。",
              "Choose your actual hardware. Leave anything uncertain unselected.",
            )}
          </p>
        </div>
        <button
          type="button"
          className="guided-button primary"
          disabled={
            disabled || allRecommended || value.robot_choice !== "foldbot"
          }
          onClick={useExistingSet}
        >
          {allRecommended
            ? t("已采用现有整机组合", "Existing robot set selected")
            : t("采用现有整机组合", "Use the existing robot set")}
        </button>
      </div>
      <div className="guided-hardware-count" aria-live="polite">
        <span>
          {t(`已选择 ${selected} / 4 项`, `${selected} / 4 selected`)}
        </span>
        <small>
          {t(
            "这里只选择配置，下一步再生成接线。",
            "This selects the configuration. Wiring is generated in the next step.",
          )}
        </small>
      </div>
      <div className="guided-hardware-grid">
        {cards.map((card) => (
          <article
            key={card.key}
            className={`guided-hardware-card ${card.color}`}
          >
            <div className="guided-hardware-card-heading">
              <span className="guided-hardware-marker" aria-hidden="true" />
              <h3>{card.name}</h3>
              <small
                className={
                  value.hardware[card.key] === "other" ? "is-pending" : ""
                }
              >
                {value.hardware[card.key] === "unselected"
                  ? t("未选择", "Not selected")
                  : value.hardware[card.key] === "other"
                    ? t("待适配", "Needs adaptation")
                    : t("已选择", "Selected")}
              </small>
            </div>
            <p className="guided-hardware-product">{card.detail}</p>
            <div
              className="guided-hardware-choices"
              role="group"
              aria-label={card.name}
            >
              <button
                type="button"
                disabled={disabled || value.robot_choice !== "foldbot"}
                className={
                  value.hardware[card.key] === card.recommended
                    ? "is-selected"
                    : ""
                }
                aria-pressed={value.hardware[card.key] === card.recommended}
                onClick={() => choose(card.key, card.recommended)}
              >
                {t("使用推荐配置", "Use suggested configuration")}
              </button>
              <button
                type="button"
                disabled={disabled}
                className={
                  value.hardware[card.key] === "other" ? "is-selected" : ""
                }
                aria-pressed={value.hardware[card.key] === "other"}
                onClick={() => choose(card.key, "other")}
              >
                {t("其他 / 待适配", "Other / needs adaptation")}
              </button>
              <button
                type="button"
                disabled={disabled || value.hardware[card.key] === "unselected"}
                className="guided-clear"
                onClick={() => choose(card.key, "unselected")}
              >
                {t("暂不选择", "Leave unselected")}
              </button>
            </div>
            <details className="guided-source-detail">
              <summary>
                {t("查看现有方案依据", "View source configuration")}
              </summary>
              <p>{card.source}</p>
            </details>
          </article>
        ))}
      </div>
      <p className="guided-source-warning guided-compatibility-note">
        <WarningCircle size={18} aria-hidden="true" />
        {t(
          "现有方案的 GPIO35–37 与 N16R8 兼容性尚待确认。",
          "GPIO35–37 compatibility with N16R8 in the existing design is still unconfirmed.",
        )}
      </p>
      {hasOther && (
        <p className="guided-pending-note">
          <WarningCircle size={18} aria-hidden="true" />
          {t(
            "其他硬件会保存在需求中。完成适配前，不会生成套用原方案的接线或程序。",
            "Other hardware is saved with the requirements. The original wiring and program will not be applied until it is adapted.",
          )}
        </p>
      )}
      <details className="guided-hardware-notes" open={hasOther || undefined}>
        <summary>
          {t(
            "补充硬件型号或查看待核对事项",
            "Add hardware details or view open checks",
          )}
        </summary>
        <div className="guided-notes-content">
          <p>
            {t(
              "推荐组合用于复用现有源码；驱动器、电源、接线和标定仍需根据实物核对。选择组合不会确认实物已经接好。",
              "The suggested set reuses existing source. Verify drivers, supply, wiring and calibration against the actual robot. Selecting a set does not confirm physical wiring.",
            )}
          </p>
          <label htmlFor={notesId}>
            {t("我的硬件补充", "My hardware notes")}
          </label>
          <textarea
            id={notesId}
            rows={3}
            maxLength={2000}
            disabled={disabled}
            value={value.hardware.notes}
            placeholder={t(
              "填写板卡或驱动器型号、已有模块、仍不确定的地方。",
              "Add board or driver models, existing modules and anything still uncertain.",
            )}
            onChange={(event) =>
              !disabled &&
              onChange({
                ...value,
                hardware: { ...value.hardware, notes: event.target.value },
                wiring_binding_sha256: null,
              })
            }
          />
        </div>
      </details>
    </section>
  );
}
