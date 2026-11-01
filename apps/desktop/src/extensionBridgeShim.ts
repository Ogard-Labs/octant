/** The global an extension's page or worker sees; only `chrome` matters here. */
export type ExtensionBridgeScope = object;

/** Where a toolbar click on an extension with no popup page arrives. */
export interface ExtensionActionSource {
  on(listener: (tab: unknown) => void): void;
}

type Settle = (value?: unknown) => void;

/**
 * Gives an extension the part of `chrome.tabs` a popup needs and the
 * `chrome.action.onClicked` event, both answered by the Octant desktop app.
 *
 * The function is self-contained on purpose: the frame preload sends its source
 * text into the page's main world, where nothing it imports would exist, so it
 * may touch only its arguments and the standard globals. A test runs it from its
 * source text to keep that true.
 *
 * `chrome.tabs` is replaced, not extended. Only `query`, `get`, `create`,
 * `update` and `sendMessage` exist afterwards; any other call is a missing
 * function, which is how the extension sees every other unsupported API.
 * `sendMessage` asks the app whether the tab is one of this profile's pages and
 * only then lets the runtime's own messaging deliver, so a tab outside the
 * profile is refused here rather than reached.
 */
export function installExtensionBridge(
  scope: ExtensionBridgeScope,
  call: (method: string, args: ReadonlyArray<unknown>) => Promise<unknown>,
  actionSource: ExtensionActionSource | undefined,
): void {
  const root = (scope as { chrome?: Record<string, unknown> }).chrome;
  if (typeof root !== "object" || root === null) return;

  const nativeTabs = root.tabs as Record<string, unknown> | undefined;
  const nativeSend =
    typeof nativeTabs?.sendMessage === "function"
      ? (nativeTabs.sendMessage as (...args: unknown[]) => Promise<unknown>).bind(nativeTabs)
      : undefined;

  // A call takes a callback or returns a promise, as the extension API does.
  const settle = (promise: Promise<unknown>, callback: Settle | undefined): unknown => {
    if (callback === undefined) return promise;
    promise.then(
      (value) => callback(value),
      (error: unknown) => {
        const runtime = root.runtime as Record<string, unknown> | undefined;
        const message = error instanceof Error ? error.message : String(error);
        if (runtime !== undefined) runtime.lastError = { message };
        try {
          callback();
        } finally {
          if (runtime !== undefined) runtime.lastError = undefined;
        }
      },
    );
    return undefined;
  };
  const split = (args: ReadonlyArray<unknown>): [ReadonlyArray<unknown>, Settle | undefined] => {
    const last = args[args.length - 1];
    return typeof last === "function" ? [args.slice(0, -1), last as Settle] : [args, undefined];
  };
  const forward = (method: string) => {
    return (...args: unknown[]): unknown => {
      const [params, callback] = split(args);
      return settle(call(method, params), callback);
    };
  };

  const tabs = {
    query: forward("query"),
    get: forward("get"),
    create: forward("create"),
    update: forward("update"),
    sendMessage: (...args: unknown[]): unknown => {
      const [params, callback] = split(args);
      const sent =
        nativeSend === undefined
          ? Promise.reject(new Error("chrome.tabs.sendMessage is not supported here."))
          : call("authorize", [params[0]]).then(() => nativeSend(...params));
      return settle(sent, callback);
    },
  };
  try {
    Object.defineProperty(root, "tabs", { value: Object.freeze(tabs), configurable: true });
  } catch {
    // A runtime that locks `chrome.tabs` keeps its own, which fails as before.
  }

  if (actionSource === undefined) return;
  const listeners: Array<(tab: unknown) => void> = [];
  const waiting: unknown[] = [];
  const deliver = (tab: unknown): void => {
    for (const listener of listeners.slice()) {
      try {
        listener(tab);
      } catch {
        // One extension listener failing must not stop the next.
      }
    }
  };
  const onClicked = {
    addListener: (listener: (tab: unknown) => void): void => {
      if (typeof listener !== "function" || listeners.includes(listener)) return;
      listeners.push(listener);
      for (const tab of waiting.splice(0)) deliver(tab);
    },
    removeListener: (listener: (tab: unknown) => void): void => {
      const index = listeners.indexOf(listener);
      if (index !== -1) listeners.splice(index, 1);
    },
    hasListener: (listener: (tab: unknown) => void): boolean => listeners.includes(listener),
  };
  const existing = root.action as Record<string, unknown> | undefined;
  const action = typeof existing === "object" && existing !== null ? existing : {};
  try {
    Object.defineProperty(action, "onClicked", { value: onClicked, configurable: true });
    if (action !== existing) {
      Object.defineProperty(root, "action", { value: action, configurable: true });
    }
  } catch {
    return;
  }
  // The click can arrive while the worker is still starting and before its
  // script has added a listener, so a click is held briefly instead of lost.
  actionSource.on((tab) => {
    if (listeners.length > 0) return deliver(tab);
    waiting.push(tab);
    setTimeout(() => {
      const index = waiting.indexOf(tab);
      if (index !== -1) waiting.splice(index, 1);
    }, 5_000);
  });
}
