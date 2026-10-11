export type SpeechState = "idle" | "starting" | "listening" | "stopping";

export type SpeechEndReason =
  | "done"
  | "cancelled"
  | "no-speech"
  | "not-allowed"
  | "service-not-allowed"
  | "audio-capture"
  | "network"
  | "language-not-supported"
  | "unsupported"
  | "start-timeout"
  | "stop-timeout"
  | "unknown";

export interface RecognitionResultEvent {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: {
      isFinal: boolean;
      [alternative: number]: { transcript: string };
    };
  };
}

export interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

export type RecognitionConstructor = new () => RecognitionLike;

export interface SpeechTimers {
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

type SpeechSessionOptions = {
  createRecognition: () => RecognitionLike;
  onState: (state: SpeechState) => void;
  onInterim: (text: string) => void;
  onFinal: (text: string) => boolean;
  onEnd: (reason: SpeechEndReason) => void;
  timers?: SpeechTimers;
};

export function getSpeechRecognitionConstructor(
  host: unknown,
): RecognitionConstructor | null {
  if ((typeof host !== "object" && typeof host !== "function") || host === null)
    return null;
  for (const key of ["SpeechRecognition", "webkitSpeechRecognition"]) {
    try {
      const candidate = (host as Record<string, unknown>)[key];
      if (typeof candidate === "function")
        return candidate as RecognitionConstructor;
    } catch {
      // Some embedded hosts expose properties that cannot be accessed.
    }
  }
  return null;
}

/** Preserve the field verbatim; never truncate a recognized segment to fit. */
export function appendSpeechText(
  current: string,
  transcript: string,
  maxLength = 4000,
): { value: string; overflow: string } {
  const segment = transcript.trim();
  if (!segment) return { value: current, overflow: "" };
  const separator = current && !current.endsWith("\n") ? "\n" : "";
  const value = `${current}${separator}${segment}`;
  // String.length matches textarea maxLength (UTF-16 code units).
  return value.length <= maxLength
    ? { value, overflow: "" }
    : { value: current, overflow: transcript };
}

function errorReason(error: unknown): SpeechEndReason {
  const item = error as { error?: unknown; name?: unknown } | null;
  const name = typeof error === "string" ? error : item?.error || item?.name;
  switch (name) {
    case "no-speech":
    case "not-allowed":
    case "service-not-allowed":
    case "audio-capture":
    case "network":
    case "language-not-supported":
      return name;
    case "aborted":
    case "AbortError":
      return "cancelled";
    case "NotAllowedError":
      return "not-allowed";
    case "SecurityError":
      return "service-not-allowed";
    case "NotFoundError":
      return "audio-capture";
    case "NetworkError":
      return "network";
    case "NotSupportedError":
      return "unsupported";
    default:
      return "unknown";
  }
}

/** A single user-triggered recognition attempt; create a fresh session to retry. */
export function createSpeechSession(options: SpeechSessionOptions): {
  start: (lang: string) => void;
  stop: () => void;
  cancel: () => void;
  dispose: () => void;
} {
  const timers: SpeechTimers = options.timers || {
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) =>
      globalThis.clearTimeout(
        handle as ReturnType<typeof globalThis.setTimeout>,
      ),
  };
  let recognition: RecognitionLike | null = null;
  let state: SpeechState = "idle";
  let used = false;
  let ended = false;
  let disposed = false;
  let hasFinal = false;
  let preview = "";
  let startTimer: unknown = null;
  let durationTimer: unknown = null;
  let stopTimer: unknown = null;
  const finalIndices = new Set<number>();

  const active = () => used && !ended && !disposed;
  const isListening = () => state === "listening";
  const reportState = (next: SpeechState) => {
    if (state === next) return;
    state = next;
    if (!disposed) options.onState(next);
  };
  const reportInterim = (next: string) => {
    if (preview === next) return;
    preview = next;
    if (!disposed) options.onInterim(next);
  };
  const clearTimers = () => {
    for (const timer of [startTimer, durationTimer, stopTimer])
      if (timer !== null) timers.clearTimeout(timer);
    startTimer = durationTimer = stopTimer = null;
  };
  const detach = () => {
    if (!recognition) return;
    recognition.onstart = null;
    recognition.onend = null;
    recognition.onerror = null;
    recognition.onresult = null;
  };
  const abort = () => {
    try {
      recognition?.abort();
    } catch {
      // The terminal state must remain usable even if the host rejects abort.
    }
  };
  const finish = (reason: SpeechEndReason, shouldAbort = false) => {
    if (!active()) return;
    // Mark terminal before touching the browser: abort can emit synchronously.
    ended = true;
    clearTimers();
    detach();
    if (shouldAbort) abort();
    reportInterim("");
    reportState("idle");
    if (!disposed) options.onEnd(reason);
  };
  const stop = () => {
    if (!active() || state === "stopping") return;
    clearTimers();
    reportState("stopping");
    if (!active()) return;
    // Install the deadline before stop, which may synchronously call onend.
    stopTimer = timers.setTimeout(() => finish("stop-timeout", true), 3000);
    try {
      recognition?.stop();
    } catch (error) {
      finish(errorReason(error), true);
    }
  };

  return {
    start(lang) {
      if (used || disposed) return;
      used = true;
      reportState("starting");
      if (!active()) return;
      try {
        recognition = options.createRecognition();
        recognition.lang = lang;
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.maxAlternatives = 1;
        recognition.onstart = () => {
          if (!active() || state !== "starting") return;
          if (startTimer !== null) timers.clearTimeout(startTimer);
          startTimer = null;
          reportState("listening");
          if (active() && isListening())
            durationTimer = timers.setTimeout(stop, 120000);
        };
        recognition.onend = () => finish(hasFinal ? "done" : "no-speech");
        recognition.onerror = (event) => finish(errorReason(event), true);
        recognition.onresult = (event) => {
          if (!active()) return;
          const interim: string[] = [];
          let shouldStop = false;
          // Inspect the full current list: interim entries can shrink or change.
          for (let index = 0; index < event.results.length; index++) {
            if (!active()) return;
            const result = event.results[index];
            if (!result || finalIndices.has(index)) continue;
            const transcript = result[0]?.transcript?.trim() || "";
            if (result.isFinal) {
              finalIndices.add(index);
              if (!transcript) continue;
              hasFinal = true;
              if (!options.onFinal(transcript)) shouldStop = true;
            } else if (transcript) interim.push(transcript);
          }
          if (active()) reportInterim(interim.join(" "));
          // Deliver the complete batch before stop, which may end synchronously.
          if (shouldStop) stop();
        };
        startTimer = timers.setTimeout(
          () => finish("start-timeout", true),
          15000,
        );
        recognition.start();
      } catch (error) {
        finish(errorReason(error), true);
      }
    },
    stop,
    cancel() {
      finish("cancelled", true);
    },
    dispose() {
      if (disposed) return;
      const shouldAbort = active();
      disposed = true;
      ended = true;
      clearTimers();
      detach();
      if (shouldAbort) abort();
    },
  };
}
