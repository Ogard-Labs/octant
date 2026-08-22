import { describe, expect, it } from "vitest";
import {
  compareThreadBoardActivityDescending,
  compareThreadBoardProjectOrder,
  deriveThreadBoardStatus,
  THREAD_BOARD_PROJECT_STATUS_ORDER,
  THREAD_BOARD_STATUS_COLUMN_ORDER,
  threadBoardProjectStatusRank,
  type ThreadBoardStatus,
  type ThreadBoardStatusInput,
} from "./threadBoardPolicy";

function statusInput(overrides: Partial<ThreadBoardStatusInput> = {}): ThreadBoardStatusInput {
  return {
    deliverySatisfaction: overrides.deliverySatisfaction ?? "pending",
    executing: overrides.executing ?? false,
    awaitingInput: overrides.awaitingInput ?? false,
    interrupted: overrides.interrupted ?? false,
    recovering: overrides.recovering ?? false,
  };
}

describe("deriveThreadBoardStatus", () => {
  it("derives Done only when the confirmed delivery target is objectively satisfied", () => {
    expect(deriveThreadBoardStatus(statusInput({ deliverySatisfaction: "done" }))).toEqual({
      status: "done",
      reason: "delivery-satisfied",
    });
  });

  it("keeps Done first: a satisfied target stays Done even while activity continues", () => {
    expect(
      deriveThreadBoardStatus(
        statusInput({
          deliverySatisfaction: "done",
          executing: true,
          awaitingInput: true,
          interrupted: true,
          recovering: true,
        }),
      ),
    ).toEqual({ status: "done", reason: "delivery-satisfied" });
  });

  it("does not treat a completed model turn as Done when the target is unmet", () => {
    // Executing (or having just executed) never produces Done. Pending delivery
    // with no wait signal is Ready; a waiting target is Waiting.
    expect(deriveThreadBoardStatus(statusInput({ executing: true }))).toEqual({
      status: "in-progress",
      reason: "executing",
    });
    expect(deriveThreadBoardStatus(statusInput({ deliverySatisfaction: "pending" }))).toEqual({
      status: "ready",
      reason: "idle-unmet-delivery",
    });
  });

  it("derives In Progress when a provider turn, tool, or subagent is executing", () => {
    expect(deriveThreadBoardStatus(statusInput({ executing: true }))).toEqual({
      status: "in-progress",
      reason: "executing",
    });
    expect(
      deriveThreadBoardStatus(
        statusInput({ executing: true, awaitingInput: true, recovering: true }),
      ),
    ).toEqual({ status: "in-progress", reason: "executing" });
  });

  it("derives Waiting with a specific reason for recovery, input, interruption, or delivery", () => {
    expect(deriveThreadBoardStatus(statusInput({ recovering: true }))).toEqual({
      status: "waiting",
      reason: "recovering",
    });
    expect(deriveThreadBoardStatus(statusInput({ awaitingInput: true }))).toEqual({
      status: "waiting",
      reason: "awaiting-input",
    });
    expect(deriveThreadBoardStatus(statusInput({ interrupted: true }))).toEqual({
      status: "waiting",
      reason: "interrupted",
    });
    expect(deriveThreadBoardStatus(statusInput({ deliverySatisfaction: "waiting" }))).toEqual({
      status: "waiting",
      reason: "delivery-waiting",
    });
  });

  it("picks the most specific Waiting reason when several wait signals apply", () => {
    expect(
      deriveThreadBoardStatus(
        statusInput({
          recovering: true,
          awaitingInput: true,
          interrupted: true,
          deliverySatisfaction: "waiting",
        }),
      ),
    ).toEqual({ status: "waiting", reason: "recovering" });
    expect(
      deriveThreadBoardStatus(
        statusInput({ awaitingInput: true, interrupted: true, deliverySatisfaction: "waiting" }),
      ),
    ).toEqual({ status: "waiting", reason: "awaiting-input" });
    expect(
      deriveThreadBoardStatus(statusInput({ interrupted: true, deliverySatisfaction: "waiting" })),
    ).toEqual({ status: "waiting", reason: "interrupted" });
  });

  it("never derives Done from an ambiguous or stale delivery target", () => {
    expect(
      deriveThreadBoardStatus(statusInput({ deliverySatisfaction: "waiting" })).status,
    ).not.toBe("done");
  });

  it("derives Ready when nothing else applies", () => {
    expect(deriveThreadBoardStatus(statusInput())).toEqual({
      status: "ready",
      reason: "idle-unmet-delivery",
    });
  });

  it("ignores unread and follow-up: only the runtime signals decide status", () => {
    const inputs: readonly [ThreadBoardStatusInput, ThreadBoardStatus][] = [
      [statusInput({ deliverySatisfaction: "done" }), "done"],
      [statusInput({ executing: true }), "in-progress"],
      [statusInput({ awaitingInput: true }), "waiting"],
      [statusInput(), "ready"],
    ];
    for (const [input, expected] of inputs) {
      expect(deriveThreadBoardStatus(input).status).toBe(expected);
    }
  });
});

describe("thread board grouping order", () => {
  it("orders Status columns Ready, In Progress, Waiting, Done", () => {
    expect(THREAD_BOARD_STATUS_COLUMN_ORDER).toEqual(["ready", "in-progress", "waiting", "done"]);
  });

  it("prioritizes Project column cards Waiting, In Progress, Ready, then Done", () => {
    expect(THREAD_BOARD_PROJECT_STATUS_ORDER).toEqual(["waiting", "in-progress", "ready", "done"]);
    expect(threadBoardProjectStatusRank("waiting")).toBeLessThan(
      threadBoardProjectStatusRank("in-progress"),
    );
    expect(threadBoardProjectStatusRank("in-progress")).toBeLessThan(
      threadBoardProjectStatusRank("ready"),
    );
    expect(threadBoardProjectStatusRank("ready")).toBeLessThan(
      threadBoardProjectStatusRank("done"),
    );
  });

  it("sorts a Project column by status priority, then most recent activity, keeping Done last", () => {
    const cards = [
      { id: "done-new", status: "done" as const, lastMeaningfulActivityAtMs: 500 },
      { id: "ready", status: "ready" as const, lastMeaningfulActivityAtMs: 100 },
      { id: "waiting-old", status: "waiting" as const, lastMeaningfulActivityAtMs: 200 },
      { id: "waiting-new", status: "waiting" as const, lastMeaningfulActivityAtMs: 400 },
      { id: "in-progress", status: "in-progress" as const, lastMeaningfulActivityAtMs: 300 },
    ];
    const ordered = [...cards].sort(compareThreadBoardProjectOrder).map((card) => card.id);
    expect(ordered).toEqual(["waiting-new", "waiting-old", "in-progress", "ready", "done-new"]);
  });

  it("sorts a Status column purely by most recent meaningful activity, nulls last", () => {
    const cards = [
      { id: "old", lastMeaningfulActivityAtMs: 100 },
      { id: "never", lastMeaningfulActivityAtMs: null },
      { id: "new", lastMeaningfulActivityAtMs: 900 },
    ];
    const ordered = [...cards].sort(compareThreadBoardActivityDescending).map((card) => card.id);
    expect(ordered).toEqual(["new", "old", "never"]);
  });
});
