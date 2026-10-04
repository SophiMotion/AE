import { Plus, Trash, ArrowUp, ArrowDown } from "@phosphor-icons/react";
import { useState } from "react";
import type { ActionDraft, Structure } from "./api";
import GuideNumber from "./GuideNumber";
import GuideOptions from "./GuideOptions";
import { numberChoices } from "./intakeChoices";
import { recommendedStageRepetitions } from "./intakeIssues";

type Props = {
  action: ActionDraft;
  structure: Structure | null;
  disabled: boolean;
  section: "joints" | "stages" | "summary";
  onChange: (action: ActionDraft) => void;
};
const scopeLabels = {
  single_joint: "单关节动作",
  multi_joint: "多个关节配合",
  other: "其他动作",
  uncertain: "参与部位还需核对",
};
export default function ActionDraftEditor({
  action,
  structure,
  disabled,
  section,
  onChange,
}: Props) {
  const [removal, setRemoval] = useState<{
    index: number;
    text: string;
  } | null>(null);
  const joints =
    structure?.joints.filter((joint) => joint.type !== "fixed") || [];
  const hasArm = action.related_joints.some((joint) =>
    /手|臂|肩|肘|arm|shoulder|elbow|wrist/i.test(
      `${joint.name} ${joint.label}`,
    ),
  );
  const endPoseOptions = [
    ...(hasArm
      ? [
          {
            value: "将手臂放下，自然垂在身体旁边。",
            label: "放下手臂，垂在身体旁边",
            description:
              "表达结束时的姿势要求；各关节应到多少度还需要结合模型确认。",
            recommended: /身体旁|自然垂|自然下垂|垂在.*两侧/.test(
              action.end_pose_text,
            ),
          },
        ]
      : []),
    {
      value: "回到动作开始前的姿势。",
      label: "回到动作开始前",
      description: "需要记住开始时各关节的位置；不是一律回到 0 度。",
      recommended: /开始前|初始姿势|起始姿势/.test(action.end_pose_text),
    },
    {
      value: "保持最后一个动作结束时的姿势。",
      label: "保持最后的姿势",
      description: "最后一步完成后停在那一姿势；具体位置由最后一步说明。",
      recommended: /保持.*(最后|结束)|最后.*保持/.test(action.end_pose_text),
    },
  ];
  const set = (patch: Partial<ActionDraft>) =>
    onChange({ ...action, ...patch, requires_review: true });
  const stage = (
    index: number,
    patch: Partial<ActionDraft["stages"][number]>,
  ) =>
    set({
      stages: action.stages.map((row, i) =>
        i === index
          ? {
              ...row,
              ...patch,
              confirmation_needed: Object.entries(patch).some(
                ([key, value]) =>
                  key !== "confirmation_needed" &&
                  JSON.stringify(row[key as keyof typeof row]) !==
                    JSON.stringify(value),
              )
                ? true
                : (patch.confirmation_needed ?? row.confirmation_needed),
            }
          : row,
      ),
    });
  const reorder = (index: number, direction: number) => {
    const rows = [...action.stages];
    [rows[index], rows[index + direction]] = [
      { ...rows[index + direction], confirmation_needed: true },
      { ...rows[index], confirmation_needed: true },
    ];
    set({ stages: rows });
  };
  return (
    <section
      className="action-draft-card"
      data-intake-path={
        section === "joints"
          ? "prd.intake.action_draft.related_joints"
          : section === "stages"
            ? "prd.intake.action_draft.stages"
            : undefined
      }
      tabIndex={section === "summary" ? undefined : -1}
      aria-label={
        section === "joints"
          ? "参与完整动作的关节"
          : section === "stages"
            ? "完整动作安排"
            : "完整动作概览"
      }
    >
      <div className="action-draft-title">
        <div>
          <span className="origin-tag">需求草稿 · 需要人工核对</span>
          <h4>
            {section === "joints"
              ? "参与完整动作的关节"
              : section === "stages"
                ? "完整动作安排"
                : "完整动作概览"}
          </h4>
        </div>
        <span>{scopeLabels[action.scope]}</span>
      </div>
      <p>{action.summary}</p>
      <p className="field-hint">
        这里保留原始动作说明和待核对项。实际执行还需要逐关节姿势程序与后台能力检查；未确定的原始角度继续留空。
      </p>
      {section === "summary" ? (
        <>
          <ol className="action-overview-list">
            {action.stages.map((row) => (
              <li key={row.id}>
                <strong>
                  {row.title}
                  {row.repetitions != null ? ` · ${row.repetitions} 次` : ""}
                </strong>
                <p>{row.description}</p>
                <small>
                  {row.joint_names
                    .map(
                      (name) =>
                        action.related_joints.find((j) => j.name === name)
                          ?.label || name,
                    )
                    .join("、") || "关节待确定"}
                  {row.target_rad != null
                    ? ` · ${((row.target_rad * 180) / Math.PI).toFixed(1)}°`
                    : ""}
                  {row.confirmation_needed ? " · 仍需核对" : ""}
                </small>
              </li>
            ))}
          </ol>
          <p>
            <strong>结束姿势：</strong>
            {action.end_pose_text || "待确认"}
          </p>
          <p>
            <strong>相关关节：</strong>
            {action.related_joints.map((joint) => joint.label).join("、") ||
              "待确认"}
          </p>
        </>
      ) : section === "joints" ? (
        <>
          {action.related_joints.map((joint, index) => (
            <div
              className="action-joint-row"
              key={`${joint.name}-${index}`}
              data-intake-path={`prd.intake.action_draft.related_joints.${index}`}
              tabIndex={-1}
            >
              <label className="field">
                <span>相关关节 {index + 1}</span>
                <select
                  aria-label={`相关关节${index + 1}`}
                  disabled={disabled}
                  value={joint.name}
                  onChange={(e) => {
                    const found = joints.find((j) => j.name === e.target.value);
                    const rows = action.related_joints.map((row, i) =>
                      i === index
                        ? {
                            ...row,
                            name: e.target.value,
                            label: found?.label || e.target.value,
                          }
                        : row,
                    );
                    set({
                      related_joints: rows,
                      reference_joint:
                        action.reference_joint === joint.name
                          ? e.target.value
                          : action.reference_joint,
                      stages: action.stages.map((row) => ({
                        ...row,
                        confirmation_needed:
                          row.joint_names.includes(joint.name) &&
                          e.target.value !== joint.name
                            ? true
                            : row.confirmation_needed,
                        joint_names: row.joint_names.map((name) =>
                          name === joint.name ? e.target.value : name,
                        ),
                      })),
                    });
                  }}
                >
                  {!joints.some((item) => item.name === joint.name) && (
                    <option value={joint.name}>
                      {joint.label} · 当前结构找不到
                    </option>
                  )}
                  {joints.map((item) => (
                    <option
                      key={item.name}
                      value={item.name}
                      disabled={action.related_joints.some(
                        (other, i) => i !== index && other.name === item.name,
                      )}
                    >
                      {item.label || item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>负责什么</span>
                <input
                  aria-label={`关节${index + 1}负责什么`}
                  disabled={disabled}
                  value={joint.role}
                  onChange={(e) =>
                    set({
                      related_joints: action.related_joints.map((row, i) =>
                        i === index ? { ...row, role: e.target.value } : row,
                      ),
                    })
                  }
                />
                <small>{joint.reason}</small>
              </label>
              <button
                className="icon-button"
                aria-label={`移除相关关节${index + 1}`}
                disabled={disabled}
                onClick={() =>
                  set({
                    related_joints: action.related_joints.filter(
                      (_, i) => i !== index,
                    ),
                    reference_joint:
                      action.reference_joint === joint.name
                        ? null
                        : action.reference_joint,
                    stages: action.stages.map((row) => ({
                      ...row,
                      confirmation_needed: row.joint_names.includes(joint.name)
                        ? true
                        : row.confirmation_needed,
                      joint_names: row.joint_names.filter(
                        (name) => name !== joint.name,
                      ),
                    })),
                  })
                }
              >
                <Trash size={18} />
              </button>
            </div>
          ))}
          <button
            className="button secondary"
            disabled={
              disabled ||
              !joints.some(
                (j) =>
                  !action.related_joints.some((row) => row.name === j.name),
              )
            }
            onClick={() => {
              const joint = joints.find(
                (j) =>
                  !action.related_joints.some((row) => row.name === j.name),
              );
              if (joint)
                set({
                  related_joints: [
                    ...action.related_joints,
                    {
                      name: joint.name,
                      label: joint.label || joint.name,
                      role: "",
                      reason: "用户添加，请核对作用",
                    },
                  ],
                });
            }}
          >
            <Plus size={18} />
            增加相关关节
          </button>
        </>
      ) : (
        <>
          <label
            className="field"
            data-intake-path="prd.intake.action_draft.summary"
          >
            <span>完整动作说明</span>
            <textarea
              maxLength={2000}
              aria-label="完整动作说明"
              rows={2}
              value={action.summary}
              disabled={disabled}
              onChange={(e) => set({ summary: e.target.value })}
            />
          </label>
          {action.stages.map((row, index) => (
            <article
              className="action-stage"
              key={row.id}
              data-intake-path={`prd.intake.action_draft.stages.${index}`}
              tabIndex={-1}
            >
              <div className="action-stage-heading">
                <strong>第 {index + 1} 步</strong>
                <div>
                  <button
                    className="icon-button"
                    aria-label={`上移动作阶段${index + 1}`}
                    disabled={disabled || index === 0}
                    onClick={() => reorder(index, -1)}
                  >
                    <ArrowUp size={17} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`下移动作阶段${index + 1}`}
                    disabled={disabled || index === action.stages.length - 1}
                    onClick={() => reorder(index, 1)}
                  >
                    <ArrowDown size={17} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`删除动作阶段${index + 1}`}
                    disabled={disabled}
                    onClick={() =>
                      set({
                        stages: action.stages.filter((_, i) => i !== index),
                      })
                    }
                  >
                    <Trash size={17} />
                  </button>
                </div>
              </div>
              <label
                className="field"
                data-intake-path={`prd.intake.action_draft.stages.${index}.title`}
              >
                <span>做什么</span>
                <input
                  aria-label={`动作阶段${index + 1}名称`}
                  value={row.title}
                  disabled={disabled}
                  onChange={(e) => stage(index, { title: e.target.value })}
                />
              </label>
              <label
                className="field"
                data-intake-path={`prd.intake.action_draft.stages.${index}.description`}
              >
                <span>怎么做</span>
                <textarea
                  maxLength={2000}
                  aria-label={`动作阶段${index + 1}说明`}
                  rows={2}
                  value={row.description}
                  disabled={disabled}
                  onChange={(e) =>
                    stage(index, { description: e.target.value })
                  }
                />
              </label>
              <fieldset
                className="stage-joints"
                data-intake-path={`prd.intake.action_draft.stages.${index}.joint_names`}
              >
                <legend>这一步用到哪些关节</legend>
                {action.related_joints.map((joint) => (
                  <label key={joint.name}>
                    <input
                      type="checkbox"
                      disabled={disabled}
                      checked={row.joint_names.includes(joint.name)}
                      onChange={(e) =>
                        stage(index, {
                          joint_names: e.target.checked
                            ? [...row.joint_names, joint.name]
                            : row.joint_names.filter(
                                (name) => name !== joint.name,
                              ),
                        })
                      }
                    />
                    {joint.label}
                  </label>
                ))}
                {!action.related_joints.length && (
                  <small>先在第 2 步选择相关关节。</small>
                )}
              </fieldset>
              <div className="guide-fields">
                <div
                  className="guide-field-anchor"
                  data-intake-path={`prd.intake.action_draft.stages.${index}.repetitions`}
                >
                  <GuideNumber
                    suggested={false}
                    label={`动作阶段${index + 1}重复次数`}
                    value={row.repetitions}
                    unit="number"
                    suffix="次"
                    choices={numberChoices("repetitions").map((choice) => ({
                      ...choice,
                      recommended:
                        choice.value === recommendedStageRepetitions(row.title),
                      description:
                        choice.value === 1
                          ? "这一步只做一次，适合抬起、放下等阶段。"
                          : `仅把当前这一步重复 ${choice.value} 次，不会改变其他阶段。`,
                    }))}
                    hint="次数只针对这一阶段。准备、抬起、放下通常做 1 次；招手几次以原话为准。推荐不会改动已填次数，请核对后再选。"
                    disabled={disabled}
                    onChange={(value) => stage(index, { repetitions: value })}
                  />
                </div>
                {row.joint_names.length <= 1 ? (
                  <div
                    className="guide-field-anchor"
                    data-intake-path={`prd.intake.action_draft.stages.${index}.target_rad`}
                  >
                    <GuideNumber
                      suggested={false}
                      label={`动作阶段${index + 1}目标角度`}
                      value={row.target_rad}
                      unit="deg"
                      suffix="°"
                      disabled={disabled}
                      hint="只有一个关节时可填写。先用结构预览核对姿势与转动范围；不知道角度就留空，不能把‘放下’直接写成 0°。"
                      onChange={(value) => stage(index, { target_rad: value })}
                    />
                  </div>
                ) : (
                  <div
                    className="field-hint"
                    data-intake-path={`prd.intake.action_draft.stages.${index}.target_rad`}
                    tabIndex={-1}
                  >
                    多个关节分别需要角度；请在说明里记录，不能用一个数代替整套姿势。
                    {row.target_rad !== null && (
                      <p className="assistant-warning">
                        之前填写的单关节角度还在，不能用于这些关节。
                        <button
                          className="text-button"
                          disabled={disabled}
                          onClick={() => stage(index, { target_rad: null })}
                        >
                          清除这一个不适用的角度
                        </button>
                      </p>
                    )}
                  </div>
                )}
              </div>
              <div
                className="stage-review"
                data-intake-path={`prd.intake.action_draft.stages.${index}.confirmation_needed`}
                role="group"
                aria-label={`第${index + 1}阶段核对状态`}
                tabIndex={-1}
              >
                <div>
                  <strong
                    className={
                      row.confirmation_needed
                        ? "stage-review-pending"
                        : "stage-review-done"
                    }
                  >
                    {row.confirmation_needed ? "待核对" : "已核对"}
                  </strong>
                  <p>
                    {row.confirmation_needed
                      ? "请看清这一步的关节、动作、次数和角度。有不确定的地方先保留，核对后再确认。"
                      : "你已确认这一步的需求。修改动作内容后，需要重新核对。"}
                  </p>
                </div>
                <button
                  type="button"
                  className="button secondary"
                  aria-label={
                    row.confirmation_needed
                      ? `确认第${index + 1}阶段：${row.title}`
                      : `将第${index + 1}阶段重新标为待核对`
                  }
                  disabled={disabled}
                  onClick={() =>
                    stage(index, {
                      confirmation_needed: !row.confirmation_needed,
                    })
                  }
                >
                  {row.confirmation_needed
                    ? "我已核对这一步"
                    : "重新标为待核对"}
                </button>
              </div>
            </article>
          ))}
          <button
            className="button secondary"
            disabled={disabled || action.stages.length >= 12}
            onClick={() =>
              set({
                stages: [
                  ...action.stages,
                  {
                    id: crypto.randomUUID(),
                    title: "",
                    description: "",
                    joint_names: [],
                    repetitions: null,
                    target_rad: null,
                    confirmation_needed: true,
                  },
                ],
              })
            }
          >
            <Plus size={18} />
            增加动作阶段
          </button>
          <GuideOptions
            label="结束姿势可以这样选"
            value={action.end_pose_text || null}
            options={endPoseOptions}
            disabled={disabled}
            onChange={(value) => set({ end_pose_text: value || "" })}
          />
          <p className="field-hint">
            这里只改结束姿势的文字，不会填写关节角度或清除待确认项。若与最后阶段的说明不同，请一起修改。仍可在下面写自己的要求。
          </p>
          <label
            className="field"
            data-intake-path="prd.intake.action_draft.end_pose_text"
          >
            <span>动作结束后是什么姿势</span>
            <textarea
              maxLength={2000}
              aria-label="完整动作结束姿势"
              rows={2}
              value={action.end_pose_text}
              disabled={disabled}
              onChange={(e) => set({ end_pose_text: e.target.value })}
            />
          </label>
          <section
            className="action-unresolved-editor"
            data-intake-path="prd.intake.action_draft.unresolved"
            tabIndex={-1}
            aria-label="完整动作待确认清单"
          >
            <h4>完整动作还有哪些事情没核对</h4>
            <p>
              这些是 AI
              整理需求时留下、或你后来补充的待核对提醒，不是要求再找一组隐藏的数字框。先核对上方动作阶段、相关关节或结束姿势，再逐项整理。
            </p>
            <small>
              填写速度、误差不会自动消除这些提醒。只有你确实核对过，才点击“这项已核对，移出清单”；这不代表动作已经可以执行或实物验证通过。
            </small>
            {action.unresolved.map((text, index) => (
              <article
                key={index}
                className="action-unresolved-row"
                data-intake-path={`prd.intake.action_draft.unresolved.${index}`}
                tabIndex={-1}
              >
                <label className="field">
                  <span>待核对事项 {index + 1}</span>
                  <textarea
                    aria-label={`完整动作待确认项${index + 1}`}
                    rows={3}
                    maxLength={2000}
                    disabled={disabled}
                    value={text}
                    onChange={(event) =>
                      set({
                        unresolved: action.unresolved.map((item, i) =>
                          i === index ? event.target.value : item,
                        ),
                      })
                    }
                  />
                </label>
                {removal?.index === index && removal.text === text ? (
                  <div className="unresolved-remove-confirm">
                    <p>
                      确认你已经核对这条要求？只会移出这条提醒，其他需求和执行限制仍保留。
                    </p>
                    <button
                      className="button secondary"
                      type="button"
                      disabled={disabled}
                      onClick={() => {
                        set({
                          unresolved: action.unresolved.filter(
                            (_, i) => i !== index,
                          ),
                        });
                        setRemoval(null);
                      }}
                    >
                      确认已核对并移出：第 {index + 1} 项
                    </button>
                    <button
                      className="text-button"
                      type="button"
                      disabled={disabled}
                      onClick={() => setRemoval(null)}
                    >
                      继续保留
                    </button>
                  </div>
                ) : (
                  <button
                    className="button secondary"
                    type="button"
                    disabled={disabled}
                    onClick={() => setRemoval({ index, text })}
                  >
                    这项已核对，移出清单：第 {index + 1} 项
                  </button>
                )}
              </article>
            ))}
            {!action.unresolved.length && (
              <p>
                目前没有单独列出的待核对提醒。上方各阶段仍需按实际情况检查。
              </p>
            )}
            <button
              className="button secondary"
              type="button"
              disabled={disabled || action.unresolved.length >= 30}
              onClick={() => set({ unresolved: [...action.unresolved, ""] })}
            >
              增加待核对事项
            </button>
            <details className="guide-extra">
              <summary>手动批量整理（每行一项）</summary>
              <label className="field">
                <span>完整动作待确认项</span>
                <textarea
                  maxLength={2000}
                  aria-label="完整动作待确认项"
                  rows={4}
                  value={action.unresolved.join("\n")}
                  disabled={disabled}
                  onChange={(event) =>
                    set({
                      unresolved: event.target.value
                        ? event.target.value.split("\n")
                        : [],
                    })
                  }
                />
              </label>
            </details>
          </section>
        </>
      )}
      {section !== "stages" && !!action.unresolved.length && (
        <div className="action-unresolved">
          <strong>还需要确认</strong>
          <ul>
            {action.unresolved.map((text, index) => (
              <li key={index}>{text}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
