import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowClockwise,
  Cube,
  Pause,
  Play,
  SlidersHorizontal,
  WarningCircle,
} from "@phosphor-icons/react";
import { useI18n } from "./i18n";
import {
  MODEL_CHANNEL,
  PREVIEW_SECONDS,
  actionVisualPose,
  initialVisualPose,
  groupForPreviewAction,
  isVisualPose,
  previewActionForGroup,
  visualPoseMessage,
  visualReadings,
  type FoldBotActionGroup,
  type FoldBotPreviewAction,
  type FoldBotVisualPose,
} from "./foldbotSimulationModel";
import "./foldbotSimulation.css";

const base =
  (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env?.BASE_URL ??
  "/";

/** Isolated display-only asset: no control session, socket, ROS call or physical telemetry. */
export function FoldBotModelPreview({ pose }: { pose?: FoldBotVisualPose }) {
  const { t, locale } = useI18n();
  const frame = useRef<HTMLIFrameElement>(null);
  const current = useRef({ pose: pose ?? initialVisualPose(), locale });
  current.current = { pose: pose ?? initialVisualPose(), locale };
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.source !== frame.current?.contentWindow ||
        event.origin !== location.origin ||
        event.data?.channel !== MODEL_CHANNEL
      )
        return;
      if (event.data.type === "ready") {
        setReady(true);
        setFailed(false);
        const value = current.current;
        if (isVisualPose(value.pose))
          frame.current?.contentWindow?.postMessage(
            visualPoseMessage(value.pose, value.locale),
            location.origin,
          );
      } else if (event.data.type === "render-error") setFailed(true);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);
  useEffect(() => {
    if (ready && isVisualPose(current.current.pose))
      frame.current?.contentWindow?.postMessage(
        visualPoseMessage(current.current.pose, locale),
        location.origin,
      );
  }, [pose, locale, ready]);
  return (
    <div className="fb-model-preview">
      <iframe
        ref={frame}
        src={`${base}foldbot-model-preview.html`}
        title={t("折叠机器人模型预览", "FoldBot model preview")}
        onLoad={() => {
          // The child's ready message can race a cached initial load. Its validated
          // receiver is already installed when load fires, so send only the pose.
          const value = current.current;
          setReady(true);
          if (isVisualPose(value.pose))
            frame.current?.contentWindow?.postMessage(
              visualPoseMessage(value.pose, value.locale),
              location.origin,
            );
        }}
      />
      {failed && (
        <p className="fb-model-error" role="alert">
          {t(
            "浏览器未能启动 3D 渲染。请开启硬件加速后重试；下方预览参数仍可查看。",
            "The browser could not start 3D rendering. Enable hardware acceleration and retry; preview parameters remain available below.",
          )}
        </p>
      )}
      <div className="fb-model-caption">
        <Cube size={16} />
        <span>
          {t(
            "原版 FoldBot 模型 · 拖动旋转 / 滚轮缩放",
            "Original FoldBot model · drag to orbit / scroll to zoom",
          )}
        </span>
      </div>
    </div>
  );
}

const actions: {
  id: FoldBotPreviewAction;
  label: [string, string];
  detail: [string, string];
}[] = [
  {
    id: "unfold",
    label: ["双板展开", "Unfold panels"],
    detail: ["查看两块折叠板的展开过程", "Preview both panels unfolding"],
  },
  {
    id: "fold",
    label: ["双板收拢", "Fold panels"],
    detail: ["查看两块折叠板的收拢过程", "Preview both panels folding"],
  },
  {
    id: "arm",
    label: ["机械臂展示", "Arm sequence"],
    detail: [
      "抬臂、摆动与夹爪开合示意",
      "Illustrative arm sweep and gripper opening",
    ],
  },
  {
    id: "drive",
    label: ["履带转动", "Track movement"],
    detail: [
      "查看左右履带滚动，不代表里程",
      "Preview track rotation, not odometry",
    ],
  },
];

export default function FoldBotSimulation({
  compact = false,
  actionGroup,
  onActionGroupChange,
}: {
  compact?: boolean;
  actionGroup?: FoldBotActionGroup;
  onActionGroupChange?: (group: FoldBotActionGroup) => void;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<"sliders" | "actions">(
    actionGroup ? "actions" : "sliders",
  );
  const [pose, setPose] = useState(() =>
    actionGroup
      ? actionVisualPose(previewActionForGroup(actionGroup), 0)
      : initialVisualPose(),
  );
  const [action, setAction] = useState<FoldBotPreviewAction>(() =>
    actionGroup ? previewActionForGroup(actionGroup) : "unfold",
  );
  const [progress, setProgress] = useState(0);
  const [playing, setPlaying] = useState(false);
  const progressRef = useRef(progress);
  progressRef.current = progress;

  useEffect(() => {
    if (!actionGroup) return;
    // A parent roundtrip may persist the same family after a local sub-action
    // selection. Keep e.g. "fold" instead of replacing it with "unfold".
    const selected = previewActionForGroup(actionGroup, action);
    setPlaying(false);
    setAction(selected);
    setProgress(0);
    setMode("actions");
    setPose(actionVisualPose(selected, 0));
  }, [actionGroup]);

  useEffect(() => {
    if (!playing) return;
    let request = 0;
    let previous: number | null = null;
    let elapsed = progressRef.current * PREVIEW_SECONDS;
    const tick = (now: number) => {
      if (previous !== null) elapsed += Math.min((now - previous) / 1000, 0.1);
      previous = now;
      const next = Math.min(1, elapsed / PREVIEW_SECONDS);
      setProgress(next);
      setPose(actionVisualPose(action, next));
      if (next >= 1) setPlaying(false);
      else request = requestAnimationFrame(tick);
    };
    const hide = () => {
      if (document.hidden) setPlaying(false);
    };
    document.addEventListener("visibilitychange", hide);
    request = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(request);
      document.removeEventListener("visibilitychange", hide);
    };
  }, [playing, action]);

  const readings = useMemo(() => {
    const before =
      playing && progress > 0.002
        ? actionVisualPose(action, progress - 0.002)
        : undefined;
    return visualReadings(
      pose,
      before,
      before ? 0.002 * PREVIEW_SECONDS : undefined,
    );
  }, [pose, action, playing, progress]);
  const curves = useMemo(
    () =>
      [0, 1, 2].map((index) =>
        Array.from({ length: 65 }, (_, i) => {
          const point = actionVisualPose(action, i / 64);
          const value =
            index === 0
              ? point.fold1
              : index === 1
                ? point.fold2
                : (point.joints[0] + 1) / 2;
          return `${(i / 64) * 640},${70 - value * 56}`;
        }).join(" "),
      ),
    [action],
  );

  if (compact) return <FoldBotModelPreview pose={pose} />;
  const stopAndSet = (next: FoldBotVisualPose) => {
    setPlaying(false);
    setPose(next);
  };
  return (
    <section
      className="fb-simulation"
      aria-label={t(
        "FoldBot 动作预览与仿真分析",
        "FoldBot motion preview and simulation analysis",
      )}
    >
      <header className="fb-sim-heading">
        <div>
          <p>FOLDBOT / {t("动作预览", "MOTION PREVIEW")}</p>
          <h2>
            {t(
              "先看清动作，再连接实物",
              "Preview the motion before connecting hardware",
            )}
          </h2>
        </div>
        <span className="fb-sim-status">
          {t("模型演示 · Gazebo 未连接", "Model preview · Gazebo disconnected")}
        </span>
      </header>
      <div className="fb-sim-grid">
        <FoldBotModelPreview pose={pose} />
        <div className="fb-sim-controls">
          <div
            className="fb-sim-mode"
            role="group"
            aria-label={t("预览控制方式", "Preview control mode")}
          >
            <button
              type="button"
              aria-pressed={mode === "sliders"}
              onClick={() => {
                setPlaying(false);
                setMode("sliders");
              }}
            >
              <SlidersHorizontal size={17} />
              {t("关节滑杆", "Joint sliders")}
            </button>
            <button
              type="button"
              aria-pressed={mode === "actions"}
              onClick={() => {
                setPlaying(false);
                setMode("actions");
                setPose(actionVisualPose(action, progress));
              }}
            >
              <Play size={17} />
              {t("动作组", "Action groups")}
            </button>
          </div>
          {mode === "sliders" ? (
            <div className="fb-sim-sliders">
              <p className="fb-sim-hint">
                {t(
                  "拖动即更新左侧模型。滑杆只调整临时预览，不写入工程或发送实物命令。",
                  "Drag to update the model. Sliders only change this temporary preview; values are not saved into the project or sent to hardware.",
                )}
              </p>
              {["fold1", "fold2"].map((key, i) => (
                <label className="fb-sim-slider" key={key}>
                  <span>
                    {i === 0
                      ? t("第一折叠板", "Lower panel")
                      : t("第二折叠板", "Upper panel")}
                    <output>
                      {Math.round(pose[key as "fold1" | "fold2"] * 100)}%
                    </output>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={pose[key as "fold1" | "fold2"] * 100}
                    onChange={(event) =>
                      stopAndSet({
                        ...pose,
                        [key]: Number(event.target.value) / 100,
                      })
                    }
                  />
                </label>
              ))}
              {pose.joints.map((value, i) => (
                <label className="fb-sim-slider" key={`joint-${i}`}>
                  <span>
                    {t(readings[i + 2].name[0], readings[i + 2].name[1])}
                    <output>{Math.round(value * 100)}%</output>
                  </span>
                  <input
                    type="range"
                    min={i === 5 ? 0 : -100}
                    max={100}
                    value={value * 100}
                    onChange={(event) => {
                      const joints = [
                        ...pose.joints,
                      ] as FoldBotVisualPose["joints"];
                      joints[i] = Number(event.target.value) / 100;
                      stopAndSet({ ...pose, joints });
                    }}
                  />
                </label>
              ))}
              {pose.tracks.map((value, i) => (
                <label className="fb-sim-slider" key={`track-${i}`}>
                  <span>
                    {i === 0
                      ? t("左履带示意进度", "Left track preview")
                      : t("右履带示意进度", "Right track preview")}
                    <output>{Math.round(value * 10)}%</output>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={value * 10}
                    onChange={(event) => {
                      const tracks = [
                        ...pose.tracks,
                      ] as FoldBotVisualPose["tracks"];
                      tracks[i] = Number(event.target.value) / 10;
                      stopAndSet({ ...pose, tracks });
                    }}
                  />
                </label>
              ))}
              <button
                className="fb-sim-reset"
                type="button"
                onClick={() => stopAndSet(initialVisualPose())}
              >
                <ArrowClockwise size={16} />
                {t("复位预览姿态", "Reset preview pose")}
              </button>
            </div>
          ) : (
            <div className="fb-sim-actions">
              <p className="fb-sim-hint">
                {t(
                  "选择一组动作，播放或拖动时间轴查看过程。",
                  "Choose an action, then play or scrub through the sequence.",
                )}
              </p>
              {actions.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  aria-pressed={action === item.id}
                  onClick={() => {
                    setPlaying(false);
                    setAction(item.id);
                    setProgress(0);
                    setPose(actionVisualPose(item.id, 0));
                    onActionGroupChange?.(groupForPreviewAction(item.id));
                  }}
                >
                  <strong>{t(...item.label)}</strong>
                  <span>{t(...item.detail)}</span>
                </button>
              ))}
              <div className="fb-sim-action-note">
                <WarningCircle size={18} />
                <p>
                  {t(
                    "动作组为模型编排示例。没有载入实物标定或验证碰撞，不会作为实机动作直接执行。",
                    "These are illustrative model sequences. Hardware calibration and collision checks have not been applied; they are not physical robot commands.",
                  )}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
      {mode === "actions" && (
        <div className="fb-sim-timeline">
          <div className="fb-sim-timeline-head">
            <button
              type="button"
              aria-label={
                playing
                  ? t("暂停模型预览", "Pause model preview")
                  : t("播放模型预览", "Play model preview")
              }
              onClick={() => {
                if (progress >= 1) {
                  setProgress(0);
                  setPose(actionVisualPose(action, 0));
                }
                setPlaying(!playing);
              }}
            >
              {playing ? <Pause size={19} /> : <Play size={19} />}
              {playing ? t("暂停", "Pause") : t("播放预览", "Play preview")}
            </button>
            <label htmlFor="fb-sim-progress">
              {t("预览时间轴", "Preview timeline")}
            </label>
            <output>
              {(progress * PREVIEW_SECONDS).toFixed(1)} / {PREVIEW_SECONDS}.0 s
            </output>
          </div>
          <input
            id="fb-sim-progress"
            type="range"
            min={0}
            max={1000}
            value={Math.round(progress * 1000)}
            onChange={(event) => {
              const next = Number(event.target.value) / 1000;
              setPlaying(false);
              setProgress(next);
              setPose(actionVisualPose(action, next));
            }}
          />
          <svg
            viewBox="0 0 640 84"
            role="img"
            aria-label={t(
              "模型轨迹示意：第一板、第二板、机械臂底座",
              "Illustrative model curves: lower panel, upper panel, arm base",
            )}
          >
            {[14, 42, 70].map((y) => (
              <line key={y} x1="0" x2="640" y1={y} y2={y} stroke="#e1e7f0" />
            ))}
            {curves.map((points, i) => (
              <polyline
                key={i}
                fill="none"
                stroke={["#002fa7", "#34a853", "#fbbc05"][i]}
                strokeWidth="2.3"
                points={points}
              />
            ))}
            <line
              x1={progress * 640}
              x2={progress * 640}
              y1="3"
              y2="80"
              stroke="#ea4335"
              strokeWidth="2"
            />
          </svg>
          <div className="fb-sim-legend">
            <span>{t("蓝：第一板", "Blue: lower panel")}</span>
            <span>{t("绿：第二板", "Green: upper panel")}</span>
            <span>{t("黄：底座", "Yellow: arm base")}</span>
            <small>
              {t(
                "归一化模型轨迹 · 非传感器曲线",
                "Normalized model curves · not sensor data",
              )}
            </small>
          </div>
        </div>
      )}
      <div className="fb-sim-analysis">
        <section className="fb-sim-warnings">
          <h3>
            <WarningCircle size={20} />
            {t("警告与状况", "Warnings and status")}
          </h3>
          <p>
            <span className="fb-sim-dot amber" />
            {t(
              "Gazebo：尚未连接物理仿真，碰撞、负载与稳定性未验证。",
              "Gazebo: physical simulation is disconnected. Collision, load and stability are unverified.",
            )}
          </p>
          <p>
            <span className="fb-sim-dot blue" />
            {t(
              "数据：角度来自原模型几何；速度为播放时的模型变化率。",
              "Data: angles come from model geometry; velocity is derived while the preview plays.",
            )}
          </p>
          <p>
            <span className="fb-sim-dot red" />
            {t(
              "扭矩：没有传感器或物理仿真数据，保持未知。",
              "Torque: no sensor or physics data is available; values remain unknown.",
            )}
          </p>
          <details>
            <summary>
              {t(
                "如何接入真正的 Gazebo",
                "Connecting a real Gazebo simulation",
              )}
            </summary>
            <p>
              {t(
                "Gazebo 有网页可视化组件 gzweb，需连接运行中的仿真和对应版本的 WebSocket 服务。本页目前只做动作预览，后续接入后再单独记录仿真结果。",
                "Gazebo provides gzweb visualization. It requires a running simulation and a version-compatible WebSocket server. This page currently previews motion; real simulation results must be recorded separately.",
              )}
            </p>
            <a
              href="https://gazebosim.org/docs/garden/web_visualization/"
              target="_blank"
              rel="noreferrer"
            >
              {t("查看官方网页可视化说明", "Official web visualization guide")}
            </a>
          </details>
        </section>
        <section className="fb-sim-table-panel">
          <h3>{t("部件状态表", "Component status")}</h3>
          <p>
            {t(
              "模型参数 · 不用于下发实物角度",
              "Model parameters · not hardware targets",
            )}
          </p>
          <div className="fb-sim-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t("部件", "Component")}</th>
                  <th>{t("模型角度 / 位置", "Model angle / position")}</th>
                  <th>{t("预览速度", "Preview velocity")}</th>
                  <th>{t("实测扭矩", "Measured torque")}</th>
                </tr>
              </thead>
              <tbody>
                {readings.map((row) => (
                  <tr key={row.id}>
                    <th>{t(...row.name)}</th>
                    <td>
                      {row.value.toFixed(1)}{" "}
                      {row.unit === "phase" ? t("相位", "phase") : row.unit}
                    </td>
                    <td>
                      {row.velocity === null
                        ? "—"
                        : `${row.velocity.toFixed(1)} ${row.unit === "phase" ? t("相位", "phase") : row.unit}/s`}
                    </td>
                    <td className="fb-sim-unknown">{t("未知", "Unknown")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </section>
  );
}
