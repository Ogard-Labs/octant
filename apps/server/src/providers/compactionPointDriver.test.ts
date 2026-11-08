import type { ProviderModelId } from "@octant/contracts";
import type { ProviderConnection, ProviderDriver } from "@octant/provider-sdk/driver";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { claudeAutoCompactWindow } from "./claudeDriver";
import { compactionPointFor, withCompactionPoint } from "./compactionPointDriver";

function recordingDriver() {
  const started: Array<unknown> = [];
  const resumed: Array<unknown> = [];
  const connection = {
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

  it("names no point without a share, or for a model whose window nobody reported", () => {
    expect(compactionPointFor(70, 200_000)).toEqual({ tokens: 140_000, contextWindow: 200_000 });
    expect(compactionPointFor(null, 200_000)).toBeUndefined();
    expect(compactionPointFor(70, undefined)).toBeUndefined();
  });

  it("sets Claude Code's window so its own reserve lands on the point, and leaves its own point past it", () => {
    expect(claudeAutoCompactWindow({ tokens: 140_000, contextWindow: 200_000 })).toEqual({
      autoCompactWindow: 153_000,
    });
    // At 95% the point is past where Claude Code already compacts.
    expect(claudeAutoCompactWindow({ tokens: 190_000, contextWindow: 200_000 })).toEqual({});
    // Below the window the runtime accepts at all.
    expect(claudeAutoCompactWindow({ tokens: 50_000, contextWindow: 100_000 })).toEqual({});
    expect(claudeAutoCompactWindow(undefined)).toEqual({});
  });
});
