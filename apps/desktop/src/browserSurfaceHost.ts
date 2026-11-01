import { createHash } from "node:crypto";
import {
  browserProfileKey,
  browserProfilePartition,
  awaitQuietPage,
  BROWSER_DIALOG_POLICY,
  BROWSER_SETTLE_CAP_MS,
  BROWSER_SETTLE_QUIET_MS,
  browserPageConditions,
  browserRefStillMatches,
  describeUnmetWait,
  dialogType,
  parseBrowserKeyChord,
  waitSatisfied,
  formatBrowserPageSnapshot,
  MAX_BROWSER_SNAPSHOT_NODES,
  MAX_BROWSER_SNAPSHOT_REFS,
  originAllowed as sameSiteOriginAllowed,
  readBrowserPage,
  type BrowserPageReadRequest,
  type BrowserPageReadResult,
  type BrowserPageSnapshotRef,
} from "@octant/domain";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";
import {
  DEFAULT_BROWSER_WAIT_MS,
  MAX_BROWSER_DIAGNOSTIC_ENTRIES,
  MAX_BROWSER_WAIT_MS,
  MAX_BROWSER_DIAGNOSTIC_TEXT_CHARACTERS,
  type BrowserActionRequest,
  type BrowserContextId,
  type BrowserContextPolicy,
  type BrowserThreadId,
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

/** One tab as the rail shows it. */
export interface BrowserSurfaceTabState {
  readonly tabId: string;
  readonly url: string;
  readonly title: string;
}

export interface BrowserSurfaceState {
  readonly contextId: string;
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly control: "idle" | "user" | "agent";
  readonly tabs: ReadonlyArray<BrowserSurfaceTabState>;
  readonly activeTabId: string;
}

/** What the person asked of the tab rail. */
export type BrowserSurfaceTabCommand =
  | { readonly kind: "open" }
  | { readonly kind: "select"; readonly tabId: string }
  | { readonly kind: "close"; readonly tabId: string };

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
  /**
   * Where Electron reports a request that did not complete. One listener per
   * session, which is why a context installs the same one for every tab.
   */
  readonly webRequest?: {
    onErrorOccurred(
      listener:
        | ((details: {
            readonly url: string;
            readonly method?: string;
            readonly error?: string;
            readonly webContentsId?: number;
          }) => void)
        | null,
    ): void;
  };
}

/** The part of a captured frame the host uses: emptiness, encoding, and scaling. */
export interface BrowserSurfaceImage {
  isEmpty(): boolean;
  toJPEG(quality: number): Uint8Array;
  getSize?(): { readonly width: number; readonly height: number };
  resize?(options: { readonly width: number }): BrowserSurfaceImage;
}

export interface BrowserSurfaceViewPort {
  setBounds(bounds: BrowserSurfaceBounds): void;
  setVisible(visible: boolean): void;
  readonly webContents: {
    /** Electron's id for the page; the key a session-wide request report names. */
    readonly id?: number;
    capturePage(): Promise<BrowserSurfaceImage>;
    close(): void;
    readonly debugger: {
      attach(protocolVersion?: string): void;
      detach(): void;
      isAttached(): boolean;
      sendCommand(method: string, commandParams?: Record<string, unknown>): Promise<unknown>;
      /** Protocol events, such as a page's dialog opening; Electron's debugger emits them. */
      on?(
        event: "message",
        listener: (event: unknown, method: string, params: unknown) => void,
      ): void;
      removeListener?(
        event: "message",
        listener: (event: unknown, method: string, params: unknown) => void,
      ): void;
    };
    /** Electron's device emulation, which sizes the page without moving the view. */
    enableDeviceEmulation?(parameters: {
      readonly screenPosition: "desktop" | "mobile";
      readonly screenSize: { readonly width: number; readonly height: number };
      readonly viewPosition: { readonly x: number; readonly y: number };
      readonly deviceScaleFactor: number;
      readonly viewSize: { readonly width: number; readonly height: number };
      readonly scale: number;
    }): void;
    disableDeviceEmulation?(): void;
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

/** One page of a context. Tabs share the context's session and its guards. */
interface OwnedTab {
  readonly tabId: string;
  readonly view: BrowserSurfaceViewPort;
}

interface OwnedSurface {
  readonly owner: BrowserSurfaceOwner;
  readonly policy: BrowserContextPolicy;
  /** Every open tab, in the order the person opened them. */
  tabs: OwnedTab[];
  activeTabId: string;
  /**
   * Ordinal for the next tab this context opens.
   *
   * Monotonic rather than derived from the open tabs, so closing the second of
   * three tabs cannot hand a later tab an identifier the renderer still holds.
   */
  nextTabOrdinal: number;
  /**
   * Bounds the surface was last placed at, so a tab brought to the front lands
   * where the outgoing one sat. Native views are positioned in window
   * coordinates, and a tab that is only made visible has no bounds of its own.
   */
  lastBounds: BrowserSurfaceBounds | undefined;
  /**
   * Origins the person reached for themselves, kept apart from the policy's
   * allowlist. The policy says what the agent may act on and grows only by
   * approval; this grows as the person browses and is never consulted when an
   * action is authorized.
   */
  userGrantedOrigins: string[];
  /**
   * Page loads an extension asked for that are still under way. A redirect during
   * one must not grant its destination as the person's own browsing would: the
   * extension is not the person, whoever last touched the surface.
   */
  extensionLoads: number;
  actionTail: Promise<void>;
  control: BrowserSurfaceState["control"];
  shellWindow: BrowserSurfaceShellWindowPort | undefined;
  /** Last top-level navigation the allowlist guard cancelled during the current action. */
  blockedNavigationUrl: string | undefined;
  /**
   * What the context's pages reported since the last diagnostics read. Bounded
   * on write, oldest first out, so a page that logs in a loop cannot grow this
   * while the agent looks elsewhere.
   */
  consoleErrors: Array<{ text: string; url?: string }>;
  failedRequests: Array<{ url: string; method?: string; failure: string }>;
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

/**
 * The element a snapshot ref named is gone or is no longer the element the
 * snapshot described, so the action was refused before it touched the page.
 */
/** A wait ran out its time; the message names the conditions that never held. */
export class BrowserWaitTimedOutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserWaitTimedOutError";
  }
}

export class BrowserTargetStaleError extends Error {
  constructor() {
    super("The element behind that ref changed since the snapshot.");
    this.name = "BrowserTargetStaleError";
  }
}

/** The actions after which the page is given a moment to settle before it is read. */
const SETTLING_ACTIONS: ReadonlySet<string> = new Set([
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

/** What the server asks a page to do; it carries no authority of its own. */
export type BrowserSurfaceAction = Pick<BrowserActionRequest, "kind"> &
  Partial<
    Pick<
      BrowserActionRequest,
      | "target"
      | "value"
      | "point"
      | "deltaX"
      | "deltaY"
      | "include"
      | "destination"
      | "files"
      | "tabId"
      | "waitFor"
      | "viewport"
    >
  > & {
    /** The role and name a snapshot ref recorded; the target must still match. */
    readonly expected?: { readonly role: string; readonly name: string; readonly url: string };
    /** The same for a drag's drop target. */
    readonly destinationExpected?: {
      readonly role: string;
      readonly name: string;
      readonly url: string;
    };
  };

export interface BrowserSurfaceRuntimeObservation {
  readonly url?: string;
  readonly title?: string;
  readonly contentHash?: string;
  readonly extractedText?: string;
  /** Only a snapshot read fills these: the outline, and what each ref names. */
  readonly snapshot?: string;
  readonly snapshotRefs?: ReadonlyArray<BrowserPageSnapshotRef>;
  readonly dialogs?: ReadonlyArray<DialogReport>;
  /** Only a tab action fills this, with the ids the agent knows tabs by. */
  readonly tabs?: ReadonlyArray<{
    readonly tabId: string;
    readonly url?: string;
    readonly title?: string;
    readonly active: boolean;
  }>;
  readonly screenshotDataUrl?: string;
  readonly viewport?: { readonly width: number; readonly height: number };
  /** Only an observe-diagnostics read fills these; each read clears what it returns. */
  readonly consoleErrors?: ReadonlyArray<{ readonly text: string; readonly url?: string }>;
  readonly failedRequests?: ReadonlyArray<{
    readonly url: string;
    readonly method?: string;
    readonly failure: string;
  }>;
}

const ISOLATED_WORLD_ID = 1_001;

/**
 * How many origins one context remembers the person having visited.
 *
 * A research session wanders; the oldest grant is given up rather than letting
 * the set grow without end. Nothing here reaches the agent, so the bound costs
 * a re-grant on revisit and nothing else.
 */
const MAX_USER_GRANTED_ORIGINS = 128;

export function createBrowserSurfaceHost(options: BrowserSurfaceHostOptions) {
  const surfaces = new Map<string, OwnedSurface>();
  const surfaceByWebContents = new Map<number, OwnedSurface>();
  const guardedSessions = new WeakSet<object>();
  const forgetWebContents = (tab: OwnedTab): void => {
    const id = tab.view.webContents.id;
    if (id !== undefined) surfaceByWebContents.delete(id);
  };
  const goneListeners = new Set<(contextId: string) => void>();
  const stateChannel = options.stateChannel ?? DESKTOP_IPC_CHANNELS.browserSurfaceState;

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
    // Emptied before anything is closed: closing a page can report the page
    // gone, and a report that arrives while this list is still being walked
    // would take a tab out from under the walk.
    const closing = owned.tabs;
    owned.tabs = [];
    for (const tab of closing) {
      tab.view.setVisible(false);
      owned.shellWindow?.contentView.removeChildView(tab.view);
      forgetWebContents(tab);
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
    owned.shellWindow = undefined;
    for (const listener of goneListeners) listener(contextId);
  };

  /**
   * Bring one tab to the front of its context.
   *
   * Native views are siblings placed by absolute window bounds, so the ones
   * behind are not merely hidden but taken out of the window: an invisible
   * child view still occupies the same rectangle and still receives the
   * window's attention. The incoming tab is given the bounds the outgoing one
   * held, because a view that has only ever been created has none.
   */
  const showTab = (owned: OwnedSurface, incoming: OwnedTab): void => {
    for (const tab of owned.tabs) {
      if (tab === incoming) continue;
      tab.view.setVisible(false);
      owned.shellWindow?.contentView.removeChildView(tab.view);
    }
    owned.activeTabId = incoming.tabId;
    if (owned.shellWindow === undefined || owned.shellWindow.isDestroyed()) return;
    owned.shellWindow.contentView.addChildView(incoming.view);
    if (owned.lastBounds !== undefined) incoming.view.setBounds(owned.lastBounds);
    incoming.view.setVisible(true);
  };

  /**
   * Take one tab out of its context, whether the person closed it or its
   * renderer went away on its own.
   *
   * Only the last tab standing ends the context. Before tabs, one destroyed
   * view was the whole surface, and carrying that forward would let a crash in
   * one research page throw away the session in the others. A tab already
   * taken out is absent here and reports nothing, so a close a caller asked
   * for does not come back around as a second, involuntary one.
   */
  const forgetTab = (contextId: string, owned: OwnedSurface, tab: OwnedTab): void => {
    const index = owned.tabs.indexOf(tab);
    if (index === -1) return;
    owned.tabs.splice(index, 1);
    tab.view.setVisible(false);
    owned.shellWindow?.contentView.removeChildView(tab.view);
    forgetWebContents(tab);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    if (owned.tabs.length === 0) return markGone(contextId, owned);
    const successor = owned.tabs[Math.min(index, owned.tabs.length - 1)];
    if (owned.activeTabId === tab.tabId && successor !== undefined) showTab(owned, successor);
    publish(contextId, owned);
  };

  /**
   * Open one more page inside a context, wired to that context's own guards.
   *
   * Every tab of a context is built here, so a second tab is protected by the
   * same permission refusals, download block, popup denial, navigation
   * admission, and input gate as the first. A tab that skipped any of them
   * would be a hole in the context rather than a page in it.
   */
  const openTabView = (
    contextId: BrowserContextId | string,
    owned: OwnedSurface,
    tabId: string,
  ): OwnedTab => {
    const view = options.createView({
      // A Private page keeps a partition of its own context; a stored profile
      // keeps one persistent partition that every page of the profile shares,
      // which is what makes a sign-in carry from one page to the next.
      partition: browserProfilePartition(owned.policy.profile, contextId),
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
    // A profile's session outlives every context in it, so the download block is
    // installed once per session rather than once per tab.
    if (!guardedSessions.has(view.webContents.session)) {
      guardedSessions.add(view.webContents.session);
      view.webContents.session.on("will-download", (event) => event.preventDefault?.());
    }
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
    for (const event of [
      "did-start-loading",
      "did-stop-loading",
      "did-navigate",
      "did-navigate-in-page",
      "page-title-updated",
    ]) {
      view.webContents.on(event, () => publish(contextId, owned));
    }
    const guardNavigation = (event: unknown, ...details: readonly unknown[]) => {
      const target = navigationUrl(event, details);
      if (typeof target === "string" && admitNavigation(owned, target)) return;
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
      const callback = details.find((detail): detail is () => void => typeof detail === "function");
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
    view.webContents.on("console-message", (...args: readonly unknown[]) => {
      recordConsoleError(owned, view.webContents.getURL(), args);
    });
    // Electron keeps one failed-request listener per session, and the pages of a
    // stored profile share a session across contexts. The listener each new tab
    // installs therefore routes by the page that failed, not by the context that
    // installed it last.
    const webContentsId = view.webContents.id;
    if (webContentsId !== undefined) surfaceByWebContents.set(webContentsId, owned);
    view.webContents.session.webRequest?.onErrorOccurred((details) => {
      if (details.webContentsId === undefined) return recordFailedRequest(owned, details);
      const target = surfaceByWebContents.get(details.webContentsId);
      if (target !== undefined) recordFailedRequest(target, details);
    });
    view.webContents.on("focus", () => {
      owned.control = "user";
      publish(contextId, owned);
    });
    const gateUserInput = (event: unknown) => {
      if (owned.control === "agent") {
        (event as { preventDefault?: () => void }).preventDefault?.();
        return;
      }
      owned.control = "user";
      publish(contextId, owned);
    };
    view.webContents.on("before-input-event", gateUserInput);
    view.webContents.on("before-mouse-event", gateUserInput);
    const tab: OwnedTab = { tabId, view };
    owned.tabs.push(tab);
    view.webContents.on("render-process-gone", () => forgetTab(String(contextId), owned, tab));
    view.webContents.on("destroyed", () => forgetTab(String(contextId), owned, tab));
    return tab;
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
      const firstTabId = `${String(input.contextId)}:1`;
      const owned: OwnedSurface = {
        owner: input.owner,
        policy: input.policy,
        tabs: [],
        activeTabId: firstTabId,
        nextTabOrdinal: 2,
        lastBounds: undefined,
        userGrantedOrigins: [],
        extensionLoads: 0,
        actionTail: Promise.resolve(),
        control: "idle",
        shellWindow: undefined,
        blockedNavigationUrl: undefined,
        consoleErrors: [],
        failedRequests: [],
      };
      openTabView(input.contextId, owned, firstTabId);
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
        for (const tab of owned.tabs) owned.shellWindow.contentView.removeChildView(tab.view);
      }
      owned.shellWindow = shellWindow;
      owned.lastBounds = normalizeBounds(bounds);
      shellWindow.contentView.addChildView(contentsView(owned));
      contentsView(owned).setBounds(owned.lastBounds);
      contentsView(owned).setVisible(true);
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
      owned.lastBounds = normalizeBounds(bounds);
      contentsView(owned).setBounds(owned.lastBounds);
    },
    detach: (contextId: BrowserContextId | string, owner: BrowserSurfaceOwner): void => {
      const owned = surface(contextId);
      if (owned.owner.windowId !== owner.windowId || owned.owner.threadId !== owner.threadId) {
        throw new Error("Octant Browser can detach only from its owning Project window.");
      }
      for (const tab of owned.tabs) {
        tab.view.setVisible(false);
        owned.shellWindow?.contentView.removeChildView(tab.view);
      }
      owned.shellWindow = undefined;
    },
    inspectTarget: async (contextId: BrowserContextId | string, selector: string) => {
      const owned = surface(contextId);
      const result = await execute(
        contentsView(owned),
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
      request: BrowserSurfaceAction,
      signal?: AbortSignal,
    ): Promise<BrowserSurfaceRuntimeObservation> => {
      const owned = surface(contextId);
      return queueSurfaceAction(owned, async () => {
        throwIfAborted(signal);
        owned.control = "agent";
        owned.blockedNavigationUrl = undefined;
        publish(contextId, owned);
        const dialogs: DialogReport[] = [];
        const releaseDialogs = await guardDialogs(contentsView(owned), dialogs);
        try {
          const observed = await (async (): Promise<BrowserSurfaceRuntimeObservation> => {
            const contents = contentsView(owned).webContents;
            // Reading or driving a page is authorized by the origin approval put
            // on this context, and the page in front is not always one approval
            // covered: the person can take their own view somewhere else, and
            // tabs of a context share its session. Navigating is exempt because
            // it reads nothing — its own target check is the guard — but its
            // result is checked below, so a navigation that fails cannot leave
            // the agent extracting the page it did not manage to leave.
            // A tab action reads no page: it names tabs and moves between them,
            // so a front tab the person took elsewhere does not strand the agent.
            if (request.kind !== "navigate" && !request.kind.startsWith("tab-")) {
              refuseUnapprovedPage(owned, contents);
            }
            await refuseStaleTarget(contentsView(owned), request.target, request.expected);
            await refuseStaleTarget(
              contentsView(owned),
              request.destination,
              request.destinationExpected,
            );
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
                if (request.waitFor === undefined) {
                  await waitForSelector(contentsView(owned), request.target);
                } else {
                  await waitForConditions(contentsView(owned), request.waitFor, signal);
                }
                break;
              case "resize": {
                const webContents = contentsView(owned).webContents;
                if (request.viewport === undefined) {
                  webContents.disableDeviceEmulation?.();
                } else {
                  webContents.enableDeviceEmulation?.({
                    screenPosition: "desktop",
                    screenSize: request.viewport,
                    viewPosition: { x: 0, y: 0 },
                    deviceScaleFactor: 0,
                    viewSize: request.viewport,
                    scale: 1,
                  });
                }
                break;
              }
              case "hover":
                await hoverTarget(contentsView(owned), request.target);
                break;
              case "select":
                await selectOption(contentsView(owned), request.target, request.value);
                break;
              case "drag":
                await dragTarget(contentsView(owned), request.target, request.destination);
                break;
              case "upload":
                await uploadFiles(contentsView(owned), request.target, request.files);
                break;
              case "tab-list":
                return agentTabs(owned);
              case "tab-open": {
                // The agent's own new tab: the same guards as every tab, and its
                // page is reached through the same navigation admission, while
                // the agent drives so nothing it reaches is granted as browsing.
                if (owned.tabs.length >= owned.policy.maxConcurrentTabs) {
                  throw new Error("Octant Browser context is already at its tab limit.");
                }
                if (
                  request.target !== undefined &&
                  !originAllowed(request.target, owned.policy.allowedOrigins)
                ) {
                  throw new Error("Navigation target origin is not in the allowlist.");
                }
                const tabId = `${String(contextId)}:${owned.nextTabOrdinal}`;
                owned.nextTabOrdinal += 1;
                const opened = openTabView(contextId, owned, tabId);
                showTab(owned, opened);
                // The new tab's own load can raise a dialog too.
                const releaseTabDialogs = await guardDialogs(opened.view, dialogs);
                try {
                  await opened.view.webContents.loadURL(
                    request.target === undefined ? "about:blank" : normalizeUrl(request.target),
                  );
                } catch (error) {
                  if (owned.blockedNavigationUrl === undefined) throw error;
                  throw new BrowserNavigationBlockedError(owned.blockedNavigationUrl);
                } finally {
                  await releaseTabDialogs().catch(() => undefined);
                }
                refuseUnapprovedPage(owned, opened.view.webContents);
                return agentTabs(owned);
              }
              case "tab-select": {
                const chosen = owned.tabs.find((tab) => agentTabId(tab.tabId) === request.tabId);
                if (chosen === undefined) throw new Error("Octant Browser tab is unknown.");
                // The person's tab on a site no approval covers stays theirs.
                refuseUnapprovedPage(owned, chosen.view.webContents);
                showTab(owned, chosen);
                return agentTabs(owned);
              }
              case "tab-close": {
                const chosen = owned.tabs.find((tab) => agentTabId(tab.tabId) === request.tabId);
                if (chosen === undefined) throw new Error("Octant Browser tab is unknown.");
                if (owned.tabs.length === 1) {
                  throw new Error("Octant Browser cannot close a context's only tab.");
                }
                forgetTab(String(contextId), owned, chosen);
                return agentTabs(owned);
              }
              case "screenshot":
                break;
              case "snapshot":
                // The outline is the whole answer: no picture and no page text,
                // and a credential field in it is named, never valued.
                refuseUnapprovedPage(owned, contents);
                return {
                  ...(contents.getURL() === ""
                    ? {}
                    : { url: redactedObservationUrl(contents.getURL()).slice(0, 4_096) }),
                  ...(contents.getTitle() === ""
                    ? {}
                    : { title: contents.getTitle().slice(0, 1_024) }),
                  ...(await snapshotOf(owned)),
                };
              case "observe-diagnostics":
                // Handed over and cleared before any renderer work: a page that
                // never committed has no document to evaluate, and that is when
                // the failed request is the whole answer. The next read answers
                // what happened since this one.
                return {
                  consoleErrors: owned.consoleErrors.splice(0),
                  failedRequests: owned.failedRequests.splice(0),
                };
              case "close-tab":
                await contents.loadURL("about:blank");
                break;
            }
            if (SETTLING_ACTIONS.has(request.kind)) await settlePage(contentsView(owned));
            refuseUnapprovedPage(owned, contents);
            const include = new Set(request.include ?? []);
            const wantsText = request.kind === "extract-text" || include.has("text");
            // The body's text is always read, for the hash the server compares to
            // say what changed; it is returned only when asked for.
            const bodyText = await execute(
              contentsView(owned),
              "document.body?.innerText?.slice(0, 65536) ?? ''",
            );
            const text = typeof bodyText === "string" ? bodyText : "";
            const selectedText =
              wantsText && request.kind === "extract-text" && request.target !== undefined
                ? await execute(
                    contentsView(owned),
                    `document.querySelector(${JSON.stringify(request.target)})?.innerText?.slice(0, 65536) ?? ''`,
                  )
                : text;
            const measuredViewport = await execute(
              contentsView(owned),
              "({ width: Math.round(window.innerWidth), height: Math.round(window.innerHeight) })",
            );
            const viewport = viewportSize(measuredViewport);
            const sensitiveDocument = await hasSensitiveDocument(
              contentsView(owned),
              owned.policy.credentialFieldProtection,
            );
            // A picture only when one is asked for. The person's activity
            // preview takes its own through peek, so an agent's click no longer
            // pays for a capture nobody reads.
            const screenshotDataUrl =
              sensitiveDocument || (request.kind !== "screenshot" && !include.has("screenshot"))
                ? undefined
                : await captureScreenshot(contentsView(owned));
            const outline = include.has("snapshot") ? await snapshotOf(owned) : {};
            return {
              ...outline,
              ...(contents.getURL() === ""
                ? {}
                : { url: redactedObservationUrl(contents.getURL()).slice(0, 4_096) }),
              ...(contents.getTitle() === "" ? {} : { title: contents.getTitle().slice(0, 1_024) }),
              ...(sensitiveDocument
                ? {}
                : { contentHash: createHash("sha256").update(text, "utf8").digest("hex") }),
              ...(!sensitiveDocument && wantsText
                ? { extractedText: typeof selectedText === "string" ? selectedText : "" }
                : {}),
              ...(screenshotDataUrl === undefined ? {} : { screenshotDataUrl }),
              ...(viewport === undefined ? {} : { viewport }),
            };
          })();
          // Every dialog the page raised during the action is reported once,
          // with how the fixed policy answered it.
          return dialogs.length === 0 ? observed : { ...observed, dialogs: dialogs.slice(0, 8) };
        } finally {
          // Released before the surface is handed back, whatever the action did;
          // a page that went away with its tab has nothing left to detach.
          await releaseDialogs().catch(() => undefined);
          owned.control = "idle";
          publish(contextId, owned);
        }
      });
    },
    /**
     * The page as it stands, without taking the surface from the person: the
     * address, the title, and a picture unless the document holds a credential
     * field. Nothing here is an action, so nothing is queued or journaled.
     */
    peek: async (
      contextId: BrowserContextId | string,
    ): Promise<BrowserSurfaceRuntimeObservation> => {
      const owned = surface(contextId);
      const contents = contentsView(owned).webContents;
      // A context that has not navigated yet has no document to inspect and
      // no painted frame to capture; both probes below would never resolve.
      if (contents.getURL() === "") return {};
      const sensitiveDocument = await hasSensitiveDocument(
        contentsView(owned),
        owned.policy.credentialFieldProtection,
      );
      const screenshotDataUrl = sensitiveDocument
        ? undefined
        : await captureScreenshot(contentsView(owned));
      return {
        ...(contents.getURL() === ""
          ? {}
          : { url: redactedObservationUrl(contents.getURL()).slice(0, 4_096) }),
        ...(contents.getTitle() === "" ? {} : { title: contents.getTitle().slice(0, 1_024) }),
        ...(screenshotDataUrl === undefined ? {} : { screenshotDataUrl }),
      };
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
        const contents = contentsView(owned).webContents;
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
    tabCommand: async (
      contextId: BrowserContextId | string,
      owner: BrowserSurfaceOwner,
      command: BrowserSurfaceTabCommand,
    ): Promise<BrowserSurfaceState> => {
      const owned = surface(contextId);
      if (owned.owner.windowId !== owner.windowId || owned.owner.threadId !== owner.threadId) {
        throw new Error("Octant Browser tab command does not own this context.");
      }
      return queueSurfaceAction(owned, async () => {
        // Opening, selecting, and closing a tab are all the person acting on
        // their own view, so the surface is theirs to drive afterwards. It
        // grants no origin on its own: a new tab starts blank and reaches an
        // origin only through the navigation guard.
        owned.control = "user";
        if (command.kind === "open") {
          if (owned.tabs.length >= owned.policy.maxConcurrentTabs) {
            throw new Error("Octant Browser context is already at its tab limit.");
          }
          const tabId = `${String(contextId)}:${owned.nextTabOrdinal}`;
          owned.nextTabOrdinal += 1;
          const opened = openTabView(contextId, owned, tabId);
          await opened.view.webContents.loadURL("about:blank");
          showTab(owned, opened);
        } else {
          const index = owned.tabs.findIndex((tab) => tab.tabId === command.tabId);
          const tab = owned.tabs[index];
          if (tab === undefined) throw new Error("Octant Browser tab is unknown.");
          if (command.kind === "select") {
            showTab(owned, tab);
          } else {
            // The context is the tab: closing the only page would leave a
            // surface with nothing to show, which is a context close and the
            // caller's decision, not this command's.
            if (owned.tabs.length === 1) {
              throw new Error("Octant Browser cannot close a context's only tab.");
            }
            forgetTab(String(contextId), owned, tab);
          }
        }
        const state = readState(contextId, owned);
        publish(contextId, owned);
        return state;
      });
    },
    /**
     * The pages of one stored profile in one window, for an extension in that
     * profile. A Private page has no profile key a stored profile shares, so it
     * is never listed, and a page of another window or profile is not either.
     */
    profileTabs: (
      profile: BrowserContextPolicy["profile"],
      windowId: string,
    ): ReadonlyArray<ProfileTab> => profileTabsOf(profile, windowId),
    /**
     * Open a page in the window's shown context of a profile, for an extension.
     * Only an origin that context already admits is reachable: an extension is
     * not the person browsing, so it can neither widen what the agent may act
     * on nor grant itself an origin.
     */
    openProfileTab: async (
      profile: BrowserContextPolicy["profile"],
      windowId: string,
      url: string | undefined,
    ): Promise<ProfileTabResult> => {
      const shown = shownSurface(profile, windowId);
      if (shown === undefined) return { status: "no-page" };
      const [contextId, owned] = shown;
      if (url !== undefined && !extensionMayReach(owned, url)) return { status: "origin-refused" };
      return queueSurfaceAction(owned, async (): Promise<ProfileTabResult> => {
        if (owned.tabs.length >= owned.policy.maxConcurrentTabs) return { status: "tab-limit" };
        const tabId = `${contextId}:${owned.nextTabOrdinal}`;
        owned.nextTabOrdinal += 1;
        const opened = openTabView(contextId, owned, tabId);
        showTab(owned, opened);
        owned.extensionLoads += 1;
        try {
          await opened.view.webContents.loadURL(url ?? "about:blank");
        } catch {
          // A page that fails to load is still a page the person can see.
        } finally {
          owned.extensionLoads -= 1;
        }
        publish(contextId, owned);
        const tab = profileTabsOf(profile, windowId).find((entry) => entry.tabId === tabId);
        return tab === undefined ? { status: "no-page" } : { status: "tab", tab };
      });
    },
    /** Navigate or select one profile page by its numeric id, under the same rule as opening. */
    updateProfileTab: async (
      profile: BrowserContextPolicy["profile"],
      windowId: string,
      id: number,
      change: { readonly url?: string; readonly active?: boolean },
    ): Promise<ProfileTabResult> => {
      for (const [contextId, owned] of surfaces) {
        if (owned.owner.windowId !== windowId) continue;
        if (browserProfileKey(owned.policy.profile) !== browserProfileKey(profile)) continue;
        const tab = owned.tabs.find((entry) => entry.view.webContents.id === id);
        if (tab === undefined) continue;
        if (change.url !== undefined && !extensionMayReach(owned, change.url)) {
          return { status: "origin-refused" };
        }
        return queueSurfaceAction(owned, async (): Promise<ProfileTabResult> => {
          if (change.active === true) showTab(owned, tab);
          if (change.url !== undefined) {
            owned.extensionLoads += 1;
            try {
              await tab.view.webContents.loadURL(change.url);
            } catch {
              // The address is the person's to see failing in the page.
            } finally {
              owned.extensionLoads -= 1;
            }
          }
          publish(contextId, owned);
          const updated = profileTabsOf(profile, windowId).find((entry) => entry.id === id);
          return updated === undefined ? { status: "no-page" } : { status: "tab", tab: updated };
        });
      }
      return { status: "no-page" };
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
    /**
     * Close every page that lives in one stored profile, and tell the server
     * each one is gone. Clearing a profile's storage under an open page would
     * leave the page signed in until its next request, so the pages go first.
     */
    closeProfileContexts: async (profile: BrowserContextPolicy["profile"]): Promise<void> => {
      const key = browserProfileKey(profile);
      const ownedIds = [...surfaces.entries()]
        .filter(([, owned]) => browserProfileKey(owned.policy.profile) === key)
        .map(([contextId]) => contextId);
      await Promise.all(
        ownedIds.map(async (contextId) => {
          await closeContext(contextId);
          for (const listener of goneListeners) listener(contextId);
        }),
      );
    },
  });

  /** The context of a profile that is on screen in a window; the page a popup acts on. */
  function shownSurface(
    profile: BrowserContextPolicy["profile"],
    windowId: string,
  ): [string, OwnedSurface] | undefined {
    const key = browserProfileKey(profile);
    for (const [contextId, owned] of surfaces) {
      if (owned.owner.windowId !== windowId) continue;
      if (browserProfileKey(owned.policy.profile) !== key) continue;
      if (owned.shellWindow === undefined || owned.shellWindow.isDestroyed()) continue;
      return [contextId, owned];
    }
    return undefined;
  }

  function profileTabsOf(
    profile: BrowserContextPolicy["profile"],
    windowId: string,
  ): ReadonlyArray<ProfileTab> {
    const key = browserProfileKey(profile);
    const tabs: ProfileTab[] = [];
    for (const [contextId, owned] of surfaces) {
      if (owned.owner.windowId !== windowId) continue;
      if (browserProfileKey(owned.policy.profile) !== key) continue;
      const shown = owned.shellWindow !== undefined && !owned.shellWindow.isDestroyed();
      for (const tab of owned.tabs) {
        const id = tab.view.webContents.id;
        if (id === undefined) continue;
        tabs.push({
          id,
          contextId,
          tabId: tab.tabId,
          url: tab.view.webContents.getURL(),
          title: tab.view.webContents.getTitle(),
          active: shown && tab.tabId === owned.activeTabId,
        });
      }
    }
    return tabs;
  }

  async function closeContext(contextId: BrowserContextId | string): Promise<void> {
    const owned = surfaces.get(contextId);
    if (owned === undefined) return;
    surfaces.delete(contextId);
    const closing = owned.tabs;
    owned.tabs = [];
    for (const tab of closing) {
      tab.view.setVisible(false);
      owned.shellWindow?.contentView.removeChildView(tab.view);
      forgetWebContents(tab);
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
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
  return activeTab(owned).view;
}

function activeTab(owned: OwnedSurface): OwnedTab {
  const tab = owned.tabs.find((candidate) => candidate.tabId === owned.activeTabId);
  if (tab === undefined) throw new Error("Octant Browser context has no open tab.");
  return tab;
}

/** A page of a stored profile as an extension in that profile sees it. */
export interface ProfileTab {
  /** The page's Electron id, which is also the id the extension uses. */
  readonly id: number;
  readonly contextId: string;
  readonly tabId: string;
  readonly url: string;
  readonly title: string;
  readonly active: boolean;
}

export type ProfileTabResult =
  | { readonly status: "tab"; readonly tab: ProfileTab }
  | { readonly status: "no-page" | "origin-refused" | "tab-limit" };

/** An extension reaches only an address the context already admits, or a blank page. */
function extensionMayReach(owned: OwnedSurface, target: string): boolean {
  if (target === "about:blank") return true;
  return (
    originAllowed(target, owned.policy.allowedOrigins) ||
    originAllowed(target, owned.userGrantedOrigins)
  );
}

/**
 * May this navigation proceed, and does it grant its origin?
 *
 * A person following a link or typing an address is browsing, so the origin
 * they reach joins the origins their own view may show. Nothing else grants:
 * while the agent drives, or while nobody has touched the surface at all, the
 * allowlist is exactly what approval made it and a page cannot widen it by
 * navigating itself.
 */
function admitNavigation(owned: OwnedSurface, target: string): boolean {
  if (originAllowed(target, owned.policy.allowedOrigins)) return true;
  if (originAllowed(target, owned.userGrantedOrigins)) return true;
  // Only while the person is demonstrably driving. "idle" is nobody's action:
  // a surface nobody has touched must not grant itself an origin because a
  // page redirected on load.
  if (owned.control !== "user" || owned.extensionLoads > 0) return false;
  const origin = originOf(target);
  if (origin === undefined) return false;
  if (owned.userGrantedOrigins.length >= MAX_USER_GRANTED_ORIGINS) {
    owned.userGrantedOrigins.shift();
  }
  owned.userGrantedOrigins.push(origin);
  return true;
}

/**
 * Refuse to let the agent touch a page approval never covered.
 *
 * Only `policy.allowedOrigins` counts. The origins the person reached for
 * themselves are deliberately not consulted: browsing somewhere is the user's
 * action, and treating it as approval would let any link the user follows hand
 * the agent a page it was never granted.
 */
function refuseUnapprovedPage(
  owned: OwnedSurface,
  contents: BrowserSurfaceViewPort["webContents"],
): void {
  const showing = contents.getURL();
  if (showing === "" || originAllowed(showing, owned.policy.allowedOrigins)) return;
  throw new Error("Octant Browser will not act on a page outside this context's allowed origins.");
}

function originOf(target: string): string | undefined {
  try {
    return new URL(normalizeUrl(target)).origin;
  } catch {
    return undefined;
  }
}

function readState(contextId: string, owned: OwnedSurface): BrowserSurfaceState {
  const contents = contentsView(owned).webContents;
  return {
    contextId,
    url: contents.getURL().slice(0, 4_096),
    title: contents.getTitle().slice(0, 1_024),
    loading: contents.isLoading(),
    canGoBack: contents.navigationHistory.canGoBack(),
    canGoForward: contents.navigationHistory.canGoForward(),
    control: owned.control,
    tabs: owned.tabs.map((tab) => ({
      tabId: tab.tabId,
      url: tab.view.webContents.getURL().slice(0, 4_096),
      title: tab.view.webContents.getTitle().slice(0, 1_024),
    })),
    activeTabId: owned.activeTabId,
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
    return sameSiteOriginAllowed(normalizeUrl(target), allowedOrigins.map(normalizeUrl));
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
  // A WebContentsView that has never committed a document queues script
  // evaluations without ever settling them: the call hangs and, because the
  // broker serializes a surface's actions, every later action waits behind it.
  // getURL() is "" exactly while no document exists, so fail the call instead.
  if (view.webContents.getURL() === "") {
    return Promise.reject(new Error("Octant Browser has no page loaded."));
  }
  return view.webContents.executeJavaScriptInIsolatedWorld(
    ISOLATED_WORLD_ID,
    [{ code }],
    userGesture,
  );
}

/**
 * Run the shared page reader in the isolated world. Its source is handed over
 * whole, which is why it keeps no helpers outside its own body.
 */
async function readPage(
  view: BrowserSurfaceViewPort,
  request: BrowserPageReadRequest,
): Promise<BrowserPageReadResult> {
  const result = await execute(view, `(${readBrowserPage.toString()})(${JSON.stringify(request)})`);
  if (typeof result !== "object" || result === null || !("mode" in result)) {
    throw new Error("Browser page read returned nothing.");
  }
  return result as BrowserPageReadResult;
}

/** The page outline and what each of its refs names, under the context's protection. */
async function snapshotOf(owned: OwnedSurface): Promise<{
  readonly snapshot: string;
  readonly snapshotRefs: ReadonlyArray<BrowserPageSnapshotRef>;
}> {
  const read = await readPage(contentsView(owned), {
    mode: "snapshot",
    maxRefs: MAX_BROWSER_SNAPSHOT_REFS,
    maxNodes: MAX_BROWSER_SNAPSHOT_NODES,
    protectCredentials: owned.policy.credentialFieldProtection,
    // Every frame, which the in-page reader does not walk.
    withholdValues: await hasSensitiveDocument(
      contentsView(owned),
      owned.policy.credentialFieldProtection,
    ),
  });
  if (read.mode !== "snapshot") throw new Error("Browser snapshot is unavailable.");
  return { snapshot: formatBrowserPageSnapshot(read.snapshot), snapshotRefs: read.snapshot.refs };
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
  const chord = parseBrowserKeyChord(key);
  if (chord === undefined) throw new Error("Press requires a supported key.");
  // A key goes to whatever has focus, a field or the page itself; only a
  // focused credential field refuses it.
  if (protectCredentials) {
    const sensitive = await execute(
      view,
      `(() => {
      const element = document.activeElement;
      if (!(element instanceof HTMLElement) || element === document.body) return false;
      const hint = [element.getAttribute("type"), element.getAttribute("autocomplete"), element.getAttribute("name"), element.id, element.getAttribute("aria-label")].join(" ").toLowerCase();
      return /(?:password|passcode|one-time-code|otp|webauthn|cc-|credit|card|ssn|secret|token|api.?key)/.test(hint);
    })()`,
    );
    if (sensitive === true) {
      throw new Error("Octant will not type into a sensitive or credential field.");
    }
  }
  const event = keyEvent(chord);
  // On macOS the editing shortcuts are the system's, not the page's: a Command
  // chord reaches a text field as the editing command it stands for.
  const command =
    process.platform === "darwin" && chord.modifiers.includes("Meta")
      ? MAC_EDITING_COMMANDS[
          `${chord.modifiers.includes("Shift") ? "Shift+" : ""}${chord.key.toLowerCase()}`
        ]
      : undefined;
  await withDebugger(view, async (send) => {
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      ...event,
      ...(command === undefined ? {} : { commands: [command] }),
    });
    const { text: _text, ...released } = event;
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...released });
  });
}

const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const;
const MAC_EDITING_COMMANDS: Readonly<Record<string, string>> = {
  a: "selectAll",
  c: "copy",
  x: "cut",
  v: "paste",
  z: "undo",
  "Shift+z": "redo",
};
const NAMED_KEYS: Readonly<Record<string, { code: string; keyCode: number; text?: string }>> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  Escape: { code: "Escape", keyCode: 27 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  Space: { code: "Space", keyCode: 32, text: " " },
};

/**
 * What Chromium's input protocol needs to deliver one key as a real keyboard
 * would: the key, its physical code, the legacy key code pages still read, the
 * modifier bits, and the text it types when no command modifier is held.
 */
function keyEvent(chord: {
  readonly modifiers: ReadonlyArray<keyof typeof MODIFIER_BITS>;
  readonly key: string;
}): {
  readonly key: string;
  readonly code: string;
  readonly windowsVirtualKeyCode: number;
  readonly modifiers: number;
  readonly text?: string;
} {
  const modifiers = chord.modifiers.reduce((bits, modifier) => bits | MODIFIER_BITS[modifier], 0);
  const commanded = chord.modifiers.some((modifier) => modifier !== "Shift");
  const named = NAMED_KEYS[chord.key];
  if (named !== undefined) {
    return {
      key: chord.key === "Space" ? " " : chord.key,
      code: named.code,
      windowsVirtualKeyCode: named.keyCode,
      modifiers,
      ...(named.text === undefined || commanded ? {} : { text: named.text }),
    };
  }
  const fn = /^F([1-9]|1[0-2])$/.exec(chord.key);
  if (fn?.[1] !== undefined) {
    return {
      key: chord.key,
      code: chord.key,
      windowsVirtualKeyCode: 111 + Number(fn[1]),
      modifiers,
    };
  }
  const upper = chord.key.toUpperCase();
  const shifted = chord.modifiers.includes("Shift");
  const key = /[A-Z]/.test(upper) ? (shifted ? upper : chord.key.toLowerCase()) : chord.key;
  return {
    key,
    code: /[0-9]/.test(chord.key) ? `Digit${chord.key}` : `Key${upper}`,
    windowsVirtualKeyCode: upper.charCodeAt(0),
    modifiers,
    ...(commanded ? {} : { text: key }),
  };
}

async function hoverTarget(view: BrowserSurfaceViewPort, selector: string | undefined) {
  const point = await targetGeometry(view, selector, undefined, false, false);
  await withDebugger(view, async (send) => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  });
}

/**
 * Choose one option of a list by its value or its label, and tell the page the
 * way a person's choice would. The option is set in the isolated world, which
 * shares the document with the page; the events are what a page listens for.
 */
async function selectOption(
  view: BrowserSurfaceViewPort,
  selector: string | undefined,
  choice: string | undefined,
) {
  if (selector === undefined || choice === undefined) {
    throw new Error("Select requires a list and an option.");
  }
  const chosen = await execute(
    view,
    `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLSelectElement)) return "not-a-list";
    const choice = ${JSON.stringify(choice)};
    const option = Array.from(element.options).find((candidate) => candidate.value === choice || candidate.label === choice);
    if (option === undefined) return "no-option";
    element.value = option.value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return "chosen";
  })()`,
  );
  if (chosen === "not-a-list") throw new Error("Browser target is not a list.");
  if (chosen !== "chosen") throw new Error("The list has no option with that value or label.");
}

/**
 * Press on one element, move in steps, and release on another: the pointer
 * path a person's drag takes, so a page that follows pointer or mouse events
 * sees a drag.
 */
async function dragTarget(
  view: BrowserSurfaceViewPort,
  source: string | undefined,
  destination: string | undefined,
) {
  const from = await targetGeometry(view, source, undefined, false, false);
  const to = await targetGeometry(view, destination, undefined, false, false);
  await withDebugger(view, async (send) => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y });
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button: "left",
      buttons: 1,
      clickCount: 1,
      x: from.x,
      y: from.y,
    });
    for (let step = 1; step <= 10; step += 1) {
      await send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        button: "left",
        buttons: 1,
        x: from.x + ((to.x - from.x) * step) / 10,
        y: from.y + ((to.y - from.y) * step) / 10,
      });
    }
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      buttons: 0,
      clickCount: 1,
      x: to.x,
      y: to.y,
    });
  });
  await waitForPageSettled(view);
}

/** Put files into one file field through Chromium's own file chooser path. */
async function uploadFiles(
  view: BrowserSurfaceViewPort,
  selector: string | undefined,
  files: ReadonlyArray<string> | undefined,
) {
  if (selector === undefined || files === undefined || files.length === 0) {
    throw new Error("Upload requires a file field and files.");
  }
  const isFileField = await execute(
    view,
    `document.querySelector(${JSON.stringify(selector)}) instanceof HTMLInputElement && document.querySelector(${JSON.stringify(selector)}).type === "file"`,
  );
  if (isFileField !== true) throw new Error("Browser target is not a file field.");
  await withDebugger(view, async (send) => {
    const document = (await send("DOM.getDocument", { depth: 0 })) as {
      readonly root?: { readonly nodeId?: number };
    };
    const rootId = document.root?.nodeId;
    if (rootId === undefined) throw new Error("Browser page has no document.");
    const found = (await send("DOM.querySelector", { nodeId: rootId, selector })) as {
      readonly nodeId?: number;
    };
    if (found.nodeId === undefined || found.nodeId === 0) {
      throw new Error("Browser target was not found.");
    }
    await send("DOM.setFileInputFiles", { files: [...files], nodeId: found.nodeId });
  });
}

/** The id the agent knows a tab by: `t` and the tab's ordinal in its context. */
function agentTabId(tabId: string): string {
  return `t${tabId.slice(tabId.lastIndexOf(":") + 1)}`;
}

/** The context's tabs as the agent sees them, after a tab action. */
function agentTabs(owned: OwnedSurface): BrowserSurfaceRuntimeObservation {
  const front = contentsView(owned).webContents;
  const frontShown =
    front.getURL() !== "" &&
    front.getURL() !== "about:blank" &&
    originAllowed(front.getURL(), owned.policy.allowedOrigins);
  return {
    ...(frontShown ? { url: redactedObservationUrl(front.getURL()).slice(0, 4_096) } : {}),
    ...(frontShown && front.getTitle() !== "" ? { title: front.getTitle().slice(0, 1_024) } : {}),
    tabs: owned.tabs.map((tab) => {
      const url = tab.view.webContents.getURL();
      // A tab the person took to a site approval never covered is theirs:
      // the agent learns that it exists, not where it is or what it shows.
      const shown =
        url !== "" && url !== "about:blank" && originAllowed(url, owned.policy.allowedOrigins);
      const title = tab.view.webContents.getTitle();
      return {
        tabId: agentTabId(tab.tabId),
        ...(shown ? { url: redactedObservationUrl(url).slice(0, 4_096) } : {}),
        ...(shown && title !== "" ? { title: title.slice(0, 1_024) } : {}),
        active: tab.tabId === owned.activeTabId,
      };
    }),
  };
}

/** Refuse a ref whose page moved on or whose element is no longer the one named. */
async function refuseStaleTarget(
  view: BrowserSurfaceViewPort,
  selector: string | undefined,
  expected: BrowserSurfaceAction["expected"],
): Promise<void> {
  if (expected === undefined || selector === undefined) return;
  const found = await readPage(view, { mode: "verify", selector });
  if (
    found.mode !== "verify" ||
    !browserRefStillMatches(expected, found.element, observedUrl(view.webContents))
  ) {
    throw new BrowserTargetStaleError();
  }
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

/**
 * Debuggers the agent's own action attached to, so the action's input and
 * capture reuse the attachment instead of mistaking it for someone else's.
 */
const agentDebuggers = new WeakSet<object>();

interface DialogReport {
  readonly type: "alert" | "confirm" | "prompt" | "beforeunload";
  readonly message: string;
  readonly answer: "accepted" | "dismissed";
}

/**
 * Answer the page's own dialogs by the fixed policy for as long as an agent's
 * action runs, and record each one. A dialog left open would hold the page,
 * and the agent behind it, until a person found it. A debugger someone else
 * attached (developer tools) is left alone and the page's dialogs stay theirs.
 */
async function guardDialogs(
  view: BrowserSurfaceViewPort,
  reports: DialogReport[],
): Promise<() => Promise<void>> {
  const client = view.webContents.debugger;
  // A page that has not loaded yet is guarded too: its first load is when a
  // dialog most often opens.
  if (client.isAttached() || client.on === undefined) return async () => undefined;
  try {
    client.attach("1.3");
  } catch {
    return async () => undefined;
  }
  agentDebuggers.add(client);
  const listener = (_event: unknown, method: string, params: unknown) => {
    if (method !== "Page.javascriptDialogOpening") return;
    const opened = (params ?? {}) as { readonly type?: unknown; readonly message?: unknown };
    const type = dialogType(typeof opened.type === "string" ? opened.type : "alert");
    const answer = BROWSER_DIALOG_POLICY[type];
    if (reports.length < 8) {
      reports.push({
        type,
        message: (typeof opened.message === "string" ? opened.message : "").slice(0, 512),
        answer,
      });
    }
    void client
      .sendCommand("Page.handleJavaScriptDialog", { accept: answer === "accepted" })
      .catch(() => undefined);
  };
  client.on("message", listener);
  // Bounded: a view with no document yet may answer late, and the guard must
  // never hold the action it exists to keep moving.
  await Promise.race([
    client.sendCommand("Page.enable").catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ]);
  return async () => {
    client.removeListener?.("message", listener);
    agentDebuggers.delete(client);
    if (client.isAttached()) client.detach();
  };
}

/**
 * Check a wait's conditions until they hold or its time runs out, never more
 * than the hard limit the contract sets.
 */
async function waitForConditions(
  view: BrowserSurfaceViewPort,
  waitFor: NonNullable<BrowserSurfaceAction["waitFor"]>,
  signal: AbortSignal | undefined,
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
        readPage(view, { mode: "check", conditions }),
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
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Give the page a moment to finish what an action started: its load, then a
 * short window in which the document stops changing, bounded either way.
 */
async function settlePage(view: BrowserSurfaceViewPort): Promise<void> {
  await waitForPageSettled(view);
  await execute(
    view,
    `(${awaitQuietPage.toString()})(${JSON.stringify({
      quietMs: BROWSER_SETTLE_QUIET_MS,
      capMs: BROWSER_SETTLE_CAP_MS,
    })})`,
  ).catch(() => undefined);
}

async function withDebugger(
  view: BrowserSurfaceViewPort,
  action: (
    send: (method: string, parameters?: Record<string, unknown>) => Promise<unknown>,
  ) => Promise<void>,
): Promise<void> {
  const client = view.webContents.debugger;
  if (client.isAttached() && agentDebuggers.has(client)) {
    await action((method, parameters) => client.sendCommand(method, parameters));
    return;
  }
  if (client.isAttached()) throw new Error("Browser automation control is already in use.");
  client.attach("1.3");
  try {
    await action((method, parameters) => client.sendCommand(method, parameters));
  } finally {
    if (client.isAttached()) client.detach();
  }
}

async function waitForPageSettled(view: BrowserSurfaceViewPort): Promise<void> {
  const deadline = Date.now() + BROWSER_SETTLE_CAP_MS;
  while (view.webContents.isLoading() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function hasSensitiveDocument(
  view: BrowserSurfaceViewPort,
  protectCredentials: boolean,
): Promise<boolean> {
  if (!protectCredentials) return false;
  // No committed document means no credential fields and no frame whose
  // script evaluation would settle (see execute).
  if (view.webContents.getURL() === "") return false;
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

function boundedText(value: string, limit: number): string {
  return value.trim().slice(0, limit);
}

/**
 * Keep one console error. Electron 43 reports the message as fields of the
 * event; an older shape passes level and message positionally, so both are read
 * and a malformed report is dropped rather than recorded as an empty error.
 */
function recordConsoleError(owned: OwnedSurface, pageUrl: string, args: readonly unknown[]): void {
  const [first, level, message] = args;
  const fromEvent =
    typeof first === "object" && first !== null
      ? (first as { level?: unknown; message?: unknown })
      : {};
  const severity = fromEvent.level ?? level;
  const rawText = fromEvent.message ?? message;
  if (severity !== "error" && severity !== 3) return;
  if (typeof rawText !== "string") return;
  const text = boundedText(rawText, MAX_BROWSER_DIAGNOSTIC_TEXT_CHARACTERS);
  if (text === "") return;
  const url =
    pageUrl === "" || pageUrl === "about:blank" ? undefined : redactedObservationUrl(pageUrl);
  if (owned.consoleErrors.length >= MAX_BROWSER_DIAGNOSTIC_ENTRIES) owned.consoleErrors.shift();
  owned.consoleErrors.push({ text, ...(url === undefined ? {} : { url: url.slice(0, 4_096) }) });
}

function recordFailedRequest(
  owned: OwnedSurface,
  details: { readonly url: string; readonly method?: string; readonly error?: string },
): void {
  const url = boundedText(redactedObservationUrl(details.url), 4_096);
  if (url === "" || url === "about:blank") return;
  const method = boundedText(details.method ?? "", 16);
  const failure = boundedText(
    details.error ?? "The request did not complete.",
    MAX_BROWSER_DIAGNOSTIC_TEXT_CHARACTERS,
  );
  if (owned.failedRequests.length >= MAX_BROWSER_DIAGNOSTIC_ENTRIES) owned.failedRequests.shift();
  owned.failedRequests.push({
    url,
    ...(method === "" ? {} : { method }),
    failure: failure === "" ? "The request did not complete." : failure,
  });
}

/** The page's address as an observation reports it, so a snapshot's can be compared. */
function observedUrl(contents: BrowserSurfaceViewPort["webContents"]): string {
  const url = contents.getURL();
  return url === "" ? "about:blank" : redactedObservationUrl(url).slice(0, 4_096);
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
  throw new BrowserWaitTimedOutError(
    "The wait timed out after 10000 ms: the element never appeared.",
  );
}

/** What the observation contract carries for a picture, data URL included. */
const MAX_SCREENSHOT_DATA_URL = 54 * 1_024;
/**
 * The steps a picture is shrunk through to fit. A full Retina frame of a busy
 * page (a news front page) was several times the limit at quality 70, and the
 * picture was then dropped whole: the Browser preview showed only the page
 * title over an empty frame. A preview needs a recognisable page, not every
 * pixel, so the frame steps down in width and quality until it fits.
 */
const SCREENSHOT_WIDTHS = [undefined, 1_280, 960, 720, 480] as const;
const SCREENSHOT_QUALITIES = [70, 55] as const;

function jpegDataUrl(bytes: Uint8Array | string): string {
  const base64 = typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("base64");
  return `data:image/jpeg;base64,${base64}`;
}

function fitImage(image: BrowserSurfaceImage): string | undefined {
  const width = image.getSize?.().width;
  for (const target of SCREENSHOT_WIDTHS) {
    if (
      target !== undefined &&
      (image.resize === undefined || width === undefined || width <= target)
    ) {
      continue;
    }
    const sized =
      target === undefined || image.resize === undefined ? image : image.resize({ width: target });
    for (const quality of SCREENSHOT_QUALITIES) {
      const dataUrl = jpegDataUrl(sized.toJPEG(quality));
      if (dataUrl.length <= MAX_SCREENSHOT_DATA_URL) return dataUrl;
    }
  }
  return undefined;
}

async function captureScreenshot(view: BrowserSurfaceViewPort): Promise<string | undefined> {
  const image = await view.webContents.capturePage();
  // A detached surface paints nothing, and Chromium reports that as an empty
  // image rather than an error; an empty JPEG is not a page snapshot.
  if (!image.isEmpty()) return fitImage(image);
  // A surface that is not in a window still has a live renderer: the debugger
  // captures its view directly instead of a compositor surface it does not
  // have.
  const client = view.webContents.debugger;
  const ours = agentDebuggers.has(client);
  if (client.isAttached() && !ours) return undefined;
  try {
    if (!ours) client.attach("1.3");
    const metrics = (await client.sendCommand("Page.getLayoutMetrics")) as
      | {
          readonly cssLayoutViewport?: {
            readonly clientWidth?: number;
            readonly clientHeight?: number;
          };
        }
      | undefined;
    const viewportWidth = metrics?.cssLayoutViewport?.clientWidth;
    const viewportHeight = metrics?.cssLayoutViewport?.clientHeight;
    for (const target of SCREENSHOT_WIDTHS) {
      const scale =
        target === undefined || viewportWidth === undefined || viewportWidth <= target
          ? undefined
          : target / viewportWidth;
      if (target !== undefined && scale === undefined) continue;
      for (const quality of SCREENSHOT_QUALITIES) {
        const result = (await client.sendCommand("Page.captureScreenshot", {
          format: "jpeg",
          quality,
          fromSurface: false,
          ...(scale === undefined || viewportWidth === undefined || viewportHeight === undefined
            ? {}
            : { clip: { x: 0, y: 0, width: viewportWidth, height: viewportHeight, scale } }),
        })) as { readonly data?: string };
        const data = typeof result.data === "string" ? result.data : "";
        if (data === "") return undefined;
        const dataUrl = jpegDataUrl(data);
        if (dataUrl.length <= MAX_SCREENSHOT_DATA_URL) return dataUrl;
      }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (!ours && client.isAttached()) client.detach();
  }
}
