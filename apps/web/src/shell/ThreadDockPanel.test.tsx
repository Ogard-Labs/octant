import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadDockPanel } from "./ThreadDockPanel";

const threadId = "10000000-0000-4000-8000-000000000001" as never;

describe("the dock's thread panel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not offer child creation until Code can provide a verified isolated worktree", async () => {
    const user = userEvent.setup();
    const requestRun = vi.fn(async (_input: unknown) => ({ kind: "run-accepted" as const }));
    const agentRunClient = {
      parentSummary: vi.fn(async () => ({ parentThreadId: threadId, entries: [] })),
      acknowledge: vi.fn(),
      cancel: vi.fn(async () => ({ results: [] })),
      requestRun,
    } as never;
    render(<ThreadDockPanel agentRunClient={agentRunClient} threadId={threadId} />);

    await user.click(screen.getByRole("button", { name: "Agents" }));
    expect(await screen.findByRole("heading", { name: "Active / History" })).toBeVisible();
    expect(screen.queryByRole("form", { name: "Create subagent" })).not.toBeInTheDocument();
    expect(requestRun).not.toHaveBeenCalled();
  });

  it("reads nothing for a group until that group is opened", () => {
    const parentSummary = vi.fn(async () => ({ parentThreadId: threadId, entries: [] }));
    render(
      <ThreadDockPanel
        agentRunClient={{ parentSummary, acknowledge: vi.fn(), cancel: vi.fn() } as never}
        threadId={threadId}
      />,
    );

    expect(screen.getByRole("button", { name: "Agents" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(parentSummary).not.toHaveBeenCalled();
  });
});
