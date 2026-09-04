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

    const next = await screen.findByRole("region", { name: "Continue" });
    const cards = within(next).getAllByRole("button");
    expect(cards[0]).toHaveTextContent("Running");
    expect(cards[0]).toHaveTextContent("Open PRs merge order");
    expect(cards[1]).toHaveTextContent("Merged");
    expect(cards[1]).toHaveTextContent("+610 −0");
    expect(cards[1]).toHaveTextContent("Claude Code · Octant · octant/ai-slop");
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

  it("shows the newest unpicked issues across repositories, not the ones that answered first", async () => {
    const requests: GithubCatalogueReadRequest[] = [];
    const issue = (repository: string, number: number, updatedAt: string) => ({
      number,
      title: `Issue ${String(number)}`,
      state: "open" as const,
      author: "octocat",
      updatedAt,
      url: `https://github.com/octant/${repository}/issues/${String(number)}`,
    });
    // The slow repository holds the newest issues, and it answers last.
    const pages: Record<string, ReadonlyArray<ReturnType<typeof issue>>> = {
      app: [
        issue("app", 1, "2026-08-01T09:00:00.000Z"),
        issue("app", 2, "2026-08-02T09:00:00.000Z"),
        issue("app", 3, "2026-08-03T09:00:00.000Z"),
        issue("app", 4, "2026-08-04T09:00:00.000Z"),
      ],
      docs: [
        issue("docs", 90, "2026-09-01T09:00:00.000Z"),
        issue("docs", 91, "2026-09-02T09:00:00.000Z"),
      ],
    };
    const client = githubClient(async (request) => {
      requests.push(request);
      if (request.kind === "assigned-work") {
        return {
          kind: "assigned-work",
          page: { items: [], freshness: { status: "fresh" } },
        } as never;
      }
      if (request.kind === "recent-repositories") {
        const repository = (name: string) => ({
          nodeId: `R_${name}`,
          owner: "octant",
          name,
          visibility: "private",
          defaultBranch: "main",
          viewerPermission: "admin",
          capabilities: [],
        });
        return {
          kind: "recent-repositories",
          rows: [repository("app"), repository("docs")],
        } as never;
      }
      if (request.kind === "issues") {
        if (request.name === "docs") await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          kind: "issues",
          page: {
            rows: pages[request.name] ?? [],
            sort: "updated-desc",
            hasNextPage: false,
            freshness: { status: "fresh" },
          },
        } as never;
      }
      throw new Error(`unexpected ${request.kind}`);
    });

    render(
      <CodeHome
        githubClient={client}
        loadAssignedLinearIssues={async () => ({ rows: [] })}
        onOpenThread={vi.fn()}
        onPickGithub={vi.fn()}
        onPickIssue={vi.fn()}
        onPickLinear={vi.fn()}
        projectNames={new Map()}
        providerLabels={new Map()}
      />,
    );

    const fresh = await screen.findByRole("region", { name: "Start something new" });
    // Four slots, and the two newest belong to the repository that answered
    // last: arrival order would have dropped them for the older four.
    await waitFor(() => expect(within(fresh).getByText("Issue 91")).toBeVisible());
    expect(within(fresh).getByText("Issue 90")).toBeVisible();
    expect(within(fresh).queryByText("Issue 1")).not.toBeInTheDocument();

    // The section promises issues nobody has picked up, so the read asks
    // GitHub for unassigned issues rather than filtering afterwards.
    const issueReads = requests.filter((request) => request.kind === "issues");
    expect(issueReads).not.toHaveLength(0);
    for (const read of issueReads) expect(read).toMatchObject({ assignee: "none" });
  });

  it("reads the board once while its loader keeps its identity across rerenders", async () => {
    const loadBoard = vi.fn(
      async () =>
        ({
          version: 1,
          query: { version: 1 },
          cards: [card({})],
          generatedAt: "2026-08-06T03:00:00.000Z",
        }) as unknown as CodeBoardView,
    );
    const props = {
      loadAssignedLinearIssues: async () => ({ rows: [] }),
      loadBoard,
      onOpenThread: vi.fn(),
      onPickGithub: vi.fn(),
      onPickIssue: vi.fn(),
      onPickLinear: vi.fn(),
      projectNames: new Map([["20000000-0000-4000-8000-000000000001", "Octant"]]),
      providerLabels: new Map([["40000000-0000-4000-8000-000000000001", "Claude Code"]]),
    };

    const view = render(<CodeHome {...props} />);
    await screen.findByRole("region", { name: "Continue" });
    expect(loadBoard).toHaveBeenCalledTimes(1);

    // A rerender the board has nothing to do with must not re-query it. The
    // shell renders on every streamed turn chunk.
    view.rerender(<CodeHome {...props} />);
    view.rerender(<CodeHome {...props} />);
    await waitFor(() => expect(loadBoard).toHaveBeenCalledTimes(1));
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

  it("names the one fact that says where a thread stands", () => {
    expect(cardBadge(card({}))).toEqual({ label: "Merged", tone: "merged", detail: "+610 −0" });
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
