import { render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ChatThreadNavigationItem } from "../shell/navigationModel";
import { ThreadReferenceChip, type ThreadReferenceChipProps } from "./ThreadReferenceChip";
import { listsOf } from "./threadReferenceLists.test-support";
import { ThreadReferencesContext, useThreadReferenceLists } from "./ThreadReferences";
import { useThreadReferences } from "./useThreadReferences";

const thread: ChatThreadNavigationItem = {
  threadId: "thread-1",
  title: "Investigate stalled issues",
  projectId: "project-1",
  activity: "working",
  turnStartedAt: new Date(Date.now() - 14 * 60_000).toISOString(),
  liveStep: { kind: "tool", tool: "Running tests" },
  checkoutChip: { checkoutKind: "managed-worktree", label: "feature/stalled" },
  provider: { displayName: "Claude", driverKind: "claude" },
  modelId: "claude-opus-5-5",
};

function renderChip(props: Partial<ThreadReferenceChipProps> = {}, listed = true) {
  const onOpen = vi.fn();
  render(
    <ThreadReferencesContext.Provider value={listsOf({ code: listed ? [thread] : [] }, onOpen)}>
      <ThreadReferenceChip
        access="Read-only"
        threadId="thread-1"
        title="Investigate stalled issues"
        {...props}
      />
    </ThreadReferencesContext.Provider>,
  );
  return onOpen;
}

describe("ThreadReferenceChip", () => {
  it("names the thread, its place, its live state and what the agent may do", () => {
    renderChip();
    expect(
      screen.getByRole("button", {
        name: "Thread: Investigate stalled issues, Code, octant, Working 14m, Read-only",
      }),
    ).toBeVisible();
  });

  it("shows the thread's card on hover and opens the thread from it", async () => {
    const user = userEvent.setup();
    const onOpen = renderChip({ receipt: "This turn reads it." });

    await user.hover(screen.getByRole("button", { name: /^Thread:/ }));

    const card = await screen.findByRole("dialog", { name: "Thread details" });
    expect(card).toHaveTextContent("Working 14m · Running tests");
    expect(card).toHaveTextContent("octant");
    expect(card).toHaveTextContent("feature/stalled");
    expect(card).toHaveTextContent("Claude · Opus 5.5");
    expect(card).toHaveTextContent("This turn reads it.");
    expect(card.querySelector(".project-mark, .project-icon")).not.toBeNull();
    expect(card.querySelector('[data-driver-kind="claude"]')).not.toBeNull();

    await user.click(within(card).getByRole("button", { name: "Open thread" }));
    expect(onOpen).toHaveBeenCalledWith({
      threadId: "thread-1",
      title: "Investigate stalled issues",
      mode: "code",
      projectId: "project-1",
    });
  });

  it("opens the card from the keyboard with its actions in reach", async () => {
    const user = userEvent.setup();
    renderChip();

    await user.tab();
    await user.keyboard("{Enter}");

    const card = await screen.findByRole("dialog", { name: "Thread details" });
    await waitFor(() =>
      expect(within(card).getByRole("button", { name: "Open thread" })).toHaveFocus(),
    );
  });

  it("says only what the host said of a thread this window does not list, and cannot open it", async () => {
    const user = userEvent.setup();
    renderChip({ threadId: "elsewhere", fallback: { mode: "work", placement: "Launch" } });

    await user.click(screen.getByRole("button", { name: /Work, Launch/ }));

    const card = await screen.findByRole("dialog", { name: "Thread details" });
    expect(card).toHaveTextContent("Work · Launch");
    expect(within(card).queryByRole("button", { name: "Open thread" })).not.toBeInTheDocument();
  });

  it("shows no thread fact for a thread the host refused, even one the window lists", async () => {
    const user = userEvent.setup();
    renderChip({ unavailableReason: "you cannot open this thread" });

    await user.click(
      screen.getByRole("button", {
        name: "Thread: Investigate stalled issues, Unavailable: you cannot open this thread",
      }),
    );

    const card = await screen.findByRole("dialog", { name: "Thread details" });
    expect(card).toHaveTextContent("Unavailable: you cannot open this thread.");
    expect(card).not.toHaveTextContent("octant");
    expect(within(card).queryByRole("button", { name: "Open thread" })).not.toBeInTheDocument();
  });
});

describe("a name in a sentence", () => {
  it("is the name alone for a thread this window does not list", () => {
    renderChip({ look: "link" }, false);
    expect(screen.getByText("Investigate stalled issues")).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("useThreadReferences", () => {
  it("finds each listed thread with its mode, Project and fork parent, and opens it there", () => {
    const onOpen = vi.fn();
    const lists = listsOf(
      {
        chat: [{ threadId: "chat-1", title: "Notes" }],
        code: [thread, { threadId: "fork-1", title: "Fork", lineageParentThreadId: "thread-1" }],
      },
      onOpen,
    );
    const { result } = renderHook(() => useThreadReferences(), {
      wrapper: ({ children }) => (
        <ThreadReferencesContext.Provider value={lists}>
          {children}
        </ThreadReferencesContext.Provider>
      ),
    });

    expect(result.current.find("chat-1")).toEqual({
      mode: "chat",
      thread: { threadId: "chat-1", title: "Notes" },
    });
    expect(result.current.find("fork-1")?.lineageParentTitle).toBe("Investigate stalled issues");
    expect(result.current.find("missing")).toBeUndefined();
    expect(result.current.find("thread-1")?.projectName).toBe("octant");
  });

  it("keeps its lists while only the open handler changes, and opens with the latest", () => {
    const first = vi.fn();
    const latest = vi.fn();
    const { chat, work, code, withProviderMark, projects } = listsOf({ code: [thread] });
    const { result, rerender } = renderHook(
      ({ onOpen }) =>
        useThreadReferenceLists({ chat, work, code, withProviderMark, projects, onOpen }),
      { initialProps: { onOpen: first } },
    );
    const before = result.current;
    rerender({ onOpen: latest });
    expect(result.current).toBe(before);
    before.onOpen({ threadId: "thread-1", title: "T", mode: "code" });
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledOnce();
  });
});
