import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  decodeProviderRuntimeEvent,
  type ProviderRuntimeEvent,
} from "@octant/contracts";
import { Effect, Stream } from "effect";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import { describe, expect, it } from "vitest";
import { attachProviderRuntimeUsageLimits } from "./providerRuntimeUsageLimitsDriver";
import { ProviderRuntimeUsageLimitsStore } from "./providerRuntimeUsageLimitsStore";

const instanceId = decodeProviderInstanceId("00000000-0000-4000-8000-000000000001");
const sessionId = decodeProviderSessionId("00000000-0000-4000-8000-000000000002");

describe("attachProviderRuntimeUsageLimits", () => {
  it("records normalized events without consuming them before the turn", async () => {
    const event = decodeProviderRuntimeEvent({
      instanceId,
      sessionId,
      sequence: 1,
      correlationId: "00000000-0000-4000-8000-000000000003",
      occurredAt: "2026-08-24T01:00:00.000Z",
      kind: "rate-limit-window",
      window: "five_hour",
      status: "warning",
      utilization: 0.87,
    });
    const store = new ProviderRuntimeUsageLimitsStore();
    const driver = fixture(event);
    const attached = attachProviderRuntimeUsageLimits(driver, store);

    const connection = await Effect.runPromise(
      Effect.scoped(attached.acquire({ instanceId, projectRoot: "/tmp/octant-test" })),
    );
    const events = await Effect.runPromise(
      Stream.runCollect(Stream.unwrapScoped(connection.subscribe)),
    );

    expect(Array.from(events)).toEqual([event]);
    expect(store.windows(instanceId)).toEqual([
      expect.objectContaining({ window: "five_hour", utilization: 0.87 }),
    ]);
  });

  it("ignores normalized events attributed to another provider instance", async () => {
    const otherInstanceId = decodeProviderInstanceId("00000000-0000-4000-8000-000000000004");
    const event = decodeProviderRuntimeEvent({
      instanceId: otherInstanceId,
      sessionId,
      sequence: 1,
      correlationId: "00000000-0000-4000-8000-000000000003",
      occurredAt: "2026-08-24T01:00:00.000Z",
      kind: "rate-limit-window",
      window: "five_hour",
      status: "warning",
      utilization: 0.87,
    });
    const store = new ProviderRuntimeUsageLimitsStore();
    const attached = attachProviderRuntimeUsageLimits(fixture(event), store);

    const connection = await Effect.runPromise(
      Effect.scoped(attached.acquire({ instanceId, projectRoot: "/tmp/octant-test" })),
    );
    await Effect.runPromise(Stream.runCollect(Stream.unwrapScoped(connection.subscribe)));

    expect(store.windows(instanceId)).toEqual([]);
    expect(store.windows(otherInstanceId)).toEqual([]);
  });
});

function fixture(event: ProviderRuntimeEvent): ProviderDriver {
  return {
    kind: "claude",
    probe: () => Effect.fail({ category: "unavailable", message: "not used" }),
    acquire: () =>
      Effect.succeed({
        subscribe: Effect.succeed(Stream.succeed(event)),
        start: () => Effect.succeed({ sessionId }),
        resume: () => Effect.succeed({ sessionId }),
        send: () => Effect.void,
        interrupt: () => Effect.void,
        stop: () => Effect.void,
        answerApproval: () => Effect.void,
        answerUserInput: () => Effect.void,
        answerTool: () => Effect.void,
      }),
  } as unknown as ProviderDriver;
}
