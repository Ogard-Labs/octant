import {
  decodeFleetActivity,
  MAX_FLEET_ACTIVITY_THREADS,
  MAX_FLEET_ACTIVITY_TITLE_LENGTH,
  type FleetActivity,
  type FleetActivitySource,
  type PendingRequest,
  type PendingRequestList,
  type ProductSurfaceSettings,
  type ProjectId,
  type WindowId,
} from "@octant/contracts";
import { enabledModes } from "@octant/domain";

/** A thread whose turn the journal projects as queued or running. */
export interface FleetRunningThread {
  readonly threadId: string;
  readonly title: string;
  readonly projectId?: ProjectId;
  readonly turnStartedAt?: string;
}

/** A row before the contract brands its timestamp; the final decode checks every field. */
interface FleetRow {
  readonly mode: "chat" | "work" | "code";
  readonly threadId: string;
  readonly title: string;
  readonly projectName?: string;
  readonly state: "needs-you" | "working";
  readonly activitySource: FleetActivitySource;
  readonly since?: string;
}

export interface FleetActivitySources {
  readonly readSettings: () => ProductSurfaceSettings;
  /** The same read `/api/pending-requests` serves this window. */
  readonly pending: (windowId: WindowId) => Promise<PendingRequestList>;
  /** Running threads from each mode's own navigation read, under that read's access check. */
  readonly chat: () => ReadonlyArray<FleetRunningThread>;
  readonly work: (windowId: WindowId) => Promise<ReadonlyArray<FleetRunningThread>>;
  readonly code: (windowId: WindowId) => Promise<ReadonlyArray<FleetRunningThread>>;
  /**
   * Local windows whose persisted workspace binds a Code Project. Code reach is
   * per bound window, and the menu bar's own window binds none, so its Code
   * needs-you rows are what each of these windows could answer.
   */
  readonly boundCodeWindows: () => ReadonlyArray<WindowId>;
  /** Code approvals, questions, and decisions this window could answer. */
  readonly codePending: (windowId: WindowId) => Promise<ReadonlyArray<PendingRequest>>;
  /**
   * Local windows whose persisted workspace binds a Work or Code Project. A
   * subagent's wait is visible only to a window bound to the parent's project,
   * and the menu bar's own window binds none, so its rows are what each of
   * these windows already lists.
   */
  readonly boundProjectWindows: () => ReadonlyArray<WindowId>;
  /** Child approvals and questions this window could open. Answering stays on the session route. */
  readonly childPending: (windowId: WindowId) => Promise<ReadonlyArray<PendingRequest>>;
  readonly projectName: (projectId: ProjectId) => string | undefined;
}

/**
 * Which threads need the person and which are running, across modes, for the
 * menu bar. It adds no authority and no state of its own: needs-you is the
 * pending-request read, plus the Code requests and the subagent waits each
 * persisted local window could already open. Working is each mode's journaled
 * run state, and a thread that is both is listed once as needs-you, because a
 * held turn is still running while it waits on an answer.
 */
export class FleetActivityService {
  readonly #sources: FleetActivitySources;

  constructor(sources: FleetActivitySources) {
    this.#sources = sources;
  }

  async list(windowId: WindowId): Promise<FleetActivity> {
    const modes = enabledModes(this.#sources.readSettings());
    const [pending, boundCode, boundChildren, work, code] = await Promise.all([
      this.#sources.pending(windowId),
      Promise.all(
        this.#sources.boundCodeWindows().map((bound) => this.#sources.codePending(bound)),
      ),
      Promise.all(
        this.#sources.boundProjectWindows().map((bound) => this.#sources.childPending(bound)),
      ),
      modes.includes("work") ? this.#sources.work(windowId) : [],
      this.#sources.code(windowId),
    ]);
    const chat = modes.includes("chat") ? this.#sources.chat() : [];

    const rows = new Map<string, FleetRow>();
    for (const request of [
      ...pending.requests,
      ...boundCode.flat(),
      ...boundChildren.flat().filter((request) => modes.includes(request.mode)),
    ]) {
      const key = `${request.mode}:${String(request.threadId)}`;
      if (rows.has(key)) continue;
      rows.set(
        key,
        this.#row({
          mode: request.mode,
          threadId: String(request.threadId),
          title: request.threadTitle,
          ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
          state: "needs-you",
          activitySource: pendingRequestSource(request),
          since: request.requestedAt,
        }),
      );
    }
    const working: FleetRow[] = [];
    for (const [mode, threads] of [
      ["chat", chat],
      ["work", work],
      ["code", code],
    ] as const) {
      for (const thread of threads) {
        if (rows.has(`${mode}:${thread.threadId}`)) continue;
        working.push(
          this.#row({
            mode,
            threadId: thread.threadId,
            title: thread.title,
            ...(thread.projectId === undefined ? {} : { projectId: thread.projectId }),
            state: "working",
            activitySource: "journal",
            ...(thread.turnStartedAt === undefined ? {} : { since: thread.turnStartedAt }),
          }),
        );
      }
    }
    working.sort(
      (left, right) =>
        (left.since ?? "").localeCompare(right.since ?? "") ||
        `${left.mode}:${left.threadId}`.localeCompare(`${right.mode}:${right.threadId}`),
    );
    const ordered = [...rows.values(), ...working];
    return decodeFleetActivity({
      threads: ordered.slice(0, MAX_FLEET_ACTIVITY_THREADS),
      truncated: pending.truncated || ordered.length > MAX_FLEET_ACTIVITY_THREADS,
    });
  }

  #row(input: Omit<FleetRow, "projectName"> & { readonly projectId?: ProjectId }): FleetRow {
    const projectName = bounded(
      input.projectId === undefined ? undefined : this.#sources.projectName(input.projectId),
    );
    return {
      mode: input.mode,
      threadId: input.threadId,
      title: bounded(input.title) ?? "Untitled",
      ...(projectName === undefined ? {} : { projectName }),
      state: input.state,
      activitySource: input.activitySource,
      ...(input.since === undefined ? {} : { since: input.since }),
    };
  }
}

/**
 * The running threads in a Work or Code navigation read: the rows its runtime
 * sidecar reports executing, which that read already folds from journaled
 * turns and runtime work. An archived row is never running work to show.
 */
export function runningThreadsFromNavigation(navigation: {
  readonly threads: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly projectId: ProjectId;
    readonly lifecycle: string;
  }>;
  readonly runtime: ReadonlyArray<{
    readonly threadId: string;
    readonly executing: boolean;
    readonly turnStartedAt?: string | undefined;
  }>;
}): ReadonlyArray<FleetRunningThread> {
  const running = new Map(
    navigation.runtime
      .filter((entry) => entry.executing)
      .map((entry) => [String(entry.threadId), entry] as const),
  );
  return navigation.threads.flatMap((thread) => {
    const live = running.get(String(thread.id));
    if (live === undefined || thread.lifecycle === "archived") return [];
    return [
      {
        threadId: String(thread.id),
        title: thread.title,
        projectId: thread.projectId,
        ...(live.turnStartedAt === undefined ? {} : { turnStartedAt: live.turnStartedAt }),
      },
    ];
  });
}

/**
 * A Work request and any finished turn's decision are journaled records; a
 * Code approval or question and a Chat question live in the provider session
 * that is parked on them. A subagent's wait is read from the parent thread's
 * live harness session in every mode.
 */
function pendingRequestSource(request: PendingRequest): FleetActivitySource {
  if (request.kind === "child-approval" || request.kind === "child-question") return "session";
  if (request.kind === "decision" || request.mode === "work") return "journal";
  return "session";
}

function bounded(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  if (trimmed === undefined || trimmed.length === 0) return undefined;
  return trimmed.length > MAX_FLEET_ACTIVITY_TITLE_LENGTH
    ? `${trimmed.slice(0, MAX_FLEET_ACTIVITY_TITLE_LENGTH - 1)}…`
    : trimmed;
}
