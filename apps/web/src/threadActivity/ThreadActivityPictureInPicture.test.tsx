import type { BrowserAutomationClient } from "@octant/client-runtime/browser-automation-client";
import type { ComputerUseClient } from "@octant/client-runtime/computer-use-client";
import type { BrowserAutomationSnapshot } from "@octant/contracts/browser-automation-rpc";
import type { ComputerUseSessionView } from "@octant/contracts/computer-use";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
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

  it("keeps the Computer Use selector available in the compact Browser and Computer Use layout", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
    const compactStart = styles.indexOf("@media (max-width: 720px)");
    const compactEnd = styles.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(compactStart).toBeGreaterThanOrEqual(0);
    expect(compactEnd).toBeGreaterThan(compactStart);
    const compactStyles = styles.slice(compactStart, compactEnd);

    expect(compactStyles).not.toContain(".thread-activity-pip__sources");
    expect(compactStyles).toContain(
      '.thread-activity-pip[data-activity-kind="browser"] .thread-activity-pip__visual',
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

  it("lets Environment show and hide the same live preview without stopping it", async () => {
    const user = userEvent.setup();
    const browser = {
      inspectThread: vi.fn(async () => browserSnapshot()),
      stop: vi.fn(),
    } as unknown as BrowserAutomationClient;
    render(
      <ThreadActivityPictureInPicture
        browserClient={browser}
        pollIntervalMs={60_000}
        threadId={threadId as never}
      >
        <section aria-label="Environment">
          <ThreadActivityEnvironment />
        </section>
      </ThreadActivityPictureInPicture>,
    );
    const environment = screen.getByRole("region", { name: "Environment" });
    expect(await screen.findByRole("img", { name: /browser activity/ })).toBeVisible();
    expect(
      within(environment).queryByRole("complementary", { name: "Thread activity preview" }),
    ).not.toBeInTheDocument();
    await user.click(within(environment).getByRole("button", { name: "Hide Picture in Picture" }));
    expect(screen.queryByRole("img", { name: /browser activity/ })).not.toBeInTheDocument();
    expect(browser.stop).not.toHaveBeenCalled();
    await user.click(within(environment).getByRole("button", { name: "Show Picture in Picture" }));
    expect(await screen.findByRole("img", { name: /browser activity/ })).toBeVisible();
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

    expect(await screen.findByRole("img", { name: /browser activity/ })).toBeVisible();
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

    expect(await screen.findByRole("img", { name: /browser activity/ })).toBeVisible();
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
    expect(await screen.findByRole("img", { name: /browser activity/ })).toBeVisible();
    await waitFor(() => expect(onOpenBrowser).toHaveBeenCalledOnce());
    unmount();

    render(ui);
    expect(await screen.findByRole("img", { name: /browser activity/ })).toBeVisible();
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
    expect(await screen.findByRole("img", { name: /browser activity/ })).toBeVisible();
    await waitFor(() => expect(onOpenBrowser).toHaveBeenCalledOnce());

    await waitFor(() => expect(inspectThread.mock.calls.length).toBeGreaterThanOrEqual(2));
    await act(async () => {
      idle.resolve(ready);
      await idle.promise;
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("complementary", { name: "Thread activity preview" }),
      ).not.toBeInTheDocument(),
    );

    await waitFor(() => expect(inspectThread.mock.calls.length).toBeGreaterThanOrEqual(3));
    await act(async () => {
      later.resolve(nextSession);
      await later.promise;
    });
    expect(await screen.findByRole("img", { name: /browser activity/ })).toBeVisible();
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

  it("shows, hides, restores, and stops the exact thread Browser preview", async () => {
    const user = userEvent.setup();
    const running = browserSnapshot();
    const ready = {
      status: "ready",
      threadId,
      evidence: [],
    } as unknown as BrowserAutomationSnapshot;
    const browser = {
      inspectThread: vi.fn(async () => running),
      stop: vi.fn(async () => ready),
    } as unknown as BrowserAutomationClient;

    render(
      <ThreadActivityPictureInPicture
        browserClient={browser}
        pollIntervalMs={60_000}
        threadId={threadId as never}
      >
        <div>Conversation</div>
      </ThreadActivityPictureInPicture>,
    );

    const preview = await screen.findByRole("complementary", {
      name: "Thread activity preview",
    });
    expect(preview).toBeVisible();
    expect(screen.getByRole("img", { name: "Example browser activity" })).toHaveAttribute(
      "src",
      "data:image/jpeg;base64,AQID",
    );
    expect(browser.inspectThread).toHaveBeenCalledWith({ threadId }, expect.any(AbortSignal));

    await user.click(screen.getByRole("button", { name: "Hide activity preview" }));
    expect(screen.queryByRole("img", { name: "Example browser activity" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show Browser activity preview" }));
    expect(screen.getByRole("img", { name: "Example browser activity" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Stop Browser" }));
    await waitFor(() => expect(browser.stop).toHaveBeenCalledOnce());
    expect(browser.stop).toHaveBeenCalledWith({ contextId, threadId });
    await waitFor(() =>
      expect(
        screen.queryByRole("complementary", {
          name: "Thread activity preview",
        }),
      ).not.toBeInTheDocument(),
    );
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
    expect(
      screen.queryByRole("complementary", { name: "Thread activity preview" }),
    ).not.toBeInTheDocument();

    rerender(
      <ThreadActivityPictureInPicture
        browserClient={browser}
        pollIntervalMs={1}
        threadId={threadId as never}
      >
        <div>Conversation</div>
      </ThreadActivityPictureInPicture>,
    );
    expect(await screen.findByText(/Preview is stale/)).toBeVisible();
    expect(screen.queryByRole("img", { name: /browser activity/i })).not.toBeInTheDocument();
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

    expect(await screen.findByRole("img", { name: "Example browser activity" })).toBeVisible();
    await waitFor(() => expect(browser.inspectThread).toHaveBeenCalledTimes(2));
    failedPoll.reject(new Error("host disconnected"));
    await waitFor(() =>
      expect(
        screen.queryByRole("img", { name: "Example browser activity" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("does not restore stopped Browser activity from an older in-flight poll", async () => {
    const user = userEvent.setup();
    const oldPoll = deferred<BrowserAutomationSnapshot>();
    const ready = {
      status: "ready",
      threadId,
      evidence: [],
    } as unknown as BrowserAutomationSnapshot;
    const browser = {
      inspectThread: vi
        .fn()
        .mockResolvedValueOnce(browserSnapshot())
        .mockImplementationOnce(() => oldPoll.promise)
        .mockResolvedValue(ready),
      stop: vi.fn(async () => ready),
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

    expect(await screen.findByRole("img", { name: "Example browser activity" })).toBeVisible();
    await waitFor(() => expect(browser.inspectThread).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "Stop Browser" }));
    await waitFor(() => expect(browser.stop).toHaveBeenCalledOnce());
    oldPoll.resolve(browserSnapshot());
    await waitFor(() =>
      expect(
        screen.queryByRole("complementary", {
          name: "Thread activity preview",
        }),
      ).not.toBeInTheDocument(),
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

    expect(await screen.findByRole("img", { name: "Example browser activity" })).toBeVisible();
    rerender(
      <ThreadActivityPictureInPicture
        browserClient={browser}
        pollIntervalMs={60_000}
        threadId={otherThreadId as never}
      >
        <div>Other conversation</div>
      </ThreadActivityPictureInPicture>,
    );

    expect(
      screen.queryByRole("complementary", { name: "Thread activity preview" }),
    ).not.toBeInTheDocument();
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

it("renders multiple Browser windows as an offset, slanted stack", async () => {
  const first = browserSnapshot();
  const second = {
    ...browserSnapshot(),
    context: {
      ...browserSnapshot().context,
      contextId: "31000000-0000-4000-8000-000000000002",
    },
    observation: {
      ...browserSnapshot().observation,
      contextId: "31000000-0000-4000-8000-000000000002",
      title: "Second",
      screenshotDataUrl: "data:image/jpeg;base64,BBBB",
    },
  };
  const stacked = {
    ...first,
    contexts: [
      { context: first.context, observation: first.observation },
      { context: second.context, observation: second.observation },
    ],
  };
  const browser = {
    inspectThread: vi.fn(async () => stacked),
    stop: vi.fn(),
  } as unknown as BrowserAutomationClient;
  render(
    <ThreadActivityPictureInPicture
      browserClient={browser}
      pollIntervalMs={60_000}
      threadId={threadId as never}
    >
      <div>Conversation</div>
    </ThreadActivityPictureInPicture>,
  );

  expect(await screen.findByLabelText("Browser windows")).toBeVisible();
  const images = screen.getAllByRole("img", { name: /browser activity/ });
  expect(images).toHaveLength(2);
});

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
