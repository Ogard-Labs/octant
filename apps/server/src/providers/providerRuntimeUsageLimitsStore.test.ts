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
});
