import { useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Plus, Trash } from "@phosphor-icons/react";
import type {
  IntakeAnswers,
  IntakeReadiness,
  PRDIntake,
  Structure,
} from "./api";
import GuideNumber from "./GuideNumber";
import GuideOptions from "./GuideOptions";
import {
  adoptPlatformDetails,
  clearDetailGroup,
  detailLabels,
  hasDetailExtras,
  newDeviceMapping,
  newMotionStep,
  reorderRow,
  type DetailGroupKey,
  type DetailSelection,
  type IntakeDetails,
} from "./intakeDetails";

type Props = {
  step: 3 | 4 | 5;
  details: IntakeDetails;
  answers: IntakeAnswers;
  intent: PRDIntake["intent"];
  structure: Structure | null;
  angleUnit: "deg" | "rad";
  disabled: boolean;
  completeAction?: boolean;
  v5Motion?: boolean;
  onChange: (details: IntakeDetails) => void;
};
const facts: Record<DetailGroupKey, string> = {
  motion:
    "按上面填写的单个动作测试。不会自动加入前后步骤、同时控制多个关节，或把招手改成只转到一个位置。",
  lifecycle:
    "手动启动。从模型初始角度开始，其他关节保留模型姿态；这不是实物回零。通信就绪后观察给定时长，到位后继续观察；结束或取消会停止本轮进程，不代表实物刹车。",
  device_mapping:
    "本轮在电脑里测试，不连接真实电机，也不驱动 GPIO。实物型号、地址和引脚可以另存资料；平台不会猜这些信息。",
  coordinates:
    "关节零位、正方向和范围来自选中的结构。位置反馈用 rad，速度指令用 rad/s；页面可用度数填写。模型零位不是实物已校准的零位。阈值任务使用 0–1 的模拟数值，输出 0 或 1。",
  communication:
    "ROS 根据反馈计算速度或开关指令；ESP32 工程处理通信与限幅。本轮在电脑上测试共享固件核心，不连接板子。使用虚拟串口 JSONL，115200，名义每秒 20 次；超过 600 毫秒没有有效消息时归零。",
  faults:
    "超过 600 毫秒没有有效消息时归零；格式不对或过期的消息会被拒绝，不是任意一个坏包都立即停车。检查批准的模型范围并限制速度；这里没有实物急停、断电或自动恢复。",
  acceptance:
    "定点任务检查末尾 5 个反馈位置是否都在误差范围内；阈值任务检查达到条件时开、低于时关。另检查两端编译、身份、通信、速度与失联。本轮不检查轨迹、往返次数或连续稳定几秒。",
  environment:
    "关节仿真使用固定基座、零重力和理想速度，不做实物负载或碰撞验收；阈值任务使用合成数值。3D 外观不代表真实受力情况。",
};
function factsForIntent(
  intent: PRDIntake["intent"],
  v5Motion = false,
): Record<DetailGroupKey, string> {
  if (v5Motion)
    return {
      ...facts,
      motion:
        "采用已明确选择的逐关节姿势程序，依次到位，按展开的区段往返。未采用的原始草稿和补充仍保留并接受后台检查。",
      lifecycle:
        "手动启动，从冻结模型初始姿态进入程序；累计时间使用仿真时钟，通信看门狗使用单调时钟。完成最后一个已核对姿势后结束；取消会停止本轮控制。",
      coordinates:
        "全部参与关节的位置统一用 rad；速度用 rad/s、加速度用 rad/s²。每个关节范围来自冻结模型。模型姿态不等于实物已校准零位。",
      communication:
        "轨迹控制器的全组位置目标先经共享固件核心审核，再写入仿真设备。紧凑批量协议绑定本轮会话、模型和全部关节；频率、带宽和超时以冻结合同与运行记录为准。",
      faults:
        "全组目标一起检查；缺轴、越界、错身份、过期与乱序帧被拒绝。取消、通信中断和控制器异常分别检查，不等于实物急停或刹车。",
      acceptance:
        "逐阶段检查全部关节的实际位置是否到位；用实际位置到达往返端点计算次数，并核对最后姿势。速度、加速度、完整编译、异常和取消记录独立检查。",
      environment:
        "Sophicore 参考仿真使用固定基座、零重力和模型近似惯量。实际反馈用于本机动作验收；不证明实物负载、碰撞、平衡或板上通信。",
    };
  if (intent !== "threshold") return facts;
  return {
    ...facts,
    motion:
      "按上面填写的阈值测试：模拟值达到阈值时输出 1，低于阈值时输出 0。不会自动添加前后动作或多条件控制。",
    lifecycle:
      "手动启动。通信就绪后，按固定顺序提供 0–1 的合成测试值并观察给定时长；结束或取消会停止本轮进程。不涉及关节起始姿态，也不是实物开关断电。",
    coordinates:
      "传感器反馈是 0–1 的模拟数值，开关指令只能是 0 或 1；不使用关节角度或电机速度。这些数值尚未对应真实传感器的温度、距离等单位。",
    communication:
      "ROS 根据模拟值计算开关指令；ESP32 工程处理通信和指令。本轮在电脑上测试共享固件核心，不连接板子。使用虚拟串口 JSONL，115200，名义每秒 20 次。",
    faults:
      "超过 600 毫秒没有有效消息时归零；格式不对或过期的消息会被拒绝，不是任意一个坏包都立即停车。只接受约定的数值和开关指令；没有实物急停、断电或自动恢复。",
    acceptance:
      "检查达到阈值时输出 1、低于阈值时输出 0，以及两端编译、身份、通信与失联。不验证真实传感器精度或实物开关效果。",
    environment:
      "使用固定顺序的合成数值和虚拟开关，不模拟真实温度、距离或周围环境，也不做实物负载与碰撞验收。",
  };
}

type GroupOption = {
  value: string;
  label: string;
  description: string;
  recommended?: boolean;
};
function groupOptions(
  group: DetailGroupKey,
  intent: PRDIntake["intent"],
  completeAction: boolean,
): GroupOption[] {
  const threshold = intent === "threshold";
  const platformDescriptions: Record<DetailGroupKey, string> = {
    motion: "只按上方填写的一个测试任务检查，不另加步骤。",
    lifecycle: threshold
      ? "手动开始模拟测试，观察到设定时间后结束；取消时停止本轮程序。"
      : "手动开始，从模型初始姿势测试；到设定时间结束，取消时停止本轮程序。",
    device_mapping: "先用电脑里的模拟设备，不需要猜实物接线。",
    coordinates: threshold
      ? "模拟传感器用 0 到 1 的数值，输出 0 表示关、1 表示开。"
      : "使用所选模型的零位和转动方向。页面填度数，程序自动换成弧度。",
    communication:
      "先让两端在电脑里通过虚拟串口收发消息，每秒 20 次，失联 0.6 秒后输出归零。",
    faults:
      "拒绝格式不对的消息；失联 0.6 秒后输出归零，检查约定范围，不自动恢复运行。",
    acceptance: threshold
      ? "检查模拟值到达阈值时开、低于阈值时关，以及编译和通信结果。"
      : "检查单个关节是否到达目标、误差是否合格，以及编译和通信结果。",
    environment: threshold
      ? "先用电脑生成的数值测试，不需要填写真实传感器周围的环境。"
      : "先在电脑里使用固定基座、零重力的模型，不把仿真当作实物负载或碰撞验证。",
  };
  const extraDescriptions: Record<DetailGroupKey, string> = {
    motion: "记录先做什么、后做什么，以及哪些动作同时做。",
    lifecycle: "比如见到人后开始、结束后放下手臂、取消后停在哪里。",
    device_mapping: "按照实物资料记录关节、电机、驱动器和接线。",
    coordinates:
      "比如实际电机的正方向相反，或传感器反馈需要换算；以真实资料为准。",
    communication: "比如需要真实串口或 CAN、改变发送频率，先记录所需方式。",
    faults: "比如出现异常后必须人工确认，或者需要另外的停止规则。",
    acceptance:
      "比如招手三次、最后放下手臂、整个动作没有漏掉步骤，分别写清怎样检查。",
    environment: "比如需要带负载、有桌面或人员、活动空间受限；只填已知条件。",
  };
  const needsActionRules =
    completeAction && (group === "lifecycle" || group === "acceptance");
  return [
    {
      value: "platform",
      label: "采用当前本机设置",
      description:
        platformDescriptions[group] +
        (needsActionRules
          ? " 这些规则只覆盖现有单项测试，还不能说明整套动作的结果。"
          : ""),
      recommended: !needsActionRules,
    },
    {
      value: "custom",
      label: "我要补充要求",
      description: extraDescriptions[group],
      recommended: needsActionRules,
    },
  ];
}

export function PlatformDetailsAction({
  details,
  intent,
  disabled,
  onChange,
  v5Motion = false,
}: {
  details: IntakeDetails;
  intent: PRDIntake["intent"];
  disabled: boolean;
  onChange: (next: IntakeDetails) => void;
  v5Motion?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="guide-suggestions details-adopt">
      <div>
        <strong>本轮只按平台现有方式在电脑里测试？</strong>
        <p>
          可以一次确认下列设置。只补没有额外内容的空白组，不改已写要求，不确认任何实物接线。
        </p>
        <button
          type="button"
          className="text-button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          查看将采用的具体设置
        </button>
        {open && (
          <ul className="details-platform-list">
            {Object.entries(factsForIntent(intent, v5Motion)).map(
              ([group, text]) => (
                <li key={group}>
                  <strong>{detailLabels[group as DetailGroupKey]}：</strong>
                  {text}
                </li>
              ),
            )}
          </ul>
        )}
      </div>
      <button
        className="button secondary"
        type="button"
        disabled={disabled}
        onClick={() => onChange(adoptPlatformDetails(details))}
      >
        采用当前本机测试设置
      </button>
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  disabled,
  placeholder,
  short = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  placeholder?: string;
  short?: boolean;
}) {
  const props = {
    "aria-label": label,
    value,
    disabled,
    maxLength: 2000,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      onChange(e.target.value),
    placeholder: placeholder || "不知道可以先留空",
  };
  return (
    <label className="field">
      <span>{label}</span>
      {short ? <input {...props} /> : <textarea rows={2} {...props} />}
    </label>
  );
}
function Choice({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string | null;
  options: [string, string][];
  onChange: (value: string | null) => void;
  disabled: boolean;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select
        aria-label={label}
        value={value || ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">还没确认</option>
        {options.map(([key, text]) => (
          <option value={key} key={key}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}
function Group({
  group,
  fact,
  description,
  selection,
  onSelection,
  options,
  extras,
  onClear,
  disabled,
  children,
}: {
  group: DetailGroupKey;
  fact: string;
  description: string;
  selection?: DetailSelection;
  onSelection?: (selection: DetailSelection) => void;
  options?: GroupOption[];
  extras: boolean;
  onClear: () => void;
  disabled: boolean;
  children: ReactNode;
}) {
  const [clearing, setClearing] = useState(false);
  return (
    <section
      className="prd-detail-group"
      aria-label={detailLabels[group]}
      data-intake-path={`prd.intake.details.${group}`}
      tabIndex={-1}
    >
      <div className="detail-group-heading">
        <h4>{detailLabels[group]}</h4>
        <span className="origin-tag">需求记录</span>
      </div>
      <p className="guide-intro">{description}</p>
      <details className="detail-platform-fact">
        <summary>平台当前怎么做 · 已知设置</summary>
        <p>{fact}</p>
        <small>
          来源：平台通信约定、模型和现有检查规则；不是实物验证结果。
        </small>
      </details>
      {onSelection && (
        <GuideOptions
          label={`${detailLabels[group]}的要求`}
          value={selection ?? null}
          options={options || []}
          disabled={disabled}
          onChange={(value) => onSelection(value as DetailSelection)}
        />
      )}
      {(selection === "custom" || extras) && onSelection && (
        <p className="detail-scope-note">
          额外要求会保存，但当前执行器还不支持。改回“本机设置”也不会忽略下面的内容。
        </p>
      )}
      {children}
      {extras && (
        <div className="detail-clear">
          {!clearing ? (
            <button
              type="button"
              disabled={disabled}
              className="text-button"
              onClick={() => setClearing(true)}
            >
              清空本组补充并采用本机设置
            </button>
          ) : (
            <>
              <span>会删除“{detailLabels[group]}”里的补充内容。</span>
              <button
                type="button"
                className="button secondary"
                disabled={disabled}
                onClick={() => {
                  onClear();
                  setClearing(false);
                }}
              >
                确认清空本组
              </button>
              <button
                className="text-button"
                disabled={disabled}
                type="button"
                onClick={() => setClearing(false)}
              >
                保留内容
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
function RowsActions({
  index,
  total,
  onMove,
  onRemove,
  disabled,
  label,
}: {
  index: number;
  total: number;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
  disabled: boolean;
  label: string;
}) {
  return (
    <div className="detail-row-actions">
      <button
        type="button"
        className="button secondary"
        disabled={disabled || index === 0}
        aria-label={`上移${label}`}
        onClick={() => onMove(-1)}
      >
        <ArrowUp size={17} />
      </button>
      <button
        type="button"
        className="button secondary"
        disabled={disabled || index === total - 1}
        aria-label={`下移${label}`}
        onClick={() => onMove(1)}
      >
        <ArrowDown size={17} />
      </button>
      <button
        type="button"
        className="button secondary"
        disabled={disabled}
        aria-label={`删除${label}`}
        onClick={onRemove}
      >
        <Trash size={17} />
      </button>
    </div>
  );
}
function JointChoice({
  label,
  value,
  structure,
  disabled,
  onChange,
}: {
  label: string;
  value: string | null;
  structure: Structure | null;
  disabled: boolean;
  onChange: (value: string | null) => void;
}) {
  const joints = structure?.joints.filter((j) => j.type !== "fixed") || [];
  return (
    <Choice
      label={label}
      value={value}
      disabled={disabled}
      onChange={onChange}
      options={[
        ...(value && !joints.some((j) => j.name === value)
          ? [[value, `${value}（不在当前结构中，待重选）`] as [string, string]]
          : []),
        ...joints.map(
          (j) =>
            [j.name, j.label ? `${j.label} · ${j.name}` : j.name] as [
              string,
              string,
            ],
        ),
      ]}
    />
  );
}

export default function PRDDetails({
  step,
  details,
  answers,
  intent,
  structure,
  angleUnit,
  disabled,
  completeAction = false,
  v5Motion = false,
  onChange,
}: Props) {
  const currentStructure =
    structure?.id === answers.structure_id ? structure : null;
  const mappingHash =
    currentStructure?.mapping_source_sha256 || currentStructure?.content_sha256;
  const update = <K extends DetailGroupKey>(
    group: K,
    patch: Partial<IntakeDetails[K]>,
  ) => onChange({ ...details, [group]: { ...details[group], ...patch } });
  const groupProps = (group: DetailGroupKey) => ({
    group,
    fact: factsForIntent(intent, v5Motion)[group],
    extras: hasDetailExtras(group, details[group]),
    onClear: () => onChange(clearDetailGroup(details, group)),
    disabled,
  });
  const selectionProps = (
    group: Exclude<DetailGroupKey, "motion" | "device_mapping">,
  ) => ({
    ...groupProps(group),
    selection: details[group].selection,
    options: v5Motion
      ? groupOptions(group, intent, false).map((option) =>
          option.value === "platform"
            ? { ...option, description: factsForIntent(intent, true)[group] }
            : option,
        )
      : groupOptions(group, intent, completeAction),
    onSelection: (selection: DetailSelection) => update(group, { selection }),
  });
  const shown = (group: Exclude<DetailGroupKey, "motion" | "device_mapping">) =>
    details[group].selection === "custom" ||
    hasDetailExtras(group, details[group]);
  const numeric = (
    label: string,
    value: number | null,
    onValue: (value: number | null) => void,
    suffix: string,
    angle = false,
  ) => (
    <GuideNumber
      label={label}
      value={value}
      unit={angle ? angleUnit : "number"}
      suffix={angle ? (angleUnit === "deg" ? "°" : "rad") : suffix}
      disabled={disabled}
      onChange={onValue}
      suggested={false}
    />
  );
  return (
    <div className="prd-details">
      {step === 3 && (
        <>
          {(!completeAction || hasDetailExtras("motion", details.motion)) && (
            <Group
              {...groupProps("motion")}
              description="是只做上面这个动作，还是还要先后、同时做别的事？"
            >
              <GuideOptions
                label="动作怎样安排"
                value={details.motion.pattern}
                disabled={disabled}
                options={[
                  {
                    value: "from_answers",
                    label: "只做上面这个任务",
                    description:
                      intent === "threshold"
                        ? "按模拟值是否达到阈值来开关，不另外添加动作。"
                        : "使用上面填写的动作参数，不另外添加步骤。",
                    recommended: !completeAction,
                  },
                  {
                    value: "sequence",
                    label: "按顺序做几步",
                    description:
                      "比如先抬手、再招手、最后放下。完整保留这些要求，先作为草稿核对。",
                  },
                  {
                    value: "parallel",
                    label: "有些动作同时做",
                    description:
                      "比如一边抬手一边转头；需要写清哪些步骤一起开始、怎样结束。",
                  },
                ]}
                onChange={(pattern) =>
                  update("motion", {
                    pattern: pattern as IntakeDetails["motion"]["pattern"],
                  })
                }
              />
              <GuideOptions
                label="什么时候算这组动作完成"
                value={details.motion.completion}
                disabled={disabled}
                options={[
                  {
                    value: "all",
                    label: "每一步都做完",
                    description:
                      "上面写到的动作和次数都要完成，不能只完成其中一步。",
                    recommended: true,
                  },
                  {
                    value: "custom",
                    label: "还有别的结束条件",
                    description: "比如收到停止指令才结束。选择后在下面写清楚。",
                  },
                ]}
                onChange={(completion) =>
                  update("motion", {
                    completion:
                      completion as IntakeDetails["motion"]["completion"],
                  })
                }
              />
              {(details.motion.completion === "custom" ||
                details.motion.completion_note.trim()) && (
                <TextField
                  label="整组动作完成的条件"
                  value={details.motion.completion_note}
                  disabled={disabled}
                  onChange={(completion_note) =>
                    update("motion", { completion_note })
                  }
                  placeholder="例如：三个关节都回到指定位置，才算结束"
                />
              )}
              {(details.motion.pattern === "sequence" ||
                details.motion.pattern === "parallel" ||
                details.motion.steps.length > 0) && (
                <>
                  <p className="detail-scope-note">
                    这里收集完整步骤，不会把它们自动变成已支持的单关节任务。需要同时做的动作，请在各步骤说明里写清与谁一起开始、何时结束。
                  </p>
                  {details.motion.steps.map((row, index) => {
                    const patch = (value: Partial<typeof row>) =>
                      update("motion", {
                        steps: details.motion.steps.map((item) =>
                          item.id === row.id ? { ...item, ...value } : item,
                        ),
                      });
                    return (
                      <div className="detail-row-card" key={row.id}>
                        <header>
                          <strong>步骤 {index + 1}</strong>
                          <RowsActions
                            index={index}
                            total={details.motion.steps.length}
                            disabled={disabled}
                            label={`步骤${index + 1}`}
                            onMove={(direction) =>
                              update("motion", {
                                steps: reorderRow(
                                  details.motion.steps,
                                  index,
                                  direction,
                                ),
                              })
                            }
                            onRemove={() =>
                              update("motion", {
                                steps: details.motion.steps.filter(
                                  (item) => item.id !== row.id,
                                ),
                              })
                            }
                          />
                        </header>
                        <Choice
                          label={`步骤${index + 1}做什么`}
                          value={row.kind}
                          disabled={disabled}
                          options={[
                            ["move", "转到一个位置"],
                            ["wait", "等待一段时间"],
                            ["condition", "等待某个条件"],
                            ["other", "其他步骤"],
                          ]}
                          onChange={(kind) =>
                            patch({
                              kind: (kind || "other") as typeof row.kind,
                            })
                          }
                        />
                        {(row.kind === "move" ||
                          row.joint_name !== null ||
                          row.target_rad !== null) && (
                          <div className="guide-fields">
                            <JointChoice
                              label={`步骤${index + 1}的关节`}
                              value={row.joint_name}
                              structure={currentStructure}
                              disabled={disabled}
                              onChange={(joint_name) => patch({ joint_name })}
                            />
                            {numeric(
                              `步骤${index + 1}的目标角度`,
                              row.target_rad,
                              (target_rad) => patch({ target_rad }),
                              "",
                              true,
                            )}
                          </div>
                        )}
                        {(row.kind === "wait" || row.duration_s !== null) &&
                          numeric(
                            `步骤${index + 1}等待多久`,
                            row.duration_s,
                            (duration_s) => patch({ duration_s }),
                            "秒",
                          )}
                        {(row.kind === "condition" || row.condition.trim()) && (
                          <TextField
                            label={`步骤${index + 1}等待什么条件`}
                            value={row.condition}
                            disabled={disabled}
                            onChange={(condition) => patch({ condition })}
                          />
                        )}
                        <TextField
                          label={`步骤${index + 1}的说明`}
                          value={row.description}
                          disabled={disabled}
                          onChange={(description) => patch({ description })}
                          placeholder="比如和哪一步同时开始、结束时保持什么姿态"
                        />
                        <details className="guide-extra" open={undefined}>
                          <summary>超时和失败时怎么处理</summary>
                          <div className="guide-fields">
                            {numeric(
                              `步骤${index + 1}最多等多久`,
                              row.timeout_s,
                              (timeout_s) => patch({ timeout_s }),
                              "秒",
                            )}
                            <TextField
                              label={`步骤${index + 1}失败后怎么办`}
                              value={row.on_failure}
                              disabled={disabled}
                              onChange={(on_failure) => patch({ on_failure })}
                            />
                          </div>
                        </details>
                      </div>
                    );
                  })}
                  <button
                    type="button"
                    className="button secondary"
                    disabled={disabled || details.motion.steps.length >= 20}
                    onClick={() =>
                      update("motion", {
                        steps: [...details.motion.steps, newMotionStep()],
                      })
                    }
                  >
                    <Plus size={17} />
                    增加一个步骤
                  </button>
                </>
              )}
            </Group>
          )}
          <Group
            {...selectionProps("lifecycle")}
            description="什么时候开始、做完后怎样停下、中途取消时怎么办？"
          >
            {shown("lifecycle") && (
              <>
                <TextField
                  label="开始条件和开始前的状态"
                  value={details.lifecycle.start}
                  disabled={disabled}
                  onChange={(start) => update("lifecycle", { start })}
                  placeholder="谁来触发？启动前各部位在哪里？"
                />
                <TextField
                  label="结束后要保持什么状态"
                  value={details.lifecycle.finish}
                  disabled={disabled}
                  onChange={(finish) => update("lifecycle", { finish })}
                />
                <TextField
                  label="中途取消时怎么处理"
                  value={details.lifecycle.cancel}
                  disabled={disabled}
                  onChange={(cancel) => update("lifecycle", { cancel })}
                />
              </>
            )}
          </Group>
        </>
      )}
      {step === 4 && (
        <>
          <Group
            {...groupProps("device_mapping")}
            description="把模型里的关节和将来使用的电机、驱动器、反馈对应起来。"
          >
            <GuideOptions
              label="这些设备对应关系用在哪里"
              value={details.device_mapping.scope}
              disabled={disabled}
              options={[
                {
                  value: "simulation_only",
                  label: "先用模拟设备",
                  description:
                    "没有实物也能先整理需求；不需要填写电机地址、引脚或接线。",
                  recommended: true,
                },
                {
                  value: "reference_only",
                  label: "先把实物资料存好",
                  description:
                    "已经有手册或接线资料，可以记在下面；这轮仍不连接实物。",
                },
                {
                  value: "required",
                  label: "这轮必须用实物",
                  description:
                    "记录真实设备要求；目前不能执行这种任务，资料缺失时不会猜测。",
                },
              ]}
              onChange={(scope) =>
                update("device_mapping", {
                  scope: scope as IntakeDetails["device_mapping"]["scope"],
                })
              }
            />
            {(details.device_mapping.scope === "reference_only" ||
              details.device_mapping.scope === "required" ||
              details.device_mapping.entries.length > 0) && (
              <>
                <p className="field-hint">
                  每行独立记录一个关节。模型或关节变了，原记录仍保留，需要手动重新关联；地址、引脚和电压不要猜。
                </p>
                {details.device_mapping.entries.map((row, index) => {
                  const patch = (value: Partial<typeof row>) =>
                    update("device_mapping", {
                      entries: details.device_mapping.entries.map((item) =>
                        item.id === row.id ? { ...item, ...value } : item,
                      ),
                    });
                  const match = Boolean(
                    row.source_sha256 &&
                    mappingHash &&
                    row.source_sha256 === mappingHash,
                  );
                  return (
                    <div className="detail-row-card" key={row.id}>
                      <header>
                        <strong>设备对应 {index + 1}</strong>
                        <button
                          type="button"
                          className="button secondary"
                          disabled={disabled}
                          aria-label={`删除设备对应${index + 1}`}
                          onClick={() =>
                            update("device_mapping", {
                              entries: details.device_mapping.entries.filter(
                                (item) => item.id !== row.id,
                              ),
                            })
                          }
                        >
                          <Trash size={17} />
                        </button>
                      </header>
                      <p className="detail-binding">
                        {row.structure_id
                          ? `已记录结构：${row.structure_id}`
                          : "还没关联结构"}
                        {row.source_sha256 && (
                          <small>来源摘要：{row.source_sha256}</small>
                        )}
                      </p>
                      <button
                        type="button"
                        className="button secondary"
                        disabled={
                          disabled || !mappingHash || !answers.joint_name
                        }
                        onClick={() =>
                          patch({
                            structure_id: currentStructure!.id,
                            source_sha256: mappingHash!,
                            joint_name: answers.joint_name,
                          })
                        }
                      >
                        关联当前结构与所选关节
                      </button>
                      {!match && row.structure_id && (
                        <p className="detail-scope-note">
                          这行记录的结构与当前选择不一致，请核对后重新关联。
                        </p>
                      )}
                      {!currentStructure && (
                        <p className="field-hint">
                          先在第 2 步选结构与关节，再回来关联。
                        </p>
                      )}
                      <JointChoice
                        label={`设备对应${index + 1}的关节`}
                        value={row.joint_name}
                        structure={match ? currentStructure : null}
                        disabled={disabled || !match}
                        onChange={(joint_name) => patch({ joint_name })}
                      />
                      <div className="guide-fields">
                        <TextField
                          short
                          label={`设备${index + 1}的电机或舵机`}
                          value={row.device}
                          disabled={disabled}
                          onChange={(device) => patch({ device })}
                        />
                        <TextField
                          short
                          label={`设备${index + 1}的驱动器`}
                          value={row.driver}
                          disabled={disabled}
                          onChange={(driver) => patch({ driver })}
                        />
                        <TextField
                          short
                          label={`设备${index + 1}的连接接口`}
                          value={row.interface}
                          disabled={disabled}
                          onChange={(value) => patch({ interface: value })}
                          placeholder="例如：某个串口、CAN 通道"
                        />
                        <TextField
                          short
                          label={`设备${index + 1}的地址或通道号`}
                          value={row.address}
                          disabled={disabled}
                          onChange={(address) => patch({ address })}
                        />
                        <TextField
                          label={`设备${index + 1}的接线`}
                          value={row.wiring}
                          disabled={disabled}
                          onChange={(wiring) => patch({ wiring })}
                        />
                        <TextField
                          label={`设备${index + 1}从哪里获得反馈`}
                          value={row.feedback}
                          disabled={disabled}
                          onChange={(feedback) => patch({ feedback })}
                        />
                        <TextField
                          label={`设备${index + 1}的资料出处`}
                          value={row.source}
                          disabled={disabled}
                          onChange={(source) => patch({ source })}
                        />
                        <Choice
                          label={`设备${index + 1}的资料状态`}
                          value={row.status}
                          disabled={disabled}
                          options={[
                            ["unknown", "还没确认"],
                            ["provided", "已填写，待核对"],
                            ["documented", "已填资料出处"],
                          ]}
                          onChange={(status) =>
                            patch({
                              status: (status ||
                                "unknown") as typeof row.status,
                            })
                          }
                        />
                      </div>
                    </div>
                  );
                })}
                <button
                  type="button"
                  className="button secondary"
                  disabled={
                    disabled || details.device_mapping.entries.length >= 20
                  }
                  onClick={() =>
                    update("device_mapping", {
                      entries: [
                        ...details.device_mapping.entries,
                        newDeviceMapping(),
                      ],
                    })
                  }
                >
                  <Plus size={17} />
                  增加设备对应
                </button>
              </>
            )}
          </Group>
          <Group
            {...selectionProps("coordinates")}
            description="零点在哪里、哪边算正方向，收到的数字又代表什么？"
          >
            {currentStructure && (
              <p className="field-hint">
                当前结构：{currentStructure.name}；关节：
                {answers.joint_name || "待选"}。模型方向与范围可在第 2
                步查看，实物安装方向仍需单独确认。
              </p>
            )}
            {shown("coordinates") && (
              <div className="guide-fields">
                {(
                  [
                    ["zero", "零位怎么确定"],
                    ["direction", "哪边算正方向"],
                    ["command_unit", "指令的数值和单位"],
                    ["feedback", "反馈数值和单位"],
                    ["conversion", "实物数值怎样换成模型数值"],
                    ["source", "零位和单位的资料出处"],
                  ] as const
                ).map(([field, label]) => (
                  <TextField
                    key={field}
                    label={label}
                    value={details.coordinates[field]}
                    disabled={disabled}
                    onChange={(value) =>
                      update("coordinates", { [field]: value })
                    }
                  />
                ))}
              </div>
            )}
          </Group>
          <Group
            {...selectionProps("communication")}
            description="让 ROS 和 ESP32 各做什么，两端怎样传指令和反馈？"
          >
            {shown("communication") && (
              <>
                <div className="guide-fields">
                  {(
                    [
                      ["transport", "两端通过什么连接"],
                      ["ros_role", "ROS 负责什么"],
                      ["esp_role", "ESP32 负责什么"],
                      ["message", "指令和反馈要包含什么"],
                    ] as const
                  ).map(([field, label]) => (
                    <TextField
                      key={field}
                      label={label}
                      value={details.communication[field]}
                      disabled={disabled}
                      onChange={(value) =>
                        update("communication", { [field]: value })
                      }
                    />
                  ))}
                </div>
                <div className="guide-fields">
                  {numeric(
                    "每秒发送多少次",
                    details.communication.rate_hz,
                    (rate_hz) => update("communication", { rate_hz }),
                    "次/秒",
                  )}
                  {numeric(
                    "多久没有消息算失联",
                    details.communication.timeout_ms,
                    (timeout_ms) => update("communication", { timeout_ms }),
                    "毫秒",
                  )}
                </div>
              </>
            )}
          </Group>
        </>
      )}
      {step === 5 && (
        <>
          <Group
            {...selectionProps("environment")}
            description="负载、安装方式和周围环境都会影响真实效果。"
          >
            {shown("environment") && (
              <>
                <div className="guide-fields">
                  <TextField
                    label="机器人怎么安装"
                    value={details.environment.mounting}
                    disabled={disabled}
                    onChange={(mounting) => update("environment", { mounting })}
                  />
                  {numeric(
                    "需要带多重的负载",
                    details.environment.load_kg,
                    (load_kg) => update("environment", { load_kg }),
                    "kg",
                  )}
                  <TextField
                    label="周围有什么障碍或人"
                    value={details.environment.obstacles}
                    disabled={disabled}
                    onChange={(obstacles) =>
                      update("environment", { obstacles })
                    }
                  />
                  <TextField
                    label="可活动的空间"
                    value={details.environment.space}
                    disabled={disabled}
                    onChange={(space) => update("environment", { space })}
                  />
                </div>
                <TextField
                  label="其他环境条件"
                  value={details.environment.notes}
                  disabled={disabled}
                  onChange={(notes) => update("environment", { notes })}
                />
              </>
            )}
          </Group>
          <Group
            {...selectionProps("faults")}
            description="不要只写“出错就停止”，还要说明什么算出错、之后能不能继续。"
          >
            {shown("faults") && (
              <div className="guide-fields">
                {(
                  [
                    ["disconnect", "通信断开时怎么办"],
                    ["invalid_data", "反馈不对或丢失时怎么办"],
                    ["limit_hit", "碰到限制或超出范围时怎么办"],
                    ["recovery", "出错后怎样恢复"],
                  ] as const
                ).map(([field, label]) => (
                  <TextField
                    key={field}
                    label={label}
                    value={details.faults[field]}
                    disabled={disabled}
                    onChange={(value) => update("faults", { [field]: value })}
                  />
                ))}
              </div>
            )}
          </Group>
          <Group
            {...selectionProps("acceptance")}
            description="把成功标准写成能检查的条件，而不是只写“运行正常”。"
          >
            {shown("acceptance") && (
              <>
                {details.acceptance.criteria.map((row, index) => {
                  const patch = (value: Partial<typeof row>) =>
                    update("acceptance", {
                      criteria: details.acceptance.criteria.map((item) =>
                        item.id === row.id ? { ...item, ...value } : item,
                      ),
                    });
                  return (
                    <div className="detail-row-card" key={row.id}>
                      <header>
                        <strong>检查条件 {index + 1}</strong>
                        <button
                          type="button"
                          className="button secondary"
                          disabled={disabled}
                          aria-label={`删除检查条件${index + 1}`}
                          onClick={() =>
                            update("acceptance", {
                              criteria: details.acceptance.criteria.filter(
                                (item) => item.id !== row.id,
                              ),
                            })
                          }
                        >
                          <Trash size={17} />
                        </button>
                      </header>
                      <TextField
                        label={`条件${index + 1}检查什么`}
                        value={row.metric}
                        disabled={disabled}
                        onChange={(metric) => patch({ metric })}
                        placeholder="例如：完成往返的次数"
                      />
                      <div className="guide-fields">
                        <TextField
                          label={`条件${index + 1}期望结果`}
                          value={row.expected}
                          disabled={disabled}
                          onChange={(expected) => patch({ expected })}
                          placeholder="例如：完整往返 3 次"
                        />
                        <TextField
                          label={`条件${index + 1}怎么判断`}
                          value={row.method}
                          disabled={disabled}
                          onChange={(method) => patch({ method })}
                          placeholder="例如：查看关节位置记录，数 A→B→A"
                        />
                      </div>
                    </div>
                  );
                })}
                <button
                  type="button"
                  className="button secondary"
                  disabled={
                    disabled || details.acceptance.criteria.length >= 20
                  }
                  onClick={() =>
                    update("acceptance", {
                      criteria: [
                        ...details.acceptance.criteria,
                        {
                          id: crypto.randomUUID(),
                          metric: "",
                          expected: "",
                          method: "",
                        },
                      ],
                    })
                  }
                >
                  <Plus size={17} />
                  增加检查条件
                </button>
              </>
            )}
          </Group>
        </>
      )}
    </div>
  );
}

export function DetailCoverage({
  coverage,
  details,
  onStep,
  disabled,
}: {
  coverage: NonNullable<IntakeReadiness["detail_coverage"]>;
  details?: IntakeDetails;
  onStep: (step: number) => void;
  disabled: boolean;
}) {
  const statusLabels = {
    confirmed: "已确认本机设置",
    reference_only: "只存参考资料",
    missing: "待补充",
    unsupported: "当前不能执行",
  };
  return (
    <section className="detail-coverage" aria-label="详细需求汇总">
      <h4>这八类问题是否说明白了</h4>
      <p>
        下面是当前填写和支持范围。信息齐全只表示可以核对，不能替代后续代码检查。
      </p>
      {coverage.map((row) => (
        <div key={row.group} className={`detail-coverage-row ${row.status}`}>
          <div>
            <strong>{row.label}</strong>
            <span>{statusLabels[row.status]}</span>
            <p>{row.summary}</p>
            {details && (
              <details className="detail-readback">
                <summary>查看这组填写内容</summary>
                <DetailReadback value={details[row.group]} />
              </details>
            )}
          </div>
          <button
            type="button"
            className="text-button"
            disabled={disabled}
            onClick={() => onStep(row.section - 1)}
          >
            去第 {row.section} 步修改
          </button>
        </div>
      ))}
    </section>
  );
}

const readbackLabels: Record<string, string> = {
  pattern: "动作安排",
  completion: "完成方式",
  completion_note: "完成条件",
  steps: "动作步骤",
  kind: "步骤类型",
  joint_name: "关节",
  target_rad: "目标角度（rad）",
  duration_s: "时长（秒）",
  condition: "等待条件",
  timeout_s: "最多等待（秒）",
  on_failure: "失败时处理",
  description: "说明",
  selection: "采用方式",
  start: "开始条件与状态",
  finish: "结束状态",
  cancel: "取消时处理",
  scope: "使用范围",
  entries: "设备对应",
  structure_id: "记录的结构",
  source_sha256: "结构来源摘要",
  device: "电机或舵机",
  driver: "驱动器",
  interface: "连接接口",
  address: "地址或通道",
  wiring: "接线",
  feedback: "反馈",
  source: "资料出处",
  status: "资料状态",
  zero: "零位",
  direction: "正方向",
  command_unit: "指令单位",
  conversion: "换算方式",
  transport: "连接方式",
  ros_role: "ROS分工",
  esp_role: "ESP32分工",
  message: "消息内容",
  rate_hz: "每秒发送次数",
  timeout_ms: "失联时间（毫秒）",
  disconnect: "断开通信",
  invalid_data: "异常反馈",
  limit_hit: "超出范围",
  recovery: "恢复方式",
  criteria: "检查条件",
  metric: "检查什么",
  expected: "期望结果",
  method: "检查办法",
  mounting: "安装方式",
  load_kg: "负载（kg）",
  obstacles: "周围障碍",
  space: "活动空间",
  notes: "其他条件",
};
const readbackOptions: Record<string, string> = {
  platform: "采用本机设置",
  custom: "额外要求",
  from_answers: "按上方填写的动作",
  sequence: "按顺序执行",
  parallel: "包含同时动作",
  all: "填写的动作全部完成",
  simulation_only: "只用模拟设备",
  reference_only: "只存参考资料",
  required: "本轮必须使用这些设备",
  move: "转到位置",
  wait: "等待时间",
  condition: "等待条件",
  other: "其他",
  unknown: "待确认",
  provided: "已填写待核对",
  documented: "已填资料出处",
};
function DetailReadback({ value }: { value: unknown }) {
  if (Array.isArray(value))
    return value.length ? (
      <div className="detail-readback-list">
        {value.map((row, index) => (
          <div key={index}>
            <strong>第 {index + 1} 项</strong>
            <DetailReadback value={row} />
          </div>
        ))}
      </div>
    ) : (
      <span>无补充条目</span>
    );
  if (value && typeof value === "object")
    return (
      <dl>
        {Object.entries(value)
          .filter(([key]) => key !== "id")
          .map(([key, item]) => (
            <div key={key}>
              <dt>{readbackLabels[key] || key}</dt>
              <dd>
                {item !== null && typeof item === "object" ? (
                  <DetailReadback value={item} />
                ) : item === null || item === "" ? (
                  "未填写"
                ) : [
                    "selection",
                    "pattern",
                    "completion",
                    "scope",
                    "kind",
                    "status",
                  ].includes(key) ? (
                  readbackOptions[String(item)] || String(item)
                ) : (
                  String(item)
                )}
              </dd>
            </div>
          ))}
      </dl>
    );
  return <span>{String(value ?? "未填写")}</span>;
}
