import {
  decodeCapacityReservationId,
  decodeContextSubjectRef,
  decodeProviderInstanceId,
  decodeProviderServiceLimits,
  type UtcTimestamp,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  CONTEXT_MAINTENANCE_POLICY,
  makeProviderCapacityScheduler,
  makeUnobservedProviderCapacityFacts,
} from "./contextRuntime";

const providerInstanceId = decodeProviderInstanceId("83000000-0000-4000-8000-000000000001");
const subject = decodeContextSubjectRef({
  aggregateType: "project",
  aggregateId: "83000000-0000-4000-8000-000000000002",
});

describe("integrated context runtime", () => {
  it("injects the real domain capacity policy and shares one provider slot across thread and subagent work", () => {
    const scheduler = makeProviderCapacityScheduler({
      now: () => Date.parse("2026-07-18T21:00:00.000Z"),
      random: () => 0,
      maxRetryJitterMs: 1_000,
      ambiguousReservationTtlMs: 60_000,
    });
    scheduler.updateProviderFacts({
      limits: decodeProviderServiceLimits({
        providerInstanceId,
        scope: "provider-instance",
        requests: { status: "unavailable" },
        tokens: { status: "unavailable" },
        concurrency: { status: "available", limit: 1, remaining: 1 },
        retry: { status: "inactive" },
        quota: "unknown",
        source: "runtime-reported",
        confidence: "high",
        updatedAt: "2026-07-18T21:00:00.000Z",
      }),
      enforcement: { kind: "observable-api", maxObservableConcurrency: 1 },
    });

    const thread = scheduler.submit(work(1, "thread"));
    const child = scheduler.submit(work(2, "subagent"));
    expect(thread.status).toBe("dispatched");
    expect(child).toMatchObject({ status: "queued", reason: "observable-concurrency" });

    const released = scheduler.recordTerminal({
      reservationId: work(1, "thread").reservationId,
      outcome: "completed",
      actualTokens: 90,
    });
    expect(released.dispatched.map(({ id }) => id)).toEqual([work(2, "subagent").reservationId]);
  });

  it("seeds unobserved provider capacity once and then defers to the observed facts", () => {
    const scheduler = makeProviderCapacityScheduler({
      now: () => Date.parse("2026-07-18T21:00:00.000Z"),
      random: () => 0,
      maxRetryJitterMs: 1_000,
      ambiguousReservationTtlMs: 60_000,
    });
    const resolve = makeUnobservedProviderCapacityFacts({
      scheduler,
      now: () => "2026-07-18T21:00:00.000Z" as UtcTimestamp,
    });

    // Nothing observed yet: the honest "unknown" record is the first fact, so
    // work on a provider no turn has touched is still schedulable.
    expect(resolve({ providerInstanceId })).toMatchObject({
      requests: { status: "unavailable" },
      retry: { status: "inactive" },
      quota: "unavailable",
      confidence: "unknown",
    });

    scheduler.updateProviderFacts({
      limits: decodeProviderServiceLimits({
        providerInstanceId,
        scope: "provider-instance",
        requests: { status: "available", limit: 100, remaining: 0 },
        tokens: { status: "unavailable" },
        concurrency: { status: "available", limit: 1, remaining: 1 },
        retry: { status: "active", until: "2026-07-18T21:05:00.000Z" },
        quota: "exhausted",
        source: "runtime-reported",
        confidence: "high",
        updatedAt: "2026-07-18T21:00:00.000Z",
      }),
      enforcement: { kind: "observable-api", maxObservableConcurrency: 1 },
    });

    expect(resolve({ providerInstanceId })).toBeUndefined();
  });

  it("injects the real compaction, variance, and one-retry recovery policies", () => {
    expect(
      CONTEXT_MAINTENANCE_POLICY.reconcileVariance({
        requestShape: "code-turn",
        expectedRequestShape: "code-turn",
        plannedInputTokens: 100,
        actualInputTokens: 140,
        currentVarianceReserve: 20,
        maxAdjustmentTokens: 50,
      }),
    ).toEqual({
      requestShape: "code-turn",
      varianceTokens: 40,
      reserveAdjustmentTokens: 40,
      nextVarianceReserve: 60,
    });
    expect(
      CONTEXT_MAINTENANCE_POLICY.decideContextLengthRecovery({
        currentMarginTokens: 100,
        marginIncreaseTokens: 50,
        rebuilds: 0,
      }),
    ).toEqual({ kind: "rebuild-once", nextMarginTokens: 150 });
  });
});

function work(index: number, origin: "thread" | "subagent") {
  return {
    reservationId: decodeCapacityReservationId(
      `83000000-0000-4000-8000-${String(100 + index).padStart(12, "0")}`,
    ),
    subject,
    providerInstanceId,
    modelId: "model-a" as never,
    estimatedTokens: 100,
    requests: 1,
    origin,
  } as const;
}
