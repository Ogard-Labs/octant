import { describe, expect, it } from "vitest";
import type {
  CapacityReservationId,
  ContextSubjectRef,
  ProviderInstanceId,
  ProviderModelId,
  ProviderServiceLimits,
} from "@octant/contracts";
import {
  ProviderCapacityScheduler,
  ProviderCapacitySchedulerRejected,
  type CapacityWorkRequest,
  type SchedulerCapacityPolicy,
} from "./providerCapacityScheduler";

const providerA = "00000000-0000-4000-8000-000000000005" as ProviderInstanceId;
const providerB = "00000000-0000-4000-8000-000000000006" as ProviderInstanceId;
const model = "model-a" as ProviderModelId;
const baseMs = Date.parse("2026-07-18T18:30:00.000Z");

function providerLimits(
  providerInstanceId: ProviderInstanceId,
  overrides: Partial<ProviderServiceLimits> = {},
): ProviderServiceLimits {
  return {
    providerInstanceId,
    scope: "provider-instance",
    requests: { status: "available", limit: 20, remaining: 20 },
    tokens: { status: "available", limit: 20_000, remaining: 20_000 },
    concurrency: { status: "available", limit: 2, remaining: 2 },
    retry: { status: "inactive" },
    quota: "available",
    source: "runtime-reported",
    confidence: "high",
    updatedAt: new Date(baseMs).toISOString() as ProviderServiceLimits["updatedAt"],
    ...overrides,
  };
}

function id(index: number): CapacityReservationId {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}` as CapacityReservationId;
}

function subject(index: number, kind: "thread" | "subagent" = "thread"): ContextSubjectRef {
  return {
    aggregateType: kind,
    aggregateId: `00000000-0000-4000-8000-${(index + 100).toString().padStart(12, "0")}`,
  } as ContextSubjectRef;
}

function work(index: number, overrides: Partial<CapacityWorkRequest> = {}): CapacityWorkRequest {
  return {
    reservationId: id(index),
    subject: subject(index),
    providerInstanceId: providerA,
    modelId: model,
    estimatedTokens: 500,
    requests: 1,
    origin: "thread",
    ...overrides,
  };
}

function checkedAdd(left: number, right: number): number {
  if (!Number.isSafeInteger(left) || left < 0 || !Number.isSafeInteger(right) || right < 0) {
    throw new Error("unsafe capacity arithmetic");
  }
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new Error("capacity overflow");
  return result;
}

function availableCapacity(
  bucket: ProviderServiceLimits["requests"],
  nowMs: number,
): { readonly remaining: number; readonly notBeforeMs?: number } | undefined {
  if (bucket.status === "unavailable") return undefined;
  if (bucket.resetsAt === undefined) return { remaining: bucket.remaining };
  const resetsAtMs = Date.parse(bucket.resetsAt);
  return nowMs >= resetsAtMs
    ? { remaining: bucket.limit }
    : { remaining: bucket.remaining, notBeforeMs: resetsAtMs };
}

const testCapacityPolicy: SchedulerCapacityPolicy = {
  evaluateAdmission(input) {
    const unavailable = [
      ...(input.limits.requests.status === "unavailable" ? (["requests"] as const) : []),
      ...(input.limits.tokens.status === "unavailable" ? (["tokens"] as const) : []),
      ...(input.limits.concurrency.status === "unavailable" ? (["concurrency"] as const) : []),
      ...(input.limits.quota === "unavailable" || input.limits.quota === "unknown"
        ? (["quota"] as const)
        : []),
    ];
    const enforcement: "fine-grained" | "observable-turn-only" =
      input.enforcement.kind === "opaque-cli" ? "observable-turn-only" : "fine-grained";
    const waiting = (
      reason:
        | "request-capacity"
        | "token-capacity"
        | "provider-concurrency"
        | "observable-concurrency"
        | "retry-after"
        | "quota-exhausted",
      notBeforeMs?: number,
    ) => ({
      status: "waiting" as const,
      reason,
      ...(notBeforeMs === undefined ? {} : { notBeforeMs }),
      unavailable,
      enforcement,
    });

    if (input.limits.quota === "exhausted") return waiting("quota-exhausted");
    if (input.limits.retry.status === "active") {
      const retryAt =
        Date.parse(input.limits.retry.until) +
        Math.floor(input.retryJitterUnit * input.maxRetryJitterMs);
      if (input.nowMs < retryAt) return waiting("retry-after", retryAt);
    }

    const requests = checkedAdd(input.allocated.requests, input.demand.requests);
    const tokens = checkedAdd(input.allocated.tokens, input.demand.estimatedTokens);
    const concurrency = checkedAdd(input.allocated.concurrency, 1);
    if (concurrency > input.enforcement.maxObservableConcurrency) {
      return waiting("observable-concurrency");
    }
    const requestCapacity = availableCapacity(input.limits.requests, input.nowMs);
    if (requestCapacity !== undefined && requests > requestCapacity.remaining) {
      return waiting("request-capacity", requestCapacity.notBeforeMs);
    }
    const tokenCapacity = availableCapacity(input.limits.tokens, input.nowMs);
    if (tokenCapacity !== undefined && tokens > tokenCapacity.remaining) {
      return waiting("token-capacity", tokenCapacity.notBeforeMs);
    }
    const concurrencyCapacity = availableCapacity(input.limits.concurrency, input.nowMs);
    if (concurrencyCapacity !== undefined && concurrency > concurrencyCapacity.remaining) {
      return waiting("provider-concurrency", concurrencyCapacity.notBeforeMs);
    }
    return { status: "admitted", unavailable, enforcement };
  },
  reconcileReservedTokens(currentlyAllocatedTokens, reservedTokens, actualTokens) {
    if (reservedTokens > currentlyAllocatedTokens) throw new Error("invalid token reservation");
    return checkedAdd(currentlyAllocatedTokens - reservedTokens, actualTokens);
  },
};

function fixture(options: { jitter?: number; ambiguousTtlMs?: number } = {}) {
  let nowMs = baseMs;
  let randomCalls = 0;
  const scheduler = new ProviderCapacityScheduler({
    now: () => nowMs,
    random: () => {
      randomCalls++;
      return options.jitter ?? 0;
    },
    maxRetryJitterMs: 400,
    ambiguousReservationTtlMs: options.ambiguousTtlMs ?? 5_000,
    capacityPolicy: testCapacityPolicy,
  });
  return {
    scheduler,
    advance(ms: number) {
      nowMs += ms;
    },
    setNow(value: number) {
      nowMs = value;
    },
    get randomCalls() {
      return randomCalls;
    },
  };
}

describe("ProviderCapacityScheduler", () => {
  it("shares one fair provider queue across two threads and subagent-shaped work", () => {
    const { scheduler } = fixture();
    scheduler.updateProviderFacts({
      limits: providerLimits(providerA),
      enforcement: { kind: "observable-api", maxObservableConcurrency: 2 },
    });

    expect(scheduler.submit(work(1)).status).toBe("dispatched");
    expect(scheduler.submit(work(2)).status).toBe("dispatched");
    expect(
      scheduler.submit(work(3, { subject: subject(3, "subagent"), origin: "subagent" })).status,
    ).toBe("queued");
    expect(scheduler.submit(work(4)).status).toBe("queued");

    const terminal = scheduler.recordTerminal({
      reservationId: id(1),
      outcome: "completed",
      actualTokens: 450,
    });
    expect(terminal.reservation.state).toBe("reconciled");
    expect(scheduler.snapshot(providerA).allocated.tokens).toBe(450 + 500 + 500);
    expect(terminal.dispatched.map((entry) => entry.id)).toEqual([id(3)]);
    expect(scheduler.snapshot(providerA).queue.map((entry) => entry.reservationId)).toEqual([
      id(4),
    ]);
    expect(
      scheduler
        .recordTerminal({
          reservationId: id(2),
          outcome: "completed",
          actualTokens: 400,
        })
        .dispatched.map((entry) => entry.id),
    ).toEqual([id(4)]);
  });

  it("keeps configured provider instances independent", () => {
    const { scheduler } = fixture();
    scheduler.updateProviderFacts({
      limits: providerLimits(providerA, {
        concurrency: { status: "available", limit: 1, remaining: 1 },
      }),
      enforcement: { kind: "observable-api", maxObservableConcurrency: 1 },
    });
    scheduler.updateProviderFacts({
      limits: providerLimits(providerB, {
        concurrency: { status: "available", limit: 1, remaining: 1 },
      }),
      enforcement: { kind: "observable-api", maxObservableConcurrency: 1 },
    });

    expect(scheduler.submit(work(10)).status).toBe("dispatched");
    expect(scheduler.submit(work(11, { providerInstanceId: providerB })).status).toBe("dispatched");
    expect(scheduler.snapshot(providerA).allocated.concurrency).toBe(1);
    expect(scheduler.snapshot(providerB).allocated.concurrency).toBe(1);
  });

  it("does not let stale or duplicate fact snapshots erase locally accounted usage", () => {
    const { scheduler } = fixture();
    const initial = providerLimits(providerA);
    scheduler.updateProviderFacts({
      limits: initial,
      enforcement: { kind: "observable-api", maxObservableConcurrency: 2 },
    });
    scheduler.submit(work(15));
    scheduler.recordTerminal({
      reservationId: id(15),
      outcome: "completed",
      actualTokens: 450,
    });
    expect(scheduler.snapshot(providerA).allocated).toMatchObject({ requests: 1, tokens: 450 });

    scheduler.updateProviderFacts({
      limits: initial,
      enforcement: { kind: "observable-api", maxObservableConcurrency: 2 },
    });
    expect(scheduler.snapshot(providerA).allocated).toMatchObject({ requests: 1, tokens: 450 });
    expect(() =>
      scheduler.updateProviderFacts({
        limits: {
          ...initial,
          updatedAt: new Date(baseMs - 1).toISOString() as ProviderServiceLimits["updatedAt"],
        },
        enforcement: { kind: "observable-api", maxObservableConcurrency: 2 },
      }),
    ).toThrow(ProviderCapacitySchedulerRejected);
    expect(scheduler.snapshot(providerA).allocated).toMatchObject({ requests: 1, tokens: 450 });

    scheduler.updateProviderFacts({
      limits: {
        ...initial,
        updatedAt: new Date(baseMs + 1).toISOString() as ProviderServiceLimits["updatedAt"],
      },
      enforcement: { kind: "observable-api", maxObservableConcurrency: 2 },
    });
    expect(scheduler.snapshot(providerA).allocated).toEqual({
      requests: 0,
      tokens: 0,
      concurrency: 0,
    });
  });

  it("labels opaque CLI enforcement honestly and never treats unavailable buckets as unlimited", () => {
    const { scheduler } = fixture();
    scheduler.updateProviderFacts({
      limits: providerLimits(providerA, {
        requests: { status: "unavailable" },
        tokens: { status: "unavailable" },
        concurrency: { status: "unavailable" },
        quota: "unavailable",
        confidence: "unknown",
      }),
      enforcement: { kind: "opaque-cli", maxObservableConcurrency: 1 },
    });

    expect(scheduler.submit(work(20))).toMatchObject({
      status: "dispatched",
      enforcement: "observable-turn-only",
      unavailable: ["requests", "tokens", "concurrency", "quota"],
    });
    expect(scheduler.submit(work(21))).toMatchObject({
      status: "queued",
      reason: "observable-concurrency",
    });
  });

  it("samples bounded retry jitter once and requires an external drain instead of looping", () => {
    const state = fixture({ jitter: 0.5 });
    const retryUntil = new Date(baseMs + 2_000).toISOString() as ProviderServiceLimits["updatedAt"];
    state.scheduler.updateProviderFacts({
      limits: providerLimits(providerA, { retry: { status: "active", until: retryUntil } }),
      enforcement: { kind: "observable-api", maxObservableConcurrency: 2 },
    });
    expect(state.randomCalls).toBe(1);
    expect(state.scheduler.submit(work(30))).toMatchObject({
      status: "queued",
      reason: "retry-after",
      notBeforeMs: baseMs + 2_200,
    });
    expect(state.scheduler.drain(providerA).dispatched).toEqual([]);
    expect(state.scheduler.drain(providerA).dispatched).toEqual([]);
    expect(state.randomCalls).toBe(1);

    state.advance(2_201);
    expect(state.scheduler.drain(providerA).dispatched.map((entry) => entry.id)).toEqual([id(30)]);
    expect(state.randomCalls).toBe(1);
  });

  it("waits for a known request reset and dispatches only after an external drain", () => {
    const state = fixture();
    const resetsAt = new Date(baseMs + 1_000).toISOString() as ProviderServiceLimits["updatedAt"];
    state.scheduler.updateProviderFacts({
      limits: providerLimits(providerA, {
        requests: { status: "available", limit: 2, remaining: 0, resetsAt },
      }),
      enforcement: { kind: "observable-api", maxObservableConcurrency: 2 },
    });
    expect(state.scheduler.submit(work(35))).toMatchObject({
      status: "queued",
      reason: "request-capacity",
      notBeforeMs: baseMs + 1_000,
    });
    state.advance(999);
    expect(state.scheduler.drain(providerA).dispatched).toEqual([]);
    state.advance(1);
    expect(state.scheduler.drain(providerA).dispatched.map((entry) => entry.id)).toEqual([id(35)]);
  });

  it("rolls finalized request and token usage into the next known reset window", () => {
    const state = fixture();
    const resetsAt = new Date(baseMs + 1_000).toISOString() as ProviderServiceLimits["updatedAt"];
    state.scheduler.updateProviderFacts({
      limits: providerLimits(providerA, {
        requests: { status: "available", limit: 1, remaining: 1, resetsAt },
        tokens: { status: "available", limit: 500, remaining: 500, resetsAt },
        concurrency: { status: "available", limit: 1, remaining: 1 },
      }),
      enforcement: { kind: "observable-api", maxObservableConcurrency: 1 },
    });
    expect(state.scheduler.submit(work(36)).status).toBe("dispatched");
    state.scheduler.recordTerminal({
      reservationId: id(36),
      outcome: "completed",
      actualTokens: 500,
    });
    expect(state.scheduler.submit(work(37)).status).toBe("queued");
    state.advance(1_000);
    expect(state.scheduler.drain(providerA).dispatched.map((entry) => entry.id)).toEqual([id(37)]);
  });

  it.each(["cancelled", "interrupted", "timeout", "process-death"] as const)(
    "holds %s work ambiguously until actual usage reconciliation",
    (outcome) => {
      const { scheduler } = fixture();
      scheduler.updateProviderFacts({
        limits: providerLimits(providerA, {
          concurrency: { status: "available", limit: 1, remaining: 1 },
        }),
        enforcement: { kind: "observable-api", maxObservableConcurrency: 1 },
      });
      scheduler.submit(work(40));
      scheduler.submit(work(41));

      const terminal = scheduler.recordTerminal({ reservationId: id(40), outcome });
      expect(terminal.reservation.state).toBe("ambiguous");
      expect(terminal.dispatched).toEqual([]);
      expect(scheduler.snapshot(providerA).allocated.concurrency).toBe(1);

      const reconciled = scheduler.reconcile(id(40), 320);
      expect(reconciled.reservation.state).toBe("reconciled");
      expect(reconciled.dispatched.map((entry) => entry.id)).toEqual([id(41)]);
    },
  );

  it("conservatively expires ambiguous restart work without assuming zero usage", () => {
    const state = fixture({ ambiguousTtlMs: 1_000 });
    state.scheduler.updateProviderFacts({
      limits: providerLimits(providerA, {
        requests: { status: "unavailable" },
        tokens: { status: "unavailable" },
        concurrency: { status: "unavailable" },
      }),
      enforcement: { kind: "opaque-cli", maxObservableConcurrency: 1 },
    });
    state.scheduler.restore([
      {
        id: id(50),
        subject: subject(50),
        providerInstanceId: providerA,
        modelId: model,
        state: "running",
        estimatedTokens: 700,
        requests: 1,
        createdAt: new Date(baseMs).toISOString() as ProviderServiceLimits["updatedAt"],
        updatedAt: new Date(baseMs).toISOString() as ProviderServiceLimits["updatedAt"],
      },
    ]);
    expect(state.scheduler.getReservation(id(50))?.state).toBe("ambiguous");
    expect(state.scheduler.submit(work(51)).status).toBe("queued");

    state.advance(999);
    expect(state.scheduler.expireAmbiguous().dispatched).toEqual([]);
    state.advance(2);
    const expired = state.scheduler.expireAmbiguous();
    expect(expired.released.map((entry) => entry.id)).toEqual([id(50)]);
    expect(expired.dispatched.map((entry) => entry.id)).toEqual([id(51)]);
    expect(state.scheduler.snapshot(providerA).allocated).toEqual({
      requests: 2,
      tokens: 1_200,
      concurrency: 1,
    });
  });

  it("reconciles expired ambiguous usage into its old bucket generation after reset", () => {
    const state = fixture({ ambiguousTtlMs: 1_000 });
    const resetsAt = new Date(baseMs + 500).toISOString() as ProviderServiceLimits["updatedAt"];
    state.scheduler.updateProviderFacts({
      limits: providerLimits(providerA, {
        requests: { status: "available", limit: 1, remaining: 1, resetsAt },
        tokens: { status: "available", limit: 500, remaining: 500, resetsAt },
        concurrency: { status: "available", limit: 1, remaining: 1 },
      }),
      enforcement: { kind: "observable-api", maxObservableConcurrency: 1 },
    });
    state.scheduler.submit(work(52));
    state.scheduler.recordTerminal({ reservationId: id(52), outcome: "timeout" });
    state.advance(1_001);
    expect(state.scheduler.expireAmbiguous().released.map((entry) => entry.id)).toEqual([id(52)]);
    expect(state.scheduler.snapshot(providerA).allocated).toEqual({
      requests: 0,
      tokens: 0,
      concurrency: 0,
    });

    const reconciled = state.scheduler.reconcile(id(52), 320);
    expect(reconciled.reservation).toMatchObject({ state: "reconciled", actualTokens: 320 });
    expect(state.scheduler.reconcile(id(52), 320).reservation).toEqual(reconciled.reservation);
    expect(state.scheduler.snapshot(providerA).allocated).toEqual({
      requests: 0,
      tokens: 0,
      concurrency: 0,
    });
  });

  it("marks running work ambiguous on shutdown and leaves never-dispatched queue work requested", () => {
    const { scheduler } = fixture();
    scheduler.updateProviderFacts({
      limits: providerLimits(providerA, {
        concurrency: { status: "available", limit: 1, remaining: 1 },
      }),
      enforcement: { kind: "observable-api", maxObservableConcurrency: 1 },
    });
    scheduler.submit(work(60));
    scheduler.markRunning(id(60));
    scheduler.submit(work(61));

    const result = scheduler.shutdown();
    expect(result.map((entry) => [entry.id, entry.state])).toEqual([[id(60), "ambiguous"]]);
    expect(scheduler.getReservation(id(61))?.state).toBe("requested");
  });

  it("makes duplicate terminal signals idempotent but rejects conflicts and unknown ids", () => {
    const { scheduler } = fixture();
    scheduler.updateProviderFacts({
      limits: providerLimits(providerA),
      enforcement: { kind: "observable-api", maxObservableConcurrency: 2 },
    });
    scheduler.submit(work(70));
    const signal = { reservationId: id(70), outcome: "completed" as const, actualTokens: 480 };
    const first = scheduler.recordTerminal(signal);
    const duplicate = scheduler.recordTerminal(signal);
    expect(duplicate.reservation).toEqual(first.reservation);
    expect(duplicate.dispatched).toEqual([]);
    expect(() => scheduler.recordTerminal({ ...signal, actualTokens: 481 })).toThrow(
      ProviderCapacitySchedulerRejected,
    );
    expect(() => scheduler.recordTerminal({ reservationId: id(999), outcome: "timeout" })).toThrow(
      ProviderCapacitySchedulerRejected,
    );
    scheduler.submit(work(71));
    expect(() =>
      scheduler.recordTerminal({
        reservationId: id(71),
        outcome: "runtime-mystery",
      } as unknown as Parameters<typeof scheduler.recordTerminal>[0]),
    ).toThrow(ProviderCapacitySchedulerRejected);
    expect(scheduler.getReservation(id(71))?.state).toBe("reserved");
  });

  it("leaves terminal and reconciliation state unchanged when a late clock failure occurs", () => {
    const state = fixture();
    state.scheduler.updateProviderFacts({
      limits: providerLimits(providerA),
      enforcement: { kind: "observable-api", maxObservableConcurrency: 2 },
    });
    state.scheduler.submit(work(72));
    const beforeTerminal = state.scheduler.getReservation(id(72));
    const beforeTerminalSnapshot = state.scheduler.snapshot(providerA);
    state.setNow(-1);
    expect(() =>
      state.scheduler.recordTerminal({
        reservationId: id(72),
        outcome: "completed",
        actualTokens: 450,
      }),
    ).toThrow(ProviderCapacitySchedulerRejected);
    state.setNow(baseMs);
    expect(state.scheduler.getReservation(id(72))).toEqual(beforeTerminal);
    expect(state.scheduler.snapshot(providerA)).toEqual(beforeTerminalSnapshot);

    state.setNow(baseMs);
    state.scheduler.recordTerminal({ reservationId: id(72), outcome: "timeout" });
    const beforeReconcile = state.scheduler.getReservation(id(72));
    const beforeReconcileSnapshot = state.scheduler.snapshot(providerA);
    state.setNow(-1);
    expect(() => state.scheduler.reconcile(id(72), 450)).toThrow(ProviderCapacitySchedulerRejected);
    state.setNow(baseMs);
    expect(state.scheduler.getReservation(id(72))).toEqual(beforeReconcile);
    expect(state.scheduler.snapshot(providerA)).toEqual(beforeReconcileSnapshot);
  });

  it("releases never-dispatched cancellation without consuming capacity", () => {
    const { scheduler } = fixture();
    scheduler.updateProviderFacts({
      limits: providerLimits(providerA, {
        concurrency: { status: "available", limit: 1, remaining: 1 },
      }),
      enforcement: { kind: "observable-api", maxObservableConcurrency: 1 },
    });
    scheduler.submit(work(75));
    scheduler.submit(work(76));
    const before = scheduler.snapshot(providerA).allocated;

    expect(
      scheduler.recordTerminal({ reservationId: id(76), outcome: "cancelled" }).reservation.state,
    ).toBe("released");
    expect(scheduler.snapshot(providerA).allocated).toEqual(before);
    expect(scheduler.snapshot(providerA).queue).toEqual([]);
  });

  it("rejects reconciliation after never-dispatched work is cancelled and released", () => {
    const { scheduler } = fixture();
    scheduler.updateProviderFacts({
      limits: providerLimits(providerA, {
        concurrency: { status: "available", limit: 1, remaining: 1 },
      }),
      enforcement: { kind: "observable-api", maxObservableConcurrency: 1 },
    });
    scheduler.submit(work(78));
    expect(scheduler.submit(work(79)).status).toBe("queued");
    scheduler.recordTerminal({ reservationId: id(79), outcome: "cancelled" });
    const released = scheduler.getReservation(id(79));
    const snapshot = scheduler.snapshot(providerA);

    expect(() => scheduler.reconcile(id(79), 0)).toThrow(ProviderCapacitySchedulerRejected);
    expect(scheduler.getReservation(id(79))).toEqual(released);
    expect(scheduler.snapshot(providerA)).toEqual(snapshot);
  });

  it("fails closed before creating a reservation when provider facts are absent", () => {
    const { scheduler } = fixture();
    expect(() =>
      scheduler.updateProviderFacts({
        limits: providerLimits(providerA),
        enforcement: {
          kind: "runtime-mystery",
          maxObservableConcurrency: 1,
        } as unknown as Parameters<typeof scheduler.updateProviderFacts>[0]["enforcement"],
      }),
    ).toThrow(ProviderCapacitySchedulerRejected);
    expect(() => scheduler.submit(work(77))).toThrow(ProviderCapacitySchedulerRejected);
    expect(scheduler.getReservation(id(77))).toBeUndefined();
  });

  it("rejects duplicate reservation ids and demands that can never fit known hard limits", () => {
    const { scheduler } = fixture();
    scheduler.updateProviderFacts({
      limits: providerLimits(providerA, {
        requests: { status: "available", limit: 2, remaining: 2 },
        tokens: { status: "available", limit: 1_000, remaining: 1_000 },
      }),
      enforcement: { kind: "observable-api", maxObservableConcurrency: 2 },
    });
    scheduler.submit(work(80));
    expect(() => scheduler.submit(work(80))).toThrow(ProviderCapacitySchedulerRejected);
    expect(() => scheduler.submit(work(81, { estimatedTokens: 1_001 }))).toThrow(
      ProviderCapacitySchedulerRejected,
    );
    expect(() => scheduler.submit(work(82, { requests: 3 }))).toThrow(
      ProviderCapacitySchedulerRejected,
    );
  });

  it("rejects an invalid restore batch atomically", () => {
    const { scheduler } = fixture();
    scheduler.updateProviderFacts({
      limits: providerLimits(providerA),
      enforcement: { kind: "observable-api", maxObservableConcurrency: 2 },
    });
    const restored = {
      id: id(90),
      subject: subject(90),
      providerInstanceId: providerA,
      modelId: model,
      state: "running" as const,
      estimatedTokens: 700,
      requests: 1,
      createdAt: new Date(baseMs).toISOString() as ProviderServiceLimits["updatedAt"],
      updatedAt: new Date(baseMs).toISOString() as ProviderServiceLimits["updatedAt"],
    };

    expect(() => scheduler.restore([restored, restored])).toThrow(
      ProviderCapacitySchedulerRejected,
    );
    expect(scheduler.getReservation(id(90))).toBeUndefined();
    expect(scheduler.snapshot(providerA).allocated).toEqual({
      requests: 0,
      tokens: 0,
      concurrency: 0,
    });
  });
});
