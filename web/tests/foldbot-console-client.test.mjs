import test from "node:test";
import assert from "node:assert/strict";
import {
  CONSOLE_CHANNEL,
  createConsoleApi,
  FoldBotConsoleSession,
  readConsoleEvents,
} from "../src/foldbotConsoleClient.ts";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const reservation = (session_id = "memory-only-token") => ({
  session_id,
  ws_path: "/api/foldbot/console/ws",
  lease_ms: 2000,
  attach_timeout_ms: 2000,
  phase: "reserved",
});
const stopped = {
  ok: true,
  stop_result: {
    ok: true,
    connection_was_open: true,
    stop_command_sent: true,
    transport_closed: true,
    physical_stop_verified: false,
  },
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
function fixture(
  overrides = {},
  publicMode = false,
  handshakeTimeoutMs = 5000,
) {
  const calls = { reserve: [], stop: [], messages: [], resets: 0 };
  const snapshots = [];
  const makeFrame = () => ({
    postMessage: (data, origin) => calls.messages.push({ data, origin }),
  });
  let frame = makeFrame();
  const api = {
    reserve: async (address, confirmed) => {
      calls.reserve.push({ address, confirmed });
      return reservation();
    },
    stop: async (token) => {
      calls.stop.push(token);
      return stopped;
    },
    ...overrides,
  };
  const session = new FoldBotConsoleSession({
    api,
    publicMode,
    origin: "http://localhost:8000",
    frame: () => frame,
    resetFrame: () => {
      frame = makeFrame();
      calls.resets++;
    },
    notify: (snapshot) => snapshots.push(snapshot),
    handshakeTimeoutMs,
  });
  const emit = (
    type,
    extra = {},
    source = frame,
    origin = "http://localhost:8000",
  ) =>
    session.receive({
      source,
      origin,
      data: { channel: CONSOLE_CHANNEL, type, ...extra },
    });
  const ready = () => {
    session.frameLoaded();
    emit("ready");
  };
  return { calls, snapshots, session, emit, ready, getFrame: () => frame };
}

test("public preview rejects API calls before fetch or beacon and ignores all session input", async () => {
  let fetches = 0,
    beacons = 0;
  const api = createConsoleApi({
    publicMode: true,
    fetcher: async () => {
      fetches++;
      throw new Error("must not fetch");
    },
    beacon: () => {
      beacons++;
      return true;
    },
  });
  await assert.rejects(
    () => api.reserve("192.168.4.1", true),
    /public_preview_only/,
  );
  await assert.rejects(() => api.stop("unused"), /public_preview_only/);
  await assert.rejects(
    () =>
      readConsoleEvents({
        publicMode: true,
        fetcher: async () => {
          fetches++;
        },
      }),
    /public_preview_only/,
  );
  const f = fixture(api, true);
  f.ready();
  await f.session.connect("192.168.4.1", true);
  f.emit("connected");
  await f.session.stop();
  f.session.dispose();
  assert.equal(fetches, 0);
  assert.equal(beacons, 0);
  assert.deepEqual(f.calls.messages, []);
  assert.deepEqual(f.snapshots, []);
});

test("initial preview and unconfirmed clicks have no network or iframe control side effects", async () => {
  const f = fixture();
  await f.session.connect("192.168.4.1", true);
  f.ready();
  await f.session.connect("192.168.4.1", false);
  assert.deepEqual(f.calls.reserve, []);
  assert.deepEqual(f.calls.messages, []);
  f.session.dispose();
  assert.deepEqual(f.calls.stop, []);
});

test("ready and load may arrive in either order, and reservation does not mean connected", async () => {
  for (const readyFirst of [false, true]) {
    const f = fixture();
    if (readyFirst) {
      f.emit("ready");
      f.session.frameLoaded();
    } else f.ready();
    await f.session.connect(" 192.168.4.1 ", true);
    assert.equal(f.snapshots.at(-1).phase, "attaching");
    assert.deepEqual(f.calls.reserve, [
      { address: "192.168.4.1", confirmed: true },
    ]);
    assert.deepEqual(f.calls.messages, [
      {
        data: {
          channel: CONSOLE_CHANNEL,
          type: "attach",
          session_id: "memory-only-token",
          ws_path: "/api/foldbot/console/ws",
        },
        origin: "http://localhost:8000",
      },
    ]);
    assert.equal(
      JSON.stringify(f.snapshots).includes("memory-only-token"),
      false,
    );
    f.emit("connected");
    assert.equal(f.snapshots.at(-1).phase, "connected");
    await f.session.stop();
    f.session.dispose();
  }
});

test("untrusted origins, sibling windows, and mismatched tokens cannot activate control", async () => {
  const f = fixture();
  f.session.frameLoaded();
  f.emit("ready", {}, {}, "http://localhost:8000");
  f.emit("ready", {}, f.getFrame(), "https://unrelated.example");
  await f.session.connect("192.168.4.1", true);
  assert.deepEqual(f.calls.reserve, []);
  f.emit("ready");
  await f.session.connect("192.168.4.1", true);
  f.emit("connected", {}, {}, "http://localhost:8000");
  f.emit("connected", {}, f.getFrame(), "https://unrelated.example");
  f.emit("connected", { session_id: "old-token" });
  assert.equal(f.snapshots.at(-1).phase, "attaching");
  await f.session.stop();
  f.session.dispose();
});

test("leaving during reservation revokes the late token without attach or resurrected state", async () => {
  const pending = deferred();
  const f = fixture({ reserve: () => pending.promise });
  f.ready();
  const connection = f.session.connect("192.168.4.1", true);
  f.session.dispose();
  const count = f.snapshots.length;
  pending.resolve(reservation("late-token"));
  await connection;
  assert.deepEqual(f.calls.stop, ["late-token"]);
  assert.equal(
    f.calls.messages.some(({ data }) => data.type === "attach"),
    false,
  );
  assert.equal(
    f.snapshots.length,
    count,
    "unmounted React must not receive late notifications",
  );
});

test("hide during pending reservation blocks reconnect until the late token is revoked", async () => {
  const pending = deferred();
  const stopPending = deferred();
  let reservations = 0;
  const f = fixture({
    reserve: () => {
      reservations++;
      return pending.promise;
    },
    stop: () => stopPending.promise,
  });
  f.ready();
  const connection = f.session.connect("192.168.4.1", true);
  await f.session.stop("page_left");
  f.ready();
  await f.session.connect("192.168.4.1", true);
  assert.equal(reservations, 1);
  pending.resolve(reservation());
  await flush();
  assert.equal(f.snapshots.at(-1).busy, true);
  stopPending.resolve(stopped);
  await connection;
  assert.equal(f.snapshots.at(-1).phase, "closed");
  assert.equal(f.snapshots.at(-1).busy, false);
  assert.equal(
    f.calls.messages.some(({ data }) => data.type === "attach"),
    false,
  );
  f.session.dispose();
});

test("STOP detaches immediately, blocks reconnect during cleanup, and rejects old-frame callbacks", async () => {
  const stopPending = deferred();
  const f = fixture({ stop: async () => stopPending.promise });
  f.ready();
  await f.session.connect("192.168.4.1", true);
  f.emit("connected");
  const oldFrame = f.getFrame();
  const stop = f.session.stop();
  assert.equal(f.calls.messages.at(-1).data.type, "detach");
  assert.equal(f.snapshots.at(-1).phase, "stopping");
  assert.notEqual(f.getFrame(), oldFrame);
  f.ready();
  await f.session.connect("192.168.4.1", true);
  assert.equal(f.calls.reserve.length, 1);
  f.emit("connected", {}, oldFrame);
  assert.equal(f.snapshots.at(-1).phase, "stopping");
  stopPending.resolve(stopped);
  await stop;
  await f.session.connect("192.168.4.1", true);
  assert.equal(f.calls.reserve.length, 2);
  f.emit("closed", {}, oldFrame);
  f.emit("connected", {}, oldFrame);
  assert.equal(f.snapshots.at(-1).phase, "attaching");
  await f.session.stop();
  f.session.dispose();
});

test("transport close failures and API failures remain unconfirmed even if ownership was revoked", async () => {
  for (const stop of [
    async () => ({
      ok: true,
      stop_result: {
        ...stopped.stop_result,
        ok: false,
        transport_closed: false,
      },
    }),
    async () => ({ ok: true }),
    async () => {
      throw new Error("offline");
    },
  ]) {
    const f = fixture({ stop });
    f.ready();
    await f.session.connect("192.168.4.1", true);
    f.emit("connected");
    await f.session.stop();
    assert.equal(f.snapshots.at(-1).error, "stop_unconfirmed");
    assert.equal(f.snapshots.at(-1).phase, "closed");
    assert.equal(f.calls.reserve.length, 1);
    f.session.dispose();
  }
});

test("missing handshake times out, stops once, and never auto-reconnects", async () => {
  const f = fixture({}, false, 5);
  f.ready();
  await f.session.connect("192.168.4.1", true);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(f.calls.stop, ["memory-only-token"]);
  assert.equal(f.calls.reserve.length, 1);
  assert.equal(f.snapshots.at(-1).reason, "connection_timeout");
  assert.equal(f.snapshots.at(-1).phase, "closed");
  f.session.dispose();
});

test("iframe reload during a pending reservation revokes the result without attaching", async () => {
  const pending = deferred();
  const f = fixture({ reserve: () => pending.promise });
  f.ready();
  const connection = f.session.connect("192.168.4.1", true);
  f.session.frameLoaded();
  pending.resolve(reservation());
  await connection;
  assert.deepEqual(f.calls.stop, ["memory-only-token"]);
  assert.equal(
    f.calls.messages.some(({ data }) => data.type === "attach"),
    false,
  );
  assert.equal(f.snapshots.at(-1).reason, "frame_reloaded");
  f.session.dispose();
});

test("invalid websocket path is never passed to the iframe and its reservation is revoked", async () => {
  const f = fixture({
    reserve: async () => ({
      ...reservation(),
      ws_path: "wss://external.example/ws",
    }),
  });
  f.ready();
  await f.session.connect("192.168.4.1", true);
  assert.deepEqual(f.calls.stop, ["memory-only-token"]);
  assert.equal(
    f.calls.messages.some(({ data }) => data.type === "attach"),
    false,
  );
  assert.equal(f.snapshots.at(-1).error, "invalid_reservation");
  f.session.dispose();
});

test("API sends fixed same-origin paths, keeps STOP alive, and reports beacon as unconfirmed", async () => {
  const requests = [],
    beacons = [];
  const api = createConsoleApi({
    publicMode: false,
    fetcher: async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith("/stop")) throw new Error("closing");
      return new Response(JSON.stringify(reservation()), { status: 200 });
    },
    beacon: (url, body) => {
      beacons.push({ url, body });
      return true;
    },
  });
  await assert.rejects(
    () => api.reserve("192.168.4.1", false),
    /confirmation_required/,
  );
  await api.reserve("192.168.4.1", true);
  await assert.rejects(() => api.stop("private-token"), /closing/);
  assert.deepEqual(
    requests.map((item) => item.url),
    ["/api/foldbot/console/sessions", "/api/foldbot/console/stop"],
  );
  assert.equal(requests[1].init.keepalive, true);
  assert.equal(requests[1].init.credentials, "same-origin");
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    session_id: "private-token",
  });
  assert.equal(beacons.length, 1);
  assert.equal(beacons[0].url, "/api/foldbot/console/stop");
  assert.deepEqual(JSON.parse(await beacons[0].body.text()), {
    session_id: "private-token",
  });
});

test("manual event reads expose protocol evidence but discard unrelated server fields", async () => {
  const urls = [];
  const events = await readConsoleEvents({
    publicMode: false,
    fetcher: async (url) => {
      urls.push(url);
      return new Response(
        JSON.stringify({
          items: [
            {
              operation: "stop",
              reason: "page_left",
              time_ms: 1000,
              session_id: "not-for-ui",
            },
          ],
          physical_completion_verified: false,
        }),
      );
    },
  });
  assert.deepEqual(urls, ["/api/foldbot/console/events"]);
  assert.deepEqual(events, [
    { operation: "stop", reason: "page_left", time_ms: 1000 },
  ]);
});

test("child errors revoke ownership and do not reconnect or restore motion", async () => {
  for (const type of ["closed", "error"]) {
    const f = fixture();
    f.ready();
    await f.session.connect("192.168.4.1", true);
    f.emit("connected");
    const oldFrame = f.getFrame();
    f.emit(type);
    await flush();
    assert.deepEqual(f.calls.stop, ["memory-only-token"]);
    f.emit("connected", {}, oldFrame);
    assert.equal(f.snapshots.at(-1).phase, "closed");
    assert.equal(f.calls.reserve.length, 1);
    f.session.dispose();
  }
});
