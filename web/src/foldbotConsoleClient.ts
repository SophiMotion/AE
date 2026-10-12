/** The original console owns the device protocol; this client only owns its lease. */
export const CONSOLE_CHANNEL = "ae-foldbot-console";
export interface ConsoleReservation {
  session_id: string;
  ws_path: string;
  lease_ms: number;
  attach_timeout_ms: number;
  phase: "reserved";
}
export interface ConsoleStopResult {
  ok: boolean;
  connection_was_open: boolean;
  stop_command_sent: boolean | null;
  transport_closed: boolean | null;
  physical_stop_verified: false;
}
export interface ConsoleStopReply {
  ok: boolean;
  stop_result?: ConsoleStopResult;
}
export interface ConsoleApi {
  reserve(address: string, confirmed: boolean): Promise<ConsoleReservation>;
  stop(sessionId: string): Promise<ConsoleStopReply>;
}

export interface ConsoleEventRecord {
  operation: string;
  reason: string;
  time_ms: number | null;
}

/** Explicit read only; called by the operator's refresh button, never on mount. */
export async function readConsoleEvents(options: {
  publicMode: boolean;
  fetcher?: typeof fetch;
}): Promise<ConsoleEventRecord[]> {
  if (options.publicMode) throw new Error("public_preview_only");
  const response = await (options.fetcher ?? fetch)(
    "/api/foldbot/console/events",
    {
      credentials: "same-origin",
      cache: "no-store",
    },
  );
  if (!response.ok) throw new Error("console_events_unavailable");
  const body: unknown = await response.json();
  if (
    !body ||
    typeof body !== "object" ||
    !("items" in body) ||
    !Array.isArray(body.items)
  )
    throw new Error("invalid_console_events");
  return body.items
    .slice(0, 100)
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      operation:
        typeof item.operation === "string"
          ? item.operation.slice(0, 80)
          : "unknown",
      reason:
        typeof item.reason === "string" ? item.reason.slice(0, 160) : "unknown",
      time_ms:
        typeof item.time_ms === "number" && Number.isFinite(item.time_ms)
          ? item.time_ms
          : null,
    }));
}

export function createConsoleApi(options: {
  publicMode: boolean;
  fetcher?: typeof fetch;
  beacon?: (url: string, body: Blob) => boolean;
}): ConsoleApi {
  const request = async (path: string, body: object, keepalive = false) => {
    if (options.publicMode) throw new Error("public_preview_only");
    const response = await (options.fetcher ?? fetch)(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
      keepalive,
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`console_http_${response.status}`);
    return response.json();
  };
  return {
    reserve: (address, confirmed) => {
      if (!confirmed) return Promise.reject(new Error("confirmation_required"));
      return request("/api/foldbot/console/sessions", { address, confirmed });
    },
    async stop(sessionId) {
      if (options.publicMode) throw new Error("public_preview_only");
      const body = { session_id: sessionId };
      try {
        return await request("/api/foldbot/console/stop", body, true);
      } catch (error) {
        // A queued beacon is a best-effort revocation, never a STOP acknowledgement.
        try {
          options.beacon?.(
            "/api/foldbot/console/stop",
            new Blob([JSON.stringify(body)], { type: "application/json" }),
          );
        } catch {
          // The browser may reject both transports while closing.
        }
        throw error;
      }
    },
  };
}

export type ConsolePhase =
  "preview" | "reserving" | "attaching" | "connected" | "stopping" | "closed";
export interface ConsoleSnapshot {
  phase: ConsolePhase;
  ready: boolean;
  busy: boolean;
  reason: string;
  error: string;
  stopResult: ConsoleStopResult | null;
}
export const initialConsoleSnapshot: ConsoleSnapshot = {
  phase: "preview",
  ready: false,
  busy: false,
  reason: "preview",
  error: "",
  stopResult: null,
};
type ConsolePacket = {
  channel: typeof CONSOLE_CHANNEL;
  type: "attach" | "detach";
  session_id?: string;
  ws_path?: string;
};
type ConsoleFrame = {
  postMessage(message: ConsolePacket, origin: string): void;
};

function stopEvidence(value: unknown): ConsoleStopResult | null {
  if (!value || typeof value !== "object") return null;
  const result = value as Record<string, unknown>;
  if (typeof result.ok !== "boolean") return null;
  return {
    ok: result.ok,
    connection_was_open: result.connection_was_open === true,
    stop_command_sent:
      typeof result.stop_command_sent === "boolean"
        ? result.stop_command_sent
        : null,
    transport_closed:
      typeof result.transport_closed === "boolean"
        ? result.transport_closed
        : null,
    physical_stop_verified: false,
  };
}

/** Tokens live only here and in same-origin postMessage; never in URLs or storage. */
export class FoldBotConsoleSession {
  private token: string | null = null;
  private epoch = 0;
  private disposed = false;
  private reserving = false;
  private stopping = 0;
  private loadedFrame: ConsoleFrame | null = null;
  private readyFrame: ConsoleFrame | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private snapshot: ConsoleSnapshot = { ...initialConsoleSnapshot };
  private options: {
    publicMode: boolean;
    api: ConsoleApi;
    origin: string;
    frame: () => ConsoleFrame | null;
    resetFrame: () => void;
    notify: (snapshot: ConsoleSnapshot) => void;
    handshakeTimeoutMs?: number;
  };

  constructor(options: FoldBotConsoleSession["options"]) {
    this.options = options;
  }

  private publish(patch: Partial<ConsoleSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    if (!this.disposed) this.options.notify(this.snapshot);
  }

  frameLoaded() {
    if (this.disposed || this.options.publicMode) return;
    const frame = this.options.frame();
    // Navigating/reloading an active embedded document always forfeits its lease.
    if (this.loadedFrame && (this.token || this.reserving)) {
      void this.stop("frame_reloaded");
      return;
    }
    this.loadedFrame = frame;
    this.publish({ ready: !!frame && this.readyFrame === frame });
  }

  receive(event: { source: unknown; origin: string; data: unknown }) {
    if (this.disposed || this.options.publicMode) return;
    const frame = this.options.frame();
    if (
      !frame ||
      event.source !== frame ||
      event.origin !== this.options.origin
    )
      return;
    if (!event.data || typeof event.data !== "object") return;
    const packet = event.data as Record<string, unknown>;
    if (packet.channel !== CONSOLE_CHANNEL) return;
    if (packet.type === "ready") {
      if (this.token) {
        void this.stop("frame_reloaded");
        return;
      }
      this.readyFrame = frame;
      this.publish({ ready: this.loadedFrame === frame });
      return;
    }
    if (!this.token || this.loadedFrame !== frame) return;
    if (packet.session_id !== undefined && packet.session_id !== this.token)
      return;
    if (packet.type === "connected" && this.snapshot.phase === "attaching") {
      this.clearTimer();
      this.publish({ phase: "connected", busy: false, reason: "connected" });
    } else if (packet.type === "closed" || packet.type === "error") {
      // Revoke server-side as well; an iframe message alone does not release ownership.
      void this.stop(
        packet.type === "closed" ? "connection_closed" : "connection_failed",
      );
    }
  }

  async connect(address: string, confirmed: boolean) {
    if (
      this.options.publicMode ||
      this.disposed ||
      !confirmed ||
      !address.trim() ||
      !this.snapshot.ready ||
      this.token ||
      this.reserving ||
      this.stopping
    )
      return;
    const epoch = ++this.epoch;
    this.reserving = true;
    this.publish({
      phase: "reserving",
      busy: true,
      reason: "connecting",
      error: "",
      stopResult: null,
    });
    try {
      // Do not abort this request on leave: its late token still needs revocation.
      const response = await this.options.api.reserve(address.trim(), true);
      const validToken =
        typeof response.session_id === "string" && !!response.session_id;
      if (epoch !== this.epoch || this.disposed) {
        if (validToken) await this.revoke(response.session_id);
        return;
      }
      if (
        !validToken ||
        response.ws_path !== "/api/foldbot/console/ws" ||
        response.phase !== "reserved"
      ) {
        if (validToken) await this.revoke(response.session_id);
        this.publish({
          phase: "closed",
          reason: "connection_failed",
          error: "invalid_reservation",
        });
        return;
      }
      const frame = this.options.frame();
      if (!frame || frame !== this.loadedFrame || frame !== this.readyFrame) {
        await this.revoke(response.session_id);
        this.publish({
          phase: "closed",
          reason: "connection_failed",
          error: "console_not_ready",
        });
        return;
      }
      this.token = response.session_id;
      this.publish({ phase: "attaching", busy: true });
      this.timer = setTimeout(() => {
        if (epoch === this.epoch) void this.stop("connection_timeout");
      }, this.options.handshakeTimeoutMs ?? 8000);
      frame.postMessage(
        {
          channel: CONSOLE_CHANNEL,
          type: "attach",
          session_id: response.session_id,
          ws_path: response.ws_path,
        },
        this.options.origin,
      );
    } catch {
      if (epoch === this.epoch) {
        if (this.token) await this.stop("connection_failed");
        else
          this.publish({
            phase: "closed",
            reason: "connection_failed",
            error: "connection_failed",
          });
      }
    } finally {
      this.reserving = false;
      if (!this.token) {
        this.publish({
          busy: this.stopping > 0,
          phase: this.stopping ? "stopping" : "closed",
        });
      }
    }
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async revoke(token: string) {
    this.stopping++;
    try {
      const reply = await this.options.api.stop(token);
      const result = stopEvidence(reply.stop_result);
      this.publish({
        stopResult: result,
        error:
          reply.ok && result?.ok && result.transport_closed === true
            ? ""
            : "stop_unconfirmed",
      });
    } catch {
      this.publish({ error: "stop_unconfirmed" });
    } finally {
      this.stopping--;
    }
  }

  async stop(reason = "stopped") {
    if (this.options.publicMode) return;
    ++this.epoch;
    const token = this.token;
    const hadSession = !!token || this.reserving;
    this.token = null;
    this.clearTimer();
    if (hadSession) {
      try {
        this.options
          .frame()
          ?.postMessage(
            { channel: CONSOLE_CHANNEL, type: "detach" },
            this.options.origin,
          );
      } catch {
        // A removed child cannot block the independent server revocation.
      }
      this.loadedFrame = null;
      this.readyFrame = null;
      if (!this.disposed) this.options.resetFrame();
    }
    this.publish({
      phase: hadSession || this.stopping ? "stopping" : "closed",
      ready: hadSession ? false : this.snapshot.ready,
      busy: hadSession || this.stopping > 0,
      reason,
    });
    if (token) await this.revoke(token);
    this.publish({
      phase: this.reserving || this.stopping ? "stopping" : "closed",
      busy: this.reserving || this.stopping > 0,
    });
  }

  dispose() {
    this.disposed = true;
    void this.stop("page_left");
  }
}
