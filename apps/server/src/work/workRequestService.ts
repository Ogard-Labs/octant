import { Schema } from "effect";
import {
  EventActor,
  UtcTimestamp,
  decodeWorkRequest,
  decodeWorkRequestId,
  type WorkRequest,
  type WorkRequestCommand,
  type WorkRequestDelivery,
  type WorkRequestFailure,
  type WorkRequestFailureCode,
  type WorkRequestFrame,
  type WorkRequestId,
  type WorkRequestRecordInput,
  type WorkThreadId,
  type ProjectId,
  type ProviderInstanceId,
  type ProviderSessionId,
} from "@octant/contracts";
import {
  classifyWorkRequestProviderAuthority,
  classifyWorkRequestTransition,
  workRequestSettledIdempotently,
} from "@octant/domain";
import type { WorkRequestEntry, WorkRequestProjection } from "./workRequestProjection";

const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

export interface WorkRequestProjectPort {
  projectType(projectId: ProjectId): "chat" | "work" | "code" | "unknown";
  /** Returns true only while a Work Project can receive new requests. */
  isActiveWorkProject(projectId: ProjectId): boolean;
  workCanonicalRoot(projectId: ProjectId): string | undefined;
  threadProjectId(threadId: WorkThreadId): ProjectId | undefined;
  threadProviderInstanceId(threadId: WorkThreadId): ProviderInstanceId | undefined;
}

export interface WorkRequestEventStorePort {
  append(input: {
    readonly requestId: WorkRequestId;
    readonly expectedVersion: number;
    readonly frame: WorkRequestFrame;
    readonly occurredAt: typeof UtcTimestamp.Type;
    readonly actor: typeof EventActor.Type;
  }): WorkRequestFrame;
  replayAll():
    | { readonly status: "ok"; readonly frames: ReadonlyArray<WorkRequestFrame> }
    | {
        readonly status: "snapshot-required";
        readonly reason: "gap" | "identity-mismatch" | "invalid-frame";
      };
}

export interface WorkRequestProviderSessionPort {
  answerApproval(input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly sessionId: ProviderSessionId;
    readonly requestId: string;
    readonly approved: boolean;
  }): Promise<void>;
  answerUserInput(input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly sessionId: ProviderSessionId;
    readonly requestId: string;
    readonly answer: string;
  }): Promise<void>;
  /** End the provider-side wait before the local request is cancelled. */
  cancel(input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly sessionId: ProviderSessionId;
    readonly requestId: string;
    readonly kind: WorkRequest["detail"]["kind"];
  }): Promise<void>;
}

export interface WorkRequestServiceOptions {
  readonly projects: WorkRequestProjectPort;
  readonly projection: WorkRequestProjection;
  readonly eventStore: WorkRequestEventStorePort;
  readonly providerSessions?: Partial<WorkRequestProviderSessionPort>;
  readonly actor: typeof EventActor.Type;
  readonly clock: () => string;
}

export type WorkRequestServiceResult =
  | { readonly status: "ok"; readonly request: WorkRequest }
  | { readonly status: "failure"; readonly failure: WorkRequestFailure };

export class WorkRequestServiceError extends Error {
  override readonly name = "WorkRequestServiceError";
  readonly code: WorkRequestFailureCode;

  constructor(code: WorkRequestFailureCode, message: string) {
    super(message);
    this.code = code;
  }
}

function failure(code: WorkRequestFailureCode, message: string): WorkRequestServiceResult {
  return { status: "failure", failure: { code, message } as WorkRequestFailure };
}

function ok(request: WorkRequest): WorkRequestServiceResult {
  return { status: "ok", request: decodeWorkRequest(request) };
}

/**
 * Server-authoritative Work request service. Records durable, Project- and
 * thread-scoped pending-approval/user-input requests observed from a
 * provider's normalized runtime events, and settles them through resolution,
 * cancellation, interruption, or expiry. Every transition is journaled as a
 * versioned `work.request-recorded@1` event and applied to the rebuildable
 * projection; optimistic concurrency on `expectedVersion` rejects stale
 * commands, and every settle transition is idempotent so a retry, reconnect,
 * or restart never errors on an already-settled request. `record` is
 * server-internal (driven by the trusted provider turn runtime, never a
 * window-issued wire command); `resolve` and `cancel` require a `local-user`
 * actor because they are the user's own decision. Every operation re-checks
 * that the request's Project is a confined Work Project and that its
 * providerInstanceId still matches the thread's current provider before
 * mutating or exposing a request.
 */
export class WorkRequestService {
  readonly #projects: WorkRequestProjectPort;
  readonly #projection: WorkRequestProjection;
  readonly #eventStore: WorkRequestEventStorePort;
  readonly #providerSessions: WorkRequestProviderSessionPort;
  readonly #userActor: typeof EventActor.Type;
  readonly #systemActor: typeof EventActor.Type;
  readonly #clock: () => string;
  /** One process owns a pending external callback delivery at a time. */
  readonly #activeDeliveries = new Set<string>();

  constructor(options: WorkRequestServiceOptions) {
    this.#projects = options.projects;
    this.#projection = options.projection;
    this.#eventStore = options.eventStore;
    this.#providerSessions = {
      answerApproval: async () => undefined,
      answerUserInput: async () => undefined,
      cancel: async () => undefined,
      ...options.providerSessions,
    };
    this.#clock = options.clock;
    try {
      this.#userActor = Schema.decodeUnknownSync(EventActor)(options.actor);
      this.#systemActor = Schema.decodeUnknownSync(EventActor)({
        kind: "system",
        actorId: this.#userActor.actorId,
      });
    } catch {
      throw new WorkRequestServiceError("invalid", "Work request service actor is invalid.");
    }
  }

  /**
   * Replays all journaled request frames into the projection. Call once
   * after restart or reconnect before serving reads or responses; the
   * projection's stale-frame guard makes repeated calls idempotent.
   */
  hydrate(): void {
    const result = this.#eventStore.replayAll();
    if (result.status !== "ok") {
      throw new WorkRequestServiceError(
        "unavailable",
        "Work request hydration exceeded the journal scan cap; a snapshot rebuild is required.",
      );
    }
    for (const frame of result.frames) {
      this.#projection.apply(frame);
    }
  }

  /**
   * Records a newly observed provider approval or user-input request as a
   * new pending Work request. Idempotent on the complete provider callback
   * identity `(threadId, providerInstanceId, providerSessionId,
   * provider callback id, detail.kind)`: a redelivered event from the same
   * session returns the existing request, while a provider that reuses a
   * callback id after reconnect receives a new durable request.
   */
  record(input: WorkRequestRecordInput): WorkRequestServiceResult {
    const projectType = this.#projects.projectType(input.projectId);
    if (projectType === "unknown" || projectType !== "work") {
      return failure("not-found", "Work request Project is unknown.");
    }
    if (!this.#projects.isActiveWorkProject(input.projectId)) {
      return failure("unauthorized", "Work request Project is archived or unavailable.");
    }
    const canonicalRoot = this.#projects.workCanonicalRoot(input.projectId);
    if (canonicalRoot === undefined || canonicalRoot.length === 0) {
      return failure(
        "unauthorized",
        "Work canonical root is unavailable; the request cannot verify confinement authority.",
      );
    }
    const threadProjectId = this.#projects.threadProjectId(input.threadId);
    if (threadProjectId === undefined) {
      return failure("not-found", "Work request thread is unknown.");
    }
    if (String(threadProjectId) !== String(input.projectId)) {
      return failure(
        "unauthorized",
        "Work request thread does not belong to the recorded Project.",
      );
    }
    const threadProviderInstanceId = this.#projects.threadProviderInstanceId(input.threadId);
    if (
      classifyWorkRequestProviderAuthority({
        requestProviderInstanceId: input.providerInstanceId,
        threadProviderInstanceId,
      }) === "deny"
    ) {
      return failure(
        "unauthorized",
        "The recording provider does not match the thread's current provider.",
      );
    }

    const existing = this.#findByProviderCallbackId(
      input.threadId,
      input.providerInstanceId,
      input.providerSessionId,
      input.providerCallbackId,
      input.detail.kind,
    );
    if (existing !== undefined) return ok(existing.request);

    const requestedAt = decodeTimestamp(this.#clock());
    const request: WorkRequest = decodeWorkRequest({
      requestId: input.requestId,
      projectId: input.projectId,
      threadId: input.threadId,
      providerInstanceId: input.providerInstanceId,
      providerSessionId: input.providerSessionId,
      // The only renderer-visible provider reference is an Octant-owned,
      // bounded surrogate. The opaque provider callback remains below in the
      // private requested frame and projection entry.
      providerRequestId: String(input.requestId),
      detail: input.detail,
      status: "pending",
      requestedAt,
      version: 1,
    });
    const frame: WorkRequestFrame = {
      kind: "requested",
      request,
      providerCallbackId: input.providerCallbackId,
      ...(input.providerOptionValues === undefined
        ? {}
        : { providerOptionValues: input.providerOptionValues }),
    };
    try {
      this.#eventStore.append({
        requestId: request.requestId,
        expectedVersion: 0,
        frame,
        occurredAt: requestedAt,
        actor: this.#systemActor,
      });
    } catch {
      return failure(
        "unavailable",
        "Work request event journal could not be written through the authoritative flow.",
      );
    }
    this.#projection.apply(frame);
    return ok(request);
  }

  /** The user's resolution of a pending approval or user-input request. */
  async resolve(
    command: Extract<WorkRequestCommand, { kind: "resolve-work-request" }>,
  ): Promise<WorkRequestServiceResult> {
    if (this.#userActor.kind !== "local-user") {
      return failure(
        "unauthorized",
        "Resolving a Work request is user-initiated and requires a local-user actor.",
      );
    }
    const entry = this.#projection.lookup(command.requestId);
    if (entry === undefined) {
      return failure("not-found", "Work request was not found.");
    }
    if (classifyWorkRequestTransition({ currentStatus: entry.request.status }) === "deny") {
      if (
        workRequestSettledIdempotently({
          current: settledCurrent(entry.request),
          attempted: { kind: "resolved", resolution: command.resolution },
        })
      ) {
        return ok(entry.request);
      }
      return failure("conflict", "Only a pending Work request may be resolved.");
    }
    if (entry.request.detail.kind !== command.resolution.kind) {
      return failure("invalid", "The resolution kind does not match the request's detail kind.");
    }
    if (this.#providerAuthorityDenied(entry.request)) {
      return failure(
        "unauthorized",
        "The thread's provider has changed since this request was recorded.",
      );
    }
    const delivery: WorkRequestDelivery = { kind: "resolve", resolution: command.resolution };
    const prepared = this.#prepareDelivery(entry.request, command.expectedVersion, delivery);
    if (!("deliver" in prepared)) return prepared;
    if (!prepared.deliver) {
      return this.#settle(
        prepared.request,
        "resolved",
        { resolution: command.resolution },
        this.#userActor,
      );
    }
    try {
      try {
        if (command.resolution.kind === "approval") {
          await this.#providerSessions.answerApproval({
            providerInstanceId: prepared.request.providerInstanceId,
            sessionId: prepared.request.providerSessionId,
            requestId: providerCallbackId(entry),
            approved: command.resolution.approved,
          });
        } else {
          await this.#providerSessions.answerUserInput({
            providerInstanceId: prepared.request.providerInstanceId,
            sessionId: prepared.request.providerSessionId,
            requestId: providerCallbackId(entry),
            answer: providerAnswer(entry, command.resolution.answer),
          });
        }
      } catch {
        return this.#deliveryFailure(prepared.request, "resolution");
      }
      const confirmed = this.#confirmDelivery(prepared.request);
      if (confirmed.status !== "ok") return confirmed;
      return this.#settle(
        confirmed.request,
        "resolved",
        { resolution: command.resolution },
        this.#userActor,
      );
    } finally {
      this.#releaseActiveDelivery(prepared.request);
    }
  }

  /** The user cancels a pending approval or user-input request. */
  async cancel(
    command: Extract<WorkRequestCommand, { kind: "cancel-work-request" }>,
  ): Promise<WorkRequestServiceResult> {
    if (this.#userActor.kind !== "local-user") {
      return failure(
        "unauthorized",
        "Cancelling a Work request is user-initiated and requires a local-user actor.",
      );
    }
    const entry = this.#projection.lookup(command.requestId);
    if (entry === undefined) {
      return failure("not-found", "Work request was not found.");
    }
    if (classifyWorkRequestTransition({ currentStatus: entry.request.status }) === "deny") {
      if (
        workRequestSettledIdempotently({
          current: settledCurrent(entry.request),
          attempted: { kind: "cancelled" },
        })
      ) {
        return ok(entry.request);
      }
      return failure("conflict", "Only a pending Work request may be cancelled.");
    }
    if (this.#providerAuthorityDenied(entry.request)) {
      return failure(
        "unauthorized",
        "The thread's provider has changed since this request was recorded.",
      );
    }
    const prepared = this.#prepareDelivery(entry.request, command.expectedVersion, {
      kind: "cancel",
    });
    if (!("deliver" in prepared)) return prepared;
    if (!prepared.deliver) return this.#settle(prepared.request, "cancelled", {}, this.#userActor);
    try {
      try {
        await this.#providerSessions.cancel({
          providerInstanceId: prepared.request.providerInstanceId,
          sessionId: prepared.request.providerSessionId,
          requestId: providerCallbackId(entry),
          kind: prepared.request.detail.kind,
        });
      } catch {
        return this.#deliveryFailure(prepared.request, "cancellation");
      }
      const confirmed = this.#confirmDelivery(prepared.request);
      if (confirmed.status !== "ok") return confirmed;
      return this.#settle(confirmed.request, "cancelled", {}, this.#userActor);
    } finally {
      this.#releaseActiveDelivery(prepared.request);
    }
  }

  /**
   * System transition: the owning provider turn/session was interrupted.
   * Idempotent; never overwrites a request that already settled another way.
   */
  interrupt(requestId: WorkRequestId): WorkRequestServiceResult {
    return this.#systemSettle(requestId, "interrupted");
  }

  /**
   * System transition: the request exceeded its time-to-live without a user
   * decision. Idempotent; never overwrites a request that already settled
   * another way.
   */
  expire(requestId: WorkRequestId): WorkRequestServiceResult {
    return this.#systemSettle(requestId, "expired");
  }

  /**
   * Settles every pending request owned by a provider session after that
   * session reaches a terminal runtime state. The session is a UUID minted by
   * Octant, so it is a safe server-side grouping key and never renderer
   * authority. A terminal event may be redelivered; per-request settlement
   * remains idempotent.
   */
  interruptSession(sessionId: ProviderSessionId): ReadonlyArray<WorkRequestServiceResult> {
    return [...this.#projection.snapshot().values()]
      .filter(
        (entry) =>
          entry.request.status === "pending" &&
          !this.#activeDeliveries.has(String(entry.request.requestId)) &&
          String(entry.request.providerSessionId) === String(sessionId),
      )
      .map((entry) => this.#reconcileTerminalSessionRequest(entry.request));
  }

  /**
   * Settles pending requests for a Project after it is archived. Archiving
   * removes a Work Project's user authority, so retaining a pending request
   * would leave an invisible request that can never be answered.
   */
  interruptProject(projectId: ProjectId): ReadonlyArray<WorkRequestServiceResult> {
    return [...this.#projection.snapshot().values()]
      .filter(
        (entry) =>
          entry.request.status === "pending" &&
          String(entry.request.projectId) === String(projectId) &&
          !this.#activeDeliveries.has(String(entry.request.requestId)),
      )
      .map((entry) => this.#systemSettle(entry.request.requestId, "interrupted"));
  }

  /** Reconciles persisted requests that became invalid while the server was offline. */
  reconcileUnavailableRequests(): ReadonlyArray<WorkRequestServiceResult> {
    return [...this.#projection.snapshot().values()]
      .filter(
        (entry) =>
          entry.request.status === "pending" &&
          !this.#activeDeliveries.has(String(entry.request.requestId)) &&
          (!this.#projects.isActiveWorkProject(entry.request.projectId) ||
            this.#providerAuthorityDenied(entry.request)),
      )
      .map((entry) => this.#systemSettle(entry.request.requestId, "interrupted"));
  }

  /** Look up one request by id, regardless of status. */
  lookup(requestId: WorkRequestId): WorkRequest | undefined {
    return this.#projection.lookup(requestId)?.request;
  }

  /** Pending requests for a Project, most recently requested first. */
  listPending(projectId: ProjectId): ReadonlyArray<WorkRequest> {
    if (!this.#projects.isActiveWorkProject(projectId)) return [];
    return this.#projection
      .listPending(projectId)
      .filter((request) => !this.#providerAuthorityDenied(request));
  }

  /** All requests (pending or settled) for one Project-scoped Work thread. */
  listForThread(projectId: ProjectId, threadId: WorkThreadId): ReadonlyArray<WorkRequest> {
    if (!this.#projects.isActiveWorkProject(projectId)) return [];
    return this.#projection
      .listForThread(projectId, threadId)
      .filter((request) => request.status !== "pending" || !this.#providerAuthorityDenied(request));
  }

  #systemSettle(
    requestId: WorkRequestId,
    status: "interrupted" | "expired",
  ): WorkRequestServiceResult {
    const entry = this.#projection.lookup(requestId);
    if (entry === undefined) {
      return failure("not-found", "Work request was not found.");
    }
    if (classifyWorkRequestTransition({ currentStatus: entry.request.status }) === "deny") {
      if (
        workRequestSettledIdempotently({
          current: settledCurrent(entry.request),
          attempted: { kind: status },
        })
      ) {
        return ok(entry.request);
      }
      return failure(
        "conflict",
        `Only a pending Work request may be ${status === "interrupted" ? "interrupted" : "expired"}.`,
      );
    }
    return this.#settle(entry.request, status, {}, this.#systemActor);
  }

  #reconcileTerminalSessionRequest(request: WorkRequest): WorkRequestServiceResult {
    const delivery = request.delivery;
    if (delivery?.confirmed !== true) {
      return this.#systemSettle(request.requestId, "interrupted");
    }
    return delivery.kind === "resolve"
      ? this.#settle(request, "resolved", { resolution: delivery.resolution }, this.#userActor)
      : this.#settle(request, "cancelled", {}, this.#userActor);
  }

  #settle(
    current: WorkRequest,
    status: "resolved" | "cancelled" | "interrupted" | "expired",
    extra: { resolution?: WorkRequest["resolution"] },
    actor: typeof EventActor.Type,
  ): WorkRequestServiceResult {
    const settledAt = decodeTimestamp(this.#clock());
    const nextVersion = current.version + 1;
    const { delivery: _delivery, ...withoutDelivery } = current;
    const nextRequest: WorkRequest = decodeWorkRequest({
      ...withoutDelivery,
      status,
      settledAt,
      version: nextVersion,
      ...(extra.resolution === undefined ? {} : { resolution: extra.resolution }),
    });
    const frame: WorkRequestFrame = { kind: status, request: nextRequest } as WorkRequestFrame;
    try {
      this.#eventStore.append({
        requestId: current.requestId,
        expectedVersion: current.version,
        frame,
        occurredAt: settledAt,
        actor,
      });
    } catch {
      return failure(
        "unavailable",
        "Work request event journal could not be written through the authoritative flow.",
      );
    }
    this.#projection.apply(frame);
    return ok(nextRequest);
  }

  #providerAuthorityDenied(request: WorkRequest): boolean {
    const threadProviderInstanceId = this.#projects.threadProviderInstanceId(request.threadId);
    return (
      classifyWorkRequestProviderAuthority({
        requestProviderInstanceId: request.providerInstanceId,
        threadProviderInstanceId,
      }) === "deny"
    );
  }

  #prepareDelivery(
    current: WorkRequest,
    expectedVersion: number,
    delivery: WorkRequestDelivery,
  ):
    | { readonly status: "ok"; readonly request: WorkRequest; readonly deliver: boolean }
    | WorkRequestServiceResult {
    if (current.delivery !== undefined) {
      if (sameDelivery(current.delivery, delivery)) {
        if (current.delivery.confirmed === true) {
          return { status: "ok", request: current, deliver: false };
        }
        if (!this.#claimActiveDelivery(current)) {
          return failure("conflict", "Work request delivery is already in progress.");
        }
        return { status: "ok", request: current, deliver: true };
      }
      return failure("conflict", "A different Work request delivery is already being reconciled.");
    }
    if (current.version !== expectedVersion) {
      return failure("stale", "Work request version is stale.");
    }
    const prepared = decodeWorkRequest({
      ...current,
      delivery,
      version: current.version + 1,
    });
    const frame: WorkRequestFrame = { kind: "delivery-requested", request: prepared };
    const occurredAt = decodeTimestamp(this.#clock());
    try {
      this.#eventStore.append({
        requestId: current.requestId,
        expectedVersion: current.version,
        frame,
        occurredAt,
        actor: this.#userActor,
      });
    } catch {
      return failure(
        "unavailable",
        "Work request delivery intent could not be written through the authoritative flow.",
      );
    }
    this.#projection.apply(frame);
    this.#claimActiveDelivery(prepared);
    return { status: "ok", request: prepared, deliver: true };
  }

  /**
   * Persist the provider acknowledgement before the terminal transition. This
   * makes an otherwise failed terminal append recoverable without guessing
   * whether a callback was already delivered.
   */
  #confirmDelivery(current: WorkRequest): WorkRequestServiceResult {
    if (current.delivery === undefined) {
      return failure("invalid", "Work request delivery is missing.");
    }
    if (current.delivery.confirmed === true) return ok(current);
    const confirmed = decodeWorkRequest({
      ...current,
      delivery: { ...current.delivery, confirmed: true },
      version: current.version + 1,
    });
    const frame: WorkRequestFrame = { kind: "delivery-confirmed", request: confirmed };
    const occurredAt = decodeTimestamp(this.#clock());
    try {
      this.#eventStore.append({
        requestId: current.requestId,
        expectedVersion: current.version,
        frame,
        occurredAt,
        actor: this.#userActor,
      });
    } catch {
      return failure(
        "unavailable",
        "The provider accepted the Work request delivery, but that acknowledgement could not be journaled.",
      );
    }
    this.#projection.apply(frame);
    return ok(confirmed);
  }

  #deliveryFailure(current: WorkRequest, action: "resolution" | "cancellation") {
    const { delivery: _delivery, ...withoutDelivery } = current;
    const released = decodeWorkRequest({
      ...withoutDelivery,
      version: current.version + 1,
    });
    const frame: WorkRequestFrame = { kind: "delivery-released", request: released };
    const occurredAt = decodeTimestamp(this.#clock());
    try {
      this.#eventStore.append({
        requestId: current.requestId,
        expectedVersion: current.version,
        frame,
        occurredAt,
        actor: this.#userActor,
      });
    } catch {
      return failure(
        "unavailable",
        `The provider rejected the Work request ${action}, and delivery recovery could not be journaled.`,
      );
    }
    this.#projection.apply(frame);
    return failure(
      "unavailable",
      `The provider session could not receive the Work request ${action}.`,
    );
  }

  #claimActiveDelivery(request: WorkRequest): boolean {
    const key = String(request.requestId);
    if (this.#activeDeliveries.has(key)) return false;
    this.#activeDeliveries.add(key);
    return true;
  }

  #releaseActiveDelivery(request: WorkRequest): void {
    this.#activeDeliveries.delete(String(request.requestId));
  }

  #findByProviderCallbackId(
    threadId: WorkThreadId,
    providerInstanceId: ProviderInstanceId,
    providerSessionId: ProviderSessionId,
    providerCallbackId: string,
    detailKind: WorkRequest["detail"]["kind"],
  ) {
    for (const entry of this.#projection.snapshot().values()) {
      if (
        String(entry.request.threadId) === String(threadId) &&
        String(entry.request.providerInstanceId) === String(providerInstanceId) &&
        String(entry.request.providerSessionId) === String(providerSessionId) &&
        providerCallbackIdForEntry(entry) === providerCallbackId &&
        entry.request.detail.kind === detailKind
      ) {
        return entry;
      }
    }
    return undefined;
  }
}

function settledCurrent(request: WorkRequest) {
  if (request.status === "pending") return { status: "pending" as const };
  if (request.status === "resolved") {
    return { status: "resolved" as const, resolution: request.resolution! };
  }
  return { status: request.status };
}

function sameDelivery(left: WorkRequestDelivery, right: WorkRequestDelivery): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "cancel" || right.kind === "cancel") return true;
  return JSON.stringify(left.resolution) === JSON.stringify(right.resolution);
}

function providerAnswer(entry: WorkRequestEntry, answer: string): string {
  if (entry.request.detail.kind !== "user-input") return answer;
  const index = entry.request.detail.options.indexOf(answer);
  return index === -1 ? answer : (entry.providerOptionValues?.[index] ?? answer);
}

/**
 * Legacy journal frames predate the private callback field. Their public
 * value is safe only as a compatibility fallback; newly recorded requests
 * always carry a private callback value in the requested frame.
 */
function providerCallbackId(entry: WorkRequestEntry): string {
  return providerCallbackIdForEntry(entry);
}

function providerCallbackIdForEntry(entry: WorkRequestEntry): string {
  return entry.providerCallbackId ?? entry.request.providerRequestId;
}

// Re-export the id decoder for callers that only import from this module.
export { decodeWorkRequestId };
