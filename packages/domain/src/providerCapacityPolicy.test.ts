import { describe, expect, it } from "vitest";
import type { ProviderInstanceId, ProviderServiceLimits } from "@octant/contracts";
import {
  ProviderCapacityPolicyRejected,
  compareCapacityQueueOrder,
  evaluateCapacityAdmission,
  reconcileReservedTokens,
} from "./providerCapacityPolicy";

const provider = "00000000-0000-4000-8000-000000000005" as ProviderInstanceId;
const otherProvider = "00000000-0000-4000-8000-000000000006" as ProviderInstanceId;
const updatedAt = "2026-07-18T18:30:00.000Z" as ProviderServiceLimits["updatedAt"];

function limits(overrides: Partial<ProviderServiceLimits> = {}): ProviderServiceLimits {
  return {
    providerInstanceId: provider,
    scope: "provider-instance",
    requests: { status: "available", limit: 10, remaining: 4 },
    tokens: { status: "available", limit: 10_000, remaining: 2_000 },
    concurrency: { status: "available", limit: 2, remaining: 2 },
    retry: { status: "inactive" },
    quota: "available",
    source: "runtime-reported",
    confidence: "high",
    updatedAt,
    ...overrides,
  };
}

describe("provider capacity policy", () => {
  it("admits only when known request, token, and concurrency capacity can be reserved", () => {
    expect(
      evaluateCapacityAdmission({
        providerInstanceId: provider,
        limits: limits(),
        enforcement: { kind: "observable-api", maxObservableConcurrency: 2 },
        demand: { requests: 1, estimatedTokens: 900 },
        allocated: { requests: 2, tokens: 1_000, concurrency: 1 },
        nowMs: Date.parse(updatedAt),
        retryJitterUnit: 0,
        maxRetryJitterMs: 500,
      }),
    ).toMatchObject({ status: "admitted", unavailable: [] });

    expect(
      evaluateCapacityAdmission({
        providerInstanceId: provider,
        limits: limits(),
        enforcement: { kind: "observable-api", maxObservableConcurrency: 2 },
        demand: { requests: 1, estimatedTokens: 1_001 },
        allocated: { requests: 2, tokens: 1_000, concurrency: 1 },
        nowMs: Date.parse(updatedAt),
        retryJitterUnit: 0,
        maxRetryJitterMs: 500,
      }),
    ).toMatchObject({ status: "waiting", reason: "token-capacity" });
  });

  it("keeps unavailable service buckets explicit and bounds opaque CLIs at the observable turn", () => {
    const unavailable = limits({
      requests: { status: "unavailable" },
      tokens: { status: "unavailable" },
      concurrency: { status: "unavailable" },
      quota: "unavailable",
      confidence: "unknown",
    });
    const base = {
      providerInstanceId: provider,
      limits: unavailable,
      enforcement: { kind: "opaque-cli", maxObservableConcurrency: 1 } as const,
      demand: { requests: 1, estimatedTokens: 50 },
      allocated: { requests: 0, tokens: 0, concurrency: 0 },
      nowMs: Date.parse(updatedAt),
      retryJitterUnit: 0,
      maxRetryJitterMs: 500,
    };

    expect(evaluateCapacityAdmission(base)).toEqual({
      status: "admitted",
      unavailable: ["requests", "tokens", "concurrency", "quota"],
      enforcement: "observable-turn-only",
    });
    expect(
      evaluateCapacityAdmission({
        ...base,
        allocated: { requests: 1, tokens: 50, concurrency: 1 },
      }),
    ).toMatchObject({
      status: "waiting",
      reason: "observable-concurrency",
      unavailable: ["requests", "tokens", "concurrency", "quota"],
    });
  });

  it("respects retry-after with deterministic bounded jitter and does not invent a retry loop", () => {
    const retryUntil = "2026-07-18T18:30:05.000Z" as ProviderServiceLimits["updatedAt"];
    const result = evaluateCapacityAdmission({
      providerInstanceId: provider,
      limits: limits({ retry: { status: "active", until: retryUntil } }),
      enforcement: { kind: "observable-api", maxObservableConcurrency: 2 },
      demand: { requests: 1, estimatedTokens: 100 },
      allocated: { requests: 0, tokens: 0, concurrency: 0 },
      nowMs: Date.parse(updatedAt),
      retryJitterUnit: 0.75,
      maxRetryJitterMs: 400,
    });

    expect(result).toEqual({
      status: "waiting",
      reason: "retry-after",
      notBeforeMs: Date.parse(retryUntil) + 300,
      unavailable: [],
      enforcement: "fine-grained",
    });
    expect(
      evaluateCapacityAdmission({
        providerInstanceId: provider,
        limits: limits({ retry: { status: "active", until: retryUntil } }),
        enforcement: { kind: "observable-api", maxObservableConcurrency: 2 },
        demand: { requests: 1, estimatedTokens: 100 },
        allocated: { requests: 0, tokens: 0, concurrency: 0 },
        nowMs: Date.parse(retryUntil) + 301,
        retryJitterUnit: 0.75,
        maxRetryJitterMs: 400,
      }),
    ).toMatchObject({ status: "admitted" });
  });

  it("waits for a known bucket reset and admits after the reset without guessing before it", () => {
    const resetsAt = "2026-07-18T18:30:03.000Z" as ProviderServiceLimits["updatedAt"];
    const input = {
      providerInstanceId: provider,
      limits: limits({
        requests: { status: "available", limit: 10, remaining: 0, resetsAt },
      }),
      enforcement: { kind: "observable-api", maxObservableConcurrency: 2 } as const,
      demand: { requests: 1, estimatedTokens: 100 },
      allocated: { requests: 0, tokens: 0, concurrency: 0 },
      nowMs: Date.parse(updatedAt),
      retryJitterUnit: 0,
      maxRetryJitterMs: 500,
    };
    expect(evaluateCapacityAdmission(input)).toMatchObject({
      status: "waiting",
      reason: "request-capacity",
      notBeforeMs: Date.parse(resetsAt),
    });
    expect(evaluateCapacityAdmission({ ...input, nowMs: Date.parse(resetsAt) })).toMatchObject({
      status: "admitted",
    });
  });

  it("rejects mismatched facts, contradictory ceilings, and unsafe arithmetic", () => {
    const base = {
      providerInstanceId: provider,
      limits: limits({ providerInstanceId: otherProvider }),
      enforcement: { kind: "observable-api", maxObservableConcurrency: 2 } as const,
      demand: { requests: 1, estimatedTokens: 100 },
      allocated: { requests: 0, tokens: 0, concurrency: 0 },
      nowMs: Date.parse(updatedAt),
      retryJitterUnit: 0,
      maxRetryJitterMs: 500,
    };
    expect(() => evaluateCapacityAdmission(base)).toThrow(ProviderCapacityPolicyRejected);
    expect(() =>
      evaluateCapacityAdmission({
        ...base,
        limits: limits(),
        enforcement: { kind: "observable-api", maxObservableConcurrency: 3 },
      }),
    ).toThrow(ProviderCapacityPolicyRejected);
    expect(() =>
      evaluateCapacityAdmission({
        ...base,
        limits: limits(),
        allocated: { requests: Number.MAX_SAFE_INTEGER, tokens: 0, concurrency: 0 },
      }),
    ).toThrow(ProviderCapacityPolicyRejected);
    expect(() => reconcileReservedTokens(Number.MAX_SAFE_INTEGER, 0, 1)).toThrow(
      ProviderCapacityPolicyRejected,
    );
    expect(() =>
      evaluateCapacityAdmission({
        ...base,
        limits: limits(),
        enforcement: {
          kind: "mystery-runtime",
          maxObservableConcurrency: 1,
        } as unknown as typeof base.enforcement,
      }),
    ).toThrow(ProviderCapacityPolicyRejected);
  });

  it("orders equal-provider queue work by arrival sequence then Unicode code point id", () => {
    const items = [
      { sequence: 2, reservationId: "a" },
      { sequence: 1, reservationId: "\u{10000}" },
      { sequence: 1, reservationId: "\uE000" },
    ];
    expect(items.toSorted(compareCapacityQueueOrder).map((item) => item.reservationId)).toEqual([
      "\uE000",
      "\u{10000}",
      "a",
    ]);
  });
});
