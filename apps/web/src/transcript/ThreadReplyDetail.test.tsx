import type { ReplyDetailLevel, ReplyDetailReading } from "@octant/contracts/shell";
import { withThreadReplyDetail } from "@octant/domain/reply-detail-policy";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { AssistantMessageBody, StreamRepliesContext } from "./AssistantMessageBody";
import { ReplyDetailSourceContext, type ReplyDetailThread } from "./replyDetail";
import { ThreadReplyDetailMenu, ThreadReplyDetailScope } from "./ThreadReplyDetail";
import { TurnActivityRows } from "./TurnActivityRows";
import type { TurnActivity } from "./turnActivity";

const settledTurn: TurnActivity = {
  reasoning: "Check the suite.",
  rows: [{ kind: "tool", id: "call-1", toolName: "Bash", state: "completed", summary: "exit 0" }],
};

function disclosure(name: string): HTMLDetailsElement {
  const details = screen.getByRole("button", { name }).closest("details");
  if (!(details instanceof HTMLDetailsElement)) throw new Error(`No disclosure named ${name}`);
  return details;
}

/** An inline part of a reply: its summary is named by its text, not a button role. */
function inlinePart(name: string): HTMLDetailsElement {
  const details = screen.getByText(name).closest("details");
  if (!(details instanceof HTMLDetailsElement)) throw new Error(`No part named ${name}`);
  return details;
}

/** Two threads under one host's reading, the way a window holds them. */
function TwoThreads(props: {
  readonly reading: ReplyDetailReading;
  readonly onSet?: (thread: ReplyDetailThread, level: ReplyDetailLevel | undefined) => void;
}) {
  const thread = (threadId: string) => (
    <section aria-label={threadId}>
      <ThreadReplyDetailScope thread={{ mode: "work", threadId }}>
        <ThreadReplyDetailMenu />
        <TurnActivityRows activity={settledTurn} running={false} settled />
      </ThreadReplyDetailScope>
    </section>
  );
  return (
    <ReplyDetailSourceContext.Provider
      value={{
        reading: props.reading,
        ...(props.onSet === undefined ? {} : { setThreadLevel: props.onSet }),
      }}
    >
      {thread("chose-high")}
      {thread("follows-default")}
    </ReplyDetailSourceContext.Provider>
  );
}

function foldOpen(threadId: string): boolean {
  const section = screen.getByRole("region", { name: threadId });
  const fold = section.querySelector(".turn-activity__disclosure--toolchain");
  if (!(fold instanceof HTMLDetailsElement)) throw new Error("No fold");
  return fold.open;
}

describe("a thread's own Reply detail level", () => {
  const chose = withThreadReplyDetail([], { mode: "work", threadId: "chose-high" }, "high");

  it("wins over the default, and a thread that never chose follows the default", () => {
    const view = render(<TwoThreads reading={{ defaultLevel: "low", threads: chose }} />);
    expect(foldOpen("chose-high")).toBe(true);
    expect(foldOpen("follows-default")).toBe(false);

    // Changing the default moves only the thread that follows it.
    view.rerender(<TwoThreads reading={{ defaultLevel: "medium", threads: chose }} />);
    expect(foldOpen("chose-high")).toBe(true);
    expect(foldOpen("follows-default")).toBe(true);
    view.rerender(<TwoThreads reading={{ defaultLevel: "low", threads: chose }} />);
    expect(foldOpen("chose-high")).toBe(true);
    expect(foldOpen("follows-default")).toBe(false);
  });

  it("names the level in effect on the thread's menu and offers to use the default again", async () => {
    const user = userEvent.setup();
    const onSet = vi.fn();
    render(<TwoThreads onSet={onSet} reading={{ defaultLevel: "low", threads: chose }} />);

    expect(
      screen.getByRole("button", { name: "Reply detail: Low, the default" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reply detail: High, this thread's own" }));
    expect(await screen.findByRole("menuitemradio", { name: "High" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await user.click(await screen.findByRole("menuitemradio", { name: "Use default (Low)" }));
    expect(onSet).toHaveBeenCalledWith({ mode: "work", threadId: "chose-high" }, undefined);
  });

  it("sets the thread's own level from its menu", async () => {
    const user = userEvent.setup();
    function Host() {
      const [threads, setThreads] = useState<ReplyDetailReading["threads"]>([]);
      return (
        <TwoThreads
          onSet={(thread, level) => setThreads(withThreadReplyDetail(threads, thread, level))}
          reading={{ defaultLevel: "low", threads }}
        />
      );
    }
    render(<Host />);
    const [first] = screen.getAllByRole("button", { name: "Reply detail: Low, the default" });
    if (first === undefined) throw new Error("No menu");
    await user.click(first);
    await user.click(await screen.findByRole("menuitemradio", { name: "Medium" }));
    expect(foldOpen("chose-high")).toBe(true);
    expect(foldOpen("follows-default")).toBe(false);
  });

  it("shows no menu where the level cannot be changed, such as a paired browser", () => {
    render(<TwoThreads reading={{ defaultLevel: "high", threads: [] }} />);
    expect(screen.queryByRole("button", { name: /^Reply detail/ })).toBeNull();
    expect(foldOpen("follows-default")).toBe(true);
  });
});

describe("Reply detail while a reply streams", () => {
  function atHigh(node: React.ReactNode, streamReplies = true) {
    return (
      <StreamRepliesContext.Provider value={streamReplies}>
        <ReplyDetailSourceContext.Provider
          value={{ reading: { defaultLevel: "high", threads: [] } }}
        >
          <ThreadReplyDetailScope thread={{ mode: "chat", threadId: "live" }}>
            {node}
          </ThreadReplyDetailScope>
        </ReplyDetailSourceContext.Provider>
      </StreamRepliesContext.Provider>
    );
  }

  it("at high, shows streaming thinking open and updates it as it arrives", () => {
    vi.useFakeTimers();
    try {
      const view = render(atHigh(<AssistantMessageBody body="<think>Read the" streaming />));
      expect(inlinePart("Thinking").open).toBe(true);
      expect(screen.getByText(/Read the/)).toBeVisible();
      act(() => {
        view.rerender(
          atHigh(<AssistantMessageBody body="<think>Read the failing log" streaming />),
        );
      });
      act(() => vi.advanceTimersByTime(60));
      expect(screen.getByText(/Read the failing log/)).toBeVisible();
      expect(inlinePart("Thinking").open).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("at high, keeps a running turn's thinking and tool rows open as they change", () => {
    const running = (summary: string): TurnActivity => ({
      reasoning: `Plan: ${summary}`,
      rows: [{ kind: "tool", id: "call-1", toolName: "Bash", state: "running", summary }],
    });
    const view = render(atHigh(<TurnActivityRows activity={running("bun test")} running />));
    expect(disclosure("Thinking").open).toBe(true);
    expect(disclosure("Bash, running").open).toBe(true);
    view.rerender(atHigh(<TurnActivityRows activity={running("bun test --watch")} running />));
    expect(screen.getByText("bun test --watch")).toBeVisible();
    expect(disclosure("Bash, running").open).toBe(true);
  });

  it.each(["low", "medium", "high"] as const)(
    "leaves Stream replies in charge of the partial answer at %s",
    (level) => {
      const body = "<think>Weigh it.</think>The partial answer";
      const tree = (streamReplies: boolean) => (
        <StreamRepliesContext.Provider value={streamReplies}>
          <ReplyDetailSourceContext.Provider
            value={{ reading: { defaultLevel: level, threads: [] } }}
          >
            <ThreadReplyDetailScope thread={{ mode: "chat", threadId: "live" }}>
              <AssistantMessageBody body={body} streaming />
            </ThreadReplyDetailScope>
          </ReplyDetailSourceContext.Provider>
        </StreamRepliesContext.Provider>
      );
      const view = render(tree(false));
      expect(screen.queryByText("The partial answer")).not.toBeInTheDocument();
      expect(inlinePart("Thinking")).toBeInTheDocument();
      view.rerender(tree(true));
      expect(screen.getByText("The partial answer")).toBeVisible();
    },
  );
});
