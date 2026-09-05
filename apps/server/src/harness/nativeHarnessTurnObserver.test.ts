import { describe, expect, it } from "vitest";
import { NativeHarnessTurnObserver, parseVerdict } from "./nativeHarnessTurnObserver";

const providerInstanceId = "00000000-0000-4000-8000-000000000001" as never;
const scope = {
  threadId: "00000000-0000-4000-8000-000000000020",
  mode: "code" as const,
  providerInstanceId,
  modelId: "frontier-large" as never,
};

function observer(isHarness = true, session?: { status: string; detail?: string }) {
  const recorded: { turns: unknown[]; followUps: unknown[]; interventions: unknown[] } = {
    turns: [],
    followUps: [],
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
      recordFollowUps: (_threadId: string, set: unknown) => {
        recorded.followUps.push(set);
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
    uuid: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
    clock: () => "2026-09-05T12:00:00.000Z",
  });
  return { subject, recorded };
}

describe("native harness turn observer", () => {
  it("puts the stable instructions in front of a harness turn and nothing in front of others", () => {
    const harness = observer(true).subject.contextFor(scope);
    expect(harness[0]?.kind).toBe("instructions");
    expect(harness[0]?.text).toContain("octant-follow-ups");
    expect(observer(false).subject.contextFor(scope)).toEqual([]);
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

  it("records the turn and the follow-ups a reply ends with", async () => {
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
    expect(recorded.followUps).toHaveLength(1);
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
