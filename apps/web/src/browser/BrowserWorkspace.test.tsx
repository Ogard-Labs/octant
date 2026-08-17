import {
  BrowserAutomationClientFailure,
  type BrowserAutomationClient,
} from "@octant/client-runtime/browser-automation-client";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BrowserWorkspace, boundsInsideViewport } from "./BrowserWorkspace";

const threadId = "10000000-0000-4000-8000-000000000001";
const authority = {
  hostId: "20000000-0000-4000-8000-000000000001",
  mode: "work",
  projectId: "30000000-0000-4000-8000-000000000001",
  rootId: "40000000-0000-4000-8000-000000000001",
  providerInstanceId: "50000000-0000-4000-8000-000000000001",
  extension: { kind: "core" as const },
};
const context = {
  contextId: "60000000-0000-4000-8000-000000000001",
  threadId,
  actionId: "70000000-0000-4000-8000-000000000001",
  correlationId: "80000000-0000-4000-8000-000000000001",
  authority,
  policy: {
    profileMode: "isolated" as const,
    allowedOrigins: ["https://example.com"],
    credentialFieldProtection: true,
    maxConcurrentTabs: 1,
    sessionTimeoutMs: 300_000,
  },
  state: "active" as const,
  createdAt: "2026-07-27T20:00:00.000Z",
};

function client(): BrowserAutomationClient {
  return {
    resolve: vi.fn(async () => ({ threadId, authority }) as any),
    create: vi.fn(async () => ({ status: "running", threadId, context, evidence: [] }) as any),
    inspect: vi.fn(async () => ({ status: "running", threadId, context, evidence: [] }) as any),
    inspectThread: vi.fn(async () => ({ status: "ready", threadId, evidence: [] }) as any),
    releaseThread: vi.fn(async () => ({ status: "ready", threadId, evidence: [] }) as any),
    act: vi.fn(
      async () =>
        ({
          status: "running",
          threadId,
          context,
          observation: {
            contextId: context.contextId,
            actionId: context.actionId,
            correlationId: context.correlationId,
            authority,
            url: "https://example.com/start",
            title: "Example",
            contentHash: "a".repeat(64),
            extractedText: "A bounded view of the current page.",
            revision: 8,
            screenshotDataUrl: "data:image/png;base64,AQID",
            observedAt: "2026-07-27T20:01:00.000Z",
            stale: false,
          },
          evidence: [{ reference: "browser-observation-evidence" }],
        }) as any,
    ),
    cancel: vi.fn(async () => ({ status: "interrupted", threadId, context, evidence: [] }) as any),
    stop: vi.fn(async () => ({ status: "ready", threadId, context, evidence: [] }) as any),
  };
}

const nativeSurfaceState = {
  contextId: context.contextId,
  url: "https://example.com/",
  title: "Example",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  control: "idle" as const,
};

function stubNativeSurfaceDom(): () => void {
  class NoopObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal("ResizeObserver", NoopObserver);
  vi.stubGlobal("IntersectionObserver", NoopObserver);
  const rects = vi
    .spyOn(HTMLElement.prototype, "getClientRects")
    .mockReturnValue({ length: 1 } as unknown as DOMRectList);
  return () => {
    rects.mockRestore();
    vi.unstubAllGlobals();
  };
}

describe("BrowserWorkspace", () => {
  it("keeps compact browser chrome ahead of the live or remote page surface", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles/shell.css"), "utf8");

    expect(styles.indexOf(".browser-workspace__chrome")).toBeGreaterThan(-1);
    expect(styles.indexOf(".browser-workspace__chrome")).toBeLessThan(
      styles.indexOf(".browser-workspace__native"),
    );
  });

  it("reattaches the authoritative current thread context without renderer-local identity", async () => {
    const browser = client();
    vi.mocked(browser.inspectThread).mockResolvedValueOnce({
      status: "running",
      threadId: threadId as any,
      context: context as any,
      evidence: [],
    });
    render(
      <BrowserWorkspace
        client={browser}
        tab={{
          kind: "browser",
          id: "90000000-0000-4000-8000-000000000010" as any,
          mode: "work",
          title: "Browser",
          threadId: threadId as any,
        }}
      />,
    );

    expect(await screen.findByRole("button", { name: "Stop" })).toBeVisible();
    expect(browser.inspectThread).toHaveBeenCalledWith({ threadId }, expect.any(AbortSignal));
    expect(browser.inspect).not.toHaveBeenCalled();
  });

  it("shows the one context its tab was opened for, not the thread's current one", async () => {
    // A Local servers tab is bound to the context that Open created,
    // so a later Open for another server cannot take this tab's page away.
    const browser = client();
    const ownContext = { ...context, contextId: "60000000-0000-4000-8000-000000000002" };
    vi.mocked(browser.inspect).mockResolvedValue({
      status: "running",
      threadId: threadId as any,
      context: ownContext as any,
      evidence: [],
    });
    render(
      <BrowserWorkspace
        client={browser}
        tab={{
          kind: "browser",
          id: "90000000-0000-4000-8000-000000000011" as any,
          mode: "code",
          title: "Browser",
          threadId: threadId as any,
          contextId: ownContext.contextId as any,
        }}
      />,
    );

    await waitFor(() =>
      expect(browser.inspect).toHaveBeenCalledWith(
        { contextId: ownContext.contextId, threadId },
        expect.any(AbortSignal),
      ),
    );
    expect(browser.inspectThread).not.toHaveBeenCalled();
  });

  it("refreshes when an agent creates or changes the thread-owned Browser context", async () => {
    const browser = client();
    vi.mocked(browser.inspectThread)
      .mockResolvedValueOnce({ status: "ready", threadId: threadId as any, evidence: [] })
      .mockResolvedValue({
        status: "running",
        threadId: threadId as any,
        context: context as any,
        observation: {
          contextId: context.contextId,
          actionId: context.actionId,
          correlationId: context.correlationId,
          authority,
          title: "Agent-updated page",
          url: "https://example.com/agent-updated",
          observedAt: "2026-07-27T20:01:00.000Z",
          stale: false,
        },
        evidence: [],
      } as any);

    render(
      <BrowserWorkspace
        client={browser}
        tab={{
          kind: "browser",
          id: "90000000-0000-4000-8000-000000000012" as any,
          mode: "work",
          title: "Browser",
          threadId: threadId as any,
        }}
      />,
    );

    expect(await screen.findByText("Agent-updated page", {}, { timeout: 2_000 })).toBeVisible();
    await waitFor(() =>
      expect(screen.getByLabelText("Browser URL")).toHaveValue("https://example.com/agent-updated"),
    );
    expect(browser.inspectThread).toHaveBeenCalledTimes(2);
  });

  it("renders unavailable truthfully when the tab has no owning thread", () => {
    render(
      <BrowserWorkspace
        client={client()}
        tab={{
          kind: "browser",
          id: "90000000-0000-4000-8000-000000000001" as any,
          mode: "work",
          title: "Browser",
        }}
      />,
    );
    expect(screen.getByText("Browser unavailable")).toBeInTheDocument();
  });

  it("creates a server-owned context and navigates through the normalized client", async () => {
    const browser = client();
    render(
      <BrowserWorkspace
        client={browser}
        tab={{
          kind: "browser",
          id: "90000000-0000-4000-8000-000000000001" as any,
          mode: "work",
          title: "Browser",
          threadId: threadId as any,
        }}
      />,
    );
    fireEvent.change(screen.getByLabelText("Browser URL"), {
      target: { value: "https://example.com/start" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start browser" }));
    await waitFor(() => expect(browser.create).toHaveBeenCalledOnce());
    await waitFor(() => expect(browser.act).toHaveBeenCalledOnce());
    expect(screen.getByText("Browser running")).toBeInTheDocument();
    expect(screen.getByText("Example")).toBeInTheDocument();
    fireEvent.submit(screen.getByRole("textbox", { name: "Browser URL" }).closest("form")!);
    await waitFor(() => expect(browser.act).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Selector")).not.toBeInTheDocument();
    expect(screen.queryByText("Value")).not.toBeInTheDocument();
  });

  it("shows security for the committed page instead of the editable address", async () => {
    const browser = client();
    vi.mocked(browser.inspectThread).mockResolvedValueOnce({
      status: "running",
      threadId: threadId as any,
      context: context as any,
      observation: {
        contextId: context.contextId,
        actionId: context.actionId,
        correlationId: context.correlationId,
        authority,
        url: "https://example.com/",
        observedAt: "2026-07-27T20:01:00.000Z",
        stale: false,
      },
      evidence: [],
    } as any);
    render(
      <BrowserWorkspace
        client={browser}
        tab={{
          kind: "browser",
          id: "90000000-0000-4000-8000-000000000016" as any,
          mode: "work",
          title: "Browser",
          threadId: threadId as any,
        }}
      />,
    );
    expect(await screen.findByLabelText("Secure HTTPS")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Browser URL"), {
      target: { value: "http://example.com" },
    });
    expect(screen.getByLabelText("Secure HTTPS")).toBeInTheDocument();
    expect(screen.queryByLabelText("Not secure HTTP")).not.toBeInTheDocument();
  });

  it("renders the host-owned screenshot preview inside the Browser tab", async () => {
    const browser = client();
    vi.mocked(browser.inspectThread).mockResolvedValueOnce({
      status: "running",
      threadId: threadId as any,
      context: context as any,
      observation: {
        contextId: context.contextId,
        actionId: context.actionId,
        correlationId: context.correlationId,
        authority,
        url: "https://example.com/start",
        title: "Example",
        contentHash: "a".repeat(64),
        screenshotDataUrl: "data:image/png;base64,AQID",
        observedAt: "2026-07-27T20:01:00.000Z",
        stale: false,
      },
      evidence: [],
    } as any);
    render(
      <BrowserWorkspace
        client={browser}
        tab={{
          kind: "browser",
          id: "90000000-0000-4000-8000-000000000010" as any,
          mode: "work",
          title: "Browser",
          threadId: threadId as any,
        }}
      />,
    );

    expect(await screen.findByRole("img", { name: "Example browser preview" })).toHaveAttribute(
      "src",
      "data:image/png;base64,AQID",
    );
  });

  it("renders the authoritative headless fallback when native routing was unavailable", async () => {
    const browser = client();
    const attachBrowserSurface = vi.fn(async () => ({}) as any);
    vi.mocked(browser.inspectThread).mockResolvedValueOnce({
      status: "running",
      threadId: threadId as any,
      context: { ...context, presentation: "headless" } as any,
      observation: {
        contextId: context.contextId,
        actionId: context.actionId,
        correlationId: context.correlationId,
        authority,
        revision: 1,
        screenshotDataUrl: "data:image/png;base64,AQID",
        observedAt: "2026-07-27T20:01:00.000Z",
        stale: false,
      },
      evidence: [],
    } as any);
    render(
      <BrowserWorkspace
        client={browser}
        hostBridge={
          {
            attachBrowserSurface,
            detachBrowserSurface: vi.fn(async () => undefined),
            getHostCapabilities: vi.fn(async () => ({ liveBrowserSupported: true }) as any),
            updateBrowserSurfaceBounds: vi.fn(async () => undefined),
          } as any
        }
        tab={{
          kind: "browser",
          id: "90000000-0000-4000-8000-000000000019" as any,
          mode: "work",
          title: "Browser",
          threadId: threadId as any,
        }}
      />,
    );

    expect(
      await screen.findByRole("application", { name: "Interactive headless Browser preview" }),
    ).toBeVisible();
    expect(attachBrowserSurface).not.toHaveBeenCalled();
  });

  it("routes web preview pointer, keyboard, and wheel input through the owned context", async () => {
    const browser = client();
    vi.mocked(browser.inspectThread).mockResolvedValueOnce({
      status: "running",
      threadId: threadId as any,
      context: context as any,
      observation: {
        contextId: context.contextId,
        actionId: context.actionId,
        correlationId: context.correlationId,
        authority,
        url: "https://example.com/start",
        title: "Example",
        revision: 7,
        screenshotDataUrl: "data:image/png;base64,AQID",
        observedAt: "2026-07-27T20:01:00.000Z",
        stale: false,
      },
      evidence: [],
    } as any);
    render(
      <BrowserWorkspace
        client={browser}
        tab={{
          kind: "browser",
          id: "90000000-0000-4000-8000-000000000018" as any,
          mode: "work",
          title: "Browser",
          threadId: threadId as any,
        }}
      />,
    );

    const preview = await screen.findByRole("img", { name: "Example browser preview" });
    Object.defineProperties(preview, {
      naturalWidth: { configurable: true, value: 1280 },
      naturalHeight: { configurable: true, value: 720 },
    });
    vi.spyOn(preview, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 640,
      bottom: 360,
      width: 640,
      height: 360,
      toJSON: () => undefined,
    });
    const surface = screen.getByRole("application", {
      name: "Interactive headless Browser preview",
    });

    fireEvent.click(preview, { clientX: 320, clientY: 180 });
    await waitFor(() =>
      expect(browser.act).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "click",
          point: { x: 0.5, y: 0.5 },
          expectedObservationRevision: 7,
        }),
      ),
    );

    fireEvent.keyDown(surface, { key: "h" });
    fireEvent.keyDown(surface, { key: "Enter" });
    fireEvent.wheel(surface, { deltaY: 240 });
    await waitFor(() => {
      expect(browser.act).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "type", value: "h" }),
      );
      expect(browser.act).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "press", value: "Enter" }),
      );
      expect(browser.act).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "scroll", deltaY: 240 }),
      );
    });
  });

  it("reloads the headless page through the authoritative Browser action", async () => {
    const browser = client();
    vi.mocked(browser.inspectThread).mockResolvedValueOnce({
      status: "running",
      threadId: threadId as any,
      context: context as any,
      evidence: [],
    } as any);
    render(
      <BrowserWorkspace
        client={browser}
        tab={{
          kind: "browser",
          id: "90000000-0000-4000-8000-000000000015" as any,
          mode: "work",
          title: "Browser",
          threadId: threadId as any,
        }}
      />,
    );

    expect(await screen.findByRole("button", { name: "Stop" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() =>
      expect(browser.act).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "navigate", target: "https://example.com/" }),
      ),
    );
  });

  it("hands the committed HTTP address to the desktop default browser", async () => {
    const browser = client();
    const openBrowserExternal = vi.fn(async () => undefined);
    vi.mocked(browser.inspectThread).mockResolvedValueOnce({
      status: "running",
      threadId: threadId as any,
      context: context as any,
      observation: {
        contextId: context.contextId,
        actionId: context.actionId,
        correlationId: context.correlationId,
        authority,
        url: "https://example.com/current",
        observedAt: "2026-07-27T20:01:00.000Z",
        stale: false,
      },
      evidence: [],
    } as any);
    render(
      <BrowserWorkspace
        client={browser}
        hostBridge={{ openBrowserExternal } as any}
        tab={{
          kind: "browser",
          id: "90000000-0000-4000-8000-000000000017" as any,
          mode: "work",
          title: "Browser",
          threadId: threadId as any,
        }}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open in default browser" }));
    await waitFor(() =>
      expect(openBrowserExternal).toHaveBeenCalledWith("https://example.com/current"),
    );
  });

  it("creates only one browser context while startup is in flight", async () => {
    const browser = client();
    let release!: (scope: { threadId: string; authority: typeof authority }) => void;
    vi.mocked(browser.resolve).mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }) as never,
    );
    render(
      <BrowserWorkspace
        client={browser}
        tab={{
          kind: "browser",
          id: "90000000-0000-4000-8000-000000000002" as any,
          mode: "work",
          title: "Browser",
          threadId: threadId as any,
        }}
      />,
    );

    const start = screen.getByRole("button", { name: "Start browser" });
    fireEvent.click(start);
    fireEvent.click(start);
    expect(browser.resolve).toHaveBeenCalledOnce();

    release({ threadId, authority });
    await waitFor(() => expect(browser.create).toHaveBeenCalledOnce());
  });

  it("surfaces invalid addresses without starting or throwing from the event handler", async () => {
    const browser = client();
    render(
      <BrowserWorkspace
        client={browser}
        tab={{
          kind: "browser",
          id: "90000000-0000-4000-8000-000000000018" as any,
          mode: "work",
          title: "Browser",
          threadId: threadId as any,
        }}
      />,
    );
    fireEvent.change(screen.getByLabelText("Browser URL"), {
      target: { value: "https://exa mple.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start browser" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter a valid HTTP or HTTPS address.",
    );
    expect(browser.create).not.toHaveBeenCalled();
  });

  it("keeps cleanup controls available after an action fails closed", async () => {
    const browser = client();
    vi.mocked(browser.act).mockRejectedValueOnce(
      new BrowserAutomationClientFailure(
        "credential-protected",
        "Octant will not type into a sensitive or credential field.",
      ),
    );
    render(
      <BrowserWorkspace
        client={browser}
        tab={{
          kind: "browser",
          id: "90000000-0000-4000-8000-000000000001" as any,
          mode: "work",
          title: "Browser",
          threadId: threadId as any,
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start browser" }));
    await screen.findByText("Browser failed");
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
  });

  it("preserves a failed start message across background inspection polling", async () => {
    const browser = client();
    vi.mocked(browser.create).mockRejectedValueOnce(
      new BrowserAutomationClientFailure("unavailable", "The host browser could not start."),
    );
    render(
      <BrowserWorkspace
        client={browser}
        tab={{
          kind: "browser",
          id: "90000000-0000-4000-8000-000000000013" as any,
          mode: "work",
          title: "Browser",
          threadId: threadId as any,
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Start browser" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The host browser could not start.");
    await waitFor(() => expect(browser.inspectThread).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    expect(screen.getByRole("alert")).toHaveTextContent("The host browser could not start.");
    expect(screen.getByText("Browser unavailable")).toBeVisible();
  });

  it("clears a local failure when an agent advances the authoritative Browser context", async () => {
    const browser = client();
    vi.mocked(browser.inspectThread)
      .mockResolvedValueOnce({ status: "ready", threadId: threadId as any, evidence: [] } as any)
      .mockResolvedValue({
        status: "running",
        threadId: threadId as any,
        context: context as any,
        observation: {
          contextId: context.contextId,
          actionId: context.actionId,
          correlationId: context.correlationId,
          authority,
          title: "Agent recovered page",
          observedAt: "2026-07-27T20:02:00.000Z",
          stale: false,
        },
        evidence: [{ reference: "agent-recovery" }],
      } as any);
    vi.mocked(browser.act)
      .mockResolvedValueOnce({
        status: "running",
        threadId: threadId as any,
        context: context as any,
        evidence: [],
      } as any)
      .mockRejectedValueOnce(
        new BrowserAutomationClientFailure("failed", "The local Browser action failed."),
      );
    render(
      <BrowserWorkspace
        client={browser}
        tab={{
          kind: "browser",
          id: "90000000-0000-4000-8000-000000000014" as any,
          mode: "work",
          title: "Browser",
          threadId: threadId as any,
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start browser" }));
    await screen.findByText("Browser running");
    fireEvent.submit(screen.getByRole("textbox", { name: "Browser URL" }).closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent("The local Browser action failed.");

    expect(await screen.findByText("Agent recovered page", {}, { timeout: 2_000 })).toBeVisible();
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByText("Browser running")).toBeVisible();
  });

  it("detaches the native surface when an in-flight attach resolves after unmount", async () => {
    const restoreDom = stubNativeSurfaceDom();
    try {
      const browser = client();
      vi.mocked(browser.inspectThread).mockResolvedValue({
        status: "running",
        threadId: threadId as any,
        context: context as any,
        evidence: [],
      } as any);
      const attachResolvers: Array<(state: unknown) => void> = [];
      const attachBrowserSurface = vi.fn(
        () =>
          new Promise((resolve) => {
            attachResolvers.push(resolve);
          }),
      );
      const detachBrowserSurface = vi.fn(async () => undefined);
      const view = render(
        <BrowserWorkspace
          client={browser}
          hostBridge={
            {
              attachBrowserSurface,
              detachBrowserSurface,
              getHostCapabilities: vi.fn(async () => ({ liveBrowserSupported: true }) as any),
              updateBrowserSurfaceBounds: vi.fn(async () => undefined),
            } as any
          }
          tab={{
            kind: "browser",
            id: "90000000-0000-4000-8000-000000000020" as any,
            mode: "work",
            title: "Browser",
            threadId: threadId as any,
          }}
        />,
      );

      await waitFor(() => expect(attachBrowserSurface).toHaveBeenCalled());
      view.unmount();
      expect(detachBrowserSurface).not.toHaveBeenCalled();

      for (const resolve of attachResolvers) resolve(nativeSurfaceState);
      await waitFor(() =>
        expect(detachBrowserSurface).toHaveBeenCalledWith({
          contextId: context.contextId,
          threadId,
        }),
      );
    } finally {
      restoreDom();
    }
  });

  it.each(["workspace-drag-preview", "workspace-drop-overlay", "octant-dialog__backdrop"])(
    "detaches the native surface while the .%s renderer overlay is present",
    async (overlayClass) => {
      const restoreDom = stubNativeSurfaceDom();
      const overlay = document.createElement("div");
      try {
        let notifyOverlayMutation: (() => void) | undefined;
        class ControlledMutationObserver {
          constructor(callback: MutationCallback) {
            notifyOverlayMutation = () => callback([], this as unknown as MutationObserver);
          }
          observe(): void {}
          disconnect(): void {}
          takeRecords(): MutationRecord[] {
            return [];
          }
        }
        vi.stubGlobal("MutationObserver", ControlledMutationObserver);
        const browser = client();
        vi.mocked(browser.inspectThread).mockResolvedValue({
          status: "running",
          threadId: threadId as any,
          context: context as any,
          evidence: [],
        } as any);
        const attachResolvers: Array<(state: unknown) => void> = [];
        const attachBrowserSurface = vi.fn(
          () =>
            new Promise((resolve) => {
              attachResolvers.push(resolve);
            }),
        );
        const detachBrowserSurface = vi.fn(async () => undefined);
        render(
          <BrowserWorkspace
            client={browser}
            hostBridge={
              {
                attachBrowserSurface,
                detachBrowserSurface,
                getHostCapabilities: vi.fn(async () => ({ liveBrowserSupported: true }) as any),
                updateBrowserSurfaceBounds: vi.fn(async () => undefined),
              } as any
            }
            tab={{
              kind: "browser",
              id: "90000000-0000-4000-8000-000000000021" as any,
              mode: "work",
              title: "Browser",
              threadId: threadId as any,
            }}
          />,
        );

        expect(await screen.findByText("Shared live page")).toBeInTheDocument();
        await waitFor(() => expect(attachBrowserSurface).toHaveBeenCalled());
        overlay.className = overlayClass;
        await act(async () => {
          document.body.appendChild(overlay);
          notifyOverlayMutation?.();
          await Promise.resolve();
        });
        for (const resolve of attachResolvers) resolve(nativeSurfaceState);
        await waitFor(() =>
          expect(detachBrowserSurface).toHaveBeenCalledWith({
            contextId: context.contextId,
            threadId,
          }),
        );
      } finally {
        overlay.remove();
        restoreDom();
      }
    },
  );

  it("reloads the committed headless address instead of the draft omnibox value", async () => {
    const browser = client();
    vi.mocked(browser.inspectThread).mockResolvedValue({
      status: "running",
      threadId: threadId as any,
      context: context as any,
      observation: {
        contextId: context.contextId,
        actionId: context.actionId,
        correlationId: context.correlationId,
        authority,
        url: "https://example.com/committed",
        observedAt: "2026-07-27T20:01:00.000Z",
        stale: false,
      },
      evidence: [],
    } as any);
    render(
      <BrowserWorkspace
        client={browser}
        tab={{
          kind: "browser",
          id: "90000000-0000-4000-8000-000000000022" as any,
          mode: "work",
          title: "Browser",
          threadId: threadId as any,
        }}
      />,
    );

    expect(await screen.findByRole("button", { name: "Stop" })).toBeVisible();
    fireEvent.change(screen.getByLabelText("Browser URL"), {
      target: { value: "https://example.com/draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() =>
      expect(browser.act).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "navigate", target: "https://example.com/committed" }),
      ),
    );
  });

  it("keeps native surface bounds inside the window even when the pane edges are fractional", () => {
    // Rounding left up and width up used to overflow the window by one pixel,
    // which the host rejects as bounds outside the owning window.
    expect(
      boundsInsideViewport({ left: 1146.5, top: 60.5, right: 2000, bottom: 982 }, 2000, 982),
    ).toEqual({ x: 1146, y: 60, width: 854, height: 922 });
    // A pane flush with the top stays below the host's reserved strip.
    const top = boundsInsideViewport({ left: 0, top: 10, right: 800, bottom: 600 }, 800, 600);
    expect(top).toEqual({ x: 0, y: 36, width: 800, height: 564 });
    // Overflowing edges are clamped rather than reported past the window.
    const over = boundsInsideViewport({ left: 10, top: 40, right: 810.7, bottom: 620 }, 800, 600);
    expect(over.x + over.width).toBe(800);
    expect(over.y + over.height).toBe(600);
  });
});
