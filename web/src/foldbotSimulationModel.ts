/** Display-only FoldBot poses. Never send these values to a physical controller. */
export type FoldBotVisualPose = {
  fold1: number;
  fold2: number;
  joints: [number, number, number, number, number, number];
  tracks: [number, number];
};
export type FoldBotPreviewAction = "unfold" | "fold" | "arm" | "drive";
export type FoldBotActionGroup = "fold-cycle" | "arm-demo" | "chassis-demo";
export function previewActionForGroup(
  group: FoldBotActionGroup,
  current?: FoldBotPreviewAction,
): FoldBotPreviewAction {
  if (current && groupForPreviewAction(current) === group) return current;
  return group === "arm-demo"
    ? "arm"
    : group === "chassis-demo"
      ? "drive"
      : "unfold";
}
export function groupForPreviewAction(
  action: FoldBotPreviewAction,
): FoldBotActionGroup {
  return action === "arm"
    ? "arm-demo"
    : action === "drive"
      ? "chassis-demo"
      : "fold-cycle";
}
export const MODEL_CHANNEL = "ae-foldbot-model-preview";
export function initialVisualPose(): FoldBotVisualPose {
  return { fold1: 0, fold2: 0, joints: [0, 0, 0, 0, 0, 0.4], tracks: [0, 0] };
}
export function isVisualPose(value: unknown): value is FoldBotVisualPose {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  if (Object.keys(p).sort().join(",") !== "fold1,fold2,joints,tracks")
    return false;
  const finite = (v: unknown, min: number, max: number) =>
    typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
  return (
    finite(p.fold1, 0, 1) &&
    finite(p.fold2, 0, 1) &&
    Array.isArray(p.joints) &&
    p.joints.length === 6 &&
    p.joints.every((v, i) => finite(v, i === 5 ? 0 : -1, 1)) &&
    Array.isArray(p.tracks) &&
    p.tracks.length === 2 &&
    p.tracks.every((v) => finite(v, -1000, 1000))
  );
}
export function visualPoseMessage(
  pose: FoldBotVisualPose,
  locale: "en" | "zh-CN",
) {
  if (!isVisualPose(pose)) throw new Error("Invalid display-only FoldBot pose");
  return { channel: MODEL_CHANNEL, type: "pose", pose, locale };
}
export const PREVIEW_SECONDS = 8;
/** Explicit illustrative action groups, not firmware trajectories or calibration. */
export function actionVisualPose(
  action: FoldBotPreviewAction,
  progress: number,
): FoldBotVisualPose {
  if (!Number.isFinite(progress))
    throw new Error("Preview progress must be finite");
  const x = Math.max(0, Math.min(1, progress));
  const p = initialVisualPose();
  const smooth = (v: number) => v * v * (3 - 2 * v);
  switch (action) {
    case "unfold":
      p.fold1 = smooth(x);
      p.fold2 = smooth(x);
      break;
    case "fold":
      p.fold1 = 1 - smooth(x);
      p.fold2 = 1 - smooth(x);
      break;
    case "arm": {
      p.fold1 = p.fold2 = 1;
      const raised = Math.sin(Math.PI * x);
      p.joints = [
        Math.sin(x * Math.PI * 6) * 0.22 * raised,
        -0.3 * raised,
        -0.35 * raised,
        0.22 * raised,
        0.15 * raised,
        0.4 + 0.25 * raised,
      ];
      break;
    }
    case "drive":
      p.tracks = [x * 10, x * 10];
      break;
    default:
      throw new Error("Unknown preview action");
  }
  return p;
}
export type VisualReading = {
  id: string;
  name: [string, string];
  value: number;
  unit: "°" | "%" | "phase";
  velocity: number | null;
  torque: null;
  source: "visual_preview";
};
function visualValues(p: FoldBotVisualPose) {
  // Match the original model's rotations, including its authored rest offsets.
  const deg = 180 / Math.PI;
  return [
    (1 - p.fold1) * 90,
    -(1 - p.fold2) * 180,
    p.joints[0] * 144,
    (-0.15 + p.joints[1] * 1.25) * deg,
    (2.55 + p.joints[2] * 1.4) * deg,
    (-1.85 + p.joints[3] * 1.25) * deg,
    p.joints[4] * 180,
    p.joints[5] * 100,
    p.tracks[0],
    p.tracks[1],
  ];
}
const VISUAL_NAMES: [string, string][] = [
  ["第一折叠板", "Lower panel"],
  ["第二折叠板", "Upper panel"],
  ["ID 1 · 底座", "ID 1 · Base"],
  ["ID 2 · 肩部", "ID 2 · Shoulder"],
  ["ID 3 · 肘部", "ID 3 · Elbow"],
  ["ID 4 · 腕俯仰", "ID 4 · Wrist pitch"],
  ["ID 5 · 腕旋转", "ID 5 · Wrist roll"],
  ["ID 6 · 夹爪", "ID 6 · Gripper"],
  ["左履带", "Left track"],
  ["右履带", "Right track"],
];
export function visualReadings(
  pose: FoldBotVisualPose,
  previous?: FoldBotVisualPose,
  seconds?: number,
): VisualReading[] {
  if (!isVisualPose(pose) || (previous && !isVisualPose(previous)))
    throw new Error("Invalid visual pose");
  const values = visualValues(pose);
  const before = previous ? visualValues(previous) : null;
  const dt =
    typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
      ? seconds
      : null;
  return values.map((value, i) => ({
    id: `visual-${i}`,
    name: VISUAL_NAMES[i],
    value,
    unit: i < 7 ? "°" : i === 7 ? "%" : "phase",
    velocity: before && dt ? (value - before[i]) / dt : null,
    torque: null,
    source: "visual_preview",
  }));
}
