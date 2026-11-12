import type { BrowserAutomationClient } from "@octant/client-runtime/browser-automation-client";
import type { BrowserAutomationSnapshot } from "@octant/contracts/browser-automation-rpc";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DockBrowserCard } from "./DockBrowserCard";

const threadId = "20000000-0000-4000-8000-000000000001";
const contextId = "30000000-0000-4000-8000-000000000001";

afterEach(() => vi.restoreAllMocks());

function snapshot(
  overrides: { readonly profile?: unknown; readonly stale?: boolean; readonly pages?: number } = {},
): BrowserAutomationSnapshot {
  const context = {
    contextId,
    state: "active",
    policy: {
      profileMode: "isolated",
      ...(overrides.profile === undefined ? {} : { profile: overrides.profile }),
    },
  };
  const observation = {
    title: "Your account",
    url: "https://github.com/settings",
    screenshotDataUrl: "data:image/jpeg;base64,AQID",
    stale: overrides.stale ?? false,
  };
  return {
    status: "running",
    threadId,
    context,
    observation,
    ...((overrides.pages ?? 1) > 1
      ? { contexts: Array.from({ length: overrides.pages ?? 1 }, () => ({ context, observation })) }
      : {}),
    evidence: [],
  } as unknown as BrowserAutomationSnapshot;
}

function clientOf(read: () => BrowserAutomationSnapshot) {
  return { inspectThread: vi.fn(async () => read()) } as unknown as BrowserAutomationClient;
}

function renderCard(
  client: BrowserAutomationClient | undefined,
  extra: { readonly pollIntervalMs?: number; readonly contextId?: string } = {},
) {
  const onExpand = vi.fn();
  const onHide = vi.fn();
  const view = render(
    <DockBrowserCard
      client={client}
      {...(extra.contextId === undefined ? {} : { contextId: extra.contextId })}
      onHide={onHide}
      onExpand={onExpand}
      pollIntervalMs={extra.pollIntervalMs ?? 60_000}
      threadId={threadId as never}
    />,
  );
  return { ...view, onHide, onExpand };
}

describe("DockBrowserCard", () => {
  it("shows the page's title and its picture fitted to the card, with the tool's own controls", async () => {
    const { container } = renderCard(clientOf(() => snapshot()));
    const card = await screen.findByRole("region", { name: "Minimised Browser" });
    await waitFor(() =>
      expect(container.querySelector("img")).toHaveAttribute("src", "data:image/jpeg;base64,AQID"),
    );
    expect(within(card).getByText("Your account")).toBeVisible();
    expect(within(card).getByRole("button", { name: "Show Browser" })).toBeVisible();
    expect(within(card).getByRole("button", { name: "Hide Browser card" })).toBeVisible();
  });

  it("expands and hides from its controls, and expands from the preview itself", async () => {
    const user = userEvent.setup();
    const { onHide, onExpand } = renderCard(clientOf(() => snapshot()));
    await screen.findByText("Your account");
    await user.click(screen.getByRole("button", { name: "Show Browser" }));
    await user.click(screen.getByRole("button", { name: /^Show Browser, live preview/ }));
    expect(onExpand).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole("button", { name: "Hide Browser card" }));
    expect(onHide).toHaveBeenCalledOnce();
  });

  it("asks for a picture only while the card is shown", async () => {
    const client = clientOf(() => snapshot());
    const { unmount } = renderCard(client, { pollIntervalMs: 10 });
    await waitFor(() => expect(client.inspectThread).toHaveBeenCalled());
    expect(client.inspectThread).toHaveBeenCalledWith({ threadId }, expect.any(AbortSignal));
    unmount();
    const calls = vi.mocked(client.inspectThread).mock.calls.length;
    await new Promise((done) => setTimeout(done, 120));
    expect(vi.mocked(client.inspectThread).mock.calls.length).toBe(calls);
  });

  describe("a page that lives in a context of its own", () => {
    const own = "30000000-0000-4000-8000-000000000002";
    const both = (read: () => Promise<BrowserAutomationSnapshot>) =>
      ({
        inspect: vi.fn(read),
        inspectThread: vi.fn(async () => snapshot()),
      }) as unknown as BrowserAutomationClient;

    it("reads that context and not the thread's current one", async () => {
      const client = both(async () => snapshot());
      const { container } = renderCard(client, { contextId: own });
      await waitFor(() =>
        expect(container.querySelector("img")).toHaveAttribute(
          "src",
          "data:image/jpeg;base64,AQID",
        ),
      );
      expect(client.inspect).toHaveBeenCalledWith(
        { contextId: own, threadId },
        expect.any(AbortSignal),
      );
      expect(client.inspectThread).not.toHaveBeenCalled();
    });

    it("keeps reading the thread for the thread's own page", async () => {
      const client = both(async () => snapshot());
      renderCard(client);
      await waitFor(() => expect(client.inspectThread).toHaveBeenCalled());
      expect(client.inspect).not.toHaveBeenCalled();
    });

    it("says the page is not available, in words, when its context is gone", async () => {
      const client = both(async () => {
        throw new Error("Browser context is stale or unknown.");
      });
      const { container } = renderCard(client, { contextId: own });
      expect(await screen.findByText("Page not available")).toBeVisible();
      expect(container.querySelector(".skeleton")).toBeNull();
    });

    it("says the same when the context has stopped, and stops asking when the card goes", async () => {
      const live = snapshot();
      const client = both(async () => ({
        ...live,
        ...(live.context === undefined ? {} : { context: { ...live.context, state: "stopped" } }),
      }));
      const { unmount } = renderCard(client, { contextId: own, pollIntervalMs: 10 });
      expect(await screen.findByText("Page not available")).toBeVisible();
      unmount();
      const calls = vi.mocked(client.inspect).mock.calls.length;
      await new Promise((done) => setTimeout(done, 120));
      expect(vi.mocked(client.inspect).mock.calls.length).toBe(calls);
      expect(client.inspectThread).not.toHaveBeenCalled();
    });
  });

  it("asks for nothing without a Browser client", async () => {
    renderCard(undefined);
    expect(await screen.findByRole("region", { name: "Minimised Browser" })).toBeVisible();
    expect(screen.getByText("Browser")).toBeVisible();
  });

  it("holds a neutral skeleton, with no status words, while the picture is stale or missing", async () => {
    const { container } = renderCard(clientOf(() => snapshot({ stale: true })));
    await screen.findByText("Your account");
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".skeleton")).not.toBeNull();
    expect(screen.queryByText(/waiting|snapshot|stale/i)).not.toBeInTheDocument();
  });

  it("names the profile of a signed-in page beside the page, and a Project profile as a Project", async () => {
    const { unmount } = renderCard(clientOf(() => snapshot({ profile: { kind: "personal" } })));
    expect(await screen.findByText("Personal")).toBeVisible();
    expect(
      screen.getByRole("button", { name: /^Show Browser, live preview.*Personal profile$/ }),
    ).toBeVisible();
    unmount();
    renderCard(clientOf(() => snapshot({ profile: { kind: "project" } })));
    expect(await screen.findByText("Project")).toBeVisible();
  });

  it("says nothing about the profile of a Private page or one with none", async () => {
    const { unmount } = renderCard(clientOf(() => snapshot({ profile: { kind: "private" } })));
    await screen.findByText("Your account");
    expect(screen.queryByText("Private")).not.toBeInTheDocument();
    expect(screen.queryByText(/profile/i)).not.toBeInTheDocument();
    unmount();
    renderCard(clientOf(() => snapshot()));
    await screen.findByText("Your account");
    expect(screen.queryByText(/profile/i)).not.toBeInTheDocument();
  });

  it("counts the pages the session has open", async () => {
    renderCard(clientOf(() => snapshot({ pages: 2 })));
    expect(await screen.findByText("2 pages")).toBeVisible();
  });

  it("asks for pictures less often while the page does not change", async () => {
    const client = clientOf(() => snapshot());
    renderCard(client, { pollIntervalMs: 20 });
    await screen.findByText("Your account");
    await new Promise((done) => setTimeout(done, 400));
    // Without a backoff a 20 ms cadence would read about twenty times.
    expect(vi.mocked(client.inspectThread).mock.calls.length).toBeLessThan(10);
    expect(vi.mocked(client.inspectThread).mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("takes no picture while the window is hidden", async () => {
    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const client = clientOf(() => snapshot());
    renderCard(client, { pollIntervalMs: 10 });
    await new Promise((done) => setTimeout(done, 80));
    expect(client.inspectThread).not.toHaveBeenCalled();

    hidden.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(client.inspectThread).toHaveBeenCalled());
  });

  it("never shows a picture another thread's answer carried", async () => {
    const other = { ...snapshot(), threadId: "20000000-0000-4000-8000-000000000002" };
    const { container } = renderCard(clientOf(() => other as BrowserAutomationSnapshot));
    await new Promise((done) => setTimeout(done, 60));
    expect(container.querySelector("img")).toBeNull();
    expect(screen.queryByText("Your account")).not.toBeInTheDocument();
  });
});
