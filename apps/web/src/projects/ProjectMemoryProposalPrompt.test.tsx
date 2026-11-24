import {
  decodeProjectMemoryProposal,
  type ProjectMemoryProposal,
  type ProjectMemoryProposalDecisionResult,
} from "@octant/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  ProjectMemoryProposalPrompt,
  type ProjectMemoryProposalClient,
} from "./ProjectMemoryProposalPrompt";

const thisThread = "cc000000-0000-4000-8000-000000000001";
const otherThread = "cc000000-0000-4000-8000-000000000002";

function proposal(overrides: Record<string, unknown> = {}): ProjectMemoryProposal {
  return decodeProjectMemoryProposal({
    proposalId: "cc000000-0000-4000-8000-000000000010",
    projectId: "cc000000-0000-4000-8000-000000000020",
    mode: "code",
    threadId: thisThread,
    change: { kind: "create", memoryKind: "decision", content: "Releases ship from main only." },
    expectedVersion: 0,
    requestedAt: "2026-11-08T10:00:00.000Z",
    ...overrides,
  });
}

function client(proposals: ReadonlyArray<ProjectMemoryProposal>) {
  return {
    listMemoryProposals: vi.fn(async () => proposals),
    decideMemoryProposal: vi.fn(
      async (): Promise<ProjectMemoryProposalDecisionResult> => ({
        kind: "project-memory-proposal-declined",
      }),
    ),
  } satisfies ProjectMemoryProposalClient;
}

function renderPrompt(fake: ProjectMemoryProposalClient) {
  return render(
    <ProjectMemoryProposalPrompt
      className="thread-column"
      client={fake}
      threadId={thisThread}
      turnActive={false}
    />,
  );
}

describe("ProjectMemoryProposalPrompt", () => {
  it("shows exactly the entry this thread's agent asks to save, and saves it only on Save", async () => {
    const fake = client([proposal(), proposal({ threadId: otherThread })]);
    renderPrompt(fake);

    const card = await screen.findByRole("group", { name: "Project memory change" });
    expect(card).toHaveTextContent("Save a decision to Project memory?");
    expect(card).toHaveTextContent("Releases ship from main only.");
    expect(card).toHaveTextContent("marked as written by an agent");
    expect(fake.decideMemoryProposal).not.toHaveBeenCalled();

    await userEvent.setup().click(screen.getByRole("button", { name: "Save to memory" }));
    expect(fake.decideMemoryProposal).toHaveBeenCalledWith({
      proposalId: "cc000000-0000-4000-8000-000000000010",
      decision: "confirm",
    });
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "Project memory change" })).toBeNull(),
    );
  });

  it("shows the text a replacement removes and names what an outside-content thread read", async () => {
    renderPrompt(
      client([
        proposal({
          change: {
            kind: "supersede",
            entryId: "cc000000-0000-4000-8000-000000000030",
            previousContent: "Tabs.",
            content: "Spaces.",
          },
          outsideContent: {
            sources: [{ sourceLabel: "web-fetch", ingestionCount: 1 }],
            sourceCount: 1,
          },
        }),
      ]),
    );

    const card = await screen.findByRole("group", { name: "Project memory change" });
    expect(card).toHaveTextContent("Replaces: Tabs.");
    expect(card).toHaveTextContent("Spaces.");
    expect(card).toHaveTextContent("Web pages");
  });

  it("says why a confirmed change the command refused failed, where the card was", async () => {
    const fake = client([proposal()]);
    fake.decideMemoryProposal.mockResolvedValueOnce({
      kind: "project-memory-proposal-not-applied",
      message: "Project memory could not be changed.",
    });
    renderPrompt(fake);

    await userEvent.setup().click(await screen.findByRole("button", { name: "Save to memory" }));
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "Project memory change" })).toBeNull(),
    );
    expect(await screen.findByText("Project memory could not be changed.")).toBeInTheDocument();
  });
});
