import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SideTask } from "@octant/contracts";
import { SideTaskCards } from "./SideTaskCards";

const threadId = "00000000-0000-4000-8000-000000000020";
const sideTaskId = "00000000-0000-4000-8000-000000000061";

function task(status: SideTask["status"] = "offered"): SideTask {
  return {
    status,
    offer: {
      id: sideTaskId,
      threadId,
      mode: "code",
      projectId: "00000000-0000-4000-8000-0000000000bb",
      suggestedBy: {
        providerInstanceId: "00000000-0000-4000-8000-000000000001",
        modelId: "sonnet",
      },
      title: "Fix stale install docs",
      reason: "The README still names the removed setup script.",
      prompt: "Update README.md so the install steps match scripts/setup.ts.",
      target: "new-worktree",
      offeredAt: "2026-09-26T12:00:00.000Z",
    },
  } as never;
}

const started = {
  kind: "side-task-started",
  sideTaskId,
  mode: "code",
  threadId: "00000000-0000-4000-8000-000000000099",
  title: "Fix stale install docs",
  sent: true,
} as const;

describe("SideTaskCards", () => {
  it("shows why a side task was offered and starts it in a new worktree on one click", async () => {
    let status: SideTask["status"] = "offered";
    const client = {
      sideTasks: vi.fn(async () => ({ threadId, tasks: [task(status)] })),
      start: vi.fn(async () => {
        status = "started";
        return started;
      }),
      dismiss: vi.fn(),
    };
    const onStarted = vi.fn();
    render(<SideTaskCards client={client as never} onStarted={onStarted} threadId={threadId} />);

    expect(
      await screen.findByText("The README still names the removed setup script."),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Start in new worktree" }));
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith(started, undefined));
    expect(client.start).toHaveBeenCalledWith(threadId, sideTaskId);
    await waitFor(() =>
      expect(screen.queryByRole("article", { name: /Fix stale install docs/ })).toBeNull(),
    );
  });

  it("hands the prompt over when the new thread exists but its first message did not go out", async () => {
    const client = {
      sideTasks: vi.fn(async () => ({ threadId, tasks: [task()] })),
      start: vi.fn(async () => ({ ...started, sent: false })),
      dismiss: vi.fn(),
    };
    const onStarted = vi.fn();
    render(<SideTaskCards client={client as never} onStarted={onStarted} threadId={threadId} />);
    await userEvent.click(await screen.findByRole("button", { name: "Start in new worktree" }));
    await waitFor(() =>
      expect(onStarted).toHaveBeenCalledWith(
        { ...started, sent: false },
        "Update README.md so the install steps match scripts/setup.ts.",
      ),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("did not go out");
  });

  it("dismisses a side task without starting anything", async () => {
    const client = {
      sideTasks: vi.fn(async () => ({ threadId, tasks: [task()] })),
      start: vi.fn(),
      dismiss: vi.fn(async () => ({ kind: "side-task-dismissed", sideTaskId })),
    };
    render(<SideTaskCards client={client as never} onStarted={vi.fn()} threadId={threadId} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Dismiss Fix stale install docs" }),
    );
    await waitFor(() => expect(client.dismiss).toHaveBeenCalledWith(threadId, sideTaskId));
    expect(client.start).not.toHaveBeenCalled();
  });
});
