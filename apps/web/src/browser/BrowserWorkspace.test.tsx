import { decodeBrowserAutomationSnapshot } from "@octant/contracts/browser-automation-rpc";
import { decodeBrowserCredentialResult } from "@octant/contracts/browser-credential-use";
import {
  BrowserAutomationClientFailure,
  type BrowserAutomationClient,
} from "@octant/client-runtime/browser-automation-client";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { threadImageOffers } from "../composer/threadImageOffers";
import { BrowserWorkspace, RENDERER_OVERLAY_SELECTOR } from "./BrowserWorkspace";
import { boundsInsideViewport } from "./useNativeBrowserSurface";

/** The toolbar's trailing more menu holds the actions that have no button of their own. */
async function openMore(): Promise<void> {
  await userEvent.click(await screen.findByRole("button", { name: "More Browser actions" }));
}
async function chooseMoreAction(name: string): Promise<void> {
  await openMore();
  await userEvent.click(await screen.findByRole("menuitem", { name }));
}
/** What the more menu offers now; the menu is closed again afterwards. */
async function moreActionNames(): Promise<ReadonlyArray<string>> {
  await openMore();
  const names = (await screen.findAllByRole("menuitem")).map((item) => {
    const labelled = item.getAttribute("aria-labelledby");
    return (
      (labelled === null ? null : document.getElementById(labelled)?.textContent) ??
      item.getAttribute("aria-label") ??
      item.textContent ??
      ""
    );
  });
  await userEvent.keyboard("{Escape}");
  return names;
}

const localServers = vi.hoisted(() => ({
  snapshot: undefined as unknown,
  open: async (_listenerId: string): Promise<unknown> => undefined,
}));
vi.mock("../environment/useLocalServersController", () => ({
  useLocalServersController: () => ({
    status: "ready",
    snapshot: localServers.snapshot,
    open: (listenerId: string) => localServers.open(listenerId),
  }),
}));

const pointing = vi.hoisted(() => ({
  armed: false,
  lastReason: undefined as string | undefined,
}));
vi.mock("./useBrowserFeedbackPointing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./useBrowserFeedbackPointing")>();
  return {
    ...actual,
    useBrowserFeedbackPointing: (
      input: Parameters<typeof actual.useBrowserFeedbackPointing>[0],
    ) => {
      pointing.lastReason = input.unavailableReason;
      const real = actual.useBrowserFeedbackPointing(input);
      return pointing.armed ? { ...real, pointing: true } : real;
    },
  };
});

// jsdom has no 2D canvas, so the export is stood in for; its plan and painting
// are tested in markupExport.test.ts.
vi.mock("./markupExport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./markupExport")>();
  return {
    ...actual,
    exportMarkedPicture: vi.fn(async () => new Blob(["png"], { type: "image/png" })),
  };
});

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
  // Opening a page records it as recent; a later test must not start from it.
  afterEach(() => globalThis.localStorage.clear());

  it("discards a prior host's availability before the replacement host answers", async () => {
    const browser = client();
    vi.mocked(browser.inspectThread).mockResolvedValue(
      decodeBrowserAutomationSnapshot({
        status: "ready",
        threadId,
        evidence: [],
        agentAvailability: { status: "available", readOnly: false },
      }),
    );
    const tab = {
      kind: "browser",
      id: "90000000-0000-4000-8000-000000000010",
      mode: "work",
      title: "Browser",
      threadId,
    } as const;
    const view = render(<BrowserWorkspace client={browser} tab={tab as never} />);
    // With no page open the sentence rides on the profile icon's tooltip.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Browser profile/ })).toHaveAttribute(
        "title",
        expect.stringContaining("Agent can use this Browser."),
      ),
    );
    expect(screen.queryByRole("img", { name: /idle/ })).toBeNull();
    const disconnected = client();
    vi.mocked(disconnected.inspectThread).mockRejectedValue(new Error("disconnected"));
    view.rerender(<BrowserWorkspace client={disconnected} tab={tab as never} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Browser profile/ })).toHaveAttribute(
        "title",
        expect.stringContaining("Browser availability is unknown."),
      ),
    );
  });
  it("keeps an invalid host response inside polling failure handling", async () => {
    const browser = client();
    vi.mocked(browser.inspectThread).mockResolvedValue(undefined as never);
    render(
      <BrowserWorkspace
        client={browser}
        tab={{ kind: "browser", id: threadId, mode: "work", title: "Browser", threadId } as never}
      />,
    );
    expect(await screen.findByRole("button", { name: /^Browser profile/ })).toHaveAttribute(
      "title",
      expect.stringContaining("Browser availability is unknown."),
    );
    await waitFor(() => expect(browser.inspectThread).toHaveBeenCalled());
    expect(screen.getByRole("region", { name: "Browser automation" })).toBeVisible();
  });
  it("keeps compact browser chrome ahead of the live or remote page surface", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles/shell.css"), "utf8");

    expect(styles.indexOf(".browser-workspace__chrome")).toBeGreaterThan(-1);
    expect(styles.indexOf(".browser-workspace__chrome")).toBeLessThan(
      styles.indexOf(".browser-workspace__native"),
    );
  });

  it("draws the address field with the control corner and the field border, and no pill", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles/shell.css"), "utf8");
    const field = styles.match(/\.browser-workspace__field \{([^}]*)\}/)?.[1] ?? "";

    expect(field).toMatch(/border-radius:\s*var\(--oct-radius-sm\)/);
    expect(field).toMatch(/border:\s*1px solid var\(--input\)/);
    expect(field).toMatch(/min-width:\s*120px/);
    for (const selector of [
      ".browser-workspace__chrome",
      ".browser-workspace__field",
      ".browser-workspace__status",
      ".browser-workspace__mark",
    ]) {
      const rule = styles.match(new RegExp(`${selector.replace(".", "\\.")} \\{([^}]*)\\}`))?.[1];
      expect(rule, selector).toBeDefined();
      expect(rule).not.toMatch(/radius-pill/);
    }
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

    expect(await screen.findByRole("button", { name: "More Browser actions" })).toBeVisible();
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

  it("starts a repeated Browser tab fresh and reports the context it creates", async () => {
    const browser = client();
    const onContextCreated = vi.fn();
    vi.mocked(browser.inspectThread).mockResolvedValue(
      decodeBrowserAutomationSnapshot({
        status: "running",
        threadId,
        context,
        evidence: [],
        agentAvailability: { status: "omitted", reason: "no-tool-transport" },
      }),
    );
    render(
      <BrowserWorkspace
        client={browser}
        onContextCreated={onContextCreated}
        startFresh
        tab={{
          kind: "browser",
          id: "90000000-0000-4000-8000-000000000099" as any,
          mode: "code",
          title: "Browser 2",
          threadId: threadId as any,
        }}
      />,
    );

    await act(async () => undefined);
    expect(await screen.findByText(/provider has no supported tool transport/)).toBeVisible();
    expect(browser.inspectThread).toHaveBeenCalledWith(
      { threadId, freshPicture: false },
      expect.any(AbortSignal),
    );
    expect(screen.getByRole("button", { name: "Start browser" })).toBeDisabled();
    expect(onContextCreated).not.toHaveBeenCalled();
    enterAddress("https://example.com");
    fireEvent.click(screen.getByRole("button", { name: "Start browser" }));
    await waitFor(() => expect(onContextCreated).toHaveBeenCalledWith(context.contextId));
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

  it("offers the checkout's running servers and opens the one the person picks as the host prepared it", async () => {
    const listener = (port: number, extra: object) => ({
      listenerId: `lsn_${String(port).padStart(32, "0")}`,
      port,
      url: `http://localhost:${port}/`,
      processName: "node",
      attribution: "current-checkout",
      startSource: "terminal",
      bindScope: "loopback",
      health: "listening",
      openAvailable: true,
      stop: { kind: "unavailable" },
      ...extra,
    });
    localServers.snapshot = {
      threadId,
      projectId: authority.projectId,
      currentCheckout: [
        listener(5173, { framework: "vite" }),
        listener(9229, { health: "unresponsive", openAvailable: false }),
      ],
      // An HTTPS dev server on a self-signed localhost certificate.
      other: [listener(3000, { framework: "next", url: "https://localhost:3000/" })],
      observedAt: "2026-07-27T20:00:00.000Z",
    };
    const opened: string[] = [];
    localServers.open = async (listenerId) => {
      opened.push(listenerId);
      return {
        url: "https://localhost:3000/",
        allowedOrigin: "https://localhost:3000",
        acceptsLocalCertificate: true,
      };
    };
    const browser = client();
    try {
      render(
        <BrowserWorkspace
          client={browser}
          projectId={authority.projectId as any}
          tab={{
            kind: "browser",
            id: "90000000-0000-4000-8000-000000000040" as any,
            mode: "code",
            title: "Browser",
            threadId: threadId as any,
          }}
        />,
      );

      expect(screen.getByRole("textbox", { name: "Browser URL" })).toHaveValue(
        "http://localhost:5173/",
      );
      const servers = screen.getByRole("list", { name: "Running servers" });
      expect(
        Array.from(servers.querySelectorAll("button"), (row) => row.getAttribute("aria-label")),
      ).toEqual(["Open vite at localhost:5173", "Open next at localhost:3000"]);

      fireEvent.click(screen.getByRole("button", { name: "Open next at localhost:3000" }));
      await waitFor(() =>
        expect(browser.create).toHaveBeenCalledWith(
          expect.objectContaining({
            policy: expect.objectContaining({
              allowedOrigins: ["https://localhost:3000"],
              acceptsLocalCertificate: true,
            }),
          }),
        ),
      );
      expect(opened).toEqual([`lsn_${"3000".padStart(32, "0")}`]);
    } finally {
      localServers.snapshot = undefined;
      localServers.open = async () => undefined;
    }
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
      target: { value: "https://example.com/deeply/nested/start" },
    });
    const address = screen.getByTitle("https://example.com/deeply/nested/start");
    expect(address.querySelector(".middle-truncated-text__head")).toHaveTextContent(
      "https://example.com/deeply/nested/",
    );
    expect(address.querySelector(".middle-truncated-text__tail")).toHaveTextContent("start");
    expect(screen.getByRole("textbox", { name: "Browser URL" })).toHaveValue(
      "https://example.com/deeply/nested/start",
    );
    expect(screen.getByRole("textbox", { name: "Browser URL" }).closest("form")).toHaveAttribute(
      "novalidate",
    );
    fireEvent.click(screen.getByRole("button", { name: "Start browser" }));
    await waitFor(() => expect(browser.create).toHaveBeenCalledOnce());
    await waitFor(() => expect(browser.act).toHaveBeenCalledOnce());
    expect(screen.getByText("Browser running")).toBeInTheDocument();
    // The committed page is what a later Browser offers under Recent.
    await waitFor(() =>
      expect(
        JSON.parse(globalThis.localStorage.getItem("octant.browser.recent-pages.v1") ?? "[]"),
      ).toEqual([expect.objectContaining({ url: expect.stringMatching(/^https?:/) })]),
    );
    expect(screen.getByText("Example")).toBeInTheDocument();
    fireEvent.submit(screen.getByRole("textbox", { name: "Browser URL" }).closest("form")!);
    await waitFor(() => expect(browser.act).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Selector")).not.toBeInTheDocument();
    expect(screen.queryByText("Value")).not.toBeInTheDocument();
  });

  it("offers the pages opened before on its start page and opens the one the person picks", async () => {
    globalThis.localStorage.setItem(
      "octant.browser.recent-pages.v1",
      JSON.stringify([{ url: "https://example.com/docs", openedAt: "2026-10-22T08:00:00.000Z" }]),
    );
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
    const recent = screen.getByRole("region", { name: "Recent pages" });
    fireEvent.click(within(recent).getByRole("button", { name: "Open example.com/docs" }));
    await waitFor(() => expect(browser.create).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(browser.act).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "navigate", target: "https://example.com/docs" }),
      ),
    );
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

    expect(await screen.findByRole("button", { name: "More Browser actions" })).toBeVisible();
    enterAddress("https://example.com");
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() =>
      expect(browser.act).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "navigate", target: "https://example.com/" }),
      ),
    );
  });

  describe("Screenshot control", () => {
    const tab = {
      kind: "browser" as const,
      id: "90000000-0000-4000-8000-000000000031" as any,
      mode: "work" as const,
      title: "Browser",
      threadId: threadId as any,
    };
    const observation = (extra: object = {}) => ({
      contextId: context.contextId,
      actionId: context.actionId,
      correlationId: context.correlationId,
      authority,
      url: "https://example.com/current",
      observedAt: "2026-07-27T20:01:00.000Z",
      stale: false,
      ...extra,
    });

    function withContext(takeCapture?: BrowserAutomationClient["takeCapture"]) {
      const browser = client();
      vi.mocked(browser.inspectThread).mockResolvedValue({
        status: "running",
        threadId: threadId as any,
        context: { ...context, presentation: "headless" } as any,
        observation: observation() as any,
        evidence: [],
      } as any);
      if (takeCapture !== undefined) browser.takeCapture = takeCapture;
      return browser;
    }

    it("keeps a capture through takeCapture and leaves Refresh preview as an ordinary action", async () => {
      const takeCapture = vi.fn(
        async () =>
          ({
            status: "running",
            threadId,
            context,
            observation: observation({
              capture: { status: "kept", captureId: "a0000000-0000-4000-8000-000000000001" },
            }),
            evidence: [],
          }) as any,
      );
      const browser = withContext(takeCapture);
      render(<BrowserWorkspace client={browser} tab={tab} />);

      await chooseMoreAction("Screenshot");
      await waitFor(() =>
        expect(takeCapture).toHaveBeenCalledWith({
          threadId,
          request: expect.objectContaining({ kind: "screenshot", contextId: context.contextId }),
        }),
      );
      expect(browser.act).not.toHaveBeenCalled();

      fireEvent.click(await screen.findByRole("button", { name: "Refresh preview" }));
      await waitFor(() =>
        expect(browser.act).toHaveBeenCalledWith(expect.objectContaining({ kind: "screenshot" })),
      );
      expect(takeCapture).toHaveBeenCalledOnce();
    });

    it("says why a screenshot was not kept without blocking the page", async () => {
      const takeCapture = vi.fn(
        async () =>
          ({
            status: "running",
            threadId,
            context,
            observation: observation({ capture: { status: "not-kept", reason: "too-large" } }),
            evidence: [],
          }) as any,
      );
      render(<BrowserWorkspace client={withContext(takeCapture)} tab={tab} />);
      await chooseMoreAction("Screenshot");
      expect(
        await screen.findByText("This screenshot could not be kept: the picture is too large."),
      ).toBeVisible();
      // The pane gives a notice its own row only under this class; without it
      // the page picture is drawn over the notice.
      expect(screen.getByRole("region", { name: "Browser automation" })).toHaveClass(
        "browser-workspace--message",
      );
      expect(await moreActionNames()).toContain("Screenshot");
    });

    it("is absent when the client cannot keep a capture", async () => {
      render(<BrowserWorkspace client={withContext()} tab={tab} />);
      expect(await screen.findByRole("button", { name: "More Browser actions" })).toBeVisible();
      expect(await moreActionNames()).not.toContain("Screenshot");
    });
    describe("Draw on page", () => {
      const captureId = "a0000000-0000-4000-8000-000000000002";
      const pictureUrl = "data:image/png;base64,iVBORw0KGgo=";
      const originalImage = globalThis.Image;

      class LoadedImage {
        naturalWidth = 400;
        naturalHeight = 200;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_value: string) {
          queueMicrotask(() => this.onload?.());
        }
      }

      afterEach(() => {
        globalThis.Image = originalImage;
        pointing.armed = false;
      });

      function keptCapture() {
        return vi.fn(
          async () =>
            ({
              status: "running",
              threadId,
              context,
              observation: observation({ capture: { status: "kept", captureId } }),
              evidence: [],
            }) as any,
        );
      }

      function drawable(takeCapture: BrowserAutomationClient["takeCapture"] = keptCapture()) {
        globalThis.Image = LoadedImage as unknown as typeof Image;
        const browser = withContext(takeCapture);
        browser.readCapture = vi.fn(async () => ({ captureId, dataUrl: pictureUrl }) as any);
        return browser;
      }

      // The drawing bar appears after the capture is taken, read and decoded.
      // On a slow runner that chain outlasted the one-second default and a
      // different test of this group failed on each run. Stay under the
      // package's 15 s test timeout.
      const DRAWING_OPENS_WITHIN_MS = 8_000;

      async function openDrawing(browser: BrowserAutomationClient) {
        render(<BrowserWorkspace canDrawOnPage client={browser} tab={tab} />);
        await screen.findByRole(
          "button",
          { name: "More Browser actions" },
          { timeout: DRAWING_OPENS_WITHIN_MS },
        );
        await chooseMoreAction("Draw on page");
        return screen.findByRole(
          "toolbar",
          { name: "Drawing tools" },
          { timeout: DRAWING_OPENS_WITHIN_MS },
        );
      }

      function drag(layer: Element, from: [number, number], to: [number, number]) {
        vi.spyOn(layer, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 400, 200));
        const event = (type: string, [x, y]: [number, number]) =>
          fireEvent(
            layer,
            new MouseEvent(type, {
              clientX: x,
              clientY: y,
              button: 0,
              bubbles: true,
              cancelable: true,
            }),
          );
        event("pointerdown", from);
        event("pointermove", [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2 + 12]);
        event("pointermove", to);
        event("pointerup", to);
      }

      it("takes a capture and shows the still with the drawing bar", async () => {
        const takeCapture = keptCapture();
        const browser = drawable(takeCapture);
        const bar = await openDrawing(browser);
        expect(takeCapture).toHaveBeenCalledWith({
          threadId,
          request: expect.objectContaining({ kind: "screenshot", contextId: context.contextId }),
        });
        expect(browser.readCapture).toHaveBeenCalledWith({ threadId, captureId });
        expect(within(bar).getByRole("button", { name: "Pen" })).toHaveAttribute(
          "aria-pressed",
          "true",
        );
        expect(within(bar).getByRole("button", { name: "Add to chat" })).toBeEnabled();
        const layer = screen.getByRole("application", { name: "Page capture to draw on" });
        expect(layer).toBeVisible();
        // Drawing opens ready for keys, not with focus left on the page body.
        // Focus lands a frame after the layer mounts, so a slow runner read it
        // before it arrived.
        await waitFor(() => expect(layer).toHaveFocus());
        // The page's own click-through preview is not mounted while the picture is drawn on.
        expect(
          screen.queryByRole("article", { name: "Interactive headless Browser preview" }),
        ).toBeNull();
      });

      it("says why a screenshot was not kept and shows no drawing bar", async () => {
        const takeCapture = vi.fn(
          async () =>
            ({
              status: "running",
              threadId,
              context,
              observation: observation({ capture: { status: "not-kept", reason: "no-picture" } }),
              evidence: [],
            }) as any,
        );
        const browser = drawable(takeCapture);
        render(<BrowserWorkspace canDrawOnPage client={browser} tab={tab} />);
        await chooseMoreAction("Draw on page");
        expect(
          await screen.findByText(
            "There is nothing to draw on: the Browser gave no picture of this page. A page with a sign-in field is never pictured.",
          ),
        ).toBeVisible();
        expect(screen.queryByRole("toolbar", { name: "Drawing tools" })).toBeNull();
        expect(browser.readCapture).not.toHaveBeenCalled();
      });

      it("takes the native page out of the window while the picture is drawn on and brings it back after", async () => {
        const browser = drawable();
        await openDrawing(browser);
        expect(document.querySelector(RENDERER_OVERLAY_SELECTOR)).not.toBeNull();
        expect(document.querySelector(".browser-markup")).not.toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Discard drawing" }));
        await waitFor(() => expect(document.querySelector(RENDERER_OVERLAY_SELECTOR)).toBeNull());
      });

      it("adds a pen mark for a drag and removes it again with Undo", async () => {
        const browser = drawable();
        const bar = await openDrawing(browser);
        const layer = screen.getByRole("application", { name: "Page capture to draw on" });
        expect(within(bar).getByRole("button", { name: "Undo" })).toBeDisabled();
        drag(layer, [20, 20], [120, 60]);
        expect(layer.querySelectorAll("polyline")).toHaveLength(1);
        fireEvent.click(within(bar).getByRole("button", { name: "Undo" }));
        expect(layer.querySelectorAll("polyline")).toHaveLength(0);
        fireEvent.click(within(bar).getByRole("button", { name: "Redo" }));
        expect(layer.querySelectorAll("polyline")).toHaveLength(1);
      });

      it("offers one PNG to this thread's message and leaves drawing mode", async () => {
        const taken = vi.fn((_file: File) => ({ status: "accepted" as const }));
        const unsubscribe = threadImageOffers.subscribe(`work:${threadId}`, taken);
        try {
          const browser = drawable();
          const bar = await openDrawing(browser);
          drag(
            screen.getByRole("application", { name: "Page capture to draw on" }),
            [20, 20],
            [120, 60],
          );
          fireEvent.click(within(bar).getByRole("button", { name: "Add to chat" }));
          await waitFor(() => expect(taken).toHaveBeenCalledOnce());
          const [file] = taken.mock.calls[0] as [File];
          expect(file.type).toBe("image/png");
          expect(file.name).toBe("browser-markup.png");
          const added = await screen.findByText("Added to the message");
          expect(added).toBeVisible();
          // A confirmation, not a warning: a status in the success tone.
          expect(added.closest("[data-tone]")).toHaveAttribute("data-tone", "success");
          expect(added.closest("[role]")).toHaveAttribute("role", "status");
          expect(screen.queryByRole("toolbar", { name: "Drawing tools" })).toBeNull();
          expect(document.querySelector(RENDERER_OVERLAY_SELECTOR)).toBeNull();
        } finally {
          unsubscribe();
        }
      });

      it("discards the drawing on Close without offering anything", async () => {
        const taken = vi.fn((_file: File) => ({ status: "accepted" as const }));
        const unsubscribe = threadImageOffers.subscribe(`work:${threadId}`, taken);
        try {
          const browser = drawable();
          await openDrawing(browser);
          fireEvent.click(screen.getByRole("button", { name: "Discard drawing" }));
          expect(screen.queryByRole("toolbar", { name: "Drawing tools" })).toBeNull();
          expect(taken).not.toHaveBeenCalled();
        } finally {
          unsubscribe();
        }
      });

      it("leaves drawing mode when the person uses a navigation control", async () => {
        const browser = drawable();
        await openDrawing(browser);
        fireEvent.click(screen.getByRole("button", { name: "Reload" }));
        await waitFor(() =>
          expect(screen.queryByRole("toolbar", { name: "Drawing tools" })).toBeNull(),
        );
      });

      it("stays in drawing mode with the marks and says why when the composer refuses the picture", async () => {
        const unsubscribe = threadImageOffers.subscribe(`work:${threadId}`, () => ({
          status: "refused" as const,
          reason: "Choose an image-capable model to attach images.",
        }));
        try {
          const browser = drawable();
          const bar = await openDrawing(browser);
          const layer = screen.getByRole("application", { name: "Page capture to draw on" });
          drag(layer, [20, 20], [120, 60]);
          fireEvent.click(within(bar).getByRole("button", { name: "Add to chat" }));
          expect(
            await screen.findByText(
              "The picture was not added to the message: Choose an image-capable model to attach images.",
            ),
          ).toBeVisible();
          expect(screen.getByRole("toolbar", { name: "Drawing tools" })).toBeVisible();
          expect(layer.querySelectorAll("polyline")).toHaveLength(1);
          expect(screen.queryByText("Added to the message")).toBeNull();
          // The refusal is announced, and the keys still work: focus is back on the layer.
          expect(screen.getByRole("alert")).toHaveTextContent("The picture was not added");
          await waitFor(() => expect(layer).toHaveFocus());
          // It sits in the stage, so it does not move the still.
          expect(screen.getByRole("alert").closest(".browser-markup")).not.toBeNull();
          await waitFor(() =>
            expect(within(bar).getByRole("button", { name: "Add to chat" })).toBeEnabled(),
          );
        } finally {
          unsubscribe();
        }
      });

      it("leaves a new drawing alone when an earlier picture's hand-off finishes", async () => {
        let answer: (verdict: { status: "accepted" }) => void = () => undefined;
        const unsubscribe = threadImageOffers.subscribe(
          `work:${threadId}`,
          () =>
            new Promise<{ status: "accepted" }>((resolve) => {
              answer = resolve;
            }),
        );
        try {
          const browser = drawable();
          const bar = await openDrawing(browser);
          fireEvent.click(within(bar).getByRole("button", { name: "Add to chat" }));
          // The composer is still uploading; the person discards and draws again.
          fireEvent.click(screen.getByRole("button", { name: "Discard drawing" }));
          await chooseMoreAction("Draw on page");
          await screen.findByRole("toolbar", { name: "Drawing tools" });
          const layer = screen.getByRole("application", { name: "Page capture to draw on" });
          drag(layer, [20, 20], [120, 60]);
          answer({ status: "accepted" });
          await new Promise((resolve) => setTimeout(resolve, 0));
          expect(screen.getByRole("toolbar", { name: "Drawing tools" })).toBeVisible();
          expect(layer.querySelectorAll("polyline")).toHaveLength(1);
          expect(screen.queryByText("Added to the message")).toBeNull();
        } finally {
          unsubscribe();
        }
      });

      it("says the picture waits for the thread when its composer is not open", async () => {
        const browser = drawable();
        const bar = await openDrawing(browser);
        fireEvent.click(within(bar).getByRole("button", { name: "Add to chat" }));
        expect(
          await screen.findByText("Added to the message when you open this thread"),
        ).toBeVisible();
        expect(screen.queryByRole("toolbar", { name: "Drawing tools" })).toBeNull();
        await waitFor(() =>
          expect(screen.getByRole("button", { name: "More Browser actions" })).toHaveFocus(),
        );
        // Leave nothing waiting for the next test's thread composer.
        threadImageOffers.subscribe(`work:${threadId}`, () => ({ status: "accepted" as const }))();
      });

      it("returns focus to the more menu that opened drawing when the drawing is discarded", async () => {
        const browser = drawable();
        await openDrawing(browser);
        fireEvent.click(screen.getByRole("button", { name: "Discard drawing" }));
        await waitFor(() =>
          expect(screen.getByRole("button", { name: "More Browser actions" })).toHaveFocus(),
        );
      });

      it("does not open drawing over a page the person left while the capture was being taken", async () => {
        let finish: (value: unknown) => void = () => undefined;
        const takeCapture = vi.fn(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }) as any,
        );
        const browser = drawable(takeCapture);
        render(<BrowserWorkspace canDrawOnPage client={browser} tab={tab} />);
        await chooseMoreAction("Draw on page");
        await waitFor(() => expect(takeCapture).toHaveBeenCalledOnce());
        fireEvent.click(screen.getByRole("button", { name: "Reload" }));
        await waitFor(() => expect(browser.act).toHaveBeenCalled());
        await act(async () => {
          finish({
            status: "running",
            threadId,
            context,
            observation: observation({ capture: { status: "kept", captureId } }),
            evidence: [],
          });
        });
        expect(screen.queryByRole("toolbar", { name: "Drawing tools" })).toBeNull();
        expect(browser.readCapture).not.toHaveBeenCalled();
      });

      it("is absent where the Screenshot control is absent and where the thread has no composer", async () => {
        globalThis.Image = LoadedImage as unknown as typeof Image;
        const without = withContext();
        without.readCapture = vi.fn(async () => ({ captureId, dataUrl: pictureUrl }) as any);
        const first = render(<BrowserWorkspace canDrawOnPage client={without} tab={tab} />);
        expect(await screen.findByRole("button", { name: "More Browser actions" })).toBeVisible();
        expect(await moreActionNames()).not.toContain("Draw on page");
        first.unmount();

        const noComposer = drawable();
        render(<BrowserWorkspace client={noComposer} tab={tab} />);
        const offered = await moreActionNames();
        expect(offered).toContain("Screenshot");
        expect(offered).not.toContain("Draw on page");
      });

      it("cannot be started while an element is being pointed at, and pointing is refused while drawing", async () => {
        pointing.armed = true;
        const browser = drawable();
        render(<BrowserWorkspace canDrawOnPage client={browser} tab={tab} />);
        await openMore();
        const draw = await screen.findByRole("menuitem", { name: "Draw on page" });
        expect(draw).toHaveAttribute("aria-disabled", "true");
        // It says why, as the item's description.
        expect(draw).toHaveAccessibleDescription(
          "Finish or cancel pointing at an element before drawing on the page",
        );
        await userEvent.keyboard("{Escape}");
        cleanup();

        pointing.armed = false;
        await openDrawing(drawable());
        expect(pointing.lastReason).toBe(
          "Finish or discard the drawing before choosing an element.",
        );
      });
    });
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

    await chooseMoreAction("Open in default browser");
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

    enterAddress("https://example.com");
    const start = screen.getByRole("button", { name: "Start browser" });
    fireEvent.click(start);
    fireEvent.click(start);
    // One ask for the thread's Project when the tab opened, and one for the start
    // that the second click did not duplicate.
    await waitFor(() => expect(browser.resolve).toHaveBeenCalledTimes(2));

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
    enterAddress("https://example.com");
    fireEvent.click(screen.getByRole("button", { name: "Start browser" }));
    await screen.findByText("Browser failed");
    expect(screen.getByRole("button", { name: "More Browser actions" })).toBeInTheDocument();
  });

  it("shows its start page without a warning when the page it held has closed", async () => {
    // After a restart the tab still names a context the host no longer has.
    const browser = client();
    vi.mocked(browser.inspectThread).mockRejectedValue(
      new BrowserAutomationClientFailure("stale", "Browser context is stale or no longer owned."),
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

    await waitFor(() => expect(browser.inspectThread).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: "Start browser" })).toBeVisible();
    expect(screen.queryByText(/stale or no longer owned/)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("backs off instead of re-asking every half second while the context refuses", async () => {
    const browser = client();
    vi.mocked(browser.inspectThread).mockRejectedValue(new Error("Browser context is stale."));
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

    await waitFor(() => expect(browser.inspectThread).toHaveBeenCalledTimes(1), { timeout: 1_500 });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2_500));
    });
    // 0 s, 0.5 s, 1.5 s in a backed-off loop; a fixed interval would already be at six.
    expect(vi.mocked(browser.inspectThread).mock.calls.length).toBeLessThanOrEqual(3);
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

    enterAddress("https://example.com");
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
    enterAddress("https://example.com");
    fireEvent.click(screen.getByRole("button", { name: "Start browser" }));
    await screen.findByText("Browser running");
    fireEvent.submit(screen.getByRole("textbox", { name: "Browser URL" }).closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent("The local Browser action failed.");

    expect(await screen.findByText("Agent recovered page", {}, { timeout: 2_000 })).toBeVisible();
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByText("Browser running")).toBeVisible();
  });

  it("refuses element selection in an embedded native-client presentation", async () => {
    const restoreDom = stubNativeSurfaceDom();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ notes: [] }), {
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    try {
      const browser = client();
      vi.mocked(browser.inspectThread).mockResolvedValue({
        status: "running",
        threadId,
        context,
        evidence: [],
      } as any);
      render(
        <BrowserWorkspace
          client={browser}
          serverUrl="http://localhost:9999"
          windowCapability="local-capability"
          hostBridge={
            {
              getHostCapabilities: async () => ({
                liveBrowserSupported: true,
                embeddedBrowserSupported: true,
              }),
              presentBrowser: async () => ({ status: "refused" }),
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
      expect(
        await screen.findByText(
          "Element selection is not available in this embedded Browser presentation yet.",
        ),
      ).toBeVisible();
      expect(screen.getByRole("button", { name: "Point at something" })).toBeDisabled();
    } finally {
      restoreDom();
    }
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

  it("shows the current idle interval and distinguishes the person's finite hold", async () => {
    const browser = client();
    vi.mocked(browser.inspectThread).mockResolvedValue({
      status: "running",
      threadId,
      context,
      evidence: [],
      waitingForPerson: "take-over",
    } as any);
    const { unmount } = render(
      <BrowserWorkspace
        client={browser}
        tab={
          {
            kind: "browser",
            id: "90000000-0000-4000-8000-000000000022",
            mode: "work",
            title: "Browser",
            threadId,
          } as any
        }
      />,
    );
    expect(await screen.findByRole("img", { name: /· Person hold/ })).toBeInTheDocument();
    unmount();
    vi.mocked(browser.inspectThread).mockResolvedValue({
      status: "running",
      threadId,
      context,
      evidence: [],
    } as any);
    render(
      <BrowserWorkspace
        client={browser}
        tab={
          {
            kind: "browser",
            id: "90000000-0000-4000-8000-000000000023",
            mode: "work",
            title: "Browser",
            threadId,
          } as any
        }
      />,
    );
    expect(await screen.findByRole("img", { name: /· 5m idle/ })).toBeInTheDocument();
  });

  it.each([
    ["personal", { kind: "personal" }, "Agent active · Personal"],
    [
      "project",
      { kind: "project", projectId: "40000000-0000-4000-8000-000000000001" },
      "Agent active · Project",
    ],
    ["private", { kind: "private" }, "Agent active"],
  ])(
    "names the %s profile in the driver indicator while the agent drives the page",
    async (_name, profile, expected) => {
      const restoreDom = stubNativeSurfaceDom();
      try {
        const browser = client();
        vi.mocked(browser.inspectThread).mockResolvedValue({
          status: "running",
          threadId: threadId as any,
          context: { ...context, policy: { ...context.policy, profile } } as any,
          evidence: [],
        } as any);
        render(
          <BrowserWorkspace
            client={browser}
            hostBridge={
              {
                attachBrowserSurface: vi.fn(async () => ({
                  ...nativeSurfaceState,
                  control: "agent" as const,
                })),
                detachBrowserSurface: vi.fn(async () => undefined),
                getHostCapabilities: vi.fn(async () => ({ liveBrowserSupported: true }) as any),
                updateBrowserSurfaceBounds: vi.fn(async () => undefined),
              } as any
            }
            tab={{
              kind: "browser",
              id: "90000000-0000-4000-8000-000000000022" as any,
              mode: "work",
              title: "Browser",
              threadId: threadId as any,
            }}
          />,
        );

        expect(await screen.findByRole("img", { name: new RegExp(expected) })).toBeInTheDocument();
      } finally {
        restoreDom();
      }
    },
  );

  describe("taking the page over from the agent", () => {
    /** A host that holds the page once asked and releases it when handed back. */
    function holdingClient() {
      const browser = client();
      let held: "take-over" | undefined;
      const answer = () =>
        ({
          status: "running",
          threadId,
          context,
          evidence: [],
          ...(held === undefined ? {} : { waitingForPerson: held }),
        }) as any;
      vi.mocked(browser.inspectThread).mockImplementation(async () => answer());
      browser.takeOver = vi.fn(async () => {
        held = "take-over";
        return answer();
      });
      browser.handBack = vi.fn(async () => {
        held = undefined;
        return answer();
      });
      return browser;
    }

    async function renderHeadless(browser: BrowserAutomationClient) {
      render(
        <BrowserWorkspace
          client={browser}
          tab={{
            kind: "browser",
            id: "90000000-0000-4000-8000-000000000031" as any,
            mode: "work",
            title: "Browser",
            threadId: threadId as any,
          }}
        />,
      );
      await screen.findByRole("button", { name: "More Browser actions" });
    }

    /** The toolbar row's width, as the resize observer reports it. */
    function widthOfToolbar(width: number): () => void {
      class FixedObserver {
        constructor(private readonly notify: (entries: ReadonlyArray<never>) => void) {}
        observe(): void {
          this.notify([]);
        }
        unobserve(): void {}
        disconnect(): void {}
      }
      vi.stubGlobal("ResizeObserver", FixedObserver);
      const rect = vi
        .spyOn(HTMLElement.prototype, "getBoundingClientRect")
        .mockImplementation(function (this: HTMLElement) {
          return new DOMRect(
            0,
            0,
            this.classList.contains("browser-workspace__chrome") ? width : 0,
            0,
          );
        });
      return () => {
        rect.mockRestore();
        vi.unstubAllGlobals();
      };
    }

    it("draws one row: history icons, the address field, then the trailing buttons", async () => {
      await renderHeadless(holdingClient());
      const row = document.querySelector<HTMLElement>(".browser-workspace__chrome");
      if (row === null) throw new Error("The toolbar row is missing.");
      const order = [...row.querySelectorAll("button, input")].map((control) =>
        control.getAttribute("aria-label"),
      );
      const profile = order.findIndex((name) => name?.startsWith("Browser profile") === true);
      // Keyboard order is the visual order: history, the address, Take over, the
      // profile icon, then the more menu.
      expect(order.slice(0, 4)).toEqual(["Back", "Forward", "Reload", "Browser URL"]);
      expect(order.indexOf("Take over")).toBe(4);
      expect(profile).toBe(5);
      expect(order.at(-1)).toBe("More Browser actions");
      expect(within(row).queryByText("Preview")).toBeNull();
    });

    it("draws an empty address field and no status icon while no page is open", async () => {
      render(
        <BrowserWorkspace
          client={client()}
          tab={{ kind: "browser", id: threadId, mode: "work", title: "Browser", threadId } as never}
        />,
      );
      const profile = await screen.findByRole("button", { name: /^Browser profile/ });
      const row = document.querySelector<HTMLElement>(".browser-workspace__chrome");
      expect(row?.querySelector(".browser-workspace__field [role=img]")).toBeNull();
      expect(row?.querySelector("[role=img]")).toBeNull();
      expect(screen.queryByRole("button", { name: "More Browser actions" })).toBeNull();
      expect(profile).toBeVisible();
    });

    it("draws the status icon after the address while a page is open", async () => {
      await renderHeadless(holdingClient());
      const row = document.querySelector<HTMLElement>(".browser-workspace__chrome");
      if (row === null) throw new Error("The toolbar row is missing.");
      const field = row.querySelector(".browser-workspace__field");
      expect(field?.querySelector("[role=img]")).toBeNull();
      const status = within(row).getByRole("img", { name: /idle/ });
      expect(
        status.compareDocumentPosition(screen.getByRole("button", { name: "Take over" })),
      ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    });

    it("keeps every other action reachable from the more menu", async () => {
      await renderHeadless(holdingClient());
      expect(await moreActionNames()).toEqual(["Stop this Browser session"]);
    });

    it("moves the status and Take over into the more menu when the row is too narrow for the address beside them", async () => {
      const restore = widthOfToolbar(300);
      try {
        await renderHeadless(holdingClient());
        expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
        expect(screen.queryByRole("img", { name: /idle/ })).toBeNull();
        expect(await moreActionNames()).toEqual(
          expect.arrayContaining(["Take over", "Stop this Browser session"]),
        );
        expect(screen.getByRole("button", { name: "Back" })).toBeVisible();
        expect(screen.getByRole("textbox", { name: "Browser URL" })).toBeVisible();
        expect(screen.getByRole("button", { name: /^Browser profile/ })).toBeVisible();
      } finally {
        restore();
      }
    });

    it("keeps the status and Take over beside the address when the row is wide", async () => {
      const restore = widthOfToolbar(640);
      try {
        await renderHeadless(holdingClient());
        expect(screen.getByRole("button", { name: "Take over" })).toBeVisible();
        expect(screen.getByRole("img", { name: /idle/ })).toBeVisible();
        expect(await moreActionNames()).not.toContain("Take over");
      } finally {
        restore();
      }
    });

    it("takes the page from the more menu when the row is narrow", async () => {
      const restore = widthOfToolbar(300);
      try {
        const browser = holdingClient();
        await renderHeadless(browser);
        await chooseMoreAction("Take over");
        expect(browser.takeOver).toHaveBeenCalledWith({ threadId });
      } finally {
        restore();
      }
    });

    it("keeps the profile choices reachable from the more menu at the narrowest page-open row", async () => {
      const restore = widthOfToolbar(288);
      try {
        await renderHeadless(holdingClient());
        expect(screen.queryByRole("button", { name: /^Browser profile/ })).toBeNull();
        expect(await moreActionNames()).toEqual(
          expect.arrayContaining([
            "Profile: Private (current)",
            "Profile: Project",
            "Profile: Personal",
          ]),
        );
        expect(screen.getByRole("textbox", { name: "Browser URL" })).toBeVisible();
      } finally {
        restore();
      }
    });

    it("takes the page on one click, says so, and hands it back on one click", async () => {
      const browser = holdingClient();
      await renderHeadless(browser);

      await userEvent.click(await screen.findByRole("button", { name: "Take over" }));
      expect(browser.takeOver).toHaveBeenCalledWith({ threadId });
      expect(await screen.findByRole("img", { name: /You have the page/ })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Take over" })).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: "Hand back" }));
      expect(browser.handBack).toHaveBeenCalledWith({ threadId });
      await waitFor(() =>
        expect(screen.queryByRole("img", { name: /You have the page/ })).not.toBeInTheDocument(),
      );
      expect(screen.getByRole("button", { name: "Take over" })).toBeInTheDocument();
    });

    it("shows a take-over made in another window of the same thread", async () => {
      const browser = holdingClient();
      vi.mocked(browser.inspectThread).mockResolvedValue({
        status: "running",
        threadId,
        context,
        evidence: [],
        waitingForPerson: "take-over",
      } as any);
      await renderHeadless(browser);
      expect(await screen.findByRole("button", { name: "Hand back" })).toBeInTheDocument();
      expect(screen.getByRole("img", { name: /You have the page/ })).toBeInTheDocument();
    });

    it("names the active owner and reclaims locally without handing the page back to the agent", async () => {
      const browser = holdingClient();
      const local = decodeBrowserAutomationSnapshot({
        status: "running",
        threadId,
        context,
        evidence: [],
        waitingForPerson: "take-over",
      });
      vi.mocked(browser.inspectThread).mockResolvedValue(
        decodeBrowserAutomationSnapshot({
          ...local,
          ownerController: {
            name: "Synthetic owner phone",
            expiresAt: "2026-11-04T12:01:00.000Z",
          },
        }),
      );
      browser.takeOver = vi.fn(async () => {
        vi.mocked(browser.inspectThread).mockResolvedValue(local);
        return local;
      });
      await renderHeadless(browser);
      expect(
        await screen.findByRole("img", { name: /Owner: Synthetic owner phone/ }),
      ).toBeInTheDocument();
      // The one action the person needs while a remote owner holds the page is
      // the trailing button; Hand back is in the more menu.
      expect(screen.queryByRole("button", { name: "Hand back" })).toBeNull();
      expect(await moreActionNames()).toContain("Hand back");
      await userEvent.click(screen.getByRole("button", { name: "Reclaim locally" }));
      expect(browser.takeOver).toHaveBeenCalledWith({ threadId });
      expect(await screen.findByRole("img", { name: /You have the page/ })).toBeInTheDocument();
      expect(browser.handBack).not.toHaveBeenCalled();
    });

    it("offers no Take over without a page, with a client that cannot, or under the agent's sign-in ask", async () => {
      const bare = client();
      vi.mocked(bare.inspectThread).mockResolvedValue({
        status: "ready",
        threadId,
        evidence: [],
      } as any);
      const { unmount } = render(
        <BrowserWorkspace
          client={bare}
          tab={{
            kind: "browser",
            id: "90000000-0000-4000-8000-000000000032" as any,
            mode: "work",
            title: "Browser",
            threadId: threadId as any,
          }}
        />,
      );
      expect(screen.queryByRole("button", { name: "Take over" })).not.toBeInTheDocument();
      unmount();

      const signingIn = holdingClient();
      vi.mocked(signingIn.inspectThread).mockResolvedValue({
        status: "running",
        threadId,
        context,
        evidence: [],
        waitingForPerson: "sign-in",
      } as any);
      await renderHeadless(signingIn);
      expect(screen.queryByRole("button", { name: "Take over" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Hand back" })).not.toBeInTheDocument();
    });

    it("says why when the host refuses", async () => {
      const browser = holdingClient();
      browser.takeOver = vi.fn(async () => {
        throw new BrowserAutomationClientFailure("unavailable", "There is no page to take over.");
      });
      await renderHeadless(browser);
      await userEvent.click(await screen.findByRole("button", { name: "Take over" }));
      expect(await screen.findByText("There is no page to take over.")).toBeInTheDocument();
    });
  });

  it.each([
    "workspace-drag-preview",
    "workspace-drop-overlay",
    "octant-dialog__backdrop",
    "octant-sheet__backdrop",
  ])(
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

        expect(await screen.findByRole("img", { name: /Shared live page/ })).toBeInTheDocument();
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

    expect(await screen.findByRole("button", { name: "More Browser actions" })).toBeVisible();
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

  describe("Browser profiles", () => {
    const tab = {
      kind: "browser" as const,
      id: "90000000-0000-4000-8000-000000000050" as any,
      mode: "work" as const,
      title: "Browser",
      threadId: threadId as any,
    };
    const nativeBridge = {
      getHostCapabilities: vi.fn(async () => ({ liveBrowserSupported: true }) as any),
    } as any;

    it("offers an explicit one-off Private open when task-default controls refuse the read", async () => {
      const browser = client();
      browser.readTaskProfile = vi.fn(async () => {
        throw new BrowserAutomationClientFailure("unauthorized", "Local window only");
      });
      browser.selectTaskProfile = vi.fn();
      globalThis.localStorage.setItem(`octant.browser.profile.${authority.projectId}`, "personal");
      render(<BrowserWorkspace client={browser} tab={tab} />);
      const user = userEvent.setup();
      await screen.findByText(/task.*default could not be loaded/i);
      enterAddress("https://example.com/private");
      fireEvent.submit(screen.getByRole("textbox", { name: "Browser URL" }).closest("form")!);
      expect(browser.create).not.toHaveBeenCalled();
      await user.click(screen.getByRole("button", { name: "Open Private page" }));
      await waitFor(() => expect(browser.create).toHaveBeenCalledOnce());
      expect(vi.mocked(browser.create).mock.calls[0]?.[0].policy.profile).toBeUndefined();
      expect(browser.selectTaskProfile).not.toHaveBeenCalled();
      expect(globalThis.localStorage.getItem(`octant.browser.profile.${authority.projectId}`)).toBe(
        "personal",
      );
    });

    it.each(["client", "thread", "mode"] as const)(
      "does not reuse a ready task default while a new %s scope read is held",
      async (changed) => {
        const browser = client();
        const initial = { threadId, mode: "work", version: 1, profile: "personal" } as any;
        browser.readTaskProfile = vi.fn(async () => initial);
        browser.selectTaskProfile = vi.fn();
        const rendered = render(<BrowserWorkspace client={browser} tab={tab} />);
        await screen.findByRole("button", {
          name: "Default browser profile for this task: Personal",
        });
        let finish!: (selection: typeof initial) => void;
        const held = new Promise<typeof initial>((resolve) => {
          finish = resolve;
        });
        const next = changed === "client" ? client() : browser;
        next.readTaskProfile = vi.fn(() => held);
        next.selectTaskProfile = vi.fn();
        const nextTab = {
          ...tab,
          threadId:
            changed === "thread" ? ("10000000-0000-4000-8000-000000000002" as any) : tab.threadId,
          mode: changed === "mode" ? ("code" as const) : tab.mode,
        };
        rendered.rerender(<BrowserWorkspace client={next} tab={nextTab} />);
        await waitFor(() => expect(next.readTaskProfile).toHaveBeenCalled());
        expect(screen.getByRole("button", { name: "Browser profile: Private" })).toBeDisabled();
        enterAddress("https://example.com/scoped");
        fireEvent.submit(screen.getByRole("textbox", { name: "Browser URL" }).closest("form")!);
        expect(next.create).not.toHaveBeenCalled();
        expect(next.selectTaskProfile).not.toHaveBeenCalled();
        await act(async () =>
          finish({
            ...initial,
            threadId: nextTab.threadId,
            mode: nextTab.mode,
            profile: "private",
          }),
        );
        expect(
          await screen.findByRole("button", {
            name: "Default browser profile for this task: Private",
          }),
        ).toBeEnabled();
      },
    );

    it("saves the task default without changing the Project page preference", async () => {
      const browser = client();
      browser.readTaskProfile = vi.fn(
        async () => ({ threadId, mode: "work", version: 1, profile: "private" }) as any,
      );
      browser.selectTaskProfile = vi.fn(
        async (input) =>
          ({
            selection: { ...input, version: 2 },
            browser: { status: "ready", threadId, evidence: [] },
          }) as any,
      );
      render(<BrowserWorkspace client={browser} hostBridge={nativeBridge} tab={tab} />);
      const user = userEvent.setup();
      const control = await screen.findByRole("button", {
        name: "Default browser profile for this task: Private",
      });
      await waitFor(() => expect(control).toBeEnabled());
      await user.click(control);
      await user.click(await screen.findByRole("menuitemradio", { name: "Personal" }));
      await waitFor(() =>
        expect(browser.selectTaskProfile).toHaveBeenCalledWith({
          threadId,
          mode: "work",
          expectedVersion: 1,
          profile: "personal",
        }),
      );
      expect(browser.stop).not.toHaveBeenCalled();
      expect(browser.create).not.toHaveBeenCalled();
      expect(
        globalThis.localStorage.getItem(`octant.browser.profile.${authority.projectId}`),
      ).toBeNull();
    });

    it.each([false, true])(
      "confirms a live shared page switch and preserves it on failure=%s",
      async (fails) => {
        const browser = client();
        const current = { status: "running", threadId, context, evidence: [] } as any;
        vi.mocked(browser.inspectThread).mockResolvedValue(current);
        vi.mocked(browser.inspect).mockResolvedValue(current);
        const selection = {
          threadId,
          mode: "work",
          version: 1,
          profile: "private",
          contextId: context.contextId,
        };
        browser.readTaskProfile = vi.fn(
          async () =>
            ({
              ...selection,
              version: fails && vi.mocked(browser.selectTaskProfile!).mock.calls.length > 0 ? 2 : 1,
            }) as any,
        );
        const replacement = {
          ...current,
          context: {
            ...context,
            contextId: "60000000-0000-4000-8000-000000000002",
            policy: { ...context.policy, profile: { kind: "personal" } },
          },
        };
        browser.selectTaskProfile = vi.fn(async () => {
          if (fails)
            throw new BrowserAutomationClientFailure("stale", "Task changed. Original page kept.");
          vi.mocked(browser.inspect).mockResolvedValue(replacement);
          vi.mocked(browser.inspectThread).mockResolvedValue(replacement);
          browser.readTaskProfile = vi.fn(
            async () =>
              ({
                ...selection,
                profile: "personal",
                version: 2,
                contextId: replacement.context.contextId,
              }) as any,
          );
          return {
            selection: {
              ...selection,
              profile: "personal",
              version: 2,
              contextId: replacement.context.contextId,
            },
            browser: replacement,
          } as any;
        });
        const created = vi.fn();
        render(
          <BrowserWorkspace
            client={browser}
            hostBridge={nativeBridge}
            tab={tab}
            onContextCreated={created}
          />,
        );
        const user = userEvent.setup();
        const control = await screen.findByRole("button", {
          name: "Default browser profile for this task: Private",
        });
        await waitFor(() => expect(control).toBeEnabled());
        await user.click(control);
        await user.click(await screen.findByRole("menuitemradio", { name: "Personal" }));
        expect(
          await screen.findByText(/Unsaved form entries on this page will be lost/),
        ).toBeVisible();
        expect(browser.selectTaskProfile).not.toHaveBeenCalled();
        await user.click(screen.getByRole("button", { name: "Change profile" }));
        await waitFor(() => expect(browser.selectTaskProfile).toHaveBeenCalledOnce());
        expect(browser.stop).not.toHaveBeenCalled();
        expect(browser.create).not.toHaveBeenCalled();
        if (fails) {
          expect(await screen.findByText("Task changed. Original page kept.")).toBeVisible();
          expect(created).not.toHaveBeenCalled();
          expect(
            screen.getByRole("button", { name: "Default browser profile for this task: Private" }),
          ).toBeVisible();
          await user.click(
            screen.getByRole("button", { name: "Default browser profile for this task: Private" }),
          );
          await user.click(await screen.findByRole("menuitemradio", { name: "Personal" }));
          await user.click(screen.getByRole("button", { name: "Change profile" }));
          await waitFor(() => expect(browser.selectTaskProfile).toHaveBeenCalledTimes(2));
          expect(vi.mocked(browser.selectTaskProfile!).mock.calls[1]?.[0].expectedVersion).toBe(2);
        } else {
          expect(created).not.toHaveBeenCalled();
          const next = {
            ...replacement,
            context: { ...replacement.context, contextId: "60000000-0000-4000-8000-000000000003" },
          };
          vi.mocked(browser.inspectThread).mockResolvedValue(next);
          await waitFor(() => expect(browser.inspectThread).toHaveBeenCalledTimes(2), {
            timeout: 2000,
          });
          expect(browser.inspect).not.toHaveBeenCalled();
        }
      },
    );

    it.each(["native-live", "headless"] as const)(
      "offers Login permission in the more menu only on the native Browser consumer, and opens its review there, not on the %s fallback",
      async (presentation) => {
        const browser = client();
        browser.manageCredentialUse = vi.fn(async () =>
          decodeBrowserCredentialResult({ kind: "browser-credential-grants", grants: [] }),
        );
        vi.mocked(browser.inspectThread).mockResolvedValue(
          decodeBrowserAutomationSnapshot({
            status: "running",
            threadId,
            context: { ...context, presentation },
            evidence: [],
            waitingForPerson: "sign-in",
          }),
        );
        render(<BrowserWorkspace client={browser} hostBridge={nativeBridge} tab={tab} />);
        await screen.findByRole("button", { name: "More Browser actions" });
        if (presentation === "headless")
          expect(await moreActionNames()).not.toContain("Login permission");
        else {
          expect(await moreActionNames()).toContain("Login permission");
          await chooseMoreAction("Login permission");
          expect(
            await screen.findByRole("dialog", { name: "Browser login permission" }),
          ).toBeTruthy();
          expect(browser.manageCredentialUse).toHaveBeenCalledWith(
            expect.objectContaining({
              kind: "list-browser-credential-grants",
              contextId: context.contextId,
              threadId,
              mode: "work",
            }),
            expect.any(AbortSignal),
          );
        }
      },
    );

    it("opens a new page Private unless the person chose a profile", async () => {
      const browser = client();
      render(<BrowserWorkspace client={browser} tab={tab} />);
      await act(async () => undefined);

      enterAddress("https://example.com");
      fireEvent.click(screen.getByRole("button", { name: "Start browser" }));

      await waitFor(() => expect(browser.create).toHaveBeenCalled());
      const policy = vi.mocked(browser.create).mock.calls[0]?.[0].policy;
      expect(policy?.profile).toBeUndefined();
      expect(screen.getByRole("button", { name: "Browser profile: Private" })).toBeVisible();
    });

    it("puts the page in the profile the person picked, and keeps that pick for the Project", async () => {
      const browser = client();
      const { unmount } = render(
        <BrowserWorkspace client={browser} hostBridge={nativeBridge} tab={tab} />,
      );
      await act(async () => undefined);
      const user = userEvent.setup();

      await user.click(screen.getByRole("button", { name: "Browser profile: Private" }));
      await user.click(await screen.findByRole("menuitemradio", { name: "Personal" }));
      enterAddress("https://example.com");
      fireEvent.click(screen.getByRole("button", { name: "Start browser" }));

      await waitFor(() => expect(browser.create).toHaveBeenCalled());
      expect(vi.mocked(browser.create).mock.calls[0]?.[0].policy.profile).toEqual({
        kind: "personal",
      });

      unmount();
      render(<BrowserWorkspace client={client()} hostBridge={nativeBridge} tab={tab} />);
      expect(
        await screen.findByRole("button", { name: "Browser profile: Personal" }),
      ).toBeVisible();
    });

    it("maps Project to this thread's own Project from the host's scope, never from the renderer", async () => {
      const browser = client();
      render(<BrowserWorkspace client={browser} hostBridge={nativeBridge} tab={tab} />);
      await act(async () => undefined);
      const user = userEvent.setup();

      await user.click(screen.getByRole("button", { name: "Browser profile: Private" }));
      await user.click(await screen.findByRole("menuitemradio", { name: "Project" }));
      enterAddress("https://example.com");
      fireEvent.click(screen.getByRole("button", { name: "Start browser" }));

      await waitFor(() => expect(browser.create).toHaveBeenCalled());
      expect(vi.mocked(browser.create).mock.calls[0]?.[0].policy.profile).toEqual({
        kind: "project",
        projectId: authority.projectId,
      });
    });

    it("reopens the same address in the chosen profile as a new context when the page is open", async () => {
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
          url: "https://example.com/start",
          revision: 1,
          observedAt: "2026-07-27T20:01:00.000Z",
          stale: false,
        } as any,
        evidence: [],
      });
      render(<BrowserWorkspace client={browser} hostBridge={nativeBridge} tab={tab} />);
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Browser profile: Private" }));
      await user.click(await screen.findByRole("menuitemradio", { name: "Personal" }));

      await waitFor(() => expect(browser.stop).toHaveBeenCalled());
      await waitFor(() => expect(browser.create).toHaveBeenCalled());
      expect(vi.mocked(browser.create).mock.calls[0]?.[0].policy.profile).toEqual({
        kind: "personal",
      });
      expect(vi.mocked(browser.act).mock.calls.at(-1)?.[0]).toMatchObject({
        kind: "navigate",
        target: expect.stringContaining("example.com"),
      });
    });

    it("remembers the choice per Project, so another Project's new tab starts Private", async () => {
      const first = client();
      const { unmount } = render(
        <BrowserWorkspace client={first} hostBridge={nativeBridge} tab={tab} />,
      );
      await act(async () => undefined);
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Browser profile: Private" }));
      await user.click(await screen.findByRole("menuitemradio", { name: "Personal" }));
      expect(screen.getByRole("button", { name: "Browser profile: Personal" })).toBeVisible();
      unmount();

      const otherProject = client();
      vi.mocked(otherProject.resolve).mockResolvedValue({
        threadId,
        authority: { ...authority, projectId: "30000000-0000-4000-8000-0000000000ff" },
      } as any);
      render(<BrowserWorkspace client={otherProject} hostBridge={nativeBridge} tab={tab} />);

      await waitFor(() => expect(otherProject.resolve).toHaveBeenCalled());
      await act(async () => undefined);
      expect(screen.getByRole("button", { name: "Browser profile: Private" })).toBeVisible();

      // The first Project still remembers its own choice.
      const again = client();
      render(<BrowserWorkspace client={again} hostBridge={nativeBridge} tab={tab} />);
      expect(
        (await screen.findAllByRole("button", { name: "Browser profile: Personal" })).length,
      ).toBeGreaterThan(0);
    });

    it("follows a tab bound to one context onto the replacement a profile switch creates", async () => {
      const browser = client();
      const replacement = { ...context, contextId: "60000000-0000-4000-8000-0000000000aa" };
      vi.mocked(browser.inspect).mockImplementation(
        async ({ contextId }: { contextId: string }) =>
          ({
            status: "running",
            threadId,
            context: contextId === context.contextId ? context : replacement,
            observation: {
              contextId,
              actionId: context.actionId,
              correlationId: context.correlationId,
              authority,
              url: "https://example.com/start",
              revision: 1,
              observedAt: "2026-07-27T20:01:00.000Z",
              stale: false,
            },
            evidence: [],
          }) as any,
      );
      vi.mocked(browser.create).mockResolvedValue({
        status: "running",
        threadId,
        context: replacement,
        evidence: [],
      } as any);
      const onContextCreated = vi.fn();
      render(
        <BrowserWorkspace
          client={browser}
          hostBridge={nativeBridge}
          onContextCreated={onContextCreated}
          tab={{ ...tab, contextId: context.contextId as any }}
        />,
      );
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Browser profile: Private" }));
      await user.click(await screen.findByRole("menuitemradio", { name: "Personal" }));

      await waitFor(() => expect(browser.create).toHaveBeenCalled());
      // The replacement is its own context: it never takes over the thread's shared one.
      expect(vi.mocked(browser.create).mock.calls[0]?.[0].dedicated).toBe(true);
      expect(onContextCreated).toHaveBeenCalledWith(replacement.contextId);
      vi.mocked(browser.inspect).mockClear();
      await waitFor(() => expect(browser.inspect).toHaveBeenCalled(), { timeout: 3_000 });
      // Every later poll asks for the replacement, never the stopped context.
      const asked = vi.mocked(browser.inspect).mock.calls.map(([input]) => input.contextId);
      expect(new Set(asked)).toEqual(new Set([replacement.contextId]));
    });

    it("says in words when the host refuses a profile page", async () => {
      const browser = client();
      vi.mocked(browser.create).mockResolvedValueOnce({
        status: "failed",
        threadId: threadId as any,
        evidence: [],
        failure: {
          category: "unavailable",
          reason: "profile-unavailable",
          message: "Signed-in pages open only in the Octant app's own Browser.",
        },
      } as any);
      globalThis.localStorage.setItem(`octant.browser.profile.${authority.projectId}`, "personal");
      render(<BrowserWorkspace client={browser} hostBridge={nativeBridge} tab={tab} />);
      await act(async () => undefined);

      enterAddress("https://example.com");
      fireEvent.click(screen.getByRole("button", { name: "Start browser" }));

      expect(
        await screen.findByText("Signed-in pages open only in the Octant app's own Browser."),
      ).toBeVisible();
    });
  });
});

function enterAddress(value: string): void {
  fireEvent.change(screen.getByRole("textbox", { name: "Browser URL" }), { target: { value } });
}
