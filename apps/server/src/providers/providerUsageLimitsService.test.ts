import { describe, expect, it, vi } from "vitest";
import {
  decodeProviderInstance,
  decodeProviderServiceLimits,
  type ProviderInstance,
  type ProviderInstanceId,
  type ProviderServiceLimits,
  type UtcTimestamp,
} from "@octant/contracts";
import { ProviderUsageLimitsService } from "./providerUsageLimitsService";
import { ProviderRuntimeUsageLimitsStore } from "./providerRuntimeUsageLimitsStore";

const firstId = "11111111-1111-4111-8111-111111111111" as ProviderInstanceId;
const secondId = "22222222-2222-4222-8222-222222222222" as ProviderInstanceId;

function instance(id: ProviderInstanceId, enabled = true): ProviderInstance {
  return decodeProviderInstance({
    id,
    displayName: `Provider ${String(id).slice(0, 4)}`,
    driverKind: "codex",
    enabled,
    configuration: { kind: "codex-cli", binaryPath: "/usr/local/bin/codex" },
    environmentPolicy: "inherit-host",
    createdAt: "2026-08-23T12:00:00.000Z",
    updatedAt: "2026-08-23T12:00:00.000Z",
    version: 1,
  });
}

function limits(id: ProviderInstanceId, remaining: number): ProviderServiceLimits {
  return decodeProviderServiceLimits({
    providerInstanceId: id,
    scope: "account",
    requests: { status: "available", limit: 100, remaining },
    tokens: { status: "unavailable" },
    concurrency: { status: "unavailable" },
    retry: { status: "inactive" },
    quota: "available",
    source: "observed-evidence",
    confidence: "high",
    updatedAt: "2026-08-23T12:00:00.000Z",
  });
}

describe("ProviderUsageLimitsService", () => {
  it("coalesces concurrent refreshes and isolates an unavailable provider", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const observe = vi.fn(async (provider: ProviderInstance) => {
      await gate;
      return String(provider.id) === String(firstId)
        ? { source: "provider-runtime" as const, limits: limits(firstId, 75) }
        : undefined;
    });
    const service = new ProviderUsageLimitsService({
      listInstances: () => [instance(firstId), instance(secondId)],
      observe,
      now: () => "2026-08-23T12:00:00.000Z" as UtcTimestamp,
    });

    const first = service.refresh();
    const second = service.refresh();
    release?.();
    const [a, b] = await Promise.all([first, second]);

    expect(observe).toHaveBeenCalledTimes(2);
    expect(a).toEqual(b);
    expect(a.entries).toEqual([
      expect.objectContaining({ providerInstanceId: firstId, status: "available" }),
      expect.objectContaining({ providerInstanceId: secondId, status: "unavailable" }),
    ]);
  });

  it("uses live normalized runtime windows when no active provider observer exists", async () => {
    const observedAt = "2026-08-23T12:00:00.000Z" as UtcTimestamp;
    const service = new ProviderUsageLimitsService({
      listInstances: () => [instance(firstId)],
      observe: vi.fn(async () => undefined),
      runtimeLimits: () =>
        decodeProviderServiceLimits({
          providerInstanceId: firstId,
          scope: "provider-instance",
          requests: { status: "unavailable" },
          tokens: { status: "unavailable" },
          concurrency: { status: "unavailable" },
          retry: { status: "inactive" },
          quota: "unknown",
          source: "runtime-reported",
          confidence: "high",
          updatedAt: observedAt,
          rateLimitWindows: [
            {
              window: "five_hour",
              status: "warning",
              utilization: 0.87,
              observedAt,
            },
          ],
        }),
      now: () => observedAt,
    });

    const snapshot = await service.refresh();

    expect(snapshot.entries[0]).toMatchObject({
      status: "available",
      source: "provider-runtime",
      limits: {
        rateLimitWindows: [{ window: "five_hour", utilization: 0.87 }],
      },
    });
  });

  it("includes a newly observed runtime window in a read without waiting for refresh", () => {
    const observedAt = "2026-08-23T12:00:00.000Z" as UtcTimestamp;
    const service = new ProviderUsageLimitsService({
      listInstances: () => [instance(firstId)],
      observe: vi.fn(async () => undefined),
      runtimeLimits: () =>
        decodeProviderServiceLimits({
          providerInstanceId: firstId,
          scope: "provider-instance",
          requests: { status: "unavailable" },
          tokens: { status: "unavailable" },
          concurrency: { status: "unavailable" },
          retry: { status: "inactive" },
          quota: "unknown",
          source: "runtime-reported",
          confidence: "high",
          updatedAt: observedAt,
          rateLimitWindows: [{ window: "weekly", status: "allowed", observedAt }],
        }),
      now: () => observedAt,
    });

    expect(service.snapshot().entries).toMatchObject([
      { status: "available", limits: { rateLimitWindows: [{ window: "weekly" }] } },
    ]);
  });

  it("preserves local observer provenance when runtime windows are merged", async () => {
    const observerObservedAt = "2026-08-23T12:00:00.000Z" as UtcTimestamp;
    const runtimeObservedAt = "2026-08-23T11:00:00.000Z" as UtcTimestamp;
    const runtime = decodeProviderServiceLimits({
      providerInstanceId: firstId,
      scope: "provider-instance",
      requests: { status: "unavailable" },
      tokens: { status: "unavailable" },
      concurrency: { status: "unavailable" },
      retry: { status: "inactive" },
      quota: "unknown",
      source: "runtime-reported",
      confidence: "high",
      updatedAt: runtimeObservedAt,
      rateLimitWindows: [{ window: "five_hour", status: "warning", observedAt: runtimeObservedAt }],
    });
    const service = new ProviderUsageLimitsService({
      listInstances: () => [instance(firstId)],
      observe: vi.fn(async () => ({
        source: "local-observer" as const,
        limits: decodeProviderServiceLimits({
          ...limits(firstId, 75),
          updatedAt: observerObservedAt,
        }),
      })),
      runtimeLimits: () => runtime,
      now: () => observerObservedAt,
    });

    const snapshot = await service.refresh();

    expect(snapshot.entries[0]).toMatchObject({
      source: "local-observer",
      limits: {
        requests: { remaining: 75 },
        rateLimitWindows: [{ window: "five_hour" }],
      },
    });
  });

  it("keeps runtime evidence visible when an active observer fails", async () => {
    const runtimeObservedAt = "2026-08-23T01:00:00.000Z" as UtcTimestamp;
    const refreshStartedAt = "2026-08-23T12:00:00.000Z" as UtcTimestamp;
    const runtime = decodeProviderServiceLimits({
      providerInstanceId: firstId,
      scope: "provider-instance",
      requests: { status: "unavailable" },
      tokens: { status: "unavailable" },
      concurrency: { status: "unavailable" },
      retry: { status: "inactive" },
      quota: "unknown",
      source: "runtime-reported",
      confidence: "high",
      updatedAt: runtimeObservedAt,
      rateLimitWindows: [{ window: "weekly", status: "allowed", observedAt: runtimeObservedAt }],
    });
    const service = new ProviderUsageLimitsService({
      listInstances: () => [instance(firstId)],
      observe: vi.fn(async () => {
        throw new Error("observer unavailable");
      }),
      runtimeLimits: () => runtime,
      now: () => refreshStartedAt,
    });

    await expect(service.refresh()).resolves.toMatchObject({
      entries: [
        {
          status: "failed",
          staleLimits: { rateLimitWindows: [{ window: "weekly" }] },
          lastSuccessfulAt: runtimeObservedAt,
        },
      ],
    });
    const refreshed = await service.refresh();
    expect(refreshed.entries[0]).toMatchObject({
      status: "failed",
      staleLimits: { rateLimitWindows: [{ window: "weekly" }] },
    });
    expect(refreshed.entries[0]).not.toMatchObject({
      lastSuccessfulAt: refreshStartedAt,
    });
  });

  it("does not keep an expired runtime window stale after a failed refresh", async () => {
    const runtimeObservedAt = "2026-08-23T01:00:00.000Z" as UtcTimestamp;
    const resetAt = "2026-08-23T02:00:00.000Z" as UtcTimestamp;
    let now = "2026-08-23T01:30:00.000Z" as UtcTimestamp;
    let fail = false;
    const store = new ProviderRuntimeUsageLimitsStore();
    store.record({
      instanceId: firstId,
      sessionId: "00000000-0000-4000-8000-000000000003" as never,
      sequence: 1,
      correlationId: "00000000-0000-4000-8000-000000000004" as never,
      occurredAt: runtimeObservedAt,
      kind: "rate-limit-window",
      window: "five_hour",
      status: "warning",
      utilization: 0.9,
      resetsAt: resetAt,
    });
    const service = new ProviderUsageLimitsService({
      listInstances: () => [instance(firstId)],
      observe: async () => {
        if (fail) throw new Error("observer unavailable");
        return undefined;
      },
      runtimeLimits: (instanceId, observedAt) => store.serviceLimits(instanceId, observedAt),
      now: () => now,
    });

    const available = await service.refresh();
    expect(available.entries[0]).toMatchObject({
      status: "available",
      limits: { rateLimitWindows: [{ window: "five_hour" }] },
    });

    now = "2026-08-23T02:30:00.000Z" as UtcTimestamp;
    fail = true;
    const failed = await service.refresh();

    expect(failed.entries[0]).toMatchObject({ status: "failed" });
    expect(JSON.stringify(failed)).not.toContain("five_hour");
  });

  it("prunes a runtime window that expires while a refresh is still observing", async () => {
    const runtimeObservedAt = "2026-08-23T00:00:00.000Z" as UtcTimestamp;
    const refreshCompletedAt = "2026-08-23T02:00:00.000Z" as UtcTimestamp;
    const store = new ProviderRuntimeUsageLimitsStore();
    store.record({
      instanceId: firstId,
      sessionId: "00000000-0000-4000-8000-000000000003" as never,
      sequence: 1,
      correlationId: "00000000-0000-4000-8000-000000000004" as never,
      occurredAt: runtimeObservedAt,
      kind: "rate-limit-window",
      window: "five_hour",
      status: "warning",
      utilization: 0.9,
      resetsAt: "2026-08-23T01:00:00.000Z" as UtcTimestamp,
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let nowCalls = 0;
    const service = new ProviderUsageLimitsService({
      listInstances: () => [instance(firstId)],
      observe: async () => {
        await gate;
        return undefined;
      },
      runtimeLimits: (instanceId, observedAt) => store.serviceLimits(instanceId, observedAt),
      now: () => {
        nowCalls += 1;
        return nowCalls === 1 ? runtimeObservedAt : refreshCompletedAt;
      },
    });

    const refresh = service.refresh();
    await vi.waitFor(() => expect(nowCalls).toBeGreaterThan(0));
    release?.();
    const snapshot = await refresh;

    expect(snapshot.refreshedAt).toBe(refreshCompletedAt);
    expect(snapshot.entries[0]).toMatchObject({ status: "unavailable" });
    expect(JSON.stringify(snapshot)).not.toContain("five_hour");
  });

  it("preserves windows supplied by a direct observer when runtime evidence is absent", async () => {
    const observedAt = "2026-08-23T00:00:00.000Z" as UtcTimestamp;
    const limitsWithWindow = decodeProviderServiceLimits({
      providerInstanceId: firstId,
      scope: "provider-instance",
      requests: { status: "unavailable" },
      tokens: { status: "unavailable" },
      concurrency: { status: "unavailable" },
      retry: { status: "inactive" },
      quota: "unknown",
      source: "runtime-reported",
      confidence: "high",
      updatedAt: observedAt,
      rateLimitWindows: [
        {
          window: "provider-owned",
          status: "warning",
          utilization: 0.5,
          resetsAt: "2026-08-23T01:00:00.000Z",
          observedAt,
        },
      ],
    });
    const service = new ProviderUsageLimitsService({
      listInstances: () => [instance(firstId)],
      observe: vi.fn(async () => ({
        source: "provider-runtime" as const,
        limits: limitsWithWindow,
      })),
      runtimeLimits: () => undefined,
      now: () => "2026-08-23T02:00:00.000Z" as UtcTimestamp,
    });

    await service.refresh();

    expect(service.snapshot().entries[0]).toMatchObject({
      status: "available",
      limits: { rateLimitWindows: [{ window: "provider-owned" }] },
    });
  });

  it("does not carry runtime ownership through provider removal and re-addition", async () => {
    let instances: ReadonlyArray<ProviderInstance> = [instance(firstId)];
    let runtimeAvailable = true;
    const runtimeObservedAt = "2026-08-23T00:00:00.000Z" as UtcTimestamp;
    const runtime = decodeProviderServiceLimits({
      providerInstanceId: firstId,
      scope: "provider-instance",
      requests: { status: "unavailable" },
      tokens: { status: "unavailable" },
      concurrency: { status: "unavailable" },
      retry: { status: "inactive" },
      quota: "unknown",
      source: "runtime-reported",
      confidence: "high",
      updatedAt: runtimeObservedAt,
      rateLimitWindows: [{ window: "runtime", status: "warning", observedAt: runtimeObservedAt }],
    });
    const direct = decodeProviderServiceLimits({
      ...runtime,
      rateLimitWindows: [{ window: "direct", status: "allowed", observedAt: runtimeObservedAt }],
    });
    const service = new ProviderUsageLimitsService({
      listInstances: () => instances,
      observe: vi.fn(async () =>
        runtimeAvailable ? undefined : { source: "provider-runtime" as const, limits: direct },
      ),
      runtimeLimits: () => (runtimeAvailable ? runtime : undefined),
      now: () => runtimeObservedAt,
    });

    await service.refresh();
    instances = [];
    await service.refresh();
    instances = [instance(firstId)];
    runtimeAvailable = false;
    await service.refresh();

    expect(service.snapshot().entries[0]).toMatchObject({
      status: "available",
      limits: { rateLimitWindows: [{ window: "direct" }] },
    });
  });

  it("retains the last successful result as stale after a failed refresh", async () => {
    const observe = vi
      .fn()
      .mockResolvedValueOnce({ source: "provider-runtime", limits: limits(firstId, 60) })
      .mockRejectedValueOnce(new Error("raw provider response must not cross"));
    let observedAt = "2026-08-23T12:00:00.000Z" as UtcTimestamp;
    const service = new ProviderUsageLimitsService({
      listInstances: () => [instance(firstId)],
      observe,
      now: () => observedAt,
    });

    await service.refresh();
    observedAt = "2026-08-23T12:05:00.000Z" as UtcTimestamp;
    const failed = await service.refresh();

    expect(failed.entries[0]).toMatchObject({
      status: "failed",
      failure: { category: "unavailable", message: "Provider limits could not be refreshed." },
      staleLimits: { requests: { remaining: 60 } },
      lastSuccessfulAt: "2026-08-23T12:00:00.000Z",
    });
    expect(JSON.stringify(failed)).not.toContain("raw provider response");
  });

  it("enforces the refresh timeout even when a provider ignores cancellation", async () => {
    const service = new ProviderUsageLimitsService({
      listInstances: () => [instance(firstId)],
      observe: () => new Promise(() => undefined),
      now: () => "2026-08-23T12:00:00.000Z" as UtcTimestamp,
      refreshTimeoutMs: 10,
    });

    const result = await Promise.race([
      service.refresh(),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 100)),
    ]);

    expect(result).toMatchObject({
      entries: [
        {
          providerInstanceId: firstId,
          status: "failed",
          failure: { category: "timeout" },
        },
      ],
    });
  });

  it("honors a provider retry window before asking the provider again", async () => {
    let observedAt = "2026-08-23T12:00:00.000Z" as UtcTimestamp;
    const observe = vi
      .fn()
      .mockRejectedValueOnce({
        category: "rate-limited",
        message: "Retry later.",
        retryAfterMs: 60_000,
      })
      .mockResolvedValueOnce({ source: "provider-runtime", limits: limits(firstId, 80) });
    const service = new ProviderUsageLimitsService({
      listInstances: () => [instance(firstId)],
      observe,
      now: () => observedAt,
    });

    const first = await service.refresh();
    observedAt = "2026-08-23T12:00:30.000Z" as UtcTimestamp;
    const duringRetry = await service.refresh();

    expect(observe).toHaveBeenCalledOnce();
    expect(duringRetry).toEqual({ ...first, refreshedAt: observedAt });
    expect(duringRetry.entries[0]).toMatchObject({
      status: "failed",
      failure: { category: "rate-limited", retryAt: "2026-08-23T12:01:00.000Z" },
    });

    observedAt = "2026-08-23T12:01:01.000Z" as UtcTimestamp;
    const afterRetry = await service.refresh();
    expect(observe).toHaveBeenCalledTimes(2);
    expect(afterRetry.entries[0]).toMatchObject({
      status: "available",
      limits: { requests: { remaining: 80 } },
    });
  });

  it("aborts an in-flight refresh when the service stops", async () => {
    let aborted = false;
    const service = new ProviderUsageLimitsService({
      listInstances: () => [instance(firstId)],
      observe: (_provider, signal) => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        return new Promise(() => undefined);
      },
      now: () => "2026-08-23T12:00:00.000Z" as UtcTimestamp,
      refreshTimeoutMs: 60_000,
    });

    const refresh = service.refresh();
    service.stop();
    await Promise.race([
      refresh,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 100)),
    ]);

    expect(aborted).toBe(true);
  });

  it("runs scheduled refreshes through the same coalesced path", async () => {
    let scheduled: (() => void) | undefined;
    const clear = vi.fn();
    const timerHandle = setInterval(() => undefined, 60_000);
    const observe = vi.fn(async () => ({
      source: "provider-runtime" as const,
      limits: limits(firstId, 50),
    }));
    const service = new ProviderUsageLimitsService({
      listInstances: () => [instance(firstId)],
      observe,
      now: () => "2026-08-23T12:00:00.000Z" as UtcTimestamp,
      schedule: (callback) => {
        scheduled = callback;
        return timerHandle;
      },
      cancelSchedule: clear,
    });

    service.start();
    scheduled?.();
    await vi.waitFor(() => expect(observe).toHaveBeenCalledOnce());
    service.stop();

    expect(clear).toHaveBeenCalledWith(timerHandle);
    clearInterval(timerHandle);
  });
});
