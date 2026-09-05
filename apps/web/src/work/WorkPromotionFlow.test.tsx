import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  decodeWorkPromotionProposal,
  decodeWorkPromotionProposalId,
  decodeProjectId,
  type WorkPromotionProposal,
} from "@octant/contracts";
import { WorkPromotionFlow } from "./WorkPromotionFlow";
import type { WorkPromotionController } from "./useWorkPromotionController";

const originProjectId = decodeProjectId("00000000-0000-4000-8000-000000000901");
const targetProjectId = decodeProjectId("00000000-0000-4000-8000-000000000903");
const proposalId = decodeWorkPromotionProposalId("00000000-0000-4000-8000-000000000902");

const pendingProposal = decodeWorkPromotionProposal({
  proposalId,
  originProjectId,
  targetCodeProjectId: targetProjectId,
  selectedContext: {
    summary: "Promote the report generator into a CLI",
    artifactRefs: ["artifact-token-a"],
  },
  status: "proposed",
  proposedCodeExecutionPolicy: "approval-gated",
  proposedCodePermissionPersistence: "current-session",
  proposedBy: { kind: "local-user", actorId: "00000000-0000-4000-8000-000000000001" },
  proposedAt: "2026-07-22T08:00:00.000Z",
  version: 1,
});

describe("WorkPromotionFlow", () => {
  it("requires explicit approve or dismiss and never switches mode silently", async () => {
    const user = userEvent.setup();
    const propose = vi.fn(async () => pendingProposal);
    const approve = vi.fn(
      async (): Promise<WorkPromotionProposal> =>
        decodeWorkPromotionProposal({
          ...pendingProposal,
          status: "approved",
          decidedAt: "2026-07-22T08:05:00.000Z",
          linkedCodeThreadId: "00000000-0000-4000-8000-000000000910",
          version: 2,
        }),
    );
    const dismiss = vi.fn(async () => true);
    const onOpenLinkedCodeThread = vi.fn();
    const deliveryTarget = {
      branchIntent: "feature/authoritative",
      remoteName: "origin",
      proposedBaseRepository: "octocat/octant",
      proposedBaseBranch: "development",
      outcomeKind: "opened-pr" as const,
      confirmedAt: "2026-07-22T08:00:00.000Z" as never,
    };
    const controller: WorkPromotionController = {
      pendingProposals: [pendingProposal],
      availableArtifactRefs: ["artifact-token-a"],
      deliveryTargetsByProject: new Map([[String(targetProjectId), deliveryTarget]]),
      proposing: false,
      reload: vi.fn(async () => undefined),
      propose,
      approve,
      dismiss,
    };

    render(
      <WorkPromotionFlow
        controller={controller}
        originProjectName="Workspace"
        targetCodeProjectLabels={[{ id: targetProjectId, name: "Repository" }]}
        providerChoices={[
          {
            instanceId: "10000000-0000-4000-8000-000000000001" as never,
            modelId: "model-a" as never,
            label: "Provider A",
          },
        ]}
        onOpenLinkedCodeThread={onOpenLinkedCodeThread}
      />,
    );

    expect(screen.getByText(/Work never turns into Code on its own/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Propose a Code thread" }));
    expect(propose).toHaveBeenCalled();
    expect(onOpenLinkedCodeThread).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryTarget,
      }),
    );
    await user.click(screen.getByRole("button", { name: "Open linked Code thread" }));
    expect(onOpenLinkedCodeThread).toHaveBeenCalledWith(
      pendingProposal.linkedCodeThreadId ?? "00000000-0000-4000-8000-000000000910",
      pendingProposal.selectedContext.summary,
      targetProjectId,
    );

    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(dismiss).toHaveBeenCalled();
  });

  it("does not submit a proposal without an explicitly selected artifact ref", async () => {
    const propose = vi.fn(async () => pendingProposal);
    const controller: WorkPromotionController = {
      pendingProposals: [],
      availableArtifactRefs: [],
      deliveryTargetsByProject: new Map(),
      proposing: false,
      reload: vi.fn(async () => undefined),
      propose,
      approve: vi.fn(async () => undefined),
      dismiss: vi.fn(async () => true),
    };

    render(
      <WorkPromotionFlow
        controller={controller}
        originProjectName="Workspace"
        targetCodeProjectLabels={[{ id: targetProjectId, name: "Repository" }]}
        providerChoices={[]}
      />,
    );

    expect(screen.getByRole("button", { name: "Propose a Code thread" })).toBeDisabled();
    expect(propose).not.toHaveBeenCalled();
  });

  it("fails closed when the target Code Project has no authoritative delivery target", async () => {
    const user = userEvent.setup();
    const approve = vi.fn(async () => undefined);
    const controller: WorkPromotionController = {
      pendingProposals: [pendingProposal],
      availableArtifactRefs: ["artifact-token-a"],
      deliveryTargetsByProject: new Map(),
      proposing: false,
      reload: vi.fn(async () => undefined),
      propose: vi.fn(async () => undefined),
      approve,
      dismiss: vi.fn(async () => false),
    };

    render(
      <WorkPromotionFlow
        controller={controller}
        originProjectName="Workspace"
        targetCodeProjectLabels={[{ id: targetProjectId, name: "Repository" }]}
        providerChoices={[
          {
            instanceId: "10000000-0000-4000-8000-000000000001" as never,
            modelId: "model-a" as never,
            label: "Provider A",
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(approve).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/confirmed delivery target/i);
  });

  /**
   * Every Code model the host reports may be unusable for Code (chat-only or
   * unverified tools). Approval must say so rather than present an empty
   * provider list whose Approve button silently does nothing.
   */
  it("says no usable Code model is available instead of approving with none", async () => {
    const user = userEvent.setup();
    const approve = vi.fn(async () => undefined);
    const controller: WorkPromotionController = {
      pendingProposals: [pendingProposal],
      availableArtifactRefs: ["artifact-token-a"],
      deliveryTargetsByProject: new Map([
        [
          String(targetProjectId),
          {
            branchIntent: "feature/authoritative",
            remoteName: "origin",
            proposedBaseRepository: "octocat/octant",
            proposedBaseBranch: "development",
            outcomeKind: "opened-pr" as const,
            confirmedAt: "2026-07-22T08:00:00.000Z" as never,
          },
        ],
      ]),
      proposing: false,
      reload: vi.fn(async () => undefined),
      propose: vi.fn(async () => undefined),
      approve,
      dismiss: vi.fn(async () => false),
    };

    render(
      <WorkPromotionFlow
        controller={controller}
        originProjectName="Workspace"
        targetCodeProjectLabels={[{ id: targetProjectId, name: "Repository" }]}
        providerChoices={[]}
      />,
    );

    expect(screen.getByText(/No usable Code model/i)).toBeVisible();
    const approveButton = screen.getByRole("button", { name: "Approve" });
    expect(approveButton).toBeDisabled();
    await user.click(approveButton);
    expect(approve).not.toHaveBeenCalled();
  });
});
