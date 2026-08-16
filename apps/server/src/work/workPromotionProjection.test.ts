import { describe, expect, it } from "vitest";
import { decodeWorkPromotionFrame, decodeWorkPromotionProposalId } from "@octant/contracts";
import { WorkPromotionProjection } from "./workPromotionProjection";

const ids = {
  proposal: decodeWorkPromotionProposalId("11111111-1111-4111-8111-111111111111"),
  origin: "22222222-2222-4222-8222-222222222222",
  target: "33333333-3333-4333-8333-333333333333",
  codeThread: "44444444-4444-4444-8444-444444444444",
  actor: "55555555-5555-4555-8555-555555555555",
} as const;

const proposedAt = "2026-07-22T08:00:00.000Z";
const decidedAt = "2026-07-22T08:05:00.000Z";

const selectedContext = {
  summary: "Refactor the report generator into a small CLI",
  artifactRefs: ["opaque-artifact-token-1"],
} as const;

function proposedFrame(version = 1) {
  return decodeWorkPromotionFrame({
    kind: "proposed",
    proposal: {
      proposalId: ids.proposal,
      originProjectId: ids.origin,
      targetCodeProjectId: ids.target,
      selectedContext,
      status: "proposed",
      proposedCodeExecutionPolicy: "approval-gated",
      proposedCodePermissionPersistence: "current-session",
      proposedBy: { kind: "local-user", actorId: ids.actor },
      proposedAt,
      version,
    },
  });
}

function approvedFrame(version = 2) {
  return decodeWorkPromotionFrame({
    kind: "approved",
    proposal: {
      proposalId: ids.proposal,
      originProjectId: ids.origin,
      targetCodeProjectId: ids.target,
      selectedContext,
      status: "approved",
      proposedCodeExecutionPolicy: "approval-gated",
      proposedCodePermissionPersistence: "current-session",
      proposedBy: { kind: "local-user", actorId: ids.actor },
      proposedAt,
      decidedAt,
      linkedCodeThreadId: ids.codeThread,
      version,
    },
    linkedCodeThreadId: ids.codeThread,
  });
}

function dismissedFrame(version = 2) {
  return decodeWorkPromotionFrame({
    kind: "dismissed",
    proposal: {
      proposalId: ids.proposal,
      originProjectId: ids.origin,
      targetCodeProjectId: ids.target,
      selectedContext,
      status: "dismissed",
      proposedCodeExecutionPolicy: "approval-gated",
      proposedCodePermissionPersistence: "current-session",
      proposedBy: { kind: "local-user", actorId: ids.actor },
      proposedAt,
      decidedAt,
      version,
    },
  });
}

describe("WorkPromotionProjection", () => {
  it("applies a proposed frame and looks up the proposal", () => {
    const projection = new WorkPromotionProjection();
    projection.apply(proposedFrame());
    const entry = projection.lookup(ids.proposal);
    expect(entry).toBeDefined();
    expect(entry?.proposal.status).toBe("proposed");
    expect(entry?.linkedCodeThreadId).toBeUndefined();
  });

  it("applies an approved frame and records the linked Code thread id", () => {
    const projection = new WorkPromotionProjection();
    projection.apply(proposedFrame());
    projection.apply(approvedFrame());
    const entry = projection.lookup(ids.proposal);
    expect(entry?.proposal.status).toBe("approved");
    expect(entry?.proposal.linkedCodeThreadId).toBe(ids.codeThread);
    expect(entry?.linkedCodeThreadId).toBe(ids.codeThread);
  });

  it("applies a dismissed frame and marks the proposal terminal", () => {
    const projection = new WorkPromotionProjection();
    projection.apply(proposedFrame());
    projection.apply(dismissedFrame());
    const entry = projection.lookup(ids.proposal);
    expect(entry?.proposal.status).toBe("dismissed");
    expect(entry?.linkedCodeThreadId).toBeUndefined();
  });

  it("replays frames idempotently to identical state", () => {
    const first = new WorkPromotionProjection();
    first.apply(proposedFrame());
    first.apply(approvedFrame());
    const second = new WorkPromotionProjection();
    second.apply(proposedFrame());
    second.apply(approvedFrame());
    expect(second.snapshot()).toEqual(first.snapshot());
  });

  it("returns undefined for an unknown proposal id", () => {
    const projection = new WorkPromotionProjection();
    expect(
      projection.lookup(decodeWorkPromotionProposalId("99999999-9999-4999-8999-999999999999")),
    ).toBeUndefined();
  });

  it("ignores a stale proposed frame applied after an approved frame", () => {
    const projection = new WorkPromotionProjection();
    projection.apply(proposedFrame());
    projection.apply(approvedFrame());
    // Stale replay of the original proposed frame must not roll back.
    projection.apply(proposedFrame());
    const entry = projection.lookup(ids.proposal);
    expect(entry?.proposal.status).toBe("approved");
    expect(entry?.proposal.linkedCodeThreadId).toBe(ids.codeThread);
  });

  it("ignores a stale proposed frame applied after a dismissed frame", () => {
    const projection = new WorkPromotionProjection();
    projection.apply(proposedFrame());
    projection.apply(dismissedFrame());
    projection.apply(proposedFrame());
    const entry = projection.lookup(ids.proposal);
    expect(entry?.proposal.status).toBe("dismissed");
  });
});
