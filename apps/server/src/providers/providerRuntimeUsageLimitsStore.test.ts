import {
  decodeProviderInstanceId,
  decodeProviderRuntimeEvent,
  type ProviderRateLimitWindow,
  type ProviderRuntimeEvent,
  type UtcTimestamp,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { ProviderRuntimeUsageLimitsStore } from "./providerRuntimeUsageLimitsStore";

const instanceId = decodeProviderInstanceId("00000000-0000-4000-8000-000000000001");
const sessionId = "00000000-0000-4000-8000-000000000002";
const occurredAt = "2026-08-24T01:00:00.000Z" as UtcTimestamp;
const timestamp = (value: string): UtcTimestamp => value as UtcTimestamp;

function windowEvent(overrides: Partial<ProviderRuntimeEvent> = {}): ProviderRuntimeEvent {
  return decodeProviderRuntimeEvent({
    instanceId,
    sessionId,
    sequence: 1,
    correlationId: "00000000-0000-4000-8000-000000000003",
    occurredAt,
    kind: "rate-limit-window",
    window: "five_hour",
    status: "warning",
    utilization: 0.87,
    resetsAt: "2026-08-24T02:00:00.000Z",
    ...overrides,
  });
}

describe("ProviderRuntimeUsageLimitsStore", () => {
  it("keeps the newest normalized window and exposes it as service-limit evidence", () => {
    const store = new ProviderRuntimeUsageLimitsStore();
    store.record(windowEvent());
    store.record(
      windowEvent({
        sequence: 2,
        occurredAt: timestamp("2026-08-24T01:01:00.000Z"),
        status: "exhausted",
        utilization: 1,
      }),
    );

    expect(store.windows(instanceId)).toEqual([
      expect.objectContaining({
        window: "five_hour",
        status: "exhausted",
        utilization: 1,
      }),
    ]);
    expect(store.serviceLimits(instanceId, timestamp("2026-08-24T01:30:00.000Z"))).toMatchObject({
      providerInstanceId: instanceId,
      source: "runtime-reported",
      confidence: "high",
      quota: "unknown",
      updatedAt: "2026-08-24T01:01:00.000Z",
      rateLimitWindows: [expect.objectContaining({ window: "five_hour", status: "exhausted" })],
    });
  });

  it("keeps the later equal-timestamp window update", () => {
    const store = new ProviderRuntimeUsageLimitsStore();
    store.record(windowEvent({ status: "warning", utilization: 0.87 }));
    store.record(windowEvent({ sequence: 2, status: "exhausted", utilization: 1 }));

    expect(store.windows(instanceId)).toEqual([
      expect.objectContaining({ window: "five_hour", status: "exhausted", utilization: 1 }),
    ]);
  });

  it("ignores stale and non-limit runtime events", () => {
    const store = new ProviderRuntimeUsageLimitsStore();
    store.record(windowEvent());
    store.record(windowEvent({ sequence: 2, occurredAt: timestamp("2026-08-24T00:59:00.000Z") }));
    store.record(
      decodeProviderRuntimeEvent({
        instanceId,
        sessionId,
        sequence: 3,
        correlationId: "00000000-0000-4000-8000-000000000003",
        occurredAt,
        kind: "text-delta",
        text: "hello",
      }),
    );

    expect(store.windows(instanceId)).toEqual([
      expect.objectContaining({
        observedAt: occurredAt,
      }) satisfies Partial<ProviderRateLimitWindow>,
    ]);
  });

  it("bounds retained provider windows", () => {
    const store = new ProviderRuntimeUsageLimitsStore({ maxWindowsPerProvider: 2 });
    for (const [index, name] of ["first", "second", "third"].entries()) {
      store.record(
        windowEvent({
          sequence: index + 1,
          window: name,
          occurredAt: timestamp(`2026-08-24T01:0${index}:00.000Z`),
        }),
      );
    }

    expect(store.windows(instanceId).map((entry) => entry.window)).toEqual(["second", "third"]);
  });

  it("rejects retention above the ProviderServiceLimits contract cap", () => {
    expect(() => new ProviderRuntimeUsageLimitsStore({ maxWindowsPerProvider: 33 })).toThrow(
      "between 1 and 32",
    );
  });

  it("does not expose a window after its provider-reported reset", () => {
    const store = new ProviderRuntimeUsageLimitsStore();
    store.record(windowEvent());

    expect(store.serviceLimits(instanceId, timestamp("2026-08-24T02:00:00.000Z"))).toBeUndefined();
    expect(store.windows(instanceId)).toEqual([]);
  });

  it("does not resurrect a reset window from a late event", () => {
    const store = new ProviderRuntimeUsageLimitsStore();
    store.record(windowEvent());
    expect(store.windows(instanceId, timestamp("2026-08-24T02:00:00.000Z"))).toEqual([]);

    store.record(
      windowEvent({
        sequence: 2,
        occurredAt: timestamp("2026-08-24T01:30:00.000Z"),
      }),
    );

    expect(store.windows(instanceId)).toEqual([]);
  });

  it("does not resurrect a reset window when a late event omits its reset", () => {
    const store = new ProviderRuntimeUsageLimitsStore();
    store.record(windowEvent());
    expect(store.windows(instanceId, timestamp("2026-08-24T02:00:00.000Z"))).toEqual([]);

    store.record(
      windowEvent({
        sequence: 2,
        occurredAt: timestamp("2026-08-24T01:30:00.000Z"),
        resetsAt: undefined,
      }),
    );

    expect(store.windows(instanceId)).toEqual([]);
  });

  it("accepts new post-reset evidence when the provider omits a reset instant", () => {
    const store = new ProviderRuntimeUsageLimitsStore();
    store.record(windowEvent());
    expect(store.windows(instanceId, timestamp("2026-08-24T02:00:00.000Z"))).toEqual([]);

    store.record(
      windowEvent({
        sequence: 2,
        occurredAt: timestamp("2026-08-24T02:30:00.000Z"),
        status: "allowed",
        resetsAt: undefined,
      }),
    );

    expect(store.windows(instanceId)).toEqual([
      expect.objectContaining({ window: "five_hour", status: "allowed" }),
    ]);
  });

  it("bounds retained provider identities as well as windows per provider", () => {
    const otherInstanceId = decodeProviderInstanceId("00000000-0000-4000-8000-000000000004");
    const store = new ProviderRuntimeUsageLimitsStore({ maxProviders: 1 });
    store.record(windowEvent());
    store.record(
      windowEvent({
        instanceId: otherInstanceId,
        sequence: 2,
        occurredAt: timestamp("2026-08-24T01:01:00.000Z"),
      }),
    );

    expect(store.windows(instanceId)).toEqual([]);
    expect(store.windows(otherInstanceId)).toHaveLength(1);
  });

  it("clears all evidence for a provider identity when its configuration is invalidated", () => {
    const store = new ProviderRuntimeUsageLimitsStore();
    store.record(windowEvent());

    store.clear(instanceId);

    expect(store.windows(instanceId)).toEqual([]);
    expect(store.serviceLimits(instanceId, timestamp("2026-08-24T01:02:00.000Z"))).toBeUndefined();
  });

  it("exposes header quota buckets as exact limits until they refill", () => {
    const store = new ProviderRuntimeUsageLimitsStore();
    store.record(bucketEvent({ bucket: "requests", limit: 500, remaining: 120 }));
    store.record(
      bucketEvent({
        sequence: 2,
        bucket: "tokens",
        limit: 30_000,
        remaining: 29_000,
        resetsAt: "2026-08-24T01:06:00.000Z",
      }),
    );

    expect(store.serviceLimits(instanceId, timestamp("2026-08-24T01:03:00.000Z"))).toMatchObject({
      source: "runtime-reported",
      requests: { status: "available", limit: 500, remaining: 120 },
      tokens: { status: "available", limit: 30_000, remaining: 29_000 },
      concurrency: { status: "unavailable" },
    });
    expect(
      store.serviceLimits(instanceId, timestamp("2026-08-24T01:03:00.000Z")),
    ).not.toHaveProperty("rateLimitWindows");

    const afterRefill = store.serviceLimits(instanceId, timestamp("2026-08-24T01:06:00.000Z"));
    expect(afterRefill?.requests).toMatchObject({ status: "available", remaining: 120 });
    expect(afterRefill?.tokens).toEqual({ status: "unavailable" });
  });

  it("keeps the newest bucket observation when an older one arrives late", () => {
    const store = new ProviderRuntimeUsageLimitsStore();
    store.record(
      bucketEvent({
        sequence: 2,
        occurredAt: timestamp("2026-08-24T01:01:00.000Z"),
        bucket: "requests",
        limit: 500,
        remaining: 100,
      }),
    );
    store.record(bucketEvent({ bucket: "requests", limit: 500, remaining: 400 }));

    expect(
      store.serviceLimits(instanceId, timestamp("2026-08-24T01:02:00.000Z"))?.requests,
    ).toMatchObject({ remaining: 100 });
  });

  it("remembers whether the last completed turn carried quota buckets", () => {
    const store = new ProviderRuntimeUsageLimitsStore();
    expect(store.lastCompletedTurn(instanceId)).toBeUndefined();

    store.record(terminalEvent("completed"));
    expect(store.lastCompletedTurn(instanceId)).toBe("silent");

    store.record(bucketEvent({ sequence: 2, bucket: "requests", limit: 500, remaining: 120 }));
    store.record(terminalEvent("completed", 3));
    expect(store.lastCompletedTurn(instanceId)).toBe("reported");

    // A failed turn proves nothing about headers; the verdict stays.
    store.record(terminalEvent("failed", 4));
    expect(store.lastCompletedTurn(instanceId)).toBe("reported");
  });
});

function bucketEvent(
  overrides: Partial<Extract<ProviderRuntimeEvent, { kind: "rate-limit-bucket" }>>,
): ProviderRuntimeEvent {
  return decodeProviderRuntimeEvent({
    instanceId,
    sessionId,
    sequence: 1,
    correlationId: "00000000-0000-4000-8000-000000000003",
    occurredAt,
    kind: "rate-limit-bucket",
    bucket: "requests",
    limit: 100,
    remaining: 50,
    ...overrides,
  });
}

function terminalEvent(kind: "completed" | "failed", sequence = 1): ProviderRuntimeEvent {
  return decodeProviderRuntimeEvent({
    instanceId,
    sessionId,
    sequence,
    correlationId: "00000000-0000-4000-8000-000000000003",
    occurredAt,
    ...(kind === "completed"
      ? { kind }
      : { kind, failure: { category: "provider-failed", message: "Provider stopped" } }),
  });
}
