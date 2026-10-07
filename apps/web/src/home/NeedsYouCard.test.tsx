import type { PendingRequestClient } from "@octant/client-runtime/pending-request-client";
import type { PendingRequest, PendingRequestList } from "@octant/contracts/pending-requests";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HomeDashboard } from "./HomeDashboard";
import { createNeedsYouCard, type NeedsYouCardSource } from "./NeedsYouCard";

const NOW = Date.parse("2026-10-06T10:00:00.000Z");

function at(minutesAgo: number): string {
  return new Date(NOW - minutesAgo * 60_000).toISOString();
}

const codeApproval = {
  mode: "code",
  kind: "approval",
  projectId: "project-code",
  threadId: "code-thread",
  threadTitle: "Fix the flaky build",
  text: "Run: bun run test",
  requestedAt: at(4),
  answer: { threadId: "code-thread", checkoutId: "checkout-1", approvalId: "approval-1" },
} as unknown as PendingRequest;

const codeQuestion = {
  mode: "code",
  kind: "question",
  projectId: "project-code",
  threadId: "code-question-thread",
  threadTitle: "Pick a database",
  text: "Which database should the service use?",
  options: [{ label: "SQLite" }, { label: "Postgres" }],
  requestedAt: at(9),
  answer: {
    threadId: "code-question-thread",
    checkoutId: "checkout-2",
    requestId: "input-1",
  },
} as unknown as PendingRequest;

const workApproval = {
  mode: "work",
  kind: "approval",
  projectId: "project-work",
  threadId: "work-thread",
  threadTitle: "Quarterly notes",
  text: "Delete: old-draft.md",
  requestedAt: at(2),
  answer: { requestId: "work-request-1", expectedVersion: 7 },
} as unknown as PendingRequest;

const chatQuestion = {
  mode: "chat",
  kind: "question",
  threadId: "chat-thread",
  threadTitle: "Trip ideas",
  text: "Which month are you travelling?",
  options: [],
  requestedAt: at(1),
  answer: {
    threadId: "chat-thread",
    expectedVersion: 3,
    turnId: "turn-1",
    attemptId: "attempt-1",
    requestId: "question-1",
  },
} as unknown as PendingRequest;

const chatChoice = {
  ...chatQuestion,
  threadId: "chat-choice-thread",
  threadTitle: "Pick a colour",
  options: [{ label: "Red", description: "Warm" }, { label: "Blue" }],
  answer: { ...(chatQuestion.answer as object), threadId: "chat-choice-thread" },
} as unknown as PendingRequest;

function reader(...reads: ReadonlyArray<ReadonlyArray<PendingRequest>>): PendingRequestClient {
  let index = 0;
  return {
    list: vi.fn(async () => {
      const requests = reads[Math.min(index, reads.length - 1)] ?? [];
      index += 1;
      return { requests, truncated: false };
    }),
  };
}

function clients() {
  return {
    chatClient: { execute: vi.fn(async () => ({})) },
    codeClient: {
      executeOperation: vi.fn(async () => ({ kind: "operation-accepted" })),
      putEvidence: vi.fn(async () => ({ evidenceId: "evidence-1" })),
    },
    workRequestClient: { execute: vi.fn(async () => ({})) },
  };
}

function source(
  overrides: Partial<NeedsYouCardSource> & { readonly answerClients?: unknown } = {},
): NeedsYouCardSource {
  return {
    pendingRequestClient: reader([]),
    answerClients: clients() as unknown as NeedsYouCardSource["answerClients"],
    feedRevision: 0,
    settings: {},
    workspace: {},
    modes: ["chat", "work", "code"],
    projectNames: new Map([
      ["project-code", "octant"],
      ["project-work", "Finance"],
    ]),
    threadProviders: new Map(),
    now: NOW,
    onOpenThread: vi.fn(),
    onOpenInbox: vi.fn(),
    ...overrides,
  } as NeedsYouCardSource;
}

function renderCard(card: ReturnType<typeof createNeedsYouCard>) {
  return render(
    <HomeDashboard
      cards={[card]}
      customization={{ order: [], visibility: [] }}
      onCustomizationChange={vi.fn()}
    />,
  );
}

async function findCard() {
  return await screen.findByRole("region", { name: "Needs you" });
}

describe("the Needs you card", () => {
  it("lists each waiting approval and question with its thread, Project, wait, and text", async () => {
    renderCard(
      createNeedsYouCard(
        source({
          pendingRequestClient: reader([codeQuestion, codeApproval, workApproval, chatQuestion]),
          threadProviders: new Map([
            ["code-thread", { displayName: "Codex", driverKind: "codex" }],
          ]),
        }),
      ),
    );
    const card = await findCard();
    const approval = await within(card).findByRole("group", {
      name: "Fix the flaky build is waiting for you",
    });
    expect(within(approval).getByText("Run: bun run test")).toBeInTheDocument();
    expect(within(approval).getByText("octant")).toBeInTheDocument();
    expect(within(approval).getByText("Waiting 4m")).toBeInTheDocument();
    expect(within(approval).getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(within(approval).getByRole("button", { name: "Deny" })).toBeInTheDocument();
    expect(approval.querySelector(".provider-glyph")).not.toBeNull();

    const question = within(card).getByRole("group", {
      name: "Pick a database is waiting for you",
    });
    expect(
      within(question).getByText("Which database should the service use?"),
    ).toBeInTheDocument();
    expect(within(question).getByRole("button", { name: "SQLite" })).toBeInTheDocument();
    expect(within(question).getByRole("button", { name: "Postgres" })).toBeInTheDocument();
    expect(within(question).getByRole("button", { name: "Reply…" })).toBeInTheDocument();
    // No provider is known for this thread, so the row draws its mode's glyph.
    expect(question.querySelector(".provider-glyph")).toBeNull();
    expect(question.querySelector(".pending-request__mark")).not.toBeNull();

    // A question with no choices offers Reply… alone, and no project name.
    const typed = within(card).getByRole("group", { name: "Trip ideas is waiting for you" });
    expect(
      within(typed)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Trip ideas", "Reply…"]);
    expect(within(card).getByText("4")).toBeInTheDocument();
    // Oldest waiting first.
    expect(
      within(card)
        .getAllByRole("group")
        .map((row) => row.getAttribute("aria-label")),
    ).toEqual([
      "Pick a database is waiting for you",
      "Fix the flaky build is waiting for you",
      "Quarterly notes is waiting for you",
      "Trip ideas is waiting for you",
    ]);
  });

  it("answers a Code approval and a Work approval through their own commands with the listed handle", async () => {
    const user = userEvent.setup();
    const answerClients = clients();
    renderCard(
      createNeedsYouCard(
        source({
          answerClients: answerClients as never,
          pendingRequestClient: reader([codeApproval, workApproval]),
        }),
      ),
    );
    const card = await findCard();
    await user.click(
      within(
        await within(card).findByRole("group", { name: "Fix the flaky build is waiting for you" }),
      ).getByRole("button", { name: "Approve" }),
    );
    expect(answerClients.codeClient.executeOperation).toHaveBeenCalledExactlyOnceWith({
      kind: "answer-provider-approval",
      operationId: expect.any(String),
      threadId: "code-thread",
      checkoutId: "checkout-1",
      approvalId: "approval-1",
      decision: "approved",
    });

    await user.click(
      within(
        within(card).getByRole("group", { name: "Quarterly notes is waiting for you" }),
      ).getByRole("button", { name: "Deny" }),
    );
    expect(answerClients.workRequestClient.execute).toHaveBeenCalledExactlyOnceWith({
      kind: "resolve-work-request",
      requestId: "work-request-1",
      expectedVersion: 7,
      resolution: { kind: "approval", approved: false },
    });
  });

  it("answers a Code question with a numbered choice and keeps the response as evidence first", async () => {
    const user = userEvent.setup();
    const answerClients = clients();
    renderCard(
      createNeedsYouCard(
        source({
          answerClients: answerClients as never,
          pendingRequestClient: reader([codeQuestion]),
        }),
      ),
    );
    await user.click(await screen.findByRole("button", { name: "Postgres" }));
    expect(answerClients.codeClient.putEvidence).toHaveBeenCalledExactlyOnceWith(
      "code-question-thread",
      "Postgres",
    );
    expect(answerClients.codeClient.executeOperation).toHaveBeenCalledExactlyOnceWith({
      kind: "answer-provider-input",
      operationId: expect.any(String),
      threadId: "code-question-thread",
      checkoutId: "checkout-2",
      requestId: "input-1",
      response: { evidenceId: "evidence-1" },
    });
  });

  it("picks a choice with its number key while the row has focus", async () => {
    const user = userEvent.setup();
    const answerClients = clients();
    renderCard(
      createNeedsYouCard(
        source({
          answerClients: answerClients as never,
          pendingRequestClient: reader([chatChoice]),
        }),
      ),
    );
    const blue = await screen.findByRole("button", { name: "Blue" });
    blue.focus();
    await user.keyboard("3");
    expect(answerClients.chatClient.execute).not.toHaveBeenCalled();
    await user.keyboard("1");
    expect(answerClients.chatClient.execute).toHaveBeenCalledExactlyOnceWith({
      kind: "answer-chat-turn-question",
      threadId: "chat-choice-thread",
      expectedVersion: 3,
      turnId: "turn-1",
      attemptId: "attempt-1",
      requestId: "question-1",
      answer: "Red",
    });
  });

  it("opens the thread from its title and from Reply…", async () => {
    const user = userEvent.setup();
    const onOpenThread = vi.fn();
    renderCard(
      createNeedsYouCard(
        source({ onOpenThread, pendingRequestClient: reader([chatQuestion, workApproval]) }),
      ),
    );
    const card = await findCard();
    await user.click(await within(card).findByRole("button", { name: "Trip ideas" }));
    await user.click(within(card).getByRole("button", { name: "Reply…" }));
    expect(onOpenThread).toHaveBeenCalledTimes(2);
    expect(onOpenThread).toHaveBeenNthCalledWith(1, chatQuestion);
    expect(onOpenThread).toHaveBeenNthCalledWith(2, chatQuestion);
  });

  it("drops an answered row on the next read", async () => {
    const user = userEvent.setup();
    const client = reader([codeApproval, workApproval], [workApproval]);
    renderCard(createNeedsYouCard(source({ pendingRequestClient: client })));
    const card = await findCard();
    await user.click(
      within(
        await within(card).findByRole("group", { name: "Fix the flaky build is waiting for you" }),
      ).getByRole("button", { name: "Approve" }),
    );
    await waitFor(() =>
      expect(
        within(card).queryByRole("group", { name: "Fix the flaky build is waiting for you" }),
      ).toBeNull(),
    );
    expect(
      within(card).getByRole("group", { name: "Quarterly notes is waiting for you" }),
    ).toBeVisible();
  });

  it("says once that a refused answer was not delivered, keeps the row while it is listed, and re-reads", async () => {
    const user = userEvent.setup();
    const answerClients = clients();
    answerClients.workRequestClient.execute.mockRejectedValueOnce(new Error("stale"));
    const client = reader([workApproval]);
    renderCard(
      createNeedsYouCard(
        source({ answerClients: answerClients as never, pendingRequestClient: client }),
      ),
    );
    const row = await screen.findByRole("group", { name: "Quarterly notes is waiting for you" });
    await user.click(within(row).getByRole("button", { name: "Approve" }));
    expect(await within(row).findByRole("status")).toHaveTextContent(
      "The answer was not delivered. The request may have changed.",
    );
    await waitFor(() => expect(client.list).toHaveBeenCalledTimes(2));
    expect(within(row).getByRole("button", { name: "Approve" })).toBeEnabled();
  });

  it("says why a Code approval the turn refuses was not delivered and offers it again", async () => {
    const user = userEvent.setup();
    const answerClients = clients();
    // The runtime refuses an answer it cannot hand the provider (Plan posture,
    // changed permission persistence, a lost connection) as a failed turn
    // state, not as operation-failed.
    answerClients.codeClient.executeOperation.mockResolvedValueOnce({
      kind: "provider-turn-state",
      operationId: "operation-1",
      state: "failed",
    } as never);
    const client = reader([codeApproval]);
    renderCard(
      createNeedsYouCard(
        source({ answerClients: answerClients as never, pendingRequestClient: client }),
      ),
    );
    const row = await screen.findByRole("group", {
      name: "Fix the flaky build is waiting for you",
    });
    await user.click(within(row).getByRole("button", { name: "Approve" }));
    expect(await within(row).findByRole("status")).toHaveTextContent(
      "The answer was not delivered. The turn changed since it asked.",
    );
    await waitFor(() => expect(client.list).toHaveBeenCalledTimes(2));
    expect(within(row).getByRole("button", { name: "Approve" })).toBeEnabled();
  });

  it("says a Code question's turn ended when the answer finds it interrupted", async () => {
    const user = userEvent.setup();
    const answerClients = clients();
    answerClients.codeClient.executeOperation.mockResolvedValueOnce({
      kind: "provider-turn-state",
      operationId: "operation-1",
      state: "interrupted",
    } as never);
    renderCard(
      createNeedsYouCard(
        source({
          answerClients: answerClients as never,
          pendingRequestClient: reader([codeQuestion]),
        }),
      ),
    );
    const row = await screen.findByRole("group", { name: "Pick a database is waiting for you" });
    await user.click(within(row).getByRole("button", { name: /SQLite/ }));
    expect(await within(row).findByRole("status")).toHaveTextContent(
      "The turn that asked has ended. Send a new message to continue.",
    );
  });

  it("keeps a refused row's line for one more read when the host no longer lists the request", async () => {
    const user = userEvent.setup();
    const answerClients = clients();
    answerClients.codeClient.executeOperation.mockResolvedValueOnce({
      kind: "operation-failed",
    } as never);
    const client = reader([codeApproval], []);
    const view = renderCard(
      createNeedsYouCard(
        source({ answerClients: answerClients as never, pendingRequestClient: client }),
      ),
    );
    const row = await screen.findByRole("group", {
      name: "Fix the flaky build is waiting for you",
    });
    await user.click(within(row).getByRole("button", { name: "Approve" }));
    // The row is gone from the host's list, yet its refusal line is still readable.
    expect(await within(row).findByRole("status")).toBeVisible();
    await waitFor(() => expect(client.list).toHaveBeenCalledTimes(2));
    expect(within(row).queryByRole("button", { name: "Approve" })).toBeNull();
    expect(row).toBeVisible();
    view.unmount();
  });

  it("shows five rows, counts them all, and opens the Inbox from +N more", async () => {
    const user = userEvent.setup();
    const onOpenInbox = vi.fn();
    const many = [1, 2, 3, 4, 5, 6, 7].map(
      (index) =>
        ({
          ...workApproval,
          threadId: `work-${String(index)}`,
          threadTitle: `Task ${String(index)}`,
          requestedAt: at(20 - index),
          answer: { requestId: `request-${String(index)}`, expectedVersion: 1 },
        }) as unknown as PendingRequest,
    );
    renderCard(createNeedsYouCard(source({ onOpenInbox, pendingRequestClient: reader(many) })));
    const card = await findCard();
    await within(card).findByText("Task 1");
    expect(within(card).getAllByRole("listitem")).toHaveLength(5);
    expect(within(card).getByText("7")).toBeInTheDocument();
    expect(within(card).queryByText("Task 6")).toBeNull();
    await user.click(within(card).getByRole("button", { name: "+2 more" }));
    expect(onOpenInbox).toHaveBeenCalledTimes(1);
  });

  it("speaks only for its own modes", async () => {
    renderCard(
      createNeedsYouCard(
        source({
          modes: ["code"],
          pendingRequestClient: reader([codeApproval, workApproval, chatQuestion]),
        }),
      ),
    );
    const card = await findCard();
    await within(card).findByText("Fix the flaky build");
    expect(within(card).queryByText("Quarterly notes")).toBeNull();
    expect(within(card).queryByText("Trip ideas")).toBeNull();
  });

  it("re-reads when the change feed moves, and not otherwise", async () => {
    const client = reader([codeApproval], []);
    const first = source({ pendingRequestClient: client });
    const view = renderCard(createNeedsYouCard(first));
    await screen.findByText("Fix the flaky build");
    expect(client.list).toHaveBeenCalledTimes(1);
    view.rerender(
      <HomeDashboard
        cards={[createNeedsYouCard({ ...first, now: NOW + 60_000 })]}
        customization={{ order: [], visibility: [] }}
        onCustomizationChange={vi.fn()}
      />,
    );
    expect(client.list).toHaveBeenCalledTimes(1);
    view.rerender(
      <HomeDashboard
        cards={[createNeedsYouCard({ ...first, feedRevision: 1 })]}
        customization={{ order: [], visibility: [] }}
        onCustomizationChange={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.queryByText("Fix the flaky build")).toBeNull());
    expect(client.list).toHaveBeenCalledTimes(2);
  });

  it("folds change-feed signals that arrive during a read into one more read", async () => {
    const resolvers: Array<() => void> = [];
    const client: PendingRequestClient = {
      list: vi.fn(
        () =>
          new Promise<PendingRequestList>((resolve) => {
            resolvers.push(() => resolve({ requests: [codeApproval], truncated: false }));
          }),
      ),
    };
    const first = source({ pendingRequestClient: client });
    const view = renderCard(createNeedsYouCard(first));
    await waitFor(() => expect(client.list).toHaveBeenCalledTimes(1));
    // A streaming reply moves the navigation topic on every delta.
    for (const feedRevision of [1, 2, 3, 4]) {
      view.rerender(
        <HomeDashboard
          cards={[createNeedsYouCard({ ...first, feedRevision })]}
          customization={{ order: [], visibility: [] }}
          onCustomizationChange={vi.fn()}
        />,
      );
    }
    expect(client.list).toHaveBeenCalledTimes(1);
    resolvers[0]?.();
    await waitFor(() => expect(client.list).toHaveBeenCalledTimes(2));
    resolvers[1]?.();
    await screen.findByText("Fix the flaky build");
    expect(client.list).toHaveBeenCalledTimes(2);
  });

  it("leaves the grid while nothing is waiting", async () => {
    renderCard(createNeedsYouCard(source({ pendingRequestClient: reader([]) })));
    await screen.findByRole("region", { name: "Home cards" });
    // Not even a loading line first: it would flash on every start screen.
    expect(screen.queryByText("Looking…")).toBeNull();
    await waitFor(() => expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull());
    expect(screen.queryByText("Nothing is waiting for you.")).toBeNull();
  });

  it("is unavailable without a client and reads nothing", async () => {
    const card = createNeedsYouCard(source({ pendingRequestClient: undefined }));
    expect(card.available).toBe(false);
    renderCard(card);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Home cards" })).toBeNull());
  });

  it("is on by default and drops out of the grid when empty", () => {
    const card = createNeedsYouCard(source());
    expect(card).toMatchObject({ id: "needs-you", defaultOn: true, hideWhenEmpty: true });
  });
});
