import test from "node:test";
import assert from "node:assert/strict";
import {
  createFoldBotApi,
  FoldBotSession,
  draftMatchesProject,
  restoreFoldBotDraft,
  validateFoldBotDraft,
} from "../src/foldbotApi.ts";

const state = {
  connected: true,
  enabled: false,
  fresh: true,
  fault: null,
  physical_completion_verified: false,
};
const reply = {
  ok: true,
  reason: "accepted",
  state,
  physical_completion_verified: false,
};
const connectArgs = {
  project_id: "p1",
  revision: 1,
  address: "192.168.4.1",
  confirmed: true,
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
function fakeApi(overrides = {}) {
  const calls = { connect: [], heartbeat: [], command: [], stop: [] };
  const api = {
    async connect(args) {
      calls.connect.push(args);
      return { ...reply, session_id: "token-one" };
    },
    async heartbeat(token) {
      calls.heartbeat.push(token);
      return reply;
    },
    async command(token, seq, command) {
      calls.command.push({ token, seq, command });
      return reply;
    },
    async stop(token) {
      calls.stop.push(token);
      return {
        ...reply,
        state: {
          ...state,
          phase: "closed",
          connected: false,
          enabled: false,
          stop_result: { ok: true, reason: "stop_sent" },
        },
      };
    },
    ...overrides,
  };
  return { api, calls };
}

test("public mode denies every project/control request before fetch but permits the static reference", async () => {
  const urls = [];
  const api = createFoldBotApi({
    publicMode: true,
    fetcher: async (url) => {
      urls.push(url);
      return new Response(JSON.stringify({ label: "reference" }));
    },
  });
  const draft = {
    name: "name",
    request: "request",
    drive_level: 10,
    drive_duration_ms: 200,
  };
  const project = { ...draft, id: "p1", revision: 1 };
  for (const call of [
    () => api.template(),
    () => api.projects(),
    () => api.project("p1"),
    () => api.save(draft, null),
    () => api.generate(project),
    () => api.file("p1", "firmware.ino"),
    () => api.connect(connectArgs),
    () => api.heartbeat("token"),
    () => api.command("token", 1, { operation: "enable", confirmed: true }),
    () => api.stop("token"),
  ]) {
    await assert.rejects(call, /public_reference_only/);
  }
  assert.deepEqual(urls, []);
  assert.equal(api.exportUrl("p1"), null);
  assert.deepEqual(await api.reference(), { label: "reference" });
  assert.deepEqual(urls, ["/foldbot-example.json"]);
});

test("constructing the lease client performs no connection or hardware request", () => {
  const { api, calls } = fakeApi();
  const session = new FoldBotSession(api, () => {});
  assert.deepEqual(calls, {
    connect: [],
    heartbeat: [],
    command: [],
    stop: [],
  });
  session.dispose();
  assert.deepEqual(calls.stop, []);
});

test("leaving while connect is pending revokes the late token without publishing a connected state", async () => {
  const pending = deferred();
  const { api, calls } = fakeApi({ connect: () => pending.promise });
  const snapshots = [];
  const session = new FoldBotSession(api, (snapshot) =>
    snapshots.push(snapshot),
  );
  const connection = session.connect(connectArgs);
  session.dispose();
  pending.resolve({ ...reply, session_id: "late-token" });
  await connection;
  await flush();
  assert.deepEqual(calls.stop, ["late-token"]);
  assert.equal(
    snapshots.some((snapshot) => snapshot.active),
    false,
  );
  assert.deepEqual(calls.heartbeat, []);
});

test("STOP bypasses a pending command; a late ACK cannot restore control", async () => {
  const pending = deferred();
  let commandCount = 0;
  const { api, calls } = fakeApi({
    command: () => {
      commandCount++;
      return pending.promise;
    },
  });
  const snapshots = [];
  const session = new FoldBotSession(api, (snapshot) =>
    snapshots.push(snapshot),
  );
  await session.connect(connectArgs);
  const command = session.command({
    operation: "drive",
    linear: 10,
    turn: 0,
    duration_ms: 200,
  });
  await session.command({
    operation: "drive",
    linear: 10,
    turn: 0,
    duration_ms: 200,
  });
  assert.equal(commandCount, 1, "double activation sends only one command");
  await session.stop();
  assert.deepEqual(
    calls.stop,
    ["token-one"],
    "STOP does not await drive acknowledgement",
  );
  pending.resolve({ ...reply, state: { ...state, enabled: true } });
  await command;
  assert.equal(snapshots.at(-1).active, false);
  assert.equal(snapshots.at(-1).state.phase, "closed");
  assert.equal(snapshots.at(-1).state.enabled, false);
  session.dispose();
});

test("heartbeat failure revokes and stops the lease without reconnecting or enabling", async () => {
  const { api, calls } = fakeApi({
    heartbeat: async () => {
      throw new Error("lease_expired");
    },
  });
  const snapshots = [];
  const session = new FoldBotSession(api, (snapshot) =>
    snapshots.push(snapshot),
  );
  await session.connect(connectArgs);
  await flush();
  assert.equal(snapshots.at(-1).active, false);
  assert.match(snapshots.at(-1).error, /lease_expired/);
  assert.deepEqual(calls.stop, ["token-one"]);
  assert.equal(calls.connect.length, 1);
  assert.deepEqual(calls.command, []);
  session.dispose();
});

test("uncertain command failure stops and never retries the command", async () => {
  let attempts = 0;
  const { api, calls } = fakeApi({
    command: async () => {
      attempts++;
      throw new Error("outcome_unknown_do_not_retry");
    },
  });
  const snapshots = [];
  const session = new FoldBotSession(api, (snapshot) =>
    snapshots.push(snapshot),
  );
  await session.connect(connectArgs);
  await session.command({ operation: "arm_step", joint: 1, direction: 1 });
  assert.equal(attempts, 1);
  assert.deepEqual(calls.stop, ["token-one"]);
  assert.equal(snapshots.at(-1).active, false);
  assert.match(snapshots.at(-1).error, /outcome_unknown/);
  session.dispose();
});

test("a failed old STOP cannot overwrite a new connection state", async () => {
  const oldStop = deferred();
  let connections = 0;
  const { api } = fakeApi({
    connect: async () => ({ ...reply, session_id: `token-${++connections}` }),
    stop: (token) =>
      token === "token-1" ? oldStop.promise : Promise.resolve(reply),
  });
  const snapshots = [];
  const session = new FoldBotSession(api, (snapshot) =>
    snapshots.push(snapshot),
  );
  await session.connect(connectArgs);
  const stopped = session.stop();
  await session.connect(connectArgs);
  oldStop.reject(new Error("old_stop_failed"));
  await stopped;
  assert.equal(snapshots.at(-1).active, true);
  assert.equal(snapshots.at(-1).error, "");
  session.dispose();
});

test("trimmed server text matches the retained raw draft, while real edits and invalid values do not", () => {
  const project = {
    name: "FoldBot",
    request: "Keep all modules",
    drive_level: 10,
    drive_duration_ms: 200,
  };
  const draft = {
    ...project,
    name: " FoldBot ",
    request: "Keep all modules\n",
  };
  assert.equal(draftMatchesProject(draft, project), true);
  assert.equal(validateFoldBotDraft(draft), true);
  assert.equal(
    draftMatchesProject({ ...draft, request: "New request" }, project),
    false,
  );
  for (const patch of [
    { drive_level: 21 },
    { drive_level: 1.5 },
    { drive_duration_ms: 2001 },
    { drive_duration_ms: 0 },
    { request: "\0bad" },
    { name: "   " },
  ]) {
    assert.equal(validateFoldBotDraft({ ...draft, ...patch }), false);
  }
});

test("a cached revision conflict survives persistence and repeated reloads", () => {
  const server = {
    id: "p1",
    revision: 2,
    name: "FoldBot",
    request: "New server request",
    drive_level: 10,
    drive_duration_ms: 200,
  };
  let cached = {
    projectId: "p1",
    baseRevision: 1,
    draft: {
      name: "FoldBot",
      request: "Unsaved text based on revision one",
      drive_level: 10,
      drive_duration_ms: 200,
    },
  };
  for (let reload = 0; reload < 3; reload++) {
    const restored = restoreFoldBotDraft(cached, [server], {});
    assert.equal(
      restored.conflict,
      true,
      "autosave must remain blocked after every reload",
    );
    assert.equal(restored.project.revision, 2, "server metadata is current");
    assert.equal(
      restored.baseline.baseRevision,
      1,
      "browser draft keeps its original revision",
    );
    assert.equal(restored.draft.request, "Unsaved text based on revision one");
    // This is the same cache payload the workbench persists after initialization.
    cached = JSON.parse(
      JSON.stringify({ draft: restored.draft, ...restored.baseline }),
    );
  }
  assert.equal(server.request, "New server request");
});

test("an unbound browser draft never attaches itself to the first server project", () => {
  const server = {
    id: "existing",
    revision: 7,
    name: "Existing",
    request: "Keep existing",
    drive_level: 10,
    drive_duration_ms: 200,
  };
  const draft = {
    name: "New draft",
    request: "Independent request",
    drive_level: 10,
    drive_duration_ms: 200,
  };
  const restored = restoreFoldBotDraft(
    { projectId: null, baseRevision: null, draft },
    [server],
    draft,
  );
  assert.equal(restored.project, null);
  assert.deepEqual(restored.baseline, { projectId: null, baseRevision: null });
  assert.deepEqual(restored.draft, draft);
});

test("STOP warns and preserves raw state when top-level success hides failed or unknown delivery", async () => {
  for (const stopResult of [
    { ok: false, reason: "transport_send_failed" },
    null,
    undefined,
  ]) {
    const stoppedState = {
      ...state,
      phase: "closed",
      connected: false,
      enabled: false,
      stop_result: stopResult,
    };
    const { api } = fakeApi({
      stop: async () => ({ ...reply, state: stoppedState }),
    });
    const snapshots = [];
    const session = new FoldBotSession(api, (snapshot) =>
      snapshots.push(snapshot),
    );
    await session.connect(connectArgs);
    await session.stop();
    assert.equal(snapshots.at(-1).active, false);
    assert.equal(snapshots.at(-1).error, "stop_unconfirmed_lease_expiry");
    assert.deepEqual(snapshots.at(-1).state, stoppedState);
    session.dispose();
  }
});

test("a late failed STOP reply cannot replace the state of a new connection", async () => {
  const oldStop = deferred();
  let connections = 0;
  const { api } = fakeApi({
    connect: async () => ({ ...reply, session_id: `token-${++connections}` }),
    stop: (token) =>
      token === "token-1" ? oldStop.promise : Promise.resolve(reply),
  });
  const snapshots = [];
  const session = new FoldBotSession(api, (snapshot) =>
    snapshots.push(snapshot),
  );
  await session.connect(connectArgs);
  const stopped = session.stop();
  await session.connect(connectArgs);
  oldStop.resolve({
    ...reply,
    state: { ...state, connected: false, stop_result: { ok: false } },
  });
  await stopped;
  assert.equal(snapshots.at(-1).active, true);
  assert.equal(snapshots.at(-1).state.connected, true);
  assert.equal(snapshots.at(-1).error, "");
  session.dispose();
});
