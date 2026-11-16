import { decodeCodePlannerView, decodeCodeThread } from "@octant/contracts";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

/** A Code client whose decisions a restricted session never reaches. */
function readOnly(readPlanner: () => Promise<unknown>) {
  return {
    readPlanner: readPlanner as never,
    execute: vi.fn(),
    executePlannerProposal: vi.fn(),
    putEvidence: vi.fn(),
    executeOperation: vi.fn(),
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
    render(<RemoteCoordinatorProposals client={readOnly(readPlanner)} thread={coordinator} />);

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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lets a person read a request the card cut off, and offers nothing for one that fits", async () => {
    // jsdom lays nothing out, so report a request taller than its two lines.
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.textContent?.startsWith("A long request") === true ? 120 : 40;
      },
    );
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(40);
    const readPlanner = vi.fn(async () =>
      decodeCodePlannerView({
        designation: { kind: "none", projectId: PROJECT, updatedAt: now },
        designationVersion: 0,
        proposals: [
          proposal("01", { intent: "A long request that runs past the card's two lines." }),
          proposal("02"),
        ],
      }),
    );
    render(<RemoteCoordinatorProposals client={readOnly(readPlanner)} thread={coordinator} />);

    const long = await screen.findByRole("article", { name: "Proposed worker: Worker 01" });
    const toggle = within(long).getByRole("button", { name: "Show the full request" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(within(long).getByRole("button", { name: "Show less" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(within(long).getByText(/A long request/)).toHaveClass(
      "remote-workspace__proposal-intent--expanded",
    );

    const short = screen.getByRole("article", { name: "Proposed worker: Worker 02" });
    expect(within(short).queryByRole("button")).toBeNull();
  });

  it("shows nothing when the planner read is refused", async () => {
    const readPlanner = vi.fn(async () => {
      throw new Error("unavailable");
    });
    const { container } = render(
      <RemoteCoordinatorProposals client={readOnly(readPlanner)} thread={coordinator} />,
    );
    await vi.waitFor(() => expect(readPlanner).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("approves a worker as it was asked for from a browser the person paired, then sends its request", async () => {
    const pending = proposal("01", {
      workerOptions: {
        providerInstanceId: "60000000-0000-4000-8000-000000000002",
        modelId: "model-b",
        executionPolicy: "approval-gated",
      },
    });
    const readPlanner = vi.fn(async () =>
      decodeCodePlannerView({
        designation: { kind: "none", projectId: PROJECT, updatedAt: now },
        designationVersion: 0,
        proposals: [pending],
      }),
    );
    const execute = vi.fn(async () => ({
      kind: "checkout-prepared",
      bindingRevisionId: "70000000-0000-4000-8000-000000000002",
      checkout: {
        id: coordinator.checkoutId,
        repositoryId: coordinator.repositoryId,
        kind: "existing-worktree",
        availability: "available",
        head: { kind: "branch", name: "main", oid: "a".repeat(40) },
        observedAt: now,
      },
    }));
    const executePlannerProposal = vi.fn(async (command: { creation?: { threadId: string } }) => ({
      status: "confirmed",
      proposal: { ...pending.proposal, status: "confirmed" },
      creation: {
        kind: "managed-thread-created",
        thread: { ...coordinator, id: command.creation?.threadId, coordinator: undefined },
      },
    }));
    const putEvidence = vi.fn(async () => ({
      contentId: "60000000-0000-4000-8000-000000000001",
      digest: "a".repeat(64),
      byteLength: 20,
    }));
    const executeOperation = vi.fn(async (command: { operationId: string }) => ({
      kind: "provider-turn-state",
      operationId: command.operationId,
      state: "running",
    }));
    render(
      <RemoteCoordinatorProposals
        actsAsHostPerson
        client={
          { readPlanner, execute, executePlannerProposal, putEvidence, executeOperation } as never
        }
        thread={coordinator}
      />,
    );

    const card = await screen.findByRole("article", { name: "Proposed worker: Worker 01" });
    expect(within(card).queryByText("Approve at a window on this computer.")).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Approve and start" }));

    await screen.findByText("Worker approved and started.");
    expect(execute).toHaveBeenCalledWith({
      kind: "prepare-code-project-checkout",
      projectId: PROJECT,
    });
    expect(executePlannerProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "confirm-planner-work-proposal",
        proposalId: pending.proposal.id,
        expectedVersion: 1,
        creation: expect.objectContaining({
          kind: "create-managed-code-thread",
          projectId: PROJECT,
          providerInstanceId: "60000000-0000-4000-8000-000000000002",
          modelId: "model-b",
          executionPolicy: "approval-gated",
          sourceBranch: "main",
          startFromOrigin: false,
        }),
      }),
    );
    const workerId = executePlannerProposal.mock.calls[0]?.[0].creation?.threadId;
    expect(putEvidence).toHaveBeenCalledWith(workerId, "Intent of worker 01.");
    expect(executeOperation).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "start-provider-turn", threadId: workerId }),
    );
  });

  it("declines a worker from a browser the person paired and creates nothing", async () => {
    const readPlanner = vi.fn(async () =>
      decodeCodePlannerView({
        designation: { kind: "none", projectId: PROJECT, updatedAt: now },
        designationVersion: 0,
        proposals: [proposal("01")],
      }),
    );
    const execute = vi.fn();
    const executePlannerProposal = vi.fn(async () => ({ status: "declined" }));
    render(
      <RemoteCoordinatorProposals
        actsAsHostPerson
        client={{ readPlanner, execute, executePlannerProposal } as never}
        thread={coordinator}
      />,
    );

    const card = await screen.findByRole("article", { name: "Proposed worker: Worker 01" });
    fireEvent.click(within(card).getByRole("button", { name: "Decline" }));

    await screen.findByText("Worker declined.");
    expect(executePlannerProposal).toHaveBeenCalledWith({
      kind: "decline-planner-work-proposal",
      proposalId: "70000000-0000-4000-8000-000000000101",
      expectedVersion: 1,
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
