import { describe, expect, it } from "vitest";
import type { AgentHierarchyInputEntry } from "./buildAgentHierarchyModel";
import { buildChildRunStatusSummary } from "./buildChildRunStatusSummary";

function entry(
  runId: string,
  lifecycleStatus: string,
  acknowledgement: { required?: boolean; acknowledged?: boolean } = {},
): AgentHierarchyInputEntry {
  return {
    runId,
    role: "worker",
    task: `task ${runId}`,
    lifecycleStatus,
    executionKind: "managed",
    usageQuality: "measured",
    resultAcknowledgement: {
      required: acknowledgement.required ?? false,
      acknowledged: acknowledgement.acknowledged ?? false,
    },
    version: 1,
    updatedAt: "2026-08-14T10:00:00.000Z",
  };
}

describe("buildChildRunStatusSummary", () => {
  it("reports an empty thread with words, not just a zero", () => {
    const summary = buildChildRunStatusSummary([]);

    expect(summary.state).toBe("none");
    expect(summary.label).toBe("No child runs · Idle");
    expect(summary.detail).toBe("This thread has no outstanding child runs.");
    expect(summary.stoppableRunIds).toEqual([]);
    expect(summary.confirmationRequired).toBe(false);
  });

  it("summarizes working children", () => {
    const summary = buildChildRunStatusSummary([
      entry("a", "running"),
      entry("b", "queued"),
      entry("c", "starting"),
    ]);

    expect(summary.state).toBe("working");
    expect(summary.working).toBe(3);
    expect(summary.label).toBe("3 child runs · Working");
    expect(summary.detail).toBe("3 working on this thread.");
  });

  it("promotes waiting over working", () => {
    const summary = buildChildRunStatusSummary([entry("a", "running"), entry("b", "waiting")]);

    expect(summary.state).toBe("waiting");
    expect(summary.label).toBe("2 child runs · Waiting");
    expect(summary.detail).toBe("1 working, 1 waiting on this thread.");
  });

  it("promotes blocked over everything else", () => {
    const summary = buildChildRunStatusSummary([
      entry("a", "running"),
      entry("b", "waiting"),
      entry("c", "failed", { required: true }),
    ]);

    expect(summary.state).toBe("blocked");
    expect(summary.blocked).toBe(1);
    expect(summary.label).toBe("3 child runs · Blocked");
  });

  it("counts unacknowledged terminal results as outstanding, matching delivery evidence", () => {
    const summary = buildChildRunStatusSummary([
      entry("a", "running"),
      entry("b", "completed", { required: true }),
      entry("c", "completed", { required: true, acknowledged: true }),
    ]);

    expect(summary.outstanding).toBe(2);
    expect(summary.deliveryEvidence).toEqual({ active: 1, unacknowledgedResults: 1 });
  });

  it("offers to stop only the non-terminal children", () => {
    const summary = buildChildRunStatusSummary([
      entry("a", "running"),
      entry("b", "waiting"),
      entry("c", "completed", { required: true }),
    ]);

    expect(summary.stoppableRunIds).toEqual(["a", "b"]);
    expect(summary.confirmationRequired).toBe(true);
  });

  it("still requires no confirmation for a single stoppable child", () => {
    const summary = buildChildRunStatusSummary([entry("a", "running")]);

    expect(summary.stoppableRunIds).toEqual(["a"]);
    expect(summary.confirmationRequired).toBe(false);
    expect(summary.label).toBe("1 child run · Working");
  });

  it("says results need acknowledgement when nothing is live", () => {
    const summary = buildChildRunStatusSummary([entry("a", "completed", { required: true })]);

    expect(summary.state).toBe("none");
    expect(summary.detail).toBe("1 finished child run needs acknowledgement.");
  });

  it("does not count an acknowledged blocked run as blocked", () => {
    const summary = buildChildRunStatusSummary([
      entry("a", "failed", { required: true, acknowledged: true }),
    ]);

    expect(summary.blocked).toBe(0);
    expect(summary.outstanding).toBe(0);
  });

  it("does not treat a finished run that needs no acknowledgement as blocked", () => {
    const summary = buildChildRunStatusSummary([entry("a", "failed"), entry("b", "cancelled")]);

    expect(summary.blocked).toBe(0);
    expect(summary.outstanding).toBe(0);
    expect(summary.state).toBe("none");
    expect(summary.label).toBe("No child runs · Idle");
  });
});
