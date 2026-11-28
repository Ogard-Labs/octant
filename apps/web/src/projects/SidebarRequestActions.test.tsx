import type { PendingRequest } from "@octant/contracts/pending-requests";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  answerClients,
  BOARD_NOW,
  codeRequest,
  pendingReader,
} from "../threadBoard/boardPendingRequests.test-fixtures";
import type { ChatThreadNavigationItem } from "../shell/navigationModel";
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

function source(
  requests: ReadonlyArray<PendingRequest>,
  clients = answerClients(),
): SidebarPendingRequestSource {
  return {
    answerClients: clients as never,
    feedRevision: 0,
    now: BOARD_NOW,
    pendingRequestClient: pendingReader(requests),
    settings: undefined,
    workspace: undefined,
  };
}

function Sidebar(props: {
  readonly source?: SidebarPendingRequestSource;
  readonly activeThreadId?: string;
  readonly openThreadIds?: ReadonlyArray<string>;
  readonly onSelectThread?: (threadId: string) => void;
}) {
  return (
    <SidebarPendingRequestsProvider source={props.source}>
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
        threadActions={{ onPinThread: vi.fn(), onArchiveThread: vi.fn() }}
        threads={[waiting]}
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

  it("offers nothing on the row of a thread the window already shows, and reads nothing for it", async () => {
    const shown = source([approval]);
    const { rerender } = render(<Sidebar activeThreadId="thread-waiting" source={shown} />);
    await waitFor(() => expect(screen.getByTitle("Needs you")).toBeInTheDocument());
    expect(answers()).toBeNull();
    rerender(<Sidebar openThreadIds={["thread-waiting"]} source={shown} />);
    expect(answers()).toBeNull();
    expect(shown.pendingRequestClient?.list).not.toHaveBeenCalled();
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
