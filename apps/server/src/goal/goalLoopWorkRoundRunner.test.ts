import { describe, expect, it, vi } from "vitest";
import type { WindowId, WorkTurnLookupResult, WorkTurnStreamFrame } from "@octant/contracts";
import { decodeWorkTurnRequestId, decodeWorkTurnId } from "@octant/contracts";
import type { GoalLoopWorkTurnPort } from "./goalLoopWorkRoundRunner";
import { createGoalLoopWorkRoundRunner } from "./goalLoopWorkRoundRunner";
import { WorkTurnUsageStore } from "../work/workTurnUsageStore";

const windowId = "00000000-0000-4000-8000-000000000901" as WindowId;
const threadId = "22222222-0000-4000-8000-000000000001";
const turnId = "88888888-0000-4000-8000-000000000001";

function acceptedTurn(
  requestId: string,
  status: "accepted" | "running" | "completed" | "cancelled" | "failed" | "waiting",
): Extract<WorkTurnLookupResult, { kind: "accepted" }> {
  return {
    kind: "accepted",
    turn: {
      requestId: decodeWorkTurnRequestId(requestId),
      threadId: threadId as never,
      turnId: decodeWorkTurnId(turnId),
      projectId: "aaaaaaaa-0000-4000-8000-000000000001" as never,
      authority: {} as never,
      status,
      prompt: "Get the migration passing",
      transcript: [],
      capabilities: {} as never,
      version: 1 as never,
      acceptedAt: "2026-08-19T09:00:00.000Z" as never,
      updatedAt: "2026-08-19T09:00:00.000Z" as never,
    },
  };
}

function settledFrame(
  turn: Extract<WorkTurnLookupResult, { kind: "accepted" }>["turn"],
): WorkTurnStreamFrame {
  return { kind: "turn-settled", sequence: 1, threadId: threadId as never, turn };
}

function harness(
  options: {
    readonly start?: GoalLoopWorkTurnPort["startFirstTurn"];
    readonly frames?: AsyncGenerator<WorkTurnStreamFrame>;
    readonly usage?: WorkTurnUsageStore;
  } = {},
) {
  const usage = options.usage ?? new WorkTurnUsageStore();
  let n = 0;
  const turns: GoalLoopWorkTurnPort = {
    startFirstTurn:
      options.start ??
      vi.fn(async () => acceptedTurn("77777777-0000-4000-8000-000000000001", "running")),
    liveCursor: vi.fn(() => 0),
    subscribe: vi.fn(async function* () {
      yield* options.frames ?? (async function* () {})();
    }),
  };
  const run = createGoalLoopWorkRoundRunner({
    turns,
    usage,
    windowId: () => windowId,
    command: (input) => ({
      kind: "start-work-thread-turn",
      requestId: `77777777-0000-4000-8000-00000000000${(n += 1)}`,
      threadId: input.threadId,
      turnId,
      prompt: input.objective,
      authority: {},
    }),
    uuid: () => "88888888-0000-4000-8000-000000000001",
    now: (() => {
      let t = 0;
      return () => (t += 100);
    })(),
  });
  return { run, turns, usage };
}

describe("createGoalLoopWorkRoundRunner", () => {
  it("reports the round only after the turn it started settles, with the elapsed time of the turn", async () => {
    const h = harness({
      frames: (async function* () {
        yield settledFrame({
          ...acceptedTurn("77777777-0000-4000-8000-000000000001", "running").turn,
          status: "completed",
        });
      })(),
    });

    const outcome = await h.run({ threadId, objective: "Get the migration passing" });

    expect(outcome).toEqual({ outcome: "ran", tokensSpent: 0, elapsedMs: 100 });
  });

  it("reports the provider's tokens for the turn when the provider reported usage", async () => {
    const usage = new WorkTurnUsageStore();
    const h = harness({
      usage,
      frames: (async function* () {
        const accepted = acceptedTurn("77777777-0000-4000-8000-000000000001", "running");
        yield settledFrame({ ...accepted.turn, status: "completed" });
      })(),
    });
    usage.record(decodeWorkTurnRequestId("77777777-0000-4000-8000-000000000001"), {
      inputTokens: 120,
      outputTokens: 30,
    });

    const outcome = await h.run({ threadId, objective: "Get the migration passing" });

    expect(outcome).toEqual({ outcome: "ran", tokensSpent: 150, elapsedMs: 100 });
  });

  it("reports a failed round when the turn it started failed", async () => {
    const h = harness({
      frames: (async function* () {
        const accepted = acceptedTurn("77777777-0000-4000-8000-000000000001", "running");
        yield settledFrame({
          ...accepted.turn,
          status: "failed",
          failure: { category: "failed", message: "Provider exploded." },
        });
      })(),
    });

    const outcome = await h.run({ threadId, objective: "Get the migration passing" });

    expect(outcome).toMatchObject({ outcome: "failed", detail: "Provider exploded." });
  });

  it("reports a failed round when the turn never settles", async () => {
    const h = harness({ frames: (async function* () {})() });

    const outcome = await h.run({ threadId, objective: "Get the migration passing" });

    expect(outcome).toMatchObject({
      outcome: "failed",
      detail: "Work turn ended without a settled state the loop could read.",
    });
  });

  it("reports a failed round when no local window can own the turn", async () => {
    const turns: GoalLoopWorkTurnPort = {
      startFirstTurn: vi.fn(async () =>
        acceptedTurn("77777777-0000-4000-8000-000000000001", "running"),
      ),
      liveCursor: vi.fn(() => 0),
      subscribe: vi.fn(async function* () {}),
    };
    const run = createGoalLoopWorkRoundRunner({
      turns,
      usage: new WorkTurnUsageStore(),
      windowId: () => undefined,
      command: (input) => ({
        kind: "start-work-thread-turn",
        requestId: "77777777-0000-4000-8000-000000000001",
        threadId: input.threadId,
        turnId,
        prompt: input.objective,
        authority: {},
      }),
      uuid: () => turnId,
    });

    const outcome = await run({ threadId, objective: "Get the migration passing" });

    expect(outcome).toMatchObject({
      outcome: "failed",
      detail: "No local window is available to run the round.",
    });
    expect(turns.startFirstTurn).not.toHaveBeenCalled();
  });
});
