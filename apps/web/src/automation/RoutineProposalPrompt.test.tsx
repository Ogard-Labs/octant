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

    const card = await screen.findByRole("article", { name: "Routine proposal" });
    expect(card).toHaveTextContent("Friday digest");
    expect(card).toHaveTextContent("(UTC)");
    expect(card).toHaveTextContent("Summarize this week's changes.");
  });

  it("creates the routine in one click on the chip", async () => {
    const fake = client([proposal()]);
    renderPrompt(fake);

    await userEvent.click(await screen.findByRole("button", { name: "Create routine" }));

    expect(fake.decideProposal).toHaveBeenCalledWith({ proposalId, decision: "confirm" });
    await waitFor(() => expect(screen.queryByRole("article")).not.toBeInTheDocument());
  });

  it("declines and creates nothing when the person dismisses the chip", async () => {
    const fake = client([proposal()]);
    renderPrompt(fake);

    await userEvent.click(await screen.findByRole("button", { name: "Dismiss Friday digest" }));

    expect(fake.decideProposal).toHaveBeenCalledTimes(1);
    expect(fake.decideProposal).toHaveBeenCalledWith({ proposalId, decision: "decline" });
    await waitFor(() => expect(screen.queryByRole("article")).not.toBeInTheDocument());
  });

  it("says a follow-up goes back into this thread, and schedules it only when confirmed", async () => {
    const fake = client([
      proposal({
        displayName: "Check for the reply",
        trigger: { kind: "once", scheduledAt: "2026-11-01T08:00:00.000Z" },
        missedRunPolicy: "run-once",
        targetPolicy: "same-thread",
        firstRunAt: "2026-11-01T08:00:00.000Z",
      } as never),
    ]);
    renderPrompt(fake);

    const card = await screen.findByRole("article", { name: "Follow-up proposal" });
    expect(card).toHaveTextContent("Follow-up here");
    expect(card).toHaveTextContent("Check for the reply");
    expect(card).toHaveTextContent("new turn in this thread");
    expect(fake.decideProposal).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Schedule follow-up" }));
    expect(fake.decideProposal).toHaveBeenCalledWith({ proposalId, decision: "confirm" });
  });

  it("shows nothing for another thread's proposal", async () => {
    const fake = client([proposal({ threadId: otherThread } as never)]);
    const { container } = renderPrompt(fake);

    await waitFor(() => expect(fake.listProposals).toHaveBeenCalled());
    await Promise.resolve();
    expect(container).toBeEmptyDOMElement();
  });
});
