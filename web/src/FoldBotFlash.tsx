import { useEffect, useRef, useState } from "react";
import { isPublicDemo } from "./api";
import { useI18n } from "./i18n";
import {
  bindingKey,
  createEspressifDriver,
  createFlashLeaseApi,
  flashManifestTemplate,
  flashSessionBusy,
  FoldBotFlashSession,
  initialFlashSnapshot,
  requireLocalFlash,
  validateFlashBundle,
  prepareImportedFlashBundle,
  type FlashBinding,
  type FlashBundle,
  type FlashSnapshot,
  type FlashPort,
} from "./foldbotFlashLogic";
import "./foldbotFlash.css";

function saveText(name: string, content: string) {
  const url = URL.createObjectURL(
    new Blob([content], {
      type: name.endsWith(".json")
        ? "application/json;charset=utf-8"
        : "text/plain;charset=utf-8",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function FoldBotFlash(props: FlashBinding) {
  const { t } = useI18n();
  const current = useRef(props);
  current.current = props;
  const mounted = useRef(false);
  const controller = useRef<FoldBotFlashSession | null>(null);
  const inputVersion = useRef(0);
  const [snapshot, setSnapshot] = useState<FlashSnapshot>(initialFlashSnapshot);
  const [manifest, setManifest] = useState<File | null>(null);
  const [app, setApp] = useState<File | null>(null);
  const [partitions, setPartitions] = useState<File | null>(null);
  const [bundle, setBundle] = useState<FlashBundle | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isolated, setIsolated] = useState(false);
  const [writeConfirmed, setWriteConfirmed] = useState(false);
  const [buildName, setBuildName] = useState("");
  const [fqbn, setFqbn] = useState("");
  const [compiledAt, setCompiledAt] = useState("");
  const busy = flashSessionBusy(snapshot.phase);
  let local = false;
  try {
    requireLocalFlash(
      isPublicDemo,
      window.location.origin,
      window.isSecureContext,
    );
    local = true;
  } catch {
    /* Preview and remote origins have no device capability. */
  }
  const supported = local && "serial" in navigator;
  const available =
    supported &&
    props.current &&
    !!props.projectId &&
    !!props.generationId &&
    !!props.sourceHash &&
    props.revision !== null;
  const key = bindingKey(props);

  useEffect(() => {
    mounted.current = true;
    if (!local)
      return () => {
        mounted.current = false;
      };
    const session = new FoldBotFlashSession({
      publicMode: isPublicDemo,
      origin: window.location.origin,
      secure: window.isSecureContext,
      binding: () => current.current,
      requestPort: () => {
        if (!("serial" in navigator))
          return Promise.reject(new Error("serial_unsupported"));
        return (
          navigator as Navigator & {
            serial: { requestPort(): Promise<FlashPort> };
          }
        ).serial.requestPort();
      },
      lease: createFlashLeaseApi(),
      driver: createEspressifDriver,
      notify(value) {
        phase.current = value.phase;
        if (mounted.current) setSnapshot(value);
        window.dispatchEvent(
          new CustomEvent("ae-foldbot-flash-busy", {
            detail: { busy: flashSessionBusy(value.phase) },
          }),
        );
      },
    });
    controller.current = session;
    const leave = () => {
      void session.cancel("page_left_outcome_unknown");
    };
    const before = (event: BeforeUnloadEvent) => {
      // The handler reads current phase through the broadcast ref below, never an old React closure.
      if (flashSessionBusy(phase.current)) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const hidden = () => {
      if (document.hidden && flashSessionBusy(phase.current)) leave();
    };
    window.addEventListener("beforeunload", before);
    window.addEventListener("pagehide", leave);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      mounted.current = false;
      inputVersion.current++;
      window.removeEventListener("beforeunload", before);
      window.removeEventListener("pagehide", leave);
      document.removeEventListener("visibilitychange", hidden);
      void session.cancel("page_left_outcome_unknown");
      controller.current = null;
    };
  }, [local]);
  const phase = useRef(snapshot.phase);
  phase.current = snapshot.phase;

  useEffect(() => {
    inputVersion.current++;
    setBundle(null);
    setIsolated(false);
    setWriteConfirmed(false);
    setError(null);
    setManifest(null);
    setApp(null);
    setPartitions(null);
    setChecking(false);
    void controller.current?.cancel("generation_changed");
  }, [key]);

  function changeFile(
    kind: "manifest" | "app" | "partitions",
    file: File | null,
  ) {
    inputVersion.current++;
    setBundle(null);
    setError(null);
    setWriteConfirmed(false);
    if (kind === "manifest") setManifest(file);
    else if (kind === "app") setApp(file);
    else setPartitions(file);
  }
  async function verifyFiles() {
    if (!available || !manifest || !app || !partitions || busy) return;
    const version = ++inputVersion.current;
    const bound = bindingKey(current.current);
    setChecking(true);
    setError(null);
    setBundle(null);
    try {
      if (
        manifest.size > 24 * 1024 ||
        app.size > 16 * 1024 * 1024 ||
        partitions.size > 4096
      )
        throw new Error("artifact_size_mismatch");
      const json = JSON.parse(await manifest.text());
      if (
        json.app?.filename !== app.name ||
        json.partition_table?.filename !== partitions.name
      )
        throw new Error("artifact_filename_mismatch");
      const result = await validateFlashBundle(
        json,
        new Uint8Array(await app.arrayBuffer()),
        new Uint8Array(await partitions.arrayBuffer()),
        current.current,
      );
      if (
        mounted.current &&
        inputVersion.current === version &&
        bindingKey(current.current) === bound
      )
        setBundle(result);
    } catch (cause) {
      if (mounted.current && inputVersion.current === version)
        setError(
          cause instanceof SyntaxError
            ? "invalid_manifest"
            : cause instanceof Error
              ? cause.message
              : "invalid_manifest",
        );
    } finally {
      if (mounted.current && inputVersion.current === version)
        setChecking(false);
    }
  }
  async function run(action: () => Promise<void>) {
    setError(null);
    try {
      await action();
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : "serial_failed");
    }
  }
  async function prepareManifest() {
    if (
      !available ||
      !app ||
      !partitions ||
      busy ||
      !buildName.trim() ||
      !fqbn.trim() ||
      !compiledAt
    )
      return;
    const version = ++inputVersion.current;
    const bound = bindingKey(current.current);
    setChecking(true);
    setError(null);
    setBundle(null);
    try {
      if (app.size > 16 * 1024 * 1024 || partitions.size > 4096)
        throw new Error("artifact_size_mismatch");
      const result = await prepareImportedFlashBundle({
        binding: current.current,
        appName: app.name,
        app: new Uint8Array(await app.arrayBuffer()),
        partitionName: partitions.name,
        partitions: new Uint8Array(await partitions.arrayBuffer()),
        firmwareBuild: buildName,
        fqbn,
        compiledAt: new Date(compiledAt).toISOString(),
      });
      if (
        mounted.current &&
        inputVersion.current === version &&
        bindingKey(current.current) === bound
      ) {
        setBundle(result);
        setManifest(null);
        setWriteConfirmed(false);
        saveText(
          "foldbot-flash-manifest.json",
          JSON.stringify(result.manifest, null, 2),
        );
      }
    } catch (cause) {
      if (mounted.current && inputVersion.current === version)
        setError(cause instanceof Error ? cause.message : "invalid_manifest");
    } finally {
      if (mounted.current && inputVersion.current === version)
        setChecking(false);
    }
  }
  const messages: Record<string, [string, string]> = {
    write_interrupted_outcome_unknown: [
      "写入或回读已中断，板上固件可能不完整；保持执行器断电，重新检查后再决定下一步。",
      "Writing or read-back was interrupted; firmware may be incomplete. Keep actuators unpowered and inspect the board before proceeding.",
    ],
    current_generation_required: [
      "请先生成当前需求版本的工程。",
      "Generate the current requirement revision first.",
    ],
    public_preview_only: [
      "分享页只展示流程，不访问 USB。",
      "Public pages show the workflow without USB access.",
    ],
    local_origin_required: [
      "请在本机 localhost／127.0.0.1 打开完整 AE。",
      "Open the complete AE on localhost / 127.0.0.1.",
    ],
    invalid_manifest: [
      "构建清单格式不正确或信息未填完整。",
      "The build manifest is malformed or incomplete.",
    ],
    unsupported_flash_profile: [
      "仅支持 ESP32-S3 的现有单应用分区更新。",
      "Only ESP32-S3 updates using an existing single-app partition table are supported.",
    ],
    unsupported_partition_layout: [
      "分区布局不在当前支持范围，不能自动修改。",
      "This partition layout is unsupported and cannot be changed automatically.",
    ],
    stale_flash_artifact: [
      "固件清单对应其他工程或旧版本，请重新准备。",
      "The manifest belongs to another project or revision. Prepare it again.",
    ],
    wrong_chip: [
      "编译目标必须是已确认的 ESP32-S3 板型配置。",
      "Use a confirmed ESP32-S3 board build configuration.",
    ],
    app_only_required: [
      "请导入单独应用 .bin；不接受合并包、引导程序或分区表烧录。",
      "Import a standalone application .bin; merged, bootloader and partition-table writes are not accepted.",
    ],
    artifact_size_mismatch: [
      "文件大小与清单不一致，或超过允许范围。",
      "File sizes do not match the manifest or exceed limits.",
    ],
    artifact_filename_mismatch: [
      "所选文件名与构建清单不一致。",
      "Selected filenames differ from the build manifest.",
    ],
    invalid_s3_application: [
      "这不是可识别的 ESP32-S3 应用镜像。",
      "This is not a recognized ESP32-S3 application image.",
    ],
    invalid_partition_table: [
      "无法读取有效的 ESP 分区表。",
      "A valid ESP partition table could not be read.",
    ],
    nvs_partition_required: [
      "分区表缺少有效 NVS，不能保证保留标定。",
      "The partition table lacks valid NVS; calibration preservation cannot be checked.",
    ],
    overlapping_partitions: [
      "分区地址重叠，已阻止烧录。",
      "Overlapping partitions blocked flashing.",
    ],
    single_app_partition_required: [
      "当前只支持单应用分区，不自动切换 OTA 槽位。",
      "Only one application partition is supported; OTA slots are not changed automatically.",
    ],
    app_outside_partition: [
      "应用偏移或大小超出对应分区。",
      "Application offset or size does not fit its partition.",
    ],
    artifact_hash_mismatch: [
      "文件 SHA-256 与清单不一致。",
      "File SHA-256 does not match the manifest.",
    ],
    port_selection_cancelled: [
      "已取消串口选择，没有连接开发板。",
      "Port selection was cancelled; no board was connected.",
    ],
    select_port_first: [
      "请先选择开发板 USB 串口。",
      "Select the board USB serial port first.",
    ],
    serial_unsupported: [
      "此浏览器没有 Web Serial，请使用桌面 Chrome 或 Edge。",
      "Web Serial is unavailable. Use desktop Chrome or Edge.",
    ],
    hardware_isolation_required: [
      "请先确认执行器断电，并关闭其他控制端。",
      "Confirm actuator power is disconnected and other controllers are closed.",
    ],
    control_busy_or_stale: [
      "控制台正在使用机器人，或工程版本已变化。请先断开控制台。",
      "A controller is using the robot, or the project is stale. Disconnect the console first.",
    ],
    flash_lease_unavailable: [
      "本机烧录接口不可用，请检查或重启 AE 后台。",
      "The local flash session API is unavailable. Check or restart AE.",
    ],
    flash_lease_lost: [
      "烧录会话失联，已撤销；请检查 USB 与板上状态，不自动重试。",
      "The flash lease was lost. Check USB and board state; no automatic retry.",
    ],
    flash_session_revoked: [
      "工程或页面发生变化，烧录会话已撤销。",
      "The project or page changed; this flash session was revoked.",
    ],
    wrong_chip_or_secure_device: [
      "芯片不匹配或处于安全下载模式，已停止。",
      "The chip differs or uses secure download mode. Stopped.",
    ],
    encrypted_or_secure_device: [
      "检测到安全启动或加密配置，请使用专门流程。",
      "Secure boot or encryption requires a dedicated workflow.",
    ],
    flash_size_mismatch: [
      "实际 Flash 容量不符合分区表。",
      "Detected flash capacity does not fit the partition table.",
    ],
    live_partition_mismatch: [
      "板上分区与导入分区不一致；为保留 NVS，已阻止写入。",
      "The live partition table differs. Writing is blocked to preserve NVS.",
    ],
    write_confirmation_required: [
      "请核对本次写入的应用信息后确认。",
      "Confirm the application details before writing.",
    ],
    connect_and_verify_first: [
      "请先连接板卡并完成芯片、分区核对。",
      "Connect and verify the chip and partitions first.",
    ],
    write_readback_mismatch: [
      "写后回读校验失败，不能标记烧录成功。",
      "Read-back verification failed; flashing is not marked successful.",
    ],
    serial_cleanup_uncertain: [
      "串口关闭结果不确定，本机控制锁仍保留。保持执行器断电，检查设备后重试“断开”；若页面已关闭，需要检查串口后重启本机后台。",
      "Serial cleanup is uncertain and local control remains locked. Keep actuators unpowered and retry Disconnect after checking the device. If this page was closed, inspect the port before restarting the local server.",
    ],
    flash_busy: [
      "当前烧录会话尚未结束，请先断开。",
      "The flash session is active. Disconnect first.",
    ],
    page_left_outcome_unknown: [
      "页面已离开，USB 操作已中止；板上结果需要重新核对。",
      "The page was left and USB operation was interrupted. Recheck the board.",
    ],
  };
  const issue =
    (snapshot.error === "serial_cleanup_uncertain" ? snapshot.error : error) ??
    (snapshot.error &&
    !["generation_changed", "operator_disconnected"].includes(snapshot.error)
      ? snapshot.error
      : null);
  const explanation = issue
    ? messages[issue]
      ? t(...messages[issue])
      : t("USB 操作未完成：", "USB operation did not finish: ") +
        issue.slice(0, 250)
    : null;
  const phaseLabels: Record<FlashSnapshot["phase"], [string, string]> = {
    idle: ["未连接 USB", "USB disconnected"],
    selected: ["已选择串口 · 尚未打开", "Port selected · not opened"],
    connecting: ["连接并核对板卡…", "Connecting and checking the board…"],
    ready: [
      "芯片与分区已核对 · 等待写入",
      "Chip and partitions checked · awaiting write",
    ],
    writing: ["正在写入应用…", "Writing the application…"],
    verifying: ["正在回读校验…", "Verifying read-back…"],
    verified: [
      "应用写入与回读校验通过 · 实物未验收",
      "Application write and read-back passed · hardware unverified",
    ],
    closing: ["正在关闭串口…", "Closing the serial port…"],
    "cleanup-required": [
      "串口待检查 · 控制锁保留",
      "Serial cleanup required · control remains locked",
    ],
    failed: ["操作未完成", "Operation incomplete"],
  };
  return (
    <section
      className="foldbot-flash"
      aria-label={t("USB 烧录", "USB flashing")}
    >
      <div className="ffl-heading">
        <div>
          <span className="ffl-kicker">ESP32-S3 / USB</span>
          <h3>{t("把程序写入折叠机器人", "Write the program to FoldBot")}</h3>
        </div>
        <span className="ffl-status">
          {isPublicDemo
            ? t("分享演示 · 无设备访问", "Public demo · no device access")
            : t(...phaseLabels[snapshot.phase])}
        </span>
      </div>
      <p>
        {t(
          "连接 USB 后，从浏览器选择开发板串口。先核对编译文件、芯片和分区，再明确开始写入。",
          "Connect USB and select the board serial port in the browser. Check build files, chip and partitions before explicitly starting a write.",
        )}
      </p>
      {isPublicDemo ? (
        <div className="ffl-notice">
          {t(
            "演示接口：COM3（示例，未连接）。分享页不会弹出串口授权、烧录程序或控制实物。",
            "Demo interface: COM3 (example, disconnected). Public pages do not request serial permission, flash firmware or control hardware.",
          )}
        </div>
      ) : !supported ? (
        <div className="ffl-notice">
          {local
            ? t(
                "请使用桌面 Chrome／Edge 打开本机 AE，当前浏览器未提供 Web Serial。",
                "Open local AE in desktop Chrome / Edge; Web Serial is unavailable here.",
              )
            : t(
                "USB 功能只在本机 AE 的 localhost／127.0.0.1 页面开放。",
                "USB features are available only on local AE at localhost / 127.0.0.1.",
              )}
        </div>
      ) : !props.current ? (
        <div className="ffl-notice">
          {t(
            "先完成前面的需求和接线核对，并生成当前版本工程。",
            "Review requirements and wiring, then generate the current project revision.",
          )}
        </div>
      ) : null}
      <div className="ffl-files">
        <label>
          {t("1. 构建清单 .json", "1. Build manifest .json")}
          <input
            disabled={!available || busy || checking}
            type="file"
            accept=".json,application/json"
            onChange={(event) =>
              changeFile("manifest", event.target.files?.[0] ?? null)
            }
          />
          {manifest && <small>{manifest.name}</small>}
        </label>
        <label>
          {t("2. 应用固件 .bin", "2. Application .bin")}
          <input
            disabled={!available || busy || checking}
            type="file"
            accept=".bin"
            onChange={(event) =>
              changeFile("app", event.target.files?.[0] ?? null)
            }
          />
          {app && <small>{app.name}</small>}
        </label>
        <label>
          {t("3. 同次构建的分区表 .bin", "3. Matching partition-table .bin")}
          <input
            disabled={!available || busy || checking}
            type="file"
            accept=".bin"
            onChange={(event) =>
              changeFile("partitions", event.target.files?.[0] ?? null)
            }
          />
          {partitions && <small>{partitions.name}</small>}
        </label>
      </div>
      <div className="ffl-actions">
        <button
          type="button"
          disabled={!props.current || !props.sourceHash || busy}
          onClick={() => {
            try {
              saveText(
                "foldbot-flash-manifest.template.json",
                JSON.stringify(flashManifestTemplate(props), null, 2),
              );
            } catch (cause) {
              setError(
                cause instanceof Error ? cause.message : "invalid_manifest",
              );
            }
          }}
        >
          {t("下载清单模板", "Download manifest template")}
        </button>
        <button
          type="button"
          disabled={
            !available || !manifest || !app || !partitions || busy || checking
          }
          onClick={() => void verifyFiles()}
        >
          {checking
            ? t("校验中…", "Checking…")
            : t("核对编译文件", "Check build files")}
        </button>
      </div>
      <details className="ffl-help">
        <summary>
          {t(
            "没有构建清单？从选中的两个文件整理",
            "No manifest? Prepare one from your two selected files",
          )}
        </summary>
        <p>
          {t(
            "填写同次编译的三项信息，文件哈希、大小和应用偏移由 AE 自动计算。构建来源仍由你核对。",
            "Enter three details from that build. AE calculates file hashes, sizes and app offset. You still verify the build origin.",
          )}
        </p>
        <div className="ffl-build-fields">
          <label>
            {t("固件中的版本字符串", "Firmware build string")}
            <input
              value={buildName}
              disabled={!available || busy || checking}
              onChange={(event) => {
                setBuildName(event.target.value);
                setBundle(null);
              }}
              placeholder="firmwareBuild"
              maxLength={160}
            />
          </label>
          <label>
            {t("编译日志中的完整 FQBN", "Full FQBN from build log")}
            <input
              value={fqbn}
              disabled={!available || busy || checking}
              onChange={(event) => {
                setFqbn(event.target.value);
                setBundle(null);
              }}
              placeholder="esp32:esp32:esp32s3:…"
              maxLength={400}
            />
          </label>
          <label>
            {t("实际编译时间", "Actual build time")}
            <input
              type="datetime-local"
              value={compiledAt}
              disabled={!available || busy || checking}
              onChange={(event) => {
                setCompiledAt(event.target.value);
                setBundle(null);
              }}
            />
          </label>
        </div>
        <button
          type="button"
          disabled={
            !available ||
            !app ||
            !partitions ||
            !buildName.trim() ||
            !fqbn.trim() ||
            !compiledAt ||
            busy ||
            checking
          }
          onClick={() => void prepareManifest()}
        >
          {t("整理并下载清单", "Prepare and download manifest")}
        </button>
      </details>
      {bundle && (
        <div className="ffl-summary">
          <strong>
            {t(
              "文件校验通过 · 构建来源由你提供",
              "Files checked · build origin supplied by you",
            )}
          </strong>
          <dl>
            <dt>{t("固件版本", "Firmware build")}</dt>
            <dd>{bundle.manifest.firmware_build}</dd>
            <dt>{t("编译目标", "Build target")}</dt>
            <dd>{bundle.manifest.fqbn}</dd>
            <dt>{t("写入范围", "Write range")}</dt>
            <dd>
              0x{bundle.manifest.app.offset.toString(16)} ·{" "}
              {bundle.manifest.app.size.toLocaleString()} bytes
            </dd>
            <dt>SHA-256</dt>
            <dd>{bundle.manifest.app.sha256}</dd>
          </dl>
          <p>
            {t(
              "哈希仅证明所选文件与清单一致，不证明编译过程、板型兼容或动作已验收。",
              "Hashes match the selected files to the manifest; they do not prove the build process, board compatibility or physical acceptance.",
            )}
          </p>
        </div>
      )}
      <label className="ffl-check">
        <input
          type="checkbox"
          checked={isolated}
          disabled={!available || busy}
          onChange={(event) => setIsolated(event.target.checked)}
        />
        {t(
          "执行器动力已断开；其他网页、ROS 和串口工具已关闭；已核对板型与 N16R8 引脚兼容问题。连接烧录器可能复位开发板。",
          "Actuator power is disconnected; other web, ROS and serial controllers are closed; board identity and N16R8 pin compatibility are reviewed. Connecting the flasher may reset the board.",
        )}
      </label>
      <div className="ffl-actions">
        <button
          type="button"
          disabled={!available || busy || checking}
          onClick={() => void run(() => controller.current!.selectPort())}
        >
          {t("选择 USB 串口", "Select USB serial port")}
        </button>
        <button
          type="button"
          disabled={
            !available ||
            !bundle ||
            !isolated ||
            snapshot.phase !== "selected" ||
            checking
          }
          onClick={() =>
            void run(() => controller.current!.connect(bundle!, isolated))
          }
        >
          {t("连接并核对板卡", "Connect and check board")}
        </button>
        <span className="ffl-port">
          {snapshot.portLabel ??
            (isPublicDemo
              ? "COM3 · demo"
              : t(
                  "等待选择；COM 名称以浏览器弹窗为准",
                  "Choose a port; its COM name is shown by the browser",
                ))}
        </span>
      </div>
      <label className="ffl-check">
        <input
          type="checkbox"
          checked={writeConfirmed}
          disabled={snapshot.phase !== "ready"}
          onChange={(event) => setWriteConfirmed(event.target.checked)}
        />
        {t(
          "我已核对当前工程版本和应用文件，确认替换应用程序；保留现有分区、NVS 和标定，不整片擦除。",
          "I reviewed the current project and application file and confirm replacing the application, preserving partitions, NVS and calibration without a full erase.",
        )}
      </label>
      <div className="ffl-actions">
        <button
          className="ffl-primary"
          type="button"
          disabled={!available || snapshot.phase !== "ready" || !writeConfirmed}
          onClick={() =>
            void run(() => controller.current!.write(writeConfirmed))
          }
        >
          {t("开始 USB 烧录", "Start USB flash")}
        </button>
        <button
          type="button"
          disabled={!local || (!busy && !snapshot.portLabel)}
          onClick={() => {
            setWriteConfirmed(false);
            setIsolated(false);
            void controller.current?.cancel();
          }}
        >
          {t("断开串口", "Disconnect serial")}
        </button>
      </div>
      {(busy || snapshot.phase === "verified") && (
        <div className="ffl-progress">
          <progress value={snapshot.progress} max={100} />
          <span>
            {snapshot.progress}% · {t(...phaseLabels[snapshot.phase])}
          </span>
        </div>
      )}
      {busy && (
        <p className="ffl-note">
          {t(
            "请保持页面前台。关闭、切换或隐藏页面会中止会话，可能留下不完整固件，需要重新核对。",
            "Keep this page in the foreground. Closing, switching or hiding it ends the session and may leave incomplete firmware requiring rechecking.",
          )}
        </p>
      )}
      {explanation && (
        <div className="ffl-error" role="alert">
          {explanation}
        </div>
      )}
      <details className="ffl-help">
        <summary>
          {t(
            "没有编译文件？查看准备步骤",
            "No build files? View preparation steps",
          )}
        </summary>
        <ol>
          <li>
            {t(
              "下载本次生成的完整 FoldBot 工程，保留 .ino、web_ui.h 和配置头文件。",
              "Download this complete FoldBot project, keeping .ino, web_ui.h and the configuration header.",
            )}
          </li>
          <li>
            {t(
              "在本地配置私有热点密码；用 Arduino IDE 核对 ESP32-S3 板型、Flash、PSRAM、USB 和分区选项，再导出编译后的二进制文件。旧 9 月构建不可当作当前版本。",
              "Set the private hotspot password locally. Confirm ESP32-S3 board, flash, PSRAM, USB and partition options in Arduino IDE, then export compiled binaries. Older September builds are not current artifacts.",
            )}
          </li>
          <li>
            {t(
              "从同一次构建选择应用 .bin 和 .partitions.bin。填写清单中的实际编译时间、FQBN、固件版本、文件大小、SHA-256 和应用分区偏移。模板的项目与修订信息已经绑定，不能用占位值烧录。",
              "Select application .bin and .partitions.bin from the same build. Fill in actual build time, FQBN, firmware version, file sizes, SHA-256 and app offset. Project and revision fields are already bound; placeholders cannot be flashed.",
            )}
          </li>
          <li>
            {t(
              "此入口只更新已有、匹配分区的单应用固件。空白板、分区迁移、加密板和多 OTA 槽位暂需专门安装流程。写后不自动启动程序；恢复供电、读版本及控制实物另行确认。",
              "This entry updates an existing single app with matching partitions. Blank boards, partition migration, encrypted boards and multi-slot OTA require a separate install workflow. Firmware is not automatically started; restoring power, checking its version and physical control are separate steps.",
            )}
          </li>
        </ol>
        <p>
          {t(
            "ROS 程序部署到本机或 Jetson。ROS 的串口参数用于通信；通过此处烧录的是 ESP32 固件。",
            "ROS programs are deployed to the host or Jetson. ROS serial settings configure communication; this uploader flashes ESP32 firmware.",
          )}
        </p>
      </details>
      <p className="ffl-muted">
        {t(
          "USB 烧录基于 Espressif esptool-js 0.7.0。",
          "USB flashing uses Espressif esptool-js 0.7.0.",
        )}{" "}
        <a
          href={`${import.meta.env.BASE_URL}esptool-js-LICENSE.txt`}
          target="_blank"
          rel="noreferrer"
        >
          Apache-2.0
        </a>
      </p>
      {snapshot.logs.length > 0 && (
        <details className="ffl-help">
          <summary>{t("USB 操作日志", "USB operation log")}</summary>
          <pre>{snapshot.logs.join("\n")}</pre>
          <button
            type="button"
            onClick={() =>
              saveText(
                "foldbot-usb-flash-log.json",
                JSON.stringify(
                  {
                    project_id: props.projectId,
                    revision: props.revision,
                    generation_id: props.generationId,
                    imported_manifest: bundle?.manifest ?? null,
                    phase: snapshot.phase,
                    byte_readback_verified: snapshot.phase === "verified",
                    firmware_execution_verified: false,
                    physical_verified: false,
                    exported_at: new Date().toISOString(),
                    logs: snapshot.logs,
                  },
                  null,
                  2,
                ),
              )
            }
          >
            {t("下载日志", "Download log")}
          </button>
        </details>
      )}
    </section>
  );
}
