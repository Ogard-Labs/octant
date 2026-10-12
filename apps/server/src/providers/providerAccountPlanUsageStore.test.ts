import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decodeProviderInstanceId,
  decodeProviderRuntimeEvent,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type UtcTimestamp,
} from "@octant/contracts";
import { ProviderAccountPlanUsageStore } from "./providerAccountPlanUsageStore";

const firstId = decodeProviderInstanceId("11111111-1111-4111-8111-111111111111");
const secondId = decodeProviderInstanceId("22222222-2222-4222-8222-222222222222");
const occurredAt = "2026-10-11T12:00:00.000Z" as UtcTimestamp;

function windowEvent(overrides: {
  readonly instanceId: ProviderInstanceId;
  readonly sessionId: string;
  readonly correlationId: string;
  readonly status: "allowed" | "warning" | "exhausted";
  readonly utilization: number;
}): Extract<ProviderRuntimeEvent, { readonly kind: "rate-limit-window" }> {
  const event = decodeProviderRuntimeEvent({
    instanceId: overrides.instanceId,
    sessionId: overrides.sessionId,
    sequence: 1,
    correlationId: overrides.correlationId,
    occurredAt,
    kind: "rate-limit-window",
    window: "five_hour",
    status: overrides.status,
    utilization: overrides.utilization,
  });
  if (event.kind !== "rate-limit-window") {
    throw new Error("expected a rate-limit-window event");
  }
  return event;
}

async function openStore(): Promise<{
  readonly store: ProviderAccountPlanUsageStore;
  readonly filePath: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "octant-plan-usage-"));
  const filePath = join(directory, "plan-usage.json");
  return { store: new ProviderAccountPlanUsageStore(filePath), filePath };
}

describe("provider account plan-usage store", () => {
  it("keeps each account's windows on its own state directory", async () => {
    const { store } = await openStore();
    await store.recordWindow(
      windowEvent({
        instanceId: firstId,
        sessionId: "00000000-0000-4000-8000-000000000001",
        correlationId: "00000000-0000-4000-8000-000000000011",
        status: "warning",
        utilization: 0.8,
      }),
      "/Users/example/.claude",
    );
    await store.recordWindow(
      windowEvent({
        instanceId: secondId,
        sessionId: "00000000-0000-4000-8000-000000000002",
        correlationId: "00000000-0000-4000-8000-000000000012",
        status: "allowed",
        utilization: 0.1,
      }),
      `/Users/example/.claude-accounts/${secondId}`,
    );

    expect(store.snapshot(firstId, "/Users/example/.claude/")?.windows).toEqual([
      expect.objectContaining({ window: "five_hour", utilization: 0.8, status: "warning" }),
    ]);
    expect(
      store.snapshot(secondId, `/Users/example/.claude-accounts/${secondId}`)?.windows,
    ).toEqual([
      expect.objectContaining({ window: "five_hour", utilization: 0.1, status: "allowed" }),
    ]);
    expect(store.snapshot(firstId, `/Users/example/.claude-accounts/${secondId}`)).toBeUndefined();
    expect(store.snapshot(secondId, "/Users/example/.claude")).toBeUndefined();
  });

  it("writes only the host snapshot file and never a credential path", async () => {
    const { store, filePath } = await openStore();
    await store.replace({
      instanceId: firstId,
      stateDirectory: "/Users/example/.claude",
      source: "process-refresh",
      observedAt: occurredAt,
      available: true,
      windows: [
        {
          window: "seven_day",
          status: "allowed",
          utilization: 0.2,
          observedAt: occurredAt,
        },
      ],
    });
    const body = await readFile(filePath, "utf8");
    expect(filePath).toContain("plan-usage.json");
    expect(body).toContain("seven_day");
    expect(body).not.toMatch(/oauth|sk-ant|keychain|credentials\.json/i);
    expect(JSON.parse(body).entries[0].stateDirectory).toBe("/Users/example/.claude");
  });

  it("keeps both accounts when two snapshots persist at the same time", async () => {
    const { store, filePath } = await openStore();
    await Promise.all([
      store.replace({
        instanceId: firstId,
        stateDirectory: "/Users/example/.claude",
        source: "process-refresh",
        observedAt: occurredAt,
        available: true,
        windows: [
          {
            window: "five_hour",
            status: "allowed",
            utilization: 0.2,
            observedAt: occurredAt,
          },
        ],
      }),
      store.recordWindow(
        windowEvent({
          instanceId: secondId,
          sessionId: "00000000-0000-4000-8000-000000000002",
          correlationId: "00000000-0000-4000-8000-000000000012",
          status: "warning",
          utilization: 0.7,
        }),
        `/Users/example/.claude-accounts/${secondId}`,
      ),
    ]);

    expect(store.snapshot(firstId, "/Users/example/.claude")?.windows).toEqual([
      expect.objectContaining({ window: "five_hour", utilization: 0.2 }),
    ]);
    expect(
      store.snapshot(secondId, `/Users/example/.claude-accounts/${secondId}`)?.windows,
    ).toEqual([expect.objectContaining({ window: "five_hour", utilization: 0.7 })]);
    const body = JSON.parse(await readFile(filePath, "utf8")) as {
      readonly entries: ReadonlyArray<{ readonly instanceId: string }>;
    };
    expect(body.entries).toHaveLength(2);
  });

  it("restores the last snapshot after a process restart", async () => {
    const { store, filePath } = await openStore();
    await store.replace({
      instanceId: firstId,
      stateDirectory: "/Users/example/.claude",
      source: "session-event",
      observedAt: occurredAt,
      available: true,
      windows: [
        {
          window: "five_hour",
          status: "allowed",
          utilization: 0.3,
          observedAt: occurredAt,
        },
      ],
    });
    const restored = new ProviderAccountPlanUsageStore(filePath);
    await restored.load();
    expect(restored.serviceLimits(firstId, "/Users/example/.claude", occurredAt)).toMatchObject({
      rateLimitWindows: [expect.objectContaining({ window: "five_hour", utilization: 0.3 })],
      updatedAt: occurredAt,
    });
  });
});
