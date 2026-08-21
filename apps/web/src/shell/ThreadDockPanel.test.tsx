import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadDockPanel } from "./ThreadDockPanel";

const threadId = "10000000-0000-4000-8000-000000000001" as never;

describe("the dock's thread panel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts a subagent under this thread's own identity", async () => {
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
    const form = await screen.findByRole("form", { name: "Create subagent" });
    expect(form).toBeVisible();

    await user.type(within(form).getByLabelText("Task"), "Summarize the failing tests.");
    await user.type(
      within(form).getByLabelText("Provider instance ID"),
      "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    );
    await user.type(within(form).getByLabelText("Model ID"), "model-one");
    await user.click(within(form).getByRole("button", { name: "Create subagent" }));

    await waitFor(() => expect(requestRun).toHaveBeenCalledTimes(1));
    expect(requestRun.mock.calls[0]?.[0]).toMatchObject({
      parentThreadId: threadId,
      task: "Summarize the failing tests.",
    });
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
