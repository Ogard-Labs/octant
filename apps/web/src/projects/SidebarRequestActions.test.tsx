import type { PendingRequestClient } from "@octant/client-runtime/pending-request-client";
import type { PendingRequest } from "@octant/contracts/pending-requests";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  answerClients,
  BOARD_NOW,
  codeRequest,
  pendingReader,
  workRequest,
} from "../threadBoard/boardPendingRequests.test-fixtures";
import { DEFAULT_SIDEBAR_ROW_PROPERTIES } from "@octant/contracts/shell";
import type { ChatThreadNavigationItem } from "../shell/navigationModel";
import { useMemo } from "react";
import { usePendingRequests } from "../pendingRequests/usePendingRequests";
import { ProjectSidebarSection } from "./ProjectSidebarSection";
import {
  SidebarPendingRequestsProvider,
  type SidebarPendingRequestSource,
} from "./sidebarPendingRequests";

const waiting: ChatThreadNavigationItem = {
  threadId: "thread-waiting",
  title: "Rotate the dev API keys",
  activity: "attention",
  updatedAt: new Date(BOARD_NOW - 2 * 60_000).toISOString(),
};

const approval = codeRequest({
  threadId: "thread-waiting",
  threadTitle: "Rotate the dev API keys",
  kind: "approval",
  text: "Wants to set a repository secret",
  minutesAgo: 2,
});

/**
 * The window around the sidebar, as the shell wires it: one pending-request
 * read that follows the Work, Code and tool-approval signals, lent to the
 * sidebar, and the Chat navigation revision the sidebar may follow itself.
 */
interface HostWindow {
  readonly reader: PendingRequestClient;
  readonly clients: ReturnType<typeof answerClients>;
  /** The Work, Code and tool-approval signals the window's read follows. */
  readonly feedRevision: number;
  readonly chatRevision: number;
}

function source(
  requests: ReadonlyArray<PendingRequest>,
  clients = answerClients(),
  feedRevision = 0,
  chatRevision = 0,
): HostWindow {
  return { reader: pendingReader(requests), clients, feedRevision, chatRevision };
}

function Sidebar(props: {
  readonly source?: HostWindow;
  readonly activeThreadId?: string;
  readonly openThreadIds?: ReadonlyArray<string>;
  /** The threads whose panes are on screen; defaults to every open one. */
  readonly shownThreadIds?: ReadonlyArray<string>;
  readonly onSelectThread?: (threadId: string) => void;
  readonly thread?: ChatThreadNavigationItem;
  /** The row properties the person chose for the Activity and Status views. */
  readonly activityRowProperties?: typeof DEFAULT_SIDEBAR_ROW_PROPERTIES.activity;
}) {
  const host = props.source;
  const shared = usePendingRequests(host?.reader, {
    feedRevision: host?.feedRevision ?? 0,
    settings: undefined,
    workspace: undefined,
  });
  const lent = useMemo(
    (): SidebarPendingRequestSource | undefined =>
      host === undefined
        ? undefined
        : {
            answerClients: host.clients as never,
            chatRevision: host.chatRevision,
            now: BOARD_NOW,
            shared,
          },
    [host, shared],
  );
  return (
    <SidebarPendingRequestsProvider
      shownThreadIds={props.shownThreadIds ?? props.openThreadIds ?? []}
      source={lent}
    >
      <ProjectSidebarSection
        {...(props.activeThreadId === undefined ? {} : { activeThreadId: props.activeThreadId })}
        {...(props.openThreadIds === undefined ? {} : { openThreadIds: props.openThreadIds })}
        archivedProjects={[]}
        availabilityByProject={new Map()}
        now={new Date(BOARD_NOW)}
        onArchive={vi.fn()}
        onMove={vi.fn()}
        onProjectOpen={vi.fn()}
        onReorder={vi.fn()}
        onRestore={vi.fn()}
        onSelectThread={props.onSelectThread ?? vi.fn()}
        projects={[]}
        {...(props.activityRowProperties === undefined
          ? {}
          : {
              rowProperties: {
                ...DEFAULT_SIDEBAR_ROW_PROPERTIES,
                activity: props.activityRowProperties,
              },
            })}
        threadActions={{ onPinThread: vi.fn(), onArchiveThread: vi.fn() }}
        threads={[props.thread ?? waiting]}
      />
    </SidebarPendingRequestsProvider>
  );
}

const answers = () => screen.queryByRole("group", { name: "Answer Rotate the dev API keys" });

/** The row's answers once the first read has listed the approval. */
async function answersOnceRead(): Promise<HTMLElement> {
  await screen.findByRole("button", { name: "Allow once" });
  return screen.getByRole("group", { name: "Answer Rotate the dev API keys" });
}

describe("answering a Needs-you row from the sidebar", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useFakeTimers({ toFake: ["Date"], now: BOARD_NOW });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("offers Allow once, Deny and Open after the row and its own actions, in that keyboard order, with what it asks on the row", async () => {
    const user = userEvent.setup();
    render(<Sidebar source={source([approval])} />);
    const group = await answersOnceRead();
    const row = screen.getByRole("button", { name: /^Rotate the dev API keys/ });
    expect(row).toHaveTextContent("Wants to set a repository secret");
    row.focus();
    // The row's own hover actions (pin, archive) come first, as on every row.
    const rowActions = row
      .closest(".sidebar-navigation__thread-row")
      ?.querySelectorAll(".sidebar-navigation__thread-actions button");
    expect(rowActions?.length).toBeGreaterThan(0);
    for (const _ of rowActions ?? []) await user.tab();
    await user.tab();
    expect(within(group).getByRole("button", { name: "Allow once" })).toHaveFocus();
    await user.tab();
    expect(within(group).getByRole("button", { name: "Deny" })).toHaveFocus();
    await user.tab();
    expect(within(group).getByRole("button", { name: "Open" })).toHaveFocus();
  });

  it("allows once through the same answer command the thread's approval card sends", async () => {
    const user = userEvent.setup();
    const clients = answerClients();
    render(<Sidebar source={source([approval], clients)} />);
    const group = await answersOnceRead();
    await user.click(within(group).getByRole("button", { name: "Allow once" }));
    expect(clients.codeClient.executeOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "answer-provider-approval",
        approvalId: "approval-thread-waiting",
        decision: "approved",
      }),
    );
  });

  it("denies through the same answer command, and shows the host's refusal in one quiet line", async () => {
    const user = userEvent.setup();
    const clients = answerClients();
    clients.codeClient.executeOperation.mockResolvedValue({
      kind: "operation-failed",
      failure: { message: "The approval was already answered." },
    } as never);
    render(<Sidebar source={source([approval], clients)} />);
    const group = await answersOnceRead();
    await user.click(within(group).getByRole("button", { name: "Deny" }));
    expect(clients.codeClient.executeOperation).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "answer-provider-approval", decision: "denied" }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "The approval was already answered.",
    );
  });

  it("opens the thread from Open, as the row itself does", async () => {
    const user = userEvent.setup();
    const onSelectThread = vi.fn();
    render(<Sidebar onSelectThread={onSelectThread} source={source([approval])} />);
    const group = await answersOnceRead();
    await user.click(within(group).getByRole("button", { name: "Open" }));
    expect(onSelectThread).toHaveBeenCalledWith("thread-waiting");
  });

  it("says how long the thread has waited in the row's name", async () => {
    render(<Sidebar source={source([approval])} />);
    await answersOnceRead();
    expect(
      screen.getByRole("button", { name: /^Rotate the dev API keys/ }).getAttribute("aria-label"),
    ).toContain("Needs attention, 2 minutes");
  });

  it("offers only Open, with what it asks, when the thread asks to enter or leave Plan or its host does not say the approval is one tool call", async () => {
    const enterPlan = codeRequest({
      threadId: "thread-waiting",
      threadTitle: "Rotate the dev API keys",
      kind: "approval",
      text: "Claude asks to plan first.",
      minutesAgo: 2,
      approves: "level-change",
    });
    const leavePlan = workRequest({
      threadId: "thread-waiting",
      threadTitle: "Rotate the dev API keys",
      kind: "approval",
      text: "Claude asks to leave Plan and carry out its plan.",
      minutesAgo: 2,
      approves: "level-change",
    });
    const unnamed = { ...approval, approves: undefined } as unknown as PendingRequest;
    for (const request of [enterPlan, leavePlan, unnamed]) {
      const clients = answerClients();
      const { unmount } = render(<Sidebar source={source([request], clients)} />);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /^Rotate the dev API keys/ })).toHaveTextContent(
          request.text,
        ),
      );
      expect(
        within(answers() as HTMLElement)
          .getAllByRole("button")
          .map((button) => button.textContent),
      ).toEqual(["Open"]);
      expect(clients.codeClient.executeOperation).not.toHaveBeenCalled();
      expect(clients.workRequestClient.execute).not.toHaveBeenCalled();
      unmount();
    }
  });

  it("still answers from a Needs-you row when the person hides the Status row property", async () => {
    const user = userEvent.setup();
    const clients = answerClients();
    render(
      <Sidebar
        activityRowProperties={{ ...DEFAULT_SIDEBAR_ROW_PROPERTIES.activity, status: false }}
        source={source([approval], clients)}
      />,
    );
    const group = await answersOnceRead();
    expect(screen.getByRole("button", { name: /^Rotate the dev API keys/ })).toHaveTextContent(
      "Wants to set a repository secret",
    );
    await user.click(within(group).getByRole("button", { name: "Allow once" }));
    expect(clients.codeClient.executeOperation).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "answer-provider-approval", decision: "approved" }),
    );
  });

  it("offers Allow once on the row of a thread whose pane sits behind Board", async () => {
    // Board covers the workspace: the waiting thread stays in a pane, so it
    // is still open, but its approval card is not on screen.
    render(
      <Sidebar
        openThreadIds={["thread-waiting"]}
        shownThreadIds={[]}
        source={source([approval])}
      />,
    );
    const group = await answersOnceRead();
    expect(within(group).getByRole("button", { name: "Deny" })).toBeInTheDocument();
  });

  it("reads once for a row that can only open its thread, and follows Chat only while a row offers answers", async () => {
    const question = codeRequest({
      threadId: "thread-waiting",
      threadTitle: "Rotate the dev API keys",
      kind: "question",
      text: "Which key should go first?",
      minutesAgo: 1,
      options: [{ label: "Staging" }],
    });
    const clients = answerClients();
    const reader = pendingReader([question]);
    const at = (chatRevision: number) => ({
      ...source([], clients, 0, chatRevision),
      reader,
    });
    const { rerender } = render(<Sidebar source={at(0)} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Rotate the dev API keys/ })).toHaveTextContent(
        "Which key should go first?",
      ),
    );
    expect(reader.list).toHaveBeenCalledOnce();
    rerender(<Sidebar source={at(1)} />);
    rerender(<Sidebar source={at(2)} />);
    await Promise.resolve();
    expect(reader.list).toHaveBeenCalledOnce();
    // The thread moved while it waits, so what it asks may have changed.
    const moved = { ...waiting, updatedAt: new Date(BOARD_NOW - 60_000).toISOString() };
    rerender(<Sidebar source={at(2)} thread={moved} />);
    await waitFor(() => expect(reader.list).toHaveBeenCalledTimes(2));

    const following = pendingReader([approval]);
    const answering = (chatRevision: number) => ({
      ...source([], clients, 0, chatRevision),
      reader: following,
    });
    rerender(<Sidebar source={answering(0)} />);
    await answersOnceRead();
    const reads = vi.mocked(following.list).mock.calls.length;
    rerender(<Sidebar source={answering(1)} />);
    await waitFor(() => expect(following.list).toHaveBeenCalledTimes(reads + 1));
  });

  it("makes one read for one Code navigation change, shared with the window's own read, while a row offers answers", async () => {
    const clients = answerClients();
    const reader = pendingReader([approval]);
    const at = (feedRevision: number) => ({ ...source([], clients, feedRevision), reader });
    const { rerender } = render(<Sidebar source={at(0)} />);
    await answersOnceRead();
    const reads = vi.mocked(reader.list).mock.calls.length;
    rerender(<Sidebar source={at(1)} />);
    await waitFor(() => expect(reader.list).toHaveBeenCalledTimes(reads + 1));
    // Let any second read the sidebar might have queued start and land.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reader.list).toHaveBeenCalledTimes(reads + 1);
    expect(
      within(answers() as HTMLElement).getByRole("button", { name: "Allow once" }),
    ).toBeEnabled();
  });

  it("offers nothing on the row of a thread the window already shows, and adds no read to the window's own", async () => {
    const shown = source([approval]);
    const { rerender } = render(
      <Sidebar
        activeThreadId="thread-waiting"
        shownThreadIds={["thread-waiting"]}
        source={shown}
      />,
    );
    await waitFor(() => expect(screen.getByTitle("Needs you")).toBeInTheDocument());
    expect(answers()).toBeNull();
    rerender(<Sidebar openThreadIds={["thread-waiting"]} source={shown} />);
    expect(answers()).toBeNull();
    await Promise.resolve();
    expect(shown.reader.list).toHaveBeenCalledOnce();
  });

  it("offers only Open without a reader, and when the thread waits on a question or on two requests", async () => {
    const { unmount } = render(<Sidebar />);
    const group = screen.getByRole("group", { name: "Answer Rotate the dev API keys" });
    expect(
      within(group)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Open"]);
    unmount();

    const question = codeRequest({
      threadId: "thread-waiting",
      threadTitle: "Rotate the dev API keys",
      kind: "question",
      text: "Which key should go first?",
      minutesAgo: 1,
      options: [{ label: "Staging" }],
    });
    for (const requests of [[question], [approval, { ...question, kind: "approval" }]]) {
      const { unmount: next } = render(<Sidebar source={source(requests as never)} />);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /^Rotate the dev API keys/ })).toHaveTextContent(
          /Which key should go first\?|Wants to set a repository secret/,
        ),
      );
      expect(
        within(answers() as HTMLElement)
          .getAllByRole("button")
          .map((button) => button.textContent),
      ).toEqual(["Open"]);
      next();
    }
  });
});
