import { describe, expect, it } from "vitest";
import {
  MAX_CODE_PLANNER_PROPOSAL_INTENT_LENGTH,
  decodeCodePlannerCommand,
  decodeCodePlannerCommandOutcome,
  decodeCodePlannerDesignationUpdated,
  decodeCodePlannerProposalCommand,
  decodeCodePlannerProposalDraft,
  decodeCodePlannerWorkProposal,
} from "./codePlanner";

const ids = {
  project: "10000000-0000-4000-8000-000000000001",
  thread: "20000000-0000-4000-8000-000000000001",
  proposal: "30000000-0000-4000-8000-000000000001",
  createdThread: "40000000-0000-4000-8000-000000000001",
} as const;

const pendingProposal = {
  id: ids.proposal,
  projectId: ids.project,
  plannerThreadId: ids.thread,
  title: "Harden the replay path",
  intent: "Investigate why a replayed checkout observation can land out of order.",
  status: "pending",
  proposedAt: "2026-08-29T09:00:00.000Z",
} as const;

describe("the Code planner contract", () => {
  it("keeps a designation bound to exactly one thread of one Project", () => {
    const updated = decodeCodePlannerDesignationUpdated({
      kind: "planner-designation-updated",
      designation: {
        kind: "designated",
        projectId: ids.project,
        plannerThreadId: ids.thread,
        designatedAt: "2026-08-29T09:00:00.000Z",
      },
    });
    expect(updated.designation.kind).toBe("designated");
  });

  it("refuses a confirmed proposal that does not name the thread it created", () => {
    expect(() =>
      decodeCodePlannerWorkProposal({
        ...pendingProposal,
        status: "confirmed",
        resolvedAt: "2026-08-29T10:00:00.000Z",
      }),
    ).toThrow();
    expect(
      decodeCodePlannerWorkProposal({
        ...pendingProposal,
        status: "confirmed",
        resolvedAt: "2026-08-29T10:00:00.000Z",
        createdThreadId: ids.createdThread,
      }).status,
    ).toBe("confirmed");
  });

  it("refuses a proposal draft whose intent outgrows what a person reads before confirming", () => {
    expect(() =>
      decodeCodePlannerProposalDraft({
        title: "Too much",
        intent: "x".repeat(MAX_CODE_PLANNER_PROPOSAL_INTENT_LENGTH + 1),
      }),
    ).toThrow();
  });

  it("carries a designation refusal as a value the caller must handle", () => {
    const outcome = decodeCodePlannerCommandOutcome({
      status: "refused",
      reason: "thread-in-another-project",
      message: "That thread belongs to another Project.",
    });
    expect(outcome.status).toBe("refused");
  });

  it("requires an undesignate command to say which designation it expects to remove", () => {
    expect(() =>
      decodeCodePlannerCommand({
        kind: "undesignate-code-planner-thread",
        projectId: ids.project,
      }),
    ).toThrow();
  });

  it("only confirms a proposal through the ordinary thread-creation command", () => {
    expect(() =>
      decodeCodePlannerProposalCommand({
        kind: "confirm-planner-work-proposal",
        proposalId: ids.proposal,
        expectedVersion: 1,
        creation: { kind: "rename-code-thread", threadId: ids.thread, expectedVersion: 1 },
      }),
    ).toThrow();
  });
});
