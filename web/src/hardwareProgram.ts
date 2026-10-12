import { t } from "./localeStore.ts";

export type HardwareBinding = { id: string; label: string; pin: number | null };
export type HardwareInstruction =
  | { kind: "serial_print"; text: string }
  | { kind: "delay"; ms: number }
  | { kind: "digital_write"; binding: string; value: 0 | 1 }
  | { kind: "repeat"; count: number; steps: HardwareInstruction[] };
export type HardwareProgram = {
  schema_version: 1;
  name: string;
  board: "esp32" | "esp32s3";
  request: string;
  bindings: HardwareBinding[];
  setup: HardwareInstruction[];
  loop: HardwareInstruction[];
};
export const BOARD_PROFILES: {
  id: HardwareProgram["board"];
  label: string;
  labelEn: string;
  fqbn: string;
  pins: number[];
  sourceUrl: string;
}[] = [
  {
    id: "esp32",
    label: "ESP32 通用编译目标",
    labelEn: "ESP32 generic build target",
    fqbn: "esp32:esp32:esp32",
    pins: [4, 13, 14, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33],
    sourceUrl: "https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/peripherals/gpio.html",
  },
  {
    id: "esp32s3",
    label: "ESP32-S3 通用编译目标",
    labelEn: "ESP32-S3 generic build target",
    fqbn: "esp32:esp32:esp32s3",
    pins: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 21],
    sourceUrl: "https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-reference/peripherals/gpio.html",
  },
];

export function defaultHardwareProgram(): HardwareProgram {
  return {
    schema_version: 1,
    name: "Serial hello",
    board: "esp32s3",
    request: "",
    bindings: [],
    setup: [{ kind: "serial_print", text: "AE ready" }],
    loop: [{ kind: "serial_print", text: "Hello, AE!" }, { kind: "delay", ms: 1000 }],
  };
}

export function ledHardwareProgram(board: HardwareProgram["board"] = "esp32s3"): HardwareProgram {
  return {
    schema_version: 1, name: "Digital output", board, request: "",
    bindings: [{ id: "output", label: "Output", pin: null }],
    setup: [],
    loop: [
      { kind: "digital_write", binding: "output", value: 1 },
      { kind: "delay", ms: 1000 },
      { kind: "digital_write", binding: "output", value: 0 },
      { kind: "delay", ms: 1000 },
    ],
  };
}

type RecordValue = Record<string, unknown>;
const own = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
const validText = (value: unknown, min: number, max: number): value is string =>
  typeof value === "string" && Array.from(value).length >= min && Array.from(value).length <= max &&
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);

/** Import validation is separate from pin completeness so unfinished drafts remain saveable. */
export function parseHardwareProgram(value: unknown): HardwareProgram {
  const issues: string[] = [];
  const fail = (path: string, zh: string, en: string) => issues.push(`${path}: ${t(zh, en)}`);
  const object = (item: unknown, keys: string[], path: string): item is RecordValue => {
    if (!own(item)) {
      fail(path, "必须是对象", "must be an object");
      return false;
    }
    if (Object.keys(item).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(item, key))) {
      fail(path, "字段缺失或包含未知字段", "contains missing or unknown fields");
      return false;
    }
    return true;
  };
  if (!object(value, ["schema_version", "name", "board", "request", "bindings", "setup", "loop"], "program")) {
    throw new Error(issues.join("\n"));
  }
  if (value.schema_version !== 1) fail("schema_version", "仅支持版本 1", "only version 1 is supported");
  if (!validText(value.name, 1, 100)) fail("name", "名称须为 1–100 个字符", "name must contain 1–100 characters");
  if (!validText(value.request, 0, 6000)) fail("request", "需求最多 6000 个字符，不能含无效 Unicode", "request must be valid Unicode of at most 6000 characters");
  const profile = BOARD_PROFILES.find((entry) => entry.id === value.board);
  if (!profile) fail("board", "不支持的板卡目标", "unsupported board target");
  const bindings = new Map<string, HardwareBinding>();
  const pins = new Set<number>();
  if (!Array.isArray(value.bindings) || value.bindings.length > 8) fail("bindings", "最多允许 8 个引脚绑定", "at most 8 bindings are allowed");
  else value.bindings.forEach((binding, index) => {
    const path = `bindings[${index}]`;
    if (!object(binding, ["id", "label", "pin"], path)) return;
    if (typeof binding.id !== "string" || !/^[a-z][a-z0-9_]{0,39}$/.test(binding.id)) {
      fail(`${path}.id`, "ID须以小写字母开头，仅含小写字母、数字、下划线，最多40位", "ID must start with a lowercase letter and contain up to 40 lowercase letters, digits or underscores");
    } else if (bindings.has(binding.id)) fail(`${path}.id`, "引脚绑定 ID 重复", "duplicate binding ID");
    else bindings.set(binding.id, binding as HardwareBinding);
    if (!validText(binding.label, 1, 100)) fail(`${path}.label`, "标签须为 1–100 个字符", "label must contain 1–100 characters");
    if (binding.pin !== null) {
      if (!integer(binding.pin, 0, 48) || !profile?.pins.includes(binding.pin)) fail(`${path}.pin`, "GPIO不在当前目标的保守可选集合中", "GPIO is outside the conservative set for this target");
      else if (pins.has(binding.pin)) fail(`${path}.pin`, "同一 GPIO 不能重复绑定为输出", "an output GPIO cannot be bound more than once");
      else pins.add(binding.pin);
    }
  });
  let count = 0;
  let expanded = 0;
  const pending: { steps: unknown; path: string; depth: number; multiplier: number }[] = [
    { steps: value.loop, path: "loop", depth: 0, multiplier: 1 },
    { steps: value.setup, path: "setup", depth: 0, multiplier: 1 },
  ];
  while (pending.length) {
    const { steps, path, depth, multiplier } = pending.pop()!;
    if (!Array.isArray(steps)) { fail(path, "指令必须是数组", "instructions must be an array"); continue; }
    count += steps.length;
    if (count > 100) { fail(path, "总指令最多 100 个", "at most 100 instructions are allowed"); break; }
    expanded += steps.length * multiplier;
    if (expanded > 10000) { fail(path, "展开后单轮最多 10000 步", "at most 10000 expanded steps per pass are allowed"); break; }
    steps.forEach((step, index) => {
      const at = `${path}[${index}]`;
      if (!own(step)) { fail(at, "指令必须是对象", "instruction must be an object"); return; }
      if (step.kind === "serial_print") {
        if (object(step, ["kind", "text"], at) && !validText(step.text, 0, 500)) fail(`${at}.text`, "文本最多 500 个字符，不能含无效 Unicode", "text must be valid Unicode of at most 500 characters");
      } else if (step.kind === "delay") {
        if (object(step, ["kind", "ms"], at) && !integer(step.ms, 1, 60000)) fail(`${at}.ms`, "延时须为 1–60000 毫秒的整数", "delay must be an integer from 1 to 60000 ms");
      } else if (step.kind === "digital_write") {
        if (!object(step, ["kind", "binding", "value"], at)) return;
        if (typeof step.binding !== "string" || !bindings.has(step.binding)) fail(`${at}.binding`, "输出引用了不存在的引脚绑定", "output refers to an unknown binding");
        if (step.value !== 0 && step.value !== 1) fail(`${at}.value`, "数字输出仅允许 0 或 1", "digital output must be 0 or 1");
      } else if (step.kind === "repeat") {
        if (!object(step, ["kind", "count", "steps"], at)) return;
        if (depth >= 4) { fail(at, "最多嵌套 4 层重复", "at most 4 nested repeats are allowed"); return; }
        if (!integer(step.count, 1, 100)) { fail(`${at}.count`, "重复次数须为 1–100 的整数", "repeat count must be an integer from 1 to 100"); return; }
        pending.push({ steps: step.steps, path: `${at}.steps`, depth: depth + 1, multiplier: multiplier * step.count });
      } else fail(at, "未知指令类型", "unknown instruction kind");
    });
  }
  if (issues.length) throw new Error(issues.join("\n"));
  // Rebuild a plain domain value; no imported object references or metadata enter saved state.
  return JSON.parse(JSON.stringify(value)) as HardwareProgram;
}

export function validateHardwareProgram(value: unknown): string[] {
  let program: HardwareProgram;
  try { program = parseHardwareProgram(value); }
  catch (error) { return (error as Error).message.split("\n"); }
  const used = new Set<string>();
  const visit = (steps: HardwareInstruction[]) => steps.forEach((step) => {
    if (step.kind === "digital_write") used.add(step.binding);
    if (step.kind === "repeat") visit(step.steps);
  });
  visit(program.setup); visit(program.loop);
  return program.bindings.filter((binding) => binding.pin === null && used.has(binding.id)).map((binding) =>
    `${binding.id}: ${t("数字输出尚未分配 GPIO", "digital output has no assigned GPIO")}`);
}

/** Fixed-width octal escapes cannot absorb following digits as a C++ hex escape would. */
export function escapeHardwareCppString(text: string): string {
  return Array.from(text).map((character) => {
    const replacements: Record<string, string> = { "\\": "\\\\", '"': '\\"', "?": "\\?", "\n": "\\n", "\r": "\\r", "\t": "\\t", "\b": "\\b", "\f": "\\f" };
    if (Object.hasOwn(replacements, character)) return replacements[character];
    const point = character.codePointAt(0)!;
    return point < 32 || point === 127 ? `\\${point.toString(8).padStart(3, "0")}` : character;
  }).join("");
}

export function generateHardwareCode(value: HardwareProgram): string {
  const issues = validateHardwareProgram(value);
  if (issues.length) throw new Error(issues.join("\n"));
  const program = parseHardwareProgram(value);
  const bindings = new Map(program.bindings.map((binding) => [binding.id, binding.pin]));
  let repeatIndex = 0;
  const lines = (steps: HardwareInstruction[], depth: number): string[] => steps.flatMap((step) => {
    const indent = "  ".repeat(depth);
    switch (step.kind) {
      case "serial_print": return [`${indent}Serial.println("${escapeHardwareCppString(step.text)}");`];
      case "delay": return [`${indent}delay(${step.ms});`];
      case "digital_write": return [`${indent}digitalWrite(${bindings.get(step.binding)}, ${step.value ? "HIGH" : "LOW"});`];
      case "repeat": {
        const variable = `repeat_${repeatIndex++}`;
        return [`${indent}for (int ${variable} = 0; ${variable} < ${step.count}; ${variable}++) {`, ...lines(step.steps, depth + 1), `${indent}}`];
      }
    }
  });
  return [
    "#include <Arduino.h>", "", "void setup() {", "  Serial.begin(115200);",
    ...program.bindings.filter((binding) => binding.pin !== null).map((binding) => `  pinMode(${binding.pin}, OUTPUT);`),
    ...lines(program.setup, 1), "}", "", "void loop() {", ...lines(program.loop, 1), "}", "",
  ].join("\n");
}

export function hardwareProgramFiles(program: HardwareProgram): Record<string, string> {
  const code = generateHardwareCode(program);
  const profile = BOARD_PROFILES.find((item) => item.id === program.board)!;
  return {
    "hardware_project/hardware_project.ino": code,
    "config.json": JSON.stringify(parseHardwareProgram(program), null, 2) + "\n",
    "manifest.json": JSON.stringify({ schema_version: 1, project_name: program.name, board: program.board, fqbn: profile.fqbn, source_only: true, compiled: false, uploaded: false, physical_tested: false }, null, 2) + "\n",
    "README.md": `# AE hardware program\n\nGeneric target: ${profile.fqbn}\n\nSource generation only. This export has not been compiled, uploaded or physically tested.\nVerify the exact board, module, exposed pins, voltage and external circuit before use.\nGPIO selections are conservative candidates, not a verified wiring diagram.\n\nGPIO reference: ${profile.sourceUrl}\n\nOpen hardware_project/hardware_project.ino with the Espressif ESP32 board package.\nSerial baud rate: 115200.\n`,
  };
}
