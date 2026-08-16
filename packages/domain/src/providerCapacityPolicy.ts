import {
  decodeProviderInstanceId,
  decodeProviderServiceLimits,
  type ProviderInstanceId,
  type ProviderServiceLimits,
} from "@octant/contracts";

export type ProviderCapacityPolicyRejectionCode =
  | "invalid-capacity-facts"
  | "provider-mismatch"
  | "contradictory-capacity"
  | "unsafe-arithmetic"
  | "invalid-timing";

export class ProviderCapacityPolicyRejected extends Error {
  readonly code: ProviderCapacityPolicyRejectionCode;

  constructor(code: ProviderCapacityPolicyRejectionCode, message: string) {
    super(message);
    this.name = "ProviderCapacityPolicyRejected";
    this.code = code;
  }
}

export interface ProviderCapacityDemand {
  readonly requests: number;
  readonly estimatedTokens: number;
}

export interface ProviderCapacityAllocation {
  readonly requests: number;
  readonly tokens: number;
  readonly concurrency: number;
}

export type ProviderCapacityEnforcement =
  | { readonly kind: "observable-api"; readonly maxObservableConcurrency: number }
  | { readonly kind: "opaque-cli"; readonly maxObservableConcurrency: number };

export type UnavailableCapacityFact = "requests" | "tokens" | "concurrency" | "quota";

export type CapacityAdmission =
  | {
      readonly status: "admitted";
      readonly unavailable: ReadonlyArray<UnavailableCapacityFact>;
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
      readonly unavailable: ReadonlyArray<UnavailableCapacityFact>;
      readonly enforcement: "fine-grained" | "observable-turn-only";
    };

export interface EvaluateCapacityAdmissionInput {
  readonly providerInstanceId: ProviderInstanceId;
  readonly limits: ProviderServiceLimits;
  readonly enforcement: ProviderCapacityEnforcement;
  readonly demand: ProviderCapacityDemand;
  readonly allocated: ProviderCapacityAllocation;
  readonly nowMs: number;
  readonly retryJitterUnit: number;
  readonly maxRetryJitterMs: number;
}

export interface CapacityQueueOrderItem {
  readonly sequence: number;
  readonly reservationId: string;
}

export const MAX_OBSERVABLE_CONCURRENCY = 64;
export const MAX_RETRY_JITTER_MS = 60_000;

function reject(code: ProviderCapacityPolicyRejectionCode, message: string): never {
  throw new ProviderCapacityPolicyRejected(code, message);
}

function nonNegativeSafe(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    reject("unsafe-arithmetic", `${label} must be a non-negative safe integer.`);
  }
  return value;
}

function positiveSafe(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    reject("unsafe-arithmetic", `${label} must be a positive safe integer.`);
  }
  return value;
}

export function checkedCapacityAdd(left: number, right: number, label: string): number {
  const result = nonNegativeSafe(left, label) + nonNegativeSafe(right, label);
  if (!Number.isSafeInteger(result)) {
    reject("unsafe-arithmetic", `${label} exceeds safe integer arithmetic.`);
  }
  return result;
}

function enforcementLabel(
  enforcement: ProviderCapacityEnforcement,
): "fine-grained" | "observable-turn-only" {
  return enforcement.kind === "opaque-cli" ? "observable-turn-only" : "fine-grained";
}

function unavailableFacts(limits: ProviderServiceLimits): ReadonlyArray<UnavailableCapacityFact> {
  const unavailable: Array<UnavailableCapacityFact> = [];
  if (limits.requests.status === "unavailable") unavailable.push("requests");
  if (limits.tokens.status === "unavailable") unavailable.push("tokens");
  if (limits.concurrency.status === "unavailable") unavailable.push("concurrency");
  if (limits.quota === "unavailable" || limits.quota === "unknown") unavailable.push("quota");
  return unavailable;
}

function decodeFacts(input: EvaluateCapacityAdmissionInput): ProviderServiceLimits {
  try {
    decodeProviderInstanceId(input.providerInstanceId);
    return decodeProviderServiceLimits(input.limits);
  } catch {
    return reject("invalid-capacity-facts", "Provider capacity facts are malformed.");
  }
}

function validateAvailableBucket(bucket: ProviderServiceLimits["requests"], label: string): void {
  if (bucket.status === "unavailable") return;
  positiveSafe(bucket.limit, `${label} limit`);
  nonNegativeSafe(bucket.remaining, `${label} remaining`);
  if (bucket.remaining > bucket.limit) {
    reject("contradictory-capacity", `${label} remaining exceeds its limit.`);
  }
}

function waiting(
  input: EvaluateCapacityAdmissionInput,
  unavailable: ReadonlyArray<UnavailableCapacityFact>,
  reason: Extract<CapacityAdmission, { status: "waiting" }>["reason"],
  notBeforeMs?: number,
): CapacityAdmission {
  return {
    status: "waiting",
    reason,
    ...(notBeforeMs === undefined ? {} : { notBeforeMs }),
    unavailable,
    enforcement: enforcementLabel(input.enforcement),
  };
}

function bucketCapacity(
  bucket: Extract<ProviderServiceLimits["requests"], { status: "available" }>,
  nowMs: number,
): { readonly remaining: number; readonly notBeforeMs?: number } {
  if (bucket.resetsAt === undefined) return { remaining: bucket.remaining };
  const resetsAtMs = Date.parse(bucket.resetsAt);
  if (!Number.isSafeInteger(resetsAtMs)) {
    reject("invalid-timing", "Provider bucket reset time is invalid.");
  }
  return nowMs >= resetsAtMs
    ? { remaining: bucket.limit }
    : { remaining: bucket.remaining, notBeforeMs: resetsAtMs };
}

export function evaluateCapacityAdmission(
  input: EvaluateCapacityAdmissionInput,
): CapacityAdmission {
  const limits = decodeFacts(input);
  if (limits.providerInstanceId !== input.providerInstanceId) {
    reject("provider-mismatch", "Capacity facts must match the requested provider instance.");
  }
  validateAvailableBucket(limits.requests, "Request bucket");
  validateAvailableBucket(limits.tokens, "Token bucket");
  validateAvailableBucket(limits.concurrency, "Concurrency bucket");

  const enforcement = input.enforcement as unknown;
  if (
    typeof enforcement !== "object" ||
    enforcement === null ||
    !("kind" in enforcement) ||
    (enforcement.kind !== "observable-api" && enforcement.kind !== "opaque-cli") ||
    !("maxObservableConcurrency" in enforcement)
  ) {
    reject("invalid-capacity-facts", "Provider capacity enforcement is malformed.");
  }

  const maxObservableConcurrency = positiveSafe(
    enforcement.maxObservableConcurrency as number,
    "Observable concurrency ceiling",
  );
  if (maxObservableConcurrency > MAX_OBSERVABLE_CONCURRENCY) {
    reject("contradictory-capacity", "Observable concurrency ceiling exceeds the hard maximum.");
  }
  if (
    limits.concurrency.status === "available" &&
    maxObservableConcurrency > limits.concurrency.limit
  ) {
    reject("contradictory-capacity", "Observable concurrency ceiling exceeds the provider limit.");
  }

  positiveSafe(input.demand.requests, "Requested capacity");
  nonNegativeSafe(input.demand.estimatedTokens, "Estimated token capacity");
  nonNegativeSafe(input.allocated.requests, "Allocated requests");
  nonNegativeSafe(input.allocated.tokens, "Allocated tokens");
  nonNegativeSafe(input.allocated.concurrency, "Allocated concurrency");
  nonNegativeSafe(input.nowMs, "Current time");
  if (
    !Number.isFinite(input.retryJitterUnit) ||
    input.retryJitterUnit < 0 ||
    input.retryJitterUnit > 1 ||
    !Number.isSafeInteger(input.maxRetryJitterMs) ||
    input.maxRetryJitterMs < 0 ||
    input.maxRetryJitterMs > MAX_RETRY_JITTER_MS
  ) {
    reject("invalid-timing", "Retry jitter must be finite and within its hard ceiling.");
  }

  const unavailable = unavailableFacts(limits);
  if (limits.quota === "exhausted") return waiting(input, unavailable, "quota-exhausted");

  if (limits.retry.status === "active") {
    const retryUntilMs = Date.parse(limits.retry.until);
    const jitterMs = Math.floor(input.retryJitterUnit * input.maxRetryJitterMs);
    const notBeforeMs = retryUntilMs + jitterMs;
    if (!Number.isSafeInteger(retryUntilMs) || !Number.isSafeInteger(notBeforeMs)) {
      reject("invalid-timing", "Retry timing exceeds safe integer arithmetic.");
    }
    if (input.nowMs < notBeforeMs) {
      return waiting(input, unavailable, "retry-after", notBeforeMs);
    }
  }

  const nextRequests = checkedCapacityAdd(
    input.allocated.requests,
    input.demand.requests,
    "Request allocation",
  );
  const nextTokens = checkedCapacityAdd(
    input.allocated.tokens,
    input.demand.estimatedTokens,
    "Token allocation",
  );
  const nextConcurrency = checkedCapacityAdd(
    input.allocated.concurrency,
    1,
    "Concurrency allocation",
  );

  if (nextConcurrency > maxObservableConcurrency) {
    return waiting(input, unavailable, "observable-concurrency");
  }
  if (limits.requests.status === "available") {
    const capacity = bucketCapacity(limits.requests, input.nowMs);
    if (nextRequests > capacity.remaining) {
      return waiting(input, unavailable, "request-capacity", capacity.notBeforeMs);
    }
  }
  if (limits.tokens.status === "available") {
    const capacity = bucketCapacity(limits.tokens, input.nowMs);
    if (nextTokens > capacity.remaining) {
      return waiting(input, unavailable, "token-capacity", capacity.notBeforeMs);
    }
  }
  if (limits.concurrency.status === "available") {
    const capacity = bucketCapacity(limits.concurrency, input.nowMs);
    if (nextConcurrency > capacity.remaining) {
      return waiting(input, unavailable, "provider-concurrency", capacity.notBeforeMs);
    }
  }

  return {
    status: "admitted",
    unavailable,
    enforcement: enforcementLabel(input.enforcement),
  };
}

export function reconcileReservedTokens(
  currentlyAllocatedTokens: number,
  reservedTokens: number,
  actualTokens: number,
): number {
  const current = nonNegativeSafe(currentlyAllocatedTokens, "Allocated tokens");
  const reserved = nonNegativeSafe(reservedTokens, "Reserved tokens");
  const actual = nonNegativeSafe(actualTokens, "Actual tokens");
  if (reserved > current) {
    reject("contradictory-capacity", "Reserved tokens exceed the current allocation.");
  }
  return checkedCapacityAdd(current - reserved, actual, "Reconciled tokens");
}

function compareCodePoints(left: string, right: string): number {
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

export function compareCapacityQueueOrder(
  left: CapacityQueueOrderItem,
  right: CapacityQueueOrderItem,
): number {
  positiveSafe(left.sequence, "Queue sequence");
  positiveSafe(right.sequence, "Queue sequence");
  if (left.sequence !== right.sequence) return left.sequence - right.sequence;
  return compareCodePoints(left.reservationId, right.reservationId);
}
