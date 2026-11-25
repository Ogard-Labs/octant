import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { decodeCodeThreadId, type CodeLiveTask } from "@octant/contracts";
import {
  decodeCodeThreadPullRequestWaits,
  type CodeThreadPullRequestWait,
} from "@octant/contracts/code-project-pull-request-switches";
import { ThreadBackgroundWork } from "./ThreadBackgroundWork";
import type { CodeSessionClient } from "./codeSessionClient";
import { createThreadWaitClient, type ThreadWaitClient } from "./threadWaitClient";

const threadId = decodeCodeThreadId("22222222-2222-4222-8222-222222222223");
const otherThreadId = decodeCodeThreadId("22222222-2222-4222-8222-222222222224");
const target = {
  projectId: "10000000-0000-4000-8000-000000000001",
  repositoryOwner: "octant",
  repositoryName: "octant",
  number: 372,
};

function wait(over: Record<string, unknown> = {}): CodeThreadPullRequestWait {
  const [decoded] = decodeCodeThreadPullRequestWaits({
    threadId,
    waits: [{ kind: "watch", target, since: "2026-11-25T10:00:00.000Z", paused: false, ...over }],
  }).waits;
  if (decoded === undefined) throw new Error("The wait did not decode.");
  return decoded;
}

function client(initial: ReadonlyArray<CodeLiveTask>, turnRunning = false) {
  let tasks = initial;
  const stopLiveTasks = vi.fn<CodeSessionClient["stopLiveTasks"]>(async () => {
    tasks = [];
    return { kind: "code-live-tasks-stopped", stopped: true };
  });
  const value: CodeSessionClient = {
    liveTasks: async () => ({ threadId, tasks, turnRunning }),
    stopLiveTasks,
  };
  return { value, stopLiveTasks };
}

function waiting(initial: ReadonlyArray<CodeThreadPullRequestWait>, turnRunning = false) {
  let waits = initial;
  const stop = vi.fn<ThreadWaitClient["stop"]>(async (_thread, stopped) => {
    waits = waits.filter((entry) => entry !== stopped);
    return true;
  });
  const value: ThreadWaitClient = { waits: vi.fn(async () => waits), stop };
  return { pullRequests: { threadId, client: value, turnRunning }, stop, client: value };
}

describe("a thread's background work", () => {
  it("shows the background tasks a finished turn left running and stops them with the session", async () => {
    const user = userEvent.setup();
    const { value, stopLiveTasks } = client([
      { taskId: "bash-1", description: "bun run dev" },
      { taskId: "bash-2", description: "tail -f server.log" },
    ]);
    render(<ThreadBackgroundWork threadId={threadId} client={value} />);

    expect(await screen.findByText("bun run dev")).toBeTruthy();
    expect(screen.getByText("tail -f server.log")).toBeTruthy();
    expect(screen.getByText("Running 2 tasks")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Stop the live tasks" }));
    expect(stopLiveTasks).toHaveBeenCalledWith(threadId);
    await waitFor(() => expect(screen.queryByLabelText("Background work")).toBeNull());
  });

  it("shows nothing while a turn holds the session, which shows its own tasks", async () => {
    const { value } = client([{ taskId: "bash-1", description: "bun run dev" }], true);
    const liveTasks = vi.spyOn(value, "liveTasks");
    const { container } = render(<ThreadBackgroundWork threadId={threadId} client={value} />);
    await waitFor(() => expect(liveTasks).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });

  it("says which pull request an idle thread waits on, and stops that watch", async () => {
    const user = userEvent.setup();
    const { pullRequests, stop } = waiting([wait()]);
    render(
      <ThreadBackgroundWork
        threadId={threadId}
        client={client([]).value}
        pullRequests={pullRequests}
      />,
    );

    expect(await screen.findByText("Watching pull request #372")).toBeTruthy();
    expect(screen.getByText("Waiting")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Stop: Watching pull request #372" }));
    expect(stop).toHaveBeenCalledWith(threadId, expect.objectContaining({ kind: "watch" }));
    await waitFor(() => expect(screen.queryByLabelText("Background work")).toBeNull());
  });

  it("names babysitting and Auto-fix in their own words", async () => {
    const { pullRequests } = waiting([
      wait({ kind: "babysit" }),
      wait({ kind: "auto-fix", target: { ...target, number: 373 } }),
    ]);
    render(
      <ThreadBackgroundWork threadId={threadId} client={undefined} pullRequests={pullRequests} />,
    );
    expect(await screen.findByText("Babysitting pull request #372")).toBeTruthy();
    expect(screen.getByText("Auto-fixing pull request #373")).toBeTruthy();
    expect(screen.getByText("Waiting on 2 pull requests")).toBeTruthy();
    // Two pull requests: the row's Stop could mean either, so each is stopped in Details.
    expect(screen.queryByRole("button", { name: /^Stop/ })).toBeNull();
  });

  it("shows no wait while a turn runs in the thread", async () => {
    const { pullRequests, client: waits } = waiting([wait()], true);
    const { container } = render(
      <ThreadBackgroundWork threadId={threadId} client={undefined} pullRequests={pullRequests} />,
    );
    await waitFor(() => expect(waits.waits).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });

  it("reads a watch nobody vouches for as paused, and says how it resumes", async () => {
    const user = userEvent.setup();
    const { pullRequests } = waiting([wait({ paused: true })]);
    render(
      <ThreadBackgroundWork threadId={threadId} client={undefined} pullRequests={pullRequests} />,
    );
    expect(await screen.findByText("Paused")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Show background work details" }));
    const dialog = await screen.findByRole("dialog", { name: "Background work" });
    expect(within(dialog).getByText(/Open the pull request to resume/)).toBeTruthy();
  });

  it("lists every task and pull request in Details with its state, and stops one by name", async () => {
    const user = userEvent.setup();
    const { pullRequests, stop } = waiting([
      wait({ wakes: 2, wakeLimit: 10, endsAt: "2026-11-28T10:00:00.000Z" }),
      wait({ kind: "auto-fix", target: { ...target, number: 373 } }),
    ]);
    const session = client([
      { taskId: "bash-1", description: "bun run dev" },
      { taskId: "bash-2", description: "tail -f server.log" },
    ]);
    render(
      <ThreadBackgroundWork
        threadId={threadId}
        client={session.value}
        pullRequests={pullRequests}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Show background work details" }));
    const dialog = await screen.findByRole("dialog", { name: "Background work" });
    expect(within(dialog).getByText("bun run dev")).toBeTruthy();
    expect(within(dialog).getAllByText("Running")).toHaveLength(2);
    expect(within(dialog).getAllByText("Waiting")).toHaveLength(2);
    expect(within(dialog).getByText(/octant\/octant · 2 of 10 wakes used · Ends /)).toBeTruthy();

    await user.click(
      within(dialog).getByRole("button", { name: "Stop: Auto-fixing pull request #373" }),
    );
    expect(stop).toHaveBeenCalledWith(threadId, expect.objectContaining({ kind: "auto-fix" }));
    await waitFor(() =>
      expect(within(dialog).queryByText("Auto-fixing pull request #373")).toBeNull(),
    );
    await user.click(within(dialog).getByRole("button", { name: "Stop tasks" }));
    expect(session.stopLiveTasks).toHaveBeenCalledWith(threadId);
    expect(within(dialog).getByText("Watching pull request #372")).toBeTruthy();
  });

  it("says in Details when the host could not stop a wait, and keeps it listed", async () => {
    const user = userEvent.setup();
    const { pullRequests, stop } = waiting([wait()]);
    stop.mockRejectedValueOnce(new Error("offline"));
    render(
      <ThreadBackgroundWork threadId={threadId} client={undefined} pullRequests={pullRequests} />,
    );
    await user.click(await screen.findByRole("button", { name: "Show background work details" }));
    const dialog = await screen.findByRole("dialog", { name: "Background work" });
    await user.click(
      within(dialog).getByRole("button", { name: "Stop: Watching pull request #372" }),
    );
    expect(await within(dialog).findByRole("status")).toHaveProperty(
      "textContent",
      "The host could not stop this. Try again.",
    );
    expect(within(dialog).getByText("Watching pull request #372")).toBeTruthy();
  });

  it("hands focus to the composer when Details closes after the last wait was stopped", async () => {
    const user = userEvent.setup();
    const { pullRequests } = waiting([wait()]);
    render(
      <div className="composer-frame">
        <ThreadBackgroundWork threadId={threadId} client={undefined} pullRequests={pullRequests} />
        <textarea aria-label="Message" />
      </div>,
    );
    await user.click(await screen.findByRole("button", { name: "Show background work details" }));
    const dialog = await screen.findByRole("dialog", { name: "Background work" });
    await user.click(
      within(dialog).getByRole("button", { name: "Stop: Watching pull request #372" }),
    );
    await within(dialog).findByText("Nothing is running or waiting in this thread.");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message" })).toHaveFocus());
  });

  it("says nothing on the next thread when a stop on the last one fails after the switch", async () => {
    const user = userEvent.setup();
    const { pullRequests, stop } = waiting([wait()]);
    let fail: (error: Error) => void = () => undefined;
    stop.mockImplementationOnce(
      () =>
        new Promise<boolean>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const { rerender } = render(
      <ThreadBackgroundWork threadId={threadId} client={undefined} pullRequests={pullRequests} />,
    );
    await user.click(
      await screen.findByRole("button", { name: "Stop: Watching pull request #372" }),
    );
    const next = waiting([]);
    rerender(
      <ThreadBackgroundWork
        threadId={otherThreadId}
        client={undefined}
        pullRequests={{ ...next.pullRequests, threadId: otherThreadId }}
      />,
    );
    fail(new Error("offline"));
    await waitFor(() => expect(next.client.waits).toHaveBeenCalled());
    expect(screen.queryByText("The host could not stop this. Try again.")).toBeNull();
  });

  it("keeps showing live tasks when the pull-request read fails", async () => {
    const { pullRequests, client: waits } = waiting([]);
    vi.mocked(waits.waits).mockRejectedValue(new Error("unavailable"));
    render(
      <ThreadBackgroundWork
        threadId={threadId}
        client={client([{ taskId: "bash-1", description: "bun run dev" }]).value}
        pullRequests={pullRequests}
      />,
    );
    expect(await screen.findByText("bun run dev")).toBeTruthy();
  });
});

describe("the thread wait client", () => {
  it("stops babysitting as Auto-fix, naming the wait the person saw", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ kind: "code-thread-pull-request-wait-stopped", stopped: true }),
    );
    const stopped = await createThreadWaitClient({
      serverUrl: "http://127.0.0.1:1/",
      windowCapability: "capability",
      fetch,
    }).stop(threadId, wait({ kind: "babysit" }));
    expect(stopped).toBe(true);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("http://127.0.0.1:1/api/code-thread-waits/stop");
    expect(JSON.parse(String(init?.body))).toEqual({
      kind: "stop-code-thread-pull-request-wait",
      threadId,
      wait: "auto-fix",
      target,
      since: "2026-11-25T10:00:00.000Z",
    });
  });

  it("refuses an answer about another thread", async () => {
    const waits = createThreadWaitClient({
      serverUrl: "http://127.0.0.1:1",
      windowCapability: "capability",
      fetch: async () => Response.json({ threadId: otherThreadId, waits: [] }),
    }).waits(threadId);
    await expect(waits).rejects.toThrow("another thread");
  });
});
