import type { LinearIssueRow } from "@octant/contracts/linear-issues";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { codeDecision, pendingIds } from "../palette/pendingRequests.test-fixtures";
import type { AssignedLinearIssuesList } from "./loadAssignedLinearIssues";
import { InboxView, type InboxDecisionSource } from "./InboxView";

const stylesheet = readFileSync(resolve(import.meta.dirname, "../styles.css"), "utf8");

const linearRow: LinearIssueRow = {
  id: "11111111-1111-4111-8111-111111111111",
  identifier: "ENG-12",
  title: "Browse issues in the workspace",
  state: { name: "In Progress", type: "started" },
  assignee: "Ada",
  url: "https://linear.app/ogard-labs/issue/ENG-12",
};

const linearPage: AssignedLinearIssuesList = {
  rows: [linearRow],
  hasNextPage: false,
  truncated: false,
};

function decisionSource(
  answerClients: ReturnType<typeof decisionClients>,
  ...reads: ReadonlyArray<ReadonlyArray<ReturnType<typeof codeDecision>>>
): InboxDecisionSource {
  let index = 0;
  return {
    pendingRequestClient: {
      list: vi.fn(async () => {
        const requests = reads[Math.min(index, reads.length - 1)] ?? [];
        index += 1;
        return { requests, truncated: false };
      }),
    },
    answerClients: answerClients as unknown as InboxDecisionSource["answerClients"],
    feedRevision: 0,
    settings: undefined,
    workspace: undefined,
    modes: ["work", "code"],
    now: Date.parse("2026-10-06T08:10:00.000Z"),
    projectNames: new Map([[pendingIds.project, "octant"]]),
    onOpenThread: vi.fn(),
  };
}

function decisionClients() {
  return {
    chatClient: { execute: vi.fn(async () => ({})) },
    codeClient: {
      executeOperation: vi.fn(async () => ({ kind: "provider-turn-state", state: "running" })),
      putEvidence: vi.fn(async () => ({ evidenceId: "evidence-1" })),
    },
    workRequestClient: { execute: vi.fn(async () => ({})) },
    workTurnClient: { startFirstTurn: vi.fn(async () => ({ kind: "accepted" })) },
  };
}

describe("InboxView decisions", () => {
  it("lists a finished turn's decision once and sends the option whose number is pressed", async () => {
    const user = userEvent.setup();
    const clients = decisionClients();
    render(
      <InboxView
        attentionItems={[
          {
            signal: {
              threadId: pendingIds.codeThread,
              reason: "turn-finished",
              title: "Fix the parser",
              source: "code",
            },
          },
        ]}
        decisions={decisionSource(clients, [codeDecision()], [])}
        onClose={vi.fn()}
        onOpenThread={vi.fn()}
      />,
    );

    const row = await screen.findByRole("group", { name: "Fix the parser asks you to decide" });
    expect(within(row).getByText("octant")).toBeInTheDocument();
    expect(screen.queryByText("Finished a turn")).not.toBeInTheDocument();
    within(row)
      .getByRole("button", { name: /Open it/ })
      .focus();
    await user.keyboard("1");
    await waitFor(() =>
      expect(clients.codeClient.executeOperation).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "start-provider-turn", threadId: pendingIds.codeThread }),
      ),
    );
    expect(clients.codeClient.putEvidence).toHaveBeenCalledWith(pendingIds.codeThread, "Open it");
    await waitFor(() =>
      expect(
        screen.queryByRole("group", { name: "Fix the parser asks you to decide" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("keeps the row with one quiet line when the host refuses the turn", async () => {
    const user = userEvent.setup();
    const clients = decisionClients();
    clients.codeClient.executeOperation.mockResolvedValueOnce({
      kind: "provider-turn-state",
      state: "failed",
      failure: { category: "invalid", message: "A turn is already running." },
    } as never);
    render(
      <InboxView
        attentionItems={[]}
        decisions={decisionSource(clients, [codeDecision()])}
        onClose={vi.fn()}
        onOpenThread={vi.fn()}
      />,
    );

    const row = await screen.findByRole("group", { name: "Fix the parser asks you to decide" });
    await user.click(within(row).getByRole("button", { name: /Wait for review/ }));
    expect(await within(row).findByRole("status")).toHaveTextContent("A turn is already running.");
    expect(screen.queryByText("No thread is waiting on you.")).not.toBeInTheDocument();
  });
});

describe("InboxView", () => {
  it("offers a real button to the Board when nothing is waiting", async () => {
    const user = userEvent.setup();
    const onOpenBoard = vi.fn();
    render(
      <InboxView
        attentionItems={[]}
        onClose={vi.fn()}
        onOpenBoard={onOpenBoard}
        onOpenThread={vi.fn()}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("No thread is waiting on you.");
    await user.click(screen.getByRole("button", { name: "Open the Board" }));
    expect(onOpenBoard).toHaveBeenCalledOnce();
  });

  it("announces unseen GitHub and Linear rows to assistive technology", async () => {
    document.head.insertAdjacentHTML("beforeend", `<style>${stylesheet}</style>`);

    render(
      <InboxView
        attentionItems={[]}
        loadAssignedGithubWork={vi.fn(async () => ({
          kind: "assigned-work" as const,
          page: {
            items: [
              {
                category: "issue" as const,
                owner: "octant",
                name: "octant",
                number: 7,
                title: "Fix inbox",
                author: "octocat",
                updatedAt: "2026-08-28T10:00:00.000Z",
                url: "https://github.com/octant/octant/issues/7",
              },
            ],
            freshness: { status: "fresh" as const },
          },
        }))}
        loadAssignedLinearIssues={vi.fn(async () => linearPage)}
        onClose={vi.fn()}
        onOpenThread={vi.fn()}
      />,
    );

    expect(await screen.findByRole("link", { name: /Fix inbox/ })).toBeVisible();
    expect(
      await screen.findByRole("link", { name: /Browse issues in the workspace/ }),
    ).toBeVisible();

    await waitFor(() => {
      expect(screen.getAllByText("Unseen")).toHaveLength(2);
    });
    for (const label of screen.getAllByText("Unseen")) {
      expect(label).toHaveClass("sr-only");
    }
  });

  it("says when assigned Linear issues were truncated and offers to open Linear", async () => {
    document.head.insertAdjacentHTML("beforeend", `<style>${stylesheet}</style>`);
    const onOpenLinearIssues = vi.fn();

    render(
      <InboxView
        attentionItems={[]}
        loadAssignedLinearIssues={vi.fn(async () => ({
          rows: [linearRow],
          hasNextPage: true,
          truncated: true,
          endCursor: "page-2",
        }))}
        onClose={vi.fn()}
        onOpenLinearIssues={onOpenLinearIssues}
        onOpenThread={vi.fn()}
      />,
    );

    expect(await screen.findByText(/Showing the first 1 assigned issues\./)).toBeVisible();
    await screen.getByRole("button", { name: "Open Linear" }).click();
    expect(onOpenLinearIssues).toHaveBeenCalledOnce();
  });
});
