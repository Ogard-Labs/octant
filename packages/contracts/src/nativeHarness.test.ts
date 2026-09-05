import { describe, expect, it } from "vitest";
import {
  MAX_NATIVE_HARNESS_FOLLOW_UPS,
  NATIVE_HARNESS_TOOL_NAMES,
  decodeActivateNativeHarnessFollowUp,
  decodeNativeHarnessAdvisorIntervention,
  decodeNativeHarnessCarriedNote,
  decodeNativeHarnessContextReduction,
  decodeNativeHarnessContextRemaining,
  decodeNativeHarnessFollowUpPreview,
  decodeNativeHarnessFollowUpSet,
  decodeNativeHarnessJournalLookupResult,
  decodeNativeHarnessSession,
  decodeNativeHarnessToolResultBounds,
  decodeNativeHarnessTurnRecord,
} from "./nativeHarness";

const at = "2026-09-05T10:00:00.000Z";
const later = "2026-09-05T10:00:05.000Z";
const session = "00000000-0000-4000-8000-000000000010";
const turn = "00000000-0000-4000-8000-000000000011";
const lead = {
  hostId: "00000000-0000-4000-8000-0000000000aa",
  providerInstanceId: "00000000-0000-4000-8000-000000000001",
  modelId: "frontier-large",
};

describe("native harness tools", () => {
  it("offers the nine working tools, the three harness reads, and delegation", () => {
    expect(NATIVE_HARNESS_TOOL_NAMES.length).toBe(13);
    expect(NATIVE_HARNESS_TOOL_NAMES).toContain("edit");
    expect(NATIVE_HARNESS_TOOL_NAMES).toContain("context-remaining");
  });

  it("a truncated tool result always says how much was omitted and where to continue", () => {
    expect(
      decodeNativeHarnessToolResultBounds({
        truncated: true,
        returnedBytes: 4096,
        omittedBytes: 12000,
        nextOffset: 4096,
      }).truncated,
    ).toBe(true);
    expect(() =>
      decodeNativeHarnessToolResultBounds({ truncated: true, returnedBytes: 4096 }),
    ).toThrow();
    expect(() =>
      decodeNativeHarnessToolResultBounds({
        truncated: false,
        returnedBytes: 4096,
        omittedBytes: 1,
        nextOffset: 4096,
      }),
    ).toThrow();
  });

  it("context remaining is what the planner measured, never more than the budget", () => {
    const remaining = decodeNativeHarnessContextRemaining({
      safeInputBudgetTokens: 150_000,
      usedTokens: 90_000,
      remainingTokens: 60_000,
      confidence: "high",
      source: "capacity-planner",
      measuredAt: at,
    });
    expect(remaining.remainingTokens).toBe(60_000);
    expect(() =>
      decodeNativeHarnessContextRemaining({
        safeInputBudgetTokens: 150_000,
        usedTokens: 160_000,
        remainingTokens: 0,
        confidence: "high",
        source: "capacity-planner",
        measuredAt: at,
      }),
    ).toThrow();
    expect(() =>
      decodeNativeHarnessContextRemaining({
        safeInputBudgetTokens: 150_000,
        usedTokens: 90_000,
        remainingTokens: 70_000,
        confidence: "high",
        source: "capacity-planner",
        measuredAt: at,
      }),
    ).toThrow();
  });

  it("an unavailable journal lookup returns no entries", () => {
    expect(() =>
      decodeNativeHarnessJournalLookupResult({
        status: "unavailable",
        entries: [{ sequence: 1, role: "user", text: "hello" }],
        returnedBytes: 5,
      }),
    ).toThrow();
    expect(
      decodeNativeHarnessJournalLookupResult({ status: "truncated", entries: [], returnedBytes: 0 })
        .status,
    ).toBe("truncated");
  });
});

describe("native harness context reduction", () => {
  it("a carried note must anchor to a plan step, evidence, artifact, or file hash", () => {
    expect(
      decodeNativeHarnessCarriedNote({
        claim: "Auth middleware now rejects expired tokens.",
        anchor: {
          kind: "file-hash",
          path: "apps/server/src/auth.ts",
          sha256: "a".repeat(64),
        },
      }).anchor.kind,
    ).toBe("file-hash");
    expect(() => decodeNativeHarnessCarriedNote({ claim: "We fixed auth." })).toThrow();
    expect(() =>
      decodeNativeHarnessCarriedNote({
        claim: "We fixed auth.",
        anchor: { kind: "file-hash", path: "x.ts", sha256: "not-a-hash" },
      }),
    ).toThrow();
  });

  it("a cutover always names its boundary and admits the cache prefix it invalidated", () => {
    const cut = {
      turnId: turn,
      requiredTokens: 210_000,
      windowTokens: 200_000,
      freedTokens: 80_000,
      reducedAt: at,
      kind: "cutover",
      droppedTurns: 12,
      boundary: "tool-call-group",
      cachePrefixInvalidated: true,
      carriedNotes: [],
    };
    expect(decodeNativeHarnessContextReduction(cut).kind).toBe("cutover");
    expect(() =>
      decodeNativeHarnessContextReduction({ ...cut, cachePrefixInvalidated: false }),
    ).toThrow();
  });

  it("a last-resort summary records the slot it ran on and where its text lives", () => {
    const summary = decodeNativeHarnessContextReduction({
      turnId: turn,
      requiredTokens: 210_000,
      windowTokens: 200_000,
      freedTokens: 50_000,
      reducedAt: at,
      kind: "summary",
      summarizedTurns: 30,
      slotId: "smol",
      reference: "content-store://summary/1",
    });
    expect(summary.kind === "summary" && summary.slotId).toBe("smol");
  });
});

describe("native harness turns and sessions", () => {
  const route = {
    job: "lead",
    decidedAt: at,
    rejected: [],
    kind: "primary",
    slotId: "default",
    candidate: lead,
  };

  it("a turn record ends after it starts", () => {
    const record = {
      turnId: turn,
      sessionId: session,
      sequence: 1,
      job: "lead",
      route,
      toolCalls: 3,
      stopReason: "end-of-turn",
      usage: { inputTokens: 1200, outputTokens: 300, cacheReadInputTokens: 1000 },
      startedAt: at,
      endedAt: later,
    };
    expect(decodeNativeHarnessTurnRecord(record).stopReason).toBe("end-of-turn");
    expect(() =>
      decodeNativeHarnessTurnRecord({ ...record, startedAt: later, endedAt: at }),
    ).toThrow();
  });

  it("a running session has nothing to explain and a paused one always does", () => {
    const running = {
      id: session,
      threadId: "00000000-0000-4000-8000-000000000020",
      mode: "code",
      leadSlotId: "default",
      lead,
      status: "running",
      turnsRun: 2,
      cutovers: 0,
      startedAt: at,
      updatedAt: later,
      version: 3,
    };
    expect(decodeNativeHarnessSession(running).status).toBe("running");
    expect(() =>
      decodeNativeHarnessSession({ ...running, detail: "why would it say this" }),
    ).toThrow();
    expect(() => decodeNativeHarnessSession({ ...running, status: "paused-by-advisor" })).toThrow();
    expect(
      decodeNativeHarnessSession({
        ...running,
        status: "paused-by-advisor",
        detail: "Advisor paused the run: the diff touches the release script.",
      }).status,
    ).toBe("paused-by-advisor");
  });
});

describe("native harness advisor", () => {
  const fields = {
    id: "00000000-0000-4000-8000-000000000030",
    sessionId: session,
    route: lead,
    occurredAt: at,
  };

  it("can cancel, redirect, pause, or answer, and nothing else", () => {
    expect(
      decodeNativeHarnessAdvisorIntervention({
        ...fields,
        kind: "redirect",
        instruction: "Stop editing the migration; the failing test is in the fixture.",
      }).kind,
    ).toBe("redirect");
    expect(() =>
      decodeNativeHarnessAdvisorIntervention({
        ...fields,
        kind: "run-tool",
        tool: "bash",
      }),
    ).toThrow();
  });

  it("an intervention has no room for a tool call, an edit, or an approval", () => {
    expect(() =>
      decodeNativeHarnessAdvisorIntervention({
        ...fields,
        kind: "cancel-turn",
        turnId: turn,
        reason: "Looping on the same failing command.",
        toolCalls: [{ name: "bash", command: "rm -rf build" }],
      }),
    ).toThrow();
    expect(() =>
      decodeNativeHarnessAdvisorIntervention({
        ...fields,
        kind: "pause-run",
        reason: "Needs a person.",
        approve: true,
      }),
    ).toThrow();
  });
});

describe("native harness follow-up suggestions", () => {
  const suggestion = (n: number, target = "new-thread") => ({
    id: `00000000-0000-4000-8000-0000000000${n}0`,
    title: `Follow-up ${n}`,
    prompt: `Do the thing ${n} on its own.`,
    target,
  });

  it("allows at most three suggestions per turn, each with its own id", () => {
    expect(MAX_NATIVE_HARNESS_FOLLOW_UPS).toBe(3);
    expect(decodeNativeHarnessFollowUpSet({ turnId: turn, suggestions: [] }).suggestions).toEqual(
      [],
    );
    expect(() =>
      decodeNativeHarnessFollowUpSet({
        turnId: turn,
        suggestions: [suggestion(1), suggestion(2), suggestion(3), suggestion(4)],
      }),
    ).toThrow();
    expect(() =>
      decodeNativeHarnessFollowUpSet({
        turnId: turn,
        suggestions: [suggestion(1), suggestion(1)],
      }),
    ).toThrow();
  });

  it("a preview must create the kind of thing the suggestion targets", () => {
    expect(
      decodeNativeHarnessFollowUpPreview({
        suggestion: suggestion(1, "new-worktree"),
        wouldCreate: {
          kind: "new-worktree",
          mode: "code",
          projectId: "00000000-0000-4000-8000-0000000000cc",
          title: "Follow-up 1",
        },
      }).wouldCreate.kind,
    ).toBe("new-worktree");
    expect(() =>
      decodeNativeHarnessFollowUpPreview({
        suggestion: suggestion(1, "same-thread"),
        wouldCreate: { kind: "new-thread", mode: "chat", title: "Follow-up 1" },
      }),
    ).toThrow();
  });

  it("a worktree follow-up can only preview a Code thread", () => {
    expect(() =>
      decodeNativeHarnessFollowUpPreview({
        suggestion: suggestion(1, "new-worktree"),
        wouldCreate: {
          kind: "new-worktree",
          mode: "work",
          projectId: "00000000-0000-4000-8000-0000000000cc",
          title: "Follow-up 1",
        },
      }),
    ).toThrow();
  });

  it("activation requires an explicit confirmation and never defaults to one", () => {
    expect(
      decodeActivateNativeHarnessFollowUp({
        turnId: turn,
        suggestionId: suggestion(1).id,
        confirmed: true,
      }).confirmed,
    ).toBe(true);
    expect(() =>
      decodeActivateNativeHarnessFollowUp({ turnId: turn, suggestionId: suggestion(1).id }),
    ).toThrow();
    expect(() =>
      decodeActivateNativeHarnessFollowUp({
        turnId: turn,
        suggestionId: suggestion(1).id,
        confirmed: false,
      }),
    ).toThrow();
  });
});
