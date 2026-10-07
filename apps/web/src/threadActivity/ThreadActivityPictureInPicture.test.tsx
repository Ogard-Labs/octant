import type { BrowserAutomationClient } from "@octant/client-runtime/browser-automation-client";
import type { ComputerUseClient } from "@octant/client-runtime/computer-use-client";
import type { BrowserAutomationSnapshot } from "@octant/contracts/browser-automation-rpc";
import type { ComputerUseSessionView } from "@octant/contracts/computer-use";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadActivityEnvironment } from "./ThreadActivityEnvironment";
import { within } from "@testing-library/react";
import { ThreadActivityPictureInPicture } from "./ThreadActivityPictureInPicture";

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

    expect(await screen.findByRole("button", { name: /Open Browser/ })).toBeVisible();
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

    expect(await screen.findByRole("button", { name: /Open Browser/ })).toBeVisible();
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
    expect(await screen.findByRole("button", { name: /Open Browser/ })).toBeVisible();
    await waitFor(() => expect(onOpenBrowser).toHaveBeenCalledOnce());
    unmount();

    render(ui);
    expect(await screen.findByRole("button", { name: /Open Browser/ })).toBeVisible();
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
    expect(await screen.findByRole("button", { name: /Open Browser/ })).toBeVisible();
    await waitFor(() => expect(onOpenBrowser).toHaveBeenCalledOnce());

    await waitFor(() => expect(inspectThread.mock.calls.length).toBeGreaterThanOrEqual(2));
    await act(async () => {
      idle.resolve(ready);
      await idle.promise;
    });
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "Browser preview" })).not.toBeInTheDocument(),
    );

    await waitFor(() => expect(inspectThread.mock.calls.length).toBeGreaterThanOrEqual(3));
    await act(async () => {
      later.resolve(nextSession);
      await later.promise;
    });
    expect(await screen.findByRole("button", { name: /Open Browser/ })).toBeVisible();
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

  it("hides the Browser preview for a session and keeps it hidden after the pane remounts", async () => {
    const user = userEvent.setup();
    const hiddenSession = "33000000-0000-4000-8000-000000000009";
    const browser = {
      inspectThread: vi.fn(async () => browserSnapshot(threadId, hiddenSession)),
    } as unknown as BrowserAutomationClient;
    const ui = (
      <ThreadActivityPictureInPicture
        browserClient={browser}
        pollIntervalMs={60_000}
        threadId={threadId as never}
      >
        <div>Conversation</div>
      </ThreadActivityPictureInPicture>
    );

    const { unmount } = render(ui);
    const preview = await screen.findByRole("group", { name: "Browser preview" });
    expect(preview.querySelector("img")).toHaveAttribute("src", "data:image/jpeg;base64,AQID");
    expect(browser.inspectThread).toHaveBeenCalledWith({ threadId }, expect.any(AbortSignal));

    await user.click(screen.getByRole("button", { name: "Hide Browser preview" }));
    expect(screen.queryByRole("group", { name: "Browser preview" })).not.toBeInTheDocument();
    unmount();

    render(ui);
    // Once the session is known to be one the person hid, no picture is asked for.
    await waitFor(() =>
      expect(browser.inspectThread).toHaveBeenLastCalledWith(
        { threadId, freshPicture: false },
        expect.any(AbortSignal),
      ),
    );
    expect(screen.queryByRole("group", { name: "Browser preview" })).not.toBeInTheDocument();
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

    expect(await screen.findByRole("button", { name: "Allow app for 5 minutes" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Hide activity preview" }));
    expect(screen.getByRole("button", { name: "Allow app for 5 minutes" })).toBeVisible();
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

  it("fails closed for another thread and never renders stale Browser pixels", async () => {
    const stale = {
      ...browserSnapshot(),
      observation: { ...browserSnapshot().observation!, stale: true },
    };
    const browser = {
      inspectThread: vi
        .fn()
        .mockResolvedValueOnce({ ...stale, threadId: otherThreadId })
        .mockResolvedValue(stale),
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
    expect(screen.queryByRole("group", { name: "Browser preview" })).not.toBeInTheDocument();

    rerender(
      <ThreadActivityPictureInPicture
        browserClient={browser}
        pollIntervalMs={1}
        threadId={threadId as never}
      >
        <div>Conversation</div>
      </ThreadActivityPictureInPicture>,
    );
    const preview = await screen.findByRole("group", { name: "Browser preview" });
    expect(preview.querySelector("img")).toBeNull();
    expect(preview.querySelector(".skeleton")).not.toBeNull();
  });

  it("removes Browser pixels when a later authority poll fails", async () => {
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

    expect(await screen.findByRole("group", { name: "Browser preview" })).toBeVisible();
    await waitFor(() => expect(browser.inspectThread).toHaveBeenCalledTimes(2));
    failedPoll.reject(new Error("host disconnected"));
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "Browser preview" })).not.toBeInTheDocument(),
    );
  });

  it("never carries a preview across a thread authority change", async () => {
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

    expect(await screen.findByRole("group", { name: "Browser preview" })).toBeVisible();
    rerender(
      <ThreadActivityPictureInPicture
        browserClient={browser}
        pollIntervalMs={60_000}
        threadId={otherThreadId as never}
      >
        <div>Other conversation</div>
      </ThreadActivityPictureInPicture>,
    );

    expect(screen.queryByRole("group", { name: "Browser preview" })).not.toBeInTheDocument();
  });
});

describe("Browser preview", () => {
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

  it("stays out of the way while the Browser is on screen and asks for no picture", async () => {
    const browser = liveBrowser("34000000-0000-4000-8000-000000000001");
    renderPreview(browser, { browserVisible: true });

    await waitFor(() => expect(browser.inspectThread).toHaveBeenCalled());
    expect(screen.queryByRole("group", { name: "Browser preview" })).not.toBeInTheDocument();
    expect(browser.inspectThread).toHaveBeenCalledWith(
      { threadId, freshPicture: false },
      expect.any(AbortSignal),
    );
  });

  it("appears when the Browser is closed and a session is live, then opens the Browser on click", async () => {
    const user = userEvent.setup();
    const onShowBrowser = vi.fn();
    const browser = liveBrowser("34000000-0000-4000-8000-000000000002");
    renderPreview(browser, { onShowBrowser });

    const open = await screen.findByRole("button", { name: "Open Browser: Example" });
    await user.click(open);
    expect(onShowBrowser).toHaveBeenCalledOnce();
  });

  it("goes away as soon as the Browser becomes visible and asks for a picture again when it closes", async () => {
    const browser = liveBrowser("34000000-0000-4000-8000-000000000003");
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
    const { rerender } = render(ui(false));
    expect(await screen.findByRole("group", { name: "Browser preview" })).toBeVisible();

    rerender(ui(true));
    expect(screen.queryByRole("group", { name: "Browser preview" })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(browser.inspectThread).toHaveBeenLastCalledWith(
        { threadId, freshPicture: false },
        expect.any(AbortSignal),
      ),
    );

    rerender(ui(false));
    expect(await screen.findByRole("group", { name: "Browser preview" })).toBeVisible();
    await waitFor(() =>
      expect(browser.inspectThread).toHaveBeenLastCalledWith({ threadId }, expect.any(AbortSignal)),
    );
  });

  it("holds a neutral skeleton, with no status words, until the first picture arrives", async () => {
    const waiting = browserSnapshot(threadId, "34000000-0000-4000-8000-000000000004");
    const { screenshotDataUrl: _picture, ...bare } = waiting.observation!;
    const browser = {
      inspectThread: vi.fn(async () => ({ ...waiting, observation: bare })),
    } as unknown as BrowserAutomationClient;
    renderPreview(browser);

    const preview = await screen.findByRole("group", { name: "Browser preview" });
    expect(preview.querySelector(".skeleton")).not.toBeNull();
    expect(preview.querySelector("img")).toBeNull();
    expect(screen.queryByText(/waiting|snapshot|stale/i)).not.toBeInTheDocument();
  });

  it("shows the active page and counts the pages the session has open", async () => {
    const first = browserSnapshot(threadId, "34000000-0000-4000-8000-000000000005");
    const other = browserSnapshot(threadId, "34000000-0000-4000-8000-000000000006");
    const browser = {
      inspectThread: vi.fn(async () => ({
        ...first,
        contexts: [
          { context: first.context!, observation: first.observation! },
          { context: other.context!, observation: other.observation! },
        ],
      })),
    } as unknown as BrowserAutomationClient;
    renderPreview(browser);

    const preview = await screen.findByRole("group", { name: "Browser preview" });
    expect(preview.querySelectorAll("img")).toHaveLength(1);
    expect(within(preview).getByText("2")).toBeVisible();
  });

  it("asks for pictures less often while the page does not change", async () => {
    const browser = liveBrowser("34000000-0000-4000-8000-000000000007");
    renderPreview(browser, { pollIntervalMs: 20 });

    await screen.findByRole("group", { name: "Browser preview" });
    await new Promise((done) => setTimeout(done, 400));
    // Without a backoff a 20 ms cadence would read about twenty times.
    expect(vi.mocked(browser.inspectThread).mock.calls.length).toBeLessThan(10);
    expect(vi.mocked(browser.inspectThread).mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("takes no picture while the window is hidden", async () => {
    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const browser = liveBrowser("34000000-0000-4000-8000-000000000008");
    renderPreview(browser, { pollIntervalMs: 10 });

    await new Promise((done) => setTimeout(done, 80));
    expect(browser.inspectThread).not.toHaveBeenCalled();

    hidden.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(browser.inspectThread).toHaveBeenCalled());
  });

  it("remembers the corner it was moved to, with the arrow keys as the keyboard route", async () => {
    const user = userEvent.setup();
    const browser = liveBrowser("34000000-0000-4000-8000-000000000010");
    const { unmount } = renderPreview(browser);

    const open = await screen.findByRole("button", { name: /Open Browser/ });
    expect(screen.getByRole("group", { name: "Browser preview" })).toHaveAttribute(
      "data-corner",
      "top-right",
    );
    open.focus();
    await user.keyboard("{ArrowDown}{ArrowLeft}");
    expect(screen.getByRole("group", { name: "Browser preview" })).toHaveAttribute(
      "data-corner",
      "bottom-left",
    );
    unmount();

    renderPreview(browser);
    expect(await screen.findByRole("group", { name: "Browser preview" })).toHaveAttribute(
      "data-corner",
      "bottom-left",
    );
  });

  it("settles into the nearest corner after a drag and does not open the Browser", async () => {
    const onShowBrowser = vi.fn();
    const browser = liveBrowser("34000000-0000-4000-8000-000000000011");
    renderPreview(browser, { onShowBrowser });
    const preview = await screen.findByRole("group", { name: "Browser preview" });
    const open = screen.getByRole("button", { name: /Open Browser/ });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        // The frame is 800 by 600; the dragged preview ends low and to the left.
        return (
          this === preview
            ? { left: 20, top: 400, width: 264, height: 165, right: 284, bottom: 565 }
            : { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }
        ) as DOMRect;
      },
    );

    fireEvent.pointerDown(open, { button: 0, clientX: 600, clientY: 40, pointerId: 1 });
    fireEvent.pointerMove(open, { clientX: 100, clientY: 400, pointerId: 1 });
    fireEvent.pointerUp(open, { clientX: 100, clientY: 400, pointerId: 1 });
    fireEvent.click(open);

    expect(preview).toHaveAttribute("data-corner", "bottom-left");
    expect(window.localStorage.getItem("octant.browserPreview.corner")).toBe("bottom-left");
    expect(onShowBrowser).not.toHaveBeenCalled();
  });

  it("rests a bottom corner above the composer instead of over it", async () => {
    const browser = liveBrowser("34000000-0000-4000-8000-000000000012");
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        return (
          this.classList.contains("thread-composer")
            ? { left: 0, top: 480, width: 800, height: 120, right: 800, bottom: 600 }
            : { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }
        ) as DOMRect;
      },
    );
    render(
      <ThreadActivityPictureInPicture
        browserClient={browser}
        pollIntervalMs={60_000}
        threadId={threadId as never}
      >
        <div className="thread-composer">Composer</div>
      </ThreadActivityPictureInPicture>,
    );

    const preview = await screen.findByRole("group", { name: "Browser preview" });
    // 600 - 480 of composer, plus the clearance kept above it.
    expect(preview.style.getPropertyValue("--browser-pip-bottom")).toBe("132px");
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
