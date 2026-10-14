/** Explicit local USB application update. Import validation never proves a build or physical operation. */
export interface FlashBinding {
  projectId: string | null;
  revision: number | null;
  generationId: string | null;
  sourceHash: string | null;
  current: boolean;
}
export interface FlashManifest {
  schema_version: 1;
  origin: "user_imported_build";
  project_id: string;
  revision: number;
  generation_id: string;
  source_hash: string;
  expected_chip: "ESP32-S3";
  firmware_build: string;
  fqbn: string;
  compiled_at: string;
  app: { filename: string; sha256: string; offset: number; size: number };
  partition_table: {
    filename: string;
    sha256: string;
    offset: number;
    size: number;
  };
}
export interface FlashBundle {
  manifest: FlashManifest;
  app: Uint8Array;
  partitions: Uint8Array;
}
export interface Partition {
  type: number;
  subtype: number;
  offset: number;
  size: number;
  name: string;
}
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9_-]{1,100}$/;
const MAX_FLASH = 16 * 1024 * 1024;
const fail = (code: string): never => {
  throw new Error(code);
};
const object = (
  value: unknown,
  fields: string[],
  code: string,
): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail(code);
  const item = value as Record<string, unknown>;
  if (Object.keys(item).sort().join("|") !== [...fields].sort().join("|"))
    return fail(code);
  return item;
};
const integer = (value: unknown, min: number, max: number) =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= min &&
  value <= max;
export function bindingKey(binding: FlashBinding): string {
  return JSON.stringify([
    binding.projectId,
    binding.revision,
    binding.generationId,
    binding.sourceHash,
    binding.current,
  ]);
}
export function requireFlashBinding(binding: FlashBinding): void {
  if (
    !binding.current ||
    !ID.test(binding.projectId ?? "") ||
    !ID.test(binding.generationId ?? "") ||
    !integer(binding.revision, 1, Number.MAX_SAFE_INTEGER) ||
    !HASH.test(binding.sourceHash ?? "")
  )
    fail("current_generation_required");
}
export function requireLocalFlash(
  publicMode: boolean,
  origin: string,
  secure: boolean,
): void {
  if (publicMode) fail("public_preview_only");
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return fail("local_origin_required");
  }
  if (
    !secure ||
    !["http:", "https:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password
  )
    fail("local_origin_required");
}
export function parseFlashManifest(
  value: unknown,
  binding: FlashBinding,
): FlashManifest {
  requireFlashBinding(binding);
  const data = object(
    value,
    [
      "schema_version",
      "origin",
      "project_id",
      "revision",
      "generation_id",
      "source_hash",
      "expected_chip",
      "firmware_build",
      "fqbn",
      "compiled_at",
      "app",
      "partition_table",
    ],
    "invalid_manifest",
  );
  if (
    data.schema_version !== 1 ||
    data.origin !== "user_imported_build" ||
    data.expected_chip !== "ESP32-S3"
  )
    fail("unsupported_flash_profile");
  if (
    data.project_id !== binding.projectId ||
    data.revision !== binding.revision ||
    data.generation_id !== binding.generationId ||
    data.source_hash !== binding.sourceHash
  )
    fail("stale_flash_artifact");
  if (
    typeof data.firmware_build !== "string" ||
    data.firmware_build.length < 1 ||
    data.firmware_build.length > 160 ||
    /[\x00-\x1f]/.test(data.firmware_build)
  )
    fail("invalid_manifest");
  if (
    typeof data.fqbn !== "string" ||
    !/^esp32:esp32:esp32s3(?::[a-zA-Z0-9_=,.-]+)?$/.test(data.fqbn) ||
    data.fqbn.length > 400
  )
    fail("wrong_chip");
  if (
    typeof data.compiled_at !== "string" ||
    data.compiled_at.length > 50 ||
    !Number.isFinite(Date.parse(data.compiled_at))
  )
    fail("invalid_manifest");
  for (const key of ["app", "partition_table"] as const) {
    const file = object(
      data[key],
      ["filename", "sha256", "offset", "size"],
      "invalid_manifest",
    );
    if (
      typeof file.filename !== "string" ||
      !/^[^\\/\x00-\x1f]{1,150}\.bin$/.test(file.filename) ||
      typeof file.sha256 !== "string" ||
      !HASH.test(file.sha256)
    )
      fail("invalid_manifest");
    if (
      !integer(file.offset, 0x1000, MAX_FLASH) ||
      !integer(file.size, 32, MAX_FLASH)
    )
      fail("invalid_manifest");
  }
  const manifest = data as unknown as FlashManifest;
  if (
    manifest.partition_table.offset !== 0x8000 ||
    ![0xc00, 0x1000].includes(manifest.partition_table.size)
  )
    fail("unsupported_partition_layout");
  if (
    manifest.app.offset < 0x10000 ||
    manifest.app.offset % 0x10000 !== 0 ||
    manifest.app.size < 256 ||
    manifest.app.size + manifest.app.offset > MAX_FLASH ||
    /(?:merged|bootloader|partitions)/i.test(manifest.app.filename)
  )
    fail("app_only_required");
  return structuredClone(manifest);
}
export async function flashSha256(bytes: Uint8Array): Promise<string> {
  return Array.from(
    new Uint8Array(
      await globalThis.crypto.subtle.digest(
        "SHA-256",
        new Uint8Array(bytes).buffer,
      ),
    ),
  )
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}
/** All entries are validated; only one application slot is supported so no OTA selection is changed. */
export function parsePartitionTable(bytes: Uint8Array): Partition[] {
  if (![0xc00, 0x1000].includes(bytes.length)) fail("invalid_partition_table");
  const result: Partition[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let terminated = false;
  for (let offset = 0; offset < 0xc00; offset += 32) {
    const magic = view.getUint16(offset, true);
    if (magic === 0xffff || magic === 0xebeb) {
      terminated = true;
      break;
    }
    if (magic !== 0x50aa) fail("invalid_partition_table");
    const part = {
      type: bytes[offset + 2],
      subtype: bytes[offset + 3],
      offset: view.getUint32(offset + 4, true),
      size: view.getUint32(offset + 8, true),
      name: new TextDecoder()
        .decode(bytes.slice(offset + 12, offset + 28))
        .replace(/\0.*$/s, ""),
    };
    if (
      part.offset < 0x9000 ||
      part.offset % 0x1000 !== 0 ||
      part.size === 0 ||
      part.size % 0x1000 !== 0 ||
      part.offset + part.size > MAX_FLASH ||
      view.getUint32(offset + 28, true) !== 0
    )
      fail("unsupported_partition_layout");
    if (
      result.some(
        (other) =>
          part.offset < other.offset + other.size &&
          other.offset < part.offset + part.size,
      )
    )
      fail("overlapping_partitions");
    result.push(part);
  }
  if (
    !terminated ||
    !result.some((item) => item.type === 1 && item.subtype === 2)
  )
    fail("nvs_partition_required");
  const apps = result.filter((item) => item.type === 0);
  if (
    apps.length !== 1 ||
    ![0, 0x10].includes(apps[0].subtype) ||
    apps[0].offset % 0x10000 !== 0
  )
    fail("single_app_partition_required");
  return result;
}
export async function validateFlashBundle(
  value: unknown,
  app: Uint8Array,
  partitions: Uint8Array,
  binding: FlashBinding,
): Promise<FlashBundle> {
  const manifest = parseFlashManifest(value, binding);
  if (
    app.length !== manifest.app.size ||
    partitions.length !== manifest.partition_table.size
  )
    fail("artifact_size_mismatch");
  const appView = new DataView(app.buffer, app.byteOffset, app.byteLength);
  // ESP32-S3 image id 9 and ESP-IDF app descriptor: prevents bootloader or merged images being treated as an app.
  if (
    app[0] !== 0xe9 ||
    app[1] < 1 ||
    app[1] > 16 ||
    appView.getUint16(12, true) !== 9 ||
    appView.getUint32(32, true) !== 0xabcd5432
  )
    fail("invalid_s3_application");
  const table = parsePartitionTable(partitions);
  const target = table.find((item) => item.type === 0)!;
  if (
    target.offset !== manifest.app.offset ||
    Math.ceil(app.length / 0x1000) * 0x1000 > target.size
  )
    fail("app_outside_partition");
  const [appHash, partitionHash] = await Promise.all([
    flashSha256(app),
    flashSha256(partitions),
  ]);
  if (
    appHash !== manifest.app.sha256 ||
    partitionHash !== manifest.partition_table.sha256
  )
    fail("artifact_hash_mismatch");
  return {
    manifest,
    app: new Uint8Array(app),
    partitions: new Uint8Array(partitions),
  };
}
export function flashManifestTemplate(binding: FlashBinding) {
  requireFlashBinding(binding);
  return {
    schema_version: 1,
    origin: "user_imported_build",
    project_id: binding.projectId,
    revision: binding.revision,
    generation_id: binding.generationId,
    source_hash: binding.sourceHash,
    expected_chip: "ESP32-S3",
    firmware_build: "FILL_FROM_CURRENT_SOURCE",
    fqbn: "FILL_FROM_CONFIRMED_BUILD",
    compiled_at: "FILL_ACTUAL_BUILD_TIME_ISO8601",
    app: {
      filename: "foldbot.ino.bin",
      sha256: "FILL_SHA256",
      offset: null,
      size: null,
    },
    partition_table: {
      filename: "foldbot.ino.partitions.bin",
      sha256: "FILL_SHA256",
      offset: 32768,
      size: null,
    },
  };
}
/** Convenience metadata is calculated from imported bytes; build provenance remains a user assertion. */
export async function prepareImportedFlashBundle(options: {
  binding: FlashBinding;
  appName: string;
  app: Uint8Array;
  partitionName: string;
  partitions: Uint8Array;
  firmwareBuild: string;
  fqbn: string;
  compiledAt: string;
}): Promise<FlashBundle> {
  const appPartition = parsePartitionTable(options.partitions).find(
    (partition) => partition.type === 0,
  )!;
  const manifest = {
    ...flashManifestTemplate(options.binding),
    firmware_build: options.firmwareBuild.trim(),
    fqbn: options.fqbn.trim(),
    compiled_at: options.compiledAt,
    app: {
      filename: options.appName,
      offset: appPartition.offset,
      size: options.app.length,
      sha256: await flashSha256(options.app),
    },
    partition_table: {
      filename: options.partitionName,
      offset: 0x8000,
      size: options.partitions.length,
      sha256: await flashSha256(options.partitions),
    },
  };
  return validateFlashBundle(
    manifest,
    options.app,
    options.partitions,
    options.binding,
  );
}

export interface FlashLeaseApi {
  reserve(binding: FlashBinding): Promise<string>;
  heartbeat(id: string): Promise<void>;
  release(id: string): Promise<void>;
}
export function createFlashLeaseApi(
  fetcher: typeof fetch = fetch,
): FlashLeaseApi {
  async function post(path: string, body: object) {
    const response = await fetcher(`/api/foldbot/flash/${path}`, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: path === "stop",
    });
    if (!response.ok)
      fail(
        response.status === 409
          ? "control_busy_or_stale"
          : "flash_lease_unavailable",
      );
    return response.json();
  }
  return {
    async reserve(binding) {
      const result = await post("sessions", {
        project_id: binding.projectId,
        revision: binding.revision,
        generation_id: binding.generationId,
        source_hash: binding.sourceHash,
      });
      if (typeof result.session_id !== "string" || !result.session_id)
        fail("flash_lease_unavailable");
      return result.session_id;
    },
    async heartbeat(id) {
      const result = await post("heartbeat", { session_id: id });
      if (result.ok !== true) fail("flash_lease_lost");
    },
    async release(id) {
      await post("stop", { session_id: id });
    },
  };
}
export interface FlashPort {
  getInfo(): { usbVendorId?: number; usbProductId?: number };
}
export interface FlashLoader {
  main(): Promise<string>;
  chip: { CHIP_NAME: string };
  secureDownloadMode?: boolean;
  getSecurityInfo(): Promise<{
    flashCryptCnt: number;
    parsedFlags: { SECURE_BOOT_EN: boolean; SECURE_DOWNLOAD_ENABLE: boolean };
  }>;
  detectFlashSize(): Promise<string | undefined>;
  readFlash(offset: number, size: number): Promise<Uint8Array>;
  writeFlash(options: {
    fileArray: { data: Uint8Array; address: number }[];
    eraseAll: false;
    flashMode: "keep";
    flashFreq: "keep";
    flashSize: "keep";
    compress: true;
    reportProgress: (index: number, written: number, total: number) => void;
  }): Promise<void>;
}
export type FlashDriver = {
  loader: FlashLoader;
  cancel?(): void;
  disconnect(): Promise<void>;
};
export type FlashPhase =
  | "idle"
  | "selected"
  | "connecting"
  | "ready"
  | "writing"
  | "verifying"
  | "verified"
  | "closing"
  | "cleanup-required"
  | "failed";
export interface FlashSnapshot {
  phase: FlashPhase;
  progress: number;
  error: string | null;
  portLabel: string | null;
  chip: string | null;
  logs: string[];
}
export const initialFlashSnapshot = (): FlashSnapshot => ({
  phase: "idle",
  progress: 0,
  error: null,
  portLabel: null,
  chip: null,
  logs: [],
});
export function flashSessionBusy(phase: FlashPhase) {
  return [
    "connecting",
    "ready",
    "writing",
    "verifying",
    "closing",
    "cleanup-required",
  ].includes(phase);
}
export interface FlashSessionOptions {
  publicMode: boolean;
  origin: string;
  secure: boolean;
  binding: () => FlashBinding;
  requestPort: () => Promise<FlashPort>;
  lease: FlashLeaseApi;
  driver: (
    port: FlashPort,
    log: (message: string) => void,
  ) => Promise<FlashDriver>;
  notify: (value: FlashSnapshot) => void;
  heartbeatMs?: number;
}
export class FoldBotFlashSession {
  private options: FlashSessionOptions;
  private value = initialFlashSnapshot();
  private port: FlashPort | null = null;
  private bundle: FlashBundle | null = null;
  private driver: FlashDriver | null = null;
  private lease: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private version = 0;
  private locked = false;
  private boundKey = "";
  private closing: Promise<void> | null = null;
  private pendingLoader = new Set<Promise<unknown>>();
  constructor(options: FlashSessionOptions) {
    this.options = options;
  }
  private emit(values: Partial<FlashSnapshot>) {
    this.value = { ...this.value, ...values };
    this.options.notify({ ...this.value, logs: [...this.value.logs] });
  }
  private guard(version?: number) {
    requireLocalFlash(
      this.options.publicMode,
      this.options.origin,
      this.options.secure,
    );
    requireFlashBinding(this.options.binding());
    if (
      version !== undefined &&
      (this.version !== version ||
        this.boundKey !== bindingKey(this.options.binding()))
    )
      fail("flash_session_revoked");
  }
  private log(message: string) {
    const safe = message
      .replace(/(?:[0-9a-f]{2}:){5}[0-9a-f]{2}/gi, "[device address]")
      .slice(0, 300);
    this.emit({ logs: [...this.value.logs, safe].slice(-120) });
  }
  private async loaderWork<T>(operation: () => Promise<T>): Promise<T> {
    const pending = operation();
    this.pendingLoader.add(pending);
    try {
      return await pending;
    } finally {
      this.pendingLoader.delete(pending);
    }
  }
  async selectPort(): Promise<void> {
    this.guard();
    if (this.locked || flashSessionBusy(this.value.phase)) fail("flash_busy");
    const version = ++this.version;
    this.boundKey = bindingKey(this.options.binding());
    this.locked = true;
    try {
      // Must be the first awaited operation after the operator click: retains transient browser activation.
      const port = await this.options.requestPort();
      this.guard(version);
      this.port = port;
      const info = port.getInfo();
      const hex = (value: number | undefined) =>
        value === undefined ? "—" : value.toString(16).padStart(4, "0");
      this.emit({
        phase: "selected",
        error: null,
        portLabel: `USB VID ${hex(info.usbVendorId)} / PID ${hex(info.usbProductId)}`,
      });
    } catch (error) {
      const issue =
        error instanceof Error
          ? error.name === "NotFoundError"
            ? "port_selection_cancelled"
            : error.message
          : "serial_failed";
      this.emit({ error: issue });
      // The UI also handles this rejection. Return the same stable code emitted
      // in the snapshot so a browser-localized DOMException cannot mask it.
      throw new Error(issue);
    } finally {
      this.locked = false;
    }
  }
  async connect(bundle: FlashBundle, confirmed: boolean): Promise<void> {
    this.guard();
    if (!confirmed) fail("hardware_isolation_required");
    if (this.locked || flashSessionBusy(this.value.phase)) fail("flash_busy");
    if (!this.port) fail("select_port_first");
    const version = ++this.version;
    this.boundKey = bindingKey(this.options.binding());
    this.locked = true;
    this.emit({
      phase: "connecting",
      error: null,
      progress: 0,
      chip: null,
      logs: [],
    });
    try {
      this.bundle = await validateFlashBundle(
        bundle.manifest,
        bundle.app,
        bundle.partitions,
        this.options.binding(),
      );
      this.guard(version);
      const lease = await this.options.lease.reserve(this.options.binding());
      if (version !== this.version) {
        await this.options.lease.release(lease);
        fail("flash_session_revoked");
      }
      this.lease = lease;
      this.guard(version);
      let heartbeatPending = false;
      this.timer = setInterval(() => {
        if (
          heartbeatPending ||
          this.version !== version ||
          this.lease !== lease
        )
          return;
        heartbeatPending = true;
        void this.options.lease
          .heartbeat(lease)
          .catch(() => {
            if (this.version === version && this.lease === lease)
              return this.cancel("flash_lease_lost");
          })
          .finally(() => {
            heartbeatPending = false;
          });
      }, this.options.heartbeatMs ?? 2000);
      const driver = await this.options.driver(this.port!, (message) => {
        if (this.version === version) this.log(message);
      });
      if (version !== this.version) {
        await driver.disconnect().catch(() => {});
        fail("flash_session_revoked");
      }
      this.driver = driver;
      this.guard(version);
      await this.loaderWork(() => driver.loader.main());
      this.guard(version);
      if (
        driver.loader.chip.CHIP_NAME !== "ESP32-S3" ||
        driver.loader.secureDownloadMode
      )
        fail("wrong_chip_or_secure_device");
      const security = await this.loaderWork(() =>
        driver.loader.getSecurityInfo(),
      );
      this.guard(version);
      if (
        security.parsedFlags.SECURE_BOOT_EN !== false ||
        security.parsedFlags.SECURE_DOWNLOAD_ENABLE !== false ||
        !Number.isSafeInteger(security.flashCryptCnt) ||
        security.flashCryptCnt < 0 ||
        security.flashCryptCnt.toString(2).replace(/0/g, "").length % 2 !== 0
      )
        fail("encrypted_or_secure_device");
      const capacity = await this.loaderWork(() =>
        driver.loader.detectFlashSize(),
      );
      this.guard(version);
      const megabytes = /^(\d+)MB$/.exec(capacity ?? "");
      const end = Math.max(
        ...parsePartitionTable(this.bundle.partitions).map(
          (part) => part.offset + part.size,
        ),
      );
      if (!megabytes || Number(megabytes[1]) * 1024 * 1024 < end)
        fail("flash_size_mismatch");
      await this.verifyPartition(version);
      this.guard(version);
      await this.options.lease.heartbeat(lease);
      this.guard(version);
      this.emit({ phase: "ready", chip: "ESP32-S3" });
      this.log("ROM connected; partition table matched. No firmware written.");
    } catch (error) {
      await this.failed(error, version);
      throw error;
    } finally {
      this.locked = false;
    }
  }
  private async verifyPartition(version: number) {
    const manifest = this.bundle!.manifest;
    const live = await this.loaderWork(() =>
      this.driver!.loader.readFlash(
        manifest.partition_table.offset,
        manifest.partition_table.size,
      ),
    );
    this.guard(version);
    if (
      live.length !== this.bundle!.partitions.length ||
      (await flashSha256(live)) !== manifest.partition_table.sha256
    )
      fail("live_partition_mismatch");
    this.guard(version);
  }
  async write(confirmed: boolean): Promise<void> {
    try {
      this.guard(this.version);
    } catch (error) {
      await this.cancel("generation_changed");
      throw error;
    }
    if (!confirmed) fail("write_confirmation_required");
    if (
      this.locked ||
      this.value.phase !== "ready" ||
      !this.driver ||
      !this.bundle ||
      !this.lease
    )
      fail("connect_and_verify_first");
    const version = this.version;
    this.guard(version);
    this.locked = true;
    const driver = this.driver!,
      source = this.bundle!,
      lease = this.lease!;
    try {
      await this.options.lease.heartbeat(lease);
      this.guard(version);
      await this.verifyPartition(version);
      this.guard(version);
      const bundle = await validateFlashBundle(
        source.manifest,
        source.app,
        source.partitions,
        this.options.binding(),
      );
      this.guard(version);
      this.emit({ phase: "writing", progress: 0 });
      await this.loaderWork(() =>
        driver.loader.writeFlash({
          fileArray: [
            { data: bundle.app, address: bundle.manifest.app.offset },
          ],
          eraseAll: false,
          flashMode: "keep",
          flashFreq: "keep",
          flashSize: "keep",
          compress: true,
          reportProgress: (_index, written, total) => {
            this.guard(version);
            this.emit({
              progress:
                total > 0
                  ? Math.min(95, Math.round((written / total) * 95))
                  : 0,
            });
          },
        }),
      );
      this.guard(version);
      this.emit({ phase: "verifying", progress: 95 });
      const readback = await this.loaderWork(() =>
        driver.loader.readFlash(bundle.manifest.app.offset, bundle.app.length),
      );
      this.guard(version);
      if (
        readback.length !== bundle.app.length ||
        (await flashSha256(readback)) !== bundle.manifest.app.sha256
      )
        fail("write_readback_mismatch");
      this.guard(version);
      // No loader.after()/hard_reset: firmware execution remains a separate physical step.
      await this.cleanup();
      this.guard(version);
      this.emit({ phase: "verified", progress: 100 });
      this.log(
        "Application bytes verified. No automatic firmware reset/run; physical behavior is unverified.",
      );
    } catch (error) {
      await this.failed(error, version);
      throw error;
    } finally {
      this.locked = false;
    }
  }
  private async cleanup() {
    if (this.closing) return this.closing;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const driver = this.driver;
    const lease = this.lease;
    driver?.cancel?.();
    this.closing = (async () => {
      // Do not release the backend exclusion while the serial transport may still be writing.
      if (driver) {
        // First close interrupts reads. Loader retry loops must also settle before
        // the final close and releasing ownership; a late open is never allowed.
        await driver.disconnect().catch(() => {});
        await Promise.allSettled([...this.pendingLoader]);
        await driver.disconnect();
        if (this.driver === driver) this.driver = null;
      }
      if (lease) {
        await this.options.lease.release(lease);
        if (this.lease === lease) this.lease = null;
      }
    })();
    try {
      await this.closing;
    } finally {
      this.closing = null;
    }
  }
  private async failed(error: unknown, version: number) {
    let message = error instanceof Error ? error.message : "serial_failed";
    try {
      await this.cleanup();
    } catch {
      message = "serial_cleanup_uncertain";
      this.log(
        "Serial cleanup uncertain; reconnect and physical verification are required.",
      );
    }
    if (version === this.version)
      this.emit({
        phase:
          message === "serial_cleanup_uncertain"
            ? "cleanup-required"
            : "failed",
        error: message,
      });
  }
  async cancel(reason = "operator_disconnected"): Promise<void> {
    if (["writing", "verifying"].includes(this.value.phase))
      reason = "write_interrupted_outcome_unknown";
    ++this.version;
    this.port = null;
    this.bundle = null;
    this.emit({ phase: "closing", error: reason });
    try {
      await this.cleanup();
      this.emit({ phase: "idle", progress: 0, portLabel: null, chip: null });
    } catch {
      this.emit({
        phase: "cleanup-required",
        error: "serial_cleanup_uncertain",
      });
    }
  }
}

type NativeFlashPort = ConstructorParameters<
  typeof import("esptool-js").Transport
>[0];
/** Permanently revoke every physical open, signal and write path, including library retries. */
export function createFlashPortFence(device: NativeFlashPort) {
  let revoked = false;
  let opened = false;
  const pending = new Set<Promise<unknown>>();
  const guard = () => {
    if (revoked) fail("flash_session_revoked");
  };
  const track = async <T>(operation: Promise<T>): Promise<T> => {
    pending.add(operation);
    try {
      return await operation;
    } finally {
      pending.delete(operation);
    }
  };
  const settle = async () => {
    while (pending.size) await Promise.allSettled([...pending]);
  };
  const port = new Proxy(device, {
    get(target, property) {
      if (property === "open")
        return async (...args: Parameters<NativeFlashPort["open"]>) => {
          guard();
          await track(
            target.open(...args).then(() => {
              opened = true;
            }),
          );
          guard();
        };
      if (property === "close")
        return async () => {
          await settle();
          if (opened || target.readable || target.writable)
            await target.close();
          opened = false;
        };
      if (property === "setSignals" || property === "setBaudRate") {
        const method = Reflect.get(target, property, target);
        if (typeof method !== "function") return method;
        return async (...args: unknown[]) => {
          guard();
          const result = await track(
            Promise.resolve(method.apply(target, args)),
          );
          guard();
          return result;
        };
      }
      if (property === "writable") {
        const stream = target.writable;
        if (!stream) return stream;
        return new Proxy(stream, {
          get(output, key) {
            if (key === "getWriter")
              return () => {
                guard();
                const writer = output.getWriter();
                return new Proxy(writer, {
                  get(raw, name) {
                    if (name === "write")
                      return async (data: Uint8Array) => {
                        guard();
                        await track(raw.write(data));
                        guard();
                      };
                    const item = Reflect.get(raw, name, raw);
                    return typeof item === "function" ? item.bind(raw) : item;
                  },
                });
              };
            const item = Reflect.get(output, key, output);
            return typeof item === "function" ? item.bind(output) : item;
          },
        });
      }
      const item = Reflect.get(target, property, target);
      return typeof item === "function" ? item.bind(target) : item;
    },
  });
  return {
    port,
    cancel: () => {
      revoked = true;
    },
    settle,
  };
}

export async function createEspressifDriver(
  port: FlashPort,
  log: (message: string) => void,
): Promise<FlashDriver> {
  const { ESPLoader, Transport } = await import("esptool-js");
  const fence = createFlashPortFence(port as NativeFlashPort);
  const transport = new Transport(fence.port, false);
  // Upstream write() releases the writer only on success. Always release it on
  // disconnect/write errors so final close can prove the port is no longer active.
  transport.write = async (data: Uint8Array) => {
    const writer = fence.port.writable?.getWriter();
    if (!writer) fail("serial_failed");
    try {
      await writer!.write(transport.slipWriter(data));
    } finally {
      writer!.releaseLock();
    }
  };
  const loader = new ESPLoader({
    transport,
    baudrate: 115200,
    romBaudrate: 115200,
    enableTracing: false,
    debugLogging: false,
    terminal: { clean() {}, write: log, writeLine: log },
  });
  return {
    loader,
    cancel: fence.cancel,
    disconnect: async () => {
      await fence.settle();
      await transport.disconnect();
    },
  };
}
