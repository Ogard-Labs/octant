import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  ACCESSIBLE_SUMMARY_LIMIT,
  TOOL_SUMMARY_PREVIEW_LIMIT,
  TurnActivityRows,
} from "./TurnActivityRows";
import type { TurnActivity } from "./turnActivity";
import { MarkdownLinkActionsContext } from "../markdown/Markdown";
import type { ReplyDetailLevel } from "@octant/contracts/shell";
import type { ReactNode } from "react";
import { ReplyDetailContext } from "./replyDetail";
import { RoutineOpenContext } from "./RoutineReceiptCard";

const mixed: TurnActivity = {
  reasoning: "Check the failing suite first.",
  rows: [
    {
      kind: "tool",
      id: "call-1",
      toolName: "Bash",
      state: "completed",
      summary: "exit 0",
    },
    {
      kind: "tool",
      id: "call-2",
      toolName: "Read",
      state: "failed",
      summary: "Path is outside the checkout.",
    },
    { kind: "task", id: "task-1", state: "running", summary: "Rewrite the pane" },
  ],
};

function disclosure(name: string): HTMLDetailsElement {
  const summary = screen.getByRole("button", { name });
  const details = summary.closest("details");
  if (!(details instanceof HTMLDetailsElement)) {
    throw new Error(`No disclosure named ${name}`);
  }
  return details;
}

describe("Octant Shield decisions among the tool rows", () => {
  const review = (verdict: "allow" | "ask" | "deny") => ({
    kind: "review" as const,
    id: `review-${verdict}`,
    summary: "bash: git push origin HEAD",
    decision: {
      reviewer: "octant-shield" as const,
      verdict,
      stage: verdict === "allow" ? ("fast-allow" as const) : ("model" as const),
      ...(verdict === "allow" ? { rule: "read-only-git" } : {}),
      reason: `Shield's reason to ${verdict}.`,
      ...(verdict === "allow"
        ? {}
        : { model: { providerInstanceId: "p" as never, modelId: "small-model" as never } }),
      latencyMs: 42,
      decidedAt: "2026-10-31T00:00:00.000Z" as never,
    },
  });

  it("names Shield, the verdict, the call, the reason, and who decided", () => {
    render(
      <TurnActivityRows
        activity={{ reasoning: "", rows: [review("allow"), review("deny"), review("ask")] }}
        running
      />,
    );
    const notes = screen.getAllByRole("note");
    expect(notes.map((note) => note.getAttribute("data-verdict"))).toEqual([
      "allow",
      "deny",
      "ask",
    ]);
    expect(notes[0]).toHaveTextContent("Octant Shield allowed");
    expect(notes[0]).toHaveTextContent("read-only-git · 42 ms");
    expect(notes[1]).toHaveTextContent("Octant Shield denied");
    expect(notes[1]).toHaveTextContent("small-model · 42 ms");
    expect(notes[2]).toHaveAccessibleName(
      "Octant Shield asked you: bash: git push origin HEAD. Shield's reason to ask.",
    );
    // Shield's decisions are not counted as tool calls or folded as running work.
    expect(screen.queryByRole("button", { name: /bash/ })).toBeNull();
  });
});

describe("The provider's own reviewer among the tool rows", () => {
  const providerReview = (verdict: "allow" | "deny") => ({
    kind: "review" as const,
    id: `provider-${verdict}`,
    summary: "git status",
    decision: {
      reviewer: "provider" as const,
      verdict,
      riskLevel: "low" as const,
      reason: "Reads the working tree.",
      decidedAt: "2026-10-31T00:00:00.000Z" as never,
    },
  });

  it("shows the provider as the approver, with the call it covered, never as Shield", () => {
    render(
      <TurnActivityRows
        activity={{ reasoning: "", rows: [providerReview("allow"), providerReview("deny")] }}
        running
      />,
    );
    const notes = screen.getAllByRole("note");
    expect(notes[0]).toHaveTextContent("Approved by the provider's review");
    expect(notes[0]).toHaveTextContent("git status");
    expect(notes[0]).toHaveTextContent("low risk");
    expect(notes[0]).toHaveAccessibleName(
      "Approved by the provider's review: git status. Reads the working tree.",
    );
    expect(notes[1]).toHaveTextContent("Denied by the provider's review");
    expect(notes.every((note) => !/Shield/.test(note.textContent ?? ""))).toBe(true);
  });
});

describe("TurnActivityRows", () => {
  it("reveals reasoning-only history with one disclosure instead of nested Thinking rows", async () => {
    render(
      <TurnActivityRows
        activity={{ reasoning: "Check the two sources.", rows: [] }}
        running={false}
        settled
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Thinking" }));
    expect(screen.getByText("Check the two sources.")).toBeVisible();
    expect(screen.getAllByRole("button", { name: "Thinking" })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Thinking" }));
    expect(screen.getByText("Check the two sources.")).not.toBeVisible();
  });

  it("stops presenting unfinished tools as running after the turn settles", () => {
    render(
      <TurnActivityRows
        activity={{
          rows: [{ kind: "tool", id: "open", toolName: "Browser", state: "running" }],
          reasoning: "",
        }}
        running={false}
        settled
      />,
    );
    expect(screen.queryByRole("button", { name: "Browser, running" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Browser, unfinished" })).toBeInTheDocument();
  });
  it("renders each tool as its own collapsed row naming the tool and outcome", () => {
    render(<TurnActivityRows activity={mixed} running={false} />);

    const bash = disclosure("Bash, done");
    const read = disclosure("Read, failed");
    const thinking = disclosure("Thinking");

    expect(bash.open).toBe(false);
    expect(screen.getByRole("button", { name: "Bash, done" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(read.open).toBe(false);
    expect(thinking.open).toBe(false);
    expect(bash).toHaveTextContent("Bash");
    expect(bash).toHaveTextContent("done");
    expect(read).toHaveTextContent("failed");
    expect(read).toHaveAttribute("data-state", "failed");
    expect(thinking).toHaveClass("turn-activity__disclosure--thinking");

    // Collapsed bodies stay in the document so in-page find can match them.
    expect(screen.getByText("exit 0")).not.toBeVisible();
    expect(screen.getByText("Check the failing suite first.")).not.toBeVisible();
    expect(screen.getByText("Path is outside the checkout.")).not.toBeVisible();
  });

  it("keeps a failed call obviously not-ok while it is still collapsed", () => {
    render(<TurnActivityRows activity={mixed} running={false} />);

    const read = disclosure("Read, failed");
    expect(read.open).toBe(false);
    expect(within(read).getByText("failed")).toBeVisible();
    expect(read.querySelector(".turn-activity__status-icon")).not.toBeNull();
  });

  it("names a collapsed task by its summary so concurrent tasks stay distinct", () => {
    render(
      <TurnActivityRows
        activity={{
          reasoning: "",
          rows: [
            { kind: "task", id: "task-1", state: "running", summary: "Inspect types" },
            { kind: "task", id: "task-2", state: "pending", summary: "Write mapper" },
          ],
        }}
        running
      />,
    );

    const inspect = disclosure("Inspect types, running");
    const write = disclosure("Write mapper, queued");
    expect(inspect.open).toBe(false);
    expect(write.open).toBe(false);
    expect(inspect.querySelector(".turn-activity__name")).toHaveTextContent("Inspect types");
    expect(write.querySelector(".turn-activity__name")).toHaveTextContent("Write mapper");
    expect(screen.queryByRole("button", { name: "Task, running" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Task, queued" })).not.toBeInTheDocument();
  });

  it("bounds a long task summary in the collapsed accessible name", () => {
    const summary = `${"Inspect the generated mapper types ".repeat(20)}TAIL`;
    expect(summary.length).toBeGreaterThan(ACCESSIBLE_SUMMARY_LIMIT);
    render(
      <TurnActivityRows
        activity={{
          reasoning: "",
          rows: [{ kind: "task", id: "task-1", state: "running", summary }],
        }}
        running
      />,
    );

    const button = screen.getByRole("button", { name: /Inspect the generated mapper types/ });
    const accessibleName = button.getAttribute("aria-label") ?? "";
    expect(accessibleName.length).toBeLessThanOrEqual(
      ACCESSIBLE_SUMMARY_LIMIT + ", running".length,
    );
    expect(accessibleName).not.toContain("TAIL");
    expect(button).toHaveTextContent("TAIL");
  });

  it("expands one row to its journaled summary without claiming it is arguments or output", async () => {
    const user = userEvent.setup();
    render(<TurnActivityRows activity={mixed} running={false} />);

    await user.click(screen.getByRole("button", { name: "Bash, done" }));

    const bash = disclosure("Bash, done");
    expect(bash.open).toBe(true);
    expect(within(bash).getByText("exit 0")).toBeVisible();
    expect(within(bash).queryByText("Arguments")).not.toBeInTheDocument();
    expect(within(bash).queryByText("Output")).not.toBeInTheDocument();

    expect(disclosure("Read, failed").open).toBe(false);
    expect(disclosure("Thinking").open).toBe(false);
    expect(screen.getByText("Check the failing suite first.")).not.toBeVisible();
  });

  it("does not present a provider progress message as tool arguments", async () => {
    const user = userEvent.setup();
    render(
      <TurnActivityRows
        activity={{
          reasoning: "",
          rows: [
            {
              kind: "tool",
              id: "call-1",
              toolName: "Read",
              state: "running",
              summary: "Reading file…",
            },
          ],
        }}
        running
      />,
    );

    await user.click(screen.getByRole("button", { name: "Read, running" }));
    expect(screen.getByText("Reading file…")).toBeVisible();
    expect(screen.queryByText("Arguments")).not.toBeInTheDocument();
    expect(screen.queryByText("Output")).not.toBeInTheDocument();
  });

  it("keeps thinking visually apart from the reply and closed until opened", async () => {
    const user = userEvent.setup();
    render(<TurnActivityRows activity={mixed} running={false} />);

    const thinking = disclosure("Thinking");
    expect(thinking).toHaveClass("turn-activity__disclosure--thinking");
    expect(screen.getByText("Check the failing suite first.")).not.toBeVisible();

    await user.click(screen.getByRole("button", { name: "Thinking" }));
    expect(thinking.open).toBe(true);
    expect(screen.getByText("Check the failing suite first.")).toBeVisible();
  });

  it("remembers each row's expanded state across a streaming update", async () => {
    const user = userEvent.setup();
    const running: TurnActivity = {
      reasoning: "planning.",
      rows: [
        {
          kind: "tool",
          id: "call-1",
          toolName: "Bash",
          state: "running",
          summary: "bun run verify",
        },
      ],
    };
    const { rerender } = render(<TurnActivityRows activity={running} running />);

    await user.click(screen.getByRole("button", { name: "Bash, running" }));
    expect(disclosure("Bash, running").open).toBe(true);

    rerender(
      <TurnActivityRows
        activity={{
          reasoning: "planning.",
          rows: [
            {
              kind: "tool",
              id: "call-1",
              toolName: "Bash",
              state: "completed",
              summary: "exit 0",
            },
          ],
        }}
        running={false}
      />,
    );

    expect(disclosure("Bash, done").open).toBe(true);
    expect(screen.getByText("exit 0")).toBeVisible();
    expect(screen.queryByText("bun run verify")).not.toBeInTheDocument();
    expect(disclosure("Thinking").open).toBe(false);
  });

  it("opens a disclosure from the keyboard alone", () => {
    render(<TurnActivityRows activity={mixed} running={false} />);

    const bash = screen.getByRole("button", { name: "Bash, done" });
    bash.focus();
    expect(bash).toHaveFocus();
    fireEvent.keyDown(bash, { key: "Enter" });

    expect(disclosure("Bash, done").open).toBe(true);
    expect(bash).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("exit 0")).toBeVisible();

    fireEvent.keyDown(bash, { key: " " });
    expect(disclosure("Bash, done").open).toBe(false);
    expect(bash).toHaveAttribute("aria-expanded", "false");
  });

  it("bounds a long tool summary when expanded and lets the user see all of it", async () => {
    const user = userEvent.setup();
    const summary = `${"line\n".repeat(400)}TAIL`;
    expect(summary.length).toBeGreaterThan(TOOL_SUMMARY_PREVIEW_LIMIT);
    render(
      <TurnActivityRows
        activity={{
          reasoning: "",
          rows: [
            {
              kind: "tool",
              id: "call-1",
              toolName: "Bash",
              state: "completed",
              summary,
            },
          ],
        }}
        running={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Bash, done" }));
    expect(screen.queryByText(/TAIL/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show all" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Show all" }));
    expect(screen.getByText(/TAIL/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Show all" })).not.toBeInTheDocument();
  });

  it("folds a settled turn's toolchain behind one summary line by default", () => {
    const settled: TurnActivity = {
      reasoning: "Check the failing suite first.",
      rows: [
        {
          kind: "tool",
          id: "call-1",
          toolName: "Bash",
          state: "completed",
          summary: "exit 0",
        },
        {
          kind: "tool",
          id: "call-2",
          toolName: "Write",
          state: "completed",
          summary: "Updated pane",
        },
      ],
    };
    render(<TurnActivityRows activity={settled} running={false} settled />);

    const fold = disclosure("2 tool calls · 1 file edited");
    expect(fold.open).toBe(false);
    expect(screen.getByRole("button", { name: "2 tool calls · 1 file edited" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByText("exit 0")).not.toBeVisible();
    expect(screen.getByText("Check the failing suite first.")).not.toBeVisible();
  });

  it("keeps expanded reasoning visible when a tool turn finishes", async () => {
    const user = userEvent.setup();
    const activity: TurnActivity = {
      reasoning: "Check the failing suite first.",
      rows: [
        { kind: "tool", id: "call-1", toolName: "Bash", state: "completed", summary: "exit 0" },
      ],
    };
    const { rerender } = render(<TurnActivityRows activity={activity} running />);
    await user.click(screen.getByRole("button", { name: "Thinking" }));
    expect(screen.getByText("Check the failing suite first.")).toBeVisible();
    rerender(<TurnActivityRows activity={activity} running={false} settled />);
    expect(screen.getByText("Check the failing suite first.")).toBeVisible();
    expect(disclosure("1 tool call").open).toBe(false);
  });

  it("keeps a waiting approval row visible outside the settled fold", () => {
    render(
      <TurnActivityRows
        activity={{
          reasoning: "",
          rows: [
            {
              kind: "tool",
              id: "call-1",
              toolName: "Read",
              state: "completed",
              summary: "ok",
            },
            {
              kind: "task",
              id: "task-1",
              state: "waiting",
              summary: "Apply the edit",
            },
          ],
        }}
        running={false}
        settled
      />,
    );

    expect(screen.getByRole("button", { name: "Apply the edit, waiting" })).toBeVisible();
    const fold = disclosure("1 tool call");
    expect(fold.open).toBe(false);
    expect(screen.getByText("ok")).not.toBeVisible();
  });

  it("leaves a live turn unfolded even when marked settled", () => {
    render(<TurnActivityRows activity={mixed} running settled />);

    expect(screen.queryByRole("button", { name: /tool call/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bash, done" })).toBeVisible();
  });

  it("expands one settled toolchain without re-folding another", async () => {
    const user = userEvent.setup();
    const first: TurnActivity = {
      reasoning: "",
      rows: [{ kind: "tool", id: "a", toolName: "Read", state: "completed", summary: "a" }],
    };
    const second: TurnActivity = {
      reasoning: "",
      rows: [{ kind: "tool", id: "b", toolName: "Bash", state: "completed", summary: "b" }],
    };
    render(
      <>
        <TurnActivityRows activity={first} running={false} settled />
        <TurnActivityRows activity={second} running={false} settled />
      </>,
    );

    const folds = screen.getAllByRole("button", { name: "1 tool call" });
    await user.click(folds[0]!);
    expect(folds[0]!.closest("details")).toHaveProperty("open", true);
    expect(folds[1]!.closest("details")).toHaveProperty("open", false);
  });
});

describe("a page a tool published", () => {
  const published: TurnActivity = {
    reasoning: "",
    rows: [
      { kind: "tool", id: "write-1", toolName: "Write", state: "completed" },
      {
        kind: "tool",
        id: "artifact-1",
        toolName: "Artifact",
        state: "completed",
        summary: "Published to claude.ai.",
        published: { url: "https://claude.ai/artifact/abc123", title: "Quarterly report" },
      },
    ],
  };

  it("stays in view as a link card after the toolchain folds, and opens in the person's browser", async () => {
    const opened: string[] = [];
    render(
      <MarkdownLinkActionsContext.Provider value={{ openExternal: (url) => opened.push(url) }}>
        <TurnActivityRows activity={published} running={false} settled />
      </MarkdownLinkActionsContext.Provider>,
    );
    const pages = screen.getByRole("list", { name: "Published pages" });
    const link = within(pages).getByRole("link", { name: /Quarterly report/ });
    expect(link).toBeVisible();
    expect(link).toHaveAttribute("href", "https://claude.ai/artifact/abc123");
    expect(link).toHaveTextContent("Published to claude.ai");
    // The page is never framed here; the link is the whole presentation.
    expect(document.querySelector("iframe")).toBeNull();
    await userEvent.click(link);
    expect(opened).toEqual(["https://claude.ai/artifact/abc123"]);
  });
});

describe("a tool row that read outside content", () => {
  const rows = (outsideContent: {
    readonly labels: ReadonlyArray<"agent-instructions" | "fake-authority">;
    readonly recordedOnly?: true;
  }): TurnActivity => ({
    reasoning: "",
    rows: [
      {
        kind: "tool",
        id: "fetch-1",
        toolName: "web-fetch",
        state: "completed",
        outsideContent,
      },
      { kind: "tool", id: "read-1", toolName: "read", state: "completed" },
    ],
  });

  it("names what Octant Shield found, in the warning role, and reads it aloud", () => {
    render(
      <TurnActivityRows
        activity={rows({ labels: ["agent-instructions", "fake-authority"] })}
        running
      />,
    );
    const row = screen.getByRole("button", { name: /^web-fetch/ });
    expect(row).toHaveAccessibleName(
      "web-fetch, done, Outside content · instructions aimed at the agent, a false claim of authority",
    );
    const tag = within(row).getByText(/^Outside content ·/).parentElement;
    expect(tag).toHaveAttribute("data-quiet", "false");
    // A row that read nothing from outside carries no tag.
    expect(
      within(screen.getByRole("button", { name: /^read/ })).queryByText(/Outside content/),
    ).toBeNull();
  });

  it("stays a quiet tag at Full access, where outside content is recorded only", () => {
    render(
      <TurnActivityRows
        activity={rows({ labels: ["agent-instructions"], recordedOnly: true })}
        running
      />,
    );
    const tag = within(screen.getByRole("button", { name: /^web-fetch/ })).getByText(
      "Outside content · instructions aimed at the agent",
    ).parentElement;
    expect(tag).toHaveAttribute("data-quiet", "true");
    expect(tag).toHaveAttribute(
      "title",
      "Outside content · instructions aimed at the agent. Recorded only at Full access.",
    );
  });

  it("marks a plain outside read quietly with no finding", () => {
    render(<TurnActivityRows activity={rows({ labels: [] })} running />);
    const tag = within(screen.getByRole("button", { name: /^web-fetch/ })).getByText(
      "Outside content",
    ).parentElement;
    expect(tag).toHaveAttribute("data-quiet", "true");
    expect(tag).toHaveAttribute("data-found", "false");
  });
});

describe("the Reply detail level", () => {
  const settledTurn: TurnActivity = {
    reasoning: "**Check** the failing suite first.\nThen read the log.",
    rows: [
      { kind: "tool", id: "call-1", toolName: "Bash", state: "completed", summary: "exit 0" },
      {
        kind: "tool",
        id: "call-2",
        toolName: "Write",
        state: "completed",
        summary: "Updated pane",
      },
    ],
  };
  const fold = "2 tool calls · 1 file edited";

  function atLevel(level: ReplyDetailLevel, node: ReactNode) {
    return <ReplyDetailContext.Provider value={level}>{node}</ReplyDetailContext.Provider>;
  }

  it("at medium, keeps thinking folded with its first line showing and a settled turn's tool calls listed", () => {
    render(atLevel("medium", <TurnActivityRows activity={settledTurn} running={false} settled />));

    const thinking = screen.getByRole("button", { name: "Thinking" });
    expect(disclosure("Thinking").open).toBe(false);
    expect(thinking).toHaveAttribute("aria-expanded", "false");
    // The first line, without its emphasis marks, beside the name; hidden from
    // assistive technology so it is not read again when the body opens.
    const preview = within(thinking).getByText("Check the failing suite first.");
    expect(preview).toBeVisible();
    expect(preview).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("Then read the log.", { exact: false })).not.toBeVisible();

    expect(disclosure(fold).open).toBe(true);
    expect(screen.getByRole("button", { name: fold })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Bash, done" })).toBeVisible();
    expect(disclosure("Bash, done").open).toBe(false);
    expect(screen.getByText("exit 0")).not.toBeVisible();
  });

  it("at high, opens thinking, the settled tool calls, and each call's recorded result", () => {
    render(atLevel("high", <TurnActivityRows activity={settledTurn} running={false} settled />));

    expect(disclosure("Thinking").open).toBe(true);
    expect(screen.getByRole("button", { name: "Thinking" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText("Then read the log.", { exact: false })).toBeVisible();
    expect(disclosure(fold).open).toBe(true);
    expect(disclosure("Bash, done").open).toBe(true);
    expect(screen.getByRole("button", { name: "Bash, done" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText("exit 0")).toBeVisible();
    expect(screen.getByText("Updated pane")).toBeVisible();
  });

  it("at low, folds a settled turn and keeps thinking shut with no preview", () => {
    render(atLevel("low", <TurnActivityRows activity={settledTurn} running={false} settled />));

    expect(disclosure("Thinking").open).toBe(false);
    expect(
      within(screen.getByRole("button", { name: "Thinking" })).queryByText(
        "Check the failing suite first.",
      ),
    ).toBeNull();
    expect(disclosure(fold).open).toBe(false);
    expect(screen.getByText("exit 0")).not.toBeVisible();
  });

  it("keeps a row the person closed by hand until the level changes", async () => {
    const user = userEvent.setup();
    const turn = (summary: string): TurnActivity => ({
      reasoning: "",
      rows: [{ kind: "tool", id: "call-1", toolName: "Bash", state: "running", summary }],
    });
    const view = render(atLevel("high", <TurnActivityRows activity={turn("bun test")} running />));
    expect(disclosure("Bash, running").open).toBe(true);

    await user.click(screen.getByRole("button", { name: "Bash, running" }));
    expect(disclosure("Bash, running").open).toBe(false);

    view.rerender(
      atLevel("high", <TurnActivityRows activity={turn("bun test --watch")} running />),
    );
    expect(disclosure("Bash, running").open).toBe(false);
    expect(screen.getByRole("button", { name: "Bash, running" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    view.rerender(
      atLevel("medium", <TurnActivityRows activity={turn("bun test --watch")} running />),
    );
    view.rerender(
      atLevel("high", <TurnActivityRows activity={turn("bun test --watch")} running />),
    );
    expect(disclosure("Bash, running").open).toBe(true);
  });

  it("keeps a settled fold the person closed by hand at medium", async () => {
    const user = userEvent.setup();
    const view = render(
      atLevel("medium", <TurnActivityRows activity={settledTurn} running={false} settled />),
    );

    await user.click(screen.getByRole("button", { name: fold }));
    expect(disclosure(fold).open).toBe(false);
    view.rerender(
      atLevel("medium", <TurnActivityRows activity={settledTurn} running={false} settled />),
    );
    expect(disclosure(fold).open).toBe(false);
  });
});

describe("a routine a tool call created", () => {
  const receipt = {
    routineId: "20000000-0000-4000-8000-0000000000a1",
    name: "Demo: Workspace Summary",
    trigger: {
      kind: "weekly-local" as const,
      weekdays: [1, 2, 3, 4, 5],
      localTime: "09:00",
      timeZone: "America/Los_Angeles",
    },
    firstRunAt: "2026-11-12T17:00:00.000Z",
    paused: true,
  };
  const created = (paused: boolean): TurnActivity => ({
    reasoning: "",
    rows: [
      {
        kind: "tool",
        id: "call-routine",
        toolName: "octant_propose_routine",
        state: "completed",
        routine: { ...receipt, paused } as never,
      },
    ],
  });

  it("shows a receipt that says the routine is paused and opens it in Automation Center", async () => {
    const opened: Array<string> = [];
    render(
      <RoutineOpenContext.Provider value={(id) => opened.push(id)}>
        <TurnActivityRows activity={created(true)} running={false} settled />
      </RoutineOpenContext.Provider>,
    );
    const list = screen.getByRole("list", { name: "Created automations" });
    expect(within(list).getByText("Created automation")).toBeTruthy();
    expect(within(list).getByText("Demo: Workspace Summary")).toBeTruthy();
    expect(within(list).getByText(/· created paused$/)).toBeTruthy();
    await userEvent.click(within(list).getByRole("button", { name: "Open" }));
    expect(opened).toEqual([receipt.routineId]);
  });

  it("does not say paused for a routine the person confirmed, and offers no Open where the host cannot open one", () => {
    render(<TurnActivityRows activity={created(false)} running={false} settled />);
    const list = screen.getByRole("list", { name: "Created automations" });
    expect(within(list).queryByText(/paused/)).toBeNull();
    expect(within(list).getByText(/^Weekdays at 9:00$/)).toBeTruthy();
    expect(within(list).queryByRole("button", { name: "Open" })).toBeNull();
  });
});

describe("a tool row's kept input and output", () => {
  const oneTool: TurnActivity = {
    reasoning: "",
    rows: [{ kind: "tool", id: "call-1", toolName: "Bash", state: "completed", summary: "exit 0" }],
  };
  const recordedAt = "2026-11-12T12:00:00.000Z" as never;

  it("shows what the call was given and what it returned once its row is opened", async () => {
    const read = vi.fn(async () => [
      {
        toolCallId: "call-1",
        toolName: "Bash",
        input: { text: "ls -la", truncated: false },
        output: { text: "README.md", truncated: true },
        recordedAt,
      },
    ]);
    render(<TurnActivityRows activity={oneTool} running={false} toolCallRecords={read} />);
    expect(read).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Bash, done" }));

    expect(await screen.findByText("ls -la")).toBeVisible();
    expect(screen.getByText("README.md")).toBeVisible();
    expect(screen.getByText("Input")).toBeVisible();
    expect(screen.getByText("Output (cut to what is kept)")).toBeVisible();
    // Reading the records re-renders the rows; that must not read them again.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(read).toHaveBeenCalledOnce();
  });

  it("says the output was not kept for a call that named a protected file", async () => {
    render(
      <TurnActivityRows
        activity={oneTool}
        running={false}
        toolCallRecords={async () => [
          {
            toolCallId: "call-1",
            toolName: "Bash",
            input: { text: "cat ~/.ssh/id_ed25519", truncated: false },
            outputWithheld: "protected-path",
            recordedAt,
          },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Bash, done" }));
    expect(await screen.findByText("cat ~/.ssh/id_ed25519")).toBeVisible();
    expect(
      screen.getByText("The output was not kept because the call named a protected file."),
    ).toBeVisible();
  });

  it("says nothing was kept for a call with no record, and that the record could not be read when the read fails", async () => {
    const { unmount } = render(
      <TurnActivityRows activity={oneTool} running={false} toolCallRecords={async () => []} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Bash, done" }));
    expect(await screen.findByText("No input or output was kept for this call.")).toBeVisible();
    unmount();

    render(
      <TurnActivityRows
        activity={oneTool}
        running={false}
        toolCallRecords={async () => {
          throw new Error("refused");
        }}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Bash, done" }));
    expect(
      await screen.findByText("The kept input and output could not be read from this window."),
    ).toBeVisible();
  });

  it("draws no input or output where the surface keeps no records", async () => {
    render(<TurnActivityRows activity={oneTool} running={false} />);
    await userEvent.click(screen.getByRole("button", { name: "Bash, done" }));
    expect(screen.getByText("exit 0")).toBeVisible();
    expect(screen.queryByText(/kept/)).toBeNull();
  });
});
