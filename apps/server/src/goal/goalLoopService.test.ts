import type { AgentRunAuthority, ThreadGoal } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { GoalLoopService, type GoalLoopDependencies } from "./goalLoopService";

const threadId = "22222222-0000-4000-8000-000000000001";
const goalId = "33333333-0000-4000-8000-000000000001";
const loopId = "11111111-0000-4000-8000-000000000001";

const ceiling: AgentRunAuthority = {
  filesystem: true,
  shell: false,
  git: false,
  network: false,
  tools: true,
  subagents: false,
  executionPolicy: "approval-gated",
  permissionPersistence: "current-session",
};

function goal(overrides: Partial<ThreadGoal> = {}): ThreadGoal {
  return {
    id: goalId,
    threadId,
    revisionId: "44444444-0000-4000-8000-000000000001",
    objective: "Get the migration passing",
    status: "active",
    budget: { turnBudget: 3 },
    usage: { tokensUsed: 0, elapsedMs: 0, turnsUsed: 0 },
    evidence: [],
    createdAt: "2026-08-19T09:00:00.000Z",
    updatedAt: "2026-08-19T09:00:00.000Z",
    version: 1,
    ...overrides,
  } as ThreadGoal;
}

function harness(
  options: {
    readonly goal?: ThreadGoal | null;
    readonly authority?: AgentRunAuthority | undefined;
    readonly pendingApproval?: GoalLoopDependencies["pendingApproval"] extends (
      threadId: string,
    ) => infer R
      ? R
      : never;
    readonly checkpoint?: string | undefined;
    readonly modePosture?: AgentRunAuthority;
    readonly round?: Partial<Awaited<ReturnType<GoalLoopDependencies["runRound"]>>>;
  } = {},
) {
  let current = options.goal === undefined ? goal() : options.goal;
  const journal = { append: vi.fn() };
  const runRound = vi.fn(async (_input: Parameters<GoalLoopDependencies["runRound"]>[0]) => ({
    outcome: "ran" as const,
    tokensSpent: 120,
    elapsedMs: 900,
    ...options.round,
  }));
  const markCheckpoint = vi.fn(async () =>
    options.checkpoint === undefined && "checkpoint" in options
      ? undefined
      : (options.checkpoint ?? "checkpoint-1"),
  );
  const recordUsage = vi.fn(
    async (input: {
      readonly tokensSpent: number;
      readonly elapsedMs: number;
      readonly complete: boolean;
    }) => {
      if (current === null) return;
      current = {
        ...current,
        usage: {
          tokensUsed: current.usage.tokensUsed + input.tokensSpent,
          elapsedMs: current.usage.elapsedMs + input.elapsedMs,
          turnsUsed: current.usage.turnsUsed + 1,
        },
        ...(input.complete ? { status: "complete" as const } : {}),
      } as ThreadGoal;
    },
  );
  let tick = 0;
  let liveAuthority: ReturnType<GoalLoopDependencies["threadAuthority"]> =
    options.authority === undefined ? ceiling : options.authority;
  const dependencies: GoalLoopDependencies = {
    readGoal: () => current,
    recordUsage,
    threadAuthority: () => liveAuthority,
    modePosture: () => options.modePosture,
    pendingApproval: () => options.pendingApproval,
    markCheckpoint,
    runRound,
    journal,
    uuid: () => `55555555-0000-4000-8000-00000000000${String((tick += 1) % 10)}`,
    clock: () => "2026-08-19T09:00:00.000Z" as never,
  };
  return {
    service: new GoalLoopService(dependencies),
    journal,
    runRound,
    recordUsage,
    markCheckpoint,
    goalNow: () => current,
    setThreadAuthority: (next: ReturnType<GoalLoopDependencies["threadAuthority"]>) => {
      liveAuthority = next;
    },
  };
}

async function started(h: ReturnType<typeof harness>) {
  const result = await h.service.execute({
    kind: "start-goal-loop",
    threadId,
    expectedVersion: 0,
    loopId,
    goalId,
    ceiling,
    trigger: { kind: "continuous" },
  });
  return result;
}

function journaled(journal: { append: ReturnType<typeof vi.fn> }): ReadonlyArray<string> {
  return journal.append.mock.calls.map((call) => String(call[0]?.eventName));
}

describe("starting a goal loop", () => {
  it("refuses a goal with no budget rather than starting one nothing would stop", async () => {
    const h = harness({ goal: goal({ budget: {} }) });

    expect(await started(h)).toMatchObject({
      kind: "goal-loop-refused",
      reason: "budget-required",
    });
    expect(h.journal.append).not.toHaveBeenCalled();
  });

  it("records the ceiling the person declared and journals the start", async () => {
    const h = harness();

    const result = await started(h);

    expect(result).toMatchObject({ kind: "goal-loop", loop: { status: "running", roundsRun: 0 } });
    expect(journaled(h.journal)).toEqual(["goal-loop-started@1"]);
  });

  it("refuses a scheduled trigger rather than starting a loop nothing would fire", async () => {
    const h = harness();

    const result = await h.service.execute({
      kind: "start-goal-loop",
      threadId,
      expectedVersion: 0,
      loopId,
      goalId,
      ceiling,
      trigger: { kind: "scheduled", automationId: "66666666-0000-4000-8000-000000000001" },
    });

    expect(result).toMatchObject({ kind: "goal-loop-refused" });
    expect(h.service.read(threadId).loop).toBeNull();
  });

  it("refuses a ceiling the mode cannot impose rather than pretending it holds", async () => {
    // Work turns always reach the filesystem, so a loop asking to run without
    // it cannot be enforced by running the turn.
    const h = harness({ modePosture: { ...ceiling, filesystem: true } });

    const result = await h.service.execute({
      kind: "start-goal-loop",
      threadId,
      expectedVersion: 0,
      loopId,
      goalId,
      ceiling: { ...ceiling, filesystem: false },
      trigger: { kind: "continuous" },
    });

    expect(result).toMatchObject({ reason: "ceiling-unenforceable" });
  });

  it("refuses to start a second loop on a thread already running one", async () => {
    const h = harness();
    await started(h);

    expect(await started(h)).toMatchObject({ reason: "loop-already-running" });
  });
});

describe("taking a round", () => {
  it("checkpoints before the round and runs under the intersection, not the declared ceiling", async () => {
    const h = harness({
      authority: { ...ceiling, filesystem: false, executionPolicy: "plan" },
    });
    await started(h);

    const round = await h.service.advance(threadId);

    expect(h.markCheckpoint).toHaveBeenCalledOnce();
    expect(h.runRound.mock.calls[0]?.[0]).toMatchObject({
      authority: { filesystem: false, executionPolicy: "plan" },
    });
    expect(round).toMatchObject({ outcome: "ran", sequence: 1, checkpointId: "checkpoint-1" });
    expect(journaled(h.journal)).toEqual(["goal-loop-started@1", "goal-loop-round-recorded@1"]);
  });

  it("does not start a round it could not checkpoint", async () => {
    const h = harness();
    await started(h);
    h.markCheckpoint.mockResolvedValueOnce(undefined);

    const outcome = await h.service.advance(threadId);

    expect(outcome).toEqual({ paused: "checkpoint-unavailable" });
    expect(h.runRound).not.toHaveBeenCalled();
    expect(journaled(h.journal)).toContain("goal-loop-paused@1");
  });

  it("spends against the budget and stops before the round that would exceed it", async () => {
    const h = harness({ goal: goal({ budget: { turnBudget: 2 } }) });
    await started(h);

    await h.service.advance(threadId);
    await h.service.advance(threadId);
    const third = await h.service.advance(threadId);

    expect(h.runRound).toHaveBeenCalledTimes(2);
    expect(third).toEqual({ paused: "budget-exhausted" });
    expect(h.service.read(threadId).loop?.status).toBe("budget-limited");
  });

  it("pauses on an approval instead of taking it because a loop is running", async () => {
    const h = harness({ pendingApproval: "destructive-irreversible" });
    await started(h);

    const outcome = await h.service.advance(threadId);

    expect(outcome).toEqual({ paused: "approval-required" });
    expect(h.runRound).not.toHaveBeenCalled();
    expect(h.service.read(threadId).loop?.status).toBe("awaiting-approval");
  });

  it("keeps going when the thread's authority narrows under it, with no gesture from anyone", async () => {
    const h = harness();
    await started(h);
    await h.service.advance(threadId);

    h.setThreadAuthority({ ...ceiling, tools: false });
    const second = await h.service.advance(threadId);

    expect(second).toMatchObject({ sequence: 2 });
    expect(h.runRound.mock.calls[1]?.[0].authority.tools).toBe(false);
  });

  it("stops rather than take a wider grant when the thread's authority widens under it", async () => {
    const h = harness({ authority: { ...ceiling, tools: false } });
    await started(h);
    await h.service.advance(threadId);

    // The person turns the thread's tool access back on while the loop runs.
    h.setThreadAuthority(ceiling);
    const second = await h.service.advance(threadId);

    expect(second).toEqual({ paused: "authority-widened" });
    expect(h.runRound).toHaveBeenCalledOnce();
    expect(h.service.read(threadId).loop?.pauseReason).toBe("authority-widened");
  });

  it("stops when the thread it was running in is gone", async () => {
    const h = harness();
    await started(h);

    h.setThreadAuthority(undefined);

    expect(await h.service.advance(threadId)).toEqual({ paused: "stopped-by-user" });
    expect(h.runRound).not.toHaveBeenCalled();
  });

  it("journals every quiet round so a stalled loop is not silence", async () => {
    const h = harness({ goal: goal({ status: "paused" }) });
    await started(h);

    await h.service.advance(threadId);
    await h.service.advance(threadId);

    expect(journaled(h.journal).filter((name) => name === "goal-loop-paused@1")).toHaveLength(2);
  });
});

describe("a round whose spend could not be recorded", () => {
  it("records the round as failed rather than throwing out of a background loop", async () => {
    const h = harness();
    await started(h);
    h.recordUsage.mockRejectedValueOnce(new Error("goal version conflict"));

    const round = await h.service.advance(threadId);

    expect(round).toMatchObject({ outcome: "failed" });
    expect(journaled(h.journal)).toContain("goal-loop-round-recorded@1");
  });
});

describe("completing a goal from a loop", () => {
  it("will not complete on the provider's word without evidence", async () => {
    const h = harness({ round: { providerReportsComplete: true, evidence: [] } });
    await started(h);

    await h.service.advance(threadId);

    expect(h.recordUsage.mock.calls[0]?.[0].complete).toBe(false);
    expect(h.service.read(threadId).loop?.status).toBe("running");
  });

  it("completes when the provider says so and the host has evidence to point at", async () => {
    const h = harness({
      round: {
        providerReportsComplete: true,
        evidence: [
          {
            kind: "test",
            referenceId: "run-1",
            summary: "Migration suite passed",
            observedAt: "2026-08-19T09:10:00.000Z" as never,
          },
        ],
      },
    });
    await started(h);

    await h.service.advance(threadId);

    expect(h.recordUsage.mock.calls[0]?.[0].complete).toBe(true);
    expect(h.service.read(threadId).loop?.status).toBe("complete");
  });
});

describe("steering a running loop", () => {
  it("accepts a narrowed ceiling and refuses a widened one", async () => {
    const h = harness();
    const start = await started(h);
    const version = start.kind === "goal-loop" ? start.loop.version : 0;

    const narrowed = await h.service.execute({
      kind: "narrow-goal-loop-ceiling",
      threadId,
      expectedVersion: version,
      ceiling: { ...ceiling, tools: false },
    });
    expect(narrowed).toMatchObject({ kind: "goal-loop", loop: { ceiling: { tools: false } } });

    const widened = await h.service.execute({
      kind: "narrow-goal-loop-ceiling",
      threadId,
      expectedVersion: version + 1,
      ceiling: { ...ceiling, shell: true },
    });
    expect(widened).toMatchObject({ kind: "goal-loop-refused", reason: "would-widen" });
  });

  it("refuses a command computed against a stale view", async () => {
    const h = harness();
    await started(h);

    expect(
      await h.service.execute({ kind: "pause-goal-loop", threadId, expectedVersion: 0 }),
    ).toMatchObject({ reason: "stale-version" });
  });

  it("takes no round once stopped, and says so in the journal", async () => {
    const h = harness();
    const start = await started(h);
    const version = start.kind === "goal-loop" ? start.loop.version : 0;
    await h.service.execute({ kind: "stop-goal-loop", threadId, expectedVersion: version });

    const outcome = await h.service.advance(threadId);

    expect(outcome).toEqual({ paused: "stopped-by-user" });
    expect(h.runRound).not.toHaveBeenCalled();
    expect(journaled(h.journal)).toContain("goal-loop-stopped@1");
  });
});
