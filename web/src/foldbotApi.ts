/** FoldBot has its own project and control API. Public builds may read only the fixture. */
import { normalizeFoldBotFlow, normalizeFoldBotDraftFlow, validateFoldBotFlow, type FoldBotFlowConfig } from "./foldbotFlow.ts";
export type { FoldBotFlowConfig } from "./foldbotFlow.ts";
export interface FoldBotDraft {
  name: string;
  request: string;
  drive_level: number;
  drive_duration_ms: number;
  workflow?: FoldBotFlowConfig;
}
export interface FoldBotFile {
  path: string;
  type: string;
  purpose: string;
  sha256: string;
  bytes: number;
}
export interface FoldBotEvidence {
  source_generated: boolean;
  compiled: boolean;
  flashed: boolean;
  ros_executed: boolean;
  hardware_verified: boolean;
}
export interface FoldBotSource {
  path: string;
  original_sha256: string;
  sanitized_sha256: string;
  transformation: string;
}
export interface FoldBotProject extends FoldBotDraft {
  id: string;
  revision: number;
  reviewed: boolean;
  created_at: string;
  updated_at: string;
  warnings: string[];
  generation: null | {
    id: string;
    revision: number;
    created_at: string;
    status: string;
    sha256: string;
    config_sha256: string;
    files: FoldBotFile[];
    source_provenance: FoldBotSource[];
    evidence: FoldBotEvidence;
  };
}
export interface FoldBotTemplate {
  id: string;
  name: string;
  summary: string;
  defaults: FoldBotDraft;
  modules: { id: string; name: string; description: string }[];
  warnings: string[];
  source_provenance: FoldBotSource[];
  evidence: FoldBotEvidence;
}
export interface FoldBotPreview {
  path: string;
  content: string;
  sha256: string;
  type: string;
  purpose: string;
  revision: number;
}
export interface FoldBotReference {
  schema_version: 1;
  label: string;
  template: FoldBotTemplate;
  project: FoldBotProject;
  previews: Record<string, FoldBotPreview>;
  archive_url?: string;
}
export interface FoldBotDeviceState {
  phase?: string;
  connected: boolean;
  enabled: boolean;
  fresh: boolean;
  fault: unknown;
  frame_age_ms?: number | null;
  firmware?: string | Record<string, unknown> | null;
  physical_completion_verified: false;
  stop_result?: { ok?: boolean; reason?: string; data?: unknown } | null;
  [key: string]: unknown;
}
export interface FoldBotControlReply {
  ok: boolean;
  reason: string;
  session_id?: string | null;
  lease_ms?: number;
  state: FoldBotDeviceState;
  physical_completion_verified: false;
}
export type FoldBotCommand =
  | { operation: "enable"; confirmed: true }
  | { operation: "drive"; linear: number; turn: number; duration_ms: number }
  | { operation: "fold"; direction: "fold" | "unfold" }
  | {
      operation: "confirm_endpoint";
      axis: 1 | 2;
      endpoint: "folded" | "unfolded";
      confirmed: true;
    }
  | { operation: "arm_step"; joint: number; direction: -1 | 1 };
export interface FoldBotConnect {
  project_id: string;
  revision: number;
  address: string;
  confirmed: true;
}

const env = (
  import.meta as ImportMeta & {
    env?: { VITE_PUBLIC_DEMO?: string; BASE_URL?: string };
  }
).env;
const builtPublic = env?.VITE_PUBLIC_DEMO === "true";

export class FoldBotApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export function createFoldBotApi(
  options: { publicMode?: boolean; fetcher?: typeof fetch } = {},
) {
  // A caller cannot turn hardware access on in a public build.
  const publicMode = builtPublic || options.publicMode === true;
  const fetcher =
    options.fetcher ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  async function request<T>(
    path: string,
    body?: unknown,
    method?: string,
    keepalive = false,
  ): Promise<T> {
    if (publicMode) throw new FoldBotApiError("public_reference_only", 403);
    const abort = new AbortController();
    const timeout = setTimeout(
      () => abort.abort(),
      path.endsWith("/heartbeat") ? 1200 : 15000,
    );
    try {
      const response = await fetcher(`/api/foldbot${path}`, {
        method: method ?? (body === undefined ? "GET" : "POST"),
        headers:
          body === undefined
            ? undefined
            : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "same-origin",
        signal: abort.signal,
        keepalive,
      });
      const data = await response.json();
      if (!response.ok) {
        const detail = data.detail ?? data.reason ?? "request_failed";
        throw new FoldBotApiError(
          typeof detail === "string" ? detail : JSON.stringify(detail),
          response.status,
        );
      }
      return data as T;
    } finally {
      clearTimeout(timeout);
    }
  }
  return {
    template: () => request<FoldBotTemplate>("/template"),
    projects: () => request<FoldBotProject[]>("/projects"),
    project: (id: string) =>
      request<FoldBotProject>(`/projects/${encodeURIComponent(id)}`),
    save: (draft: FoldBotDraft, project: FoldBotProject | null) =>
      request<FoldBotProject>(
        project ? `/projects/${encodeURIComponent(project.id)}` : "/projects",
        {
          ...draft,
          reviewed: false,
          ...(project ? { revision: project.revision } : {}),
        },
        project ? "PUT" : "POST",
      ),
    generate: (project: FoldBotProject) =>
      request<FoldBotProject>(
        `/projects/${encodeURIComponent(project.id)}/generate`,
        { revision: project.revision, reviewed: true },
      ),
    file: (id: string, path: string) =>
      request<FoldBotPreview>(
        `/projects/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`,
      ),
    exportUrl: (id: string) =>
      publicMode
        ? null
        : `/api/foldbot/projects/${encodeURIComponent(id)}/export`,
    connect: (body: FoldBotConnect) =>
      request<FoldBotControlReply>("/control/connect", body),
    heartbeat: (session_id: string) =>
      request<FoldBotControlReply>("/control/heartbeat", { session_id }),
    command: (session_id: string, seq: number, command: FoldBotCommand) =>
      request<FoldBotControlReply>("/control/command", {
        session_id,
        seq,
        ...command,
      }),
    stop: (session_id: string) =>
      request<FoldBotControlReply>(
        "/control/stop",
        { session_id },
        "POST",
        true,
      ),
    reference: async () => {
      const response = await fetcher(
        `${env?.BASE_URL ?? "/"}foldbot-example.json`,
        { credentials: "same-origin" },
      );
      if (!response.ok) throw new Error("reference_unavailable");
      return response.json() as Promise<FoldBotReference>;
    },
  };
}

export const foldbotApi = createFoldBotApi();
export type FoldBotApi = ReturnType<typeof createFoldBotApi>;
export interface FoldBotSessionSnapshot {
  active: boolean;
  busy: boolean;
  state: FoldBotDeviceState | null;
  reason: string;
  error: string;
}

/** Owns a single lease. Epochs discard late replies after STOP, hide or unmount. */
export class FoldBotSession {
  private token: string | null = null;
  private epoch = 0;
  private sequence = 0;
  private disposed = false;
  private renewBusy = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private snapshot: FoldBotSessionSnapshot = {
    active: false,
    busy: false,
    state: null,
    reason: "",
    error: "",
  };
  private api: Pick<FoldBotApi, "connect" | "heartbeat" | "command" | "stop">;
  private notify: (snapshot: FoldBotSessionSnapshot) => void;
  constructor(
    api: Pick<FoldBotApi, "connect" | "heartbeat" | "command" | "stop">,
    notify: (snapshot: FoldBotSessionSnapshot) => void,
  ) {
    this.api = api;
    this.notify = notify;
  }
  private publish(patch: Partial<FoldBotSessionSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    if (!this.disposed) this.notify(this.snapshot);
  }
  async connect(body: FoldBotConnect) {
    if (this.disposed || this.token || this.snapshot.busy) return;
    const epoch = ++this.epoch;
    this.publish({ busy: true, error: "", reason: "connecting" });
    try {
      const response = await this.api.connect(body);
      if (epoch !== this.epoch || this.disposed) {
        if (response.session_id)
          void this.api.stop(response.session_id).catch(() => undefined);
        return;
      }
      if (!response.ok || !response.session_id)
        throw new Error(response.reason);
      this.token = response.session_id;
      this.sequence = 0;
      this.publish({
        active: true,
        busy: false,
        state: response.state,
        reason: response.reason,
      });
      this.timer = setInterval(() => {
        void this.renew(epoch);
      }, 500);
      void this.renew(epoch);
    } catch (error) {
      if (epoch === this.epoch)
        this.publish({
          busy: false,
          active: false,
          error: error instanceof Error ? error.message : "connection_failed",
        });
    }
  }
  private async renew(epoch: number) {
    if (!this.token || this.renewBusy || epoch !== this.epoch || this.disposed)
      return;
    const token = this.token;
    this.renewBusy = true;
    try {
      const response = await this.api.heartbeat(token);
      if (epoch !== this.epoch || token !== this.token) return;
      if (!response.ok) throw new Error(response.reason);
      this.publish({
        state: response.state,
        reason:
          this.snapshot.reason === "connecting" &&
          response.state.phase === "connected"
            ? "connected_disabled"
            : this.snapshot.reason,
      });
    } catch (error) {
      if (epoch === this.epoch) {
        void this.stop("lease_lost");
        this.publish({
          error: error instanceof Error ? error.message : "lease_lost",
        });
      }
    } finally {
      if (epoch === this.epoch) this.renewBusy = false;
    }
  }
  async command(command: FoldBotCommand) {
    if (!this.token || this.snapshot.busy || this.disposed) return;
    const token = this.token;
    const epoch = this.epoch;
    this.publish({ busy: true, error: "" });
    try {
      const response = await this.api.command(token, ++this.sequence, command);
      if (epoch !== this.epoch || token !== this.token) return;
      if (!response.ok) throw new Error(response.reason);
      this.publish({
        state: response.state,
        reason: response.reason,
        busy: false,
      });
    } catch (error) {
      if (epoch === this.epoch) {
        void this.stop("command_failed_no_retry");
        this.publish({
          error:
            error instanceof Error ? error.message : "command_failed_no_retry",
        });
      }
    }
  }
  async stop(reason = "stopped") {
    const epoch = ++this.epoch;
    const token = this.token;
    this.token = null;
    this.renewBusy = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.publish({ active: false, busy: false, state: null, reason });
    if (token) {
      try {
        const response = await this.api.stop(token);
        if (epoch !== this.epoch) return;
        // The top-level reply confirms lease revocation, not delivery of STOP.
        // Keep the transport result visible even after the local token is cleared.
        this.publish({
          state: response.state,
          ...(response.ok && response.state.stop_result?.ok === true
            ? {}
            : { error: "stop_unconfirmed_lease_expiry" }),
        });
      } catch {
        if (epoch === this.epoch)
          this.publish({ error: "stop_unconfirmed_lease_expiry" });
      }
    }
  }
  dispose() {
    this.disposed = true;
    void this.stop("page_left");
  }
}

export function draftMatchesProject(
  draft: FoldBotDraft,
  project: FoldBotProject | null,
) {
  return (
    !!project &&
    draft.name.trim() === project.name.trim() &&
    draft.request.trim() === project.request.trim() &&
    draft.drive_level === project.drive_level &&
    draft.drive_duration_ms === project.drive_duration_ms &&
    ((draft.workflow === undefined && project.workflow === undefined) ||
      (validateFoldBotFlow(draft.workflow) && validateFoldBotFlow(project.workflow) &&
        JSON.stringify(normalizeFoldBotFlow(draft.workflow)) === JSON.stringify(normalizeFoldBotFlow(project.workflow))))
  );
}

export interface FoldBotDraftBaseline {
  projectId: string | null;
  baseRevision: number | null;
}
export interface FoldBotCachedDraft extends FoldBotDraftBaseline {
  draft: FoldBotDraft;
}

/**
 * Merge only the baseline of this exact acknowledged save. A late response must
 * preserve more recent (even temporarily invalid) typing and cannot bind another
 * project's cache or roll back a baseline advanced by a later save.
 * null means the caller must leave storage untouched.
 */
export function mergeFoldBotSavedCache(
  cached: FoldBotCachedDraft | null,
  previousProject: FoldBotProject | null,
  saved: FoldBotProject,
): FoldBotCachedDraft | null {
  if (!cached || !saved.id || !Number.isSafeInteger(saved.revision)) return null;
  if (previousProject) {
    if (
      cached.projectId !== previousProject.id ||
      cached.baseRevision !== previousProject.revision ||
      saved.id !== previousProject.id ||
      (saved.revision !== previousProject.revision &&
        saved.revision !== previousProject.revision + 1)
    ) return null;
  } else if (
    cached.projectId !== null || cached.baseRevision !== null || saved.revision !== 1
  ) return null;
  return {
    draft: cached.draft,
    projectId: saved.id,
    baseRevision: saved.revision,
  };
}

/** A server lookup must never promote the revision on which a browser draft was based. */
export function restoreFoldBotDraft(
  cached: FoldBotCachedDraft | null,
  projects: FoldBotProject[],
  defaults: FoldBotDraft,
) {
  const project = cached
    ? (projects.find((item) => item.id === cached.projectId) ?? null)
    : (projects[0] ?? null);
  const source = cached?.draft ?? project ?? defaults;
  const draft: FoldBotDraft = {
    name: source.name,
    request: source.request,
    drive_level: source.drive_level,
    drive_duration_ms: source.drive_duration_ms,
    ...(source.workflow === undefined ? {} : { workflow: normalizeFoldBotDraftFlow(source.workflow) }),
  };
  const baseline: FoldBotDraftBaseline = cached
    ? {
        projectId: cached.projectId ?? null,
        baseRevision: cached.baseRevision ?? null,
      }
    : {
        projectId: project?.id ?? null,
        baseRevision: project?.revision ?? null,
      };
  const conflict =
    !!cached &&
    !!project &&
    baseline.baseRevision !== project.revision &&
    !draftMatchesProject(draft, project);
  return { draft, project, baseline, conflict };
}

export function validateFoldBotDraft(draft: FoldBotDraft) {
  return (
    !!draft.name.trim() &&
    draft.name.trim().length <= 120 &&
    !!draft.request.trim() &&
    draft.request.length <= 12000 &&
    !draft.name.includes("\0") &&
    !draft.request.includes("\0") &&
    Number.isInteger(draft.drive_level) &&
    draft.drive_level >= 1 &&
    draft.drive_level <= 20 &&
    Number.isInteger(draft.drive_duration_ms) &&
    draft.drive_duration_ms >= 1 &&
    draft.drive_duration_ms <= 2000 &&
    (draft.workflow === undefined || validateFoldBotFlow(draft.workflow))
  );
}
