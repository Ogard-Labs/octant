import { Effect, Fiber, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";
import { countsTowardTurnEventBudget, makeIdleTimeout } from "./turnBudget";

describe("turn budget", () => {
  it("excludes streaming deltas and progress ticks from the event budget", () => {
    expect(countsTowardTurnEventBudget({ kind: "text-delta" })).toBe(false);
    expect(countsTowardTurnEventBudget({ kind: "reasoning-delta" })).toBe(false);
    expect(countsTowardTurnEventBudget({ kind: "tool-progress" })).toBe(false);
    expect(countsTowardTurnEventBudget({ kind: "tool-start" })).toBe(true);
    expect(countsTowardTurnEventBudget({ kind: "approval-request" })).toBe(true);
    expect(countsTowardTurnEventBudget({ kind: "completed" })).toBe(true);
  });

  it("only expires after a full idle window without activity", async () => {
    const program = Effect.gen(function* () {
      const idle = yield* makeIdleTimeout(1_000);
      const watcher = yield* Effect.fork(idle.expired);

      yield* TestClock.adjust(800);
      yield* idle.touch;
      yield* TestClock.adjust(800);
      // 1.6s of wall time but only 800ms since the last touch — still alive.
      const early = yield* Fiber.poll(watcher);
      expect(early._tag).toBe("None");

      yield* TestClock.adjust(200);
      yield* Fiber.join(watcher);
    });
    await Effect.runPromise(program.pipe(Effect.provide(TestContext.TestContext)));
  });
});
