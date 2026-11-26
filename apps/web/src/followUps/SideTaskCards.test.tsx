import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SideTask } from "@octant/contracts";
import { listsOf } from "../threadReferences/threadReferenceLists.test-support";
import { ThreadReferencesContext } from "../threadReferences/ThreadReferences";
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
    setReporting: vi.fn(async () => ({
      kind: "side-task-reporting",
      sideTaskId,
      reporting: "stopped",
    })),
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

  it("shows the child thread's live state on the started receipt, and nothing when it is unknown", async () => {
    setup(() => [
      task({
        status: "started",
        startedWith: "fresh",
        startedThreadId: "00000000-0000-4000-8000-000000000099",
        childState: "attention",
      }),
    ]);

    expect(await screen.findByText(/Started in a new thread/)).toBeVisible();
    expect(screen.getByText(/Needs you/)).toBeVisible();
  });

  it("shows no state on the started receipt when the child cannot be read", async () => {
    setup(() => [
      task({
        status: "started",
        startedWith: "fresh",
        startedThreadId: "00000000-0000-4000-8000-000000000099",
      }),
    ]);

    expect(await screen.findByText(/Started in a new thread/)).toBeVisible();
    expect(screen.queryByText(/Needs you/)).toBeNull();
    expect(screen.queryByText(/Finished/)).toBeNull();
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
    expect(await screen.findByText(/Not sure it was delivered/)).toBeVisible();
    expect(screen.getByText(/Check this thread and its queue/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Do it here" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New worktree" })).toBeNull();
    expect(client.continueHere).not.toHaveBeenCalled();
    expect(client.start).not.toHaveBeenCalled();
  });

  it.each(["offered", "continued-here"] as const)(
    "holds every action after a lost response until the host confirms the offer is %s",
    async (status) => {
      let responseLost = false;
      let readable = false;
      const sideTasks = vi.fn(async () => {
        if (responseLost && !readable) throw new Error("Host unavailable");
        return {
          threadId,
          tasks: [task(responseLost ? { status, continuedDelivery: "unconfirmed" } : {})],
        };
      });
      const { client } = setup(() => [], {
        sideTasks,
        continueHere: vi.fn(async () => {
          responseLost = true;
          throw new Error("Response lost after dispatch");
        }),
      });

      await userEvent.click(await screen.findByRole("button", { name: "Do it here" }));
      await waitFor(() => expect(sideTasks).toHaveBeenCalledTimes(2));
      expect(await screen.findByRole("alert")).toHaveTextContent("Waiting for the host");
      expect(screen.getByRole("button", { name: "Do it here" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "New worktree" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Dismiss Fix stale install docs" })).toBeDisabled();
      await userEvent.click(screen.getByRole("button", { name: "Do it here" }));
      expect(client.continueHere).toHaveBeenCalledTimes(1);

      readable = true;
      act(() => window.dispatchEvent(new Event("online")));
      if (status === "continued-here") {
        expect(await screen.findByText(/Not sure it was delivered/)).toBeVisible();
        expect(screen.queryByRole("button", { name: "Do it here" })).toBeNull();
      } else {
        await waitFor(() =>
          expect(screen.getByRole("button", { name: "Do it here" })).toBeEnabled(),
        );
      }
      expect(screen.queryByRole("alert")).toBeNull();
      expect(client.continueHere).toHaveBeenCalledTimes(1);
    },
  );

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
    expect(await screen.findByRole("alert")).toHaveTextContent("was not sent");
  });

  it("holds stale choices when delivery was recorded but its following status read fails", async () => {
    let recorded = false;
    let readable = false;
    const sideTasks = vi.fn(async () => {
      if (recorded && !readable) throw new Error("Status read unavailable");
      return {
        threadId,
        tasks: [task(recorded ? { status: "continued-here", continuedDelivery: "queued" } : {})],
      };
    });
    const { client } = setup(() => [], {
      sideTasks,
      continueHere: vi.fn(async () => {
        recorded = true;
        return { kind: "side-task-continued-here", sideTaskId, threadId, delivery: "queued" };
      }),
    });
    await userEvent.click(await screen.findByRole("button", { name: "Do it here" }));
    await waitFor(() => expect(sideTasks).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Do it here" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "New worktree" })).toBeDisabled();
    expect(await screen.findByRole("alert")).toHaveTextContent("The host recorded this action");
    readable = true;
    act(() => window.dispatchEvent(new Event("online")));
    expect(await screen.findByText(/Queued here/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Do it here" })).toBeNull();
    expect(client.continueHere).toHaveBeenCalledTimes(1);
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

  it("stops a started child's reports from its receipt and offers to resume them", async () => {
    let reporting: "on" | "stopped" | undefined = "on";
    const { client } = setup(
      () => [
        task({
          status: "started",
          startedThreadId: started.threadId,
          startedWith: "fresh",
          reporting,
        }),
      ],
      {
        setReporting: vi.fn(async (_thread: string, _id: string, on: boolean) => {
          reporting = on ? "on" : "stopped";
          return { kind: "side-task-reporting", sideTaskId, reporting };
        }),
      },
    );

    await userEvent.click(await screen.findByRole("button", { name: "Stop reporting" }));
    await waitFor(() =>
      expect(client.setReporting).toHaveBeenCalledWith(threadId, sideTaskId, false),
    );
    expect(await screen.findByRole("button", { name: "Resume reporting" })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: "Resume reporting" }));
    await waitFor(() =>
      expect(client.setReporting).toHaveBeenCalledWith(threadId, sideTaskId, true),
    );
    expect(await screen.findByRole("button", { name: "Stop reporting" })).toBeEnabled();
  });

  it("re-reads the offers when the pane's navigation moves while a started receipt is shown", async () => {
    const sideTasks = vi.fn(async () => ({
      threadId,
      tasks: [
        task({
          status: "started",
          startedWith: "fresh",
          startedThreadId: started.threadId,
        }),
      ],
    }));
    const client = { sideTasks, start: vi.fn(), continueHere: vi.fn(), dismiss: vi.fn() };
    const tree = (navigationRevision: number) => (
      <SideTaskProvider
        client={client as never}
        navigationRevision={navigationRevision}
        threadId={threadId}
      >
        <SideTaskInline last loadedTurnIds={new Set([turnId])} running={false} turnId={turnId} />
      </SideTaskProvider>
    );
    const view = render(tree(1));
    await waitFor(() => expect(sideTasks).toHaveBeenCalled());
    // The started task itself moves the provider onto the recovery cadence,
    // which reads once; the baseline is whatever that settles to.
    await act(async () => {});
    const before = sideTasks.mock.calls.length;

    view.rerender(tree(2));

    await waitFor(() => expect(sideTasks.mock.calls.length).toBeGreaterThan(before));
  });

  it("ignores navigation moves while no started receipt needs them", async () => {
    const sideTasks = vi.fn(async () => ({ threadId, tasks: [task()] }));
    const client = { sideTasks, start: vi.fn(), continueHere: vi.fn(), dismiss: vi.fn() };
    const tree = (navigationRevision: number) => (
      <SideTaskProvider
        client={client as never}
        navigationRevision={navigationRevision}
        threadId={threadId}
      >
        <SideTaskInline last loadedTurnIds={new Set([turnId])} running={false} turnId={turnId} />
      </SideTaskProvider>
    );
    const view = render(tree(1));
    await waitFor(() => expect(sideTasks).toHaveBeenCalledTimes(1));

    view.rerender(tree(2));
    await act(async () => {});

    expect(sideTasks).toHaveBeenCalledTimes(1);
  });

  it("shows the started thread's card from its name on the receipt", async () => {
    const full = {
      sideTasks: vi.fn(async () => ({
        threadId,
        tasks: [
          task({
            status: "started",
            startedThreadId: started.threadId as never,
            startedWith: "fresh",
          }),
        ],
      })),
    };
    render(
      <ThreadReferencesContext.Provider
        value={listsOf({
          code: [
            {
              threadId: started.threadId,
              title: "Fix stale install docs",
              projectId: "project-1",
              checkoutChip: { checkoutKind: "managed-worktree", label: "fix/install-docs" },
            },
          ],
        })}
      >
        <SideTaskProvider client={full as never} onStarted={vi.fn()} threadId={threadId}>
          <SideTaskInline last loadedTurnIds={new Set([turnId])} running={false} turnId={turnId} />
        </SideTaskProvider>
      </ThreadReferencesContext.Provider>,
    );

    await userEvent.click(
      await screen.findByRole("button", { name: /^Thread: Fix stale install docs/ }),
    );

    const card = await screen.findByRole("dialog", { name: "Thread details" });
    expect(card).toHaveTextContent("fix/install-docs");
    expect(screen.getByRole("button", { name: "Open", hidden: true })).toBeInTheDocument();
  });
});
