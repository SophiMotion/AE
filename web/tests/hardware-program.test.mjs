import assert from "node:assert/strict";
import test from "node:test";
import {
  BOARD_PROFILES, defaultHardwareProgram, ledHardwareProgram,
  parseHardwareProgram, validateHardwareProgram, generateHardwareCode,
  hardwareProgramFiles, escapeHardwareCppString,
} from "../src/hardwareProgram.ts";
import { setLocale } from "../src/localeStore.ts";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { transform } from "esbuild";
setLocale("en");

const serial = () => ({ kind: "serial_print", text: "hello" });
const empty = () => ({ ...defaultHardwareProgram(), setup: [], loop: [] });
const nested = (depth, count = 1) => depth ? { kind: "repeat", count, steps: [nested(depth - 1, count)] } : serial();

test("default serial program generates exact Arduino source without GPIO guesses", () => {
  const program = defaultHardwareProgram();
  assert.deepEqual(validateHardwareProgram(program), []);
  assert.equal(generateHardwareCode(program), '#include <Arduino.h>\n\nvoid setup() {\n  Serial.begin(115200);\n  Serial.println("AE ready");\n}\n\nvoid loop() {\n  Serial.println("Hello, AE!");\n  delay(1000);\n}\n');
  assert.deepEqual(program.bindings, []);
});

test("null output pins import and roundtrip but block source/export until assigned", () => {
  const draft = ledHardwareProgram();
  assert.deepEqual(parseHardwareProgram(draft), draft);
  assert.match(validateHardwareProgram(draft).join("\n"), /no assigned GPIO/);
  assert.throws(() => generateHardwareCode(draft), /no assigned GPIO/);
  assert.throws(() => hardwareProgramFiles(draft), /no assigned GPIO/);
  draft.bindings[0].pin = 4;
  const source = generateHardwareCode(draft);
  assert.match(source, /pinMode\(4, OUTPUT\);/);
  assert.match(source, /digitalWrite\(4, HIGH\);/);
  assert.match(source, /digitalWrite\(4, LOW\);/);
});

test("an unused unassigned binding is a valid incomplete draft", () => {
  const draft = empty();
  draft.bindings = [{ id: "future", label: "Future output", pin: null }];
  assert.deepEqual(validateHardwareProgram(draft), []);
  assert.doesNotMatch(generateHardwareCode(draft), /pinMode/);
});

test("unknown or missing fields reject at program, binding and instruction levels", () => {
  const base = empty();
  for (const malformed of [
    { ...base, code: "digitalWrite(1, HIGH);" },
    { ...base, schema_version: 2 },
    { ...base, loop: [{ ...serial(), disabled: true }] },
    { ...base, loop: [{ kind: "raw_code", code: "reset();" }] },
    { ...base, loop: [{ kind: "delay" }] },
    { ...base, bindings: [{ id: "pin", label: "Pin", pin: 4, metadata: {} }] },
    JSON.parse('{"__proto__":{},' + JSON.stringify(base).slice(1)),
  ]) assert.throws(() => parseHardwareProgram(malformed));
  const { request, ...missing } = base;
  assert.throws(() => parseHardwareProgram(missing), /missing or unknown fields/);
});

test("shape validator rejects non-objects, nested arrays, null and invalid fields", () => {
  for (const value of [null, [], 1, "{}", {}, { ...empty(), loop: null }, { ...empty(), setup: [null] }, { ...empty(), name: "" }]) {
    assert.throws(() => parseHardwareProgram(value));
    assert.ok(validateHardwareProgram(value).length);
  }
  for (const field of ["name", "request"]) assert.throws(() => parseHardwareProgram({ ...empty(), [field]: 4 }));
});

test("duplicate IDs, duplicate GPIO and invalid identifiers are rejected", () => {
  const binding = { id: "output", label: "Output", pin: 4 };
  assert.throws(() => parseHardwareProgram({ ...empty(), bindings: [binding, { ...binding, pin: 5 }] }), /duplicate binding ID/);
  assert.throws(() => parseHardwareProgram({ ...empty(), bindings: [binding, { ...binding, id: "second" }] }), /cannot be bound more than once/);
  for (const id of ["", "Output", "1pin", "bad-id", "p;reset()", "a".repeat(41)]) {
    assert.throws(() => parseHardwareProgram({ ...empty(), bindings: [{ ...binding, id }] }), /ID must start/);
  }
});

test("board profiles exclude flash, USB and common constrained GPIO candidates", () => {
  assert.deepEqual(BOARD_PROFILES.map(({ id, fqbn }) => [id, fqbn]), [["esp32", "esp32:esp32:esp32"], ["esp32s3", "esp32:esp32:esp32s3"]]);
  for (const [board, pin] of [["esp32", 0], ["esp32", 6], ["esp32", 34], ["esp32s3", 0], ["esp32s3", 19], ["esp32s3", 20], ["esp32s3", 35], ["esp32s3", 36], ["esp32s3", 37]]) {
    assert.throws(() => parseHardwareProgram({ ...empty(), board, bindings: [{ id: "output", label: "Output", pin }] }), /outside the conservative set/);
  }
  assert.throws(() => parseHardwareProgram({ ...empty(), board: "sophicar" }), /unsupported board/);
});

test("changing board cannot retain a GPIO excluded from the new target", () => {
  const program = { ...ledHardwareProgram("esp32"), bindings: [{ id: "output", label: "Output", pin: 33 }] };
  assert.deepEqual(validateHardwareProgram(program), []);
  assert.throws(() => parseHardwareProgram({ ...program, board: "esp32s3" }), /outside the conservative set/);
});

test("unknown output bindings and non-binary numeric values reject", () => {
  for (const step of [
    { kind: "digital_write", binding: "missing", value: 1 },
    { kind: "digital_write", binding: "output", value: true },
    { kind: "digital_write", binding: "output", value: "1" },
    { kind: "digital_write", binding: "output", value: 2 },
  ]) assert.throws(() => parseHardwareProgram({ ...ledHardwareProgram(), loop: [step] }));
});

test("integer limits reject non-integers, booleans, infinity and strings", () => {
  for (const ms of [0, 60001, 1.1, true, Infinity, NaN, "1000"]) {
    assert.throws(() => parseHardwareProgram({ ...empty(), loop: [{ kind: "delay", ms }] }), /delay must be an integer/);
  }
  for (const count of [0, 101, 2.3, false, "2"]) {
    assert.throws(() => parseHardwareProgram({ ...empty(), loop: [{ kind: "repeat", count, steps: [] }] }), /repeat count must be an integer/);
  }
  for (const ms of [1, 60000]) assert.doesNotThrow(() => parseHardwareProgram({ ...empty(), loop: [{ kind: "delay", ms }] }));
});

test("instruction count includes both entry points and nested instructions", () => {
  assert.doesNotThrow(() => parseHardwareProgram({ ...empty(), loop: Array.from({ length: 100 }, serial) }));
  assert.throws(() => parseHardwareProgram({ ...empty(), setup: [serial()], loop: Array.from({ length: 100 }, serial) }), /at most 100 instructions/);
  assert.throws(() => parseHardwareProgram({ ...empty(), loop: [{ kind: "repeat", count: 1, steps: Array.from({ length: 100 }, serial) }] }), /at most 100 instructions/);
});

test("four nested repeats allowed; fifth and hostile thousand-deep input reject before recursion", () => {
  assert.doesNotThrow(() => parseHardwareProgram({ ...empty(), loop: [nested(4)] }));
  assert.throws(() => parseHardwareProgram({ ...empty(), loop: [nested(5)] }), /at most 4 nested repeats/);
  let deep = serial();
  for (let i = 0; i < 10000; i++) deep = { kind: "repeat", count: 1, steps: [deep] };
  assert.throws(() => parseHardwareProgram({ ...empty(), loop: [deep] }), /at most 4 nested repeats/);
});

test("expanded budget counts repeat overhead and both entry points", () => {
  const program = { ...empty(), loop: [{ kind: "repeat", count: 100, steps: Array.from({ length: 99 }, serial) }] };
  assert.doesNotThrow(() => parseHardwareProgram(program)); // 1 + 100 * 99 = 9901
  assert.throws(() => parseHardwareProgram({ ...empty(), loop: [nested(2, 100)] }), /10000 expanded steps/);
  const half = { kind: "repeat", count: 100, steps: [{ kind: "repeat", count: 50, steps: [serial()] }] };
  assert.throws(() => parseHardwareProgram({ ...empty(), setup: [half], loop: [half] }), /10000 expanded steps/);
});

test("C++ escaping preserves Unicode and prevents quote, control, octal and trigraph injection", () => {
  const original = '\"\\\n\r\t\b\f\0' + '\x01' + '7\x7f' + '??/你好😀';
  const escaped = escapeHardwareCppString(original);
  assert.equal(escaped, '\\\"\\\\\\n\\r\\t\\b\\f\\000\\0017\\177\\?\\?/你好😀');
  const source = generateHardwareCode({ ...empty(), loop: [{ kind: "serial_print", text: '");\nreset();//' }] });
  assert.ok(source.includes('Serial.println("\\");\\nreset();//");'));
  assert.equal(source.split("\n").filter((line) => line.includes("reset()")).length, 1);
  for (const text of ["\ud800", "\udc00", "a\ud800b"]) assert.throws(() => parseHardwareProgram({ ...empty(), loop: [{ kind: "serial_print", text }] }), /valid Unicode/);
});

test("text lengths count Unicode characters consistently with backend", () => {
  assert.doesNotThrow(() => parseHardwareProgram({ ...empty(), loop: [{ kind: "serial_print", text: "😀".repeat(500) }] }));
  assert.throws(() => parseHardwareProgram({ ...empty(), loop: [{ kind: "serial_print", text: "😀".repeat(501) }] }));
  assert.throws(() => parseHardwareProgram({ ...empty(), name: "x".repeat(101) }));
  assert.throws(() => parseHardwareProgram({ ...empty(), request: "x".repeat(6001) }));
  assert.throws(() => parseHardwareProgram({ ...empty(), bindings: Array.from({ length: 9 }, (_, i) => ({ id: `pin${i}`, label: "Pin", pin: null })) }));
});

test("repeat variable names increment globally and exports use fixed safe paths", () => {
  const program = { ...empty(), name: "../../evil", setup: [nested(2)], loop: [nested(1)] };
  const source = generateHardwareCode(program);
  for (const index of [0, 1, 2]) assert.match(source, new RegExp(`for \\(int repeat_${index} = 0;`));
  const files = hardwareProgramFiles(program);
  assert.deepEqual(Object.keys(files), ["hardware_project/hardware_project.ino", "config.json", "manifest.json", "README.md"]);
  assert.deepEqual(JSON.parse(files["config.json"]), program);
  assert.equal(files["hardware_project/hardware_project.ino"], source);
  assert.equal(JSON.parse(files["manifest.json"]).compiled, false);
  const copied = parseHardwareProgram(program);
  copied.setup[0].steps.push(serial());
  assert.notDeepEqual(copied, program);
});

// Exercise the actual TSX cache guard without rendering React or creating build artifacts.
const editorUrl = new URL("../src/HardwareBlockEditor.tsx", import.meta.url);
const editorCode = await transform(await readFile(editorUrl, "utf8"), { loader: "tsx", format: "cjs", jsx: "automatic" });
const editorModule = { exports: {} };
const editorRequire = createRequire(editorUrl);
runInNewContext(editorCode.code + "\nmodule.exports.defineBlocksForTest = defineBlocks;", {
  module: editorModule,
  exports: editorModule.exports,
  require: (name) => name === "./i18n" ? {} : name === "./hardwareProgram" ? { parseHardwareProgram } : editorRequire(name),
});
const { parseHardwareCanvasDraft, serializeHardwareCanvasDraft } = editorModule.exports;
const rawSnapshot = (extraBlocks = []) => ({ blocks: { languageVersion: 0, blocks: [
  { type: "ae_setup", id: "setup", x: 30, y: 30, deletable: false },
  { type: "ae_loop", id: "loop", x: 30, y: 200, deletable: false },
  ...extraBlocks,
] } });
const cachedCanvas = (workspace, program = empty()) => JSON.stringify({ schema_version: 1, structure: JSON.stringify([program.setup, program.loop]), workspace });
const readCanvas = (raw, program = empty()) => parseHardwareCanvasDraft(raw, JSON.stringify([program.setup, program.loop]));

test("official Blockly serializer output roundtrips through the cache guard", () => {
  const Blockly = editorRequire("blockly/core");
  editorModule.exports.defineBlocksForTest(() => [], (zh, en) => en ?? zh);
  const workspace = new Blockly.Workspace();
  const restored = new Blockly.Workspace();
  try {
    workspace.newBlock("ae_setup");
    workspace.newBlock("ae_loop");
    workspace.newBlock("ae_serial_print").setFieldValue("detached text", "TEXT");
    workspace.newBlock("ae_digital_write");
    const snapshot = Blockly.serialization.workspaces.save(workspace);
    const raw = serializeHardwareCanvasDraft(snapshot, empty());
    const parsed = readCanvas(raw);
    Blockly.serialization.workspaces.load(parsed, restored);
    assert.equal(restored.getTopBlocks(false).length, 4);
    assert.equal(restored.getAllBlocks(false).find((block) => block.type === "ae_serial_print").getFieldValue("TEXT"), "detached text");
    assert.equal(restored.getAllBlocks(false).find((block) => block.type === "ae_digital_write").getFieldValue("BINDING"), "__unassigned__");
  } finally { workspace.dispose(); restored.dispose(); }
});

test("raw canvas cache preserves detached, disabled and temporarily over-nested edits", () => {
  let block = { type: "ae_serial_print", fields: { TEXT: "unsaved user text" }, disabledReasons: ["MANUALLY_DISABLED"] };
  for (let i = 0; i < 5; i++) block = { type: "ae_repeat", fields: { COUNT: 2 }, inputs: { STEPS: { block } } };
  const snapshot = rawSnapshot([block, { type: "ae_digital_write", fields: { BINDING: "__unassigned__", VALUE: "1" } }]);
  assert.equal(JSON.stringify(readCanvas(cachedCanvas(snapshot))), JSON.stringify(snapshot));
  assert.equal(serializeHardwareCanvasDraft(snapshot, empty()), cachedCanvas(snapshot));
});

test("canvas identity ignores metadata but rejects a different program structure", () => {
  const snapshot = rawSnapshot([{ type: "ae_serial_print", fields: { TEXT: "draft" } }]);
  const raw = cachedCanvas(snapshot);
  const metadataChange = { ...empty(), name: "New name", request: "New request", bindings: [{ id: "output", label: "Renamed", pin: 4 }] };
  assert.doesNotThrow(() => readCanvas(raw, metadataChange));
  assert.throws(() => readCanvas(raw, { ...empty(), loop: [serial()] }), /does not match/);
});

test("canvas cache rejects malformed envelopes, unknown types, metadata and field objects", () => {
  for (const snapshot of [
    { ...rawSnapshot(), variables: [] },
    rawSnapshot([{ type: "arbitrary_code", fields: { CODE: "reset();" } }]),
    rawSnapshot([{ type: "ae_serial_print", fields: { TEXT: "draft" }, extraState: { value: 1 } }]),
    rawSnapshot([{ type: "ae_serial_print", fields: { TEXT: { malicious: true } } }]),
    rawSnapshot([{ type: "ae_repeat", fields: { COUNT: 2 }, inputs: { UNKNOWN: { block: { type: "ae_delay", fields: { MS: 1 } } } } }]),
    rawSnapshot([{ type: "ae_delay", fields: { MS: 1 }, next: { shadow: { type: "ae_delay", fields: { MS: 2 } } } }]),
    rawSnapshot([{ type: "ae_digital_write", fields: { BINDING: "output", VALUE: "2" } }]),
    rawSnapshot([{ type: "ae_delay", fields: { MS: 1 }, id: "setup" }]),
  ]) assert.throws(() => readCanvas(cachedCanvas(snapshot)), /Invalid or oversized/);
  assert.throws(() => readCanvas("{broken"));
  assert.throws(() => readCanvas(JSON.stringify({ schema_version: 2, structure: "[[],[]]", workspace: rawSnapshot() })), /Invalid Blockly/);
  assert.throws(() => readCanvas(JSON.stringify({ schema_version: 1, structure: "[[],[]]", workspace: rawSnapshot(), script: "ignored" })), /Invalid Blockly/);
});

test("canvas cache bounds byte-like string size, block count and hostile nesting before Blockly load", () => {
  assert.throws(() => readCanvas(" ".repeat(1_000_001)), /exceeds size limit/);
  assert.throws(() => readCanvas(cachedCanvas(rawSnapshot(Array.from({ length: 101 }, () => ({ type: "ae_delay", fields: { MS: 1 } }))))), /Invalid or oversized/);
  const deepBlock = '{"type":"ae_repeat","fields":{"COUNT":1},"inputs":{"STEPS":{"block":'.repeat(3000) + '{"type":"ae_delay","fields":{"MS":1}}' + '}}}'.repeat(3000);
  const deepRaw = '{"schema_version":1,"structure":"[[],[]]","workspace":{"blocks":{"languageVersion":0,"blocks":[' + deepBlock + ']}}}';
  assert.throws(() => readCanvas(deepRaw), /Invalid or oversized/);
  assert.throws(() => readCanvas(cachedCanvas(rawSnapshot([{ type: "ae_serial_print", fields: { TEXT: "x".repeat(100001) } }]))), /Invalid or oversized/);
});
