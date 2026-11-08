import type { ProviderModelId } from "@octant/contracts";
import type { ProviderConnection, ProviderDriver } from "@octant/provider-sdk/driver";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { decodeContextUsageWindow } from "./claudeAgentSdkDecoder";
import { claudeAutoCompactWindow } from "./claudeDriver";
import { compactionPointFor, withCompactionPoint } from "./compactionPointDriver";

function recordingDriver() {
  const started: Array<unknown> = [];
  const resumed: Array<unknown> = [];
  const connection = {
    subscribe: Effect.succeed(
      Stream.make(
        { kind: "usage", sessionId: "a", contextWindow: 400_000 },
        { kind: "completed", sessionId: "a" },
      ),
    ),
    start: (input: unknown) =>
      Effect.sync(() => {
        started.push(input);
        return { sessionId: "s" };
      }),
    resume: (input: unknown) =>
      Effect.sync(() => {
        resumed.push(input);
        return { sessionId: "s" };
      }),
  } as unknown as ProviderConnection;
  const driver = { acquire: () => Effect.succeed(connection) } as unknown as ProviderDriver;
  return { driver, started, resumed };
}

describe("handing a session the person's compaction point", () => {
  const model = "model-a" as ProviderModelId;
  const point = { tokens: 140_000, contextWindow: 200_000 };

  it("names the point on every start and resume, but not on a one-request session", async () => {
    const { driver, started, resumed } = recordingDriver();
    const pointed = withCompactionPoint(driver, () => point);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* pointed.acquire({} as never);
          yield* connection.start({
            sessionId: "a",
            modelId: model,
            executionPolicy: "approval-gated",
          } as never);
          yield* connection.start({
            sessionId: "b",
            modelId: model,
            executionPolicy: "approval-gated",
            singleUse: true,
          } as never);
          yield* connection.resume({
            sessionId: "a",
            modelId: model,
            resumeCursor: { driverKind: "codex", value: "x" },
            executionPolicy: "approval-gated",
          } as never);
        }),
      ),
    );
    expect(started[0]).toMatchObject({ compactionPoint: point });
    expect(started[1]).not.toHaveProperty("compactionPoint");
    expect(resumed[0]).toMatchObject({ compactionPoint: point });
  });

  it("remembers the window a session's runtime reported, for a model whose catalogue names none", async () => {
    const { driver } = recordingDriver();
    const remembered: Array<[string, number]> = [];
    const pointed = withCompactionPoint(
      driver,
      () => undefined,
      (modelId, window) => remembered.push([String(modelId), window]),
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* pointed.acquire({} as never);
          yield* connection.start({
            sessionId: "a",
            modelId: model,
            executionPolicy: "approval-gated",
          } as never);
          yield* Stream.runDrain(yield* connection.subscribe);
        }),
      ),
    );
    expect(remembered).toEqual([["model-a", 400_000]]);
  });

  it("names no point without a share, or for a model whose window nobody reported", () => {
    expect(compactionPointFor(70, 200_000)).toEqual({ tokens: 140_000, contextWindow: 200_000 });
    expect(compactionPointFor(null, 200_000)).toBeUndefined();
    expect(compactionPointFor(70, undefined)).toBeUndefined();
  });

  it("sets Claude Code's window so its own reserve lands on the point, and leaves its own point past it", () => {
    expect(claudeAutoCompactWindow({ tokens: 140_000, contextWindow: 200_000 })).toEqual({
      autoCompactWindow: 173_000,
    });
    // At 95% the point is past where Claude Code already compacts.
    expect(claudeAutoCompactWindow({ tokens: 190_000, contextWindow: 200_000 })).toEqual({});
    // Below the window the runtime accepts at all.
    expect(claudeAutoCompactWindow({ tokens: 50_000, contextWindow: 100_000 })).toEqual({});
    expect(claudeAutoCompactWindow(undefined)).toEqual({});
  });

  it("reads the Claude runtime's window from its context-usage answer, compaction on or off", () => {
    expect(decodeContextUsageWindow({ maxTokens: 1_000_000, isAutoCompactEnabled: false })).toBe(
      1_000_000,
    );
    expect(decodeContextUsageWindow({ maxTokens: "big" })).toBeUndefined();
    expect(decodeContextUsageWindow(undefined)).toBeUndefined();
  });
});
