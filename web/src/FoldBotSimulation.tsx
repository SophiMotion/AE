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
  previewFrameReadings,
  previewWaveform,
  visualPoseMessage,
  visualReadings,
  type FoldBotActionGroup,
  type FoldBotPreviewAction,
  type FoldBotVisualPose,
  type PreviewWaveformChannel,
  type VisualReading,
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

type WaveMetric = "angle" | "velocity" | "torque";

function WaveformTrack({
  metric,
  channels,
  readings,
  progress,
  manual,
  onSeek,
}: {
  metric: WaveMetric;
  channels: PreviewWaveformChannel[];
  readings: VisualReading[];
  progress: number;
  manual: boolean;
  onSeek: (progress: number) => void;
}) {
  const { t } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const update = () => setWidth(Math.max(240, element.clientWidth));
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => observer.disconnect();
  }, []);
  const unit = metric === "angle" ? "°" : metric === "velocity" ? "°/s" : "N·m";
  const title =
    metric === "angle"
      ? t("角度", "Angle")
      : metric === "velocity"
        ? t("角速度", "Angular velocity")
        : t("扭矩", "Torque");
  const noData = metric === "torque" || (manual && metric === "velocity");
  const values =
    metric === "torque"
      ? []
      : channels.flatMap((channel) =>
          manual
            ? [readings.find((row) => row.id === channel.id)!.value]
            : channel.points.map((point) => point[metric]),
        );
  const low = values.length ? Math.min(0, ...values) : -1;
  const high = values.length ? Math.max(0, ...values) : 1;
  const pad = Math.max((high - low) * 0.12, metric === "angle" ? 5 : 1);
  const min = low - pad,
    max = high + pad;
  const left = 49,
    right = width - 14,
    top = 24,
    bottom = 124;
  const x = (time: number) => left + (time / PREVIEW_SECONDS) * (right - left);
  const y = (value: number) =>
    bottom - ((value - min) / (max - min)) * (bottom - top);
  const cursorX = x(manual ? 0 : progress * PREVIEW_SECONDS);
  const emptyText =
    metric === "torque"
      ? t(
          "暂无扭矩数据 · 未连接传感器或物理仿真",
          "No torque data · sensors or physics simulation disconnected",
        )
      : manual
        ? t(
            "拖动仅改变姿态 · 尚无速度时间序列",
            "Pose adjustment only · no velocity time series",
          )
        : t("选择上方部件查看曲线", "Select components above to view curves");
  return (
    <section className="fb-wave-track" data-metric={metric}>
      <header>
        <h4>
          {title} <span>{unit}</span>
        </h4>
        <span>
          {metric === "torque"
            ? t("暂无数据", "No data")
            : manual
              ? t("当前姿态", "Current pose")
              : t("模型轨迹", "Model trajectory")}
        </span>
      </header>
      <div className="fb-wave-plot" ref={box}>
        <svg
          viewBox={`0 0 ${width} 155`}
          role="img"
          aria-label={`${title} · ${noData ? emptyText : manual ? t("当前模型姿态采样点", "Current model pose samples") : t("模型时间曲线，非实测数据", "Model time series, not measurements")}`}
          onPointerDown={
            manual
              ? undefined
              : (event) => {
                  const bounds = event.currentTarget.getBoundingClientRect();
                  const position =
                    ((event.clientX - bounds.left) * width) / bounds.width;
                  onSeek(
                    Math.max(
                      0,
                      Math.min(1, (position - left) / (right - left)),
                    ),
                  );
                }
          }
        >
          {[0, 0.5, 1].map((fraction) => {
            const value = min + (max - min) * fraction;
            const chartY = bottom - fraction * (bottom - top);
            return (
              <g key={fraction}>
                <line
                  x1={left}
                  x2={right}
                  y1={chartY}
                  y2={chartY}
                  className="fb-wave-grid"
                />
                {!noData && channels.length > 0 && (
                  <text x={left - 9} y={chartY + 3} textAnchor="end">
                    {value.toFixed(Math.abs(value) >= 100 ? 0 : 1)}
                  </text>
                )}
              </g>
            );
          })}
          {[0, 2, 4, 6, 8].map((time) => (
            <g key={time}>
              <line
                x1={x(time)}
                x2={x(time)}
                y1={top}
                y2={bottom}
                className="fb-wave-grid vertical"
              />
              {!manual && (
                <text x={x(time)} y={146} textAnchor="middle">
                  {time} s
                </text>
              )}
            </g>
          ))}
          {!noData && channels.length > 0 && (
            <line
              x1={left}
              x2={right}
              y1={y(0)}
              y2={y(0)}
              className="fb-wave-zero"
            />
          )}
          {!noData &&
            !manual &&
            channels.map((channel) => (
              <polyline
                key={channel.id}
                data-channel={channel.id}
                fill="none"
                stroke={channel.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                points={channel.points
                  .map(
                    (point) => `${x(point.time)},${y(point[metric] as number)}`,
                  )
                  .join(" ")}
              />
            ))}
          {!manual && (
            <line
              x1={cursorX}
              x2={cursorX}
              y1={9}
              y2={bottom + 3}
              className="fb-wave-cursor"
            />
          )}
          {!manual && (
            <path
              d={`M ${cursorX - 4} 9 L ${cursorX + 4} 9 L ${cursorX} 15 Z`}
              fill="#ea4335"
            />
          )}
          {!noData &&
            channels.map((channel) => {
              const row = readings.find((item) => item.id === channel.id)!;
              const value = metric === "angle" ? row.value : row.velocity;
              return value === null ? null : (
                <circle
                  key={channel.id}
                  cx={cursorX}
                  cy={y(value)}
                  r={3.5}
                  fill={channel.color}
                  stroke="#fff"
                  strokeWidth={1.5}
                >
                  <title>{`${t(...channel.name)}: ${value.toFixed(1)} ${unit}`}</title>
                </circle>
              );
            })}
          {manual && !noData && channels.length > 0 && (
            <text x={left} y={146}>
              {t("姿态采样（无时间历史）", "Pose sample (no time history)")}
            </text>
          )}
        </svg>
        {(noData || channels.length === 0) && (
          <div className="fb-wave-empty">{emptyText}</div>
        )}
      </div>
    </section>
  );
}

function MotionWaveforms({
  action,
  progress,
  readings,
  manual,
  onSeek,
}: {
  action: FoldBotPreviewAction;
  progress: number;
  readings: VisualReading[];
  manual: boolean;
  onSeek: (progress: number) => void;
}) {
  const { t } = useI18n();
  const waveform = useMemo(() => previewWaveform(action), [action]);
  const [selected, setSelected] = useState(() =>
    waveform.channels.map((channel) => channel.id),
  );
  const channels = waveform.channels.filter((channel) =>
    selected.includes(channel.id),
  );
  return (
    <section
      className="fb-waveforms"
      aria-label={t(
        "角度、速度与扭矩曲线",
        "Angle, velocity and torque curves",
      )}
    >
      <header className="fb-wave-heading">
        <div>
          <h3>{t("运动曲线", "Motion curves")}</h3>
          <p>
            {manual
              ? t(
                  "当前姿态点随滑杆更新；切换动作组查看时间曲线。",
                  "Pose samples follow the sliders. Switch to action groups for time series.",
                )
              : t(
                  "播放或拖动时间轴，模型与游标同步。点击部件名称可显示或隐藏曲线。",
                  "Play or scrub the timeline to synchronize the model and cursor. Toggle components to show or hide curves.",
                )}
          </p>
        </div>
        <span className="fb-wave-source">
          {t("模型预览 · 非实测", "Model preview · not measured")}
        </span>
      </header>
      <div
        className="fb-wave-channels"
        role="group"
        aria-label={t("曲线部件通道", "Curve component channels")}
      >
        {waveform.channels.map((channel) => (
          <button
            type="button"
            key={channel.id}
            aria-pressed={selected.includes(channel.id)}
            onClick={() =>
              setSelected((current) =>
                current.includes(channel.id)
                  ? current.filter((id) => id !== channel.id)
                  : [...current, channel.id],
              )
            }
          >
            <span style={{ background: channel.color }} />
            {t(...channel.name)}
          </button>
        ))}
      </div>
      {!manual && (
        <div className="fb-wave-reference-frames">
          <span>{t("模型参考帧", "Model reference frames")}</span>
          <div
            role="group"
            aria-label={t("定位模型参考帧", "Seek to a model reference frame")}
          >
            {waveform.referenceFrames.map((time) => (
              <button
                type="button"
                key={time}
                aria-label={t(
                  `跳转到 ${time} 秒模型参考帧`,
                  `Seek to the ${time} second model reference frame`,
                )}
                aria-pressed={
                  Math.abs(progress * PREVIEW_SECONDS - time) < 0.02
                }
                onClick={() => onSeek(time / PREVIEW_SECONDS)}
              >
                <span aria-hidden="true">◆</span>
                {time} s
              </button>
            ))}
          </div>
          <output aria-live="off">
            {(progress * PREVIEW_SECONDS).toFixed(1)} s
          </output>
        </div>
      )}
      <div className="fb-wave-tracks">
        {(["angle", "velocity", "torque"] as const).map((metric) => (
          <WaveformTrack
            key={metric}
            metric={metric}
            channels={channels}
            readings={readings}
            progress={progress}
            manual={manual}
            onSeek={onSeek}
          />
        ))}
      </div>
      <p className="fb-wave-footnote">
        {t(
          "角度与角速度分轨显示；夹爪开度和履带相位见数值详情。扭矩等待真实数据接入。",
          "Angle and angular velocity use separate tracks. Gripper opening and track phase are in numeric details. Torque awaits real data.",
        )}
      </p>
    </section>
  );
}

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

  const readings = useMemo(
    () =>
      mode === "actions"
        ? previewFrameReadings(action, progress)
        : visualReadings(pose),
    [pose, mode, action, progress],
  );

  if (compact) return <FoldBotModelPreview pose={pose} />;
  const stopAndSet = (next: FoldBotVisualPose) => {
    setPlaying(false);
    setPose(next);
  };
  const seek = (next: number) => {
    setPlaying(false);
    setProgress(next);
    setPose(actionVisualPose(action, next));
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
            onChange={(event) => seek(Number(event.target.value) / 1000)}
          />
        </div>
      )}
      <MotionWaveforms
        action={action}
        progress={progress}
        readings={readings}
        manual={mode === "sliders"}
        onSeek={seek}
      />
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
              "数据：角度来自原模型几何；角速度是示例轨迹对时间的变化率。",
              "Data: angles come from model geometry; angular velocity is the sample trajectory's rate of change over time.",
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
        <details className="fb-sim-table-panel">
          <summary>
            {t("查看部件数值详情", "View numeric component details")}
          </summary>
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
        </details>
      </div>
    </section>
  );
}
