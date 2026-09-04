import { describe, expect, it } from "vitest";
import { Effect, Queue, Stream } from "effect";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import {
  ContextSummaryGenerationFailed,
  makeContextSummaryGenerator,
} from "./contextSummaryGenerator";
import type { GenerateContextSummaryRequest } from "./contextMaintenancePort";

const providerInstanceId = "55555555-5555-4555-8555-555555555555";
const sessionId = "99999999-9999-4999-8999-999999999999";
const entryId = "77777777-7777-4777-8777-777777777777";

interface FakeMaintenanceProvider {
  readonly driver: ProviderDriver;
  readonly starts: ReadonlyArray<string>;
  readonly sends: ReadonlyArray<string>;
  readonly stops: ReadonlyArray<string>;
}

/**
 * A maintenance provider that can wedge in the phases a real subprocess can:
 * one that never comes up, never starts a session, never accepts a prompt, or
 * never confirms that it ended the session.
 */
function fakeProvider(options?: {
  readonly wedge?: "acquire" | "start" | "send";
  readonly wedgeStop?: boolean;
}): FakeMaintenanceProvider {
  const starts: string[] = [];
  const sends: string[] = [];
  const stops: string[] = [];
  const queue = Effect.runSync(Queue.unbounded<never>());
  const connection = {
    subscribe: Effect.succeed(Stream.fromQueue(queue)),
    start: (input: { readonly sessionId: string }) =>
      Effect.suspend(() => {
        starts.push(input.sessionId);
        return options?.wedge === "start"
          ? Effect.never
          : Effect.succeed({ sessionId: input.sessionId });
      }),
    resume: () => Effect.succeed({ sessionId }),
    send: (input: { readonly sessionId: string }) =>
      Effect.suspend(() => {
        sends.push(input.sessionId);
        return options?.wedge === "send"
          ? Effect.never
          : Effect.gen(function* () {
              yield* Queue.offer(queue, {
                kind: "text-delta",
                sessionId: input.sessionId,
                text: "Compacted earlier conversation.",
              } as never);
              yield* Queue.offer(queue, {
                kind: "usage",
                sessionId: input.sessionId,
                inputTokens: 40,
                outputTokens: 12,
              } as never);
              yield* Queue.offer(queue, {
                kind: "completed",
                sessionId: input.sessionId,
              } as never);
            });
      }),
    interrupt: () => Effect.void,
    stop: (session: string) =>
      Effect.suspend(() => {
        stops.push(session);
        return options?.wedgeStop === true ? Effect.never : Effect.void;
      }),
    answerApproval: () => Effect.void,
    answerUserInput: () => Effect.void,
    answerTool: () => Effect.void,
  };
  return {
    driver: {
      acquire: () => (options?.wedge === "acquire" ? Effect.never : Effect.succeed(connection)),
    } as unknown as ProviderDriver,
    starts,
    sends,
    stops,
  };
}

function generateSummary(provider: FakeMaintenanceProvider, timeoutMs = 50) {
  return makeContextSummaryGenerator({
    driver: provider.driver,
    providerInstanceId: providerInstanceId as never,
    scratchRoot: "/tmp/octant-context-maintenance/thread",
    sessionId: sessionId as never,
    mode: "chat",
    timeoutMs,
    shutdownTimeoutMs: 50,
  });
}

const request: GenerateContextSummaryRequest = {
  providerInstanceId: providerInstanceId as never,
  modelId: "gpt-4o" as never,
  materials: [{ entryId: entryId as never, content: "User: Turn 0", sizeTokens: 8 }],
};

describe("makeContextSummaryGenerator", () => {
  it("returns the maintenance model's summary with its reported usage", async () => {
    const provider = fakeProvider();
    const observed: Array<{ readonly inputTokens: number; readonly outputTokens: number }> = [];

    const generated = await makeContextSummaryGenerator({
      driver: provider.driver,
      providerInstanceId: providerInstanceId as never,
      scratchRoot: "/tmp/octant-context-maintenance/thread",
      sessionId: sessionId as never,
      mode: "chat",
      observeUsage: (usage) => void observed.push(usage),
      timeoutMs: 2_000,
    })(request, new AbortController().signal);

    expect(generated.content).toBe("Compacted earlier conversation.");
    expect(generated.summaryTokens).toEqual({
      kind: "known",
      tokens: 12,
      accuracy: "provider-reported",
    });
    expect(observed).toEqual([{ inputTokens: 40, outputTokens: 12 }]);
    expect(provider.stops).toEqual([sessionId]);
  });

  // The turn awaits maintenance before it dispatches the user's own send, so a
  // provider that never settles in any of these phases would hang the send
  // itself. The deadline has to cover setup, not only the event collection.
  it("gives up on a maintenance request wedged in provider acquisition", async () => {
    const provider = fakeProvider({ wedge: "acquire" });

    await expect(
      generateSummary(provider)(request, new AbortController().signal),
    ).rejects.toBeInstanceOf(ContextSummaryGenerationFailed);
    // Nothing was acquired, so there is no connection to stop.
    expect(provider.stops).toEqual([]);
  });

  it("gives up on a maintenance request wedged in provider startup", async () => {
    const provider = fakeProvider({ wedge: "start" });

    await expect(
      generateSummary(provider)(request, new AbortController().signal),
    ).rejects.toBeInstanceOf(ContextSummaryGenerationFailed);
    expect(provider.starts).toEqual([sessionId]);
    // The connection was acquired before the deadline fired, so it is stopped
    // rather than left running against the user's turn.
    expect(provider.stops).toEqual([sessionId]);
  });

  it("gives up on a maintenance request wedged in its send", async () => {
    const provider = fakeProvider({ wedge: "send" });

    await expect(
      generateSummary(provider)(request, new AbortController().signal),
    ).rejects.toBeInstanceOf(ContextSummaryGenerationFailed);
    expect(provider.sends).toEqual([sessionId]);
    expect(provider.stops).toEqual([sessionId]);
  });

  // Teardown runs in a scope finalizer, which is uninterruptible by default, so
  // an unbounded stop holds the request open long after the deadline that was
  // meant to release it — and the turn waiting on maintenance with it.
  it("returns the summary when the provider never confirms the maintenance stop", async () => {
    const provider = fakeProvider({ wedgeStop: true });

    const generated = await generateSummary(provider, 2_000)(request, new AbortController().signal);

    expect(generated.content).toBe("Compacted earlier conversation.");
    expect(provider.stops).toEqual([sessionId]);
  });

  it("gives up on a maintenance request whose stop never settles after its deadline", async () => {
    const provider = fakeProvider({ wedge: "send", wedgeStop: true });

    await expect(
      generateSummary(provider)(request, new AbortController().signal),
    ).rejects.toBeInstanceOf(ContextSummaryGenerationFailed);
    expect(provider.sends).toEqual([sessionId]);
    expect(provider.stops).toEqual([sessionId]);
  });

  it("refuses to route maintenance to another provider instance", async () => {
    const provider = fakeProvider();

    await expect(
      generateSummary(provider)(
        { ...request, providerInstanceId: sessionId as never },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(ContextSummaryGenerationFailed);
    expect(provider.starts).toEqual([]);
  });
});
