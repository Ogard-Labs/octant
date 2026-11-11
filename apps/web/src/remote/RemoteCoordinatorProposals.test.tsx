import { decodeCodePlannerView, decodeCodeThread } from "@octant/contracts";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RemoteCoordinatorProposals } from "./RemoteCoordinatorProposals";

const now = "2026-11-10T12:00:00.000Z";
const PROJECT = "40000000-0000-4000-8000-000000000001";
const COORDINATOR = "20000000-0000-4000-8000-000000000001";

const coordinator = decodeCodeThread({
  id: COORDINATOR,
  projectId: PROJECT,
  bindingRevisionId: "70000000-0000-4000-8000-000000000001",
  repositoryId: `repo_${"a".repeat(64)}`,
  checkoutId: "30000000-0000-4000-8000-000000000001",
  title: "Backlog",
  lifecycle: "active",
  coordinator: true,
  providerInstanceId: "60000000-0000-4000-8000-000000000001",
  modelId: "model-a",
  executionPolicy: "auto-accept-edits",
  permissionPersistence: "current-session",
  deliveryTarget: {
    branchIntent: "feature/coordinate",
    remoteName: "origin",
    proposedBaseRepository: "octant/octant",
    proposedBaseBranch: "main",
    outcomeKind: "local-implementation",
    confirmedAt: now,
  },
  version: 1,
  createdAt: now,
  updatedAt: now,
});

function proposal(id: string, overrides: Record<string, unknown> = {}) {
  return {
    proposal: {
      id: `70000000-0000-4000-8000-0000000001${id}`,
      projectId: PROJECT,
      plannerThreadId: COORDINATOR,
      fromCoordinator: true,
      title: `Worker ${id}`,
      intent: `Intent of worker ${id}.`,
      status: "pending",
      proposedAt: now,
      ...overrides,
    },
    proposalVersion: 1,
  };
}

describe("a coordinator's proposals on a paired browser", () => {
  it("shows this coordinator's pending workers with the requested level and no decision", async () => {
    const readPlanner = vi.fn(async () =>
      decodeCodePlannerView({
        designation: { kind: "none", projectId: PROJECT, updatedAt: now },
        designationVersion: 0,
        proposals: [
          proposal("01", {
            workerOptions: { modelId: "model-b", executionPolicy: "approval-gated" },
          }),
          proposal("02", { plannerThreadId: "20000000-0000-4000-8000-000000000009" }),
          proposal("03", { status: "declined", resolvedAt: now }),
        ],
      }),
    );
    render(<RemoteCoordinatorProposals client={{ readPlanner }} thread={coordinator} />);

    const card = await screen.findByRole("article", { name: "Proposed worker: Worker 01" });
    expect(readPlanner).toHaveBeenCalledWith(PROJECT);
    expect(within(card).getByText("Intent of worker 01.")).toBeVisible();
    expect(
      within(card).getByText(
        "The coordinator asked for this worker on model-b at Ask first or lower.",
      ),
    ).toBeVisible();
    expect(within(card).getByText("Approve at a window on this computer.")).toBeVisible();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText("Worker 02")).toBeNull();
    expect(screen.queryByText("Worker 03")).toBeNull();
  });

  it("shows nothing when the planner read is refused", async () => {
    const readPlanner = vi.fn(async () => {
      throw new Error("unavailable");
    });
    const { container } = render(
      <RemoteCoordinatorProposals client={{ readPlanner }} thread={coordinator} />,
    );
    await vi.waitFor(() => expect(readPlanner).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
