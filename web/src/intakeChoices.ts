export type NumberChoice = {
  value: number;
  label: string;
  description: string;
  recommended?: boolean;
};

const radians = (degrees: number) => (degrees * Math.PI) / 180;

/** Optional local examples in program units. Never apply these on load. */
export function numberChoices(
  key: string,
  completeAction = false,
): NumberChoice[] {
  switch (key) {
    case "max_velocity_rad_s":
      return [
        {
          value: radians(15),
          label: "慢慢转",
          description: "15°/秒；转过 90° 最快约 6 秒，方便看清动作。",
        },
        {
          value: radians(30),
          label: "普通演示",
          description: "30°/秒；转过 90° 最快约 3 秒。",
          recommended: true,
        },
        {
          value: radians(60),
          label: "较快演示",
          description: "60°/秒；转过 90° 最快约 1.5 秒。",
        },
      ];
    case "tolerance_rad":
      return [
        {
          value: radians(1),
          label: "更接近目标",
          description: "允许差 1°；目标 30° 时，29–31° 算到位。",
        },
        {
          value: radians(2),
          label: "普通动作",
          description: "允许差 2°；目标 30° 时，28–32° 算到位。",
          recommended: true,
        },
        {
          value: radians(5),
          label: "只看大致位置",
          description: "允许差 5°；目标 30° 时，25–35° 算到位。",
        },
      ];
    case "duration_s":
      return [
        {
          value: 8,
          label: "看一个短动作",
          description: "观察 8 秒，适合查看单个关节的一次动作。",
          recommended: !completeAction,
        },
        {
          value: 15,
          label: "多看几个步骤",
          description: "观察 15 秒，给抬起、摆动、放下留出观察时间。",
          recommended: completeAction,
        },
        {
          value: 30,
          label: "留更长时间",
          description: "观察 30 秒；动作慢或步骤多时可选。",
        },
      ];
    case "repetitions":
    case "cycles":
      return [
        { value: 1, label: "先做 1 次", description: "先看清一次完整动作。" },
        {
          value: 3,
          label: "做 3 次",
          description: "适合观察重复动作是否一致。",
          recommended: true,
        },
        {
          value: 5,
          label: "做 5 次",
          description: "多重复几次，需要更长观察时间。",
        },
      ];
    case "dwell_s":
      return [
        {
          value: 0,
          label: "不停留",
          description: "到达一个位置后接着运动。",
          recommended: true,
        },
        {
          value: 0.5,
          label: "稍停一下",
          description: "每到一个位置停 0.5 秒。",
        },
        {
          value: 1,
          label: "停一下看清楚",
          description: "每到一个位置停 1 秒。",
        },
      ];
    case "threshold":
      return [
        {
          value: 0.25,
          label: "较早触发",
          description: "模拟读数达到 0.25 时打开。",
        },
        {
          value: 0.5,
          label: "到一半触发",
          description: "模拟读数达到 0.5 时打开。",
          recommended: true,
        },
        {
          value: 0.75,
          label: "较晚触发",
          description: "模拟读数达到 0.75 时打开。",
        },
      ];
    default:
      return [];
  }
}

/** Numeric equality identifies a current value, never its source. */
export function matchesNumberChoice(
  value: number | null,
  choice: number,
): boolean {
  return (
    value !== null &&
    Number.isFinite(value) &&
    Math.abs(value - choice) <= 1e-12
  );
}

/** Explicit group action: only known numeric presets and truly blank values. */
export function blankNumberRecommendations<T extends object>(
  answers: T,
  fields: (keyof T & string)[],
  completeAction = false,
): Record<string, number> {
  return Object.fromEntries(
    fields.flatMap((key) => {
      const choice = numberChoices(key, completeAction).find(
        (item) => item.recommended,
      );
      return answers[key] === null && choice ? [[key, choice.value]] : [];
    }),
  );
}
