import { describe, expect, it } from "vitest";
import {
  decodeWorkPromotionCommand,
  decodeWorkPromotionCommandResult,
  decodeWorkPromotionContextSelection,
  decodeWorkPromotionList,
  decodeWorkPromotionFrame,
  decodeWorkPromotionProposal,
  decodeWorkPromotionProposalId,
} from "./workPromotion";

const ids = {
  proposal: "11111111-1111-4111-8111-111111111111",
  origin: "22222222-2222-4222-8222-222222222222",
  target: "33333333-3333-4333-8333-333333333333",
  codeThread: "44444444-4444-4444-8444-444444444444",
  provider: "55555555-5555-4555-8555-555555555555",
  actor: "66666666-6666-4666-8666-666666666666",
} as const;

const proposedAt = "2026-07-22T08:00:00.000Z";
const decidedAt = "2026-07-22T08:05:00.000Z";

const selectedContext = {
  summary: "Refactor the report generator into a small CLI",
  artifactRefs: ["opaque-artifact-token-1"],
} as const;

const baseProposedProposal = {
  proposalId: ids.proposal,
  originProjectId: ids.origin,
  targetCodeProjectId: ids.target,
  selectedContext,
  status: "proposed",
  proposedCodeExecutionPolicy: "approval-gated",
  proposedCodePermissionPersistence: "current-session",
  proposedBy: { kind: "local-user", actorId: ids.actor },
  proposedAt,
  version: 0,
} as const;

const approvedProposal = {
  ...baseProposedProposal,
  status: "approved",
  decidedAt,
  linkedCodeThreadId: ids.codeThread,
  version: 1,
} as const;

const deliveryTarget = {
  branchIntent: "feature/report-cli",
  remoteName: "origin",
  proposedBaseRepository: "git@github.com:example/repo.git",
  proposedBaseBranch: "main",
  outcomeKind: "opened-pr",
  confirmedAt: decidedAt,
} as const;

describe("WorkPromotionProposalId", () => {
  it("decodes a valid branded UUID", () => {
    expect(decodeWorkPromotionProposalId(ids.proposal)).toEqual(ids.proposal);
  });

  it("rejects a non-UUID", () => {
    expect(() => decodeWorkPromotionProposalId("not-a-uuid")).toThrow();
  });
});

describe("WorkPromotionContextSelection", () => {
  it("decodes a sanitized summary with opaque artifact refs", () => {
    expect(decodeWorkPromotionContextSelection(selectedContext)).toEqual(selectedContext);
  });

  it("rejects a summary containing a path separator", () => {
    expect(() =>
      decodeWorkPromotionContextSelection({
        summary: "leaked/host/path",
        artifactRefs: ["opaque-artifact-token-1"],
      }),
    ).toThrow();
  });

  it("rejects a summary containing a file URL scheme", () => {
    expect(() =>
      decodeWorkPromotionContextSelection({
        summary: "file:///etc/passwd",
        artifactRefs: ["opaque-artifact-token-1"],
      }),
    ).toThrow();
  });

  it("rejects a summary with an embedded https scheme without slashes", () => {
    expect(() =>
      decodeWorkPromotionContextSelection({
        summary: "Investigate https:internal.example",
        artifactRefs: ["opaque-artifact-token-1"],
      }),
    ).toThrow();
  });

  it("rejects a summary with an embedded file scheme mid-string", () => {
    expect(() =>
      decodeWorkPromotionContextSelection({
        summary: "See file:secret.txt for details",
        artifactRefs: ["opaque-artifact-token-1"],
      }),
    ).toThrow();
  });

  it("rejects an artifact ref containing a path separator", () => {
    expect(() =>
      decodeWorkPromotionContextSelection({
        summary: "clean summary",
        artifactRefs: ["folder/report"],
      }),
    ).toThrow();
  });

  it("rejects an empty artifact ref list", () => {
    expect(() =>
      decodeWorkPromotionContextSelection({
        summary: "clean summary",
        artifactRefs: [],
      }),
    ).toThrow();
  });
});

describe("WorkPromotionProposal", () => {
  it("decodes a valid proposed proposal without a linked Code thread", () => {
    expect(decodeWorkPromotionProposal(baseProposedProposal)).toEqual(baseProposedProposal);
  });

  it("decodes a valid approved proposal with a linked Code thread", () => {
    expect(decodeWorkPromotionProposal(approvedProposal)).toEqual(approvedProposal);
  });

  it("rejects a proposal whose origin and target Code Project are the same", () => {
    expect(() =>
      decodeWorkPromotionProposal({
        ...baseProposedProposal,
        originProjectId: ids.target,
        targetCodeProjectId: ids.target,
      }),
    ).toThrow();
  });

  it("rejects a proposed proposal that already carries a linked Code thread", () => {
    expect(() =>
      decodeWorkPromotionProposal({
        ...baseProposedProposal,
        linkedCodeThreadId: ids.codeThread,
      }),
    ).toThrow();
  });

  it("rejects an approved proposal without a linked Code thread", () => {
    expect(() =>
      decodeWorkPromotionProposal({
        ...baseProposedProposal,
        status: "approved",
        decidedAt,
        version: 1,
      }),
    ).toThrow();
  });

  it("rejects a dismissed proposal that carries a linked Code thread", () => {
    expect(() =>
      decodeWorkPromotionProposal({
        ...baseProposedProposal,
        status: "dismissed",
        decidedAt,
        linkedCodeThreadId: ids.codeThread,
        version: 1,
      }),
    ).toThrow();
  });

  it("structurally rejects a full-access Code execution policy", () => {
    expect(() =>
      decodeWorkPromotionProposal({
        ...baseProposedProposal,
        proposedCodeExecutionPolicy: "full-access",
      }),
    ).toThrow();
  });

  it("structurally rejects a plan Code execution policy", () => {
    expect(() =>
      decodeWorkPromotionProposal({
        ...baseProposedProposal,
        proposedCodeExecutionPolicy: "plan",
      }),
    ).toThrow();
  });

  it("rejects an approved proposal without decidedAt", () => {
    expect(() =>
      decodeWorkPromotionProposal({
        ...baseProposedProposal,
        status: "approved",
        linkedCodeThreadId: ids.codeThread,
        version: 1,
      }),
    ).toThrow();
  });

  it("rejects a dismissed proposal without decidedAt", () => {
    expect(() =>
      decodeWorkPromotionProposal({
        ...baseProposedProposal,
        status: "dismissed",
        version: 1,
      }),
    ).toThrow();
  });

  it("rejects an expired proposal without decidedAt", () => {
    expect(() =>
      decodeWorkPromotionProposal({
        ...baseProposedProposal,
        status: "expired",
        version: 1,
      }),
    ).toThrow();
  });
});

describe("WorkPromotionCommand", () => {
  it("decodes a propose command", () => {
    const command = {
      kind: "propose-work-promotion",
      proposalId: ids.proposal,
      originProjectId: ids.origin,
      targetCodeProjectId: ids.target,
      selectedContext,
      proposedCodePermissionPersistence: "current-session",
    } as const;
    expect(decodeWorkPromotionCommand(command)).toEqual(command);
  });

  it("decodes an approve command carrying Code thread configuration", () => {
    const command = {
      kind: "approve-work-promotion",
      proposalId: ids.proposal,
      expectedVersion: 0,
      providerInstanceId: ids.provider,
      modelId: "claude-sonnet-4",
      deliveryTarget,
    } as const;
    expect(decodeWorkPromotionCommand(command)).toEqual(command);
  });

  it("decodes dismiss and expire transition commands", () => {
    const dismiss = {
      kind: "dismiss-work-promotion",
      proposalId: ids.proposal,
      expectedVersion: 0,
    } as const;
    const expire = {
      kind: "expire-work-promotion",
      proposalId: ids.proposal,
      expectedVersion: 0,
    } as const;
    expect(decodeWorkPromotionCommand(dismiss)).toEqual(dismiss);
    expect(decodeWorkPromotionCommand(expire)).toEqual(expire);
  });
});

describe("WorkPromotionCommandResult", () => {
  it("decodes an approved result whose linked thread matches the proposal", () => {
    const result = {
      kind: "work-promotion-approved",
      proposal: approvedProposal,
      linkedCodeThreadId: ids.codeThread,
    } as const;
    expect(decodeWorkPromotionCommandResult(result)).toEqual(result);
  });

  it("rejects an approved result whose linked thread disagrees with the proposal", () => {
    expect(() =>
      decodeWorkPromotionCommandResult({
        kind: "work-promotion-approved",
        proposal: approvedProposal,
        linkedCodeThreadId: "55555555-5555-4555-8555-555555555556",
      }),
    ).toThrow();
  });

  it("rejects a dismissed result whose proposal is not dismissed", () => {
    expect(() =>
      decodeWorkPromotionCommandResult({
        kind: "work-promotion-dismissed",
        proposal: baseProposedProposal,
      }),
    ).toThrow();
  });

  it("rejects a proposed result whose proposal is not proposed", () => {
    expect(() =>
      decodeWorkPromotionCommandResult({
        kind: "work-promotion-proposed",
        proposal: approvedProposal,
      }),
    ).toThrow();
  });
});

describe("WorkPromotionList", () => {
  it("decodes a promotion list", () => {
    expect(
      decodeWorkPromotionList({
        proposals: [baseProposedProposal],
        artifactRefs: [],
        deliveryTargets: [],
      }),
    ).toEqual({ proposals: [baseProposedProposal], artifactRefs: [], deliveryTargets: [] });
  });
});

describe("WorkPromotionFrame", () => {
  it("decodes a proposed frame", () => {
    const frame = { kind: "proposed", proposal: baseProposedProposal } as const;
    expect(decodeWorkPromotionFrame(frame)).toEqual(frame);
  });

  it("decodes an approved frame whose linked thread matches the proposal", () => {
    const frame = {
      kind: "approved",
      proposal: approvedProposal,
      linkedCodeThreadId: ids.codeThread,
    } as const;
    expect(decodeWorkPromotionFrame(frame)).toEqual(frame);
  });

  it("rejects an approved frame whose proposal status is not approved", () => {
    expect(() =>
      decodeWorkPromotionFrame({
        kind: "approved",
        proposal: baseProposedProposal,
        linkedCodeThreadId: ids.codeThread,
      }),
    ).toThrow();
  });

  it("rejects a proposed frame whose proposal status is not proposed", () => {
    expect(() =>
      decodeWorkPromotionFrame({ kind: "proposed", proposal: approvedProposal }),
    ).toThrow();
  });
});
