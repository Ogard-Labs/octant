import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
  CodeBoardCard,
  CodeBoardView,
  GithubCatalogueReadRequest,
  GithubCatalogueReadResponse,
} from "@octant/contracts";
import type { GithubClient } from "@octant/client-runtime/github-client";
import { CodeHome, cardBadge } from "./CodeHome";

function githubClient(
  readCatalogue: (request: GithubCatalogueReadRequest) => Promise<GithubCatalogueReadResponse>,
): GithubClient {
  return {
    authenticationSnapshot: async () => {
      throw new Error("not used");
    },
    executeAuthenticationCommand: async () => {
      throw new Error("not used");
    },
    readCatalogue,
    recordRecentRepository: async () => ({ kind: "recent-repositories", rows: [] }),
  };
}

const assigned: GithubCatalogueReadResponse = {
  kind: "assigned-work",
  page: {
    items: [
      {
        category: "issue",
        owner: "octant",
        name: "app",
        number: 12,
        title: "Name the Board",
        author: "octocat",
        updatedAt: "2026-08-05T09:00:00.000Z",
        url: "https://github.com/octant/app/issues/12",
      },
    ],
    freshness: { status: "fresh" },
  } as never,
};

const recents: GithubCatalogueReadResponse = {
  kind: "recent-repositories",
  rows: [
    {
      nodeId: "R_node1",
      owner: "octant",
      name: "app",
      visibility: "private",
      defaultBranch: "main",
      viewerPermission: "admin",
      capabilities: [],
    } as never,
  ],
};

const openIssues: GithubCatalogueReadResponse = {
  kind: "issues",
  page: {
    rows: [
      {
        number: 12,
        title: "Name the Board",
        state: "open",
        author: "octocat",
        updatedAt: "2026-08-05T09:00:00.000Z",
        url: "https://github.com/octant/app/issues/12",
      },
      {
        number: 40,
        title: "Widen the dock",
        state: "open",
        author: "hubot",
        updatedAt: "2026-08-06T09:00:00.000Z",
        url: "https://github.com/octant/app/issues/40",
      },
    ],
    sort: "updated-desc",
    hasNextPage: false,
    freshness: { status: "fresh" },
  },
};

function card(overrides: Partial<CodeBoardCard>): CodeBoardCard {
  return {
    threadId: "10000000-0000-4000-8000-000000000001",
    projectId: "20000000-0000-4000-8000-000000000001",
    checkoutId: "30000000-0000-4000-8000-000000000001",
    checkoutKind: "managed-worktree",
    title: "Ai slop callouts",
    status: "done",
    statusReason: "delivered",
    outcomeKind: "pull-request",
    deliverySatisfaction: "satisfied",
    providerInstanceId: "40000000-0000-4000-8000-000000000001",
    modelId: "sonnet",
    executing: false,
    worktree: { kind: "available", head: { kind: "branch", name: "octant/ai-slop" } },
    changedFiles: {
      kind: "observed",
      freshness: { status: "fresh" },
      changedPathCount: 6,
      stagedCount: 0,
      committedAhead: 1,
      workingTreeClean: true,
      insertions: 610,
      deletions: 0,
    },
    linkedPullRequest: {
      kind: "linked",
      freshness: { status: "fresh" },
      number: 273,
      url: "https://github.com/octant/app/pull/273",
      baseRepository: "octant/app",
      baseBranch: "main",
      headBranch: "octant/ai-slop",
      state: "merged",
      matchesDeliveryBranch: true,
    },
    pullRequestSummaries: { items: [], hiddenCount: 0 },
    checks: { freshness: { status: "fresh" }, state: "passing" },
    reviewState: { freshness: { status: "fresh" }, state: "approved" },
    childAgents: { active: 0, unacknowledged: 0 },
    planProgress: { kind: "none" },
    recovery: { kind: "none" },
    githubFreshness: { status: "fresh" },
    followUp: false,
    lastMeaningfulActivityAt: "2026-08-06T01:00:00.000Z",
    ...overrides,
  } as unknown as CodeBoardCard;
}

describe("CodeHome", () => {
  it("lists assigned work, open issues nobody took, and the latest threads with their delivery state", async () => {
    const user = userEvent.setup();
    const onPickGithub = vi.fn();
    const onPickIssue = vi.fn();
    const onOpenThread = vi.fn();
    const client = githubClient(async (request) => {
      if (request.kind === "assigned-work") return assigned;
      if (request.kind === "recent-repositories") return recents;
      if (request.kind === "issues") return openIssues;
      throw new Error(`unexpected ${request.kind}`);
    });
    const board: CodeBoardView = {
      version: 1,
      query: { version: 1 },
      cards: [
        card({}),
        card({
          threadId: "10000000-0000-4000-8000-000000000002" as never,
          title: "Open PRs merge order",
          executing: true,
          lastMeaningfulActivityAt: "2026-08-06T02:00:00.000Z" as never,
        }),
      ],
      generatedAt: "2026-08-06T03:00:00.000Z",
    } as unknown as CodeBoardView;

    render(
      <CodeHome
        githubClient={client}
        loadAssignedLinearIssues={async () => ({
          rows: [
            {
              id: "lin-1",
              identifier: "OCT-7",
              title: "Ship the sidebar split",
              state: { name: "Todo", type: "unstarted" },
              url: "https://linear.app/octant/issue/OCT-7",
            } as never,
          ],
        })}
        loadBoard={async () => board}
        loadOpenLinearIssues={async () => ({
          rows: [
            {
              id: "lin-2",
              identifier: "OCT-9",
              title: "Name the Board columns",
              state: { name: "Backlog", type: "backlog" },
              url: "https://linear.app/octant/issue/OCT-9",
            } as never,
          ],
        })}
        onOpenThread={onOpenThread}
        onPickGithub={onPickGithub}
        onPickIssue={onPickIssue}
        onPickLinear={vi.fn()}
        projectNames={new Map([["20000000-0000-4000-8000-000000000001", "Octant"]])}
        providerLabels={new Map([["40000000-0000-4000-8000-000000000001", "Claude Code"]])}
      />,
    );

    const upNext = await screen.findByRole("region", { name: "Up next" });
    expect(within(upNext).getByText("Name the Board")).toBeVisible();
    expect(within(upNext).getByText("Ship the sidebar split")).toBeVisible();
    expect(within(upNext).getByText("OCT-7")).toBeVisible();
    expect(within(upNext).getByText("Todo")).toBeVisible();

    const fresh = await screen.findByRole("region", { name: "Start something new" });
    expect(within(fresh).getByText("Widen the dock")).toBeVisible();
    expect(within(fresh).queryByText("Name the Board")).not.toBeInTheDocument();
    expect(await within(fresh).findByText("Name the Board columns")).toBeVisible();
    expect(within(fresh).getByText("OCT-9")).toBeVisible();
    expect(within(upNext).getByText("Assigned to you")).toBeVisible();

    const next = await screen.findByRole("region", { name: "Continue" });
    const cards = within(next).getAllByRole("button");
    expect(cards[0]).toHaveTextContent("Running");
    expect(cards[0]).toHaveTextContent("Open PRs merge order");
    expect(cards[1]).toHaveTextContent("Done");
    expect(cards[1]).toHaveTextContent("+610 −0");
    expect(cards[1]).toHaveTextContent("Octant");
    expect(cards[1]).toHaveTextContent("octant/ai-slopworktree");
    expect(cards[1]).toHaveTextContent("#273 Merged");
    expect(cards[1]).toHaveTextContent("Claude Code");
    expect(cards[1]).not.toHaveTextContent("Ready");

    await user.click(within(upNext).getByText("Name the Board"));
    expect(onPickGithub).toHaveBeenCalledWith(expect.objectContaining({ number: 12 }));
    await user.click(within(fresh).getByText("Widen the dock"));
    expect(onPickIssue).toHaveBeenCalledWith(expect.objectContaining({ number: 40 }));
    await user.click(cards[1]!);
    expect(onOpenThread).toHaveBeenCalledWith({
      threadId: "10000000-0000-4000-8000-000000000001",
      projectId: "20000000-0000-4000-8000-000000000001",
    });
  });

  it("says you are caught up when nothing is assigned and hides sections without a source", async () => {
    const client = githubClient(async (request) => {
      if (request.kind === "assigned-work") {
        return {
          kind: "assigned-work",
          page: { items: [], freshness: { status: "fresh" } },
        } as never;
      }
      if (request.kind === "recent-repositories") return { kind: "recent-repositories", rows: [] };
      throw new Error(`unexpected ${request.kind}`);
    });
    render(<CodeHome githubClient={client} onPickGithub={vi.fn()} onPickIssue={vi.fn()} />);

    expect(await screen.findByText("You're all caught up.")).toBeVisible();
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Start something new" })).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("region", { name: "Continue" })).not.toBeInTheDocument();
  });

  it("names the thread's own state and leaves the pull request to the facts", () => {
    expect(cardBadge(card({}))).toEqual({ label: "Done", tone: "done", detail: "+610 −0" });
    expect(cardBadge(card({ executing: true })).label).toBe("Running");
    expect(
      cardBadge(
        card({
          linkedPullRequest: { kind: "none" } as never,
          status: "waiting",
          changedFiles: { kind: "unavailable" } as never,
        }),
      ),
    ).toEqual({ label: "Waiting", tone: "waiting" });
  });
});
