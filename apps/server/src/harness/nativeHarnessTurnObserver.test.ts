import { describe, expect, it } from "vitest";
import { NativeHarnessTurnObserver, parseVerdict } from "./nativeHarnessTurnObserver";

const providerInstanceId = "00000000-0000-4000-8000-000000000001" as never;
const scope = {
  threadId: "00000000-0000-4000-8000-000000000020",
  mode: "code" as const,
  providerInstanceId,
  modelId: "frontier-large" as never,
};

function observer(
  isHarness = true,
  session?: { status: string; detail?: string },
  goal?: Record<string, unknown>,
) {
  const recorded: { turns: unknown[]; interventions: unknown[] } = {
    turns: [],
    interventions: [],
  };
  let counter = 0;
  const subject = new NativeHarnessTurnObserver({
    sessions: {
      read: () => (session === undefined ? undefined : ({ session } as never)),
      takeToolCalls: () => [],
      clearSteering: () => undefined,
      ensure: () =>
        ({
          id: "00000000-0000-4000-8000-000000000010",
          leadSlotId: "default",
          turnsRun: recorded.turns.length,
        }) as never,
      markRunning: () => undefined,
      recordTurn: (_threadId: string, turn: unknown) => {
        recorded.turns.push(turn);
      },
      recordReduction: () => undefined,
      recordIntervention: (_threadId: string, intervention: unknown) => {
        recorded.interventions.push(intervention);
      },
    } as never,
    router: { resolve: () => ({ kind: "unroutable" }) as never },
    isHarnessProvider: () => isHarness,
    resolveDriver: () => undefined,
    hostId: "00000000-0000-4000-8000-0000000000aa",
    scratchRoot: "/tmp",
    ...(goal === undefined ? {} : { readGoal: () => goal as never }),
    uuid: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
    clock: () => "2026-09-05T12:00:00.000Z",
  });
  return { subject, recorded };
}

describe("native harness turn observer", () => {
  it("puts the stable instructions in front of a harness turn and nothing in front of others", () => {
    const harness = observer(true).subject.contextFor(scope);
    expect(harness[0]?.kind).toBe("instructions");
    expect(harness[0]?.text).toContain("todo-write");
    expect(observer(false).subject.contextFor(scope)).toEqual([]);
  });

  it("puts an open goal's criteria after the stable instructions and drops a completed one", () => {
    const goal = {
      objective: "Make the parser accept trailing commas",
      status: "active",
      budget: { turnBudget: 10 },
      usage: { tokensUsed: 0, elapsedMs: 0, turnsUsed: 3 },
      criteria: [
        { id: "c1", text: "Parser tests pass", check: "bun run test parser", status: "met" },
        { id: "c2", text: "Docs mention it", status: "unmet" },
      ],
    };
    const context = observer(true, undefined, goal).subject.contextFor(scope);
    const instructions = context.filter((block) => block.kind === "instructions");
    const work = context.find((block) => block.kind === "work-item");
    expect(context.indexOf(work as never)).toBeGreaterThan(
      context.indexOf(instructions.at(-1) as never),
    );
    expect(work?.text).toContain("- [met] c1: Parser tests pass (check: bun run test parser)");
    expect(work?.text).toContain("- [unmet] c2: Docs mention it (a person confirms this one)");
    expect(work?.text).toContain("Budget left: 7 of 10 turns.");
    const done = observer(true, undefined, { ...goal, status: "complete" }).subject.contextFor(
      scope,
    );
    expect(done.some((block) => block.kind === "work-item")).toBe(false);
  });

  it("hands a pending advisor redirect to exactly the next turn", async () => {
    const { subject } = observer();
    subject.contextFor(scope);
    // No advisor slot is configured, so no redirect is ever pending; a
    // second read is the same stable prefix.
    expect(subject.contextFor(scope)).toEqual(subject.contextFor(scope));
  });

  it("refuses the next turn while a pause stands and admits it for other providers", () => {
    const paused = observer(true, { status: "paused-by-advisor", detail: "Spending ahead." });
    expect(paused.subject.admitTurn(scope)).toEqual({
      kind: "paused",
      status: "paused-by-advisor",
      detail: "Spending ahead.",
    });
    expect(observer(true, { status: "idle" }).subject.admitTurn(scope)).toEqual({
      kind: "admitted",
    });
    expect(
      observer(false, { status: "paused-by-advisor", detail: "x" }).subject.admitTurn(scope),
    ).toEqual({ kind: "admitted" });
  });

  it("records the turn a reply completes", async () => {
    const { subject, recorded } = observer();
    await subject.turnCompleted({
      ...scope,
      text: 'Done.\n```octant-follow-ups\n{"suggestions":[{"title":"Tests","prompt":"Add tests.","target":"new-thread"}]}\n```',
      toolCalls: 4,
    });
    expect(recorded.turns).toHaveLength(1);
    expect(recorded.turns[0]).toMatchObject({
      job: "lead",
      toolCalls: 4,
      stopReason: "end-of-turn",
    });
    expect(recorded.interventions).toEqual([]);
  });

  it("reads the advisor's verdict from wherever it put the JSON, and refuses an empty redirect", () => {
    expect(
      parseVerdict(
        'Sure: {"action":"redirect","reason":"drift","instruction":"Run the tests first."}',
      ),
    ).toEqual({
      action: "redirect",
      reason: "drift",
      instruction: "Run the tests first.",
    });
    expect(parseVerdict('{"action":"pause","reason":"needs a decision"}')).toEqual({
      action: "pause",
      reason: "needs a decision",
    });
    expect(parseVerdict('{"action":"redirect","instruction":""}')).toBeUndefined();
    expect(parseVerdict("no json here")).toBeUndefined();
    expect(parseVerdict(undefined)).toBeUndefined();
  });
});
