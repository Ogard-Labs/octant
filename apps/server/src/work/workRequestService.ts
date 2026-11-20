import { Schema } from "effect";
import {
  EventActor,
  UtcTimestamp,
  decodeWorkRequest,
  decodeWorkRequestId,
  type WorkRequest,
  type WorkRequestResolution,
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
  APPROVAL_POSTURE_CHANGED_MESSAGE,
  approvalAnswerUnderPosture,
  validateQuestionnaireAnswer,
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
  /**
   * The thread's posture now, as `approvalPostureOf` reads it, or undefined
   * when the thread cannot be read.
   */
  threadApprovalPosture(threadId: WorkThreadId): string | undefined;
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
    readonly ownerCurrent?: () => boolean;
  }): Promise<void>;
  answerUserInput(input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly sessionId: ProviderSessionId;
    readonly requestId: string;
    readonly answer: string;
  }): Promise<void>;
  /**
   * Moves the asking session's running turn to Plan in place; absent, or
   * anything but `applied`, and an approved entry to Plan ends the turn.
   */
  changeLevelInPlace?(input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly sessionId: ProviderSessionId;
  }): Promise<{ readonly status: "applied" | "refused" | "failed" }>;
  /** End the provider-side wait before the local request is cancelled. */
  cancel(input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly sessionId: ProviderSessionId;
    readonly requestId: string;
    readonly kind: WorkRequest["detail"]["kind"];
  }): Promise<void>;
}

/**
 * Carries out an approved level change: the agent's own ask to plan first or
 * to leave Plan. The thread's level changes as the person's own choice. The
 * turn that asked ends once the provider has the answer, unless it entered
 * Plan in place, when the running turn is held to Plan from then on.
 */
export interface WorkRequestLevelChangePort {
  change(input: {
    readonly threadId: WorkThreadId;
    readonly kind: "enter-plan" | "exit-plan";
    readonly actor: typeof EventActor.Type;
  }): { readonly status: "changed" } | { readonly status: "refused"; readonly message: string };
  endTurn(threadId: WorkThreadId): void;
  /** The running turn entered Plan in place: what it may do is Plan's from now on. */
  enteredPlanInPlace?(threadId: WorkThreadId): void;
}

export interface WorkRequestServiceOptions {
  readonly projects: WorkRequestProjectPort;
  readonly projection: WorkRequestProjection;
  readonly eventStore: WorkRequestEventStorePort;
  readonly providerSessions?: Partial<WorkRequestProviderSessionPort>;
  /** Absent, an approved level change is refused rather than left unapplied. */
  readonly levelChanges?: WorkRequestLevelChangePort;
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
  readonly #levelChanges: WorkRequestLevelChangePort | undefined;
  readonly #userActor: typeof EventActor.Type;
  readonly #systemActor: typeof EventActor.Type;
  readonly #clock: () => string;
  /** One process owns a pending external callback delivery at a time. */
  readonly #activeDeliveries = new Set<string>();
  readonly #interruptedSessions = new Set<string>();
  readonly #settlementListeners = new Map<
    string,
    Set<
      (settled?: {
        readonly person: boolean;
        readonly requestedAt?: UtcTimestamp;
        readonly settledAt?: UtcTimestamp;
      }) => void
    >
  >();
  /**
   * The thread's posture when each pending approval in this process was
   * asked, by request id. A request restored after a restart has none, and
   * its provider session did not survive to take an allow anyway.
   */
  readonly #askedPostures = new Map<string, string | undefined>();

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
    this.#levelChanges = options.levelChanges;
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
        "Work request hydration exceeded the journal scan cap, so Octant refuses to serve a partial view.",
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
    if (request.detail.kind === "approval") {
      this.#askedPostures.set(
        String(request.requestId),
        this.#projects.threadApprovalPosture(request.threadId),
      );
    }
    return ok(request);
  }

  /** The user's resolution of a pending approval or user-input request. */
  async resolve(
    command: Extract<WorkRequestCommand, { kind: "resolve-work-request" }>,
    ownerCurrent?: () => boolean,
    // Who answered, as the route resolved it from the authenticated
    // principal: a paired device's answer is journaled as that device. Absent
    // means the person at this host.
    answeredBy: typeof EventActor.Type = this.#userActor,
  ): Promise<WorkRequestServiceResult> {
    if (ownerCurrent !== undefined && !ownerCurrent())
      return failure("stale", "Owner approval target changed.");
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
    if (
      command.resolution.kind === "approval" &&
      entry.request.delivery === undefined &&
      this.#approvalAskedAgain(entry.request, command.resolution.approved)
    ) {
      return failure("stale", APPROVAL_POSTURE_CHANGED_MESSAGE);
    }
    if (entry.request.detail.kind === "user-input" && command.resolution.kind === "user-input") {
      const questionnaire = entry.request.detail.questionnaire;
      const answer = command.resolution.answer;
      if (
        questionnaire === undefined
          ? typeof answer !== "string"
          : typeof answer === "string" ||
            validateQuestionnaireAnswer(questionnaire, JSON.stringify(answer)).status !== "valid"
      ) {
        return failure(
          "invalid",
          "The questionnaire answer is incomplete or contains invalid choices.",
        );
      }
    }
    // An approved level change moves the thread before the provider hears
    // the answer, so an agent told "approved" never finds the old level; a
    // change the host cannot make leaves the request pending for the person.
    const levelChange =
      entry.request.detail.kind === "approval" &&
      entry.request.detail.levelChange !== undefined &&
      command.resolution.kind === "approval" &&
      command.resolution.approved &&
      entry.request.delivery === undefined
        ? entry.request.detail.levelChange
        : undefined;
    if (levelChange !== undefined) {
      // A stale answer changes nothing: the version is checked before the
      // level moves, not only when the delivery is prepared.
      if (entry.request.version !== command.expectedVersion) {
        return failure("stale", "Work request version is stale.");
      }
      const changed = this.#levelChanges?.change({
        threadId: entry.request.threadId,
        kind: levelChange.to === "plan" ? "enter-plan" : "exit-plan",
        actor: answeredBy,
      }) ?? { status: "refused", message: "This host cannot change the thread's level." };
      if (changed.status === "refused") return failure("conflict", changed.message);
    }
    const delivery: WorkRequestDelivery = { kind: "resolve", resolution: command.resolution };
    const prepared = this.#prepareDelivery(
      entry.request,
      command.expectedVersion,
      delivery,
      answeredBy,
    );
    if (!("deliver" in prepared)) return prepared;
    if (!prepared.deliver) {
      return this.#settle(
        prepared.request,
        "resolved",
        { resolution: command.resolution },
        answeredBy,
      );
    }
    // Entering Plan applies inside the running turn where the session's
    // driver can hold it to Plan, before the agent hears the answer; leaving
    // Plan, or a driver without that change, ends the turn.
    let levelChangeApplied: "in-place" | "next-turn" | undefined;
    try {
      try {
        if (levelChange !== undefined) {
          const inPlace =
            levelChange.to === "plan" && this.#providerSessions.changeLevelInPlace !== undefined
              ? await this.#providerSessions
                  .changeLevelInPlace({
                    providerInstanceId: prepared.request.providerInstanceId,
                    sessionId: prepared.request.providerSessionId,
                  })
                  .catch(() => ({ status: "failed" as const }))
              : undefined;
          levelChangeApplied = inPlace?.status === "applied" ? "in-place" : "next-turn";
          // The running turn's ceiling narrows before the agent hears yes.
          if (levelChangeApplied === "in-place")
            this.#levelChanges?.enteredPlanInPlace?.(entry.request.threadId);
        }
        if (command.resolution.kind === "approval") {
          await this.#providerSessions.answerApproval({
            providerInstanceId: prepared.request.providerInstanceId,
            sessionId: prepared.request.providerSessionId,
            requestId: providerCallbackId(entry),
            approved: command.resolution.approved,
            ...(ownerCurrent === undefined ? {} : { ownerCurrent }),
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
        // The provider never heard the answer, so the level moves back and the
        // request is left as it was: a retry applies the change again and
        // delivers it, rather than finding the thread already moved.
        if (levelChange !== undefined) {
          this.#levelChanges?.change({
            threadId: entry.request.threadId,
            kind: levelChange.to === "plan" ? "exit-plan" : "enter-plan",
            actor: answeredBy,
          });
        }
        return this.#deliveryFailure(prepared.request, "resolution", answeredBy);
      }
      const confirmed = this.#confirmDelivery(prepared.request, answeredBy);
      if (confirmed.status !== "ok") return confirmed;
      const settled = this.#settle(
        confirmed.request,
        "resolved",
        {
          resolution: command.resolution,
          ...(levelChangeApplied === undefined ? {} : { levelChangeApplied }),
        },
        answeredBy,
      );
      if (levelChange !== undefined && levelChangeApplied !== "in-place")
        this.#levelChanges?.endTurn(entry.request.threadId);
      return settled;
    } finally {
      this.#releaseActiveDelivery(prepared.request);
    }
  }

  /** The user cancels a pending approval or user-input request. */
  async cancel(
    command: Extract<WorkRequestCommand, { kind: "cancel-work-request" }>,
    answeredBy: typeof EventActor.Type = this.#userActor,
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
    const prepared = this.#prepareDelivery(
      entry.request,
      command.expectedVersion,
      { kind: "cancel" },
      answeredBy,
    );
    if (!("deliver" in prepared)) return prepared;
    if (!prepared.deliver) return this.#settle(prepared.request, "cancelled", {}, answeredBy);
    try {
      try {
        await this.#providerSessions.cancel({
          providerInstanceId: prepared.request.providerInstanceId,
          sessionId: prepared.request.providerSessionId,
          requestId: providerCallbackId(entry),
          kind: prepared.request.detail.kind,
        });
      } catch {
        return this.#deliveryFailure(prepared.request, "cancellation", answeredBy);
      }
      const confirmed = this.#confirmDelivery(prepared.request, answeredBy);
      if (confirmed.status !== "ok") return confirmed;
      return this.#settle(confirmed.request, "cancelled", {}, answeredBy);
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

  onSettled(
    input: {
      readonly providerSessionId: ProviderSessionId;
      readonly providerCallbackId: string;
    },
    callback: (settled?: {
      readonly person: boolean;
      readonly requestedAt?: UtcTimestamp;
      readonly settledAt?: UtcTimestamp;
    }) => void,
  ): () => void {
    const key = settlementListenerKey(input.providerSessionId, input.providerCallbackId);
    const entry = this.#findByProviderSessionCallbackId(
      input.providerSessionId,
      input.providerCallbackId,
    );
    if (entry !== undefined && entry.request.status !== "pending") {
      const { status } = entry.request;
      // Interrupted and expired settles are the system's own, and the wait
      // was person-facing until it ran out. A resolved or cancelled request
      // settled by a person or by an automated reviewer only the actor can
      // tell apart: when the settle was journaled without one (a replayed
      // frame carries none), billing would be a guess, so it is omitted.
      const person =
        status === "interrupted" || status === "expired"
          ? true
          : entry.settledActorKind !== undefined && entry.settledActorKind !== "agent";
      callback({
        person,
        requestedAt: entry.request.requestedAt,
        ...(entry.request.settledAt === undefined ? {} : { settledAt: entry.request.settledAt }),
      });
      return () => undefined;
    }
    const listeners =
      this.#settlementListeners.get(key) ??
      new Set<
        (settled?: {
          readonly person: boolean;
          readonly requestedAt?: UtcTimestamp;
          readonly settledAt?: UtcTimestamp;
        }) => void
      >();
    listeners.add(callback);
    this.#settlementListeners.set(key, listeners);
    return () => {
      const current = this.#settlementListeners.get(key);
      if (current === undefined) return;
      current.delete(callback);
      if (current.size === 0) this.#settlementListeners.delete(key);
    };
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
          String(entry.request.providerSessionId) === String(sessionId),
      )
      .flatMap((entry) => {
        const requestId = String(entry.request.requestId);
        if (this.#activeDeliveries.has(requestId)) {
          this.#interruptedSessions.add(String(sessionId));
          return [];
        }
        return [this.#reconcileTerminalSessionRequest(entry.request)];
      });
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

  /** Interrupts every pending request because no provider session survives a restart. */
  interruptOnRestart(): ReadonlyArray<WorkRequestServiceResult> {
    return [...this.#projection.snapshot().values()]
      .filter(
        (entry) =>
          entry.request.status === "pending" &&
          !this.#activeDeliveries.has(String(entry.request.requestId)) &&
          entry.request.delivery?.confirmed !== true,
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
    extra: {
      resolution?: WorkRequest["resolution"];
      levelChangeApplied?: WorkRequest["levelChangeApplied"];
    },
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
      ...(extra.levelChangeApplied === undefined
        ? {}
        : { levelChangeApplied: extra.levelChangeApplied }),
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
    this.#projection.apply(frame, actor);
    const currentEntry = this.#projection.lookup(current.requestId);
    const listenerKey =
      currentEntry === undefined
        ? settlementListenerKey(current.providerSessionId, current.providerRequestId)
        : settlementListenerKey(
            currentEntry.request.providerSessionId,
            providerCallbackIdForEntry(currentEntry),
          );
    const listeners = this.#settlementListeners.get(listenerKey);
    this.#settlementListeners.delete(listenerKey);
    // The ask was person-facing the whole time it stood open: a person's
    // answer and a person-facing wait that ran out — expiry, interrupt, a
    // withdraw — both end person time at this settle. Only an automated
    // reviewer's `agent` settle is not person wait.
    const person = actor.kind !== "agent";
    for (const callback of listeners ?? [])
      callback({ person, requestedAt: nextRequest.requestedAt, settledAt });
    return ok(nextRequest);
  }

  /**
   * Whether an answer to this approval must wait for the person to answer
   * again: an allow given under a posture the thread no longer holds. The
   * request stays pending and is now asked under the current posture.
   */
  #approvalAskedAgain(request: WorkRequest, approved: boolean): boolean {
    const current = this.#projects.threadApprovalPosture(request.threadId);
    const decision = approvalAnswerUnderPosture({
      approved,
      askedUnder: this.#askedPostures.get(String(request.requestId)),
      current,
    });
    if (decision === "deliver") return false;
    this.#askedPostures.set(String(request.requestId), current);
    return true;
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
    actor: typeof EventActor.Type,
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
        actor,
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
  #confirmDelivery(current: WorkRequest, actor: typeof EventActor.Type): WorkRequestServiceResult {
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
        actor,
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

  #deliveryFailure(
    current: WorkRequest,
    action: "resolution" | "cancellation",
    actor: typeof EventActor.Type,
  ) {
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
        actor,
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
    if (
      this.#interruptedSessions.has(String(request.providerSessionId)) &&
      this.#projection.lookup(request.requestId)?.request.status === "pending"
    ) {
      this.#systemSettle(request.requestId, "interrupted");
    }
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

  #findByProviderSessionCallbackId(
    providerSessionId: ProviderSessionId,
    providerCallbackId: string,
  ) {
    for (const entry of this.#projection.snapshot().values()) {
      if (
        String(entry.request.providerSessionId) === String(providerSessionId) &&
        providerCallbackIdForEntry(entry) === providerCallbackId
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

function providerAnswer(
  entry: WorkRequestEntry,
  answer: Extract<WorkRequestResolution, { kind: "user-input" }>["answer"],
): string {
  if (typeof answer !== "string") return JSON.stringify(answer);
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

function settlementListenerKey(providerSessionId: ProviderSessionId, providerCallbackId: string) {
  return `${String(providerSessionId)}:${providerCallbackId}`;
}

// Re-export the id decoder for callers that only import from this module.
export { decodeWorkRequestId };
