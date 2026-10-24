import { decodeProviderRuntimeEvent, type ProviderRuntimeEvent } from "@octant/contracts";
import { Effect, Fiber, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";
import { countsTowardTurnEventBudget, makeIdleTimeout, makeTurnTextParagraphs } from "./turnBudget";

let sequence = 0;
function runtimeEvent(fields: Record<string, unknown>): ProviderRuntimeEvent {
  sequence += 1;
  return decodeProviderRuntimeEvent({
    instanceId: "00000000-0000-4000-8000-000000000001",
    sessionId: "00000000-0000-4000-8000-000000000002",
    sequence,
    correlationId: "00000000-0000-4000-8000-000000000003",
    occurredAt: "2026-10-24T00:00:00.000Z",
    ...fields,
  });
}

function answerText(events: ReadonlyArray<Record<string, unknown>>): string {
  const paragraphs = makeTurnTextParagraphs();
  return events
    .map((fields) => paragraphs(runtimeEvent(fields)))
    .map((event) => (event.kind === "text-delta" ? event.text : ""))
    .join("");
}

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
    expect(countsTowardTurnEventBudget({ kind: "liveness" })).toBe(false);
    expect(countsTowardTurnEventBudget({ kind: "tool-start" })).toBe(true);
    expect(countsTowardTurnEventBudget({ kind: "approval-request" })).toBe(true);
    expect(countsTowardTurnEventBudget({ kind: "completed" })).toBe(true);
  });

  it("starts a new paragraph when the answer resumes after a tool step", () => {
    expect(
      answerText([
        { kind: "text-delta", text: "Let me check the " },
        { kind: "text-delta", text: "repository." },
        { kind: "tool-start", toolCallId: "call-1", toolName: "read" },
        { kind: "tool-success", toolCallId: "call-1", summary: "Read package.json" },
        { kind: "text-delta", text: "No AGENTS.md found." },
        { kind: "usage", inputTokens: 1, outputTokens: 1 },
        { kind: "text-delta", text: " It is a TypeScript server." },
      ]),
    ).toBe("Let me check the repository.\n\nNo AGENTS.md found. It is a TypeScript server.");
  });

  it("adds no break before the first text or where the provider already sent one", () => {
    expect(
      answerText([
        { kind: "tool-start", toolCallId: "call-1", toolName: "read" },
        { kind: "text-delta", text: "First." },
        { kind: "tool-start", toolCallId: "call-2", toolName: "read" },
        { kind: "text-delta", text: "\n\nSecond." },
      ]),
    ).toBe("First.\n\nSecond.");
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
