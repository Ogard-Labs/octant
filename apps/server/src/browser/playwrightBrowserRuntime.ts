import { createHash } from "node:crypto";
import {
  browserRefStillMatches,
  formatBrowserPageSnapshot,
  MAX_BROWSER_SNAPSHOT_NODES,
  MAX_BROWSER_SNAPSHOT_REFS,
  originAllowed,
  parseBrowserKeyChord,
  readBrowserPage,
} from "@octant/domain";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { BrowserContextId, BrowserContextPolicy } from "@octant/contracts/browser-automation";
import { MAX_BROWSER_SCREENSHOT_DATA_URL_CHARACTERS } from "@octant/contracts/browser-automation";
import {
  MAX_BROWSER_DIAGNOSTIC_ENTRIES,
  MAX_BROWSER_DIAGNOSTIC_TEXT_CHARACTERS,
} from "@octant/contracts/browser-automation";
import { MAX_PRODUCT_FEEDBACK_CROP_CHARACTERS } from "@octant/contracts/product-feedback";
import { chromium } from "playwright-core";
import {
  BrowserNavigationBlockedError,
  BrowserProfileUnavailableError,
  BrowserTargetStaleError,
  type BrowserPointObservation,
  type BrowserRuntimeObservation,
  type BrowserRuntimePort,
  type BrowserRuntimeAction,
  type BrowserTargetInspection,
} from "./browserRuntimePort";
import {
  persistProcessReceipt,
  reconcileProcessReceipts,
  type OwnedProcessReceiptHandle,
} from "../process/nodeOwnedProcessReceipt";
import type { ProviderProcessStartedListener } from "../providers/providerRuntimeRegistry";

export interface PlaywrightPagePort {
  goto(url: string): Promise<unknown>;
  click(selector: string): Promise<unknown>;
  fill(selector: string, value: string): Promise<unknown>;
  hover(selector: string): Promise<unknown>;
  selectOption(selector: string, value: string): Promise<unknown>;
  dragAndDrop(source: string, target: string): Promise<unknown>;
  setInputFiles(selector: string, files: ReadonlyArray<string>): Promise<unknown>;
  readonly mouse: {
    click(x: number, y: number): Promise<unknown>;
    wheel(deltaX: number, deltaY: number): Promise<unknown>;
  };
  readonly keyboard: {
    insertText(value: string): Promise<unknown>;
    press(key: string): Promise<unknown>;
  };
  evaluate<T, Argument = void>(
    expression: (argument: Argument) => T,
    argument?: Argument,
  ): Promise<T>;
  frames(): ReadonlyArray<PlaywrightFramePort>;
  /**
   * What the page reported while the agent was driving it. Both are optional
   * because a test double need not model them, and a runtime without them
   * simply yields no diagnostics rather than failing the action.
   */
  on?(event: "console", listener: (message: { type(): string; text(): string }) => void): void;
  on?(
    event: "requestfailed",
    listener: (request: {
      url(): string;
      method(): string;
      failure(): { errorText: string } | null;
    }) => void,
  ): void;
  locator(selector: string): {
    evaluate<T>(expression: (element: Element) => T): Promise<T>;
    waitFor(): Promise<void>;
  };
  screenshot(options: {
    readonly type: "jpeg";
    readonly quality: number;
    readonly scale: "css";
    /** Cut one region out of the page, in CSS pixels. */
    readonly clip?: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };
  }): Promise<Uint8Array>;
  setViewportSize(size: { readonly width: number; readonly height: number }): Promise<void>;
  title(): Promise<string>;
  url(): string;
  viewportSize(): { readonly width: number; readonly height: number } | null;
  textContent(selector: string): Promise<string | null>;
  close(): Promise<void>;
}

export interface PlaywrightFramePort {
  evaluate<T>(expression: () => T): Promise<T>;
  locator(selector: string): {
    evaluate<T>(expression: (element: Element) => T): Promise<T>;
  };
}

export interface PlaywrightContextPort {
  route(
    pattern: string,
    handler: (route: {
      abort(): Promise<unknown>;
      continue(): Promise<unknown>;
      request(): { url(): string; isNavigationRequest(): boolean };
    }) => Promise<void>,
  ): Promise<unknown>;
  routeWebSocket(
    pattern: string,
    handler: (route: {
      url(): string;
      close(options: { readonly code: number; readonly reason: string }): Promise<unknown>;
      connectToServer(): unknown;
    }) => Promise<void>,
  ): Promise<unknown>;
  on(event: "page", listener: (page: PlaywrightPagePort) => void): void;
  newPage(): Promise<PlaywrightPagePort>;
  close(): Promise<void>;
}

export interface PlaywrightBrowserPort {
  newContext(options?: { readonly ignoreHTTPSErrors: true }): Promise<PlaywrightContextPort>;
  close(): Promise<void>;
  on(event: "disconnected", listener: () => void): void;
  readonly pid?: number;
}

export interface PlaywrightBrowserRuntimeOptions {
  readonly executableCandidates: ReadonlyArray<string>;
  readonly executable: (path: string) => Promise<boolean>;
  readonly launch: (
    executablePath: string,
    onProcessStarted?: ProviderProcessStartedListener,
  ) => Promise<PlaywrightBrowserPort>;
  readonly receiptDirectory?: string;
  readonly processIdentity?: (pid: number) => Promise<string | undefined>;
  readonly processGroupExists?: (pid: number) => Promise<boolean> | boolean;
  readonly killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
  readonly shutdownTimeoutMs?: number;
}

interface OwnedRuntimeContext {
  readonly context: PlaywrightContextPort;
  readonly allowedOrigins: ReadonlyArray<string>;
  readonly protectCredentials: boolean;
  readonly maxTabs: number;
  /** The tab in front, the one every action but a tab action acts on. */
  page: PlaywrightPagePort | undefined;
  /** Every tab the agent opened, in order, with the id it knows each by. */
  tabs: Array<{ readonly tabId: string; readonly page: PlaywrightPagePort }>;
  nextTabOrdinal: number;
  /**
   * Set while the agent's own new tab is opening. The context reports every
   * new page, and any page the agent did not open (a popup) is closed; this is
   * how the one it did open is told apart.
   */
  openingTab: boolean;
  /** Last top-level navigation the allowlist refused during the current action. */
  blockedNavigationUrl: string | undefined;
  /**
   * What the page reported since the last diagnostics read. Bounded on write,
   * not on read: a page that logs in a loop must not grow this without limit
   * while the agent is looking elsewhere.
   */
  consoleErrors: Array<{ text: string; url?: string }>;
  failedRequests: Array<{ url: string; method?: string; failure: string }>;
  /**
   * Pages already carrying diagnostic listeners.
   *
   * The context reports a page before `newPage()` resolves, so a replacement
   * page reaches the `page` handler while `owned.page` is still undefined and
   * again when `#page` adopts it. Without this, both calls attach, every entry
   * is recorded twice, and a full buffer holds half as many distinct events as
   * it claims.
   */
  instrumentedPages: WeakSet<PlaywrightPagePort>;
}

export const DEFAULT_BROWSER_EXECUTABLE_CANDIDATES = [
  ...(process.env.OCTANT_BROWSER_EXECUTABLE === undefined
    ? []
    : [process.env.OCTANT_BROWSER_EXECUTABLE]),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
] as const;

export class PlaywrightBrowserRuntime implements BrowserRuntimePort {
  readonly #options: PlaywrightBrowserRuntimeOptions;
  readonly #contexts = new Map<BrowserContextId, OwnedRuntimeContext>();
  readonly #processExitListeners = new Set<() => void>();
  #browser: PlaywrightBrowserPort | undefined;
  #launching: Promise<PlaywrightBrowserPort> | undefined;
  #executablePath: string | undefined;
  #browserPid: number | undefined;
  #receipt: OwnedProcessReceiptHandle = { ready: Promise.resolve(), remove: async () => undefined };
  #receiptReady: Promise<void> = Promise.resolve();

  constructor(options: PlaywrightBrowserRuntimeOptions) {
    this.#options = options;
  }

  async available(): Promise<boolean> {
    return (await this.#resolveExecutable()) !== undefined;
  }

  async createContext(
    contextId: BrowserContextId,
    policy: BrowserContextPolicy,
    signal: AbortSignal,
  ): Promise<"headless"> {
    throwIfAborted(signal);
    if (policy.profileMode !== "isolated") {
      throw new Error("Only host-owned isolated browser contexts are supported.");
    }
    // A second, headless copy of a stored profile would hold different cookies
    // from the desktop app's copy, so a headless page is always Private.
    if (policy.profile !== undefined && policy.profile.kind !== "private") {
      throw new BrowserProfileUnavailableError();
    }
    if (this.#contexts.has(contextId)) throw new Error("Browser context already exists.");
    const browser = await this.#ensureBrowser();
    throwIfAborted(signal);
    // Certificate acceptance belongs to this one context. The host has already
    // refused the flag unless every allowed origin is a loopback HTTPS origin
    // and Playwright can only relax verification for a whole context,
    // never for one origin. The guards below are what make acceptance
    // origin-exact: this context cannot reach any origin outside its allowlist,
    // so a neighbouring self-signed service on another port of the same loopback
    // host is never contacted and no trust root is installed anywhere.
    const context =
      policy.acceptsLocalCertificate === true
        ? await browser.newContext({ ignoreHTTPSErrors: true })
        : await browser.newContext();
    const owned: OwnedRuntimeContext = {
      context,
      allowedOrigins: policy.allowedOrigins,
      protectCredentials: policy.credentialFieldProtection,
      maxTabs: policy.maxConcurrentTabs,
      page: undefined,
      tabs: [],
      nextTabOrdinal: 1,
      openingTab: false,
      blockedNavigationUrl: undefined,
      consoleErrors: [],
      failedRequests: [],
      instrumentedPages: new WeakSet(),
    };
    try {
      // Every request, not only navigations: a subresource reaches the network
      // exactly as a navigation does, and the allowlist is this context's whole
      // authority.
      await context.route("**/*", async (route) => {
        const request = route.request();
        if (!originAllowed(request.url(), policy.allowedOrigins)) {
          // Only a refused top-level navigation explains a failed action to the
          // user; blocked subresources are the allowlist working as intended.
          if (request.isNavigationRequest()) owned.blockedNavigationUrl = request.url();
          await route.abort();
          return;
        }
        await route.continue();
      });
      // A WebSocket handshake never reaches the request guard above: Playwright
      // routes WebSockets through their own interceptor, so the allowlist has to
      // be attached there as well or the origin bound would stop at HTTP while
      // relaxed verification kept covering the whole context. The same predicate
      // decides both, on the http(s) origin a wss:// connection belongs to. What
      // this does not reach is a WebSocket opened from a worker: Playwright
      // intercepts by replacing the document's WebSocket constructor, and that
      // init script never runs in a worker scope.
      await context.routeWebSocket("**/*", async (route) => {
        if (!originAllowed(httpUrlForWebSocket(route.url()), policy.allowedOrigins)) {
          await route.close({
            code: 1008,
            reason: "This origin is outside the context allowlist.",
          });
          return;
        }
        route.connectToServer();
      });
      owned.page = await context.newPage();
      this.#adoptTab(owned, owned.page);
      this.#collectDiagnostics(owned, owned.page);
      context.on("page", (candidate) => {
        // Listen before adopting or closing: a popup can log an error or fail
        // a request while it is briefly open, and closing it discards the
        // listeners that would have recorded that. This is the one place a
        // later page passes through, which is what makes the diagnostics
        // answer cover the popup too instead of only the first page.
        //
        // No comparison against owned.page here: a context reports a page
        // before newPage() resolves, so that comparison is false for the very
        // case it looks like it handles. The collection refuses a page it has
        // already instrumented, which is the property that actually matters.
        this.#collectDiagnostics(owned, candidate);
        if (owned.openingTab) return;
        if (owned.page === undefined) {
          owned.page = candidate;
          this.#adoptTab(owned, candidate);
          return;
        }
        if (candidate !== owned.page) void candidate.close().catch(() => undefined);
      });
      throwIfAborted(signal);
      this.#contexts.set(contextId, owned);
      return "headless";
    } catch (error) {
      await context.close().catch(() => undefined);
      throw error;
    }
  }

  async inspectTarget(
    contextId: BrowserContextId,
    selector: string,
    signal: AbortSignal,
  ): Promise<BrowserTargetInspection> {
    const page = await this.#page(contextId, signal);
    const sensitive = await sensitiveTarget(page, selector);
    throwIfAborted(signal);
    return { sensitive };
  }

  /**
   * Name the element under one point and cut a picture of it.
   *
   * The page is read in the page, because only the page knows what is under a
   * coordinate: the evaluated function resolves the element, walks a short
   * selector path to it, and reports its accessible identity and box. Nothing
   * here acts on the page — a description costs the same as looking.
   */
  async describePoint(
    contextId: BrowserContextId,
    point: { readonly x: number; readonly y: number },
    signal: AbortSignal,
  ): Promise<BrowserPointObservation> {
    const page = await this.#page(contextId, signal);
    const viewport = page.viewportSize();
    if (viewport === null) return { status: "no-element" };
    const described = await page.evaluate(describeElementAtPoint, {
      x: point.x * viewport.width,
      y: point.y * viewport.height,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
    });
    throwIfAborted(signal);
    if (described === null) return { status: "no-element" };
    const crop = await this.#cropDataUrl(page, described.bounds, viewport);
    throwIfAborted(signal);
    return {
      status: "described",
      element: described,
      ...(crop === undefined ? {} : { cropDataUrl: crop }),
      url: page.url(),
      title: await page.title(),
    };
  }

  async #cropDataUrl(
    page: PlaywrightPagePort,
    bounds: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    },
    viewport: { readonly width: number; readonly height: number },
  ): Promise<string | undefined> {
    // A little air around the element keeps the crop legible: an element cut to
    // its exact box reads as a fragment with nothing to place it against.
    const padX = Math.min(24, viewport.width * 0.05);
    const padY = Math.min(24, viewport.height * 0.05);
    const x = Math.max(0, bounds.x * viewport.width - padX);
    const y = Math.max(0, bounds.y * viewport.height - padY);
    const width = Math.min(viewport.width - x, bounds.width * viewport.width + padX * 2);
    const height = Math.min(viewport.height - y, bounds.height * viewport.height + padY * 2);
    if (width < 1 || height < 1) return undefined;
    try {
      const bytes = await page.screenshot({
        type: "jpeg",
        quality: 60,
        scale: "css",
        clip: { x, y, width, height },
      });
      const url = jpegDataUrl(bytes);
      return url.length <= MAX_PRODUCT_FEEDBACK_CROP_CHARACTERS ? url : undefined;
    } catch {
      return undefined;
    }
  }

  async peek(contextId: BrowserContextId, signal: AbortSignal): Promise<BrowserRuntimeObservation> {
    const page = await this.#page(contextId, signal);
    return this.#observe(page, this.#contexts.get(contextId)?.protectCredentials ?? true, {
      text: false,
      screenshot: true,
      snapshot: false,
    });
  }

  async act(
    contextId: BrowserContextId,
    request: BrowserRuntimeAction,
    signal: AbortSignal,
  ): Promise<BrowserRuntimeObservation> {
    const page = await this.#page(contextId, signal);
    const owned = this.#contexts.get(contextId);
    if (owned !== undefined) owned.blockedNavigationUrl = undefined;
    await refuseStaleTarget(page, request.target, request.expected);
    await refuseStaleTarget(page, request.destination, request.destinationExpected);
    switch (request.kind) {
      case "navigate":
        try {
          await page.goto(required(request.target, "Navigate actions require a URL."));
        } catch (error) {
          const blocked = this.#contexts.get(contextId)?.blockedNavigationUrl;
          throw blocked === undefined ? error : new BrowserNavigationBlockedError(blocked);
        }
        break;
      case "click":
        if (request.point === undefined) {
          await page.click(required(request.target, "Click actions require a selector or point."));
        } else {
          const point = viewportPoint(page, request.point);
          await page.mouse.click(point.x, point.y);
        }
        break;
      case "type": {
        const selector = request.target ?? ":focus";
        if (await sensitiveTarget(page, selector)) {
          throw new Error("Octant will not type into a sensitive or credential field.");
        }
        const value = required(request.value, "Type actions require a value.");
        if (request.target === undefined) await page.keyboard.insertText(value);
        else await page.fill(request.target, value);
        break;
      }
      case "press":
        if (await sensitiveTarget(page, ":focus")) {
          throw new Error("Octant will not type into a sensitive or credential field.");
        }
        await page.keyboard.press(
          playwrightKey(required(request.value, "Press actions require a key.")),
        );
        break;
      case "scroll":
        await page.mouse.wheel(request.deltaX ?? 0, request.deltaY ?? 500);
        break;
      case "screenshot":
        break;
      case "extract-text":
        break;
      case "snapshot":
        break;
      case "observe-diagnostics": {
        // Hand over what the page reported and clear it: the next read answers
        // "what happened since I last looked", which is the question an agent
        // actually has, and keeps one failure from being reported forever.
        const diagnostics = {
          consoleErrors: [...owned!.consoleErrors],
          failedRequests: [...owned!.failedRequests],
        };
        owned!.consoleErrors.length = 0;
        owned!.failedRequests.length = 0;
        return diagnostics;
      }
      case "wait":
        await page.locator(required(request.target, "Wait actions require a selector.")).waitFor();
        break;
      case "hover":
        await page.hover(required(request.target, "Hover actions require an element."));
        break;
      case "select": {
        const selector = required(request.target, "Select actions require an element.");
        const choice = required(request.value, "Select actions require an option.");
        // Playwright waits for a missing option until its timeout; a page with
        // no such option is the agent's mistake to hear about now.
        const exists = await page
          .locator(selector)
          .evaluate((element) =>
            element instanceof HTMLSelectElement
              ? Array.from(element.options).map((option) => [option.value, option.label])
              : [],
          );
        if (!exists.some((pair) => pair.includes(choice))) {
          throw new Error("The list has no option with that value or label.");
        }
        await page.selectOption(selector, choice);
        break;
      }
      case "drag":
        await page.dragAndDrop(
          required(request.target, "Drag actions require an element."),
          required(request.destination, "Drag actions require where to drop."),
        );
        break;
      case "upload":
        await page.setInputFiles(
          required(request.target, "Upload actions require a file field."),
          request.files ?? [],
        );
        break;
      case "tab-list":
        return this.#tabsObservation(required(owned, "Browser context is unavailable."));
      case "tab-open": {
        const tabs = required(owned, "Browser context is unavailable.");
        if (tabs.tabs.length >= tabs.maxTabs) {
          throw new Error("This browser context is at its tab limit.");
        }
        tabs.openingTab = true;
        let opened: PlaywrightPagePort;
        try {
          opened = await tabs.context.newPage();
        } finally {
          tabs.openingTab = false;
        }
        this.#collectDiagnostics(tabs, opened);
        this.#adoptTab(tabs, opened);
        tabs.page = opened;
        if (request.target !== undefined) {
          try {
            await opened.goto(request.target);
          } catch (error) {
            const blocked = tabs.blockedNavigationUrl;
            throw blocked === undefined ? error : new BrowserNavigationBlockedError(blocked);
          }
        }
        return this.#tabsObservation(tabs);
      }
      case "tab-select": {
        const tabs = required(owned, "Browser context is unavailable.");
        const chosen = tabs.tabs.find((tab) => tab.tabId === request.tabId);
        if (chosen === undefined) throw new Error("This browser context has no such tab.");
        tabs.page = chosen.page;
        return this.#tabsObservation(tabs);
      }
      case "tab-close": {
        const tabs = required(owned, "Browser context is unavailable.");
        const index = tabs.tabs.findIndex((tab) => tab.tabId === request.tabId);
        const closing = tabs.tabs[index];
        if (closing === undefined) throw new Error("This browser context has no such tab.");
        if (tabs.tabs.length === 1) throw new Error("A browser context keeps its last tab.");
        tabs.tabs.splice(index, 1);
        await closing.page.close();
        if (tabs.page === closing.page) {
          tabs.page = tabs.tabs[Math.min(index, tabs.tabs.length - 1)]?.page;
        }
        return this.#tabsObservation(tabs);
      }
      case "close-tab": {
        await page.close();
        const tabs = this.#contexts.get(contextId);
        if (tabs !== undefined) {
          tabs.tabs = tabs.tabs.filter((tab) => tab.page !== page);
          tabs.page = tabs.tabs.at(-1)?.page;
        }
        return {};
      }
    }
    // Chromium follows a redirect inside the routed request, so a top-level
    // document can land on an origin the request guard never saw. The
    // allowlist is this context's whole authority: leave the page rather than
    // observe, script, or screenshot an origin outside it.
    const landed = page.url();
    if (
      owned !== undefined &&
      /^https?:/i.test(landed) &&
      !originAllowed(landed, owned.allowedOrigins)
    ) {
      await page.goto("about:blank").catch(() => undefined);
      throw new BrowserNavigationBlockedError(landed);
    }
    throwIfAborted(signal);
    if (request.kind === "snapshot") {
      return this.#snapshot(page, owned?.protectCredentials ?? true);
    }
    const include = new Set(request.include ?? []);
    return this.#observe(
      page,
      owned?.protectCredentials ?? true,
      {
        text: request.kind === "extract-text" || include.has("text"),
        screenshot: request.kind === "screenshot" || include.has("screenshot"),
        snapshot: include.has("snapshot"),
      },
      request.kind === "extract-text" ? request.target : undefined,
    );
  }

  async closeContext(contextId: BrowserContextId): Promise<void> {
    const owned = this.#contexts.get(contextId);
    if (owned === undefined) return;
    this.#contexts.delete(contextId);
    await owned.context.close();
  }

  async closeAll(): Promise<void> {
    const contexts = [...this.#contexts.values()];
    this.#contexts.clear();
    await Promise.allSettled(contexts.map(async (owned) => owned.context.close()));
    const browser = this.#browser;
    this.#browser = undefined;
    this.#launching = undefined;
    if (browser !== undefined) {
      await browser.close();
    }
    await this.#receiptReady.catch(() => undefined);
    if (await this.#waitForProcessGroupExit(this.#browserPid)) {
      await this.#receipt.remove();
      this.#browserPid = undefined;
    }
  }

  async reconcile(): Promise<void> {
    await reconcileProcessReceipts({
      supervisor: "browser",
      ...(this.#options.receiptDirectory === undefined
        ? {}
        : { receiptDirectory: this.#options.receiptDirectory }),
      ...(this.#options.processIdentity === undefined
        ? {}
        : { processIdentity: this.#options.processIdentity }),
      ...(this.#options.processGroupExists === undefined
        ? {}
        : { processGroupExists: this.#options.processGroupExists }),
      ...(this.#options.killProcessGroup === undefined
        ? {}
        : { killProcessGroup: this.#options.killProcessGroup }),
      ...(this.#options.shutdownTimeoutMs === undefined
        ? {}
        : { shutdownTimeoutMs: this.#options.shutdownTimeoutMs }),
    });
  }

  onProcessExit(listener: () => void): () => void {
    this.#processExitListeners.add(listener);
    return () => this.#processExitListeners.delete(listener);
  }

  async #ensureBrowser(): Promise<PlaywrightBrowserPort> {
    if (this.#browser !== undefined) return this.#browser;
    if (this.#launching !== undefined) return this.#launching;
    const executablePath = await this.#resolveExecutable();
    if (executablePath === undefined)
      throw new Error("No supported Chromium executable was found.");
    this.#launching = this.#options
      .launch(executablePath, (process) => this.#persistBrowserProcess(process))
      .then(async (browser) => {
        this.#browser = browser;
        browser.on("disconnected", () => {
          if (this.#browser !== browser) return;
          this.#browser = undefined;
          this.#launching = undefined;
          this.#contexts.clear();
          for (const listener of this.#processExitListeners) listener();
        });
        return browser;
      });
    const launching = this.#launching;
    try {
      return await launching;
    } catch (error) {
      const receipt = this.#receipt;
      const pid = this.#browserPid;
      await this.#receiptReady.catch(() => undefined);
      if (await this.#waitForProcessGroupExit(pid)) {
        await receipt.remove();
        if (this.#receipt === receipt) {
          this.#receipt = { ready: Promise.resolve(), remove: async () => undefined };
          this.#receiptReady = Promise.resolve();
          this.#browserPid = undefined;
        }
      }
      if (this.#launching === launching) this.#launching = undefined;
      throw error;
    }
  }

  async #resolveExecutable(): Promise<string | undefined> {
    if (this.#executablePath !== undefined) return this.#executablePath;
    for (const candidate of this.#options.executableCandidates) {
      if (!isAbsolute(candidate) || !(await this.#options.executable(candidate))) continue;
      this.#executablePath = candidate;
      return candidate;
    }
    return undefined;
  }

  async #page(contextId: BrowserContextId, signal: AbortSignal): Promise<PlaywrightPagePort> {
    throwIfAborted(signal);
    const owned = this.#contexts.get(contextId);
    if (owned === undefined) throw new Error("Browser context is unavailable.");
    if (owned.page === undefined) {
      owned.page = await owned.context.newPage();
      this.#adoptTab(owned, owned.page);
      this.#collectDiagnostics(owned, owned.page);
    }
    throwIfAborted(signal);
    return owned.page;
  }

  /**
   * Keep what the page reports, bounded as it arrives.
   *
   * The listeners are attached where pages are created — the one place both
   * the initial page and any later one pass through — so an agent that asks for
   * diagnostics gets what happened on this page rather than only what happened
   * since it started listening. Both arrays drop their oldest entry once they
   * are full: the last errors before a failure are the ones worth reading.
   */
  #collectDiagnostics(owned: OwnedRuntimeContext, page: PlaywrightPagePort): void {
    // Attaching twice would record every entry twice, so a full buffer would
    // hold half as many distinct events as its limit claims. Callers cannot
    // deduplicate this themselves: a replacement page arrives from the context
    // while owned.page is still undefined, and again when it is adopted.
    if (owned.instrumentedPages.has(page)) return;
    owned.instrumentedPages.add(page);
    page.on?.("console", (message) => {
      if (message.type() !== "error") return;
      const text = bounded(message.text(), MAX_BROWSER_DIAGNOSTIC_TEXT_CHARACTERS);
      if (text === "") return;
      const url = page.url() === "about:blank" ? undefined : bounded(page.url(), 4096);
      if (owned.consoleErrors.length >= MAX_BROWSER_DIAGNOSTIC_ENTRIES) owned.consoleErrors.shift();
      owned.consoleErrors.push({ text, ...(url === undefined ? {} : { url }) });
    });
    page.on?.("requestfailed", (request) => {
      const url = bounded(request.url(), 4096);
      if (url === "") return;
      const method = bounded(request.method(), 16);
      const failure = bounded(
        request.failure()?.errorText ?? "The request did not complete.",
        MAX_BROWSER_DIAGNOSTIC_TEXT_CHARACTERS,
      );
      if (owned.failedRequests.length >= MAX_BROWSER_DIAGNOSTIC_ENTRIES)
        owned.failedRequests.shift();
      owned.failedRequests.push({
        url,
        ...(method === "" ? {} : { method }),
        failure: failure === "" ? "The request did not complete." : failure,
      });
    });
  }

  async #waitForProcessGroupExit(pid: number | undefined): Promise<boolean> {
    if (this.#options.receiptDirectory === undefined || pid === undefined) return true;
    const timeoutMs = this.#options.shutdownTimeoutMs ?? 2_000;
    const processGroupExists =
      this.#options.processGroupExists ??
      ((groupPid: number) => {
        try {
          process.kill(process.platform === "win32" ? groupPid : -groupPid, 0);
          return true;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ESRCH") return false;
          if (code === "EPERM") return true;
          throw error;
        }
      });
    const deadline = Date.now() + timeoutMs;
    while (await processGroupExists(pid)) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    return true;
  }

  async #persistBrowserProcess(
    process: Parameters<ProviderProcessStartedListener>[0],
  ): Promise<OwnedProcessReceiptHandle> {
    this.#browserPid = process.pid;
    try {
      const receipt = await persistProcessReceipt(
        {
          supervisor: "browser",
          ...(this.#options.receiptDirectory === undefined
            ? {}
            : { receiptDirectory: this.#options.receiptDirectory }),
          ...(this.#options.processIdentity === undefined
            ? {}
            : { processIdentity: this.#options.processIdentity }),
        },
        "browser",
        process.pid,
      );
      this.#receipt = receipt;
      this.#receiptReady = receipt.ready;
      await receipt.ready;
      return receipt;
    } catch (error) {
      this.#browserPid = undefined;
      throw error;
    }
  }

  /** Give a page the agent will act on an id it can name it by. */
  #adoptTab(owned: OwnedRuntimeContext, page: PlaywrightPagePort): void {
    owned.tabs.push({ tabId: `t${String(owned.nextTabOrdinal)}`, page });
    owned.nextTabOrdinal += 1;
  }

  /** The tabs as they now stand, after a tab action, with the one in front. */
  async #tabsObservation(owned: OwnedRuntimeContext): Promise<BrowserRuntimeObservation> {
    const tabs = await Promise.all(
      owned.tabs.map(async (tab) => {
        const title = await tab.page.title().catch(() => "");
        const url = tab.page.url();
        return {
          tabId: tab.tabId,
          ...(url === "about:blank" ? {} : { url: bounded(url, 4096) }),
          ...(title.trim() === "" ? {} : { title: bounded(title, 1024) }),
          active: tab.page === owned.page,
        };
      }),
    );
    const front = owned.page;
    if (front === undefined) return { tabs };
    const title = await front.title();
    return {
      ...(front.url() === "about:blank" ? {} : { url: bounded(front.url(), 4096) }),
      ...(title.trim() === "" ? {} : { title: bounded(title, 1024) }),
      tabs,
    };
  }

  /**
   * The page as an outline with refs. No picture and no page text: the outline
   * is the whole answer, and a credential field in it is named, never valued.
   */
  async #snapshot(
    page: PlaywrightPagePort,
    protectCredentials: boolean,
  ): Promise<BrowserRuntimeObservation> {
    const read = await page.evaluate(readBrowserPage, {
      mode: "snapshot",
      maxRefs: MAX_BROWSER_SNAPSHOT_REFS,
      maxNodes: MAX_BROWSER_SNAPSHOT_NODES,
      protectCredentials,
      // Every frame and shadow root, which the in-page reader does not walk.
      withholdValues: protectCredentials && (await sensitiveDocument(page)),
    });
    if (read.mode !== "snapshot") throw new Error("Browser snapshot is unavailable.");
    const title = await page.title();
    const viewport = page.viewportSize();
    return {
      ...(page.url() === "about:blank" ? {} : { url: bounded(page.url(), 4096) }),
      ...(title.trim() === "" ? {} : { title: bounded(title, 1024) }),
      snapshot: formatBrowserPageSnapshot(read.snapshot),
      snapshotRefs: read.snapshot.refs,
      ...(viewport === null ? {} : { viewport }),
    };
  }

  /**
   * The page after an action: its address, title, and a hash of its text, so
   * the server can say what changed. The text itself, a picture, and an
   * outline cost the model tokens and the host a capture, so each comes back
   * only when asked for.
   */
  async #observe(
    page: PlaywrightPagePort,
    protectCredentials: boolean,
    parts: { readonly text: boolean; readonly screenshot: boolean; readonly snapshot: boolean },
    selector?: string,
  ): Promise<BrowserRuntimeObservation> {
    const outline = parts.snapshot ? await this.#snapshot(page, protectCredentials) : {};
    if (protectCredentials && (await sensitiveDocument(page))) {
      const title = await page.title();
      const viewport = page.viewportSize();
      return {
        ...outline,
        ...(page.url() === "about:blank" ? {} : { url: bounded(page.url(), 4096) }),
        ...(title.trim() === "" ? {} : { title: bounded(title, 1024) }),
        ...(viewport === null ? {} : { viewport }),
      };
    }
    const [title, text, selected, screenshotDataUrl] = await Promise.all([
      page.title(),
      page.textContent("body"),
      parts.text && selector !== undefined ? page.textContent(selector) : Promise.resolve(null),
      parts.screenshot ? boundedScreenshotDataUrl(page) : Promise.resolve(undefined),
    ]);
    const boundedText = bounded(text ?? "", 65_536);
    const viewport = page.viewportSize();
    return {
      ...outline,
      ...(page.url() === "about:blank" ? {} : { url: bounded(page.url(), 4096) }),
      ...(title.trim() === "" ? {} : { title: bounded(title, 1024) }),
      contentHash: createHash("sha256").update(boundedText).digest("hex"),
      ...(parts.text
        ? { extractedText: selector === undefined ? boundedText : bounded(selected ?? "", 65_536) }
        : {}),
      ...(screenshotDataUrl === undefined ? {} : { screenshotDataUrl }),
      ...(viewport === null ? {} : { viewport }),
    };
  }
}

async function sensitiveTarget(page: PlaywrightPagePort, selector: string): Promise<boolean> {
  const frames = selector === ":focus" ? page.frames() : [page];
  for (const frame of frames) {
    try {
      if (await frame.locator(selector).evaluate(isSensitiveElement)) return true;
    } catch {
      if (selector !== ":focus") return true;
    }
  }
  return false;
}

function isSensitiveElement(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  const type = (element.getAttribute("type") ?? "").toLowerCase();
  const autocomplete = (element.getAttribute("autocomplete") ?? "").toLowerCase();
  const name = (element.getAttribute("name") ?? "").toLowerCase();
  const id = (element.getAttribute("id") ?? "").toLowerCase();
  const ariaLabel = (element.getAttribute("aria-label") ?? "").toLowerCase();
  const contentEditable = (element.getAttribute("contenteditable") ?? "false").toLowerCase();
  const hint = `${type} ${autocomplete} ${name} ${id} ${ariaLabel}`;
  return (
    (tag === "input" || tag === "textarea" || contentEditable !== "false") &&
    (type === "password" ||
      /(?:password|passcode|one-time-code|otp|webauthn|cc-|credit|card|ssn|secret|token|api.?key)/.test(
        hint,
      ))
  );
}

async function sensitiveDocument(page: PlaywrightPagePort): Promise<boolean> {
  for (const frame of page.frames()) {
    try {
      const sensitive = await frame.evaluate(() => {
        const roots: Array<Document | ShadowRoot> = [document];
        for (let index = 0; index < roots.length; index += 1) {
          const root = roots[index];
          if (root === undefined) continue;
          for (const element of root.querySelectorAll("*")) {
            if (element.shadowRoot !== null) roots.push(element.shadowRoot);
          }
        }
        return roots.some((root) =>
          Array.from(root.querySelectorAll("input, textarea, [contenteditable]")).some(
            (element) => {
              const hint = [
                element.getAttribute("type"),
                element.getAttribute("autocomplete"),
                element.getAttribute("name"),
                element.id,
                element.getAttribute("aria-label"),
              ]
                .join(" ")
                .toLowerCase();
              return /(?:password|passcode|one-time-code|otp|webauthn|cc-|credit|card|ssn|secret|token|api.?key)/.test(
                hint,
              );
            },
          ),
        );
      });
      if (sensitive) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * The chord as Playwright reads it. A letter is the key a keyboard sends: lower
 * case, or upper case only with Shift held, so `Control+B` reaches the page as
 * `b` with Control, as it does from a person's keyboard and the desktop Browser.
 */
function playwrightKey(value: string): string {
  const chord = parseBrowserKeyChord(value);
  if (chord === undefined) return value;
  const key =
    chord.key === "Space"
      ? "Space"
      : /^[A-Za-z]$/.test(chord.key)
        ? chord.modifiers.includes("Shift")
          ? chord.key.toUpperCase()
          : chord.key.toLowerCase()
        : chord.key;
  return [...chord.modifiers, key].join("+");
}

/** Refuse a ref whose page moved on or whose element is no longer the one named. */
async function refuseStaleTarget(
  page: PlaywrightPagePort,
  selector: string | undefined,
  expected: BrowserRuntimeAction["expected"],
): Promise<void> {
  if (expected === undefined || selector === undefined) return;
  const found = await page.evaluate(readBrowserPage, { mode: "verify", selector });
  const pageUrl = page.url() === "about:blank" ? "about:blank" : bounded(page.url(), 4096);
  if (found.mode !== "verify" || !browserRefStillMatches(expected, found.element, pageUrl)) {
    throw new BrowserTargetStaleError();
  }
}

function viewportPoint(
  page: PlaywrightPagePort,
  point: { readonly x: number; readonly y: number },
): { readonly x: number; readonly y: number } {
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error("Browser viewport is unavailable.");
  return { x: point.x * viewport.width, y: point.y * viewport.height };
}

async function boundedScreenshotDataUrl(page: PlaywrightPagePort): Promise<string | undefined> {
  const initialUrl = jpegDataUrl(
    await page.screenshot({ type: "jpeg", quality: 35, scale: "css" }),
  );
  if (initialUrl.length <= MAX_BROWSER_SCREENSHOT_DATA_URL_CHARACTERS) return initialUrl;
  const compressedUrl = jpegDataUrl(
    await page.screenshot({ type: "jpeg", quality: 8, scale: "css" }),
  );
  if (compressedUrl.length <= MAX_BROWSER_SCREENSHOT_DATA_URL_CHARACTERS) return compressedUrl;

  const originalViewport = page.viewportSize();
  if (originalViewport === null) return undefined;
  for (const scale of [0.75, 0.5, 0.375]) {
    await page.setViewportSize({
      width: Math.max(320, Math.floor(originalViewport.width * scale)),
      height: Math.max(200, Math.floor(originalViewport.height * scale)),
    });
    const resizedUrl = jpegDataUrl(
      await page.screenshot({ type: "jpeg", quality: 8, scale: "css" }),
    );
    if (resizedUrl.length <= MAX_BROWSER_SCREENSHOT_DATA_URL_CHARACTERS) return resizedUrl;
  }
  await page.setViewportSize(originalViewport);
  return undefined;
}

/**
 * Runs inside the page: only the page can say what is under a coordinate.
 *
 * The selector is a short structural path — id when there is one, otherwise tag
 * plus nth-of-type — which is enough to name the element to a person and to an
 * agent without pretending to be a durable test locator. Text and accessible
 * name are bounded here, at the source, so nothing unbounded ever crosses back.
 */
export function describeElementAtPoint(argument: {
  readonly x: number;
  readonly y: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}): {
  readonly selector: string;
  readonly role?: string;
  readonly accessibleName?: string;
  readonly text?: string;
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
} | null {
  const element = document.elementFromPoint(argument.x, argument.y);
  if (element === null) return null;

  const step = (node: Element): string => {
    const id = node.getAttribute("id");
    if (id !== null && id.trim().length > 0 && /^[A-Za-z][\w-]*$/.test(id)) return `#${id}`;
    const tag = node.tagName.toLowerCase();
    const parent = node.parentElement;
    if (parent === null) return tag;
    const siblings = [...parent.children].filter((child) => child.tagName === node.tagName);
    return siblings.length <= 1 ? tag : `${tag}:nth-of-type(${String(siblings.indexOf(node) + 1)})`;
  };

  const path: string[] = [];
  let current: Element | null = element;
  while (current !== null && path.length < 6 && current.tagName.toLowerCase() !== "html") {
    const piece = step(current);
    path.unshift(piece);
    if (piece.startsWith("#")) break;
    current = current.parentElement;
  }

  const rect = element.getBoundingClientRect();
  const label = element.getAttribute("aria-label");
  const role = element.getAttribute("role");
  const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
  const implicitRole = element.tagName.toLowerCase();
  return {
    selector: path.join(" > ").slice(0, 1_024),
    role: (role ?? implicitRole).slice(0, 64),
    ...(label === null || label.trim().length === 0
      ? {}
      : { accessibleName: label.trim().slice(0, 512) }),
    ...(text.length === 0 ? {} : { text: text.slice(0, 2_048) }),
    bounds: {
      x: Math.min(1, Math.max(0, rect.left / argument.viewportWidth)),
      y: Math.min(1, Math.max(0, rect.top / argument.viewportHeight)),
      width: Math.min(1, Math.max(0, rect.width / argument.viewportWidth)),
      height: Math.min(1, Math.max(0, rect.height / argument.viewportHeight)),
    },
  };
}

function jpegDataUrl(bytes: Uint8Array): string {
  return `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`;
}

export function createPlaywrightBrowserRuntime(
  overrides: Pick<
    PlaywrightBrowserRuntimeOptions,
    | "receiptDirectory"
    | "processIdentity"
    | "processGroupExists"
    | "killProcessGroup"
    | "shutdownTimeoutMs"
  > = {},
): PlaywrightBrowserRuntime {
  return new PlaywrightBrowserRuntime({
    executableCandidates: DEFAULT_BROWSER_EXECUTABLE_CANDIDATES,
    executable: async (path) => {
      try {
        await access(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    launch: async (executablePath, onProcessStarted) => {
      const browser = await chromium.launch({
        executablePath,
        headless: true,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      });
      try {
        const pid = launchedBrowserPid(browser);
        if (pid === undefined) throw new Error("Owned browser process identity is unavailable.");
        const exited = new Promise<void>((resolveExit) => {
          browser.on("disconnected", () => resolveExit());
        });
        await onProcessStarted?.({ pid, exited });
        const ownedBrowser = browser as unknown as PlaywrightBrowserPort & { pid?: number };
        Object.defineProperty(ownedBrowser, "pid", { value: pid });
        return ownedBrowser;
      } catch (error) {
        await browser.close().catch(() => undefined);
        throw error;
      }
    },
    ...overrides,
  });
}

function launchedBrowserPid(browser: unknown): number | undefined {
  try {
    const candidate = browser as {
      readonly _connection?: {
        toImpl?: (value: unknown) => {
          readonly options?: {
            readonly browserProcess?: { readonly process?: { readonly pid?: unknown } };
          };
        };
      };
    };
    const pid = candidate._connection?.toImpl?.(browser)?.options?.browserProcess?.process?.pid;
    return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Browser action was interrupted.", "AbortError");
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

function bounded(value: string, maximum: number): string {
  return value.length <= maximum ? value : value.slice(0, maximum);
}

// A wss:// connection belongs to the https:// origin that opened it, so the one
// allowlist rule can judge it once the scheme is mapped back. An unparsable URL
// is left alone and the rule refuses it.
function httpUrlForWebSocket(target: string): string {
  try {
    const url = new URL(target);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") return target;
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    return url.href;
  } catch {
    return target;
  }
}
