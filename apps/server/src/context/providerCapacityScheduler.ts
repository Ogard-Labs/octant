import {
  decodeCapacityReservation,
  decodeProviderServiceLimits,
  type CapacityReservation,
  type CapacityReservationId,
  type ContextSubjectRef,
  type ProviderInstanceId,
  type ProviderModelId,
  type ProviderServiceLimits,
} from "@octant/contracts";
export type ProviderCapacitySchedulerRejectionCode =
  | "invalid-configuration"
  | "invalid-request"
  | "duplicate-reservation"
  | "unknown-reservation"
  | "invalid-transition"
  | "conflicting-terminal"
  | "unschedulable-demand"
  | "unsafe-arithmetic";

export class ProviderCapacitySchedulerRejected extends Error {
  readonly code: ProviderCapacitySchedulerRejectionCode;

  constructor(code: ProviderCapacitySchedulerRejectionCode, message: string) {
    super(message);
    this.name = "ProviderCapacitySchedulerRejected";
    this.code = code;
  }
}

export interface CapacityWorkRequest {
  readonly reservationId: CapacityReservationId;
  readonly subject: ContextSubjectRef;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
  readonly estimatedTokens: number;
  readonly requests: number;
  readonly origin: "thread" | "subagent";
}

export interface SchedulerProviderFacts {
  readonly limits: ProviderServiceLimits;
  readonly enforcement: SchedulerCapacityEnforcement;
}

export type SchedulerCapacityEnforcement =
  | { readonly kind: "observable-api"; readonly maxObservableConcurrency: number }
  | { readonly kind: "opaque-cli"; readonly maxObservableConcurrency: number };

export interface SchedulerCapacityAllocation {
  readonly requests: number;
  readonly tokens: number;
  readonly concurrency: number;
}

export type SchedulerUnavailableCapacityFact = "requests" | "tokens" | "concurrency" | "quota";

export type SchedulerCapacityAdmission =
  | {
      readonly status: "admitted";
      readonly unavailable: ReadonlyArray<SchedulerUnavailableCapacityFact>;
      readonly enforcement: "fine-grained" | "observable-turn-only";
    }
  | {
      readonly status: "waiting";
      readonly reason:
        | "request-capacity"
        | "token-capacity"
        | "provider-concurrency"
        | "observable-concurrency"
        | "retry-after"
        | "quota-exhausted";
      readonly notBeforeMs?: number;
      readonly unavailable: ReadonlyArray<SchedulerUnavailableCapacityFact>;
      readonly enforcement: "fine-grained" | "observable-turn-only";
    };

export interface SchedulerCapacityPolicy {
  readonly evaluateAdmission: (input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly limits: ProviderServiceLimits;
    readonly enforcement: SchedulerCapacityEnforcement;
    readonly demand: { readonly requests: number; readonly estimatedTokens: number };
    readonly allocated: SchedulerCapacityAllocation;
    readonly nowMs: number;
    readonly retryJitterUnit: number;
    readonly maxRetryJitterMs: number;
  }) => SchedulerCapacityAdmission;
  readonly reconcileReservedTokens: (
    currentlyAllocatedTokens: number,
    reservedTokens: number,
    actualTokens: number,
  ) => number;
}

export interface ProviderCapacitySchedulerOptions {
  readonly now: () => number;
  readonly random: () => number;
  readonly maxRetryJitterMs: number;
  readonly ambiguousReservationTtlMs: number;
  readonly capacityPolicy: SchedulerCapacityPolicy;
}

export type SubmissionResult =
  | {
      readonly status: "dispatched";
      readonly reservation: CapacityReservation;
      readonly enforcement: "fine-grained" | "observable-turn-only";
      readonly unavailable: ReadonlyArray<SchedulerUnavailableCapacityFact>;
    }
  | {
      readonly status: "queued";
      readonly reservation: CapacityReservation;
      readonly reason:
        | Extract<SchedulerCapacityAdmission, { status: "waiting" }>["reason"]
        | "queued-behind-earlier-work";
      readonly notBeforeMs?: number;
    };

export interface CapacityTerminalSignal {
  readonly reservationId: CapacityReservationId;
  readonly outcome: "completed" | "cancelled" | "interrupted" | "timeout" | "process-death";
  readonly actualTokens?: number;
}

interface QueueRecord {
  readonly sequence: number;
  readonly reservationId: CapacityReservationId;
}

interface ReservationRecord {
  request: CapacityWorkRequest;
  reservation: CapacityReservation;
  sequence: number;
  dispatched: boolean;
  countsCapacity: boolean;
  concurrent: boolean;
  countedTokens: number;
  requestAccountedAtMs?: number;
  tokenAccountedAtMs?: number;
  ambiguousSinceMs?: number;
  terminalSignature?: string;
}

interface ProviderState {
  facts: SchedulerProviderFacts;
  retryJitterUnit: number;
  queue: Array<QueueRecord>;
}

const MAX_AMBIGUOUS_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_OBSERVABLE_CONCURRENCY = 64;
const TERMINAL_OUTCOMES = new Set([
  "completed",
  "cancelled",
  "interrupted",
  "timeout",
  "process-death",
]);
const UNAVAILABLE_FACTS = new Set(["requests", "tokens", "concurrency", "quota"]);
const WAITING_REASONS = new Set([
  "request-capacity",
  "token-capacity",
  "provider-concurrency",
  "observable-concurrency",
  "retry-after",
  "quota-exhausted",
]);

function reject(code: ProviderCapacitySchedulerRejectionCode, message: string): never {
  throw new ProviderCapacitySchedulerRejected(code, message);
}

function safeNonNegative(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    reject("unsafe-arithmetic", `${label} must be a non-negative safe integer.`);
  }
  return value;
}

function safePositive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    reject("unsafe-arithmetic", `${label} must be a positive safe integer.`);
  }
  return value;
}

function codePointCompare(left: string, right: string): number {
  if (left === right) return 0;
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  const shared = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < shared; index++) {
    const difference = (leftPoints[index] ?? 0) - (rightPoints[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function compareQueueOrder(left: QueueRecord, right: QueueRecord): number {
  safePositive(left.sequence, "Queue sequence");
  safePositive(right.sequence, "Queue sequence");
  if (left.sequence !== right.sequence) return left.sequence - right.sequence;
  return codePointCompare(left.reservationId, right.reservationId);
}

function freezeReservation(reservation: CapacityReservation): CapacityReservation {
  return Object.freeze({
    ...reservation,
    subject: Object.freeze({ ...reservation.subject }),
  });
}

function freezeLimits(limits: ProviderServiceLimits): ProviderServiceLimits {
  return Object.freeze({
    ...limits,
    requests: Object.freeze({ ...limits.requests }),
    tokens: Object.freeze({ ...limits.tokens }),
    concurrency: Object.freeze({ ...limits.concurrency }),
    retry: Object.freeze({ ...limits.retry }),
  });
}

function normalizeEnforcement(value: unknown): SchedulerCapacityEnforcement {
  if (typeof value !== "object" || value === null) {
    return reject("invalid-configuration", "Provider capacity enforcement is malformed.");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== "observable-api" && candidate.kind !== "opaque-cli") {
    return reject("invalid-configuration", "Provider capacity enforcement kind is unsupported.");
  }
  const maxObservableConcurrency = safePositive(
    candidate.maxObservableConcurrency as number,
    "Observable concurrency ceiling",
  );
  if (maxObservableConcurrency > MAX_OBSERVABLE_CONCURRENCY) {
    return reject(
      "invalid-configuration",
      "Observable concurrency ceiling exceeds the scheduler hard maximum.",
    );
  }
  return Object.freeze({ kind: candidate.kind, maxObservableConcurrency });
}

function validateAvailableBucket(bucket: ProviderServiceLimits["requests"], label: string): void {
  if (bucket.status === "unavailable") return;
  safePositive(bucket.limit, `${label} limit`);
  safeNonNegative(bucket.remaining, `${label} remaining`);
  if (bucket.remaining > bucket.limit) {
    reject("invalid-configuration", `${label} remaining exceeds its limit.`);
  }
  if (bucket.resetsAt !== undefined && !Number.isSafeInteger(Date.parse(bucket.resetsAt))) {
    reject("invalid-configuration", `${label} reset time is invalid.`);
  }
}

export class ProviderCapacityScheduler {
  readonly #options: ProviderCapacitySchedulerOptions;
  readonly #providers = new Map<ProviderInstanceId, ProviderState>();
  readonly #reservations = new Map<CapacityReservationId, ReservationRecord>();
  #nextSequence = 1;

  constructor(options: ProviderCapacitySchedulerOptions) {
    if (
      typeof options.now !== "function" ||
      typeof options.random !== "function" ||
      typeof options.capacityPolicy?.evaluateAdmission !== "function" ||
      typeof options.capacityPolicy?.reconcileReservedTokens !== "function" ||
      !Number.isSafeInteger(options.maxRetryJitterMs) ||
      options.maxRetryJitterMs < 0 ||
      !Number.isSafeInteger(options.ambiguousReservationTtlMs) ||
      options.ambiguousReservationTtlMs <= 0 ||
      options.ambiguousReservationTtlMs > MAX_AMBIGUOUS_TTL_MS
    ) {
      reject("invalid-configuration", "Scheduler timing configuration is outside hard bounds.");
    }
    this.#options = Object.freeze({ ...options });
    this.#now();
  }

  updateProviderFacts(facts: SchedulerProviderFacts): void {
    let limits: ProviderServiceLimits;
    try {
      limits = freezeLimits(decodeProviderServiceLimits(facts.limits));
    } catch {
      return reject("invalid-configuration", "Provider service-limit facts are malformed.");
    }
    const enforcement = normalizeEnforcement(facts.enforcement);
    validateAvailableBucket(limits.requests, "Request bucket");
    validateAvailableBucket(limits.tokens, "Token bucket");
    validateAvailableBucket(limits.concurrency, "Concurrency bucket");
    if (!Number.isSafeInteger(Date.parse(limits.updatedAt))) {
      reject("invalid-configuration", "Provider fact timestamp is invalid.");
    }
    if (
      limits.concurrency.status === "available" &&
      enforcement.maxObservableConcurrency > limits.concurrency.limit
    ) {
      reject("invalid-configuration", "Observable concurrency ceiling exceeds the provider limit.");
    }
    const existing = this.#providers.get(limits.providerInstanceId);
    if (existing !== undefined) {
      const previousUpdatedAt = Date.parse(existing.facts.limits.updatedAt);
      const nextUpdatedAt = Date.parse(limits.updatedAt);
      if (!Number.isSafeInteger(previousUpdatedAt) || !Number.isSafeInteger(nextUpdatedAt)) {
        reject("invalid-configuration", "Provider fact timestamp is invalid.");
      }
      if (nextUpdatedAt < previousUpdatedAt) {
        reject(
          "invalid-configuration",
          "Stale provider capacity facts cannot replace newer facts.",
        );
      }
      if (nextUpdatedAt === previousUpdatedAt) {
        if (JSON.stringify(existing.facts) !== JSON.stringify({ limits, enforcement })) {
          reject("invalid-configuration", "Equal-time provider capacity facts conflict.");
        }
        return;
      }
    }
    const random = this.#options.random();
    if (!Number.isFinite(random) || random < 0 || random > 1) {
      reject("invalid-configuration", "Injected randomness must be between zero and one.");
    }

    try {
      this.#validateAdmission(
        this.#options.capacityPolicy.evaluateAdmission({
          providerInstanceId: limits.providerInstanceId,
          limits,
          enforcement,
          demand: { requests: 1, estimatedTokens: 0 },
          allocated: { requests: 0, tokens: 0, concurrency: 0 },
          nowMs: this.#now(),
          retryJitterUnit: random,
          maxRetryJitterMs: this.#options.maxRetryJitterMs,
        }),
        enforcement.kind === "opaque-cli" ? "observable-turn-only" : "fine-grained",
      );
    } catch (error) {
      if (error instanceof ProviderCapacitySchedulerRejected) throw error;
      return reject("invalid-configuration", "Capacity policy rejected provider facts.");
    }

    for (const record of this.#reservations.values()) {
      if (
        record.request.providerInstanceId === limits.providerInstanceId &&
        !record.concurrent &&
        (record.reservation.state === "reconciled" || record.reservation.state === "released")
      ) {
        record.countsCapacity = false;
      }
    }
    this.#providers.set(limits.providerInstanceId, {
      facts: { limits, enforcement },
      retryJitterUnit: random,
      queue: existing?.queue ?? [],
    });
  }

  submit(request: CapacityWorkRequest): SubmissionResult {
    if (this.#reservations.has(request.reservationId)) {
      reject("duplicate-reservation", `Reservation ${request.reservationId} already exists.`);
    }
    if (request.origin !== "thread" && request.origin !== "subagent") {
      reject("invalid-request", "Capacity work origin is invalid.");
    }
    safePositive(request.requests, "Requested request capacity");
    safeNonNegative(request.estimatedTokens, "Estimated tokens");
    const now = this.#now();
    const timestamp = new Date(now).toISOString();
    let reservation: CapacityReservation;
    try {
      reservation = freezeReservation(
        decodeCapacityReservation({
          id: request.reservationId,
          subject: request.subject,
          providerInstanceId: request.providerInstanceId,
          modelId: request.modelId,
          state: "requested",
          estimatedTokens: request.estimatedTokens,
          requests: request.requests,
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      );
    } catch {
      return reject("invalid-request", "Capacity work request is malformed.");
    }

    const normalizedRequest: CapacityWorkRequest = Object.freeze({
      reservationId: reservation.id,
      subject: Object.freeze({ ...reservation.subject }),
      providerInstanceId: reservation.providerInstanceId,
      modelId: reservation.modelId,
      estimatedTokens: reservation.estimatedTokens,
      requests: reservation.requests,
      origin: request.origin,
    });
    const provider = this.#providers.get(normalizedRequest.providerInstanceId);
    if (provider === undefined) {
      return reject("invalid-configuration", "Provider capacity facts are unavailable.");
    }
    this.#rejectImpossibleDemand(normalizedRequest, provider.facts.limits);
    const sequence = this.#claimSequence();
    const record: ReservationRecord = {
      request: normalizedRequest,
      reservation,
      sequence,
      dispatched: false,
      countsCapacity: false,
      concurrent: false,
      countedTokens: normalizedRequest.estimatedTokens,
    };
    this.#reservations.set(request.reservationId, record);
    provider.queue.push({ sequence, reservationId: request.reservationId });
    provider.queue.sort(compareQueueOrder);
    const drain = this.drain(request.providerInstanceId);
    if (drain.dispatched.some((entry) => entry.id === request.reservationId)) {
      return {
        status: "dispatched",
        reservation: record.reservation,
        enforcement:
          provider.facts.enforcement.kind === "opaque-cli"
            ? "observable-turn-only"
            : "fine-grained",
        unavailable: this.#unavailable(provider.facts.limits),
      };
    }
    const head = provider.queue[0];
    if (head?.reservationId !== request.reservationId) {
      return { status: "queued", reservation, reason: "queued-behind-earlier-work" };
    }
    const admission = this.#admission(provider, record);
    if (admission.status === "admitted") {
      return reject("invalid-transition", "Admitted queue head was not dispatched.");
    }
    return {
      status: "queued",
      reservation,
      reason: admission.reason,
      ...(admission.notBeforeMs === undefined ? {} : { notBeforeMs: admission.notBeforeMs }),
    };
  }

  drain(providerInstanceId?: ProviderInstanceId): {
    readonly dispatched: ReadonlyArray<CapacityReservation>;
  } {
    const providerIds =
      providerInstanceId === undefined
        ? [...this.#providers.keys()].sort(codePointCompare)
        : [providerInstanceId];
    const dispatched: Array<CapacityReservation> = [];
    for (const providerId of providerIds) {
      const provider = this.#providers.get(providerId);
      if (provider === undefined) continue;
      while (provider.queue.length > 0) {
        const head = provider.queue[0];
        if (head === undefined) break;
        const record = this.#reservations.get(head.reservationId);
        if (record === undefined) {
          reject(
            "unknown-reservation",
            `Queue references unknown reservation ${head.reservationId}.`,
          );
        }
        const admission = this.#admission(provider, record);
        if (admission.status === "waiting") break;
        const now = this.#now();
        const reservation = this.#transitionAt(record.reservation, "reserved", now);
        provider.queue.shift();
        record.dispatched = true;
        record.countsCapacity = true;
        record.concurrent = true;
        record.requestAccountedAtMs = now;
        record.tokenAccountedAtMs = now;
        record.reservation = reservation;
        dispatched.push(record.reservation);
      }
    }
    return { dispatched };
  }

  markRunning(reservationId: CapacityReservationId): CapacityReservation {
    const record = this.#knownReservation(reservationId);
    if (record.reservation.state === "running") return record.reservation;
    if (record.reservation.state !== "reserved") {
      reject("invalid-transition", "Only a reserved capacity record can begin running.");
    }
    const now = this.#now();
    record.reservation = this.#transitionAt(record.reservation, "running", now);
    return record.reservation;
  }

  recordTerminal(signal: CapacityTerminalSignal): {
    readonly reservation: CapacityReservation;
    readonly dispatched: ReadonlyArray<CapacityReservation>;
  } {
    if (!TERMINAL_OUTCOMES.has(signal.outcome)) {
      reject("invalid-request", "Capacity terminal outcome is invalid.");
    }
    const record = this.#knownReservation(signal.reservationId);
    const signature = `${signal.outcome}:${signal.actualTokens ?? ""}`;
    if (record.terminalSignature !== undefined) {
      if (record.terminalSignature !== signature) {
        reject("conflicting-terminal", "A conflicting terminal signal was received.");
      }
      return { reservation: record.reservation, dispatched: [] };
    }
    if (record.reservation.state === "requested") {
      if (signal.outcome === "completed" || signal.actualTokens !== undefined) {
        reject("invalid-transition", "Never-dispatched work cannot report provider usage.");
      }
      const now = this.#now();
      const reservation = this.#transitionAt(record.reservation, "released", now);
      this.#removeQueued(record);
      record.reservation = reservation;
      record.terminalSignature = signature;
      return { reservation: record.reservation, dispatched: [] };
    }
    if (!record.concurrent) {
      reject("invalid-transition", "Reservation is already terminal.");
    }
    if (signal.actualTokens !== undefined) {
      const now = this.#now();
      const tokenAccountedAtMs = this.#prepareActualTokens(record, signal.actualTokens, now);
      const reservation = this.#transitionAt(
        record.reservation,
        "reconciled",
        now,
        signal.actualTokens,
      );
      record.countedTokens = signal.actualTokens;
      record.tokenAccountedAtMs = tokenAccountedAtMs;
      record.concurrent = false;
      record.reservation = reservation;
    } else {
      const now = this.#now();
      const reservation = this.#transitionAt(record.reservation, "ambiguous", now);
      record.ambiguousSinceMs = now;
      record.reservation = reservation;
    }
    record.terminalSignature = signature;
    return {
      reservation: record.reservation,
      dispatched: this.drain(record.request.providerInstanceId).dispatched,
    };
  }

  reconcile(
    reservationId: CapacityReservationId,
    actualTokens: number,
  ): {
    readonly reservation: CapacityReservation;
    readonly dispatched: ReadonlyArray<CapacityReservation>;
  } {
    const record = this.#knownReservation(reservationId);
    if (record.reservation.state === "reconciled") {
      if (record.reservation.actualTokens !== actualTokens) {
        reject("conflicting-terminal", "Reconciliation conflicts with recorded actual usage.");
      }
      return { reservation: record.reservation, dispatched: [] };
    }
    if (!record.dispatched) {
      reject("invalid-transition", "Never-dispatched work cannot reconcile provider usage.");
    }
    if (
      record.reservation.state !== "ambiguous" &&
      record.reservation.state !== "reserved" &&
      record.reservation.state !== "running" &&
      record.reservation.state !== "released"
    ) {
      reject("invalid-transition", "Reservation cannot be reconciled from its current state.");
    }
    const now = this.#now();
    const tokenAccountedAtMs = this.#prepareActualTokens(record, actualTokens, now);
    const reservation = this.#transitionAt(record.reservation, "reconciled", now, actualTokens);
    record.countedTokens = actualTokens;
    record.tokenAccountedAtMs = tokenAccountedAtMs;
    record.concurrent = false;
    delete record.ambiguousSinceMs;
    record.reservation = reservation;
    return {
      reservation: record.reservation,
      dispatched: this.drain(record.request.providerInstanceId).dispatched,
    };
  }

  restore(reservations: ReadonlyArray<CapacityReservation>): void {
    const prepared: Array<{ provider: ProviderState; record: ReservationRecord }> = [];
    const seen = new Set<CapacityReservationId>(this.#reservations.keys());
    let nextSequence = this.#nextSequence;
    const restoreNow = reservations.length === 0 ? undefined : this.#now();
    for (const candidate of reservations) {
      let reservation: CapacityReservation;
      try {
        reservation = freezeReservation(decodeCapacityReservation(candidate));
      } catch {
        return reject("invalid-request", "Restored reservation is malformed.");
      }
      if (seen.has(reservation.id)) {
        reject("duplicate-reservation", `Reservation ${reservation.id} already exists.`);
      }
      seen.add(reservation.id);
      const provider = this.#providers.get(reservation.providerInstanceId);
      if (provider === undefined) {
        reject("invalid-configuration", "Restore requires provider facts first.");
      }
      const sequence = nextSequence;
      nextSequence = this.#checkedAdd(nextSequence, 1, "Queue sequence");
      const request: CapacityWorkRequest = Object.freeze({
        reservationId: reservation.id,
        subject: Object.freeze({ ...reservation.subject }),
        providerInstanceId: reservation.providerInstanceId,
        modelId: reservation.modelId,
        estimatedTokens: reservation.estimatedTokens,
        requests: reservation.requests,
        origin: reservation.subject.aggregateType === "subagent" ? "subagent" : "thread",
      });
      this.#rejectImpossibleDemand(request, provider.facts.limits);
      const active =
        reservation.state === "reserved" ||
        reservation.state === "running" ||
        reservation.state === "ambiguous";
      const restored = active
        ? this.#transitionAt(reservation, "ambiguous", restoreNow as number)
        : reservation;
      prepared.push({
        provider,
        record: {
          request,
          reservation: restored,
          sequence,
          dispatched: reservation.state !== "requested",
          countsCapacity: active,
          concurrent: active,
          countedTokens: reservation.actualTokens ?? reservation.estimatedTokens,
          ...(active
            ? {
                requestAccountedAtMs: restoreNow as number,
                tokenAccountedAtMs: restoreNow as number,
                ambiguousSinceMs: restoreNow as number,
              }
            : {}),
        },
      });
    }

    this.#nextSequence = nextSequence;
    const affectedProviders = new Set<ProviderState>();
    for (const { provider, record } of prepared) {
      const reservation = record.reservation;
      this.#reservations.set(reservation.id, record);
      if (reservation.state === "requested") {
        provider.queue.push({ sequence: record.sequence, reservationId: reservation.id });
        affectedProviders.add(provider);
      }
    }
    for (const provider of affectedProviders) provider.queue.sort(compareQueueOrder);
  }

  expireAmbiguous(): {
    readonly released: ReadonlyArray<CapacityReservation>;
    readonly dispatched: ReadonlyArray<CapacityReservation>;
  } {
    const now = this.#now();
    const released: Array<CapacityReservation> = [];
    const providers = new Set<ProviderInstanceId>();
    for (const record of this.#reservations.values()) {
      if (record.reservation.state !== "ambiguous" || record.ambiguousSinceMs === undefined)
        continue;
      const age = now - record.ambiguousSinceMs;
      if (!Number.isSafeInteger(age) || age < 0) {
        reject("unsafe-arithmetic", "Ambiguous reservation age is invalid.");
      }
      if (age < this.#options.ambiguousReservationTtlMs) continue;
      const reservation = this.#transitionAt(record.reservation, "released", now);
      record.concurrent = false;
      delete record.ambiguousSinceMs;
      record.reservation = reservation;
      released.push(record.reservation);
      providers.add(record.request.providerInstanceId);
    }
    const dispatched = [...providers]
      .sort(codePointCompare)
      .flatMap((providerId) => this.drain(providerId).dispatched);
    return { released, dispatched };
  }

  shutdown(): ReadonlyArray<CapacityReservation> {
    const ambiguous: Array<CapacityReservation> = [];
    const now = this.#now();
    for (const record of this.#reservations.values()) {
      if (record.reservation.state !== "reserved" && record.reservation.state !== "running") {
        continue;
      }
      const reservation = this.#transitionAt(record.reservation, "ambiguous", now);
      record.ambiguousSinceMs = now;
      record.reservation = reservation;
      ambiguous.push(record.reservation);
    }
    return ambiguous;
  }

  getReservation(reservationId: CapacityReservationId): CapacityReservation | undefined {
    return this.#reservations.get(reservationId)?.reservation;
  }

  /**
   * The capacity facts this scheduler currently holds for a provider, or
   * `undefined` when nothing has been observed for it yet. Callers use this to
   * tell "no observation" apart from an observed limit, so an unobserving
   * caller can leave observed facts — an active retry window, an exhausted
   * quota, a live bucket — authoritative instead of replacing them.
   */
  providerFacts(providerInstanceId: ProviderInstanceId): SchedulerProviderFacts | undefined {
    const provider = this.#providers.get(providerInstanceId);
    if (provider === undefined) return undefined;
    return Object.freeze({
      limits: provider.facts.limits,
      enforcement: provider.facts.enforcement,
    });
  }

  snapshot(providerInstanceId: ProviderInstanceId): {
    readonly allocated: SchedulerCapacityAllocation;
    readonly queue: ReadonlyArray<QueueRecord>;
  } {
    const provider = this.#providers.get(providerInstanceId);
    return {
      allocated: this.#allocated(providerInstanceId),
      queue: provider?.queue.map((entry) => ({ ...entry })) ?? [],
    };
  }

  #admission(provider: ProviderState, record: ReservationRecord): SchedulerCapacityAdmission {
    try {
      const now = this.#now();
      const admission = this.#options.capacityPolicy.evaluateAdmission({
        providerInstanceId: record.request.providerInstanceId,
        limits: provider.facts.limits,
        enforcement: provider.facts.enforcement,
        demand: {
          requests: record.request.requests,
          estimatedTokens: record.request.estimatedTokens,
        },
        allocated: this.#allocated(record.request.providerInstanceId, now),
        nowMs: now,
        retryJitterUnit: provider.retryJitterUnit,
        maxRetryJitterMs: this.#options.maxRetryJitterMs,
      });
      return this.#validateAdmission(
        admission,
        provider.facts.enforcement.kind === "opaque-cli" ? "observable-turn-only" : "fine-grained",
      );
    } catch (error) {
      if (error instanceof ProviderCapacitySchedulerRejected) throw error;
      return reject("invalid-configuration", "Capacity policy rejected scheduler admission.");
    }
  }

  #allocated(
    providerInstanceId: ProviderInstanceId,
    nowMs = this.#now(),
  ): SchedulerCapacityAllocation {
    let requests = 0;
    let tokens = 0;
    let concurrency = 0;
    const limits = this.#providers.get(providerInstanceId)?.facts.limits;
    for (const record of this.#reservations.values()) {
      if (record.request.providerInstanceId !== providerInstanceId || !record.countsCapacity)
        continue;
      if (
        record.concurrent ||
        this.#countsInCurrentWindow(
          limits?.requests,
          record.requestAccountedAtMs,
          nowMs,
          "Request bucket",
        )
      ) {
        requests = this.#checkedAdd(requests, record.request.requests, "Allocated requests");
      }
      if (
        record.concurrent ||
        this.#countsInCurrentWindow(
          limits?.tokens,
          record.tokenAccountedAtMs,
          nowMs,
          "Token bucket",
        )
      ) {
        tokens = this.#checkedAdd(tokens, record.countedTokens, "Allocated tokens");
      }
      if (record.concurrent) concurrency = this.#checkedAdd(concurrency, 1, "Concurrency");
    }
    return { requests, tokens, concurrency };
  }

  #prepareActualTokens(record: ReservationRecord, actualTokens: number, nowMs: number): number {
    safeNonNegative(actualTokens, "Actual tokens");
    const tokenAccountedAtMs = record.tokenAccountedAtMs;
    if (tokenAccountedAtMs === undefined) {
      return reject("invalid-transition", "Token accounting timestamp is unavailable.");
    }
    const limits = this.#providers.get(record.request.providerInstanceId)?.facts.limits;
    const reservedCountsInCurrentWindow =
      record.countsCapacity &&
      (record.concurrent ||
        this.#countsInCurrentWindow(limits?.tokens, tokenAccountedAtMs, nowMs, "Token bucket"));
    if (!reservedCountsInCurrentWindow) {
      return safeNonNegative(tokenAccountedAtMs, "Token accounting timestamp");
    }
    const allocated = this.#allocated(record.request.providerInstanceId, nowMs);
    try {
      this.#options.capacityPolicy.reconcileReservedTokens(
        allocated.tokens,
        record.countedTokens,
        actualTokens,
      );
    } catch (error) {
      if (error instanceof ProviderCapacitySchedulerRejected) throw error;
      return reject("unsafe-arithmetic", "Capacity policy rejected usage reconciliation.");
    }
    return nowMs;
  }

  #transitionAt(
    reservation: CapacityReservation,
    state: CapacityReservation["state"],
    nowMs: number,
    actualTokens?: number,
  ): CapacityReservation {
    try {
      return freezeReservation(
        decodeCapacityReservation({
          ...reservation,
          state,
          updatedAt: new Date(safeNonNegative(nowMs, "Clock value")).toISOString(),
          ...(state === "reconciled"
            ? { actualTokens }
            : { actualTokens: reservation.actualTokens }),
        }),
      );
    } catch {
      return reject("invalid-transition", `Invalid capacity transition to ${state}.`);
    }
  }

  #countsInCurrentWindow(
    bucket: ProviderServiceLimits["requests"] | undefined,
    accountedAtMs: number | undefined,
    nowMs: number,
    label: string,
  ): boolean {
    if (bucket === undefined || bucket.status === "unavailable" || bucket.resetsAt === undefined) {
      return true;
    }
    const resetsAtMs = Date.parse(bucket.resetsAt);
    if (!Number.isSafeInteger(resetsAtMs)) {
      return reject("invalid-configuration", `${label} reset time is invalid.`);
    }
    if (nowMs < resetsAtMs) return true;
    if (accountedAtMs === undefined) {
      return reject("invalid-transition", `${label} accounting timestamp is unavailable.`);
    }
    safeNonNegative(accountedAtMs, `${label} accounting timestamp`);
    return accountedAtMs >= resetsAtMs;
  }

  #validateAdmission(
    value: unknown,
    expectedEnforcement: "fine-grained" | "observable-turn-only",
  ): SchedulerCapacityAdmission {
    if (typeof value !== "object" || value === null) {
      return reject("invalid-configuration", "Capacity policy returned a malformed admission.");
    }
    const admission = value as Record<string, unknown>;
    if (admission.status !== "admitted" && admission.status !== "waiting") {
      return reject("invalid-configuration", "Capacity policy returned an unsupported status.");
    }
    if (
      admission.enforcement !== "fine-grained" &&
      admission.enforcement !== "observable-turn-only"
    ) {
      return reject(
        "invalid-configuration",
        "Capacity policy returned an unsupported enforcement label.",
      );
    }
    if (admission.enforcement !== expectedEnforcement) {
      return reject(
        "invalid-configuration",
        "Capacity policy returned a contradictory enforcement label.",
      );
    }
    if (!Array.isArray(admission.unavailable)) {
      return reject("invalid-configuration", "Capacity policy omitted unavailable facts.");
    }
    const unavailable = admission.unavailable as Array<unknown>;
    if (
      unavailable.some((fact) => !UNAVAILABLE_FACTS.has(fact as string)) ||
      new Set(unavailable).size !== unavailable.length
    ) {
      return reject("invalid-configuration", "Capacity policy returned invalid unavailable facts.");
    }
    if (admission.status === "waiting") {
      if (!WAITING_REASONS.has(admission.reason as string)) {
        return reject("invalid-configuration", "Capacity policy returned an unsupported wait.");
      }
      if (
        admission.notBeforeMs !== undefined &&
        (!Number.isSafeInteger(admission.notBeforeMs) || (admission.notBeforeMs as number) < 0)
      ) {
        return reject("invalid-configuration", "Capacity policy returned invalid wait timing.");
      }
    } else if (admission.reason !== undefined || admission.notBeforeMs !== undefined) {
      return reject("invalid-configuration", "Admitted capacity cannot include wait metadata.");
    }
    return value as SchedulerCapacityAdmission;
  }

  #removeQueued(record: ReservationRecord): void {
    const provider = this.#providers.get(record.request.providerInstanceId);
    if (provider === undefined) return;
    provider.queue = provider.queue.filter(
      (entry) => entry.reservationId !== record.request.reservationId,
    );
  }

  #knownReservation(reservationId: CapacityReservationId): ReservationRecord {
    const record = this.#reservations.get(reservationId);
    if (record === undefined) {
      reject("unknown-reservation", `Unknown capacity reservation ${reservationId}.`);
    }
    return record;
  }

  #claimSequence(): number {
    const sequence = this.#nextSequence;
    this.#nextSequence = this.#checkedAdd(this.#nextSequence, 1, "Queue sequence");
    return sequence;
  }

  #checkedAdd(left: number, right: number, label: string): number {
    const result = safeNonNegative(left, label) + safeNonNegative(right, label);
    if (!Number.isSafeInteger(result)) reject("unsafe-arithmetic", `${label} overflowed.`);
    return result;
  }

  #now(): number {
    const value = this.#options.now();
    return safeNonNegative(value, "Clock value");
  }

  #rejectImpossibleDemand(request: CapacityWorkRequest, limits: ProviderServiceLimits): void {
    if (limits.requests.status === "available" && request.requests > limits.requests.limit) {
      reject("unschedulable-demand", "Requested capacity exceeds the provider request limit.");
    }
    if (limits.tokens.status === "available" && request.estimatedTokens > limits.tokens.limit) {
      reject("unschedulable-demand", "Estimated tokens exceed the provider token limit.");
    }
  }

  #unavailable(limits: ProviderServiceLimits): ReadonlyArray<SchedulerUnavailableCapacityFact> {
    const unavailable: Array<SchedulerUnavailableCapacityFact> = [];
    if (limits.requests.status === "unavailable") unavailable.push("requests");
    if (limits.tokens.status === "unavailable") unavailable.push("tokens");
    if (limits.concurrency.status === "unavailable") unavailable.push("concurrency");
    if (limits.quota === "unavailable" || limits.quota === "unknown") unavailable.push("quota");
    return unavailable;
  }
}
