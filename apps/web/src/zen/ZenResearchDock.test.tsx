import type { BrowserAutomationClient } from "@octant/client-runtime/browser-automation-client";
import type { ZenResearchDock as ZenResearchDockBinding } from "@octant/contracts/zen";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ZenResearchDock } from "./ZenResearchDock";
import type { BrowserSurfaceState, OctantHostBridge } from "../shell/hostBridge";

const threadId = "10000000-0000-4000-8000-000000000001";
const contextId = "60000000-0000-4000-8000-000000000001";
const authority = {
  hostId: "20000000-0000-4000-8000-000000000001",
  mode: "work",
  projectId: "30000000-0000-4000-8000-000000000001",
  rootId: "40000000-0000-4000-8000-000000000001",
  providerInstanceId: "50000000-0000-4000-8000-000000000001",
  extension: { kind: "core" as const },
};
const context = {
  contextId,
  threadId,
  actionId: "70000000-0000-4000-8000-000000000001",
  correlationId: "80000000-0000-4000-8000-000000000001",
  authority,
  policy: {
    profileMode: "isolated" as const,
    allowedOrigins: ["https://example.com"],
    credentialFieldProtection: true,
    maxConcurrentTabs: 8,
    sessionTimeoutMs: 600_000,
  },
  state: "active" as const,
  createdAt: "2026-08-18T20:00:00.000Z",
};

const dock: ZenResearchDockBinding = {
  sourceContext: {
    hostId: "20000000-0000-4000-8000-000000000001",
    mode: "work",
    projectId: "30000000-0000-4000-8000-000000000001",
    threadKind: "work",
    threadId,
  },
  width: 480,
  collapsed: false,
} as ZenResearchDockBinding;

function client(): BrowserAutomationClient {
  const snapshot = { status: "running", threadId, context, evidence: [] };
  return {
    resolve: vi.fn(async () => ({ threadId, authority }) as never),
    create: vi.fn(async () => snapshot as never),
    inspect: vi.fn(async () => snapshot as never),
    inspectThread: vi.fn(async () => snapshot as never),
    releaseThread: vi.fn(async () => snapshot as never),
    act: vi.fn(async () => snapshot as never),
    cancel: vi.fn(async () => snapshot as never),
    stop: vi.fn(async () => snapshot as never),
  };
}

const twoTabs: BrowserSurfaceState = {
  contextId,
  url: "https://example.com/a",
  title: "First",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  control: "user",
  tabs: [
    { tabId: `${contextId}:1`, url: "https://example.com/a", title: "First" },
    { tabId: `${contextId}:2`, url: "https://example.com/b", title: "Second" },
  ],
  activeTabId: `${contextId}:2`,
};

function hostBridge(overrides: Partial<OctantHostBridge> = {}): OctantHostBridge {
  class NoopObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal("ResizeObserver", NoopObserver);
  vi.stubGlobal("IntersectionObserver", NoopObserver);
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue({
    length: 1,
  } as unknown as DOMRectList);
  return {
    attachBrowserSurface: vi.fn(async () => twoTabs),
    updateBrowserSurfaceBounds: vi.fn(async () => undefined),
    detachBrowserSurface: vi.fn(async () => undefined),
    getHostCapabilities: () => ({ sidebarVibrancySupported: false, liveBrowserSupported: true }),
    clearProviderCredential: vi.fn(async () => undefined),
    close: vi.fn(),
    maximizeOrRestore: vi.fn(),
    minimize: vi.fn(),
    ...overrides,
  } as unknown as OctantHostBridge;
}

describe("ZenResearchDock", () => {
  it("moves the browser surface when its header is dragged", () => {
    render(
      <ZenResearchDock
        client={client()}
        dock={dock}
        hostBridge={hostBridge()}
        onCollapse={vi.fn()}
        onUndock={vi.fn()}
      />,
    );

    const browser = screen.getByRole("complementary", { name: "Research browser" });
    const header = screen.getByText("Research").closest("header");
    if (header === null) throw new Error("Research browser header was not rendered.");

    fireEvent.pointerDown(header, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(header, { clientX: 140, clientY: 140, pointerId: 1 });
    fireEvent.pointerUp(header, { clientX: 140, clientY: 140, pointerId: 1 });

    expect(browser).toHaveStyle({ transform: "translate(40px, 40px)" });
  });

  it("lists the pages the host has open rather than tabs of its own making", async () => {
    const tabBrowserSurface = vi.fn(async () => twoTabs);
    render(
      <ZenResearchDock
        client={client()}
        dock={dock}
        hostBridge={hostBridge({ tabBrowserSurface })}
        onCollapse={vi.fn()}
        onUndock={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open page" }));

    await waitFor(() =>
      expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["First", "Second"]),
    );
    expect(screen.getAllByRole("tab")[1]?.getAttribute("aria-selected")).toBe("true");
  });

  it("asks the host to open a tab instead of arranging one in the renderer", async () => {
    // Tabs are real pages of one browsing context, so they share its session
    // and its origin approval. A tab the renderer invented would share
    // neither.
    const tabBrowserSurface = vi.fn(async () => twoTabs);
    render(
      <ZenResearchDock
        client={client()}
        dock={dock}
        hostBridge={hostBridge({ tabBrowserSurface })}
        onCollapse={vi.fn()}
        onUndock={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Open page" }));

    fireEvent.click(await screen.findByRole("button", { name: "Open a new research tab" }));

    await waitFor(() =>
      expect(tabBrowserSurface).toHaveBeenCalledWith({
        contextId,
        threadId,
        command: { kind: "open" },
      }),
    );
  });

  it("renders the shared headless Browser on authenticated web and stops it on unmount", async () => {
    const browser = client();
    const { unmount } = render(
      <ZenResearchDock
        client={browser}
        dock={dock}
        hostBridge={hostBridge({
          getHostCapabilities: () => ({
            sidebarVibrancySupported: false,
            liveBrowserSupported: false,
          }),
        })}
        onCollapse={vi.fn()}
        onUndock={vi.fn()}
        serverUrl="http://127.0.0.1:13773"
        windowCapability="fixture-capability"
      />,
    );

    expect(await screen.findByLabelText("Browser URL")).toBeVisible();
    expect(
      screen.queryByText("A research page needs the Octant desktop app on this host."),
    ).not.toBeInTheDocument();

    unmount();
    await waitFor(() => expect(browser.stop).toHaveBeenCalledOnce());
  });
});
