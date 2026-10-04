import {
  ArrowRight,
  CircleNotch,
  FloppyDisk,
  SlidersHorizontal,
} from "@phosphor-icons/react";
import type {
  Catalog,
  EngineeringManifest,
  Parameters,
  PRD,
  Structure,
  Task,
} from "./api";
import { selectTask, type Draft } from "./draft";
import StructurePanel from "./StructurePanel";
import { useState } from "react";
import WorkflowEditor from "./WorkflowEditor";
import { validateWorkflow } from "./workflowModel";
import { jointBounds } from "./modelView";
import ProjectManifest from "./ProjectManifest";
export default function Requirements({
  draft,
  setDraft,
  tasks,
  catalog,
  locked: externallyLocked,
  saving,
  onSave,
  onPlan,
  manifest,
  manifestStale,
}: {
  draft: Draft;
  setDraft: (v: Draft) => void;
  tasks: Task[];
  catalog: Catalog | null;
  locked: boolean;
  saving: boolean;
  onSave: () => void;
  onPlan: () => void;
  manifest?: EngineeringManifest | null;
  manifestStale?: boolean;
}) {
  const [uploadingStructure, setUploadingStructure] = useState(false);
  const [selectedStructure, setSelectedStructure] = useState<Structure | null>(
    null,
  );
  const locked = externallyLocked || uploadingStructure;
  const setParam = (key: keyof Parameters, value: string) =>
    setDraft({
      ...draft,
      parameters: {
        ...draft.parameters,
        [key]: value.trim() === "" ? null : Number(value),
      },
    });
  const setPRD = (key: keyof PRD, value: string) =>
    setDraft({ ...draft, prd: { ...draft.prd, [key]: value } });
  const isJoint = draft.task_type === "joint_position";
  const selectedJoint =
    selectedStructure?.id === draft.prd.structure_id
      ? selectedStructure.joints.find((j) => j.name === draft.prd.joint_name)
      : undefined;
  const targetBounds = jointBounds(selectedJoint);
  const flowError = validateWorkflow(draft.workflow).error;
  const choose = (task: Task) => setDraft(selectTask(draft, task));
  const limits: [keyof Parameters, number, number, string][] = [
    ["target", targetBounds.lower, targetBounds.upper, "目标位置"],
    ["threshold", 0.1, 0.9, "触发阈值"],
    ["tolerance", 0.005, 0.15, "允许误差"],
    ["duration", 4, 30, "运行时长"],
    ["max_velocity", 0.1, 2, "最高速度"],
  ];
  const invalid = limits.find(
    ([key, min, max]) =>
      draft.parameters[key] === null ||
      !Number.isFinite(draft.parameters[key]) ||
      Number(draft.parameters[key]) < min ||
      Number(draft.parameters[key]) > max,
  );
  const validBoard = ["esp32", "esp32s3"].includes(draft.hardware.board || "");
  const validTransport = draft.hardware.transport === "serial_jsonl";
  const incomplete =
    !draft.name.trim() ||
    draft.request.trim().length < 5 ||
    !draft.prd.use_case.trim() ||
    !draft.prd.acceptance.trim() ||
    !validBoard ||
    !validTransport ||
    (isJoint && (!selectedJoint || selectedJoint.type !== "revolute")) ||
    !!flowError;
  const disabled = locked || saving || !!invalid || incomplete;
  const boards = catalog?.boards?.length
    ? catalog.boards
    : [
        { id: "esp32", label: "ESP32" },
        { id: "esp32s3", label: "ESP32-S3" },
      ];
  const board = boards.find((x) => x.id === draft.hardware.board);
  return (
    <section className="panel requirement-panel">
      <header className="panel-heading">
        <SlidersHorizontal size={24} />
        <div>
          <h2>需求与硬件</h2>
          <p>先选清楚用什么、做什么，再让 AI 拆分工作。</p>
        </div>
        <span className="scope-badge">本机仿真</span>
      </header>
      <div className="prd-section">
        <div className="section-intro">
          <h3>
            <span>01</span>选择任务和设备
          </h3>
          <p>当前支持两个可运行的测试场景。</p>
        </div>
        <div className="prd-grid">
          <label className="field">
            <span>用途 / 控制任务</span>
            <select
              disabled={locked}
              value={draft.task_type || ""}
              onChange={(e) => {
                const selected = tasks.find((t) => t.id === e.target.value);
                if (selected) choose(selected);
              }}
            >
              {tasks.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>目标控制板</span>
            <select
              disabled={locked}
              value={draft.hardware.board || ""}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  hardware: { ...draft.hardware, board: e.target.value },
                })
              }
            >
              {!validBoard && (
                <option value={draft.hardware.board || ""}>
                  旧工程未选板型，请重新选择
                </option>
              )}
              {boards.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>控制对象</span>
            <select
              disabled={locked}
              value={
                draft.hardware.actuator ||
                (isJoint ? "virtual_joint" : "virtual_switch")
              }
              onChange={(e) =>
                setDraft({
                  ...draft,
                  hardware: { ...draft.hardware, actuator: e.target.value },
                })
              }
            >
              <option value={isJoint ? "virtual_joint" : "virtual_switch"}>
                {isJoint
                  ? "虚拟关节（不接真实电机）"
                  : "虚拟开关（不接真实设备）"}
              </option>
            </select>
          </label>
          <label className="field">
            <span>反馈传感器</span>
            <select
              disabled={locked}
              value={
                draft.hardware.sensor ||
                (isJoint ? "simulated_encoder" : "simulated_scalar")
              }
              onChange={(e) =>
                setDraft({
                  ...draft,
                  hardware: { ...draft.hardware, sensor: e.target.value },
                })
              }
            >
              <option
                value={isJoint ? "simulated_encoder" : "simulated_scalar"}
              >
                {isJoint ? "模拟编码器：返回关节位置" : "模拟数值：范围 0–1"}
              </option>
            </select>
          </label>
          <label className="field">
            <span>两端怎么通信</span>
            <select
              disabled={locked}
              value={draft.hardware.transport}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  hardware: {
                    ...draft.hardware,
                    transport: e.target.value,
                    baudrate: 115200,
                  },
                })
              }
            >
              <option value="serial_jsonl">
                串口消息格式 · 主机虚拟串口测试
              </option>
              {!validTransport && (
                <option value={draft.hardware.transport} disabled>
                  旧通信模式，请重新选择
                </option>
              )}
            </select>
          </label>
          <div className="field read-only-field">
            <span>运行环境</span>
            <div>ROS 2 Humble · 本机模拟</div>
            <small>编译选定板型的程序；本轮不烧录。</small>
          </div>
        </div>
        {board?.fqbn && (
          <p className="hardware-identifier">
            编译目标 <code>{board.fqbn}</code>
          </p>
        )}
        <div className="capability-note">
          <strong>这轮实际能完成</strong>
          <p>
            {isJoint
              ? "选择一个有角度上下限的关节，让它到达指定位置，并检查位置误差、速度和通信。其他关节保持源姿态。"
              : "读取 0–1 范围的模拟数值，达到阈值输出 1，低于阈值输出 0，并检查收发和失联处理。"}
          </p>
          <small>
            整机走路、导航、抓取、多关节动作编排和真实驱动尚未适配。额外文字要求会逐条核对，不能仅靠选择这些任务就声称完成。
          </small>
        </div>
        {!validBoard && (
          <div className="notice warning">
            先选 ESP32 或 ESP32-S3，再保存并重新拆分旧工程。
          </div>
        )}
        {!validTransport && (
          <div className="notice warning">
            旧工程需要选择串口消息格式，再保存并重新拆分。
          </div>
        )}
      </div>
      <StructurePanel
        onStructure={setSelectedStructure}
        onBusyChange={setUploadingStructure}
        id={draft.prd.structure_id}
        jointName={draft.prd.joint_name}
        target={draft.parameters.target ?? 0}
        locked={locked}
        onChange={(id, jointName) =>
          setDraft({
            ...draft,
            prd: { ...draft.prd, structure_id: id, joint_name: jointName },
          })
        }
      />
      <div className="prd-section">
        <div className="section-intro">
          <h3>
            <span>02</span>写清楚要求
          </h3>
        </div>
        <label className="field">
          <span>工程名称</span>
          <input
            maxLength={80}
            value={draft.name}
            disabled={locked}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </label>
        <label className="field request-field">
          <span>你希望机器人做什么</span>
          <textarea
            rows={3}
            aria-label="你希望机器人做什么"
            maxLength={4000}
            disabled={locked}
            value={draft.request}
            onChange={(e) => setDraft({ ...draft, request: e.target.value })}
            placeholder="描述动作、触发条件，以及怎样算成功"
          />
          <small className="char-count">{draft.request.length} / 4000</small>
        </label>
        <div className="parameter-grid">
          {isJoint ? (
            <NumberField
              label="目标位置"
              unit="rad"
              value={draft.parameters.target}
              min={targetBounds.lower}
              max={targetBounds.upper}
              step={0.1}
              disabled={locked}
              onChange={(v) => setParam("target", v)}
            />
          ) : (
            <NumberField
              label="触发阈值"
              unit="0–1"
              value={draft.parameters.threshold}
              min={0.1}
              max={0.9}
              step={0.1}
              disabled={locked}
              onChange={(v) => setParam("threshold", v)}
            />
          )}
          <NumberField
            label="允许误差"
            unit={isJoint ? "rad" : "归一化值"}
            value={draft.parameters.tolerance}
            min={0.005}
            max={0.15}
            step={0.01}
            disabled={locked}
            onChange={(v) => setParam("tolerance", v)}
          />
          <NumberField
            label="运行时长"
            unit="s"
            value={draft.parameters.duration}
            min={4}
            max={30}
            step={1}
            disabled={locked}
            onChange={(v) => setParam("duration", v)}
          />
          {isJoint && (
            <NumberField
              label="最高速度"
              unit="rad/s"
              value={draft.parameters.max_velocity}
              min={0.1}
              max={2}
              step={0.1}
              disabled={locked}
              onChange={(v) => setParam("max_velocity", v)}
            />
          )}
        </div>
        <label className="field">
          <span>必须遵守的限制</span>
          <textarea
            rows={2}
            maxLength={2000}
            disabled={locked}
            value={draft.prd.constraints}
            aria-label="必须遵守的限制"
            onChange={(e) => setPRD("constraints", e.target.value)}
            placeholder="例如：失联停止，不允许接实物"
          />
        </label>
        <label className="field">
          <span>怎样才算完成</span>
          <textarea
            rows={2}
            maxLength={2000}
            disabled={locked}
            value={draft.prd.acceptance}
            aria-label="怎样才算完成"
            onChange={(e) => setPRD("acceptance", e.target.value)}
            placeholder="写清需要检查的结果"
          />
        </label>
        <div className="prd-summary">
          <h3>这份需求将交给 AI</h3>
          <p>
            {draft.prd.use_case} · {board?.label || "待选板型"} ·{" "}
            {isJoint ? "虚拟关节 + 模拟编码器" : "虚拟开关 + 模拟传感器"}
          </p>
          <small>
            AI 拆分后，会让你核对 ROS / ESP32
            分工、消息格式和验收标准。核对通过才生成、编译。
          </small>
        </div>
      </div>
      <WorkflowEditor
        value={draft.workflow}
        onChange={(workflow) => setDraft({ ...draft, workflow })}
        locked={locked}
        defaultValue={catalog?.default_workflow}
      />
      <ProjectManifest manifest={manifest} stale={manifestStale} />
      {isJoint && !selectedJoint && (
        <p className="input-error">
          请选择一个要控制的关节，等结构信息加载完成再保存。
        </p>
      )}
      {isJoint && selectedJoint && selectedJoint.type !== "revolute" && (
        <p className="input-error">
          当前角度控制需要有上下限的旋转关节，请选择受支持的关节。
        </p>
      )}
      {invalid && (
        <p className="input-error" role="alert">
          {invalid[3]}需在 {invalid[1]} 到 {invalid[2]} 之间。
        </p>
      )}
      <div className="form-actions">
        <p>保存需求不会启动编译或烧录。</p>
        <button
          className="button secondary"
          disabled={disabled}
          onClick={onSave}
        >
          <FloppyDisk size={16} />
          保存
        </button>
        <button className="button primary" disabled={disabled} onClick={onPlan}>
          {saving ? <CircleNotch className="spin" size={17} /> : null}拆分需求
          <ArrowRight size={17} />
        </button>
      </div>
    </section>
  );
}
function NumberField({
  label,
  unit,
  value,
  min,
  max,
  step,
  disabled,
  onChange,
}: {
  label: string;
  unit: string;
  value: number | null;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field">
      <span>
        {label}
        <small>{unit}</small>
      </span>
      <input
        type="number"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value ?? ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
