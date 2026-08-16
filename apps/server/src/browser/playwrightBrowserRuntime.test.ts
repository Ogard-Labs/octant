import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserActionRequest, BrowserContextId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  PlaywrightBrowserRuntime,
  type PlaywrightBrowserPort,
  type PlaywrightContextPort,
  type PlaywrightPagePort,
} from "./playwrightBrowserRuntime";

const firstId = "10000000-0000-4000-8000-000000000001" as BrowserContextId;
const secondId = "10000000-0000-4000-8000-000000000002" as BrowserContextId;
const policy = {
  profileMode: "isolated" as const,
  allowedOrigins: ["https://example.com"],
  credentialFieldProtection: true,
  maxConcurrentTabs: 1,
  sessionTimeoutMs: 300_000,
};

function fakePage(name: string): PlaywrightPagePort {
  let url = "about:blank";
  let title = name;
  let viewport = { width: 1280, height: 720 };
  const locator = vi.fn((selector: string) => ({
    evaluate: vi.fn(async (expression: (element: Element) => unknown) =>
      expression({
        getAttribute: (attribute: string) =>
          selector === "#password" && attribute === "autocomplete"
            ? "current-password"
            : selector === "#api-key" && attribute === "aria-label"
              ? "API key"
              : null,
        id: selector === "#password" ? "password" : "focused-input",
        isContentEditable: false,
        tagName: "INPUT",
      } as unknown as Element),
    ),
    waitFor: vi.fn(async () => undefined),
  }));
  const frame = { evaluate: vi.fn(async () => false), locator };
  return {
    goto: vi.fn(async (next) => {
      url = next;
    }),
    click: vi.fn(async () => {
      title = `${name} clicked`;
    }),
    fill: vi.fn(async () => undefined),
    mouse: {
      click: vi.fn(async () => undefined),
      wheel: vi.fn(async () => undefined),
    },
    keyboard: {
      insertText: vi.fn(async () => undefined),
      press: vi.fn(async () => undefined),
    },
    evaluate: vi.fn(async (expression, argument) => expression(argument as never)),
    frames: vi.fn(() => [frame]),
    locator,
    screenshot: vi.fn(async () => new Uint8Array([1, 2, 3])),
    setViewportSize: vi.fn(async (next) => {
      viewport = next;
    }),
    title: vi.fn(async () => title),
    url: vi.fn(() => url),
    viewportSize: () => viewport,
    textContent: vi.fn(async () => title),
    close: vi.fn(async () => undefined),
  } as unknown as PlaywrightPagePort;
}

function harness() {
  const pages = [fakePage("first"), fakePage("second")];
  const routeHandlers: Array<(route: any) => Promise<void>> = [];
  const webSocketRouteHandlers: Array<(route: any) => Promise<void>> = [];
  const pageListeners: Array<(page: PlaywrightPagePort) => void> = [];
  const contexts: PlaywrightContextPort[] = pages.map((page) => ({
    route: vi.fn(async (_pattern, handler) => void routeHandlers.push(handler)),
    routeWebSocket: vi.fn(async (_pattern, handler) => void webSocketRouteHandlers.push(handler)),
    on: vi.fn((_event, listener) => void pageListeners.push(listener)),
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => undefined),
  }));
  let disconnected: (() => void) | undefined;
  const browser: PlaywrightBrowserPort = {
    pid: 4321,
    newContext: vi.fn(async () => contexts.shift()!),
    close: vi.fn(async () => undefined),
    on: (_event, listener) => {
      disconnected = listener;
    },
  };
  const launch = vi.fn(async () => browser);
  const runtime = new PlaywrightBrowserRuntime({
    executableCandidates: ["/missing", "/browser"],
    executable: vi.fn(async (path) => path === "/browser"),
    launch,
  });
  return {
    browser,
    disconnected: () => disconnected?.(),
    launch,
    pages,
    pageListeners,
    routeHandlers,
    runtime,
    webSocketRouteHandlers,
  };
}

function action(kind: BrowserActionRequest["kind"], target?: string): BrowserActionRequest {
  return {
    actionId: "20000000-0000-4000-8000-000000000001" as any,
    contextId: firstId,
    correlationId: "30000000-0000-4000-8000-000000000001" as any,
    authority: {
      hostId: "40000000-0000-4000-8000-000000000001" as any,
      mode: "work",
      projectId: "50000000-0000-4000-8000-000000000001" as any,
      providerInstanceId: "60000000-0000-4000-8000-000000000001" as any,
      extension: { kind: "core" },
    },
    kind,
    ...(target === undefined ? {} : { target }),
  };
}

describe("PlaywrightBrowserRuntime", () => {
  it("accepts the localhost certificate only for the context that asked", async () => {
    const { browser, runtime } = harness();
    await runtime.createContext(firstId, policy, new AbortController().signal);
    await runtime.createContext(
      secondId,
      {
        ...policy,
        allowedOrigins: ["https://127.0.0.1:8443"],
        acceptsLocalCertificate: true,
      },
      new AbortController().signal,
    );

    // Verification stays on for every other context this browser owns.
    expect(vi.mocked(browser.newContext).mock.calls[0]).toEqual([]);
    expect(browser.newContext).toHaveBeenNthCalledWith(2, { ignoreHTTPSErrors: true });
  });

  it("detects a host executable and creates one isolated context per id", async () => {
    const { browser, launch, runtime } = harness();
    expect(await runtime.available()).toBe(true);
    await runtime.createContext(firstId, policy, new AbortController().signal);
    await runtime.createContext(secondId, policy, new AbortController().signal);
    expect(launch).toHaveBeenCalledOnce();
    expect(browser.newContext).toHaveBeenCalledTimes(2);
  });

  it("persists and removes a browser ownership receipt", async () => {
    const receiptDirectory = await mkdtemp(join(tmpdir(), "octant-browser-receipts-"));
    try {
      const pages = [fakePage("first")];
      const browser: PlaywrightBrowserPort = {
        pid: 4321,
        newContext: vi.fn(async () => ({
          route: vi.fn(async () => undefined),
          routeWebSocket: vi.fn(async () => undefined),
          on: vi.fn(),
          newPage: vi.fn(async () => pages[0]!),
          close: vi.fn(async () => undefined),
        })),
        close: vi.fn(async () => undefined),
        on: vi.fn(),
      };
      const runtime = new PlaywrightBrowserRuntime({
        executableCandidates: ["/browser"],
        executable: vi.fn(async () => true),
        launch: vi.fn(async (_path, onProcessStarted) => {
          await onProcessStarted?.({ pid: 4321, exited: Promise.resolve() });
          return browser;
        }),
        receiptDirectory,
        processIdentity: async () => `sha256:${"a".repeat(64)}`,
        processGroupExists: () => false,
      });
      await runtime.createContext(firstId, policy, new AbortController().signal);
      expect(await readdir(receiptDirectory)).toHaveLength(1);
      await runtime.closeAll();
      expect(await readdir(receiptDirectory)).toHaveLength(0);
    } finally {
      await rm(receiptDirectory, { recursive: true, force: true });
    }
  });

  it("retains the browser receipt when shutdown fails", async () => {
    const receiptDirectory = await mkdtemp(join(tmpdir(), "octant-browser-receipts-"));
    try {
      const pages = [fakePage("first")];
      const browser: PlaywrightBrowserPort = {
        pid: 4321,
        newContext: vi.fn(async () => ({
          route: vi.fn(async () => undefined),
          routeWebSocket: vi.fn(async () => undefined),
          on: vi.fn(),
          newPage: vi.fn(async () => pages[0]!),
          close: vi.fn(async () => undefined),
        })),
        close: vi.fn(async () => undefined),
        on: vi.fn(),
      };
      const runtime = new PlaywrightBrowserRuntime({
        executableCandidates: ["/browser"],
        executable: vi.fn(async () => true),
        launch: vi.fn(async (_path, onProcessStarted) => {
          await onProcessStarted?.({ pid: 4321, exited: Promise.resolve() });
          return browser;
        }),
        receiptDirectory,
        processIdentity: async () => `sha256:${"a".repeat(64)}`,
        processGroupExists: () => false,
      });
      await runtime.createContext(firstId, policy, new AbortController().signal);
      browser.close = vi.fn(async () => {
        throw new Error("browser shutdown failed");
      });

      await expect(runtime.closeAll()).rejects.toThrow("browser shutdown failed");
      expect(await readdir(receiptDirectory)).toHaveLength(1);
    } finally {
      await rm(receiptDirectory, { recursive: true, force: true });
    }
  });

  it("navigates and interacts only through the selected context page", async () => {
    const { pages, runtime } = harness();
    await runtime.createContext(firstId, policy, new AbortController().signal);
    await runtime.createContext(secondId, policy, new AbortController().signal);
    const observed = await runtime.act(
      firstId,
      action("navigate", "https://example.com/start"),
      new AbortController().signal,
    );
    await runtime.act(firstId, action("click", "#go"), new AbortController().signal);
    expect(pages[0]!.goto).toHaveBeenCalledWith("https://example.com/start");
    expect(pages[0]!.click).toHaveBeenCalledWith("#go");
    expect(pages[1]!.goto).not.toHaveBeenCalled();
    expect(observed.url).toBe("https://example.com/start");
  });

  it("operates the interactive web preview through bounded viewport input", async () => {
    const { pages, runtime } = harness();
    await runtime.createContext(firstId, policy, new AbortController().signal);

    await runtime.act(
      firstId,
      { ...action("click"), point: { x: 0.5, y: 0.5 } },
      new AbortController().signal,
    );
    await runtime.act(firstId, { ...action("type"), value: "hello" }, new AbortController().signal);
    await runtime.act(
      firstId,
      { ...action("press"), value: "Enter" },
      new AbortController().signal,
    );
    await runtime.act(firstId, { ...action("scroll"), deltaY: 240 }, new AbortController().signal);

    expect(pages[0]!.mouse.click).toHaveBeenCalledWith(640, 360);
    expect(pages[0]!.keyboard.insertText).toHaveBeenCalledWith("hello");
    expect(pages[0]!.keyboard.press).toHaveBeenCalledWith("Enter");
    expect(pages[0]!.mouse.wheel).toHaveBeenCalledWith(0, 240);
  });

  it("identifies credential fields without reading their values", async () => {
    const { runtime } = harness();
    await runtime.createContext(firstId, policy, new AbortController().signal);
    await expect(
      runtime.inspectTarget(firstId, "#password", new AbortController().signal),
    ).resolves.toEqual({ sensitive: true });
    await expect(
      runtime.inspectTarget(firstId, "#api-key", new AbortController().signal),
    ).resolves.toEqual({ sensitive: true });
  });

  it("aborts redirected navigation outside the context allowlist", async () => {
    const { routeHandlers, runtime } = harness();
    await runtime.createContext(firstId, policy, new AbortController().signal);
    const abort = vi.fn(async () => undefined);
    const continueRequest = vi.fn(async () => undefined);
    await routeHandlers[0]!({
      abort,
      continue: continueRequest,
      request: () => ({ isNavigationRequest: () => true, url: () => "https://evil.example/" }),
    });
    expect(abort).toHaveBeenCalledOnce();
    expect(continueRequest).not.toHaveBeenCalled();
  });

  it("reports the blocked redirect target when a navigation leaves the allowlist", async () => {
    const { pages, routeHandlers, runtime } = harness();
    await runtime.createContext(firstId, policy, new AbortController().signal);
    // Playwright reports the refused redirect through the route guard while
    // goto is still pending, then rejects goto with an opaque network error.
    vi.mocked(pages[0]!.goto).mockImplementationOnce(async () => {
      await routeHandlers[0]!({
        abort: async () => undefined,
        continue: async () => undefined,
        request: () => ({ isNavigationRequest: () => true, url: () => "https://www.example.com/" }),
      });
      throw new Error("net::ERR_FAILED");
    });
    await expect(
      runtime.act(
        firstId,
        action("navigate", "https://example.com/"),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      name: "BrowserNavigationBlockedError",
      url: "https://www.example.com/",
    });
    // A later action starts clean: the old refusal must not relabel an
    // unrelated failure.
    vi.mocked(pages[0]!.goto).mockRejectedValueOnce(new Error("net::ERR_TIMED_OUT"));
    await expect(
      runtime.act(
        firstId,
        action("navigate", "https://example.com/"),
        new AbortController().signal,
      ),
    ).rejects.toThrow("net::ERR_TIMED_OUT");
  });

  it("leaves a page that a followed redirect landed outside the allowlist", async () => {
    const { pages, runtime } = harness();
    await runtime.createContext(firstId, policy, new AbortController().signal);
    // The route guard never sees a redirect Chromium follows inside the
    // routed request; the page simply reports the new URL after goto.
    vi.mocked(pages[0]!.goto).mockImplementationOnce(async () => {
      vi.mocked(pages[0]!.url).mockReturnValue("https://www.example.com/");
    });
    await expect(
      runtime.act(
        firstId,
        action("navigate", "https://example.com/"),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      name: "BrowserNavigationBlockedError",
      url: "https://www.example.com/",
    });
    expect(pages[0]!.goto).toHaveBeenLastCalledWith("about:blank");
  });

  it("aborts a subresource request to an origin outside the context allowlist", async () => {
    const { routeHandlers, runtime } = harness();
    await runtime.createContext(firstId, policy, new AbortController().signal);
    const abort = vi.fn(async () => undefined);
    const continueRequest = vi.fn(async () => undefined);
    await routeHandlers[0]!({
      abort,
      continue: continueRequest,
      request: () => ({
        isNavigationRequest: () => false,
        url: () => "https://cdn.evil.example/tracker.js",
      }),
    });
    expect(abort).toHaveBeenCalledOnce();
    expect(continueRequest).not.toHaveBeenCalled();
  });

  it("keeps loading the loopback origin whose certificate this context accepted", async () => {
    const { routeHandlers, runtime } = harness();
    await runtime.createContext(
      firstId,
      { ...policy, allowedOrigins: ["https://127.0.0.1:8443"], acceptsLocalCertificate: true },
      new AbortController().signal,
    );
    const abort = vi.fn(async () => undefined);
    const continueRequest = vi.fn(async () => undefined);
    const request = (url: string, navigation: boolean) =>
      routeHandlers[0]!({
        abort,
        continue: continueRequest,
        request: () => ({ isNavigationRequest: () => navigation, url: () => url }),
      });

    await request("https://127.0.0.1:8443/", true);
    await request("https://127.0.0.1:8443/assets/app.js", false);
    // A neighbouring self-signed service on the same loopback host is a different
    // origin, so relaxed verification never reaches it.
    await request("https://127.0.0.1:9443/assets/app.js", false);

    expect(continueRequest).toHaveBeenCalledTimes(2);
    expect(abort).toHaveBeenCalledOnce();
  });

  it("refuses a WebSocket outside the allowlist and keeps the allowed one", async () => {
    const { runtime, webSocketRouteHandlers } = harness();
    await runtime.createContext(
      firstId,
      { ...policy, allowedOrigins: ["https://127.0.0.1:8443"], acceptsLocalCertificate: true },
      new AbortController().signal,
    );
    const connected: string[] = [];
    const refused: string[] = [];
    const open = async (url: string) =>
      webSocketRouteHandlers[0]!({
        url: () => url,
        close: async () => void refused.push(url),
        connectToServer: () => void connected.push(url),
      });

    await open("wss://127.0.0.1:8443/events");
    // A WebSocket handshake never reaches the request guard, so without a
    // WebSocket guard this neighbouring self-signed service stays reachable and
    // inherits the relaxed verification the whole context carries.
    await open("wss://127.0.0.1:9443/events");

    expect(connected).toEqual(["wss://127.0.0.1:8443/events"]);
    expect(refused).toEqual(["wss://127.0.0.1:9443/events"]);
  });

  it("closes popup pages to preserve the one-tab host limit", async () => {
    const { pageListeners, runtime } = harness();
    await runtime.createContext(firstId, policy, new AbortController().signal);
    const popup = fakePage("popup");
    pageListeners[0]!(popup);
    await vi.waitFor(() => expect(popup.close).toHaveBeenCalledOnce());
  });

  it("accepts one replacement page after the owned tab is closed", async () => {
    const { pageListeners, runtime } = harness();
    await runtime.createContext(firstId, policy, new AbortController().signal);
    await runtime.act(firstId, action("close-tab"), new AbortController().signal);
    const replacement = fakePage("replacement");
    pageListeners[0]!(replacement);
    expect(replacement.close).not.toHaveBeenCalled();
  });

  it("hashes only a bounded page-text observation", async () => {
    const { pages, runtime } = harness();
    vi.mocked(pages[0]!.textContent).mockResolvedValueOnce("x".repeat(100_000));
    await runtime.createContext(firstId, policy, new AbortController().signal);
    const observed = await runtime.act(
      firstId,
      action("extract-text"),
      new AbortController().signal,
    );
    expect(observed.contentHash).toBe(
      createHash("sha256").update("x".repeat(65_536)).digest("hex"),
    );
    expect(observed.extractedText).toBe("x".repeat(65_536));
  });

  it("returns a bounded screenshot preview for the owned page", async () => {
    const { pages, runtime } = harness();
    await runtime.createContext(firstId, policy, new AbortController().signal);
    const observed = await runtime.act(firstId, action("screenshot"), new AbortController().signal);
    expect(pages[0]!.screenshot).toHaveBeenCalledOnce();
    expect(pages[0]!.screenshot).toHaveBeenCalledWith({
      type: "jpeg",
      quality: 35,
      scale: "css",
    });
    expect(observed.screenshotDataUrl).toBe("data:image/jpeg;base64,AQID");
  });

  it("recompresses screenshots against the provider-visible data URL envelope", async () => {
    const { pages, runtime } = harness();
    vi.mocked(pages[0]!.screenshot)
      .mockResolvedValueOnce(new Uint8Array(42 * 1024))
      .mockResolvedValueOnce(new Uint8Array(30 * 1024));
    await runtime.createContext(firstId, policy, new AbortController().signal);

    const observed = await runtime.act(firstId, action("screenshot"), new AbortController().signal);

    expect(pages[0]!.screenshot).toHaveBeenNthCalledWith(1, {
      type: "jpeg",
      quality: 35,
      scale: "css",
    });
    expect(pages[0]!.screenshot).toHaveBeenNthCalledWith(2, {
      type: "jpeg",
      quality: 8,
      scale: "css",
    });
    expect(observed.screenshotDataUrl?.length).toBeLessThanOrEqual(54 * 1024);
  });

  it("shrinks an oversized screenshot before giving up the shared envelope", async () => {
    const { pages, runtime } = harness();
    vi.mocked(pages[0]!.screenshot)
      .mockResolvedValueOnce(new Uint8Array(48 * 1024))
      .mockResolvedValueOnce(new Uint8Array(44 * 1024))
      .mockResolvedValueOnce(new Uint8Array(30 * 1024));
    await runtime.createContext(firstId, policy, new AbortController().signal);

    const observed = await runtime.act(firstId, action("screenshot"), new AbortController().signal);

    expect(observed.screenshotDataUrl?.length).toBeLessThanOrEqual(54 * 1024);
    expect(pages[0]!.setViewportSize).toHaveBeenNthCalledWith(1, {
      width: 960,
      height: 540,
    });
    expect(pages[0]!.viewportSize()).toEqual({ width: 960, height: 540 });
    expect(observed.viewport).toEqual({ width: 960, height: 540 });
    expect(pages[0]!.screenshot).toHaveBeenCalledTimes(3);
  });

  it("suppresses provider-visible evidence when any frame contains a sensitive field", async () => {
    const { pages, runtime } = harness();
    vi.mocked(pages[0]!.frames).mockReturnValue([
      {
        evaluate: vi.fn(async () => true),
        locator: pages[0]!.locator,
      },
    ] as any);
    await runtime.createContext(firstId, policy, new AbortController().signal);

    const observed = await runtime.act(firstId, action("screenshot"), new AbortController().signal);

    expect(observed.screenshotDataUrl).toBeUndefined();
    expect(observed.contentHash).toBeUndefined();
    expect(pages[0]!.screenshot).not.toHaveBeenCalled();
  });

  it("denies focused typing when a child frame owns a credential field", async () => {
    const { pages, runtime } = harness();
    vi.mocked(pages[0]!.frames).mockReturnValue([
      {
        evaluate: vi.fn(async () => false),
        locator: vi.fn(() => ({
          evaluate: vi.fn(async () => true),
        })),
      },
    ] as any);
    await runtime.createContext(firstId, policy, new AbortController().signal);

    await expect(
      runtime.act(
        firstId,
        { ...action("type"), value: "not-secret" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("sensitive or credential field");
  });

  it("reports process death and closes all owned contexts", async () => {
    const { browser, disconnected, runtime } = harness();
    const listener = vi.fn();
    runtime.onProcessExit(listener);
    await runtime.createContext(firstId, policy, new AbortController().signal);
    disconnected();
    expect(listener).toHaveBeenCalledOnce();
    await runtime.closeAll();
    expect(browser.close).not.toHaveBeenCalled();
  });

  it("retains the receipt after disconnect while the browser group survives", async () => {
    const receiptDirectory = await mkdtemp(join(tmpdir(), "octant-browser-receipts-"));
    try {
      const { browser, disconnected, runtime } = harnessWithReceipt({
        receiptDirectory,
        processGroupExists: () => true,
      });
      await runtime.createContext(firstId, policy, new AbortController().signal);
      expect(await readdir(receiptDirectory)).toHaveLength(1);
      disconnected();
      await runtime.closeAll();
      expect(browser.close).not.toHaveBeenCalled();
      expect(await readdir(receiptDirectory)).toHaveLength(1);
    } finally {
      await rm(receiptDirectory, { recursive: true, force: true });
    }
  });

  it("removes the receipt when a tracked launch fails after the browser group exits", async () => {
    const receiptDirectory = await mkdtemp(join(tmpdir(), "octant-browser-receipts-"));
    try {
      const runtime = new PlaywrightBrowserRuntime({
        executableCandidates: ["/browser"],
        executable: vi.fn(async () => true),
        launch: vi.fn(async (_path, onProcessStarted) => {
          await onProcessStarted?.({ pid: 4321, exited: Promise.resolve() });
          throw new Error("browser connection failed");
        }),
        receiptDirectory,
        processIdentity: async () => `sha256:${"a".repeat(64)}`,
        processGroupExists: () => false,
      });

      await expect(
        runtime.createContext(firstId, policy, new AbortController().signal),
      ).rejects.toThrow("browser connection failed");
      expect(await readdir(receiptDirectory)).toHaveLength(0);
    } finally {
      await rm(receiptDirectory, { recursive: true, force: true });
    }
  });
});

function harnessWithReceipt(options: {
  readonly receiptDirectory: string;
  readonly processGroupExists: (pid: number) => boolean;
}) {
  const pages = [fakePage("first")];
  const contexts: PlaywrightContextPort[] = [
    {
      route: vi.fn(async () => undefined),
      routeWebSocket: vi.fn(async () => undefined),
      on: vi.fn(),
      newPage: vi.fn(async () => pages[0]!),
      close: vi.fn(async () => undefined),
    },
  ];
  let disconnected: (() => void) | undefined;
  const browser: PlaywrightBrowserPort = {
    pid: 4321,
    newContext: vi.fn(async () => contexts.shift()!),
    close: vi.fn(async () => undefined),
    on: (_event, listener) => {
      disconnected = listener;
    },
  };
  const runtime = new PlaywrightBrowserRuntime({
    executableCandidates: ["/browser"],
    executable: vi.fn(async () => true),
    launch: vi.fn(async (_path, onProcessStarted) => {
      await onProcessStarted?.({ pid: 4321, exited: Promise.resolve() });
      return browser;
    }),
    receiptDirectory: options.receiptDirectory,
    processIdentity: async () => `sha256:${"a".repeat(64)}`,
    processGroupExists: options.processGroupExists,
    shutdownTimeoutMs: 1,
  });
  return { browser, disconnected: () => disconnected?.(), runtime };
}
