import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  flashSha256,
  validateFlashBundle,
  parsePartitionTable,
  parseFlashManifest,
  requireLocalFlash,
  flashManifestTemplate,
  FoldBotFlashSession,
  createFlashLeaseApi,
  prepareImportedFlashBundle,
  createEspressifDriver,
  flashSessionBusy,
  createFlashPortFence,
} from "../src/foldbotFlashLogic.ts";

const binding = () => ({
  projectId: "project1",
  revision: 2,
  generationId: "generation2",
  sourceHash: "a".repeat(64),
  current: true,
});
function partitionFile(
  entries = [
    [1, 2, 0x9000, 0x5000, "nvs"],
    [1, 0, 0xe000, 0x2000, "otadata"],
    [0, 0x10, 0x10000, 0x300000, "app0"],
  ],
) {
  const data = new Uint8Array(3072).fill(255);
  const view = new DataView(data.buffer);
  entries.forEach(([type, subtype, offset, size, name], index) => {
    const i = index * 32;
    data.fill(0, i, i + 32);
    view.setUint16(i, 0x50aa, true);
    data[i + 2] = type;
    data[i + 3] = subtype;
    view.setUint32(i + 4, offset, true);
    view.setUint32(i + 8, size, true);
    data.set(new TextEncoder().encode(name), i + 12);
  });
  return data;
}
async function fixture() {
  const app = new Uint8Array(256);
  const view = new DataView(app.buffer);
  app[0] = 0xe9;
  app[1] = 1;
  view.setUint16(12, 9, true);
  view.setUint32(32, 0xabcd5432, true);
  const partitions = partitionFile();
  const manifest = {
    ...flashManifestTemplate(binding()),
    firmware_build: "foldbot-current",
    fqbn: "esp32:esp32:esp32s3:FlashSize=16M,PSRAM=disabled",
    compiled_at: "2026-10-12T01:00:00Z",
    app: {
      filename: "foldbot.ino.bin",
      offset: 0x10000,
      size: app.length,
      sha256: await flashSha256(app),
    },
    partition_table: {
      filename: "foldbot.ino.partitions.bin",
      offset: 0x8000,
      size: partitions.length,
      sha256: await flashSha256(partitions),
    },
  };
  return { app, partitions, manifest };
}
async function harness(overrides = {}) {
  const bundle = await fixture();
  let currentBinding = binding();
  const snapshots = [];
  const calls = [];
  let written = false;
  const loader = {
    chip: { CHIP_NAME: "ESP32-S3" },
    main: async () => {
      calls.push("main");
      return "ESP32-S3";
    },
    getSecurityInfo: async () => ({
      flashCryptCnt: 0,
      parsedFlags: { SECURE_BOOT_EN: false, SECURE_DOWNLOAD_ENABLE: false },
    }),
    detectFlashSize: async () => "16MB",
    readFlash: async (offset, size) => {
      calls.push(["read", offset, size]);
      return new Uint8Array(
        offset === 0x8000
          ? bundle.partitions
          : written
            ? bundle.app
            : new Uint8Array(size),
      );
    },
    writeFlash: async (options) => {
      calls.push(["write", options]);
      written = true;
      options.reportProgress(0, 100, 100);
    },
    ...overrides.loader,
  };
  const session = new FoldBotFlashSession({
    publicMode: false,
    origin: "http://127.0.0.1:8877",
    secure: true,
    binding: () => currentBinding,
    heartbeatMs: 100000,
    requestPort: async () => {
      calls.push("requestPort");
      return { getInfo: () => ({ usbVendorId: 0x303a, usbProductId: 0x1001 }) };
    },
    lease: {
      reserve: async () => {
        calls.push("reserve");
        return "lease1";
      },
      heartbeat: async () => {
        calls.push("heartbeat");
      },
      release: async () => {
        calls.push("release");
      },
    },
    driver: async () => {
      calls.push("driver");
      return {
        loader,
        disconnect: async () => {
          calls.push("disconnect");
        },
      };
    },
    notify: (value) => snapshots.push(value),
    ...overrides.options,
  });
  return {
    session,
    bundle,
    calls,
    snapshots,
    loader,
    setBinding: (value) => {
      currentBinding = value;
    },
  };
}
test("current app and partition hashes validate without modifying inputs", async () => {
  const value = await fixture();
  const checked = await validateFlashBundle(
    value.manifest,
    value.app,
    value.partitions,
    binding(),
  );
  value.app[50] = 9;
  assert.equal(checked.app[50], 0);
  assert.equal(checked.manifest.origin, "user_imported_build");
});
test("manifest helper derives hashes, sizes and offset but labels provenance user imported", async () => {
  const f = await fixture();
  const result = await prepareImportedFlashBundle({
    binding: binding(),
    appName: f.manifest.app.filename,
    app: f.app,
    partitionName: f.manifest.partition_table.filename,
    partitions: f.partitions,
    firmwareBuild: "foldbot-current",
    fqbn: f.manifest.fqbn,
    compiledAt: f.manifest.compiled_at,
  });
  assert.deepEqual(result.manifest, f.manifest);
  assert.equal(result.manifest.origin, "user_imported_build");
});
test("public, remote and insecure contexts reject before port access", async () => {
  for (const options of [
    { publicMode: true },
    { origin: "https://example.com" },
    { secure: false },
    { origin: "file:///test" },
  ]) {
    const h = await harness({ options });
    await assert.rejects(h.session.selectPort());
    assert.deepEqual(h.calls, []);
  }
  assert.doesNotThrow(() =>
    requireLocalFlash(false, "http://localhost:8877", true),
  );
});
test("unknown or missing manifest fields and placeholder values reject", async () => {
  const { manifest } = await fixture();
  assert.throws(
    () => parseFlashManifest({ ...manifest, erase_all: true }, binding()),
    /invalid_manifest/,
  );
  assert.throws(() =>
    parseFlashManifest(flashManifestTemplate(binding()), binding()),
  );
  assert.throws(
    () =>
      parseFlashManifest({ ...manifest, expected_chip: "ESP32" }, binding()),
    /unsupported_flash_profile/,
  );
});
test("stale requirement revision or source package cannot authorize flash", async () => {
  const { manifest } = await fixture();
  for (const value of [
    { ...binding(), current: false },
    { ...binding(), revision: 3 },
    { ...binding(), sourceHash: "b".repeat(64) },
  ])
    assert.throws(() => parseFlashManifest(manifest, value));
});
test("merged and bootloader image names and offsets reject", async () => {
  const { manifest } = await fixture();
  for (const filename of [
    "foldbot.merged.bin",
    "foldbot.bootloader.bin",
    "../foldbot.bin",
  ])
    assert.throws(() =>
      parseFlashManifest(
        { ...manifest, app: { ...manifest.app, filename } },
        binding(),
      ),
    );
  assert.throws(() =>
    parseFlashManifest(
      { ...manifest, app: { ...manifest.app, offset: 0 } },
      binding(),
    ),
  );
});
test("wrong hashes, sizes and app image identity reject", async () => {
  const f = await fixture();
  await assert.rejects(
    validateFlashBundle(
      { ...f.manifest, app: { ...f.manifest.app, sha256: "b".repeat(64) } },
      f.app,
      f.partitions,
      binding(),
    ),
    /hash/,
  );
  await assert.rejects(
    validateFlashBundle(f.manifest, f.app.slice(1), f.partitions, binding()),
    /size/,
  );
  f.app[12] = 0;
  await assert.rejects(
    validateFlashBundle(f.manifest, f.app, f.partitions, binding()),
    /invalid_s3_application/,
  );
});
test("partition validation protects data, NVS and single application boundaries", () => {
  assert.equal(parsePartitionTable(partitionFile()).length, 3);
  assert.throws(
    () =>
      parsePartitionTable(partitionFile([[0, 0, 0x10000, 0x200000, "app"]])),
    /nvs/,
  );
  assert.throws(
    () =>
      parsePartitionTable(
        partitionFile([
          [1, 2, 0x9000, 0x10000, "nvs"],
          [0, 0, 0x10000, 0x300000, "app"],
        ]),
      ),
    /overlapping/,
  );
  assert.throws(
    () =>
      parsePartitionTable(
        partitionFile([
          [1, 2, 0x9000, 0x5000, "nvs"],
          [0, 0x10, 0x10000, 0x100000, "app0"],
          [0, 0x11, 0x110000, 0x100000, "app1"],
        ]),
      ),
    /single_app/,
  );
});
test("app offset must match actual imported partition", async () => {
  const f = await fixture();
  f.manifest.app.offset = 0x20000;
  await assert.rejects(
    validateFlashBundle(f.manifest, f.app, f.partitions, binding()),
    /app_outside/,
  );
});
test("selecting serial does not open, reset or reserve a device", async () => {
  const h = await harness();
  await h.session.selectPort();
  assert.deepEqual(h.calls, ["requestPort"]);
  assert.equal(h.snapshots.at(-1).portLabel, "USB VID 303a / PID 1001");
});
test("browser port chooser cancellation reports the same stable UI code without hardware access", async () => {
  let cancel = true;
  const h = await harness({
    options: {
      requestPort: async () => {
        if (cancel) throw new DOMException("User cancelled", "NotFoundError");
        return {
          getInfo: () => ({ usbVendorId: 0x303a, usbProductId: 0x1001 }),
        };
      },
    },
  });
  await assert.rejects(h.session.selectPort(), (error) => {
    assert.equal(error.message, "port_selection_cancelled");
    assert.equal(error.message, h.snapshots.at(-1).error);
    return true;
  });
  assert.equal(h.snapshots.at(-1).phase, "idle");
  assert.equal(h.snapshots.at(-1).portLabel, null);
  assert.deepEqual(h.calls, []);
  cancel = false;
  await h.session.selectPort();
  assert.equal(h.snapshots.at(-1).phase, "selected");
  assert.equal(h.snapshots.at(-1).error, null);
  assert.deepEqual(h.calls, []);
});
test("official lazy loader construction makes no serial writes or opens", async () => {
  const calls = [];
  const driver = await createEspressifDriver(
    {
      getInfo: () => ({ usbVendorId: 0x303a }),
      open: async () => calls.push("open"),
      setSignals: async () => calls.push("signals"),
    },
    () => {},
  );
  assert.equal(typeof driver.loader.main, "function");
  assert.equal(typeof driver.loader.writeFlash, "function");
  assert.deepEqual(calls, []);
});
test("connect requires isolation confirmation before any reset", async () => {
  const h = await harness();
  await h.session.selectPort();
  await assert.rejects(h.session.connect(h.bundle, false), /isolation/);
  assert.deepEqual(h.calls, ["requestPort"]);
});
test("connecting validates live table and does not write", async () => {
  const h = await harness();
  await h.session.selectPort();
  await h.session.connect(h.bundle, true);
  assert.equal(h.snapshots.at(-1).phase, "ready");
  assert.equal(
    h.calls.some((call) => Array.isArray(call) && call[0] === "write"),
    false,
  );
  await h.session.cancel();
  assert.deepEqual(h.calls.slice(-2), ["disconnect", "release"]);
});
test("different live partition table refuses application update", async () => {
  const h = await harness({
    loader: { readFlash: async () => new Uint8Array(3072) },
  });
  await h.session.selectPort();
  await assert.rejects(h.session.connect(h.bundle, true), /live_partition/);
  assert.equal(h.snapshots.at(-1).phase, "failed");
  assert.deepEqual(h.calls.slice(-2), ["disconnect", "release"]);
});
test("wrong chip, encryption and capacity refuse before application write", async () => {
  for (const loader of [
    { chip: { CHIP_NAME: "ESP32" } },
    { getSecurityInfo: async () => ({ flashCryptCnt: 1, parsedFlags: {} }) },
    { detectFlashSize: async () => "2MB" },
  ]) {
    const h = await harness({ loader });
    await h.session.selectPort();
    await assert.rejects(h.session.connect(h.bundle, true));
    assert.equal(
      h.calls.some((call) => Array.isArray(call) && call[0] === "write"),
      false,
    );
  }
});
test("explicit write updates only application and verifies readback before success", async () => {
  const h = await harness();
  await h.session.selectPort();
  await h.session.connect(h.bundle, true);
  await assert.rejects(h.session.write(false), /confirmation/);
  await h.session.write(true);
  const options = h.calls.find(
    (call) => Array.isArray(call) && call[0] === "write",
  )[1];
  assert.equal(options.eraseAll, false);
  assert.equal(options.flashMode, "keep");
  assert.equal(options.fileArray.length, 1);
  assert.equal(options.fileArray[0].address, 0x10000);
  assert.equal(h.snapshots.at(-1).phase, "verified");
  assert.deepEqual(h.calls.slice(-2), ["disconnect", "release"]);
});
test("readback mismatch never marks successful flash", async () => {
  const h = await harness();
  const original = h.loader.readFlash;
  h.loader.readFlash = async (offset, size) =>
    offset === 0x8000 ? original(offset, size) : new Uint8Array(size);
  await h.session.selectPort();
  await h.session.connect(h.bundle, true);
  await assert.rejects(h.session.write(true), /readback/);
  assert.equal(h.snapshots.at(-1).phase, "failed");
});
test("uncertain serial close retains backend exclusion until explicit successful retry", async () => {
  let allowClose = false;
  const h = await harness({
    options: {
      driver: async () => ({
        loader: h.loader,
        disconnect: async () => {
          h.calls.push("disconnect");
          if (!allowClose) throw new Error("close failed");
        },
      }),
    },
  });
  await h.session.selectPort();
  await h.session.connect(h.bundle, true);
  await h.session.cancel();
  assert.equal(h.snapshots.at(-1).error, "serial_cleanup_uncertain");
  assert.equal(flashSessionBusy(h.snapshots.at(-1).phase), true);
  assert.equal(h.calls.includes("release"), false);
  allowClose = true;
  await h.session.cancel();
  assert.deepEqual(h.calls.slice(-2), ["disconnect", "release"]);
});
test("disconnect during write records uncertain firmware and cannot report success", async () => {
  let finish;
  const h = await harness({
    loader: {
      writeFlash: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    },
  });
  await h.session.selectPort();
  await h.session.connect(h.bundle, true);
  const writing = h.session.write(true);
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  const stopping = h.session.cancel();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.includes("release"), false);
  assert.equal(h.snapshots.at(-1).phase, "closing");
  finish();
  await stopping;
  await assert.rejects(writing, /revoked/);
  assert.equal(h.snapshots.at(-1).error, "write_interrupted_outcome_unknown");
  assert.equal(
    h.snapshots.some((value) => value.phase === "verified"),
    false,
  );
});
test("permanent port fence prevents late reopen, signals and writes after cancellation", async () => {
  const calls = [];
  let finishOpen;
  const raw = {
    readable: null,
    writable: {
      getWriter: () => ({
        write: async () => calls.push("write"),
        releaseLock() {},
      }),
    },
    open: () =>
      new Promise((resolve) => {
        calls.push("open");
        finishOpen = resolve;
      }),
    close: async () => {
      calls.push("close");
      raw.writable = null;
    },
    setSignals: async () => calls.push("signals"),
  };
  const fence = createFlashPortFence(raw);
  const cachedWriter = fence.port.writable.getWriter();
  const opening = fence.port.open({ baudRate: 115200 });
  fence.cancel();
  const closing = fence.port.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["open"]);
  finishOpen();
  await assert.rejects(opening, /revoked/);
  await closing;
  await assert.rejects(fence.port.open({ baudRate: 115200 }), /revoked/);
  await assert.rejects(
    fence.port.setSignals({ dataTerminalReady: true }),
    /revoked/,
  );
  await assert.rejects(cachedWriter.write(new Uint8Array([1])), /revoked/);
  assert.deepEqual(calls, ["open", "close"]);
});
test("cancel keeps exclusion until pending main and its attempted late reopen have settled", async () => {
  let finishOpen;
  let mainSettled = false;
  const io = [];
  const raw = {
    readable: null,
    writable: null,
    open: () =>
      new Promise((resolve) => {
        io.push("open");
        finishOpen = resolve;
      }),
    close: async () => {
      io.push("close");
    },
  };
  const fence = createFlashPortFence(raw);
  const h = await harness({
    options: {
      driver: async () => ({
        loader: {
          ...h.loader,
          main: async () => {
            try {
              try {
                await fence.port.open({ baudRate: 115200 });
              } catch {
                await fence.port.open({ baudRate: 115200 });
              }
            } finally {
              mainSettled = true;
            }
          },
        },
        cancel: fence.cancel,
        disconnect: () => fence.port.close(),
      }),
    },
  });
  await h.session.selectPort();
  const connecting = h.session.connect(h.bundle, true);
  const rejected = assert.rejects(connecting, /revoked/);
  while (!finishOpen) await new Promise((resolve) => setImmediate(resolve));
  const stopping = h.session.cancel();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.includes("release"), false);
  assert.equal(h.snapshots.at(-1).phase, "closing");
  finishOpen();
  await stopping;
  await rejected;
  assert.equal(mainSettled, true);
  assert.equal(io.filter((value) => value === "open").length, 1);
  assert.equal(h.calls.includes("release"), true);
});
test("late heartbeat failure from an old lease cannot cancel a newer session", async () => {
  let reservations = 0;
  let rejectOldHeartbeat;
  let oldHeartbeats = 0;
  const released = [];
  const h = await harness({
    options: {
      heartbeatMs: 2,
      lease: {
        reserve: async () => `lease${++reservations}`,
        heartbeat: async (lease) => {
          if (lease === "lease1" && ++oldHeartbeats > 1)
            await new Promise((_, reject) => {
              rejectOldHeartbeat = reject;
            });
        },
        release: async (id) => {
          released.push(id);
        },
      },
    },
  });
  await h.session.selectPort();
  await h.session.connect(h.bundle, true);
  while (!rejectOldHeartbeat)
    await new Promise((resolve) => setTimeout(resolve, 2));
  await h.session.cancel();
  await h.session.selectPort();
  await h.session.connect(h.bundle, true);
  rejectOldHeartbeat(new Error("stale heartbeat response"));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(h.snapshots.at(-1).phase, "ready");
  assert.deepEqual(released, ["lease1"]);
  await h.session.cancel();
});
test("revision changes after connect cannot start write", async () => {
  const h = await harness();
  await h.session.selectPort();
  await h.session.connect(h.bundle, true);
  h.setBinding({ ...binding(), revision: 3 });
  await assert.rejects(h.session.write(true), /revoked/);
  await h.session.cancel("generation_changed");
  assert.equal(
    h.calls.some((call) => Array.isArray(call) && call[0] === "write"),
    false,
  );
});
test("cancelled port chooser cannot install a late selection", async () => {
  let finish;
  const h = await harness({
    options: {
      requestPort: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    },
  });
  const selected = h.session.selectPort();
  await h.session.cancel();
  finish({ getInfo: () => ({}) });
  await assert.rejects(selected, /revoked/);
  assert.equal(h.snapshots.at(-1).portLabel, null);
});
test("cancel during delayed reservation releases late lease without loading flasher", async () => {
  let finish;
  const calls = [];
  const h = await harness({
    options: {
      lease: {
        reserve: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
        heartbeat: async () => {},
        release: async (id) => {
          calls.push(id);
        },
      },
    },
  });
  await h.session.selectPort();
  const connecting = h.session.connect(h.bundle, true);
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  await h.session.cancel();
  finish("late-lease");
  await assert.rejects(connecting, /revoked/);
  assert.deepEqual(calls, ["late-lease"]);
  assert.equal(h.calls.includes("driver"), false);
});
test("local lease calls use generation identity and no device address", async () => {
  const requests = [];
  const api = createFlashLeaseApi(async (url, options) => {
    requests.push([url, JSON.parse(options.body)]);
    return { ok: true, json: async () => ({ session_id: "lease", ok: true }) };
  });
  assert.equal(await api.reserve(binding()), "lease");
  await api.heartbeat("lease");
  await api.release("lease");
  assert.deepEqual(requests[0], [
    "/api/foldbot/flash/sessions",
    {
      project_id: "project1",
      revision: 2,
      generation_id: "generation2",
      source_hash: "a".repeat(64),
    },
  ]);
  assert.equal(requests[2][0], "/api/foldbot/flash/stop");
});
test("UI guards direct hardware operations, cleanup, and download evidence labels", async () => {
  const source = await readFile(
    new URL("../src/FoldBotFlash.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /beforeunload/);
  assert.match(source, /pagehide/);
  assert.match(source, /visibilitychange/);
  assert.match(source, /ae-foldbot-flash-busy/);
  assert.match(source, /firmware_execution_verified: false/);
  assert.match(source, /COM3（示例，未连接）/);
});
