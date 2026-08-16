import { createHash } from "node:crypto";
import type {
  BrowserActionRequest,
  BrowserContextId,
  BrowserContextPolicy,
  BrowserThreadId,
} from "@octant/contracts";

export interface BrowserSurfaceBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface BrowserSurfaceOwner {
  readonly windowId: string;
  readonly threadId: BrowserThreadId | string;
}

export interface BrowserSurfaceState {
  readonly contextId: string;
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly control: "idle" | "user" | "agent";
}

export interface BrowserSurfaceShellWindowPort {
  readonly contentView: {
    addChildView(view: BrowserSurfaceViewPort): void;
    removeChildView(view: BrowserSurfaceViewPort): void;
  };
  readonly isDestroyed: () => boolean;
  readonly webContents: { readonly send: (channel: string, payload: unknown) => void };
}

interface BrowserSurfaceSessionPort {
  on(event: "will-download", listener: (event: { preventDefault?: () => void }) => void): void;
  /**
   * Electron's per-session certificate override. Octant declines it: the
   * request it reports carries only `hostname`, which cannot be bounded to the
   * one origin a surface opened (see `createContext`). It stays on this port so
   * that guarantee remains observable.
   */
  setCertificateVerifyProc?(
    handler: (
      request: { readonly hostname: string },
      callback: (verificationResult: number) => void,
    ) => void,
  ): void;
  setDevicePermissionHandler(handler: () => boolean): void;
  setDisplayMediaRequestHandler(
    handler: (request: unknown, callback: (streams: Record<string, never>) => void) => void,
  ): void;
  setPermissionCheckHandler(handler: () => boolean): void;
  setPermissionRequestHandler(
    handler: (
      webContents: unknown,
      permission: string,
      callback: (allowed: boolean) => void,
    ) => void,
  ): void;
}

export interface BrowserSurfaceViewPort {
  setBounds(bounds: BrowserSurfaceBounds): void;
  setVisible(visible: boolean): void;
  readonly webContents: {
    capturePage(): Promise<{ toJPEG(quality: number): Uint8Array }>;
    close(): void;
    readonly debugger: {
      attach(protocolVersion?: string): void;
      detach(): void;
      isAttached(): boolean;
      sendCommand(method: string, commandParams?: Record<string, unknown>): Promise<unknown>;
    };
    executeJavaScriptInIsolatedWorld(
      worldId: number,
      scripts: ReadonlyArray<{ readonly code: string }>,
      userGesture?: boolean,
    ): Promise<unknown>;
    getTitle(): string;
    getURL(): string;
    isDestroyed(): boolean;
    isLoading(): boolean;
    loadURL(url: string): Promise<unknown>;
    readonly mainFrame: {
      readonly framesInSubtree: ReadonlyArray<{
        executeJavaScript(code: string): Promise<unknown>;
      }>;
    };
    readonly navigationHistory: {
      canGoBack(): boolean;
      canGoForward(): boolean;
      goBack(): void;
      goForward(): void;
    };
    on(event: string, listener: (...args: readonly unknown[]) => void): void;
    reload(): void;
    readonly session: BrowserSurfaceSessionPort;
    setWindowOpenHandler(handler: (details: { readonly url: string }) => { action: "deny" }): void;
    stop(): void;
  };
}

export interface BrowserSurfaceHostOptions {
  readonly createView: (options: {
    readonly partition: string;
    readonly webPreferences: {
      readonly allowRunningInsecureContent: false;
      readonly contextIsolation: true;
      readonly nodeIntegration: false;
      readonly sandbox: true;
      readonly webSecurity: true;
    };
  }) => BrowserSurfaceViewPort;
  readonly stateChannel?: string;
  readonly isOwnerWindowAvailable?: (windowId: string) => boolean;
}

interface OwnedSurface {
  readonly owner: BrowserSurfaceOwner;
  readonly policy: BrowserContextPolicy;
  readonly view: BrowserSurfaceViewPort;
  actionTail: Promise<void>;
  control: BrowserSurfaceState["control"];
  shellWindow: BrowserSurfaceShellWindowPort | undefined;
  /** Last top-level navigation the allowlist guard cancelled during the current action. */
  blockedNavigationUrl: string | undefined;
}

/**
 * The page tried to move to an origin outside the context allowlist, typically
 * a redirect such as example.com → www.example.com. Carries the refused URL so
 * the broker can report it instead of a generic operation failure.
 */
export class BrowserNavigationBlockedError extends Error {
  readonly url: string;
  constructor(url: string) {
    super(`Navigation to ${url} is outside the browser context allowlist.`);
    this.name = "BrowserNavigationBlockedError";
    this.url = url;
  }
}

export interface BrowserSurfaceRuntimeObservation {
  readonly url?: string;
  readonly title?: string;
  readonly contentHash?: string;
  readonly extractedText?: string;
  readonly screenshotDataUrl?: string;
  readonly viewport?: { readonly width: number; readonly height: number };
}

const ISOLATED_WORLD_ID = 1_001;

export function createBrowserSurfaceHost(options: BrowserSurfaceHostOptions) {
  const surfaces = new Map<string, OwnedSurface>();
  const goneListeners = new Set<(contextId: string) => void>();
  const stateChannel = options.stateChannel ?? "octant:browser-surface:state";

  const surface = (contextId: string): OwnedSurface => {
    const owned = surfaces.get(contextId);
    if (owned === undefined) throw new Error("Octant Browser context is unknown.");
    return owned;
  };

  const publish = (contextId: string, owned: OwnedSurface): void => {
    if (owned.shellWindow === undefined || owned.shellWindow.isDestroyed()) return;
    owned.shellWindow.webContents.send(stateChannel, readState(contextId, owned));
  };

  const markGone = (contextId: string, owned: OwnedSurface): void => {
    if (surfaces.get(contextId) !== owned) return;
    surfaces.delete(contextId);
    owned.view.setVisible(false);
    owned.shellWindow?.contentView.removeChildView(owned.view);
    owned.shellWindow = undefined;
    if (!owned.view.webContents.isDestroyed()) owned.view.webContents.close();
    for (const listener of goneListeners) listener(contextId);
  };

  return Object.freeze({
    available: (): boolean => true,
    onContextGone: (listener: (contextId: string) => void): (() => void) => {
      goneListeners.add(listener);
      return () => goneListeners.delete(listener);
    },
    createContext: async (input: {
      readonly contextId: BrowserContextId | string;
      readonly owner: BrowserSurfaceOwner;
      readonly policy: BrowserContextPolicy;
    }): Promise<void> => {
      if (input.policy.profileMode !== "isolated") {
        throw new Error("Octant Browser supports isolated profiles only.");
      }
      if (surfaces.has(input.contextId)) throw new Error("Browser context already exists.");
      if (options.isOwnerWindowAvailable?.(input.owner.windowId) === false) {
        throw new Error("Octant Browser owner is not a native Project window.");
      }
      const view = options.createView({
        partition: `octant-browser-${input.contextId}`,
        webPreferences: {
          allowRunningInsecureContent: false,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
        },
      });
      view.setVisible(false);
      view.webContents.session.setPermissionCheckHandler(() => false);
      view.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      view.webContents.session.setDevicePermissionHandler(() => false);
      view.webContents.session.setDisplayMediaRequestHandler((_request, callback) => callback({}));
      view.webContents.session.on("will-download", (event) => event.preventDefault?.());
      // `policy.acceptsLocalCertificate` relaxes nothing here. That acceptance
      // is bounded to the one origin this surface opened, and Electron's
      // certificate verify proc reports only `request.hostname` — no scheme, no
      // port, no URL — because Chromium verifies a certificate against a host
      // and caches the verdict in the network service. Accepting by hostname
      // would also trust a different self-signed service on another port of the
      // same loopback host, including for subresource requests that never reach
      // the navigation guard below, so this surface leaves Chromium's own
      // verification in force and installs no trust root.
      view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      const owned: OwnedSurface = {
        owner: input.owner,
        policy: input.policy,
        view,
        actionTail: Promise.resolve(),
        control: "idle",
        shellWindow: undefined,
        blockedNavigationUrl: undefined,
      };
      for (const event of [
        "did-start-loading",
        "did-stop-loading",
        "did-navigate",
        "did-navigate-in-page",
        "page-title-updated",
      ]) {
        view.webContents.on(event, () => publish(input.contextId, owned));
      }
      const guardNavigation = (event: unknown, ...details: readonly unknown[]) => {
        const target = navigationUrl(event, details);
        if (typeof target === "string" && originAllowed(target, owned.policy.allowedOrigins))
          return;
        (event as { preventDefault?: () => void }).preventDefault?.();
        return target;
      };
      // Only a refused top-level move explains a failed navigate action to the
      // user; a cancelled frame navigation is the allowlist working as intended.
      const guardTopLevelNavigation = (event: unknown, ...details: readonly unknown[]) => {
        const refused = guardNavigation(event, ...details);
        if (typeof refused === "string") owned.blockedNavigationUrl = refused;
      };
      view.webContents.on("will-navigate", guardTopLevelNavigation);
      view.webContents.on("will-redirect", guardTopLevelNavigation);
      view.webContents.on("will-frame-navigate", guardNavigation);
      view.webContents.on("login", (event: unknown, ...details: readonly unknown[]) => {
        (event as { preventDefault?: () => void }).preventDefault?.();
        const callback = details.find(
          (detail): detail is () => void => typeof detail === "function",
        );
        callback?.();
      });
      view.webContents.on(
        "select-client-certificate",
        (event: unknown, ...details: readonly unknown[]) => {
          (event as { preventDefault?: () => void }).preventDefault?.();
          const callback = details.find(
            (detail): detail is () => void => typeof detail === "function",
          );
          callback?.();
        },
      );
      view.webContents.on("focus", () => {
        owned.control = "user";
        publish(input.contextId, owned);
      });
      const gateUserInput = (event: unknown) => {
        if (owned.control === "agent") {
          (event as { preventDefault?: () => void }).preventDefault?.();
          return;
        }
        owned.control = "user";
        publish(input.contextId, owned);
      };
      view.webContents.on("before-input-event", gateUserInput);
      view.webContents.on("before-mouse-event", gateUserInput);
      view.webContents.on("render-process-gone", () => markGone(input.contextId, owned));
      view.webContents.on("destroyed", () => markGone(input.contextId, owned));
      surfaces.set(input.contextId, owned);
    },
    attach: (
      contextId: BrowserContextId | string,
      owner: BrowserSurfaceOwner,
      shellWindow: BrowserSurfaceShellWindowPort,
      bounds: BrowserSurfaceBounds,
    ): BrowserSurfaceState => {
      const owned = surface(contextId);
      if (owned.owner.windowId !== owner.windowId || owned.owner.threadId !== owner.threadId) {
        throw new Error("Octant Browser can attach only to its owning Project window.");
      }
      if (owned.shellWindow !== undefined && owned.shellWindow !== shellWindow) {
        owned.shellWindow.contentView.removeChildView(owned.view);
      }
      owned.shellWindow = shellWindow;
      shellWindow.contentView.addChildView(owned.view);
      owned.view.setBounds(normalizeBounds(bounds));
      owned.view.setVisible(true);
      const state = readState(contextId, owned);
      publish(contextId, owned);
      return state;
    },
    updateBounds: (
      contextId: BrowserContextId | string,
      owner: BrowserSurfaceOwner,
      bounds: BrowserSurfaceBounds,
    ): void => {
      const owned = surface(contextId);
      if (owned.owner.windowId !== owner.windowId || owned.owner.threadId !== owner.threadId) {
        throw new Error("Octant Browser can resize only inside its owning Project window.");
      }
      owned.view.setBounds(normalizeBounds(bounds));
    },
    detach: (contextId: BrowserContextId | string, owner: BrowserSurfaceOwner): void => {
      const owned = surface(contextId);
      if (owned.owner.windowId !== owner.windowId || owned.owner.threadId !== owner.threadId) {
        throw new Error("Octant Browser can detach only from its owning Project window.");
      }
      owned.view.setVisible(false);
      owned.shellWindow?.contentView.removeChildView(owned.view);
      owned.shellWindow = undefined;
    },
    inspectTarget: async (contextId: BrowserContextId | string, selector: string) => {
      const owned = surface(contextId);
      const result = await execute(
        owned.view,
        `(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!(element instanceof HTMLInputElement)) return false;
        const hint = [element.type, element.autocomplete, element.name, element.id].join(" ").toLowerCase();
        return element.type === "password" || /(?:password|passcode|one-time-code|otp|webauthn|cc-|credit|card|ssn|secret|token)/.test(hint);
      })()`,
      );
      return { sensitive: result === true };
    },
    act: async (
      contextId: BrowserContextId | string,
      request: Pick<BrowserActionRequest, "kind"> &
        Partial<Pick<BrowserActionRequest, "target" | "value" | "point" | "deltaX" | "deltaY">>,
      signal?: AbortSignal,
    ): Promise<BrowserSurfaceRuntimeObservation> => {
      const owned = surface(contextId);
      return queueSurfaceAction(owned, async () => {
        throwIfAborted(signal);
        owned.control = "agent";
        owned.blockedNavigationUrl = undefined;
        publish(contextId, owned);
        try {
          const contents = owned.view.webContents;
          switch (request.kind) {
            case "navigate": {
              if (
                request.target === undefined ||
                !originAllowed(request.target, owned.policy.allowedOrigins)
              ) {
                throw new Error("Navigation target origin is not in the allowlist.");
              }
              try {
                await contents.loadURL(normalizeUrl(request.target));
              } catch (error) {
                if (owned.blockedNavigationUrl === undefined) throw error;
                throw new BrowserNavigationBlockedError(owned.blockedNavigationUrl);
              }
              break;
            }
            case "click":
              await clickTarget(contentsView(owned), request.target, request.point);
              break;
            case "type":
              await typeIntoTarget(
                contentsView(owned),
                request.target,
                request.value,
                owned.policy.credentialFieldProtection,
              );
              break;
            case "press":
              await pressFocusedTarget(
                contentsView(owned),
                request.value,
                owned.policy.credentialFieldProtection,
              );
              break;
            case "scroll":
              await execute(
                contentsView(owned),
                `window.scrollBy({ left: ${request.deltaX ?? 0}, top: ${request.deltaY ?? 500}, behavior: 'smooth' });`,
                true,
              );
              break;
            case "extract-text":
              break;
            case "wait":
              await waitForSelector(contentsView(owned), request.target);
              break;
            case "screenshot":
              break;
            case "close-tab":
              await contents.loadURL("about:blank");
              break;
          }
          const extractedText = await execute(
            contentsView(owned),
            "document.body?.innerText?.slice(0, 65536) ?? ''",
          );
          const text = typeof extractedText === "string" ? extractedText : "";
          const measuredViewport = await execute(
            contentsView(owned),
            "({ width: Math.round(window.innerWidth), height: Math.round(window.innerHeight) })",
          );
          const viewport = viewportSize(measuredViewport);
          const sensitiveDocument = await hasSensitiveDocument(
            contentsView(owned),
            owned.policy.credentialFieldProtection,
          );
          const screenshotDataUrl =
            request.kind === "screenshot" && !sensitiveDocument
              ? await captureScreenshot(contentsView(owned))
              : undefined;
          return {
            ...(contents.getURL() === ""
              ? {}
              : { url: redactedObservationUrl(contents.getURL()).slice(0, 4_096) }),
            ...(contents.getTitle() === "" ? {} : { title: contents.getTitle().slice(0, 1_024) }),
            ...(sensitiveDocument
              ? {}
              : { contentHash: createHash("sha256").update(text, "utf8").digest("hex") }),
            ...(!sensitiveDocument &&
            (request.kind === "extract-text" || request.kind === "screenshot")
              ? { extractedText: text }
              : {}),
            ...(screenshotDataUrl === undefined ? {} : { screenshotDataUrl }),
            ...(viewport === undefined ? {} : { viewport }),
          };
        } finally {
          owned.control = "idle";
          publish(contextId, owned);
        }
      });
    },
    command: async (
      contextId: BrowserContextId | string,
      owner: BrowserSurfaceOwner,
      command: "back" | "forward" | "reload" | "stop",
    ): Promise<void> => {
      const owned = surface(contextId);
      if (owned.owner.windowId !== owner.windowId || owned.owner.threadId !== owner.threadId) {
        throw new Error("Octant Browser command does not own this context.");
      }
      await queueSurfaceAction(owned, async () => {
        owned.control = "user";
        const contents = owned.view.webContents;
        if (command === "back" && contents.navigationHistory.canGoBack()) {
          contents.navigationHistory.goBack();
        } else if (command === "forward" && contents.navigationHistory.canGoForward()) {
          contents.navigationHistory.goForward();
        } else if (command === "reload") {
          contents.reload();
        } else if (command === "stop") {
          contents.stop();
        }
        publish(contextId, owned);
      });
    },
    state: (contextId: BrowserContextId | string): BrowserSurfaceState =>
      readState(contextId, surface(contextId)),
    closeContext,
    closeOwnerContexts: async (windowId: string): Promise<void> => {
      const ownedIds = [...surfaces.entries()]
        .filter(([, owned]) => owned.owner.windowId === windowId)
        .map(([contextId]) => contextId);
      await Promise.all(
        ownedIds.map(async (contextId) => {
          await closeContext(contextId);
          for (const listener of goneListeners) listener(contextId);
        }),
      );
    },
    closeAll: async (): Promise<void> => {
      await Promise.all([...surfaces.keys()].map(closeContext));
    },
  });

  async function closeContext(contextId: BrowserContextId | string): Promise<void> {
    const owned = surfaces.get(contextId);
    if (owned === undefined) return;
    surfaces.delete(contextId);
    owned.view.setVisible(false);
    owned.shellWindow?.contentView.removeChildView(owned.view);
    if (!owned.view.webContents.isDestroyed()) owned.view.webContents.close();
  }
}

export type ReturnTypeOfBrowserSurfaceHost = ReturnType<typeof createBrowserSurfaceHost>;

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Browser action was interrupted.");
}

async function queueSurfaceAction<T>(owned: OwnedSurface, action: () => Promise<T>): Promise<T> {
  const previous = owned.actionTail;
  let release!: () => void;
  const completed = new Promise<void>((resolve) => {
    release = resolve;
  });
  owned.actionTail = previous.catch(() => undefined).then(() => completed);
  await previous.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
  }
}

function contentsView(owned: OwnedSurface): BrowserSurfaceViewPort {
  return owned.view;
}

function readState(contextId: string, owned: OwnedSurface): BrowserSurfaceState {
  const contents = owned.view.webContents;
  return {
    contextId,
    url: contents.getURL().slice(0, 4_096),
    title: contents.getTitle().slice(0, 1_024),
    loading: contents.isLoading(),
    canGoBack: contents.navigationHistory.canGoBack(),
    canGoForward: contents.navigationHistory.canGoForward(),
    control: owned.control,
  };
}

function normalizeBounds(bounds: BrowserSurfaceBounds): BrowserSurfaceBounds {
  if (
    ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ||
    bounds.x < 0 ||
    bounds.y < 0 ||
    bounds.width < 1 ||
    bounds.height < 1
  ) {
    throw new Error("Octant rejected invalid Browser surface bounds.");
  }
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  };
}

function normalizeUrl(value: string): string {
  const url = new URL(value.includes("://") ? value : `https://${value}`);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Unsupported URL.");
  return url.toString();
}

function originAllowed(target: string, allowedOrigins: ReadonlyArray<string>): boolean {
  if (target === "about:blank") return true;
  try {
    const origin = new URL(normalizeUrl(target)).origin;
    return allowedOrigins.some((allowed) => new URL(normalizeUrl(allowed)).origin === origin);
  } catch {
    return false;
  }
}

function navigationUrl(event: unknown, details: readonly unknown[]): unknown {
  const eventUrl =
    typeof event === "object" && event !== null && "url" in event
      ? (event as { readonly url?: unknown }).url
      : undefined;
  if (typeof eventUrl === "string") return eventUrl;
  for (const detail of details) {
    if (typeof detail === "string") return detail;
    if (typeof detail === "object" && detail !== null && "url" in detail) {
      const candidate = (detail as { readonly url?: unknown }).url;
      if (typeof candidate === "string") return candidate;
    }
  }
  return undefined;
}

function execute(
  view: BrowserSurfaceViewPort,
  code: string,
  userGesture = false,
): Promise<unknown> {
  return view.webContents.executeJavaScriptInIsolatedWorld(
    ISOLATED_WORLD_ID,
    [{ code }],
    userGesture,
  );
}

async function targetGeometry(
  view: BrowserSurfaceViewPort,
  selector: string | undefined,
  point: { readonly x: number; readonly y: number } | undefined,
  editable: boolean,
  protectCredentials: boolean,
): Promise<{ readonly x: number; readonly y: number }> {
  if (point !== undefined) {
    const result = await execute(
      view,
      `(() => {
      const x = ${point.x} * window.innerWidth;
      const y = ${point.y} * window.innerHeight;
      const element = document.elementFromPoint(x, y);
      if (!(element instanceof HTMLElement)) throw new Error("Browser target was not found.");
      if (${editable ? "true" : "false"} && !(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable)) throw new Error("Browser target is not editable.");
      const hint = [element.getAttribute("type"), element.getAttribute("autocomplete"), element.getAttribute("name"), element.id, element.getAttribute("aria-label")].join(" ").toLowerCase();
      if (${protectCredentials ? "true" : "false"} && /(?:password|passcode|one-time-code|otp|webauthn|cc-|credit|card|ssn|secret|token|api.?key)/.test(hint)) throw new Error("Octant will not type into a sensitive or credential field.");
      return { x, y };
    })()`,
    );
    return validPoint(result);
  }
  if (selector === undefined) throw new Error("Browser action requires a selector or point.");
  const result = await execute(
    view,
    `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) throw new Error("Browser target was not found.");
    if (${editable ? "true" : "false"} && !(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable)) throw new Error("Browser target is not editable.");
    const hint = [element.getAttribute("type"), element.getAttribute("autocomplete"), element.getAttribute("name"), element.id, element.getAttribute("aria-label")].join(" ").toLowerCase();
    if (${protectCredentials ? "true" : "false"} && /(?:password|passcode|one-time-code|otp|webauthn|cc-|credit|card|ssn|secret|token|api.?key)/.test(hint)) {
      throw new Error("Octant will not type into a sensitive or credential field.");
    }
    element.scrollIntoView({ block: "center", inline: "center" });
    const rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) throw new Error("Browser target is not visible.");
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`,
  );
  return validPoint(result);
}

async function clickTarget(
  view: BrowserSurfaceViewPort,
  selector: string | undefined,
  point: { readonly x: number; readonly y: number } | undefined,
): Promise<void> {
  const target = await targetGeometry(view, selector, point, false, false);
  await withDebugger(view, async (send) => {
    await dispatchTrustedClick(send, target);
  });
  await waitForPageSettled(view);
}

async function typeIntoTarget(
  view: BrowserSurfaceViewPort,
  selector: string | undefined,
  value: string | undefined,
  protectCredentials: boolean,
): Promise<void> {
  if (value === undefined) throw new Error("Type requires a selector and value.");
  const point = await targetGeometry(view, selector, undefined, true, protectCredentials);
  await withDebugger(view, async (send) => {
    await dispatchTrustedClick(send, point);
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", modifiers: 4 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", modifiers: 4 });
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace" });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace" });
    await send("Input.insertText", { text: value });
  });
}

async function pressFocusedTarget(
  view: BrowserSurfaceViewPort,
  key: string | undefined,
  protectCredentials: boolean,
): Promise<void> {
  if (key === undefined) throw new Error("Press requires a key.");
  await targetGeometry(view, ":focus", undefined, true, protectCredentials);
  await withDebugger(view, async (send) => {
    const shifted = key === "Shift+Tab";
    const normalized = shifted ? "Tab" : key;
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: normalized,
      ...(shifted ? { modifiers: 8 } : {}),
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: normalized,
      ...(shifted ? { modifiers: 8 } : {}),
    });
  });
}

function validPoint(value: unknown): { readonly x: number; readonly y: number } {
  if (
    typeof value !== "object" ||
    value === null ||
    !("x" in value) ||
    !("y" in value) ||
    typeof value.x !== "number" ||
    typeof value.y !== "number" ||
    !Number.isFinite(value.x) ||
    !Number.isFinite(value.y)
  ) {
    throw new Error("Browser target geometry is invalid.");
  }
  return { x: value.x, y: value.y };
}

function viewportSize(
  value: unknown,
): { readonly width: number; readonly height: number } | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("width" in value) ||
    !("height" in value) ||
    typeof value.width !== "number" ||
    typeof value.height !== "number" ||
    !Number.isInteger(value.width) ||
    !Number.isInteger(value.height) ||
    value.width < 1 ||
    value.height < 1 ||
    value.width > 8192 ||
    value.height > 8192
  ) {
    return undefined;
  }
  return { width: value.width, height: value.height };
}

async function dispatchTrustedClick(
  send: (method: string, parameters?: Record<string, unknown>) => Promise<unknown>,
  point: { readonly x: number; readonly y: number },
): Promise<void> {
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    clickCount: 1,
    x: point.x,
    y: point.y,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    button: "left",
    clickCount: 1,
    x: point.x,
    y: point.y,
  });
}

async function withDebugger(
  view: BrowserSurfaceViewPort,
  action: (
    send: (method: string, parameters?: Record<string, unknown>) => Promise<unknown>,
  ) => Promise<void>,
): Promise<void> {
  const client = view.webContents.debugger;
  if (client.isAttached()) throw new Error("Browser automation control is already in use.");
  client.attach("1.3");
  try {
    await action((method, parameters) => client.sendCommand(method, parameters));
  } finally {
    if (client.isAttached()) client.detach();
  }
}

async function waitForPageSettled(view: BrowserSurfaceViewPort): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (view.webContents.isLoading() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function hasSensitiveDocument(
  view: BrowserSurfaceViewPort,
  protectCredentials: boolean,
): Promise<boolean> {
  if (!protectCredentials) return false;
  const probe = `(() => {
    const roots = [document];
    for (let index = 0; index < roots.length; index += 1) {
      for (const element of roots[index].querySelectorAll("*")) {
        if (element.shadowRoot) roots.push(element.shadowRoot);
      }
    }
    return roots.some((root) =>
      Array.from(root.querySelectorAll("input, textarea, [contenteditable=true]")).some((element) => {
        const hint = [element.getAttribute("type"), element.getAttribute("autocomplete"), element.getAttribute("name"), element.id, element.getAttribute("aria-label")].join(" ").toLowerCase();
        return /(?:password|passcode|one-time-code|otp|webauthn|cc-|credit|card|ssn|secret|token|api.?key)/.test(hint);
      })
    );
  })()`;
  const frames = view.webContents.mainFrame.framesInSubtree;
  try {
    if (frames.length === 0) return (await execute(view, probe)) === true;
    for (const frame of frames) {
      if ((await frame.executeJavaScript(probe)) === true) return true;
    }
    return false;
  } catch {
    // If any frame cannot be inspected, screenshot and extracted evidence
    // fail closed instead of risking credential disclosure.
    return true;
  }
}

function redactedObservationUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of url.searchParams.keys()) {
      if (/(?:token|secret|password|passcode|code|key|credential|auth)/i.test(key)) {
        url.searchParams.set(key, "redacted");
      }
    }
    url.hash = "";
    return url.toString();
  } catch {
    return "about:blank";
  }
}

async function waitForSelector(
  view: BrowserSurfaceViewPort,
  selector: string | undefined,
): Promise<void> {
  if (selector === undefined) throw new Error("Wait requires a selector.");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (
      (await execute(view, `document.querySelector(${JSON.stringify(selector)}) !== null`)) === true
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for Browser target.");
}

async function captureScreenshot(view: BrowserSurfaceViewPort): Promise<string | undefined> {
  const image = await view.webContents.capturePage();
  const bytes = image.toJPEG(70);
  const dataUrl = `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`;
  return dataUrl.length <= 54 * 1_024 ? dataUrl : undefined;
}
