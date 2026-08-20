import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  ACCESSIBLE_SUMMARY_LIMIT,
  CodeTranscriptRow,
  TOOL_SUMMARY_PREVIEW_LIMIT,
} from "./CodeTranscriptRow";
import type { CodeTurnActivity } from "./transcriptActivity";

const mixed: CodeTurnActivity = {
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

describe("CodeTranscriptRow", () => {
  it("renders each tool as its own collapsed row naming the tool and outcome", () => {
    render(<CodeTranscriptRow activity={mixed} running={false} />);

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
    expect(thinking).toHaveClass("code-transcript-row__disclosure--thinking");

    // Collapsed bodies stay in the document so in-page find can match them.
    expect(screen.getByText("exit 0")).not.toBeVisible();
    expect(screen.getByText("Check the failing suite first.")).not.toBeVisible();
    expect(screen.getByText("Path is outside the checkout.")).not.toBeVisible();
  });

  it("keeps a failed call obviously not-ok while it is still collapsed", () => {
    render(<CodeTranscriptRow activity={mixed} running={false} />);

    const read = disclosure("Read, failed");
    expect(read.open).toBe(false);
    expect(within(read).getByText("failed")).toBeVisible();
    expect(read.querySelector(".code-transcript-row__status-icon")).not.toBeNull();
  });

  it("names a collapsed task by its summary so concurrent tasks stay distinct", () => {
    render(
      <CodeTranscriptRow
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
    expect(inspect.querySelector(".code-transcript-row__name")).toHaveTextContent("Inspect types");
    expect(write.querySelector(".code-transcript-row__name")).toHaveTextContent("Write mapper");
    expect(screen.queryByRole("button", { name: "Task, running" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Task, queued" })).not.toBeInTheDocument();
  });

  it("bounds a long task summary in the collapsed accessible name", () => {
    const summary = `${"Inspect the generated mapper types ".repeat(20)}TAIL`;
    expect(summary.length).toBeGreaterThan(ACCESSIBLE_SUMMARY_LIMIT);
    render(
      <CodeTranscriptRow
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
    render(<CodeTranscriptRow activity={mixed} running={false} />);

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
      <CodeTranscriptRow
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
    render(<CodeTranscriptRow activity={mixed} running={false} />);

    const thinking = disclosure("Thinking");
    expect(thinking).toHaveClass("code-transcript-row__disclosure--thinking");
    expect(screen.getByText("Check the failing suite first.")).not.toBeVisible();

    await user.click(screen.getByRole("button", { name: "Thinking" }));
    expect(thinking.open).toBe(true);
    expect(screen.getByText("Check the failing suite first.")).toBeVisible();
  });

  it("remembers each row's expanded state across a streaming update", async () => {
    const user = userEvent.setup();
    const running: CodeTurnActivity = {
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
    const { rerender } = render(<CodeTranscriptRow activity={running} running />);

    await user.click(screen.getByRole("button", { name: "Bash, running" }));
    expect(disclosure("Bash, running").open).toBe(true);

    rerender(
      <CodeTranscriptRow
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
    render(<CodeTranscriptRow activity={mixed} running={false} />);

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
      <CodeTranscriptRow
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
});
