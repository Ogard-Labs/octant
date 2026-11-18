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
  const onClose = vi.fn();
  const view = render(
    <DockBrowserCard
      client={client}
      {...(extra.contextId === undefined ? {} : { contextId: extra.contextId })}
      onClose={onClose}
      onExpand={onExpand}
      pollIntervalMs={extra.pollIntervalMs ?? 60_000}
      threadId={threadId as never}
    />,
  );
  return { ...view, onClose, onExpand };
}

describe("DockBrowserCard", () => {
  it("shows the page's own icon in the card head and the globe when it has none", async () => {
    const icon = "data:image/png;base64,iVBORw0KGgo=";
    const withIcon = snapshot();
    (withIcon.observation as { faviconDataUrl?: string }).faviconDataUrl = icon;
    const view = renderCard(clientOf(() => withIcon));
    const card = await screen.findByRole("region", { name: "Minimised Browser" });
    await waitFor(() =>
      expect(card.querySelector(".dock-mini-card__head img")).toHaveAttribute("src", icon),
    );
    view.unmount();
    renderCard(clientOf(() => snapshot()));
    const plain = await screen.findByRole("region", { name: "Minimised Browser" });
    await waitFor(() => expect(within(plain).getByText("Your account")).toBeVisible());
    expect(plain.querySelector(".dock-mini-card__head img")).toBeNull();
  });

  it("shows the page's title and its picture fitted to the card, with the tool's own controls", async () => {
    const { container } = renderCard(clientOf(() => snapshot()));
    const card = await screen.findByRole("region", { name: "Minimised Browser" });
    await waitFor(() =>
      expect(container.querySelector("img")).toHaveAttribute("src", "data:image/jpeg;base64,AQID"),
    );
    expect(within(card).getByText("Your account")).toBeVisible();
    expect(within(card).getByRole("button", { name: "Show Browser" })).toBeVisible();
    expect(within(card).getByRole("button", { name: "Close Browser" })).toBeVisible();
  });

  it("expands from its controls and its preview, and closes the page from its X", async () => {
    const user = userEvent.setup();
    const { onClose, onExpand } = renderCard(clientOf(() => snapshot()));
    await screen.findByText("Your account");
    await user.click(screen.getByRole("button", { name: "Show Browser" }));
    await user.click(screen.getByRole("button", { name: /^Show Browser, live preview/ }));
    expect(onExpand).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole("button", { name: "Close Browser" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Hide Browser card" })).toBeNull();
  });

  it("lists the Browser's pages behind a chevron after the title, and shows the one chosen", async () => {
    const user = userEvent.setup();
    const onChoose = vi.fn();
    render(
      <DockBrowserCard
        client={clientOf(() => snapshot())}
        onClose={vi.fn()}
        onExpand={vi.fn()}
        pages={{
          label: "Browser pages",
          items: [
            { id: "one", label: "Your account", current: true },
            { id: "two", label: "Pricing", current: false },
          ],
          onChoose,
        }}
        pollIntervalMs={60_000}
        threadId={threadId as never}
      />,
    );
    await screen.findByText("Your account");
    await user.click(screen.getByRole("button", { name: "Browser pages" }));
    const menu = await screen.findByRole("menu", { name: "Browser pages" });
    expect(within(menu).getByRole("menuitem", { name: "Your account" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    await user.click(within(menu).getByRole("menuitem", { name: "Pricing" }));
    expect(onChoose).toHaveBeenCalledExactlyOnceWith("two");
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

    it("reads that context, asking for a picture of the off-screen page, and not the thread's current one", async () => {
      const client = both(async () => snapshot());
      const { container } = renderCard(client, { contextId: own });
      await waitFor(() =>
        expect(container.querySelector("img")).toHaveAttribute(
          "src",
          "data:image/jpeg;base64,AQID",
        ),
      );
      expect(client.inspect).toHaveBeenCalledWith(
        { contextId: own, threadId, freshPicture: true },
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
    const { container } = renderCard(undefined);
    expect(await screen.findByRole("region", { name: "Minimised Browser" })).toBeVisible();
    expect(
      within(container.querySelector(".dock-mini-card__head") as HTMLElement).getByText("Browser"),
    ).toBeVisible();
  });

  it("holds a neutral skeleton until the first answer, then the page's name instead of an empty box", async () => {
    let answer: (value: BrowserAutomationSnapshot) => void = () => {};
    const client = {
      inspectThread: vi.fn(
        () =>
          new Promise<BrowserAutomationSnapshot>((done) => {
            answer = done;
          }),
      ),
    } as unknown as BrowserAutomationClient;
    const { container } = renderCard(client);
    await waitFor(() => expect(client.inspectThread).toHaveBeenCalled());
    expect(container.querySelector(".skeleton")).not.toBeNull();

    answer(snapshot({ stale: true }));
    const preview = await waitFor(() => {
      const note = container.querySelector(".dock-mini-card__note");
      expect(note).not.toBeNull();
      return note as HTMLElement;
    });
    expect(container.querySelector(".dock-mini-card__picture")).toBeNull();
    expect(container.querySelector(".skeleton")).toBeNull();
    expect(within(preview).getByText("Your account")).toBeVisible();
    expect(screen.queryByText(/waiting|snapshot|stale/i)).not.toBeInTheDocument();
  });

  describe("in the desktop app", () => {
    const desktopPicture = "data:image/jpeg;base64,ZGVza3RvcA==";
    const serverPicture = "data:image/jpeg;base64,AQID";
    const renderDesktop = (
      capture: (request: { contextId: string; threadId: string }) => Promise<string | undefined>,
      client: BrowserAutomationClient = clientOf(() => snapshot()),
    ) => {
      const hostBridge = { captureBrowserSurfacePreview: vi.fn(capture) };
      const view = render(
        <DockBrowserCard
          client={client}
          hostBridge={hostBridge}
          onClose={vi.fn()}
          onExpand={vi.fn()}
          pollIntervalMs={60_000}
          previewIntervalMs={20}
          threadId={threadId as never}
        />,
      );
      return { ...view, hostBridge };
    };
    const shownPicture = (container: HTMLElement) =>
      container.querySelector(".dock-mini-card__picture")?.getAttribute("src");

    it("shows the window's own picture of the page over the server's", async () => {
      const { container, hostBridge } = renderDesktop(async () => desktopPicture);
      await waitFor(() => expect(shownPicture(container)).toBe(desktopPicture));
      expect(hostBridge.captureBrowserSurfacePreview).toHaveBeenCalledWith({
        contextId,
        threadId,
      });
    });

    it("keeps the last picture while a refresh brings nothing new", async () => {
      let calls = 0;
      const { container, hostBridge } = renderDesktop(async () =>
        calls++ === 0 ? desktopPicture : undefined,
      );
      await waitFor(() => expect(shownPicture(container)).toBe(desktopPicture));
      await waitFor(() =>
        expect(hostBridge.captureBrowserSurfacePreview.mock.calls.length).toBeGreaterThan(2),
      );
      expect(shownPicture(container)).toBe(desktopPicture);
    });

    it("falls back to the server's picture when the desktop app refuses, and stops asking", async () => {
      const { container, hostBridge } = renderDesktop(async () => {
        throw new Error("Octant Browser preview does not own this context.");
      });
      await waitFor(() => expect(shownPicture(container)).toBe(serverPicture));
      // One refusal is not final (a card can mount before the window knows its
      // page); after three in a row it stops.
      await waitFor(() => expect(hostBridge.captureBrowserSurfacePreview).toHaveBeenCalledTimes(3));
      await new Promise((done) => setTimeout(done, 80));
      expect(hostBridge.captureBrowserSurfacePreview).toHaveBeenCalledTimes(3);
    });

    it("takes no picture while the window is hidden", async () => {
      const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      const { hostBridge } = renderDesktop(async () => desktopPicture);
      await new Promise((done) => setTimeout(done, 80));
      expect(hostBridge.captureBrowserSurfacePreview).not.toHaveBeenCalled();
      hidden.mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      await waitFor(() => expect(hostBridge.captureBrowserSurfacePreview).toHaveBeenCalled());
    });
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
