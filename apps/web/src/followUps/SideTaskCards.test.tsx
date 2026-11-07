import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SideTask } from "@octant/contracts";
import { SideTaskInline, SideTaskProvider } from "./SideTaskCards";

const threadId = "00000000-0000-4000-8000-000000000020";
const sideTaskId = "00000000-0000-4000-8000-000000000061";
const turnId = "turn-1";

function task(overrides: Partial<SideTask> = {}): SideTask {
  return {
    status: "offered",
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
      context: "fork",
      turnId,
      offeredAt: "2026-09-26T12:00:00.000Z",
    },
    ...overrides,
  } as never;
}

const started = {
  kind: "side-task-started",
  sideTaskId,
  mode: "code",
  threadId: "00000000-0000-4000-8000-000000000099",
  title: "Fix stale install docs",
  startedWith: "fork",
  sent: true,
} as const;

function setup(
  tasks: () => ReadonlyArray<SideTask>,
  client: Record<string, unknown> = {},
  running = false,
) {
  const full = {
    sideTasks: vi.fn(async () => ({ threadId, tasks: tasks() })),
    start: vi.fn(),
    continueHere: vi.fn(),
    dismiss: vi.fn(),
    ...client,
  };
  const onStarted = vi.fn();
  render(
    <SideTaskProvider client={full as never} onStarted={onStarted} threadId={threadId}>
      <SideTaskInline last loadedTurnIds={new Set([turnId])} running={running} turnId={turnId} />
    </SideTaskProvider>,
  );
  return { client: full, onStarted };
}

describe("SideTaskInline", () => {
  it("asks where to run the offer and offers a new worktree, doing it here, and dismissing", async () => {
    setup(() => [task()]);

    expect(
      await screen.findByRole("article", { name: "Side task: Fix stale install docs" }),
    ).toBeVisible();
    expect(screen.getByText("The README still names the removed setup script.")).toBeVisible();
    expect(screen.getByText("Start this in a new worktree, or do it here?")).toBeVisible();
    expect(screen.getByRole("button", { name: "New worktree" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Do it here" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Dismiss Fix stale install docs" })).toBeEnabled();
  });

  it("holds the fork choice back until the offering reply finishes", async () => {
    setup(() => [task()], {}, true);

    const include = await screen.findByRole("radio", { name: "Include this conversation" });
    expect(include).toBeDisabled();
    expect(screen.getByText("Available when this reply finishes.")).toBeVisible();
    expect(screen.getByRole("radio", { name: "Fresh" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Do it here" })).toBeEnabled();
  });

  it("starts with the conversation the offer suggested, or fresh when the person picks it", async () => {
    let status: SideTask["status"] = "offered";
    const { client, onStarted } = setup(() => [task({ status, startedWith: "fresh" })], {
      start: vi.fn(async () => {
        status = "started";
        return started;
      }),
    });

    expect(await screen.findByRole("radio", { name: "Include this conversation" })).toBeChecked();
    await userEvent.click(screen.getByRole("radio", { name: "Fresh" }));
    await userEvent.click(screen.getByRole("button", { name: "New worktree" }));
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith(started, undefined));
    expect(client.start).toHaveBeenCalledWith(threadId, sideTaskId, "fresh");
    expect(await screen.findByText(/Started in a new thread/)).toBeVisible();
  });

  it("does the work in this thread and says it will run after the current reply when queued", async () => {
    let status: SideTask["status"] = "offered";
    const { client } = setup(() => [task({ status })], {
      continueHere: vi.fn(async () => {
        status = "continued-here";
        return {
          kind: "side-task-continued-here",
          sideTaskId,
          threadId,
          delivery: "queued",
        };
      }),
    });

    await userEvent.click(await screen.findByRole("button", { name: "Do it here" }));
    expect(client.continueHere).toHaveBeenCalledWith(threadId, sideTaskId);
    expect(await screen.findByText(/Queued here, runs after the current reply/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Do it here" })).toBeNull();
  });

  it("shows why the host refused an action next to the card", async () => {
    setup(() => [task()], {
      start: vi.fn(async () => ({
        kind: "side-task-refused",
        sideTaskId,
        reason: "turn-running",
        message: "Wait for the reply to finish before including the conversation.",
      })),
    });

    await userEvent.click(await screen.findByRole("button", { name: "New worktree" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Wait for the reply to finish");
    expect(screen.getByRole("button", { name: "New worktree" })).toBeEnabled();
  });

  it("shows an unconfirmed delivery after reopening without offering to send it again", async () => {
    const { client } = setup(() => [
      task({ status: "continued-here", continuedDelivery: "unconfirmed" }),
    ]);
    expect(await screen.findByText(/Delivery is unconfirmed/)).toBeVisible();
    expect(screen.getByText(/Check this thread and its queued messages/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Do it here" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New worktree" })).toBeNull();
    expect(client.continueHere).not.toHaveBeenCalled();
    expect(client.start).not.toHaveBeenCalled();
  });

  it("hands the prompt over when the new thread exists but its first message did not go out", async () => {
    const { onStarted } = setup(() => [task()], {
      start: vi.fn(async () => ({ ...started, sent: false })),
    });

    await userEvent.click(await screen.findByRole("button", { name: "New worktree" }));
    await waitFor(() =>
      expect(onStarted).toHaveBeenCalledWith(
        { ...started, sent: false },
        "Update README.md so the install steps match scripts/setup.ts.",
      ),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("did not go out");
  });

  it("dismisses an offer without starting anything and leaves a receipt", async () => {
    let status: SideTask["status"] = "offered";
    const { client } = setup(() => [task({ status })], {
      dismiss: vi.fn(async () => {
        status = "dismissed";
        return { kind: "side-task-dismissed", sideTaskId };
      }),
    });

    await userEvent.click(
      await screen.findByRole("button", { name: "Dismiss Fix stale install docs" }),
    );
    await waitFor(() => expect(client.dismiss).toHaveBeenCalledWith(threadId, sideTaskId));
    expect(client.start).not.toHaveBeenCalled();
    expect(await screen.findByText("Dismissed")).toBeVisible();
  });

  it("opens the started thread from the receipt", async () => {
    const { onStarted } = setup(() => [
      task({
        status: "started",
        startedThreadId: started.threadId,
        startedWith: "fresh",
      }),
    ]);

    await userEvent.click(await screen.findByRole("button", { name: "Open" }));
    expect(onStarted).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: started.threadId, mode: "code" }),
      undefined,
    );
  });
});
