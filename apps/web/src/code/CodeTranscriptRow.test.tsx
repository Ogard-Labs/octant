import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CodeTranscriptRow, TOOL_OUTPUT_PREVIEW_LIMIT } from "./CodeTranscriptRow";
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
      arguments: "bun run verify",
      output: "exit 0",
    },
    {
      kind: "tool",
      id: "call-2",
      toolName: "Read",
      state: "failed",
      summary: "Path is outside the checkout.",
      arguments: "src/secret.ts",
      output: "Path is outside the checkout.",
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
    expect(screen.getByText("bun run verify")).not.toBeVisible();
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

  it("expands one row to arguments and output without opening the rest", async () => {
    const user = userEvent.setup();
    render(<CodeTranscriptRow activity={mixed} running={false} />);

    await user.click(screen.getByRole("button", { name: "Bash, done" }));

    const bash = disclosure("Bash, done");
    expect(bash.open).toBe(true);
    expect(within(bash).getByText("Arguments")).toBeVisible();
    expect(within(bash).getByText("bun run verify")).toBeVisible();
    expect(within(bash).getByText("Output")).toBeVisible();
    expect(within(bash).getByText("exit 0")).toBeVisible();

    expect(disclosure("Read, failed").open).toBe(false);
    expect(disclosure("Thinking").open).toBe(false);
    expect(screen.getByText("Check the failing suite first.")).not.toBeVisible();
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
          arguments: "bun run verify",
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
              arguments: "bun run verify",
              output: "exit 0",
            },
          ],
        }}
        running={false}
      />,
    );

    expect(disclosure("Bash, done").open).toBe(true);
    expect(screen.getByText("bun run verify")).toBeVisible();
    expect(screen.getByText("exit 0")).toBeVisible();
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
    expect(screen.getByText("bun run verify")).toBeVisible();

    fireEvent.keyDown(bash, { key: " " });
    expect(disclosure("Bash, done").open).toBe(false);
    expect(bash).toHaveAttribute("aria-expanded", "false");
  });

  it("bounds long tool output when expanded and lets the user see all of it", async () => {
    const user = userEvent.setup();
    const output = `${"line\n".repeat(400)}TAIL`;
    expect(output.length).toBeGreaterThan(TOOL_OUTPUT_PREVIEW_LIMIT);
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
              output,
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
