import type { BrowserContextId } from "@octant/contracts/browser-automation";
import { BrowserProfileUnavailableError, type BrowserRuntimePort } from "./browserRuntimePort";
import { DesktopBrowserOwnerUnavailable } from "./desktopBrowserRuntime";

export class RoutingBrowserRuntime implements BrowserRuntimePort {
  readonly #native: BrowserRuntimePort;
  readonly #headless: BrowserRuntimePort;
  readonly #backend = new Map<BrowserContextId, BrowserRuntimePort>();

  constructor(options: {
    readonly native: BrowserRuntimePort;
    readonly headless: BrowserRuntimePort;
  }) {
    this.#native = options.native;
    this.#headless = options.headless;
  }

  async available(): Promise<boolean> {
    return (await this.#native.available()) || (await this.#headless.available());
  }

  async nativeAvailable(): Promise<boolean> {
    return this.#native.available();
  }

  get profiles(): BrowserRuntimePort["profiles"] {
    return this.#native.profiles;
  }

  async createContext(
    ...args: Parameters<BrowserRuntimePort["createContext"]>
  ): ReturnType<BrowserRuntimePort["createContext"]> {
    const [contextId, policy] = args;
    // A stored profile has one store, and the desktop app keeps it. Falling back
    // to a headless page would open a copy with different cookies, so a profile
    // page opens natively or not at all.
    if (policy.profile !== undefined && policy.profile.kind !== "private") {
      if (!(await this.#native.available())) throw new BrowserProfileUnavailableError();
      try {
        const presentation = await this.#native.createContext(...args);
        this.#backend.set(contextId, this.#native);
        return presentation;
      } catch (error) {
        if (error instanceof DesktopBrowserOwnerUnavailable) {
          throw new BrowserProfileUnavailableError();
        }
        throw error;
      }
    }
    if (!(await this.#native.available())) {
      const presentation = await this.#headless.createContext(...args);
      this.#backend.set(contextId, this.#headless);
      return presentation;
    }
    try {
      const presentation = await this.#native.createContext(...args);
      this.#backend.set(contextId, this.#native);
      return presentation;
    } catch (error) {
      if (!(error instanceof DesktopBrowserOwnerUnavailable)) throw error;
      const presentation = await this.#headless.createContext(...args);
      this.#backend.set(contextId, this.#headless);
      return presentation;
    }
  }

  inspectTarget(...args: Parameters<BrowserRuntimePort["inspectTarget"]>) {
    return this.#owned(args[0]).inspectTarget(...args);
  }

  act(...args: Parameters<BrowserRuntimePort["act"]>) {
    return this.#owned(args[0]).act(...args);
  }

  /** A peek goes to whichever backend holds the page; one without a peek offers none. */
  async peek(...args: Parameters<NonNullable<BrowserRuntimePort["peek"]>>) {
    const backend = this.#owned(args[0]);
    if (backend.peek === undefined)
      throw new Error("This Browser runtime cannot picture its page.");
    return backend.peek(...args);
  }

  async closeContext(contextId: BrowserContextId): Promise<void> {
    const runtime = this.#backend.get(contextId);
    this.#backend.delete(contextId);
    await runtime?.closeContext(contextId);
  }

  async closeAll(): Promise<void> {
    this.#backend.clear();
    await Promise.all([this.#native.closeAll(), this.#headless.closeAll()]);
  }

  async reconcile(): Promise<void> {
    await Promise.all([this.#native.reconcile?.(), this.#headless.reconcile?.()]);
  }

  onProcessExit(listener: (contextIds?: ReadonlyArray<BrowserContextId>) => void): () => void {
    const scoped = (
      runtime: BrowserRuntimePort,
      contextIds: ReadonlyArray<BrowserContextId> | undefined,
    ) => {
      const owned = [...this.#backend.entries()]
        .filter(
          ([contextId, backend]) =>
            backend === runtime && (contextIds === undefined || contextIds.includes(contextId)),
        )
        .map(([contextId]) => contextId);
      if (owned.length > 0) listener(owned);
    };
    const removeNative = this.#native.onProcessExit?.((contextIds) =>
      scoped(this.#native, contextIds),
    );
    const removeHeadless = this.#headless.onProcessExit?.((contextIds) =>
      scoped(this.#headless, contextIds),
    );
    return () => {
      removeNative?.();
      removeHeadless?.();
    };
  }

  #owned(contextId: BrowserContextId): BrowserRuntimePort {
    const runtime = this.#backend.get(contextId);
    if (runtime === undefined) throw new Error("Browser context is stale or unknown.");
    return runtime;
  }
}
