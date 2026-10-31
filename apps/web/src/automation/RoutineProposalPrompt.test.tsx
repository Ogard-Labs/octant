import type { AutomationClient } from "@octant/client-runtime";
import type { RoutineProposal } from "@octant/contracts/automation";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RoutineProposalPrompt } from "./RoutineProposalPrompt";

const thisThread = "bb000000-0000-4000-8000-000000000001";
const otherThread = "bb000000-0000-4000-8000-000000000002";
const proposalId = "bb000000-0000-4000-8000-000000000010";

function proposal(overrides: Partial<RoutineProposal> = {}): RoutineProposal {
  return {
    proposalId,
    threadId: thisThread,
    mode: "work",
    projectId: "bb000000-0000-4000-8000-000000000020",
    displayName: "Friday digest",
    taskPrompt: "Summarize this week's changes.",
    trigger: { kind: "weekly-local", weekdays: [5], localTime: "16:00", timeZone: "UTC" },
    missedRunPolicy: "skip",
    firstRunAt: "2026-11-06T16:00:00.000Z",
    requestedAt: "2026-10-31T10:00:00.000Z",
    ...overrides,
  } as RoutineProposal;
}

function client(proposals: ReadonlyArray<RoutineProposal>) {
  const fake = {
    listProposals: vi.fn(async () => proposals),
    decideProposal: vi.fn(async () => ({ kind: "routine-proposal-declined" as const })),
  };
  return fake as unknown as AutomationClient & typeof fake;
}

function renderPrompt(fake: AutomationClient) {
  return render(
    <RoutineProposalPrompt
      className="thread-column"
      client={fake}
      threadId={thisThread}
      turnActive={false}
    />,
  );
}

describe("RoutineProposalPrompt", () => {
  it("shows the routine's name, schedule, and prompt for this thread", async () => {
    renderPrompt(client([proposal()]));

    const card = await screen.findByRole("group", { name: "Routine proposal" });
    expect(card).toHaveTextContent("Create the routine “Friday digest”?");
    expect(card).toHaveTextContent("(UTC)");
    expect(card).toHaveTextContent("Summarize this week's changes.");
  });

  it("creates the routine when the person confirms", async () => {
    const fake = client([proposal()]);
    renderPrompt(fake);

    await userEvent.click(await screen.findByRole("button", { name: "Create routine" }));

    expect(fake.decideProposal).toHaveBeenCalledWith({ proposalId, decision: "confirm" });
    await waitFor(() => expect(screen.queryByRole("group")).not.toBeInTheDocument());
  });

  it("declines the routine when the person declines", async () => {
    const fake = client([proposal()]);
    renderPrompt(fake);

    await userEvent.click(await screen.findByRole("button", { name: "Decline" }));

    expect(fake.decideProposal).toHaveBeenCalledWith({ proposalId, decision: "decline" });
  });

  it("shows nothing for another thread's proposal", async () => {
    const fake = client([proposal({ threadId: otherThread } as never)]);
    const { container } = renderPrompt(fake);

    await waitFor(() => expect(fake.listProposals).toHaveBeenCalled());
    await Promise.resolve();
    expect(container).toBeEmptyDOMElement();
  });
});
