import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  api,
  printable,
  type MotionPlan,
  type MotionRecipe,
  type Structure,
  type AssistRecord,
  type AssistProvenance,
} from "./api";
import {
  motionCycleCount,
  motionPlanIssues,
  repeatMotionSegment,
} from "./motionPlan";
const StructureView = lazy(() => import("./StructureView"));

type Props = {
  plan?: MotionPlan | null;
  structure: Structure | null;
  request: string;
  disabled: boolean;
  summary?: boolean;
  onChange: (value: MotionPlan | null) => void;
  onAdopt?: (recipe: MotionRecipe, endpoint: string) => void;
  source?: AssistRecord;
  provenance?: AssistProvenance | null;
  sourceStale?: boolean;
};
const degrees = (value: number) => Number(((value * 180) / Math.PI).toFixed(3));
export default function MotionPlanEditor({
  plan,
  structure,
  request,
  disabled,
  summary = false,
  onChange,
  onAdopt,
  source,
  provenance,
  sourceStale,
}: Props) {
  const [recipe, setRecipe] = useState<{
    value: MotionRecipe;
    key: string;
    endpoint: string;
  } | null>(null);
  const [side, setSide] = useState("right");
  const [cycles, setCycles] = useState(3);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(2);
  const [rounds, setRounds] = useState(3);
  const [newJoint, setNewJoint] = useState("");
  const [newAngle, setNewAngle] = useState("");
  const [poseIndex, setPoseIndex] = useState(0);
  const [clearPending, setClearPending] = useState(false);
  const [clearedPlan, setClearedPlan] = useState<MotionPlan | null>(null);
  const currentKey = JSON.stringify({
    request,
    structure: structure?.id,
    fingerprint: structure?.mapping_source_sha256 || structure?.content_sha256,
    plan,
  });
  const keyRef = useRef(currentKey);
  keyRef.current = currentKey;
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const recommend = async () => {
    if (!structure || disabled || busy) return;
    const snapshot = currentKey;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setError("");
    setRecipe(null);
    try {
      const endpoint = `/motion-v5/recipe?structure_id=${encodeURIComponent(structure.id)}&side=${side}&cycles=${cycles}`;
      const response = await api<MotionRecipe>(
        endpoint,
        undefined,
        "GET",
        abort.signal,
      );
      if (!abort.signal.aborted && snapshot === keyRef.current)
        setRecipe({
          value: response,
          key: snapshot,
          endpoint: `/api${endpoint}`,
        });
    } catch (e) {
      if (!abort.signal.aborted) setError((e as Error).message);
    } finally {
      if (controller.current === abort) setBusy(false);
    }
  };
  const shown =
    plan || (recipe?.key === currentKey ? recipe.value.motion_plan : null);
  const issues = shown ? motionPlanIssues(shown, structure) : [];
  const repeatPreview = plan
    ? repeatMotionSegment(plan, start, end, rounds)
    : null;
  const change = (value: MotionPlan) =>
    onChange({ ...value, recipe_id: "custom", reviewed: false });
  const patch = (value: Partial<MotionPlan>) =>
    plan && change({ ...plan, ...value });
  const point = (
    index: number,
    value: Partial<MotionPlan["waypoints"][number]>,
  ) =>
    plan &&
    patch({
      waypoints: plan.waypoints.map((row, i) =>
        i === index ? { ...row, ...value } : row,
      ),
    });
  const numeric = (text: string, previous: number) =>
    text.trim() && Number.isFinite(Number(text)) ? Number(text) : previous;
  return (
    <section
      className="action-draft-card motion-plan-card"
      data-intake-path="prd.intake.motion_plan"
      tabIndex={-1}
      aria-label="多关节可执行姿势程序"
    >
      <div className="action-draft-title">
        <div>
          <span className="origin-tag">本机参考仿真 · V5</span>
          <h4>{summary ? "将执行的完整动作" : "把整套动作变成逐关节姿势"}</h4>
        </div>
        <span>
          {plan
            ? plan.reviewed
              ? "已人工核对"
              : "需要人工核对"
            : "建议尚未采用"}
        </span>
      </div>
      <p>
        每行是一个完整姿势：所有参与关节同时运动到这一行角度。累计时间从动作开始计时；相同姿势可以用来停留。往返必须有明确端点，最后一行是结束姿势。阶段代号只使用英文字母、数字、下划线或短横线，如
        prepare、wave_a、finish。
      </p>
      {!summary && (
        <>
          {plan && (
            <div className="notice warning">
              <div>
                <strong>更换模型或左右手臂时，先明确清除当前执行程序</strong>
                <p>
                  原始需求、动作草稿、补充要求和已保留的来源历史继续保留；重新查看并采用参考配方后再人工核对。
                </p>
                {clearPending ? (
                  <>
                    <button
                      type="button"
                      className="button secondary"
                      disabled={disabled || busy}
                      onClick={() => {
                        setClearedPlan(structuredClone(plan));
                        setClearPending(false);
                        setRecipe(null);
                        onChange(null);
                      }}
                    >
                      确认清除当前执行程序，保留原始需求
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => setClearPending(false)}
                    >
                      取消清除
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="text-button"
                    disabled={disabled || busy}
                    onClick={() => setClearPending(true)}
                  >
                    清除执行程序后重新选择配方
                  </button>
                )}
              </div>
            </div>
          )}
          {!plan && clearedPlan && (
            <button
              type="button"
              className="button secondary"
              disabled={disabled || busy}
              onClick={() => {
                onChange({ ...clearedPlan, reviewed: false });
                setClearedPlan(null);
              }}
            >
              撤销清除，恢复上一套执行程序（需重新核对）
            </button>
          )}
          <div className="guide-fields">
            <label className="field">
              <span>参考动作</span>
              <select
                aria-label="参考手臂"
                disabled={disabled || busy}
                value={side}
                onChange={(e) => {
                  setSide(e.target.value);
                  setRecipe(null);
                }}
              >
                <option value="right">右臂抬起、招手、放下</option>
                <option value="left">左臂抬起、招手、放下</option>
              </select>
            </label>
            <label className="field">
              <span>参考招手次数</span>
              <input
                aria-label="参考招手次数"
                type="number"
                min={1}
                max={10}
                step={1}
                disabled={disabled || busy}
                value={cycles}
                onChange={(e) => {
                  setCycles(numeric(e.target.value, cycles));
                  setRecipe(null);
                }}
              />
            </label>
          </div>
          <button
            type="button"
            className="button secondary"
            disabled={
              disabled ||
              busy ||
              !structure ||
              !request.trim() ||
              !Number.isInteger(cycles) ||
              cycles < 1 ||
              cycles > 10
            }
            onClick={() => void recommend()}
          >
            {busy ? "正在读取模型动作配方…" : "查看 Sophicore 参考姿势建议"}
          </button>
          {busy && (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                controller.current?.abort();
                setBusy(false);
                setRecipe(null);
              }}
            >
              取消建议
            </button>
          )}
          {!structure && (
            <p className="field-hint">
              先在第 2 步选择 Sophicore 参考模型，再查看该模型的姿势与范围。
            </p>
          )}
        </>
      )}
      {error && <p className="notice warning">{error}</p>}
      {recipe?.key === currentKey && (
        <div className="notice">
          <div>
            <strong>{recipe.value.label}</strong>
            {recipe.value.notes.map((note, i) => (
              <p key={i}>{note}</p>
            ))}
            <details>
              <summary>推荐来源与模型依据</summary>
              <pre>{printable(recipe.value.source)}</pre>
            </details>
            {plan ? (
              <p>
                已有姿势程序保留。要比较新建议，请核对来源；不会覆盖你的角度和时间。
              </p>
            ) : (
              <button
                type="button"
                className="button primary"
                disabled={disabled || !!issues.length}
                onClick={() =>
                  onAdopt
                    ? onAdopt(recipe.value, recipe.endpoint)
                    : onChange({
                        ...structuredClone(recipe.value.motion_plan),
                        reviewed: false,
                      })
                }
              >
                采用这套参考姿势，随后人工核对
              </button>
            )}
          </div>
        </div>
      )}
      {shown && (
        <>
          {source && (
            <details className="source-details">
              <summary>
                {sourceStale
                  ? "先前参考姿势来源，需要重新核对"
                  : "已采用姿势的来源与请求记录"}
              </summary>
              <p>{source.reason}</p>
              <p>当时原话：{source.basis.request_text}</p>
              {provenance && (
                <>
                  <p>
                    工具：{provenance.tool} · {provenance.model}
                  </p>
                  <pre>{provenance.prompt}</pre>
                  <details>
                    <summary>真实参考接口响应</summary>
                    <pre>{provenance.response}</pre>
                  </details>
                </>
              )}
            </details>
          )}
          <p className="field-hint">
            姿势来源：
            {shown.recipe_id === "custom"
              ? "用户编辑的程序；参考配方数值已变化，需重新核对"
              : shown.recipe_id}{" "}
            · 配置摘要 {shown.model_source_sha256.slice(0, 16)}
            。模型限位只用于本机检查，实物零位与负载未确认。
          </p>
          {!summary && structure && !!shown.waypoints.length && (
            <details className="source-details">
              <summary>在 3D 中核对每个完整目标姿势（预览）</summary>
              <label className="field">
                <span>查看哪一行姿势</span>
                <select
                  aria-label="完整目标姿势预览"
                  value={Math.min(poseIndex, shown.waypoints.length - 1)}
                  onChange={(e) => setPoseIndex(Number(e.target.value))}
                >
                  {shown.waypoints.map((row, index) => (
                    <option key={index} value={index}>
                      第 {index + 1} 行 · {row.stage_id} · 往返{" "}
                      {row.cycle_index}
                    </option>
                  ))}
                </select>
              </label>
              <Suspense fallback={<p>正在准备目标姿势预览…</p>}>
                <StructureView
                  structure={structure}
                  previewPositions={Object.fromEntries(
                    shown.joint_names.map((name, index) => [
                      name,
                      shown.waypoints[
                        Math.min(poseIndex, shown.waypoints.length - 1)
                      ].positions[index],
                    ]),
                  )}
                />
              </Suspense>
            </details>
          )}
          <div className="motion-table-scroll">
            <table className="motion-table">
              <thead>
                <tr>
                  <th>阶段 / 往返编号</th>
                  <th>累计时间 (s)</th>
                  {shown.joint_names.map((name) => (
                    <th key={name}>
                      {structure?.joints.find((j) => j.name === name)?.label ||
                        name}
                      <small>{name}</small>
                    </th>
                  ))}
                  {plan && !summary && <th>编辑顺序</th>}
                </tr>
              </thead>
              <tbody>
                {shown.waypoints.map((row, index) => (
                  <tr key={index}>
                    <td>
                      {plan && !summary ? (
                        <>
                          <input
                            aria-label={`姿势${index + 1}阶段`}
                            disabled={disabled}
                            value={row.stage_id}
                            onChange={(e) =>
                              point(index, { stage_id: e.target.value })
                            }
                          />
                          <input
                            type="number"
                            min={0}
                            step={1}
                            aria-label={`姿势${index + 1}往返编号`}
                            disabled={disabled}
                            value={row.cycle_index}
                            onChange={(e) =>
                              point(index, {
                                cycle_index: numeric(
                                  e.target.value,
                                  row.cycle_index,
                                ),
                              })
                            }
                          />
                        </>
                      ) : (
                        `${row.stage_id} / ${row.cycle_index}`
                      )}
                    </td>
                    <td>
                      {plan && !summary ? (
                        <input
                          type="number"
                          min={0}
                          step="0.1"
                          aria-label={`姿势${index + 1}累计时间`}
                          disabled={disabled}
                          value={row.time_from_start_s}
                          onChange={(e) =>
                            point(index, {
                              time_from_start_s: numeric(
                                e.target.value,
                                row.time_from_start_s,
                              ),
                            })
                          }
                        />
                      ) : (
                        row.time_from_start_s
                      )}
                    </td>
                    {shown.joint_names.map((name, j) => {
                      const joint = structure?.joints.find(
                        (item) => item.name === name,
                      );
                      const lower = joint?.limits?.lower ?? joint?.lower;
                      const upper = joint?.limits?.upper ?? joint?.upper;
                      return (
                        <td key={name}>
                          {plan && !summary ? (
                            <input
                              type="number"
                              step="0.1"
                              aria-label={`姿势${index + 1} ${name}角度`}
                              disabled={disabled}
                              value={degrees(row.positions[j])}
                              onChange={(e) =>
                                point(index, {
                                  positions: row.positions.map((value, i) =>
                                    i === j
                                      ? (numeric(
                                          e.target.value,
                                          degrees(value),
                                        ) *
                                          Math.PI) /
                                        180
                                      : value,
                                  ),
                                })
                              }
                            />
                          ) : (
                            `${degrees(row.positions[j])}°`
                          )}
                          <small>
                            范围{" "}
                            {lower == null ? "待确认" : degrees(lower) + "°"} ～{" "}
                            {upper == null ? "待确认" : degrees(upper) + "°"}
                          </small>
                        </td>
                      );
                    })}
                    {plan && !summary && (
                      <td>
                        <button
                          type="button"
                          className="text-button"
                          disabled={disabled || index === 0}
                          aria-label={`上移姿势${index + 1}`}
                          onClick={() => {
                            const rows = structuredClone(plan.waypoints);
                            const previousTime =
                              rows[index - 1].time_from_start_s;
                            const currentTime = rows[index].time_from_start_s;
                            [rows[index - 1], rows[index]] = [
                              rows[index],
                              rows[index - 1],
                            ];
                            rows[index - 1].time_from_start_s = previousTime;
                            rows[index].time_from_start_s = currentTime;
                            patch({ waypoints: rows });
                          }}
                        >
                          上移
                        </button>
                        <button
                          type="button"
                          className="text-button"
                          disabled={disabled || plan.waypoints.length <= 1}
                          aria-label={`删除姿势${index + 1}`}
                          onClick={() =>
                            patch({
                              waypoints: plan.waypoints.filter(
                                (_, i) => i !== index,
                              ),
                            })
                          }
                        >
                          删除
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {plan && !summary && (
            <>
              <details className="source-details">
                <summary>调整参与关节（每行都要包含这些关节）</summary>
                <p>
                  新增关节必须明确填写一个角度，暂时将这一角度应用到所有行，再逐行调整。不会猜测实物零位。
                </p>
                <div className="guide-fields">
                  <label className="field">
                    <span>新增关节</span>
                    <select
                      aria-label="新增程序关节"
                      disabled={disabled}
                      value={newJoint}
                      onChange={(e) => setNewJoint(e.target.value)}
                    >
                      <option value="">请选择</option>
                      {structure?.joints
                        .filter(
                          (joint) =>
                            joint.type !== "fixed" &&
                            !plan.joint_names.includes(joint.name),
                        )
                        .map((joint) => (
                          <option key={joint.name} value={joint.name}>
                            {joint.label || joint.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>各行初始填写角度 (°)</span>
                    <input
                      aria-label="新增关节各行角度"
                      disabled={disabled}
                      type="number"
                      step="any"
                      value={newAngle}
                      onChange={(e) => setNewAngle(e.target.value)}
                    />
                  </label>
                </div>
                <button
                  type="button"
                  className="button secondary"
                  disabled={
                    disabled ||
                    !newJoint ||
                    !newAngle.trim() ||
                    !Number.isFinite(Number(newAngle))
                  }
                  onClick={() => {
                    patch({
                      joint_names: [...plan.joint_names, newJoint],
                      waypoints: plan.waypoints.map((row) => ({
                        ...row,
                        positions: [
                          ...row.positions,
                          (Number(newAngle) * Math.PI) / 180,
                        ],
                      })),
                    });
                    setNewJoint("");
                    setNewAngle("");
                  }}
                >
                  将该关节加入全部姿势
                </button>
                <ul>
                  {plan.joint_names.map((name, index) => (
                    <li key={name}>
                      {name}{" "}
                      <button
                        type="button"
                        className="text-button"
                        disabled={disabled || plan.joint_names.length <= 1}
                        aria-label={`移除程序关节 ${name}`}
                        onClick={() =>
                          patch({
                            joint_names: plan.joint_names.filter(
                              (_, i) => i !== index,
                            ),
                            waypoints: plan.waypoints.map((row) => ({
                              ...row,
                              positions: row.positions.filter(
                                (_, i) => i !== index,
                              ),
                            })),
                          })
                        }
                      >
                        从程序移除（原始需求保留）
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
              <button
                type="button"
                className="button secondary"
                disabled={disabled || !plan.waypoints.length}
                onClick={() => {
                  const last = plan.waypoints.at(-1)!;
                  patch({
                    waypoints: [
                      ...plan.waypoints,
                      {
                        ...structuredClone(last),
                        stage_id: `new_pose_${plan.waypoints.length + 1}`,
                        cycle_index: 0,
                        time_from_start_s: last.time_from_start_s + 2,
                      },
                    ],
                  });
                }}
              >
                在末尾增加姿势（复制上一行供修改）
              </button>
              <details className="source-details">
                <summary>自定义往返：重复已闭合的姿势区段</summary>
                <p>
                  从 A 经 B 回 A 才是一次完整往返。选择起止行（从 1
                  计数），两端角度必须一致，不能截断现有往返组。所选区段作为一次往返；前后动作全部保留并按完整程序重新编号。累计时间与超时同步增加，请逐行核对。
                </p>
                <div className="guide-fields">
                  {[
                    ["开始行", start + 1, (v: number) => setStart(v - 1)],
                    ["结束行", end + 1, (v: number) => setEnd(v - 1)],
                    ["所选区段执行次数", rounds, setRounds],
                  ].map(([label, value, setter]) => (
                    <label className="field" key={String(label)}>
                      <span>{String(label)}</span>
                      <input
                        aria-label={String(label)}
                        type="number"
                        min={1}
                        step={1}
                        disabled={disabled}
                        value={value as number}
                        onChange={(e) =>
                          (setter as (v: number) => void)(
                            Number(e.target.value),
                          )
                        }
                      />
                    </label>
                  ))}
                </div>
                {repeatPreview && (
                  <p className="notice">
                    所选区段将执行 {rounds} 次；整套程序约定的往返组从{" "}
                    {motionCycleCount(plan)} 次变为{" "}
                    {motionCycleCount(repeatPreview)}{" "}
                    次，前后其他动作保留。原始动作草稿的次数与原话保持原样；如有不同，也需要重新核对，后台会检查冲突。
                  </p>
                )}
                <button
                  type="button"
                  className="button secondary"
                  disabled={disabled || !repeatPreview}
                  onClick={() => {
                    const expanded = repeatPreview;
                    if (expanded) {
                      setError("");
                      onChange(expanded);
                    } else
                      setError(
                        "请选择包含一个完整往返的闭合 A → B → A 区段和 2～20 次执行；不能截断现有编号组或合并多个编号组。",
                      );
                  }}
                >
                  {repeatPreview
                    ? `展开所选区段（整套 ${motionCycleCount(repeatPreview)} 次）并重新核对`
                    : "先选择一个完整闭合往返区段"}
                </button>
              </details>
            </>
          )}
          <div className="guide-fields">
            {(
              [
                ["tolerance_rad", "到位允许误差", "rad"],
                ["max_velocity_rad_s", "最大角速度", "rad/s"],
                ["max_acceleration_rad_s2", "最大角加速度", "rad/s²"],
                ["timeout_s", "整套动作超时", "s"],
              ] as const
            ).map(([key, label, unit]) => (
              <label
                className="field"
                key={key}
                data-intake-path={`prd.intake.motion_plan.${key}`}
              >
                <span>
                  {label} ({unit})
                </span>
                {plan && !summary ? (
                  <input
                    aria-label={label}
                    disabled={disabled}
                    type="number"
                    min={0}
                    step="any"
                    value={plan[key]}
                    onChange={(e) =>
                      patch({ [key]: numeric(e.target.value, plan[key]) })
                    }
                  />
                ) : (
                  <strong>{shown[key]}</strong>
                )}
              </label>
            ))}
          </div>
          {!!issues.length && (
            <div className="notice warning">
              <ul>
                {issues.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            </div>
          )}
          {plan && (
            <label
              className="stage-review"
              data-intake-path="prd.intake.motion_plan.reviewed"
            >
              <input
                type="checkbox"
                aria-label="已人工核对完整姿势程序"
                disabled={disabled || !!issues.length || !request.trim()}
                checked={plan.reviewed}
                onChange={(e) =>
                  onChange({ ...plan, reviewed: e.target.checked })
                }
              />
              <span>
                我已核对全部参与关节、逐阶段角度、往返次数、最后姿势与时间限位。这些值只用于本机参考仿真。原话、模型或参数修改后需要重新核对。
              </span>
            </label>
          )}
        </>
      )}
      {summary && !shown && (
        <p>
          尚未采用完整姿势程序。第 3
          步可以查看模型参考建议；保存需求草稿与采用执行程序是两个操作。
        </p>
      )}
    </section>
  );
}
