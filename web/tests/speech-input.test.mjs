import test from "node:test";
import assert from "node:assert/strict";
import {
  appendSpeechText,
  createSpeechSession,
  getSpeechRecognitionConstructor,
} from "../src/speechInput.ts";

// This clock advances deadlines without waiting for microphone/browser services.
function clock() {
  let now = 0;
  let sequence = 0;
  const pending = new Map();
  return {
    timers: {
      setTimeout(callback, delayMs) {
        const id = ++sequence;
        pending.set(id, { callback, at: now + delayMs });
        return id;
      },
      clearTimeout(id) {
        pending.delete(id);
      },
    },
    tick(ms) {
      const target = now + ms;
      while (true) {
        const next = [...pending.entries()]
          .filter(([, item]) => item.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        pending.delete(next[0]);
        now = next[1].at;
        next[1].callback();
      }
      now = target;
    },
    size: () => pending.size,
  };
}

class Recognition {
  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 0;
  onstart = null;
  onend = null;
  onerror = null;
  onresult = null;
  startCalls = 0;
  stopCalls = 0;
  abortCalls = 0;
  start() {
    this.startCalls++;
  }
  stop() {
    this.stopCalls++;
  }
  abort() {
    this.abortCalls++;
  }
  result(rows, resultIndex = 0) {
    this.onresult?.({
      resultIndex,
      results: rows.map(([transcript, isFinal]) => ({
        isFinal,
        0: { transcript },
        length: 1,
      })),
    });
  }
}

function harness({ onFinal, createRecognition } = {}) {
  const recognition = new Recognition();
  const time = clock();
  const states = [],
    previews = [],
    finals = [],
    endings = [];
  const session = createSpeechSession({
    createRecognition: createRecognition || (() => recognition),
    onState: (state) => states.push(state),
    onInterim: (text) => previews.push(text),
    onFinal: (text) => {
      finals.push(text);
      return onFinal?.(text) ?? true;
    },
    onEnd: (reason) => endings.push(reason),
    timers: time.timers,
  });
  return { recognition, time, states, previews, finals, endings, session };
}

test("constructor detection prefers standard support, falls back to WebKit and tolerates inaccessible hosts", () => {
  class Standard {}
  class WebKit {}
  assert.equal(
    getSpeechRecognitionConstructor({
      SpeechRecognition: Standard,
      webkitSpeechRecognition: WebKit,
    }),
    Standard,
  );
  assert.equal(
    getSpeechRecognitionConstructor({
      SpeechRecognition: {},
      webkitSpeechRecognition: WebKit,
    }),
    WebKit,
  );
  for (const host of [
    null,
    undefined,
    3,
    {},
    { SpeechRecognition: "unsupported" },
  ])
    assert.equal(getSpeechRecognitionConstructor(host), null);
  const blocked = Object.defineProperty({}, "SpeechRecognition", {
    get() {
      throw new Error("blocked");
    },
  });
  assert.doesNotThrow(() => getSpeechRecognitionConstructor(blocked));
  assert.equal(getSpeechRecognitionConstructor(blocked), null);
});

test("append preserves existing text and adds a single newline boundary around a trimmed new segment", () => {
  assert.deepEqual(appendSpeechText("  原需求  ", "  招手三次。  "), {
    value: "  原需求  \n招手三次。",
    overflow: "",
  });
  assert.deepEqual(appendSpeechText("已有内容\n", " next "), {
    value: "已有内容\nnext",
    overflow: "",
  });
  assert.deepEqual(appendSpeechText("", "  hello  "), {
    value: "hello",
    overflow: "",
  });
  assert.deepEqual(appendSpeechText("保留\n", " \n\t "), {
    value: "保留\n",
    overflow: "",
  });
});

test("append rejects an entire overflowing segment, retaining original whitespace for recovery", () => {
  assert.deepEqual(appendSpeechText("abc", " d ", 5), {
    value: "abc\nd",
    overflow: "",
  });
  assert.deepEqual(appendSpeechText("abc", " de ", 5), {
    value: "abc",
    overflow: " de ",
  });
  assert.deepEqual(appendSpeechText("x".repeat(4000), "extra"), {
    value: "x".repeat(4000),
    overflow: "extra",
  });
  assert.deepEqual(appendSpeechText("already longer", "new", 2), {
    value: "already longer",
    overflow: "new",
  });
});

test("append respects textarea UTF-16 length without splitting emoji or Unicode text", () => {
  assert.deepEqual(appendSpeechText("🤖", "挥手👋", 6), {
    value: "🤖",
    overflow: "挥手👋",
  });
  assert.deepEqual(appendSpeechText("🤖", "挥手👋", 7), {
    value: "🤖\n挥手👋",
    overflow: "",
  });
  assert.deepEqual(appendSpeechText("", "e\u0301", 1), {
    value: "",
    overflow: "e\u0301",
  });
});

test("start is user-triggered, configures language once and never restarts a used session", () => {
  const h = harness();
  assert.equal(h.recognition.startCalls, 0);
  assert.deepEqual(h.states, []);
  h.session.start("zh-CN");
  h.session.start("en-US");
  assert.equal(h.recognition.lang, "zh-CN");
  assert.equal(h.recognition.continuous, true);
  assert.equal(h.recognition.interimResults, true);
  assert.equal(h.recognition.maxAlternatives, 1);
  assert.equal(h.recognition.startCalls, 1);
  assert.deepEqual(h.states, ["starting"]);
  h.recognition.onstart();
  assert.deepEqual(h.states, ["starting", "listening"]);
  h.recognition.result([["hello", true]]);
  h.recognition.onend();
  h.session.start("en-US");
  assert.equal(h.recognition.startCalls, 1);
  assert.deepEqual(h.endings, ["done"]);
  assert.equal(h.time.size(), 0);
});

test("interim corrections replace preview and only final result indices are appended once", () => {
  const h = harness();
  h.session.start("zh-CN");
  h.recognition.onstart();
  h.recognition.result([["招", false]]);
  h.recognition.result([["招手三次", false]]);
  assert.deepEqual(h.finals, []);
  assert.equal(h.previews.at(-1), "招手三次");
  h.recognition.result([
    [" 招手三次 ", true],
    ["然后", false],
  ]);
  assert.deepEqual(h.finals, ["招手三次"]);
  assert.equal(h.previews.at(-1), "然后");
  h.recognition.result(
    [
      ["招手三次", true],
      ["然后放下", false],
    ],
    1,
  );
  assert.equal(h.previews.at(-1), "然后放下");
  h.recognition.result(
    [
      ["招手三次", true],
      ["然后放下", true],
    ],
    1,
  );
  h.recognition.result(
    [
      ["招手三次", true],
      ["然后放下", true],
    ],
    0,
  );
  assert.deepEqual(h.finals, ["招手三次", "然后放下"]);
  assert.equal(h.previews.at(-1), "");
  h.recognition.onend();
});

test("identical words at different final indices remain legitimate separate segments", () => {
  const h = harness();
  h.session.start("en-US");
  h.recognition.onstart();
  h.recognition.result([
    ["again", true],
    ["again", true],
  ]);
  assert.deepEqual(h.finals, ["again", "again"]);
  h.recognition.onend();
});

test("a browser result-list contraction removes obsolete interim text", () => {
  const h = harness();
  h.session.start("en-US");
  h.recognition.onstart();
  h.recognition.result([
    ["first", false],
    ["wrong", false],
  ]);
  assert.equal(h.previews.at(-1), "first wrong");
  h.recognition.result([["first", false]], 1);
  assert.equal(h.previews.at(-1), "first");
  h.session.cancel();
});

test("stop waits for tail finals before ending, without duplicate browser stop calls", () => {
  const h = harness();
  h.session.start("en-US");
  h.recognition.onstart();
  h.session.stop();
  h.session.stop();
  assert.equal(h.recognition.stopCalls, 1);
  assert.equal(h.states.at(-1), "stopping");
  assert.deepEqual(h.endings, []);
  h.time.tick(2999);
  h.recognition.result([["tail final", true]]);
  assert.deepEqual(h.finals, ["tail final"]);
  h.recognition.onend();
  h.time.tick(1);
  assert.deepEqual(h.endings, ["done"]);
  assert.equal(h.states.at(-1), "idle");
  assert.equal(h.recognition.abortCalls, 0);
  assert.equal(h.time.size(), 0);
});

test("final rejection stops recording but preserves subsequent final segments for overflow handling", () => {
  const h = harness({ onFinal: () => false });
  h.session.start("en-US");
  h.recognition.onstart();
  h.recognition.result([
    ["too long", true],
    ["also preserve", true],
  ]);
  assert.deepEqual(h.finals, ["too long", "also preserve"]);
  assert.equal(h.recognition.stopCalls, 1);
  h.recognition.result(
    [
      ["too long", true],
      ["also preserve", true],
      ["tail", true],
    ],
    2,
  );
  assert.deepEqual(h.finals, ["too long", "also preserve", "tail"]);
  h.recognition.onend();
  assert.deepEqual(h.endings, ["done"]);
});

test("silent startup is aborted after 15 seconds and old callbacks are ignored", () => {
  const h = harness();
  h.session.start("en-US");
  const lateStart = h.recognition.onstart,
    lateResult = h.recognition.onresult;
  h.time.tick(14999);
  assert.deepEqual(h.endings, []);
  h.time.tick(1);
  assert.deepEqual(h.endings, ["start-timeout"]);
  assert.equal(h.states.at(-1), "idle");
  assert.equal(h.recognition.abortCalls, 1);
  lateStart();
  lateResult({
    resultIndex: 0,
    results: [{ isFinal: true, 0: { transcript: "late" } }],
  });
  assert.deepEqual(h.finals, []);
  assert.equal(h.states.at(-1), "idle");
});

test("real start replaces the startup deadline with a 120-second recording limit", () => {
  const h = harness();
  h.session.start("en-US");
  h.time.tick(14000);
  h.recognition.onstart();
  h.time.tick(119999);
  assert.deepEqual(h.endings, []);
  assert.equal(h.recognition.stopCalls, 0);
  h.time.tick(1);
  assert.equal(h.states.at(-1), "stopping");
  assert.equal(h.recognition.stopCalls, 1);
  h.recognition.result([["last words", true]]);
  h.recognition.onend();
  assert.deepEqual(h.finals, ["last words"]);
  assert.deepEqual(h.endings, ["done"]);
});

test("a browser that never ends after stop is aborted after the 3-second grace period", () => {
  const h = harness();
  h.session.start("en-US");
  h.recognition.onstart();
  h.session.stop();
  const lateEnd = h.recognition.onend;
  h.time.tick(3000);
  lateEnd();
  assert.deepEqual(h.endings, ["stop-timeout"]);
  assert.equal(h.recognition.abortCalls, 1);
  assert.equal(h.states.at(-1), "idle");
  assert.equal(h.time.size(), 0);
});

test("stop during startup cannot revert to listening on a delayed onstart", () => {
  const h = harness();
  h.session.start("zh-CN");
  h.session.stop();
  h.recognition.onstart();
  assert.deepEqual(h.states, ["starting", "stopping"]);
  h.time.tick(3000);
  assert.deepEqual(h.endings, ["stop-timeout"]);
});

test("permission and service errors report once, clear timers, and ignore later results", () => {
  const reasons = [
    "no-speech",
    "not-allowed",
    "service-not-allowed",
    "audio-capture",
    "network",
    "language-not-supported",
  ];
  for (const reason of reasons) {
    const h = harness();
    h.session.start("zh-CN");
    const lateEnd = h.recognition.onend,
      lateResult = h.recognition.onresult;
    h.recognition.onerror({ error: reason });
    lateEnd();
    lateResult({
      resultIndex: 0,
      results: [{ isFinal: true, 0: { transcript: "late" } }],
    });
    h.time.tick(130000);
    assert.deepEqual(h.endings, [reason]);
    assert.deepEqual(h.finals, []);
    assert.equal(h.states.at(-1), "idle");
    assert.equal(h.time.size(), 0);
  }
});

test("unrecognized errors are recoverable and a fresh session can start afterwards", () => {
  const h = harness();
  h.session.start("en-US");
  h.recognition.onerror({ error: "unrecognized-browser-error" });
  assert.deepEqual(h.endings, ["unknown"]);
  assert.equal(h.states.at(-1), "idle");
  const fresh = harness();
  fresh.session.start("en-US");
  fresh.recognition.onstart();
  fresh.recognition.result([["recovered", true]]);
  fresh.recognition.onend();
  assert.deepEqual(fresh.finals, ["recovered"]);
  assert.deepEqual(fresh.endings, ["done"]);
});

test("natural end without any speech reports no-speech and discards interim text", () => {
  const h = harness();
  h.session.start("zh-CN");
  h.recognition.onstart();
  h.recognition.result([["unfinished", false]]);
  h.recognition.onend();
  assert.deepEqual(h.endings, ["no-speech"]);
  assert.deepEqual(h.finals, []);
  assert.equal(h.previews.at(-1), "");
});

test("cancel aborts once and protects a new field from callbacks retained by the old recognition", () => {
  const h = harness();
  h.session.start("en-US");
  h.recognition.onstart();
  const callbacks = {
    result: h.recognition.onresult,
    end: h.recognition.onend,
    error: h.recognition.onerror,
  };
  h.session.cancel();
  h.session.cancel();
  h.session.stop();
  callbacks.result({
    resultIndex: 0,
    results: [{ isFinal: true, 0: { transcript: "old project" } }],
  });
  callbacks.error({ error: "aborted" });
  callbacks.end();
  h.time.tick(200000);
  assert.deepEqual(h.endings, ["cancelled"]);
  assert.deepEqual(h.finals, []);
  assert.equal(h.recognition.abortCalls, 1);
  assert.equal(h.states.at(-1), "idle");
});

test("dispose is silent and ignores all subsequent browser callbacks and public methods", () => {
  const h = harness();
  h.session.start("en-US");
  h.recognition.onstart();
  const callbacks = {
    result: h.recognition.onresult,
    start: h.recognition.onstart,
    end: h.recognition.onend,
    error: h.recognition.onerror,
  };
  const before = { states: [...h.states], previews: [...h.previews] };
  h.session.dispose();
  h.session.dispose();
  h.session.start("zh-CN");
  h.session.cancel();
  h.session.stop();
  callbacks.start();
  callbacks.result({
    resultIndex: 0,
    results: [{ isFinal: true, 0: { transcript: "old" } }],
  });
  callbacks.error({ error: "network" });
  callbacks.end();
  h.time.tick(200000);
  assert.deepEqual(h.states, before.states);
  assert.deepEqual(h.previews, before.previews);
  assert.deepEqual(h.endings, []);
  assert.deepEqual(h.finals, []);
  assert.equal(h.recognition.abortCalls, 1);
  assert.equal(h.time.size(), 0);
});

test("dispose before first use never opens the microphone", () => {
  const h = harness();
  h.session.dispose();
  h.session.start("en-US");
  assert.equal(h.recognition.startCalls, 0);
  assert.deepEqual(h.states, []);
});

test("constructor and start exceptions return to idle with a mapped reason", () => {
  const constructor = harness({
    createRecognition: () => {
      throw new Error("cannot construct");
    },
  });
  assert.doesNotThrow(() => constructor.session.start("en-US"));
  assert.deepEqual(constructor.endings, ["unknown"]);
  assert.equal(constructor.states.at(-1), "idle");
  const denied = harness();
  denied.recognition.start = () => {
    throw Object.assign(new Error("permission"), { name: "NotAllowedError" });
  };
  assert.doesNotThrow(() => denied.session.start("en-US"));
  assert.deepEqual(denied.endings, ["not-allowed"]);
  assert.equal(denied.time.size(), 0);
  const unsupported = harness({
    createRecognition: () => {
      throw Object.assign(new Error("not supported"), {
        name: "NotSupportedError",
      });
    },
  });
  unsupported.session.start("en-US");
  assert.deepEqual(unsupported.endings, ["unsupported"]);
});

test("stop and abort exceptions cannot leave the UI stuck or leak timer callbacks", () => {
  const h = harness();
  h.session.start("en-US");
  h.recognition.onstart();
  h.recognition.stop = () => {
    throw new Error("stop failed");
  };
  h.recognition.abort = () => {
    throw new Error("abort failed");
  };
  assert.doesNotThrow(() => h.session.stop());
  assert.equal(h.states.at(-1), "idle");
  assert.deepEqual(h.endings, ["unknown"]);
  assert.equal(h.time.size(), 0);
});

test("synchronous browser end inside stop cannot be followed by a stale stop timeout", () => {
  const h = harness();
  h.session.start("en-US");
  h.recognition.onstart();
  h.recognition.result([["complete", true]]);
  h.recognition.stop = () => h.recognition.onend?.();
  h.session.stop();
  h.time.tick(200000);
  assert.deepEqual(h.endings, ["done"]);
  assert.equal(h.time.size(), 0);
});

test("all final segments in an overflowing batch survive a synchronous browser stop", () => {
  const h = harness({ onFinal: () => false });
  h.session.start("en-US");
  h.recognition.onstart();
  h.recognition.stop = () => h.recognition.onend?.();
  h.recognition.result([
    ["overflow one", true],
    ["overflow two", true],
  ]);
  assert.deepEqual(h.finals, ["overflow one", "overflow two"]);
  assert.deepEqual(h.endings, ["done"]);
});
