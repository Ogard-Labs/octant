import type { ProviderUsageLimitsClient } from "@octant/client-runtime/provider-usage-limits-client";
import { decodeProviderInstance, decodeProviderUsageLimitsSnapshot } from "@octant/contracts";
import type { LinearIssueRow } from "@octant/contracts/linear-issues";
import { PlanUsageProvider } from "../usage/PlanUsageContext";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { ComposerPlanUsage } from "../usage/ComposerPlanUsage";
import { RailUsageRings } from "../usage/RailUsageRings";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  codeDecision,
  codeQuestion,
  pendingIds,
  workChildApproval,
  workLeadApproval,
  workLeadQuestion,
} from "../palette/pendingRequests.test-fixtures";
import type { AssignedLinearIssuesList } from "./loadAssignedLinearIssues";
import { decodePendingRequest } from "@octant/contracts/pending-requests";
import { ProjectIconContext } from "../projects/ProjectIcon";
import { iconSourceFor } from "../projects/projectIcon.test-support";
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
  it("lists a finished turn's decision and sends the option whose number is pressed", async () => {
    const user = userEvent.setup();
    const clients = decisionClients();
    render(
      <InboxView
        attentionItems={[]}
        decisions={decisionSource(clients, [codeDecision()], [])}
        onClose={vi.fn()}
        onOpenThread={vi.fn()}
      />,
    );

    const row = await screen.findByRole("group", { name: "Fix the parser asks you to decide" });
    expect(within(row).getByText("octant")).toBeInTheDocument();
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
    expect(
      screen.queryByText("Threads that need an answer, an approval or a look show up here."),
    ).not.toBeInTheDocument();
  });
});

describe("InboxView Project icon", () => {
  function inbox(source: ReturnType<typeof iconSourceFor>["source"]) {
    return render(
      <ProjectIconContext.Provider value={source}>
        <InboxView
          attentionItems={[]}
          decisions={decisionSource(decisionClients(), [codeDecision()])}
          onClose={vi.fn()}
          onOpenThread={vi.fn()}
        />
      </ProjectIconContext.Provider>,
    );
  }

  it("draws the Project's image in its group heading when the host has an icon", async () => {
    const { container } = inbox(iconSourceFor([pendingIds.project]).source);
    await waitFor(() =>
      expect(container.querySelector(".inbox-group__head img.project-icon")).not.toBeNull(),
    );
  });

  it("keeps the folder glyph when the host has no icon", async () => {
    const { fetcher, source } = iconSourceFor([]);
    const { container } = inbox(source);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(container.querySelector(".inbox-group__head img.project-icon")).toBeNull();
    expect(container.querySelector(".inbox-group__head svg.lucide-folder")).not.toBeNull();
  });
});

describe("InboxView triage", () => {
  it("shows only decisions once Decide is chosen, with the counts on the chips", async () => {
    const user = userEvent.setup();
    const source = decisionSource(decisionClients(), [codeDecision(), workChildApproval()]);
    render(
      <InboxView attentionItems={[]} decisions={source} onClose={vi.fn()} onOpenThread={vi.fn()} />,
    );

    await screen.findByRole("group", { name: "Quarterly report has a subagent waiting for you" });
    expect(screen.getByRole("button", { name: /Decide/ })).toHaveTextContent("1");
    expect(screen.getByRole("button", { name: /Stuck/ })).toHaveTextContent("1");
    await user.click(screen.getByRole("button", { name: /Decide/ }));
    expect(screen.getByRole("group", { name: "Fix the parser asks you to decide" })).toBeVisible();
    expect(
      screen.queryByRole("group", { name: "Quarterly report has a subagent waiting for you" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Finished/ }));
    expect(screen.getByRole("status")).toHaveTextContent("No finished turns waiting.");
  });

  it("lists a finished turn that asked a decision once, as the decision", async () => {
    const user = userEvent.setup();
    render(
      <InboxView
        attentionItems={[
          {
            signal: {
              threadId: pendingIds.codeThread,
              reason: "turn-finished",
              title: "Fix the parser",
              source: "code",
              detail: "Finished a turn.",
            },
          },
        ]}
        decisions={decisionSource(decisionClients(), [codeDecision()])}
        onClose={vi.fn()}
        onOpenThread={vi.fn()}
      />,
    );

    await screen.findByRole("group", { name: "Fix the parser asks you to decide" });
    expect(screen.getByRole("button", { name: /Finished/ })).toHaveTextContent("0");
    await user.click(screen.getByRole("button", { name: /Finished/ }));
    expect(screen.getByRole("status")).toHaveTextContent("No finished turns waiting.");
  });

  it("heads each Project group with its count and its urgent count", async () => {
    const source = decisionSource(decisionClients(), [
      decodePendingRequest({ ...codeDecision(), urgent: true }),
      workChildApproval(),
    ]);
    render(
      <InboxView attentionItems={[]} decisions={source} onClose={vi.fn()} onOpenThread={vi.fn()} />,
    );

    const group = await screen.findByRole("region", { name: "octant" });
    expect(within(group).getByRole("heading")).toHaveTextContent("octant21 urgent");
    expect(screen.getByText(/2 threads are waiting on you\./)).toHaveTextContent("1 urgent.");
  });
});

describe("InboxView waiting subagents", () => {
  it("lists a waiting subagent beside a decision and opens its request without answering it", async () => {
    const user = userEvent.setup();
    const clients = decisionClients();
    const source = decisionSource(clients, [codeDecision(), workChildApproval()]);
    render(
      <InboxView attentionItems={[]} decisions={source} onClose={vi.fn()} onOpenThread={vi.fn()} />,
    );

    const row = await screen.findByRole("group", {
      name: "Quarterly report has a subagent waiting for you",
    });
    expect(within(row).getByText("Research subagent needs your approval")).toBeInTheDocument();
    expect(within(row).getByText("octant")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Fix the parser asks you to decide" })).toBeVisible();
    expect(
      screen.queryByText("Threads that need an answer, an approval or a look show up here."),
    ).not.toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: /Approve|Deny/ })).toBeNull();

    await user.click(within(row).getByRole("button", { name: "Review request" }));
    expect(source.onOpenThread).toHaveBeenCalledExactlyOnceWith(workChildApproval());
    expect(clients.workRequestClient.execute).not.toHaveBeenCalled();
  });
});

describe("InboxView waiting agent approvals", () => {
  it("lists the agent's own approval and opens its thread without answering it", async () => {
    const user = userEvent.setup();
    const clients = decisionClients();
    const source = decisionSource(clients, [workLeadApproval()]);
    render(
      <InboxView attentionItems={[]} decisions={source} onClose={vi.fn()} onOpenThread={vi.fn()} />,
    );

    const row = await screen.findByRole("group", { name: "Quarterly report needs your approval" });
    expect(within(row).getByText("edit: summary.md")).toBeInTheDocument();
    expect(
      screen.queryByText("Threads that need an answer, an approval or a look show up here."),
    ).not.toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: /Approve|Deny/ })).toBeNull();

    await user.click(within(row).getByRole("button", { name: "Review request" }));
    expect(source.onOpenThread).toHaveBeenCalledExactlyOnceWith(workLeadApproval());
    expect(clients.workRequestClient.execute).not.toHaveBeenCalled();
  });

  it("lists the approval once, not again as the thread's attention", async () => {
    render(
      <InboxView
        attentionItems={[
          {
            signal: {
              threadId: pendingIds.workThread,
              reason: "approval-required",
              title: "Quarterly report",
              source: "work",
              detail: "Waiting for your approval.",
            },
          },
        ]}
        decisions={decisionSource(decisionClients(), [workLeadApproval()])}
        onClose={vi.fn()}
        onOpenThread={vi.fn()}
      />,
    );

    expect(
      await screen.findByRole("group", { name: "Quarterly report needs your approval" }),
    ).toBeVisible();
    expect(screen.queryByText("Waiting for your approval.")).not.toBeInTheDocument();
  });

  it("lists a Work agent's own question once, not again as the thread's attention", async () => {
    const user = userEvent.setup();
    const clients = decisionClients();
    const source = decisionSource(clients, [workLeadQuestion()]);
    render(
      <InboxView
        attentionItems={[
          {
            signal: {
              threadId: pendingIds.workThread,
              reason: "question-asked",
              title: "Quarterly report",
              source: "work",
              detail: "Waiting for your answer.",
            },
          },
        ]}
        decisions={source}
        onClose={vi.fn()}
        onOpenThread={vi.fn()}
      />,
    );

    const row = await screen.findByRole("group", {
      name: "Quarterly report is waiting for your answer",
    });
    expect(within(row).getByText("Which quarter should the summary cover?")).toBeInTheDocument();
    expect(screen.queryByText("Waiting for your answer.")).not.toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: "Review request" }));
    expect(source.onOpenThread).toHaveBeenCalledExactlyOnceWith(workLeadQuestion());
    expect(clients.workRequestClient.execute).not.toHaveBeenCalled();
  });

  it("keeps the thread's attention row when this window cannot read the list", () => {
    render(
      <InboxView
        attentionItems={[
          {
            signal: {
              threadId: pendingIds.workThread,
              reason: "approval-required",
              title: "Quarterly report",
              source: "work",
              detail: "Waiting for your approval.",
            },
          },
        ]}
        onClose={vi.fn()}
        onOpenThread={vi.fn()}
      />,
    );
    expect(screen.getByText("Waiting for your approval.")).toBeVisible();
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

    expect(screen.getByRole("status")).toHaveTextContent(
      "Threads that need an answer, an approval or a look show up here.",
    );
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

function waitingThread(id: string) {
  return {
    signal: {
      threadId: id,
      reason: "approval-required" as const,
      title: `Thread ${id}`,
      source: "work" as const,
    },
  };
}

describe("InboxView page", () => {
  it("says the date and that nothing waits when no thread needs the person", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date(2026, 10, 11, 12, 0, 0));
    try {
      render(<InboxView attentionItems={[]} onClose={vi.fn()} onOpenThread={vi.fn()} />);
      const state = screen.getByText(/Nothing is waiting on you\./);
      expect(state).toHaveTextContent(/Wednesday/);
      expect(state).toHaveTextContent(/November/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("changes its date after midnight in a window with no decision source", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date(2026, 10, 11, 23, 59, 30));
    try {
      render(<InboxView attentionItems={[]} onClose={vi.fn()} onOpenThread={vi.fn()} />);
      expect(screen.getByText(/Nothing is waiting on you\./)).toHaveTextContent(/Wednesday/);
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(screen.getByText(/Nothing is waiting on you\./)).toHaveTextContent(/Thursday/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts one waiting thread in the singular and many in the plural", () => {
    const { unmount } = render(
      <InboxView attentionItems={[waitingThread("a")]} onClose={vi.fn()} onOpenThread={vi.fn()} />,
    );
    expect(screen.getByText(/1 thread is waiting on you\./)).toBeVisible();
    unmount();
    render(
      <InboxView
        attentionItems={[waitingThread("a"), waitingThread("b"), waitingThread("c")]}
        onClose={vi.fn()}
        onOpenThread={vi.fn()}
      />,
    );
    expect(screen.getByText(/3 threads are waiting on you\./)).toBeVisible();
  });

  it("says in one sentence what each GitHub state is", async () => {
    const view = (load: () => Promise<never>) => (
      <InboxView
        attentionItems={[]}
        loadAssignedGithubWork={load}
        onClose={vi.fn()}
        onOpenThread={vi.fn()}
      />
    );
    const { unmount } = render(view(() => new Promise(() => undefined)));
    expect(
      within(screen.getByRole("region", { name: "GitHub" })).getByRole("status"),
    ).toHaveTextContent("Loading assigned work…");
    unmount();
    render(
      <InboxView
        attentionItems={[]}
        loadAssignedGithubWork={async () => ({
          kind: "assigned-work" as const,
          page: { items: [], freshness: { status: "fresh" as const } },
        })}
        onClose={vi.fn()}
        onOpenThread={vi.fn()}
      />,
    );
    expect(await screen.findByText("Nothing is assigned to you.")).toBeVisible();
  });

  it("shows a Plan usage card only for an account that reports a window", async () => {
    const accountId = "10000000-0000-4000-8000-000000000001";
    const observedAt = "2026-10-20T12:00:00.000Z";
    const snapshot = (windows: ReadonlyArray<unknown>) =>
      decodeProviderUsageLimitsSnapshot({
        version: 1,
        refreshedAt: observedAt,
        entries: [
          {
            providerInstanceId: accountId,
            status: "available",
            source: "provider-runtime",
            observedAt,
            limits: {
              providerInstanceId: accountId,
              scope: "account",
              requests: { status: "unavailable" },
              tokens: { status: "unavailable" },
              concurrency: { status: "unavailable" },
              retry: { status: "inactive" },
              quota: "available",
              source: "observed-evidence",
              confidence: "high",
              updatedAt: observedAt,
              rateLimitWindows: windows,
            },
          },
        ],
      });
    const account = decodeProviderInstance({
      id: accountId,
      displayName: "Claude Max",
      driverKind: "claude",
      configuration: {
        kind: "claude-agent-sdk",
        binaryPath: "/opt/homebrew/bin/claude",
        authentication: "subscription",
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: observedAt,
      updatedAt: observedAt,
    });
    const page = (windows: ReadonlyArray<unknown>) => (
      <PlanUsageProvider
        barStyle="smooth"
        client={
          {
            list: vi.fn(() => Promise.resolve(snapshot(windows))),
          } as unknown as ProviderUsageLimitsClient
        }
        instances={[account]}
      >
        <InboxView attentionItems={[]} onClose={vi.fn()} onOpenThread={vi.fn()} />
      </PlanUsageProvider>
    );
    const { unmount } = render(
      page([{ window: "five_hour", status: "allowed", utilization: 0.4, observedAt }]),
    );
    const card = await screen.findByRole("region", { name: "Plan usage" });
    expect(card).toHaveTextContent("Claude Max");
    expect(card).toHaveTextContent("60%");
    unmount();
    render(page([]));
    await waitFor(() => expect(screen.getByRole("region", { name: "Needs you" })).toBeVisible());
    expect(screen.queryByRole("region", { name: "Plan usage" })).toBeNull();
  });

  it("reads the plan limits once for the rail, a composer and the Inbox together", async () => {
    const accountId = "10000000-0000-4000-8000-000000000001";
    const observedAt = "2026-10-20T12:00:00.000Z";
    const snapshot = decodeProviderUsageLimitsSnapshot({
      version: 1,
      refreshedAt: observedAt,
      entries: [
        {
          providerInstanceId: accountId,
          status: "available",
          source: "provider-runtime",
          observedAt,
          limits: {
            providerInstanceId: accountId,
            scope: "account",
            requests: { status: "unavailable" },
            tokens: { status: "unavailable" },
            concurrency: { status: "unavailable" },
            retry: { status: "inactive" },
            quota: "available",
            source: "observed-evidence",
            confidence: "high",
            updatedAt: observedAt,
            rateLimitWindows: [
              { window: "five_hour", status: "allowed", utilization: 0.4, observedAt },
            ],
          },
        },
      ],
    });
    const account = decodeProviderInstance({
      id: accountId,
      displayName: "Claude Max",
      driverKind: "claude",
      configuration: {
        kind: "claude-agent-sdk",
        binaryPath: "/opt/homebrew/bin/claude",
        authentication: "subscription",
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: observedAt,
      updatedAt: observedAt,
    });
    const list = vi.fn(() => Promise.resolve(snapshot));
    render(
      <PlanUsageProvider
        barStyle="smooth"
        client={{ list } as unknown as ProviderUsageLimitsClient}
        instances={[account]}
      >
        <RailUsageRings instances={[account]} />
        <ComposerPlanUsage providerInstanceId={accountId} />
        <InboxView attentionItems={[]} onClose={vi.fn()} onOpenThread={vi.fn()} />
      </PlanUsageProvider>,
    );
    expect(await screen.findByRole("region", { name: "Plan usage" })).toHaveTextContent("60%");
    expect(screen.getAllByLabelText("Plan usage left").length).toBeGreaterThan(1);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("reads title, state, Needs you, GitHub in that order", async () => {
    render(
      <InboxView
        attentionItems={[]}
        loadAssignedGithubWork={async () => ({
          kind: "assigned-work" as const,
          page: { items: [], freshness: { status: "fresh" as const } },
        })}
        onClose={vi.fn()}
        onOpenThread={vi.fn()}
      />,
    );
    const title = screen.getByRole("heading", { level: 1, name: "Inbox" });
    const state = screen.getByText(/Nothing is waiting on you\./);
    const needs = screen.getByRole("heading", { level: 2, name: "Needs you" });
    const github = screen.getByRole("heading", { level: 2, name: "GitHub" });
    const follows = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(title, state)).toBe(true);
    expect(follows(state, needs)).toBe(true);
    expect(follows(needs, github)).toBe(true);
    await screen.findByText("Nothing is assigned to you.");
  });
});

it("keeps a deferred question discoverable once and wakes it without answering", async () => {
  const user = userEvent.setup();
  const clients = decisionClients();
  const question = {
    ...codeQuestion(),
    deferralKey: "a".repeat(64),
    deferredUntil: codeQuestion().requestedAt,
  };
  const source = {
    ...decisionSource(clients, [question]),
    now: Date.parse(question.requestedAt) - 1000,
  };
  const defer = vi.fn(async () => true);
  render(
    <InboxView
      attentionItems={[
        {
          signal: {
            threadId: String(question.threadId),
            reason: "question-asked",
            title: question.threadTitle,
            source: "code",
            detail: "Duplicate attention",
          },
        },
      ]}
      decisions={{
        ...source,
        pendingRequestClient: {
          list: async () => ({ requests: [question], truncated: false }),
          defer,
        },
      }}
      onClose={vi.fn()}
      onOpenThread={vi.fn()}
    />,
  );
  await user.click(await screen.findByRole("button", { name: "Bring back now" }));
  expect(defer).toHaveBeenCalledExactlyOnceWith({ key: question.deferralKey, until: null });
  expect(screen.queryByText("Duplicate attention")).not.toBeInTheDocument();
  expect(clients.codeClient.executeOperation).not.toHaveBeenCalled();
});
