import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowRight,
  CheckCircle,
  Code,
  Cpu,
  DownloadSimple,
  FileCode,
  FlowArrow,
  Lightning,
  Plus,
  Robot,
  UploadSimple,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { useI18n } from "./i18n";
import { api, isPublicDemo } from "./api";
import RequestInput from "./RequestInput";
import {
  BOARD_PROFILES,
  defaultHardwareProgram,
  generateHardwareCode,
  hardwareProgramFiles,
  ledHardwareProgram,
  parseHardwareProgram,
  validateHardwareProgram,
  type HardwareProgram,
} from "./hardwareProgram";
import "./hardwareWorkspace.css";

const HardwareBlockEditor = lazy(() => import("./HardwareBlockEditor"));
const cacheKey = `ae.hardware.workspace.v1.${isPublicDemo ? "public" : "local"}`;
type Suggestion = {
  program: HardwareProgram;
  summary: string;
  changes: string[];
  unresolved: string[];
  provenance: Record<string, unknown>;
};
function readDraft() {
  try {
    const raw = localStorage.getItem(cacheKey);
    return {
      program: raw
        ? parseHardwareProgram(JSON.parse(raw))
        : defaultHardwareProgram(),
      error: false,
    };
  } catch {
    return { program: defaultHardwareProgram(), error: true };
  }
}
function download(
  name: string,
  content: string | Blob,
  mime = "text/plain;charset=utf-8",
) {
  const url = URL.createObjectURL(
    content instanceof Blob ? content : new Blob([content], { type: mime }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function HardwareWorkspace({
  onUseRequirements,
  onFoldBot,
}: {
  onUseRequirements: (program: HardwareProgram) => void;
  onFoldBot: (console: boolean) => void;
}) {
  const { locale, t } = useI18n();
  const [initial] = useState(readDraft);
  const [program, setProgram] = useState(initial.program);
  const [storageError, setStorageError] = useState(initial.error);
  const [saveStatus, setSaveStatus] = useState("ready");
  const [tab, setTab] = useState("code");
  const [file, setFile] = useState("hardware_project/hardware_project.ino");
  const [editorError, setEditorError] = useState<string | null>(null);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [canvasStorageError, setCanvasStorageError] = useState<string | null>(
    null,
  );
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [overflow, setOverflow] = useState("");
  const [instruction, setInstruction] = useState("");
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const version = useRef(0);
  const alive = useRef(true);
  const request = useRef<AbortController | null>(null);
  const imported = useRef<HTMLInputElement>(null);
  const persist = useRef(!initial.error);
  const issues = validateHardwareProgram(program);
  const profile = BOARD_PROFILES.find((b) => b.id === program.board)!;
  let code = "",
    files: Record<string, string> = {};
  if (!issues.length && !editorError) {
    code = generateHardwareCode(program);
    files = hardwareProgramFiles(program);
  }
  const canGenerate = !issues.length && !editorError;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      request.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!persist.current) return;
    try {
      parseHardwareProgram(program);
      localStorage.setItem(cacheKey, JSON.stringify(program));
      setStorageError(false);
      setSaveStatus("saved");
    } catch {
      setSaveStatus("unsaved");
    }
  }, [program]);

  const editorState = useCallback((message: string | null) => {
    setEditorError(message);
    if (message) {
      version.current += 1;
      request.current?.abort();
      request.current = null;
      setAiBusy(false);
      setSuggestion(null);
    }
  }, []);

  const change = useCallback((next: HardwareProgram) => {
    version.current += 1;
    request.current?.abort();
    request.current = null;
    setAiBusy(false);
    setSuggestion(null);
    setError("");
    setMessage("");
    persist.current = true;
    setProgram(next);
  }, []);
  function replace(next: HardwareProgram) {
    if (
      (editorError ||
        JSON.stringify(program) !== JSON.stringify(defaultHardwareProgram())) &&
      !window.confirm(
        t(
          "用所选示例替换当前积木？可先导出 JSON 保存当前草稿。",
          "Replace the current blocks? Export JSON first to keep this draft.",
        ),
      )
    )
      return;
    setEditorError(null);
    setEditorEpoch((value) => value + 1);
    change(next);
  }
  function boardChange(board: HardwareProgram["board"]) {
    if (program.board === board) return;
    change({
      ...program,
      board,
      bindings: program.bindings.map((b) => ({ ...b, pin: null })),
    });
    setMessage(
      t(
        "已切换目标，请重新选择输出引脚。",
        "Target changed. Select output pins again.",
      ),
    );
  }
  async function importFile(file: File | undefined) {
    if (!file) return;
    const before = version.current;
    try {
      if (file.size > 128000)
        throw new Error(
          t(
            "配置文件不能超过 128 KB。",
            "Configuration must be smaller than 128 KB.",
          ),
        );
      const next = parseHardwareProgram(JSON.parse(await file.text()));
      if (!alive.current || before !== version.current) return;
      replace(next);
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (imported.current) imported.current.value = "";
    }
  }
  async function assist() {
    if (isPublicDemo || editorError) return;
    const text = instruction.trim() || program.request.trim();
    if (!text) {
      setError(
        t(
          "先写下希望实现或修改的功能。",
          "Describe the feature or change first.",
        ),
      );
      return;
    }
    try {
      parseHardwareProgram(program);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    const before = version.current;
    setAiBusy(true);
    setError("");
    setSuggestion(null);
    try {
      const result = await api<Suggestion>(
        "/hardware/assist",
        { program, instruction: text },
        "POST",
        controller.signal,
      );
      if (
        !alive.current ||
        controller.signal.aborted ||
        before !== version.current
      )
        return;
      parseHardwareProgram(result.program);
      setSuggestion(result);
    } catch (e) {
      if (
        alive.current &&
        !controller.signal.aborted &&
        before === version.current
      )
        setError((e as Error).message);
    } finally {
      if (alive.current && request.current === controller) {
        setAiBusy(false);
        request.current = null;
      }
    }
  }
  async function exportProject() {
    if (isPublicDemo || !canGenerate) return;
    const before = version.current;
    setExportBusy(true);
    setError("");
    try {
      const response = await fetch("/api/hardware/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(program),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(
          typeof data.detail === "string"
            ? data.detail
            : JSON.stringify(data.detail),
        );
      }
      const blob = await response.blob();
      if (!alive.current || before !== version.current) return;
      download("ae-hardware-project.zip", blob);
      setMessage(
        t(
          "已下载源码工程。编译、烧录与实物验证尚未执行。",
          "Source project downloaded. Build, flashing and device checks have not run.",
        ),
      );
    } catch (e) {
      if (alive.current && before === version.current)
        setError((e as Error).message);
    } finally {
      if (alive.current) setExportBusy(false);
    }
  }
  function addOutput() {
    const id = Array.from({ length: 9 }, (_, i) => `output${i + 1}`).find(
      (id) => !program.bindings.some((b) => b.id === id),
    )!;
    change({
      ...program,
      bindings: [...program.bindings, { id, label: id, pin: null }],
    });
    setTab("wiring");
  }
  function promptFile() {
    download(
      "hardware-ai-prompt.txt",
      `You are an AE hardware planning assistant. Suggest only serial_print, delay, digital_write and finite repeat instructions. Preserve board and bindings; never invent GPIO or claim a build/device test. Explain unsupported requirements and proposed changes. Return a candidate for human review.\nRequest: ${instruction || program.request}\nProgram:\n${JSON.stringify(program, null, 2)}`,
    );
  }

  return (
    <section className="hardware-workspace">
      <header className="hw-heading">
        <div>
          <p className="hw-eyebrow">
            <Cpu size={16} /> AE / HARDWARE STUDIO
          </p>
          <h1>{t("硬件开发工作区", "Hardware studio")}</h1>
          <p>
            {t(
              "把想法变成积木，随时查看它对应的代码与引脚。",
              "Build with blocks. See the code and pin assignments as you edit.",
            )}
          </p>
        </div>
        <div className="hw-save" role="status">
          <CheckCircle size={17} />
          {storageError || canvasStorageError || saveStatus === "unsaved"
            ? t("草稿未保存 · 请导出 JSON", "Draft not saved · export JSON")
            : saveStatus === "saving"
              ? t("正在保存…", "Saving…")
              : t("草稿保存在此浏览器", "Draft saved in this browser")}
        </div>
      </header>
      {storageError && (
        <p className="hw-warning" role="alert">
          {t(
            "旧草稿无法读取，尚未覆盖。可以导入备份，或编辑新草稿后保存。",
            "The old draft could not be read and has not been overwritten. Import a backup, or edit to save a new draft.",
          )}
        </p>
      )}
      {canvasStorageError && (
        <p className="hw-warning" role="alert">
          {canvasStorageError}
        </p>
      )}
      <div className="hw-targets" aria-label={t("编译目标", "Build target")}>
        {BOARD_PROFILES.map((b) => (
          <button
            type="button"
            className={`hw-target ${program.board === b.id ? "selected" : ""}`}
            key={b.id}
            onClick={() => boardChange(b.id)}
            aria-pressed={program.board === b.id}
          >
            <Cpu size={25} />
            <span>
              <strong>{b.id === "esp32s3" ? "ESP32-S3" : "ESP32"}</strong>
              <small>{t("通用 Arduino 目标", "Generic Arduino target")}</small>
            </span>
            {program.board === b.id && <CheckCircle size={20} />}
          </button>
        ))}
        <div className="hw-target-note">
          <strong>
            {t(
              "先选目标，再确认实物型号",
              "Choose a target, then verify your board",
            )}
          </strong>
          <p>
            {t(
              "当前是源码设计；通用目标不等于 Sophicar 扩展板。",
              "This is source design. Generic targets do not describe the Sophicar expansion board.",
            )}
          </p>
        </div>
      </div>
      <div className="hw-project-row">
        <label>
          {t("工程名称", "Project name")}
          <input
            aria-label={t("硬件工程名称", "Hardware project name")}
            maxLength={100}
            value={program.name}
            onChange={(e) => change({ ...program, name: e.target.value })}
          />
        </label>
        <span>
          <code>{profile.fqbn}</code>
          <small>
            {t(
              "串口波特率 115200 · 尚未编译或烧录",
              "Serial 115200 · not built or flashed",
            )}
          </small>
        </span>
      </div>
      <div className="hw-toolbar">
        <div>
          <button
            className="button secondary"
            onClick={() =>
              replace({ ...defaultHardwareProgram(), board: program.board })
            }
          >
            {t("串口示例", "Serial example")}
          </button>
          <button
            className="button secondary"
            onClick={() => replace(ledHardwareProgram(program.board))}
          >
            {t("LED 闪烁示例", "LED blink example")}
          </button>
        </div>
        <div>
          <input
            ref={imported}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => void importFile(e.target.files?.[0])}
          />
          <button
            className="button secondary"
            onClick={() => imported.current?.click()}
          >
            <UploadSimple size={16} />
            {t("导入 JSON", "Import JSON")}
          </button>
          <button
            className="button secondary"
            disabled={!!editorError}
            onClick={() =>
              download(
                "config.json",
                JSON.stringify(program, null, 2),
                "application/json",
              )
            }
          >
            <DownloadSimple size={16} />
            {t("导出 JSON", "Export JSON")}
          </button>
        </div>
      </div>
      {message && (
        <p className="hw-message" role="status">
          {message}
        </p>
      )}
      {error && (
        <div className="hw-warning" role="alert">
          <WarningCircle size={18} />
          <span>{error}</span>
          <button
            aria-label={t("关闭提示", "Dismiss")}
            onClick={() => setError("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      <div className="hw-grid">
        <section className="hw-canvas-panel">
          <div className="hw-panel-heading">
            <h2>
              <FlowArrow size={20} />
              {t("程序积木", "Program blocks")}
            </h2>
            <span>{t("初始化 → 循环执行", "Setup → loop")}</span>
          </div>
          <p className="hw-caption">
            {t(
              "从左侧分类拖入积木，连接到初始化或循环入口。右键可删除。",
              "Drag blocks from the toolbox into Setup or Loop. Right-click to delete.",
            )}
          </p>
          <Suspense
            fallback={
              <p className="hw-loading">
                {t("正在载入积木编辑器…", "Loading block editor…")}
              </p>
            }
          >
            <HardwareBlockEditor
              draftKey={`ae.hardware.blockly.v1.${isPublicDemo ? "public" : "local"}`}
              resetEpoch={editorEpoch}
              onStorageError={setCanvasStorageError}
              program={program}
              onChange={change}
              onError={editorState}
            />
          </Suspense>
          {editorError || issues.length > 0 ? (
            <div className="hw-validation" role="alert">
              <WarningCircle size={19} />
              <div>
                <strong>
                  {t(
                    "完成这些设置后再生成代码",
                    "Complete these settings to generate code",
                  )}
                </strong>
                {editorError && <p>{editorError}</p>}
                {issues.slice(0, 5).map((issue) => (
                  <p key={issue}>{issue}</p>
                ))}
              </div>
            </div>
          ) : (
            <div className="hw-validation valid">
              <CheckCircle size={19} />
              <span>
                {t(
                  "程序结构检查通过 · 源码已同步，未进行编译或实物验证",
                  "Structure valid · source updated, build and device tests have not run",
                )}
              </span>
            </div>
          )}
        </section>
        <section className="hw-inspector">
          <div
            className="hw-tabs"
            role="tablist"
            aria-label={t("设计视图", "Design views")}
          >
            {[
              ["code", "代码", "Code"],
              ["wiring", "接线与引脚", "Wiring & pins"],
              ["files", "工程文件", "Files"],
            ].map(([id, zh, en]) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
              >
                {t(zh, en)}
              </button>
            ))}
          </div>
          {tab === "code" ? (
            <div className="hw-tab-content">
              <div className="hw-file-caption">
                <FileCode size={17} />
                <code>hardware_project.ino</code>
              </div>
              {canGenerate ? (
                <pre className="hw-code">
                  <code>{code}</code>
                </pre>
              ) : (
                <div className="hw-empty">
                  <Code size={34} />
                  <p>
                    {t(
                      "积木或引脚还有待补项。修正后这里会显示完整源码。",
                      "Fix the blocks or missing pins to view the complete source.",
                    )}
                  </p>
                  <button
                    className="text-button"
                    onClick={() => setTab("wiring")}
                  >
                    {t("设置引脚", "Assign pins")}
                  </button>
                </div>
              )}
              <button
                className="button secondary hw-download"
                disabled={!canGenerate}
                onClick={() => download("hardware_project.ino", code)}
              >
                <DownloadSimple size={16} />
                {t("下载 Arduino 源码", "Download Arduino source")}
              </button>
            </div>
          ) : tab === "wiring" ? (
            <div className="hw-tab-content">
              <p className="hw-caption">
                {t(
                  "这是信号连接草图。电源、限流和驱动接线需按实物确认；不可直接接电机。",
                  "Signal diagram only. Verify power, current limiting and drivers for your hardware; do not connect motors directly.",
                )}
              </p>
              {program.bindings.length ? (
                <>
                  <svg
                    className="hw-wiring"
                    viewBox={`0 0 400 ${Math.max(120, program.bindings.length * 70 + 25)}`}
                    role="img"
                    aria-label={t("输出信号连接图", "Output signal diagram")}
                  >
                    <rect
                      x="8"
                      y="8"
                      width="130"
                      height={Math.max(100, program.bindings.length * 70)}
                      rx="10"
                      fill="#eef3ff"
                      stroke="#002fa7"
                    />
                    <text x="18" y="32" fill="#002fa7" fontSize="15">
                      {program.board.toUpperCase()}
                    </text>
                    {program.bindings.map((b, i) => (
                      <g key={b.id}>
                        <text
                          x="18"
                          y={60 + i * 70}
                          fill="#27364e"
                          fontSize="13"
                        >
                          {b.pin === null ? "GPIO ?" : `GPIO ${b.pin}`}
                        </text>
                        <path
                          d={`M138 ${55 + i * 70} L230 ${55 + i * 70}`}
                          stroke={b.pin === null ? "#a96a00" : "#4285f4"}
                          strokeWidth="3"
                          strokeDasharray={b.pin === null ? "5 5" : undefined}
                        />
                        <rect
                          x="230"
                          y={35 + i * 70}
                          width="160"
                          height="40"
                          rx="8"
                          fill="#f4f7fa"
                          stroke="#d4dde8"
                        />
                        <text
                          x="240"
                          y={60 + i * 70}
                          fontSize="12"
                          fill="#27364e"
                        >
                          {b.label.slice(0, 15)}
                        </text>
                      </g>
                    ))}
                  </svg>
                  {program.bindings.map((b) => (
                    <div className="hw-binding" key={b.id}>
                      <label>
                        {t("输出名称", "Output label")}
                        <input
                          value={b.label}
                          maxLength={100}
                          onChange={(e) =>
                            change({
                              ...program,
                              bindings: program.bindings.map((x) =>
                                x.id === b.id
                                  ? { ...x, label: e.target.value }
                                  : x,
                              ),
                            })
                          }
                        />
                      </label>
                      <label>
                        {t("分配 GPIO", "Assign GPIO")}
                        <select
                          aria-label={`${b.id} GPIO`}
                          value={b.pin ?? ""}
                          onChange={(e) =>
                            change({
                              ...program,
                              bindings: program.bindings.map((x) =>
                                x.id === b.id
                                  ? {
                                      ...x,
                                      pin:
                                        e.target.value === ""
                                          ? null
                                          : Number(e.target.value),
                                    }
                                  : x,
                              ),
                            })
                          }
                        >
                          <option value="">
                            {t("待选择", "Choose a pin")}
                          </option>
                          {profile.pins.map((pin) => (
                            <option
                              key={pin}
                              value={pin}
                              disabled={program.bindings.some(
                                (other) =>
                                  other.id !== b.id && other.pin === pin,
                              )}
                            >
                              GPIO {pin}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  ))}
                </>
              ) : (
                <div className="hw-empty">
                  <Cpu size={30} />
                  <p>
                    {t(
                      "当前仅使用串口，不需要数字输出接线。",
                      "This serial program needs no digital output wiring.",
                    )}
                  </p>
                </div>
              )}
              <button
                className="button secondary hw-download"
                disabled={program.bindings.length >= 8}
                onClick={addOutput}
              >
                <Plus size={16} />
                {t("添加数字输出", "Add digital output")}
              </button>
              <details className="hw-pinmap">
                <summary>
                  {t("查看目标引脚集合", "View target pin set")}
                </summary>
                <div>
                  {profile.pins.map((pin) => (
                    <span
                      className={
                        program.bindings.some((b) => b.pin === pin)
                          ? "assigned"
                          : ""
                      }
                      key={pin}
                    >
                      GPIO {pin}
                    </span>
                  ))}
                </div>
                <p>
                  {t(
                    "保守可选集合，不是开发板的物理排针位置图。已避开部分存储、USB 与启动引脚；仍须核对实际模组。",
                    "Conservative pin set, not a physical header diagram. Some memory, USB and boot pins are excluded; verify the actual module.",
                  )}
                </p>
                <a href={profile.sourceUrl} target="_blank" rel="noreferrer">
                  {t("乐鑫 GPIO 资料", "Espressif GPIO reference")}
                </a>
              </details>
            </div>
          ) : (
            <div className="hw-tab-content">
              <p className="hw-caption">
                {t(
                  "固定目录与文件名，便于在 Arduino 工具链打开。",
                  "Fixed paths and names for use with the Arduino toolchain.",
                )}
              </p>
              {canGenerate ? (
                <>
                  <div className="hw-file-list">
                    {Object.keys(files).map((path) => (
                      <button
                        key={path}
                        className={file === path ? "selected" : ""}
                        onClick={() => setFile(path)}
                      >
                        <FileCode size={15} />
                        {path}
                      </button>
                    ))}
                  </div>
                  <pre className="hw-code small">
                    <code>{files[file] ?? Object.values(files)[0]}</code>
                  </pre>
                  <button
                    className="button secondary"
                    onClick={() =>
                      download(
                        (files[file] ? file : Object.keys(files)[0])
                          .split("/")
                          .pop()!,
                        files[file] ?? Object.values(files)[0],
                      )
                    }
                  >
                    {t("下载当前文件", "Download selected file")}
                  </button>
                </>
              ) : (
                <p>
                  {t(
                    "补齐积木和引脚后显示工程文件。配置 JSON 始终可以导出。",
                    "Complete blocks and pins to view project files. Configuration JSON can still be exported.",
                  )}
                </p>
              )}
              <button
                className="button primary hw-download"
                disabled={!canGenerate || exportBusy || isPublicDemo}
                onClick={() => void exportProject()}
              >
                <DownloadSimple size={17} />
                {exportBusy
                  ? t("正在打包…", "Packaging…")
                  : t("下载完整工程 ZIP", "Download project ZIP")}
              </button>
              {isPublicDemo && (
                <p className="hw-caption">
                  {t(
                    "分享版可下载单个源码和配置；完整 ZIP 打包使用本机服务。",
                    "Download source and config here; ZIP packaging requires the local service.",
                  )}
                </p>
              )}
            </div>
          )}
        </section>
      </div>
      <div className="hw-bottom-grid">
        <section className="hw-assistant">
          <div className="hw-panel-heading">
            <h2>
              <Lightning size={21} />
              {t("描述需求，让 AI 帮你整理", "Describe it with AI assistance")}
            </h2>
            <span>
              {isPublicDemo
                ? t("分享版 · 提示词与示例", "Public demo · prompts & examples")
                : t("使用本机模型设置", "Uses local model settings")}
            </span>
          </div>
          <RequestInput
            value={program.request}
            onChange={(value) =>
              change({ ...program, request: value.slice(0, 6000) })
            }
            disabled={false}
            placeholder={t(
              "例如：每隔一秒输出一次 Hello，启动时输出 Ready。",
              "Example: print Hello every second, and Ready at startup.",
            )}
            rows={3}
            overflow={overflow}
            onOverflowChange={setOverflow}
          />
          <label className="hw-extra-request">
            {t("这次希望怎样修改（可选）", "Change request (optional)")}
            <input
              maxLength={2000}
              value={instruction}
              onChange={(e) => {
                request.current?.abort();
                setAiBusy(false);
                setSuggestion(null);
                setInstruction(e.target.value);
              }}
              placeholder={t(
                "例如：把间隔改成 500 毫秒，其他保持不变",
                "Example: change the interval to 500 ms, keep the rest",
              )}
            />
          </label>
          <div className="hw-actions">
            <button
              className="button primary"
              disabled={isPublicDemo || aiBusy || !!editorError}
              onClick={() => void assist()}
            >
              <Lightning size={17} />
              {aiBusy
                ? t("正在分析…", "Analyzing…")
                : t("生成修改建议", "Suggest changes")}
            </button>
            {aiBusy && (
              <button
                className="button secondary"
                onClick={() => {
                  request.current?.abort();
                  request.current = null;
                  setAiBusy(false);
                }}
              >
                {t("取消", "Cancel")}
              </button>
            )}
            <button className="button secondary" onClick={promptFile}>
              {t("下载 AI 提示词", "Download AI prompt")}
            </button>
          </div>
          <p className="hw-caption">
            {isPublicDemo
              ? t(
                  "这里可以编辑积木和生成确定性的源码预览；AI 调用需要本机版。",
                  "Edit blocks and generate deterministic source previews here. AI calls require local mode.",
                )
              : t(
                  "AI 返回待采用草稿，先看修改说明，再决定是否应用。未知引脚不会自动补上。",
                  "Review the candidate before applying it. Unknown pins are not filled automatically.",
                )}
          </p>
          {suggestion && (
            <section className="hw-suggestion">
              <h3>{t("待采用的建议", "Candidate changes")}</h3>
              <p>{suggestion.summary}</p>
              <ul>
                {suggestion.changes.map((text, i) => (
                  <li key={i}>{text}</li>
                ))}
              </ul>
              {suggestion.unresolved.length > 0 && (
                <div className="hw-warning">
                  <ul>
                    {suggestion.unresolved.map((text, i) => (
                      <li key={i}>{text}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="hw-actions">
                <button
                  className="button primary"
                  disabled={!!editorError}
                  onClick={() => {
                    if (editorError) return;
                    setEditorError(null);
                    setEditorEpoch((value) => value + 1);
                    change(suggestion.program);
                    setMessage(
                      t(
                        "已采用建议，积木和代码已同步。",
                        "Candidate applied. Blocks and code updated.",
                      ),
                    );
                  }}
                >
                  {t("采用这份建议", "Apply candidate")}
                </button>
                <button
                  className="button secondary"
                  onClick={() => setSuggestion(null)}
                >
                  {t("保留原稿", "Keep original")}
                </button>
              </div>
              <details>
                <summary>
                  {t(
                    "查看本次提示词与模型记录",
                    "View prompt and model record",
                  )}
                </summary>
                <pre className="hw-code small">
                  {JSON.stringify(suggestion.provenance, null, 2)}
                </pre>
              </details>
            </section>
          )}
        </section>
        <aside className="hw-next">
          <h2>{t("继续你的 AE 工程", "Continue in AE")}</h2>
          <p>
            {t(
              "把这里的需求和配置摘要带入 PRD，再沿用需求、方案、生成和验收流程。",
              "Carry the request and configuration summary into PRD, then continue through planning, generation and checks.",
            )}
          </p>
          <button
            className="button primary"
            disabled={!!editorError || !program.name.trim()}
            onClick={() => onUseRequirements(program)}
          >
            {t("带入 PRD 需求", "Send to PRD")}
            <ArrowRight size={17} />
          </button>
          <p className="hw-caption">
            {t(
              "会新建需求草稿；现有 ROS 任务仍按各自支持范围核对，不会直接执行这些积木。",
              "Creates a new request draft. Existing ROS workflows still require their own checks; these blocks are not executed directly.",
            )}
          </p>
          <div className="hw-foldbot-links">
            <Robot size={23} />
            <strong>FoldBot</strong>
            <p>
              {t(
                "整机工程继续使用已有模板和控制协议。",
                "The full robot keeps its existing template and control protocol.",
              )}
            </p>
            <button className="text-button" onClick={() => onFoldBot(false)}>
              {t("打开折叠机器人工程", "Open FoldBot project")} →
            </button>
            <button className="text-button" onClick={() => onFoldBot(true)}>
              {t("打开原版完整控制台", "Open original full console")} →
            </button>
          </div>
        </aside>
      </div>
      <footer className="hw-attribution">
        <span>
          {t(
            "交互参考：v1 视频中的 aily Blockly；编辑器使用官方 Blockly。",
            "Interaction reference: aily Blockly in v1 video. Editor powered by official Blockly.",
          )}
        </span>
        <a
          href="https://github.com/RaspberryPiFoundation/blockly"
          target="_blank"
          rel="noreferrer"
        >
          Blockly · Apache-2.0
        </a>
        <span>
          {locale === "en"
            ? "Source design ≠ device verification"
            : "源码设计与实物验收分别记录"}
        </span>
      </footer>
    </section>
  );
}
