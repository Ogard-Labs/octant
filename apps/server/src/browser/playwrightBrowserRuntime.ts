import { createHash } from "node:crypto";
import {
  awaitQuietPage,
  BROWSER_DIALOG_POLICY,
  BROWSER_SETTLE_CAP_MS,
  BROWSER_SHADOW_HOP,
  browserFrameAdmitted,
  BROWSER_SETTLE_QUIET_MS,
  browserPageConditions,
  browserRefStillMatches,
  describeUnmetWait,
  dialogType,
  formatBrowserPageSnapshot,
  readFramedBrowserSnapshot,
  splitBrowserFrameTarget,
  waitSatisfied,
  MAX_BROWSER_SNAPSHOT_NODES,
  MAX_BROWSER_SNAPSHOT_REFS,
  originAllowed,
  parseBrowserKeyChord,
  readBrowserPage,
  redactedBrowserUrl,
} from "@octant/domain";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type {
  BrowserContextId,
  BrowserContextPolicy,
  BrowserEmulationReport,
} from "@octant/contracts/browser-automation";
import {
  DEFAULT_BROWSER_WAIT_MS,
  MAX_BROWSER_SCREENSHOT_DATA_URL_CHARACTERS,
  MAX_BROWSER_WAIT_MS,
} from "@octant/contracts/browser-automation";
import {
  MAX_BROWSER_DIAGNOSTIC_ENTRIES,
  MAX_BROWSER_DIAGNOSTIC_TEXT_CHARACTERS,
} from "@octant/contracts/browser-automation";
import { MAX_PRODUCT_FEEDBACK_CROP_CHARACTERS } from "@octant/contracts/product-feedback";
import { browserDownloadHoldRoot, prepareBrowserDownloadHoldRoot } from "@octant/host-runtime";
import { chromium } from "playwright-core";
import {
  DownloadFolderWatch,
  PlaywrightDownloadHold,
  type PlaywrightDownloadPort,
} from "./playwrightDownloadHold";
import {
  BrowserNavigationBlockedError,
  BrowserProfileUnavailableError,
  BrowserTargetStaleError,
  BrowserWaitTimedOutError,
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
    event: "dialog",
    listener: (dialog: {
      type(): string;
      message(): string;
      accept(): Promise<void>;
      dismiss(): Promise<void>;
    }) => void,
  ): void;
  on?(
    event: "response",
    listener: (response: {
      status(): number;
      url(): string;
      request(): { method(): string };
    }) => void,
  ): void;
  on?(
    event: "requestfailed",
    listener: (request: {
      url(): string;
      method(): string;
      failure(): { errorText: string } | null;
    }) => void,
  ): void;
  /**
   * A download the page started. Optional like the other listeners; the
   * context accepts downloads by default, and the runtime cancels every one it
   * is not holding for an agent action.
   */
  on?(event: "download", listener: (download: PlaywrightDownloadPort) => void): void;
  locator(selector: string): {
    evaluate<T>(expression: (element: Element) => T): Promise<T>;
    waitFor(options?: { readonly timeout: number }): Promise<void>;
  };
  /** Optional, like the event listeners: a test double need not model loading. */
  waitForLoadState?(
    state: "load" | "domcontentloaded",
    options: { readonly timeout: number },
  ): Promise<void>;
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
  /**
   * Optional, like the event listeners: a test double need not model device
   * emulation, and a resize on one that does not fails with its own message.
   */
  emulateMedia?(options: { readonly colorScheme: "light" | "dark" | null }): Promise<void>;
  context?(): {
    newCDPSession(page: PlaywrightPagePort): Promise<PlaywrightProtocolSessionPort>;
  };
  title(): Promise<string>;
  url(): string;
  viewportSize(): { readonly width: number; readonly height: number } | null;
  textContent(selector: string): Promise<string | null>;
  close(): Promise<void>;
  /**
   * The element a selector names, for stepping into the frame it holds.
   * Optional: a test double need not model frames.
   */
  $?(selector: string): Promise<PlaywrightElementPort | null>;
}

/** One document of a page: the page's own, or a frame's. Playwright's frames answer the same calls. */
export type PlaywrightDocumentPort = Pick<
  PlaywrightPagePort,
  | "click"
  | "fill"
  | "hover"
  | "selectOption"
  | "dragAndDrop"
  | "setInputFiles"
  | "evaluate"
  | "locator"
  | "textContent"
  | "url"
  | "$"
>;

export interface PlaywrightElementPort {
  contentFrame(): Promise<PlaywrightDocumentPort | null>;
}

/** A DevTools protocol session on one page, which the runtime owns and drops with the page. */
export interface PlaywrightProtocolSessionPort {
  send(method: string, parameters?: Record<string, unknown>): Promise<unknown>;
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
  /** Where the browser writes a download as it arrives; see `PlaywrightDownloadHold`. */
  readonly downloadFolder?: string;
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
  consoleErrors: Array<{ text: string; url?: string; seq: number }>;
  consoleWarnings: Array<{ text: string; url?: string; seq: number }>;
  httpErrors: Array<{ url: string; method?: string; status: number; seq: number }>;
  /** The last diagnostic entry's number; every kind shares the count. */
  diagnosticSeq: number;
  /** The pages' own dialogs since the last action, answered by the fixed policy. */
  dialogs: Array<{
    type: "alert" | "confirm" | "prompt" | "beforeunload";
    message: string;
    answer: "accepted" | "dismissed";
  }>;
  failedRequests: Array<{ url: string; method?: string; failure: string; seq: number }>;
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
  /** The files the agent's actions made this context hold; see the class. */
  readonly downloads: PlaywrightDownloadHold;
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
  /** Measures the browser's one download folder for every context; see the class. */
  readonly #downloadWatch: DownloadFolderWatch;
  readonly #emulation = new WeakMap<PlaywrightPagePort, PageEmulation>();
  readonly #processExitListeners = new Set<() => void>();
  #browser: PlaywrightBrowserPort | undefined;
  #launching: Promise<PlaywrightBrowserPort> | undefined;
  #executablePath: string | undefined;
  #browserPid: number | undefined;
  #receipt: OwnedProcessReceiptHandle = { ready: Promise.resolve(), remove: async () => undefined };
  #receiptReady: Promise<void> = Promise.resolve();

  constructor(options: PlaywrightBrowserRuntimeOptions) {
    this.#options = options;
    this.#downloadWatch = new DownloadFolderWatch(options.downloadFolder);
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
      consoleWarnings: [],
      httpErrors: [],
      diagnosticSeq: 0,
      dialogs: [],
      failedRequests: [],
      instrumentedPages: new WeakSet(),
      downloads: new PlaywrightDownloadHold(this.#downloadWatch),
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
    // A field inside a frame is checked in that frame; one that cannot be
    // reached is treated as sensitive, as an unreadable field always was.
    const target =
      selector === ":focus"
        ? undefined
        : await targetDocument(
            page,
            selector,
            this.#contexts.get(contextId)?.allowedOrigins ?? [],
          ).catch(() => null);
    const sensitive =
      target === null
        ? true
        : target === undefined
          ? await sensitiveTarget(page, selector)
          : await sensitiveTarget(target.document, target.selector);
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
    const owned = this.#contexts.get(contextId);
    return this.#observe(page, owned?.protectCredentials ?? true, owned?.allowedOrigins ?? [], {
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
    const owned = this.#contexts.get(contextId);
    // A download is held only while an agent action that was allowed to
    // download runs; at any other time the context cancels it.
    if (request.downloads === "hold") owned?.downloads.begin();
    let observed: BrowserRuntimeObservation;
    try {
      observed = await this.#act(contextId, request, signal);
    } finally {
      // The reports wait for the next answer if this action failed.
      if (request.downloads === "hold") await owned?.downloads.finish();
    }
    // Every dialog the page raised since the last action is reported once,
    // with how the fixed policy answered it.
    const dialogs = owned?.dialogs.splice(0) ?? [];
    const downloads = owned?.downloads.takeReports() ?? [];
    return {
      ...observed,
      ...(dialogs.length === 0 ? {} : { dialogs }),
      ...(downloads.length === 0 ? {} : { downloads }),
    };
  }

  /** The held file for a download the agent asked to save, if this context still holds it. */
  claimDownload(contextId: BrowserContextId, downloadId: string): Promise<string | undefined> {
    return Promise.resolve(this.#contexts.get(contextId)?.downloads.claim(downloadId));
  }

  async discardDownload(contextId: BrowserContextId, downloadId: string): Promise<void> {
    await this.#contexts.get(contextId)?.downloads.discard(downloadId);
  }

  async #act(
    contextId: BrowserContextId,
    request: BrowserRuntimeAction,
    signal: AbortSignal,
  ): Promise<BrowserRuntimeObservation> {
    const page = await this.#page(contextId, signal);
    const owned = this.#contexts.get(contextId);
    if (owned !== undefined) owned.blockedNavigationUrl = undefined;
    const allowedOrigins = owned?.allowedOrigins ?? [];
    await refuseStaleTarget(page, request.target, request.expected, allowedOrigins);
    await refuseStaleTarget(page, request.destination, request.destinationExpected, allowedOrigins);
    // The document an element target sits in, a frame's when its ref stepped
    // into one, and the selector inside it.
    const at = (target: string | undefined, message: string) =>
      targetDocument(page, required(target, message), allowedOrigins);
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
        if (
          this.#emulation.get(page)?.touch === true &&
          (request.point !== undefined ||
            splitBrowserFrameTarget(request.target ?? "").frames.length === 0)
        ) {
          // A touch device is tapped, not clicked: the page gets touch events
          // and the click a tap ends in, as it would from a finger. An element
          // inside a frame is still clicked: the tap's point is the page's.
          await this.#tap(page, request);
        } else if (request.point === undefined) {
          const target = await at(request.target, "Click actions require a selector or point.");
          await target.document.click(target.selector);
        } else {
          const point = viewportPoint(page, request.point);
          await page.mouse.click(point.x, point.y);
        }
        break;
      case "type": {
        const value = required(request.value, "Type actions require a value.");
        if (request.target === undefined) {
          if (await sensitiveTarget(page, ":focus")) {
            throw new Error("Octant will not type into a sensitive or credential field.");
          }
          await page.keyboard.insertText(value);
          break;
        }
        // The credential check runs in the field's own frame, whichever it is.
        const target = await at(request.target, "Type actions require a selector.");
        if (await sensitiveTarget(target.document, target.selector)) {
          throw new Error("Octant will not type into a sensitive or credential field.");
        }
        await target.document.fill(target.selector, value);
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
      case "observe-diagnostics":
        return readDiagnostics(required(owned, "Browser context is unavailable."), request);
      case "wait":
        if (request.waitFor !== undefined) {
          await waitForConditions(page, request.waitFor, signal, allowedOrigins);
        } else {
          try {
            const target = await at(request.target, "Wait actions require a selector.");
            await target.document
              .locator(target.selector)
              .waitFor({ timeout: DEFAULT_BROWSER_WAIT_MS });
          } catch {
            throw new BrowserWaitTimedOutError(
              `The wait timed out after ${String(DEFAULT_BROWSER_WAIT_MS)} ms: the element never appeared.`,
            );
          }
        }
        break;
      case "resize":
        await this.#emulate(page, request);
        break;
      case "hover": {
        const target = await at(request.target, "Hover actions require an element.");
        await target.document.hover(target.selector);
        break;
      }
      case "select": {
        const { document, selector } = await at(
          request.target,
          "Select actions require an element.",
        );
        const choice = required(request.value, "Select actions require an option.");
        // Playwright waits for a missing option until its timeout; a page with
        // no such option is the agent's mistake to hear about now.
        const exists = await document
          .locator(selector)
          .evaluate((element) =>
            element instanceof HTMLSelectElement
              ? Array.from(element.options).map((option) => [option.value, option.label])
              : [],
          );
        if (!exists.some((pair) => pair.includes(choice))) {
          throw new Error("The list has no option with that value or label.");
        }
        await document.selectOption(selector, choice);
        break;
      }
      case "drag": {
        const from = await at(request.target, "Drag actions require an element.");
        const to = await at(request.destination, "Drag actions require where to drop.");
        if (from.document !== to.document) {
          throw new Error("A drag starts and ends in the same frame.");
        }
        await from.document.dragAndDrop(from.selector, to.selector);
        break;
      }
      case "upload": {
        const target = await at(request.target, "Upload actions require a file field.");
        await target.document.setInputFiles(target.selector, request.files ?? []);
        break;
      }
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
        await leaveUnapprovedLanding(opened, tabs.allowedOrigins);
        return this.#tabsObservation(tabs);
      }
      case "tab-select": {
        const tabs = required(owned, "Browser context is unavailable.");
        const chosen = tabs.tabs.find((tab) => tab.tabId === request.tabId);
        if (chosen === undefined) throw new Error("This browser context has no such tab.");
        tabs.page = chosen.page;
        await leaveUnapprovedLanding(chosen.page, tabs.allowedOrigins);
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
    if (SETTLING_ACTIONS.has(request.kind)) await settle(page);
    if (owned !== undefined) await leaveUnapprovedLanding(page, owned.allowedOrigins);
    throwIfAborted(signal);
    if (request.kind === "snapshot") {
      return this.#snapshot(page, owned?.protectCredentials ?? true, allowedOrigins);
    }
    const include = new Set(request.include ?? []);
    const observed = await this.#observe(
      page,
      owned?.protectCredentials ?? true,
      allowedOrigins,
      {
        text: request.kind === "extract-text" || include.has("text"),
        screenshot: request.kind === "screenshot" || include.has("screenshot"),
        snapshot: include.has("snapshot"),
      },
      request.kind === "extract-text" ? request.target : undefined,
    );
    if (request.kind !== "resize") return observed;
    const emulation = await measureEmulation(page);
    return emulation === undefined ? observed : { ...observed, emulation };
  }

  /**
   * Make the agent's page look like another device, on this page only: the
   * context and the browser stay as they were. Each field changes what it
   * names; a call naming none restores size, touch, and color scheme together.
   */
  async #emulate(page: PlaywrightPagePort, request: BrowserRuntimeAction): Promise<void> {
    const restoring =
      request.viewport === undefined &&
      request.touch === undefined &&
      request.colorScheme === undefined;
    const state = this.#emulation.get(page) ?? {
      deviceOverride: false,
      touch: false,
    };
    this.#emulation.set(page, state);
    const session = async (): Promise<PlaywrightProtocolSessionPort> => {
      if (state.session !== undefined) return state.session;
      const opened = await page.context?.().newCDPSession(page);
      if (opened === undefined) throw new Error("This Browser cannot emulate a device.");
      state.session = opened;
      return opened;
    };
    if (request.viewport !== undefined || restoring) {
      const size = request.viewport ?? DEFAULT_VIEWPORT;
      const scale = request.deviceScaleFactor ?? 1;
      const mobile = request.mobile ?? false;
      // The protocol override replaces the viewport's own, so it is cleared
      // before the viewport is set again and set last when a device needs it.
      if (state.deviceOverride) {
        await (await session()).send("Emulation.clearDeviceMetricsOverride");
        state.deviceOverride = false;
        // Playwright sends nothing for a size it already holds, and the clear
        // just took its own override away, so a different size goes first.
        const held = page.viewportSize();
        if (held?.width === size.width && held.height === size.height) {
          await page.setViewportSize({
            width: size.width,
            height: size.height + 1,
          });
        }
      }
      await page.setViewportSize(size);
      if (scale !== 1 || mobile) {
        await (
          await session()
        ).send("Emulation.setDeviceMetricsOverride", {
          width: size.width,
          height: size.height,
          deviceScaleFactor: scale,
          mobile,
        });
        state.deviceOverride = true;
      }
    }
    const touch = restoring ? false : request.touch;
    if (touch !== undefined && touch !== state.touch) {
      await (
        await session()
      ).send("Emulation.setTouchEmulationEnabled", {
        enabled: touch,
        maxTouchPoints: 1,
      });
      state.touch = touch;
    }
    const colorScheme = restoring ? "default" : request.colorScheme;
    // Nothing was overridden yet, so there is nothing for "default" to undo.
    if (
      colorScheme !== undefined &&
      !(colorScheme === "default" && state.baselineScheme === undefined)
    ) {
      if (page.emulateMedia === undefined) throw new Error("This Browser cannot emulate a device.");
      if (state.baselineScheme === undefined) {
        const before = await measureEmulation(page);
        if (before !== undefined) state.baselineScheme = before.colorScheme;
      }
      await page.emulateMedia({
        colorScheme: colorScheme === "default" ? (state.baselineScheme ?? null) : colorScheme,
      });
    }
  }

  /** A click on a touch-emulated page: one finger down and up on the target. */
  async #tap(page: PlaywrightPagePort, request: BrowserRuntimeAction): Promise<void> {
    let x: number;
    let y: number;
    if (request.point !== undefined) {
      ({ x, y } = viewportPoint(page, request.point));
    } else {
      const selector = required(request.target, "Click actions require a selector or point.");
      const center = await page.locator(playwrightSelector(selector)).evaluate((element) => {
        // Instant, so a page with smooth scrolling is measured where it ends.
        element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        const rect = element.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        // The topmost element at the point, looked for inside open shadow
        // roots too, and whether it sits in the target, across shadow hosts.
        let hit = document.elementFromPoint(cx, cy);
        while (hit?.shadowRoot) {
          const inner = hit.shadowRoot.elementFromPoint(cx, cy);
          if (inner === null || inner === hit) break;
          hit = inner;
        }
        let node: Node | null = hit;
        while (node !== null && node !== element) {
          node = node.parentNode instanceof ShadowRoot ? node.parentNode.host : node.parentNode;
        }
        return {
          x: cx,
          y: cy,
          reachable: rect.width >= 1 && rect.height >= 1 && hit !== null && node === element,
        };
      });
      // Playwright's own click waits for the element to be reachable; a tap
      // sent to a covered point would land on whatever covers it.
      if (!center.reachable) throw new Error("Browser target is not visible or is covered.");
      ({ x, y } = center);
    }
    const session = this.#emulation.get(page)?.session;
    if (session === undefined) throw new Error("Touch emulation is not active on this page.");
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y }],
    });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  }

  async closeContext(contextId: BrowserContextId): Promise<void> {
    const owned = this.#contexts.get(contextId);
    if (owned === undefined) return;
    this.#contexts.delete(contextId);
    await owned.downloads.dispose();
    await owned.context.close();
  }

  async closeAll(): Promise<void> {
    const contexts = [...this.#contexts.values()];
    this.#contexts.clear();
    await Promise.allSettled(
      contexts.map(async (owned) => {
        await owned.downloads.dispose();
        await owned.context.close();
      }),
    );
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
      const type = message.type();
      if (type !== "error" && type !== "warning") return;
      const text = bounded(message.text(), MAX_BROWSER_DIAGNOSTIC_TEXT_CHARACTERS);
      if (text === "") return;
      const url =
        page.url() === "about:blank" ? undefined : bounded(redactedBrowserUrl(page.url()), 4096);
      keepDiagnostic(owned, type === "error" ? owned.consoleErrors : owned.consoleWarnings, {
        text,
        ...(url === undefined ? {} : { url }),
      });
    });
    // A completed request's status, never its headers or body: the response
    // object is read for its status and address and let go.
    page.on?.("response", (response) => {
      const status = response.status();
      if (status < 400 || status > 599) return;
      const url = bounded(redactedBrowserUrl(response.url()), 4096);
      if (url === "") return;
      const method = bounded(response.request().method(), 16);
      keepDiagnostic(owned, owned.httpErrors, {
        url,
        ...(method === "" ? {} : { method }),
        status,
      });
    });
    page.on?.("download", (download) => owned.downloads.onDownload(download));
    page.on?.("dialog", (dialog) => {
      const type = dialogType(dialog.type());
      const answer = BROWSER_DIALOG_POLICY[type];
      if (owned.dialogs.length >= 8) owned.dialogs.shift();
      owned.dialogs.push({ type, message: bounded(dialog.message(), 512), answer });
      void (answer === "accepted" ? dialog.accept() : dialog.dismiss()).catch(() => undefined);
    });
    page.on?.("requestfailed", (request) => {
      const url = bounded(redactedBrowserUrl(request.url()), 4096);
      if (url === "") return;
      const method = bounded(request.method(), 16);
      const failure = bounded(
        request.failure()?.errorText ?? "The request did not complete.",
        MAX_BROWSER_DIAGNOSTIC_TEXT_CHARACTERS,
      );
      keepDiagnostic(owned, owned.failedRequests, {
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
    // The context reports a page before newPage() resolves, so the same page
    // can arrive here twice; it is one tab.
    if (owned.tabs.some((tab) => tab.page === page)) return;
    owned.tabs.push({ tabId: `t${String(owned.nextTabOrdinal)}`, page });
    owned.nextTabOrdinal += 1;
  }

  /** The tabs as they now stand, after a tab action, with the one in front. */
  async #tabsObservation(owned: OwnedRuntimeContext): Promise<BrowserRuntimeObservation> {
    const tabs = await Promise.all(
      owned.tabs.map(async (tab) => {
        // A tab can follow a redirect off the allowed origins after its own
        // action ended; it is sent to a blank page before anything of it is
        // read, as the tab in front is after every action.
        await leaveUnapprovedLanding(tab.page, owned.allowedOrigins).catch(() => undefined);
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
    allowedOrigins: ReadonlyArray<string>,
  ): Promise<BrowserRuntimeObservation> {
    // A credential field in any frame withholds every value in every frame.
    const withholdValues = protectCredentials && (await sensitiveDocument(page));
    const snapshot = await readFramedBrowserSnapshot<PlaywrightDocumentPort>(
      page,
      {
        read: async (document, limits) => {
          const read = await document.evaluate(readBrowserPage, {
            mode: "snapshot",
            ...limits,
            protectCredentials,
            withholdValues,
          });
          if (read.mode !== "snapshot") throw new Error("Browser snapshot is unavailable.");
          return read.snapshot;
        },
        child: async (document, selector) => {
          const owner = await document.$?.(playwrightSelector(selector));
          const frame = await owner?.contentFrame();
          if (frame === null || frame === undefined) return { status: "excluded" };
          if (!browserFrameAdmitted(frame.url(), { allowedOrigins, signedIn: false })) {
            return { status: "excluded", ...frameOrigin(frame.url()) };
          }
          return { status: "included", frame };
        },
      },
      { maxRefs: MAX_BROWSER_SNAPSHOT_REFS, maxNodes: MAX_BROWSER_SNAPSHOT_NODES },
    );
    const title = await page.title();
    const viewport = page.viewportSize();
    return {
      ...(page.url() === "about:blank" ? {} : { url: bounded(page.url(), 4096) }),
      ...(title.trim() === "" ? {} : { title: bounded(title, 1024) }),
      snapshot: formatBrowserPageSnapshot(snapshot),
      snapshotRefs: snapshot.refs,
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
    allowedOrigins: ReadonlyArray<string>,
    parts: { readonly text: boolean; readonly screenshot: boolean; readonly snapshot: boolean },
    selector?: string,
  ): Promise<BrowserRuntimeObservation> {
    const outline = parts.snapshot
      ? await this.#snapshot(page, protectCredentials, allowedOrigins)
      : {};
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
      parts.text && selector !== undefined
        ? targetDocument(page, selector, allowedOrigins).then((target) =>
            target.document.textContent(target.selector),
          )
        : Promise.resolve(null),
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

/**
 * What the page itself reports about its device, read by a fixed script, so
 * the answer states what the page sees rather than what was asked for.
 */
async function measureEmulation(
  page: PlaywrightPagePort,
): Promise<BrowserEmulationReport | undefined> {
  try {
    const seen = await page.evaluate(() => ({
      width: Math.round(window.innerWidth),
      height: Math.round(window.innerHeight),
      deviceScaleFactor: window.devicePixelRatio,
      touch: navigator.maxTouchPoints > 0 && window.matchMedia("(pointer: coarse)").matches,
      dark: window.matchMedia("(prefers-color-scheme: dark)").matches,
    }));
    return {
      width: seen.width,
      height: seen.height,
      deviceScaleFactor: seen.deviceScaleFactor,
      touch: seen.touch,
      colorScheme: seen.dark ? "dark" : "light",
    };
  } catch {
    return undefined;
  }
}

async function sensitiveTarget(
  page: PlaywrightDocumentPort & Partial<Pick<PlaywrightPagePort, "frames">>,
  selector: string,
): Promise<boolean> {
  const frames = selector === ":focus" && page.frames !== undefined ? page.frames() : [page];
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

const DEFAULT_VIEWPORT = { width: 1280, height: 720 } as const;

/**
 * What a page's device emulation needs to remember between calls: the protocol
 * session that holds it (a session's overrides end with the session, so it is
 * kept for the page's life), whether a device override is set and so must be
 * cleared before the next size, and whether touch is on, which decides how a
 * click reaches the page.
 */
interface PageEmulation {
  session?: PlaywrightProtocolSessionPort;
  deviceOverride: boolean;
  touch: boolean;
  /**
   * The color scheme the page had before the first override, read from the
   * page. Playwright's own reset goes to the machine's scheme, not to the one
   * this Browser's pages started with, so a restore returns to this instead.
   */
  baselineScheme?: "light" | "dark";
}

/** Number one diagnostic entry and keep it, dropping the oldest of its kind past the bound. */
function keepDiagnostic<T extends { seq: number }>(
  owned: { diagnosticSeq: number },
  list: T[],
  entry: Omit<T, "seq">,
): void {
  owned.diagnosticSeq += 1;
  if (list.length >= MAX_BROWSER_DIAGNOSTIC_ENTRIES) list.shift();
  list.push({ ...entry, seq: owned.diagnosticSeq } as T);
}

/**
 * What the page reported after the reader's cursor. Nothing is cleared: two
 * readers (the agent, a person's pane) each keep their own place, and the
 * answer's cursor is where the next read starts.
 */
function readDiagnostics(
  owned: Pick<
    OwnedRuntimeContext,
    "consoleErrors" | "consoleWarnings" | "failedRequests" | "httpErrors" | "diagnosticSeq"
  >,
  request: BrowserRuntimeAction,
): BrowserRuntimeObservation {
  const since = request.diagnosticsSince ?? 0;
  const after = <T extends { readonly seq: number }>(list: ReadonlyArray<T>) =>
    list.filter((entry) => entry.seq > since);
  return {
    consoleErrors: after(owned.consoleErrors),
    failedRequests: after(owned.failedRequests),
    httpErrors: after(owned.httpErrors),
    ...(request.diagnosticsWarnings === true
      ? { consoleWarnings: after(owned.consoleWarnings) }
      : {}),
    diagnosticsCursor: owned.diagnosticSeq,
  };
}

/** The actions after which the page is given a moment to settle before it is read. */
const SETTLING_ACTIONS: ReadonlySet<BrowserRuntimeAction["kind"]> = new Set([
  "navigate",
  "click",
  "type",
  "press",
  "scroll",
  "hover",
  "select",
  "drag",
  "upload",
  "resize",
]);

/**
 * The document a target sits in and the selector Playwright resolves inside
 * it. A ref that stepped into frames is followed hop by hop, and a frame is
 * entered only when its origin is one the context's allowlist admits, so a
 * frame outside the approval stays as unreadable as a page outside it.
 */
async function targetDocument(
  page: PlaywrightPagePort,
  target: string,
  allowedOrigins: ReadonlyArray<string>,
): Promise<{
  readonly document: PlaywrightDocumentPort;
  /** For Playwright: shadow hops become its own chained selectors, which pierce shadow roots. */
  readonly selector: string;
  /** For the page reader, which takes shadow hops itself. */
  readonly element: string;
}> {
  const { frames, element } = splitBrowserFrameTarget(target);
  let document: PlaywrightDocumentPort = page;
  for (const frameSelector of frames) {
    const owner = await document.$?.(playwrightSelector(frameSelector));
    const frame = await owner?.contentFrame();
    if (frame === null || frame === undefined) throw new Error("Browser target was not found.");
    if (!browserFrameAdmitted(frame.url(), { allowedOrigins, signedIn: false })) {
      throw new Error("That frame's site is outside the sites approved for this page.");
    }
    document = frame;
  }
  return { document, selector: playwrightSelector(element), element };
}

/**
 * A shadow hop becomes Playwright's own chain, whose CSS reaches into the
 * host's shadow root. `:scope >` keeps each part to the root's own children
 * first, as the page reader resolves it, rather than any descendant; a part
 * that starts at an id, unique in its root, needs no anchor.
 */
function playwrightSelector(selector: string): string {
  const [first = "", ...inside] = selector.split(BROWSER_SHADOW_HOP);
  return [first, ...inside.map((part) => (part.startsWith("#") ? part : `:scope > ${part}`))].join(
    " >> ",
  );
}

function frameOrigin(url: string): { readonly origin?: string } {
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? {} : { origin };
  } catch {
    return {};
  }
}

/**
 * Let the page finish what the action started: its load, then a short window in
 * which the document stops changing. Bounded either way, so a page that never
 * settles costs the cap and the action still answers.
 */
async function settle(page: PlaywrightPagePort): Promise<void> {
  await page.waitForLoadState?.("load", { timeout: BROWSER_SETTLE_CAP_MS }).catch(() => undefined);
  await page
    .evaluate(awaitQuietPage, { quietMs: BROWSER_SETTLE_QUIET_MS, capMs: BROWSER_SETTLE_CAP_MS })
    .catch(() => undefined);
}

/**
 * Check a wait's conditions until they hold or its time runs out. The time is
 * the wait's own, never more than the hard limit the contract sets.
 */
async function waitForConditions(
  page: PlaywrightPagePort,
  waitFor: NonNullable<BrowserRuntimeAction["waitFor"]>,
  signal: AbortSignal,
  allowedOrigins: ReadonlyArray<string>,
): Promise<void> {
  const conditions = browserPageConditions(waitFor);
  const timeoutMs = Math.min(waitFor.timeoutMs ?? DEFAULT_BROWSER_WAIT_MS, MAX_BROWSER_WAIT_MS);
  const deadline = Date.now() + timeoutMs;
  let met: ReadonlyArray<boolean> = conditions.map(() => false);
  while (true) {
    throwIfAborted(signal);
    try {
      // One check never outlives the wait: a page stuck in its own script
      // would otherwise hold the loop past its deadline.
      const checked = await Promise.race([
        checkConditions(page, conditions, allowedOrigins),
        new Promise<undefined>((resolve) =>
          setTimeout(() => resolve(undefined), Math.max(0, deadline - Date.now())),
        ),
      ]);
      if (checked?.mode === "check") met = checked.met;
    } catch {
      // A page between documents cannot be read; the next check will be.
    }
    if (waitSatisfied(waitFor.match, met)) return;
    if (Date.now() >= deadline) {
      throw new BrowserWaitTimedOutError(describeUnmetWait(timeoutMs, conditions, met));
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}

/**
 * Check wait conditions where each one lives: the page's in one read, and an
 * element a ref found inside a frame in that frame. A frame that is gone holds
 * no element, so its condition reads as an element that is not there.
 */
async function checkConditions(
  page: PlaywrightPagePort,
  conditions: ReturnType<typeof browserPageConditions>,
  allowedOrigins: ReadonlyArray<string>,
): Promise<{ readonly mode: "check"; readonly met: ReadonlyArray<boolean> }> {
  const inFrame = (condition: (typeof conditions)[number]) =>
    condition.kind === "element" && splitBrowserFrameTarget(condition.target).frames.length > 0;
  const pageRead = await page.evaluate(readBrowserPage, {
    mode: "check",
    conditions: conditions.map((condition) =>
      inFrame(condition) ? { ...condition, target: ":not(*)" } : condition,
    ),
  });
  const met = pageRead.mode === "check" ? [...pageRead.met] : conditions.map(() => false);
  for (const [index, condition] of conditions.entries()) {
    if (condition.kind !== "element" || !inFrame(condition)) continue;
    const target = await targetDocument(page, condition.target, allowedOrigins).catch(
      () => undefined,
    );
    if (target === undefined) continue;
    const read = await target.document.evaluate(readBrowserPage, {
      mode: "check",
      conditions: [{ ...condition, target: target.element }],
    });
    if (read.mode === "check") met[index] = read.met[0] === true;
  }
  return { mode: "check", met };
}

/**
 * Chromium follows a redirect inside the routed request, so a top-level
 * document can land on an origin the request guard never saw. The allowlist is
 * the context's whole authority: leave the page rather than observe, script,
 * or screenshot an origin outside it. Every tab is held to it, a new one too.
 */
async function leaveUnapprovedLanding(
  page: PlaywrightPagePort,
  allowedOrigins: ReadonlyArray<string>,
): Promise<void> {
  const landed = page.url();
  if (/^https?:/i.test(landed) && !originAllowed(landed, allowedOrigins)) {
    await page.goto("about:blank").catch(() => undefined);
    throw new BrowserNavigationBlockedError(landed);
  }
}

/** Refuse a ref whose page moved on or whose element is no longer the one named. */
async function refuseStaleTarget(
  page: PlaywrightPagePort,
  selector: string | undefined,
  expected: BrowserRuntimeAction["expected"],
  allowedOrigins: ReadonlyArray<string>,
): Promise<void> {
  if (expected === undefined || selector === undefined) return;
  const target = await targetDocument(page, selector, allowedOrigins).catch(() => undefined);
  if (target === undefined) throw new BrowserTargetStaleError();
  const found = await target.document.evaluate(readBrowserPage, {
    mode: "verify",
    selector: target.element,
  });
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
    // Downloads arrive here, in a private folder that is emptied when the
    // browser starts, and the runtime watches it to stop a file at the cap.
    downloadFolder: browserDownloadHoldRoot("headless"),
    launch: async (executablePath, onProcessStarted) => {
      const downloadsPath = await prepareBrowserDownloadHoldRoot("headless");
      const browser = await chromium.launch({
        executablePath,
        headless: true,
        downloadsPath,
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
