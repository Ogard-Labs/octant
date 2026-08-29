import {
  MAX_PENDING_CODE_PLANNER_PROPOSALS,
  decodeCodePlannerDesignation,
  decodeCodePlannerWorkProposal,
  decodeCodeThreadId,
  decodeProjectId,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  decideCodePlannerBoardAccess,
  decideCodePlannerDesignation,
  decideCodePlannerProposalResolution,
  decideCodePlannerProposalSubmission,
  decideCodePlannerUndesignation,
} from "./codePlannerPolicy";

const projectId = decodeProjectId("10000000-0000-4000-8000-000000000001");
const otherProjectId = decodeProjectId("10000000-0000-4000-8000-000000000002");
const threadId = decodeCodeThreadId("20000000-0000-4000-8000-000000000001");
const otherThreadId = decodeCodeThreadId("20000000-0000-4000-8000-000000000002");

const codeProject = { id: projectId, type: "code", lifecycle: "active" } as const;
const thread = { id: threadId, projectId, lifecycle: "active" } as const;
const designated = decodeCodePlannerDesignation({
  kind: "designated",
  projectId,
  plannerThreadId: threadId,
  designatedAt: "2026-08-29T09:00:00.000Z",
});
const pendingProposal = decodeCodePlannerWorkProposal({
  id: "30000000-0000-4000-8000-000000000001",
  projectId,
  plannerThreadId: threadId,
  title: "Harden the replay path",
  intent: "Investigate the out-of-order checkout observation on replay.",
  status: "pending",
  proposedAt: "2026-08-29T09:00:00.000Z",
});

describe("designating a planner thread", () => {
  it("designates an active thread of the same Code Project when none is designated", () => {
    expect(
      decideCodePlannerDesignation({
        project: codeProject,
        thread,
        currentDesignation: undefined,
      }),
    ).toEqual({ status: "designate" });
  });

  it("refuses to designate a thread that lives in another Project", () => {
    const decision = decideCodePlannerDesignation({
      project: codeProject,
      thread: { ...thread, projectId: otherProjectId },
      currentDesignation: undefined,
    });
    expect(decision).toMatchObject({ status: "refused", reason: "thread-in-another-project" });
  });

  it("refuses to designate a thread that does not exist", () => {
    expect(
      decideCodePlannerDesignation({
        project: codeProject,
        thread: undefined,
        currentDesignation: undefined,
      }),
    ).toMatchObject({ status: "refused", reason: "thread-not-found" });
  });

  it("refuses a second planner while one is already designated", () => {
    const decision = decideCodePlannerDesignation({
      project: codeProject,
      thread: { ...thread, id: otherThreadId },
      currentDesignation: designated,
    });
    expect(decision).toMatchObject({ status: "refused", reason: "planner-already-designated" });
  });

  it("refuses to designate a planner for anything but an active Code Project", () => {
    expect(
      decideCodePlannerDesignation({
        project: { ...codeProject, type: "work" },
        thread,
        currentDesignation: undefined,
      }),
    ).toMatchObject({ status: "refused", reason: "project-unavailable" });
    expect(
      decideCodePlannerDesignation({
        project: { ...codeProject, lifecycle: "archived" },
        thread,
        currentDesignation: undefined,
      }),
    ).toMatchObject({ status: "refused", reason: "project-unavailable" });
  });

  it("refuses to designate an archived thread", () => {
    expect(
      decideCodePlannerDesignation({
        project: codeProject,
        thread: { ...thread, lifecycle: "archived" },
        currentDesignation: undefined,
      }),
    ).toMatchObject({ status: "refused", reason: "thread-archived" });
  });

  it("refuses to undesignate a Project that has no planner", () => {
    expect(
      decideCodePlannerUndesignation({ project: codeProject, currentDesignation: undefined }),
    ).toMatchObject({ status: "refused", reason: "no-planner-designated" });
  });
});

describe("reading the board as the planner", () => {
  it("allows the designated planner thread to read its own Project's board", () => {
    expect(decideCodePlannerBoardAccess({ thread, designation: designated })).toEqual({
      status: "allowed",
      projectId,
    });
  });

  it("refuses the board to a thread that is not the Project's planner", () => {
    expect(
      decideCodePlannerBoardAccess({
        thread: { ...thread, id: otherThreadId },
        designation: designated,
      }),
    ).toMatchObject({ status: "refused", reason: "not-the-planner-thread" });
  });

  it("refuses the board while the Project has no designated planner", () => {
    expect(decideCodePlannerBoardAccess({ thread, designation: undefined })).toMatchObject({
      status: "refused",
      reason: "no-planner-designated",
    });
  });
});

describe("proposing and resolving work", () => {
  it("stops the planner from queueing unresolved proposals without bound", () => {
    expect(
      decideCodePlannerProposalSubmission({
        thread,
        designation: designated,
        pendingProposals: MAX_PENDING_CODE_PLANNER_PROPOSALS,
      }),
    ).toMatchObject({ status: "refused", reason: "too-many-pending-proposals" });
  });

  it("refuses a proposal from a thread that is not the planner", () => {
    expect(
      decideCodePlannerProposalSubmission({
        thread: { ...thread, id: otherThreadId },
        designation: designated,
        pendingProposals: 0,
      }),
    ).toMatchObject({ status: "refused", reason: "not-the-planner-thread" });
  });

  it("refuses to resolve a proposal that was already resolved", () => {
    const resolved = decodeCodePlannerWorkProposal({
      ...pendingProposal,
      status: "declined",
      resolvedAt: "2026-08-29T10:00:00.000Z",
    });
    expect(
      decideCodePlannerProposalResolution({ proposal: resolved, action: "decline" }),
    ).toMatchObject({ status: "refused", reason: "proposal-not-pending" });
  });

  it("refuses to confirm a proposal into a different Project than it was proposed for", () => {
    expect(
      decideCodePlannerProposalResolution({
        proposal: pendingProposal,
        action: "confirm",
        creationProjectId: otherProjectId,
      }),
    ).toMatchObject({ status: "refused", reason: "creation-project-mismatch" });
  });

  it("lets the user confirm a pending proposal into the proposal's own Project", () => {
    expect(
      decideCodePlannerProposalResolution({
        proposal: pendingProposal,
        action: "confirm",
        creationProjectId: projectId,
      }),
    ).toMatchObject({ status: "allowed" });
  });
});
