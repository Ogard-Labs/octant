import type { BrowserAutomationClient } from "@octant/client-runtime/browser-automation-client";
import type { ComputerUseClient } from "@octant/client-runtime/computer-use-client";
import type { BrowserAutomationSnapshot } from "@octant/contracts/browser-automation-rpc";
import type { ApprovalOutsideContent } from "@octant/contracts/content-provenance";
import type { ComputerUseSessionView } from "@octant/contracts/computer-use";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadActivityEnvironment } from "./ThreadActivityEnvironment";
import { within } from "@testing-library/react";
import { ThreadActivityPictureInPicture } from "./ThreadActivityPictureInPicture";
import {
  agentBrowserCardContext,
  dismissLiveBrowserCard,
  resetBrowserCardActivityForTests,
} from "./browserCardActivity";

afterEach(resetBrowserCardActivityForTests);

const threadId = "20000000-0000-4000-8000-000000000001";
const otherThreadId = "20000000-0000-4000-8000-000000000002";
const contextId = "30000000-0000-4000-8000-000000000001";

describe("ThreadActivityPictureInPicture", () => {
  it("defers Browser and Computer Use probes until the transcript is display-ready", async () => {
    const browser = { inspectThread: vi.fn() } as unknown as BrowserAutomationClient;
    const computerUse = { list: vi.fn() } as unknown as ComputerUseClient;
    const { rerender } = render(
      <ThreadActivityPictureInPicture
        browserClient={browser}
        computerUseClient={computerUse}
        enabled={false}
        pollIntervalMs={60_000}
        threadId={threadId as never}
      >
        <div>Conversation</div>
      </ThreadActivityPictureInPicture>,
    );

    expect(screen.getByText("Conversation")).toBeVisible();
    expect(browser.inspectThread).not.toHaveBeenCalled();
    expect(computerUse.list).not.toHaveBeenCalled();

    vi.mocked(browser.inspectThread).mockResolvedValue({
      status: "ready",
      threadId,
      evidence: [],
    } as never);
    vi.mocked(computerUse.list).mockResolvedValue([]);
    rerender(
      <ThreadActivityPictureInPicture
        browserClient={browser}
        computerUseClient={computerUse}
        enabled
        pollIntervalMs={60_000}
        threadId={threadId as never}
      >
        <div>Conversation</div>
      </ThreadActivityPictureInPicture>,
    );

    await waitFor(() => expect(browser.inspectThread).toHaveBeenCalledOnce());
    expect(computerUse.list).toHaveBeenCalledOnce();
  });

  it("reports a Computer Use session only while the PiP renders it", async () => {
    const session = computerSession(threadId, "running");
    const onComputerUseSessionChange = vi.fn();
    const computerUse = {
      list: vi.fn(async () => [session]),
    } as unknown as ComputerUseClient;
    const { unmount } = render(
      <ThreadActivityPictureInPicture
        computerUseClient={computerUse}
        onComputerUseSessionChange={onComputerUseSessionChange}
        pollIntervalMs={60_000}
        threadId={threadId as never}
      >
        <div>Conversation</div>
      </ThreadActivityPictureInPicture>,
    );

    await waitFor(() =>
      expect(onComputerUseSessionChange).toHaveBeenCalledWith(
        threadId,
        String(session.sessionId),
        true,
      ),
    );
    unmount();
    expect(onComputerUseSessionChange).toHaveBeenLastCalledWith(
      threadId,
      String(session.sessionId),
      false,
    );
  });

  it("does not report a Computer Use exclusion while polling is pending or failed", async () => {
    const firstPoll = deferred<ReadonlyArray<ComputerUseSessionView>>();
    const session = computerSession(threadId, "running");
    const onComputerUseSessionChange = vi.fn();
    const list = vi
      .fn()
      .mockImplementationOnce(() => firstPoll.promise)
      .mockRejectedValue(new Error("host disconnected"));
    const computerUse = {
      list,
    } as unknown as ComputerUseClient;

    render(
      <ThreadActivityPictureInPicture
        computerUseClient={computerUse}
        onComputerUseSessionChange={onComputerUseSessionChange}
        pollIntervalMs={10}
        threadId={threadId as never}
      >
        <div>Conversation</div>
      </ThreadActivityPictureInPicture>,
    );

    await waitFor(() => expect(list).toHaveBeenCalledOnce());
    expect(onComputerUseSessionChange).not.toHaveBeenCalledWith(
      threadId,
      String(session.sessionId),
      true,
    );

    await act(async () => {
      firstPoll.resolve([session]);
      await firstPoll.promise;
    });
    await waitFor(() =>
      expect(onComputerUseSessionChange).toHaveBeenCalledWith(
        threadId,
        String(session.sessionId),
        true,
      ),
    );
    // The rejected poll settles immediately, and a short interval can
    // legitimately schedule more than one failed refresh before the next
    // assertion tick. The contract is that a subsequent poll occurred and the
    // resulting transition happened, never an unstable exact call count.
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThanOrEqual(2));
    await waitFor(() =>
      expect(onComputerUseSessionChange).toHaveBeenLastCalledWith(
        threadId,
        String(session.sessionId),
        false,
      ),
    );
  });

  it("lets Environment show and hide the Computer Use preview without stopping it", async () => {
    const user = userEvent.setup();
    const computerUse = {
      list: vi.fn(async () => [computerSession(threadId, "running")]),
      stop: vi.fn(),
    } as unknown as ComputerUseClient;
    render(
      <ThreadActivityPictureInPicture
        computerUseClient={computerUse}
        pollIntervalMs={60_000}
        threadId={threadId as never}
      >
        <section aria-label="Environment">
          <ThreadActivityEnvironment />
        </section>
      </ThreadActivityPictureInPicture>,
    );
    const environment = screen.getByRole("region", { name: "Environment" });
    expect(
      await screen.findByRole("complementary", { name: "Thread activity preview" }),
    ).toBeVisible();
    await user.click(within(environment).getByRole("button", { name: "Hide Picture in Picture" }));
    expect(
      screen.queryByRole("complementary", { name: "Thread activity preview" }),
    ).not.toBeInTheDocument();
    expect(computerUse.stop).not.toHaveBeenCalled();
    await user.click(within(environment).getByRole("button", { name: "Show Picture in Picture" }));
    expect(
      await screen.findByRole("complementary", { name: "Thread activity preview" }),
    ).toBeVisible();
  });

  it("opens the Browser surface once when Browser activity first appears", async () => {
    const onOpenBrowser = vi.fn();
    const browser = {
      inspectThread: vi.fn(async () => browserSnapshot()),
    } as unknown as BrowserAutomationClient;

    render(
      <ThreadActivityPictureInPicture
        browserClient={browser}
        onOpenBrowser={onOpenBrowser}
        pollIntervalMs={60_000}
        threadId={threadId as never}
      >
        <div>Conversation</div>
      </ThreadActivityPictureInPicture>,
    );

    await waitFor(() => expect(agentBrowserCardContext(threadId)).toBeDefined());
    await waitFor(() => expect(onOpenBrowser).toHaveBeenCalledOnce());
    expect(onOpenBrowser).toHaveBeenCalledWith({ sessionIds: [contextId] });
  });

  it("does not ask the shell to reopen while the same Browser session keeps polling", async () => {
    const onOpenBrowser = vi.fn();
    const browser = {
      inspectThread: vi.fn(async () => browserSnapshot()),
    } as unknown as BrowserAutomationClient;

    render(
      <ThreadActivityPictureInPicture
        browserClient={browser}
        onOpenBrowser={onOpenBrowser}
        pollIntervalMs={10}
        threadId={threadId as never}
      >
        <div>Conversation</div>
      </ThreadActivityPictureInPicture>,
    );

    await waitFor(() => expect(agentBrowserCardContext(threadId)).toBeDefined());
    await waitFor(() => expect(onOpenBrowser).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(vi.mocked(browser.inspectThread).mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    expect(onOpenBrowser).toHaveBeenCalledOnce();
    expect(onOpenBrowser).toHaveBeenCalledWith({ sessionIds: [contextId] });
  });

  it("notifies the shell again after remounting the same live Browser session", async () => {
    const onOpenBrowser = vi.fn();
    const browser = {
      inspectThread: vi.fn(async () => browserSnapshot()),
    } as unknown as BrowserAutomationClient;
    const ui = (
      <ThreadActivityPictureInPicture
        browserClient={browser}
        onOpenBrowser={onOpenBrowser}
        pollIntervalMs={60_000}
        threadId={threadId as never}
      >
        <div>Conversation</div>
      </ThreadActivityPictureInPicture>
    );

    const { unmount } = render(ui);
    await waitFor(() => expect(agentBrowserCardContext(threadId)).toBeDefined());
    await waitFor(() => expect(onOpenBrowser).toHaveBeenCalledOnce());
    unmount();

    render(ui);
    await waitFor(() => expect(agentBrowserCardContext(threadId)).toBeDefined());
    await waitFor(() => expect(onOpenBrowser).toHaveBeenCalledTimes(2));
    expect(onOpenBrowser).toHaveBeenNthCalledWith(2, { sessionIds: [contextId] });
  });

  it("asks the shell to surface a later Browser session after the previous one ends", async () => {
    const onOpenBrowser = vi.fn();
    const nextContextId = "31000000-0000-4000-8000-000000000002";
    const ready = {
      status: "ready",
      threadId,
      evidence: [],
    } as unknown as BrowserAutomationSnapshot;
    const nextSession = browserSnapshot(threadId, nextContextId);
    const first = deferred<BrowserAutomationSnapshot>();
    const idle = deferred<BrowserAutomationSnapshot>();
    const later = deferred<BrowserAutomationSnapshot>();
    const inspectThread = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => idle.promise)
      .mockImplementation(() => later.promise);
    const browser = { inspectThread } as unknown as BrowserAutomationClient;

    render(
      <ThreadActivityPictureInPicture
        browserClient={browser}
        onOpenBrowser={onOpenBrowser}
        pollIntervalMs={10}
        threadId={threadId as never}
      >
        <div>Conversation</div>
      </ThreadActivityPictureInPicture>,
    );

    await waitFor(() => expect(inspectThread).toHaveBeenCalledOnce());
    await act(async () => {
      first.resolve(browserSnapshot());
      await first.promise;
    });
    await waitFor(() => expect(agentBrowserCardContext(threadId)).toBeDefined());
    await waitFor(() => expect(onOpenBrowser).toHaveBeenCalledOnce());

    await waitFor(() => expect(inspectThread.mock.calls.length).toBeGreaterThanOrEqual(2));
    await act(async () => {
      idle.resolve(ready);
      await idle.promise;
    });
    await waitFor(() => expect(agentBrowserCardContext(threadId)).toBeUndefined());

    await waitFor(() => expect(inspectThread.mock.calls.length).toBeGreaterThanOrEqual(3));
    await act(async () => {
      later.resolve(nextSession);
      await later.promise;
    });
    await waitFor(() => expect(agentBrowserCardContext(threadId)).toBeDefined());
    await waitFor(() => expect(onOpenBrowser).toHaveBeenCalledTimes(2));
    expect(onOpenBrowser).toHaveBeenNthCalledWith(1, { sessionIds: [contextId] });
    expect(onOpenBrowser).toHaveBeenNthCalledWith(2, { sessionIds: [nextContextId] });
  });

  it("names each thread's Browser session without sharing one callback payload", async () => {
    const onOpenFirst = vi.fn();
    const onOpenSecond = vi.fn();
    const firstBrowser = {
      inspectThread: vi.fn(async () => browserSnapshot()),
    } as unknown as BrowserAutomationClient;
    const secondContextId = "32000000-0000-4000-8000-000000000003";
    const secondBrowser = {
      inspectThread: vi.fn(async () => browserSnapshot(otherThreadId, secondContextId)),
    } as unknown as BrowserAutomationClient;

    render(
      <>
        <ThreadActivityPictureInPicture
          browserClient={firstBrowser}
          onOpenBrowser={onOpenFirst}
          pollIntervalMs={60_000}
          threadId={threadId as never}
        >
          <div>First conversation</div>
        </ThreadActivityPictureInPicture>
        <ThreadActivityPictureInPicture
          browserClient={secondBrowser}
          onOpenBrowser={onOpenSecond}
          pollIntervalMs={60_000}
          threadId={otherThreadId as never}
        >
          <div>Second conversation</div>
        </ThreadActivityPictureInPicture>
      </>,
    );

    await waitFor(() => expect(onOpenFirst).toHaveBeenCalledWith({ sessionIds: [contextId] }));
    await waitFor(() =>
      expect(onOpenSecond).toHaveBeenCalledWith({ sessionIds: [secondContextId] }),
    );
    expect(onOpenFirst).toHaveBeenCalledOnce();
    expect(onOpenSecond).toHaveBeenCalledOnce();
  });

  it("tells the dock about a live Browser session and whether the Browser is in sight, and asks the host for no picture", async () => {
    const hiddenSession = "33000000-0000-4000-8000-000000000009";
    const browser = {
      inspectThread: vi.fn(async () => browserSnapshot(threadId, hiddenSession)),
    } as unknown as BrowserAutomationClient;
    const ui = (visible: boolean) => (
      <ThreadActivityPictureInPicture
        browserClient={browser}
        browserVisible={visible}
        pollIntervalMs={60_000}
        threadId={threadId as never}
      >
        <div>Conversation</div>
      </ThreadActivityPictureInPicture>
    );

    const { rerender, unmount } = render(ui(false));
    await waitFor(() => expect(agentBrowserCardContext(threadId)).toBe(hiddenSession));
    expect(browser.inspectThread).toHaveBeenCalledWith(
      { threadId, freshPicture: false },
      expect.any(AbortSignal),
    );
    expect(screen.queryByRole("group", { name: "Browser preview" })).not.toBeInTheDocument();

    rerender(ui(true));
    await waitFor(() => expect(agentBrowserCardContext(threadId)).toBeUndefined());
    rerender(ui(false));
    await waitFor(() => expect(agentBrowserCardContext(threadId)).toBe(hiddenSession));

    // A card the person closed stays closed after the pane remounts.
    dismissLiveBrowserCard(threadId);
    unmount();
    render(ui(false));
    await waitFor(() => expect(browser.inspectThread).toHaveBeenCalled());
    expect(agentBrowserCardContext(threadId)).toBeUndefined();
  });

  it("filters Computer Use to the exact thread and keeps approval and stop visible", async () => {
    const user = userEvent.setup();
    const waiting = computerSession(threadId, "waiting-for-approval");
    const running = computerSession(threadId, "running");
    const stopped = computerSession(threadId, "stopped");
    const computerUse = {
      list: vi.fn(async () => [computerSession(otherThreadId, "running"), waiting]),
      decide: vi.fn(async () => running),
      stop: vi.fn(async () => stopped),
      inspect: vi.fn(async () => waiting),
    } as unknown as ComputerUseClient;
    const browser = {
      inspectThread: vi.fn(async () => ({
        status: "ready",
        threadId,
        evidence: [],
      })),
    } as unknown as BrowserAutomationClient;

    render(
      <ThreadActivityPictureInPicture
        browserClient={browser}
        computerUseClient={computerUse}
        pollIntervalMs={60_000}
        threadId={threadId as never}
      >
        <div>Conversation</div>
      </ThreadActivityPictureInPicture>,
    );

    expect(await screen.findByText("Computer Use")).toBeVisible();
    expect(screen.getByText("click in Preview")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Allow computer access?" })).toBeVisible();
    expect(screen.queryByText("Approval needed")).not.toBeInTheDocument();
    expect(screen.queryByText(otherThreadId)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Approve once" }));
    await waitFor(() => expect(computerUse.decide).toHaveBeenCalledOnce());
    // The state reads once, on the card itself; there is no footer repeating it.
    expect(screen.getByText("Computer Use running")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Stop Computer Use" }));
    await waitFor(() => expect(computerUse.stop).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(
        screen.queryByRole("complementary", {
          name: "Thread activity preview",
        }),
      ).not.toBeInTheDocument(),
    );
  });

  it("describes an application-session approval in expanded and collapsed PiP", async () => {
    const user = userEvent.setup();
    const waiting = computerSession(threadId, "waiting-for-approval", "application-session");
    const computerUse = {
      list: vi.fn(async () => [waiting]),
      decide: vi.fn(async () => waiting),
      stop: vi.fn(async () => waiting),
      inspect: vi.fn(async () => waiting),
    } as unknown as ComputerUseClient;

    render(
      <ThreadActivityPictureInPicture
        computerUseClient={computerUse}
        pollIntervalMs={60_000}
        threadId={threadId as never}
      >
        <div>Conversation</div>
      </ThreadActivityPictureInPicture>,
    );

    expect(await screen.findByRole("button", { name: "Allow app for this thread" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Hide activity preview" }));
    expect(screen.getByRole("button", { name: "Allow app for this thread" })).toBeVisible();
  });

  it("keeps Computer Use approval and stop controls while the preview is collapsed", async () => {
    const user = userEvent.setup();
    const waiting = computerSession(threadId, "waiting-for-approval");
    const stopped = computerSession(threadId, "stopped");
    const computerUse = {
      list: vi.fn(async () => [waiting]),
      decide: vi.fn(async () => waiting),
      stop: vi.fn(async () => stopped),
      inspect: vi.fn(async () => waiting),
    } as unknown as ComputerUseClient;

    render(
      <ThreadActivityPictureInPicture
        computerUseClient={computerUse}
        pollIntervalMs={60_000}
        threadId={threadId as never}
      >
        <div>Conversation</div>
      </ThreadActivityPictureInPicture>,
    );

    expect(await screen.findByRole("button", { name: "Approve once" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Hide activity preview" }));

    expect(
      screen.getByRole("button", { name: "Show Computer Use activity preview" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Approve once" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Deny" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Stop Computer Use" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Stop Computer Use" }));
    await waitFor(() => expect(computerUse.stop).toHaveBeenCalledOnce());
  });

  it("opens the full prompt, with its sources, before a marked approval can be given from the collapsed strip", async () => {
    const user = userEvent.setup();
    const waiting = computerSession(threadId, "waiting-for-approval", undefined, {
      sourceCount: 1,
      sources: [
        {
          sourceLabel: "web-fetch",
          ingestionCount: 2,
          firstIngestedAt: "2026-08-10T11:00:00.000Z" as never,
          lastIngestedAt: "2026-08-10T11:30:00.000Z" as never,
        },
      ],
    });
    const computerUse = {
      list: vi.fn(async () => [waiting]),
      decide: vi.fn(async () => waiting),
      stop: vi.fn(async () => waiting),
      inspect: vi.fn(async () => waiting),
    } as unknown as ComputerUseClient;

    render(
      <ThreadActivityPictureInPicture
        computerUseClient={computerUse}
        pollIntervalMs={60_000}
        threadId={threadId as never}
      >
        <div>Conversation</div>
      </ThreadActivityPictureInPicture>,
    );

    expect(await screen.findByText("Web pages")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Hide activity preview" }));

    expect(screen.queryByRole("button", { name: "Approve once" })).not.toBeInTheDocument();
    expect(screen.queryByText("Web pages")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Review before approving" }));

    expect(screen.getByText("Web pages")).toBeVisible();
    expect(screen.getByRole("button", { name: "Approve once" })).toBeVisible();
    expect(computerUse.decide).not.toHaveBeenCalled();
  });

  it("fails closed for another thread's answer and reports nothing for it", async () => {
    const browser = {
      inspectThread: vi
        .fn()
        .mockResolvedValueOnce({ ...browserSnapshot(), threadId: otherThreadId })
        .mockResolvedValue(browserSnapshot()),
    } as unknown as BrowserAutomationClient;
    const { rerender } = render(
      <ThreadActivityPictureInPicture
        browserClient={browser}
        pollIntervalMs={60_000}
        threadId={threadId as never}
      >
        <div>Conversation</div>
      </ThreadActivityPictureInPicture>,
    );

    await waitFor(() => expect(browser.inspectThread).toHaveBeenCalledOnce());
    expect(agentBrowserCardContext(threadId)).toBeUndefined();
    expect(agentBrowserCardContext(otherThreadId)).toBeUndefined();

    rerender(
      <ThreadActivityPictureInPicture
        browserClient={browser}
        pollIntervalMs={1}
        threadId={threadId as never}
      >
        <div>Conversation</div>
      </ThreadActivityPictureInPicture>,
    );
    await waitFor(() => expect(agentBrowserCardContext(threadId)).toBe(contextId));
  });

  it("withdraws the live session when a later authority poll fails", async () => {
    const failedPoll = deferred<BrowserAutomationSnapshot>();
    const browser = {
      inspectThread: vi
        .fn()
        .mockResolvedValueOnce(browserSnapshot())
        .mockImplementationOnce(() => failedPoll.promise)
        .mockRejectedValue(new Error("host disconnected")),
    } as unknown as BrowserAutomationClient;

    render(
      <ThreadActivityPictureInPicture
        browserClient={browser}
        pollIntervalMs={10}
        threadId={threadId as never}
      >
        <div>Conversation</div>
      </ThreadActivityPictureInPicture>,
    );

    await waitFor(() => expect(agentBrowserCardContext(threadId)).toBe(contextId));
    await waitFor(() => expect(browser.inspectThread).toHaveBeenCalledTimes(2));
    failedPoll.reject(new Error("host disconnected"));
    await waitFor(() => expect(agentBrowserCardContext(threadId)).toBeUndefined());
  });

  it("never carries a session across a thread authority change", async () => {
    const nextThreadPoll = deferred<BrowserAutomationSnapshot>();
    const browser = {
      inspectThread: vi
        .fn()
        .mockResolvedValueOnce(browserSnapshot())
        .mockImplementationOnce(() => nextThreadPoll.promise),
    } as unknown as BrowserAutomationClient;
    const { rerender } = render(
      <ThreadActivityPictureInPicture
        browserClient={browser}
        pollIntervalMs={60_000}
        threadId={threadId as never}
      >
        <div>Conversation</div>
      </ThreadActivityPictureInPicture>,
    );

    await waitFor(() => expect(agentBrowserCardContext(threadId)).toBe(contextId));
    rerender(
      <ThreadActivityPictureInPicture
        browserClient={browser}
        pollIntervalMs={60_000}
        threadId={otherThreadId as never}
      >
        <div>Other conversation</div>
      </ThreadActivityPictureInPicture>,
    );

    expect(agentBrowserCardContext(otherThreadId)).toBeUndefined();
    await waitFor(() => expect(agentBrowserCardContext(threadId)).toBeUndefined());
  });
});

describe("Browser activity", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    try {
      window.localStorage.clear();
    } catch {
      // Storage may be unavailable.
    }
  });

  function renderPreview(
    browser: BrowserAutomationClient,
    extra: Partial<React.ComponentProps<typeof ThreadActivityPictureInPicture>> = {},
  ) {
    return render(
      <ThreadActivityPictureInPicture
        browserClient={browser}
        pollIntervalMs={60_000}
        threadId={threadId as never}
        {...extra}
      >
        <div>Conversation</div>
      </ThreadActivityPictureInPicture>,
    );
  }

  function liveBrowser(sessionId: string) {
    return {
      inspectThread: vi.fn(async () => browserSnapshot(threadId, sessionId)),
    } as unknown as BrowserAutomationClient;
  }

  it("asks the host for no picture, whether or not the Browser is on screen", async () => {
    const browser = liveBrowser("34000000-0000-4000-8000-000000000001");
    renderPreview(browser, { browserVisible: true });

    await waitFor(() => expect(browser.inspectThread).toHaveBeenCalled());
    expect(screen.queryByRole("group", { name: "Browser preview" })).not.toBeInTheDocument();
    expect(browser.inspectThread).toHaveBeenCalledWith(
      { threadId, freshPicture: false },
      expect.any(AbortSignal),
    );
  });

  it("brings the Browser forward once when the agent hands the page over to sign in", async () => {
    const onShowBrowser = vi.fn();
    const browser = {
      inspectThread: vi.fn(async () => ({
        ...browserSnapshot(threadId, "34000000-0000-4000-8000-000000000009"),
        waitingForPerson: "sign-in" as const,
      })),
    } as unknown as BrowserAutomationClient;
    renderPreview(browser, { onShowBrowser, pollIntervalMs: 20 });

    await waitFor(() => expect(onShowBrowser).toHaveBeenCalledOnce());
    await waitFor(() => expect(browser.inspectThread).toHaveBeenCalledTimes(3));
    expect(onShowBrowser).toHaveBeenCalledOnce();
  });

  it("does not pull the Browser forward when the person took the page over themselves", async () => {
    const onShowBrowser = vi.fn();
    const browser = {
      inspectThread: vi.fn(async () => ({
        ...browserSnapshot(threadId, "34000000-0000-4000-8000-000000000010"),
        waitingForPerson: "take-over" as const,
      })),
    } as unknown as BrowserAutomationClient;
    renderPreview(browser, { onShowBrowser, pollIntervalMs: 20 });

    await waitFor(() => expect(browser.inspectThread).toHaveBeenCalledTimes(3));
    expect(onShowBrowser).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function browserSnapshot(
  ownedThreadId: string = threadId,
  ownedContextId: string = contextId,
): BrowserAutomationSnapshot {
  return {
    status: "running",
    threadId: ownedThreadId as never,
    context: {
      contextId: ownedContextId as never,
      threadId: ownedThreadId as never,
      actionId: "40000000-0000-4000-8000-000000000001" as never,
      correlationId: "50000000-0000-4000-8000-000000000001" as never,
      authority: {
        hostId: "local" as never,
        mode: "code",
        projectId: "60000000-0000-4000-8000-000000000001" as never,
        rootId: "70000000-0000-4000-8000-000000000001" as never,
        providerInstanceId: "80000000-0000-4000-8000-000000000001" as never,
        extension: { kind: "core" },
      },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 300_000,
      },
      state: "active",
      createdAt: "2026-08-10T12:00:00.000Z" as never,
    },
    observation: {
      contextId: ownedContextId as never,
      actionId: "40000000-0000-4000-8000-000000000001" as never,
      correlationId: "50000000-0000-4000-8000-000000000001" as never,
      authority: {
        hostId: "local" as never,
        mode: "code",
        projectId: "60000000-0000-4000-8000-000000000001" as never,
        rootId: "70000000-0000-4000-8000-000000000001" as never,
        providerInstanceId: "80000000-0000-4000-8000-000000000001" as never,
        extension: { kind: "core" },
      },
      url: "https://example.com",
      title: "Example",
      screenshotDataUrl: "data:image/jpeg;base64,AQID",
      observedAt: "2026-08-10T12:00:01.000Z" as never,
      stale: false,
    },
    evidence: [],
  };
}

function computerSession(
  ownedThreadId: string,
  state: ComputerUseSessionView["state"],
  approvalScope?: "application-session",
  outsideContent?: ApprovalOutsideContent,
): ComputerUseSessionView {
  const waiting = state === "waiting-for-approval";
  return {
    sessionId: "90000000-0000-4000-8000-000000000001" as never,
    threadId: ownedThreadId,
    requestedBy: {
      kind: "local-user",
      actorId: "91000000-0000-4000-8000-000000000001" as never,
    },
    authority: {
      hostId: "local" as never,
      mode: "code",
      projectId: "60000000-0000-4000-8000-000000000001" as never,
      rootId: "70000000-0000-4000-8000-000000000001" as never,
      providerInstanceId: "80000000-0000-4000-8000-000000000001" as never,
      extension: { kind: "core" },
    },
    state,
    sequence: 1,
    ...(waiting
      ? {
          pendingApproval: {
            approvalId: "92000000-0000-4000-8000-000000000001" as never,
            actionId: "93000000-0000-4000-8000-000000000001" as never,
            expiresAt: "2026-08-10T12:05:00.000Z" as never,
            summary: "click in Preview",
            ...(approvalScope === undefined ? {} : { scope: approvalScope }),
            ...(outsideContent === undefined ? {} : { outsideContent }),
          },
        }
      : {}),
    events: [
      {
        sequence: 1,
        kind: waiting ? "approval-requested" : "action-started",
        occurredAt: "2026-08-10T12:00:01.000Z" as never,
        detail: waiting ? "One-time approval is required." : "Computer Use running",
      },
    ],
  };
}
