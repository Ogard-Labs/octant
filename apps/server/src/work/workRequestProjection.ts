import type {
  WorkRequest,
  WorkRequestFrame,
  WorkRequestId,
  WorkThreadId,
  ProjectId,
} from "@octant/contracts";

export interface WorkRequestEntry {
  readonly requestId: WorkRequestId;
  readonly request: WorkRequest;
  /** Private provider callback id; never returned from WorkRequest APIs. */
  readonly providerCallbackId?: string;
  /** Private provider option values; never returned from WorkRequest APIs. */
  readonly providerOptionValues?: ReadonlyArray<string>;
}

/**
 * Rebuildable in-memory Work request projection. The request service
 * replays journaled `WorkRequestFrame` events into this projection to
 * reconstruct pending and settled request state. The projection is
 * idempotent: replaying the same frame sequence produces identical state, so
 * reconnect or restart rebuilds request state from the authoritative event
 * journal without a separate store. Terminal requests (resolved, cancelled,
 * interrupted, expired) are retained so transition authority can fail closed
 * or settle idempotently on a replayed or stale command.
 */
export class WorkRequestProjection {
  readonly #entries = new Map<WorkRequestId, WorkRequestEntry>();

  apply(frame: WorkRequestFrame): void {
    const request = frame.request;
    const existing = this.#entries.get(request.requestId);
    // Ignore stale frames: a reconnect/duplicate subscription must never roll
    // a terminal request back to an earlier version.
    if (existing !== undefined && request.version <= existing.request.version) {
      return;
    }
    const providerOptionValues =
      frame.kind === "requested" ? frame.providerOptionValues : existing?.providerOptionValues;
    const providerCallbackId =
      frame.kind === "requested" ? frame.providerCallbackId : existing?.providerCallbackId;
    this.#entries.set(request.requestId, {
      requestId: request.requestId,
      request,
      ...(providerCallbackId === undefined ? {} : { providerCallbackId }),
      ...(providerOptionValues === undefined ? {} : { providerOptionValues }),
    });
  }

  lookup(requestId: WorkRequestId): WorkRequestEntry | undefined {
    return this.#entries.get(requestId);
  }

  /** All pending requests for a Project, most recently requested first. */
  listPending(projectId: ProjectId): ReadonlyArray<WorkRequest> {
    return [...this.#entries.values()]
      .map((entry) => entry.request)
      .filter(
        (request) =>
          String(request.projectId) === String(projectId) && request.status === "pending",
      )
      .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt));
  }

  /** All requests (pending or settled) for one Project-scoped Work thread. */
  listForThread(projectId: ProjectId, threadId: WorkThreadId): ReadonlyArray<WorkRequest> {
    return [...this.#entries.values()]
      .map((entry) => entry.request)
      .filter(
        (request) =>
          String(request.projectId) === String(projectId) &&
          String(request.threadId) === String(threadId),
      )
      .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt));
  }

  snapshot(): ReadonlyMap<WorkRequestId, WorkRequestEntry> {
    return new Map(this.#entries);
  }
}
