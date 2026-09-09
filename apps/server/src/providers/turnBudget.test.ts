import { Effect, Fiber, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";
import { countsTowardTurnEventBudget, makeIdleTimeout } from "./turnBudget";

describe("turn budget", () => {
  it("does not count an app-owned action as provider inactivity", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const idle = yield* makeIdleTimeout(1_000);
        const watcher = yield* Effect.fork(idle.expired);
        const action = yield* Effect.fork(idle.during(Effect.sleep(3_000)));
        yield* TestClock.adjust(2_000);
        expect((yield* Fiber.poll(watcher))._tag).toBe("None");
        yield* TestClock.adjust(1_000);
        yield* Fiber.join(action);
        yield* TestClock.adjust(999);
        expect((yield* Fiber.poll(watcher))._tag).toBe("None");
        yield* TestClock.adjust(1);
        yield* Fiber.join(watcher);
      }).pipe(Effect.provide(TestContext.TestContext)),
    );
  });

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
