import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type {
  BrowserActionRequest,
  BrowserContextId,
  BrowserContextPolicy,
} from "@octant/contracts/browser-automation";
import { MAX_BROWSER_SCREENSHOT_DATA_URL_CHARACTERS } from "@octant/contracts/browser-automation";
import { chromium } from "playwright-core";
import type {
  BrowserRuntimeObservation,
  BrowserRuntimePort,
  BrowserTargetInspection,
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
  locator(selector: string): {
    evaluate<T>(expression: (element: Element) => T): Promise<T>;
    waitFor(): Promise<void>;
  };
  screenshot(options: {
    readonly type: "jpeg";
    readonly quality: number;
    readonly scale: "css";
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
      request(): { url(): string };
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
  readonly protectCredentials: boolean;
  page: PlaywrightPagePort | undefined;
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
    try {
      // Every request, not only navigations: a subresource reaches the network
      // exactly as a navigation does, and the allowlist is this context's whole
      // authority.
      await context.route("**/*", async (route) => {
        if (!originAllowed(route.request().url(), policy.allowedOrigins)) {
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
      const page = await context.newPage();
      const owned: OwnedRuntimeContext = {
        context,
        protectCredentials: policy.credentialFieldProtection,
        page,
      };
      context.on("page", (candidate) => {
        if (owned.page === undefined) {
          owned.page = candidate;
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

  async act(
    contextId: BrowserContextId,
    request: BrowserActionRequest,
    signal: AbortSignal,
  ): Promise<BrowserRuntimeObservation> {
    const page = await this.#page(contextId, signal);
    switch (request.kind) {
      case "navigate":
        await page.goto(required(request.target, "Navigate actions require a URL."));
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
        await page.keyboard.press(required(request.value, "Press actions require a key."));
        break;
      case "scroll":
        await page.mouse.wheel(request.deltaX ?? 0, request.deltaY ?? 500);
        break;
      case "screenshot":
        break;
      case "extract-text":
        break;
      case "wait":
        await page.locator(required(request.target, "Wait actions require a selector.")).waitFor();
        break;
      case "close-tab":
        await page.close();
        this.#contexts.get(contextId)!.page = undefined;
        return {};
    }
    throwIfAborted(signal);
    return this.#observe(
      page,
      request.kind === "extract-text",
      this.#contexts.get(contextId)?.protectCredentials ?? true,
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
    if (owned.page === undefined) owned.page = await owned.context.newPage();
    throwIfAborted(signal);
    return owned.page;
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

  async #observe(
    page: PlaywrightPagePort,
    includeExtractedText: boolean,
    protectCredentials: boolean,
  ): Promise<BrowserRuntimeObservation> {
    if (protectCredentials && (await sensitiveDocument(page))) {
      const title = await page.title();
      const viewport = page.viewportSize();
      return {
        ...(page.url() === "about:blank" ? {} : { url: bounded(page.url(), 4096) }),
        ...(title.trim() === "" ? {} : { title: bounded(title, 1024) }),
        ...(viewport === null ? {} : { viewport }),
      };
    }
    const [title, text, screenshotDataUrl] = await Promise.all([
      page.title(),
      page.textContent("body"),
      boundedScreenshotDataUrl(page),
    ]);
    const boundedText = bounded(text ?? "", 65_536);
    const viewport = page.viewportSize();
    return {
      ...(page.url() === "about:blank" ? {} : { url: bounded(page.url(), 4096) }),
      ...(title.trim() === "" ? {} : { title: bounded(title, 1024) }),
      contentHash: createHash("sha256").update(boundedText).digest("hex"),
      ...(includeExtractedText ? { extractedText: boundedText } : {}),
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
          for (const element of roots[index]!.querySelectorAll("*")) {
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

function required(value: string | undefined, message: string): string {
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

function originAllowed(target: string, allowedOrigins: ReadonlyArray<string>): boolean {
  let targetOrigin: string;
  try {
    targetOrigin = new URL(target).origin;
  } catch {
    return false;
  }
  return allowedOrigins.some((allowed) => {
    try {
      return new URL(allowed).origin === targetOrigin;
    } catch {
      return false;
    }
  });
}
