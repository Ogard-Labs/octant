import type {
  HumanBrowserRequest,
  HumanBrowserResult,
} from "@octant/contracts/browser-presentation";
import type { WindowId } from "@octant/contracts/shell";
import type { BrowserContextId } from "@octant/contracts/browser-automation";
import type { PersistentBrowserLeaseId } from "@octant/contracts/persistent-browser-owner";
import { BrowserProfileUnavailableError, type BrowserRuntimePort } from "./browserRuntimePort";
import { DesktopBrowserOwnerUnavailable } from "./desktopBrowserRuntime";

export class RoutingBrowserRuntime implements BrowserRuntimePort {
  readonly #native: BrowserRuntimePort;
  readonly #headless: BrowserRuntimePort;
  readonly #backend = new Map<BrowserContextId, BrowserRuntimePort>();
  readonly #executionContexts = new Map<PersistentBrowserLeaseId, BrowserContextId>();

  constructor(options: {
    readonly native: BrowserRuntimePort;
    readonly headless: BrowserRuntimePort;
  }) {
    this.#native = options.native;
    this.#headless = options.headless;
  }

  get persistentOwner(): BrowserRuntimePort["persistentOwner"] {
    const native = this.#native.persistentOwner;
    if (native === undefined) return undefined;
    return {
      status: (signal) => native.status(signal),
      configure: (enabled, signal) => native.configure(enabled, signal),
      createContext: async (...args) => {
        const created = await native.createContext(...args);
        if (created.status === "created") {
          this.#backend.set(args[0], this.#native);
          this.#executionContexts.set(created.leaseId, args[0]);
        }
        return created;
      },
      release: async (leaseId) => {
        const result = await native.release(leaseId);
        if (result === "closed") {
          const contextId = this.#executionContexts.get(leaseId);
          if (contextId !== undefined) this.#forget(contextId);
        }
        return result;
      },
    };
  }

  async humanPresentation(
    request: HumanBrowserRequest,
    windowId: WindowId,
    signal: AbortSignal,
  ): Promise<HumanBrowserResult> {
    const backend = this.#backend.get(request.contextId);
    if (backend !== this.#native || backend.humanPresentation === undefined || signal.aborted)
      return { status: "refused" };
    const result = await backend.humanPresentation(request, windowId, signal);
    return !signal.aborted && this.#backend.get(request.contextId) === backend
      ? result
      : { status: "refused" };
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

  ownerControl: NonNullable<BrowserRuntimePort["ownerControl"]> = async (command, signal) => {
    const owner = this.#owned(command.contextId);
    if (owner !== this.#native || owner.ownerControl === undefined) return { status: "refused" };
    return owner.ownerControl(command, signal);
  };

  runPageScript: NonNullable<BrowserRuntimePort["runPageScript"]> = async (command, signal) => {
    const owner = this.#owned(command.contextId);
    if (owner !== this.#native || owner.runPageScript === undefined)
      return { status: "refused", effect: "none", reason: "unavailable" };
    return owner.runPageScript(command, signal);
  };

  prepareCredentialFill: NonNullable<BrowserRuntimePort["prepareCredentialFill"]> = async (
    ...args
  ) =>
    this.#owned(args[0]).prepareCredentialFill?.(...args) ?? {
      status: "refused",
      reason: "unavailable",
    };
  validateCredentialFill: NonNullable<BrowserRuntimePort["validateCredentialFill"]> = async (
    ...args
  ) => this.#owned(args[0]).validateCredentialFill?.(...args) ?? false;
  cancelCredentialFill: NonNullable<BrowserRuntimePort["cancelCredentialFill"]> = async (
    ...args
  ) => {
    return (
      (await this.#owned(args[0]).cancelCredentialFill?.(...args)) ?? {
        status: "cancelled",
        effect: "none",
      }
    );
  };
  submitCredentialFill: NonNullable<BrowserRuntimePort["submitCredentialFill"]> = async (...args) =>
    this.#owned(args[0]).submitCredentialFill?.(...args) ?? { status: "failed", effect: "none" };

  inspectTarget(...args: Parameters<BrowserRuntimePort["inspectTarget"]>) {
    return this.#owned(args[0]).inspectTarget(...args);
  }

  act(...args: Parameters<BrowserRuntimePort["act"]>) {
    return this.#owned(args[0]).act(...args);
  }

  async describePoint(...args: Parameters<NonNullable<BrowserRuntimePort["describePoint"]>>) {
    const backend = this.#owned(args[0]);
    return (
      backend.describePoint?.(...args) ?? {
        status: "unavailable" as const,
        reason: "capture-unavailable" as const,
      }
    );
  }

  /** A peek goes to whichever backend holds the page; one without a peek offers none. */
  async peek(...args: Parameters<NonNullable<BrowserRuntimePort["peek"]>>) {
    const backend = this.#owned(args[0]);
    if (backend.peek === undefined)
      throw new Error("This Browser runtime cannot picture its page.");
    return backend.peek(...args);
  }

  claimDownload(contextId: BrowserContextId, downloadId: string): Promise<string | undefined> {
    const backend = this.#backend.get(contextId);
    return backend?.claimDownload?.(contextId, downloadId) ?? Promise.resolve(undefined);
  }

  async discardDownload(contextId: BrowserContextId, downloadId: string): Promise<void> {
    await this.#backend.get(contextId)?.discardDownload?.(contextId, downloadId);
  }

  async closeContext(contextId: BrowserContextId): Promise<void> {
    const runtime = this.#backend.get(contextId);
    await runtime?.closeContext(contextId);
    this.#forget(contextId);
  }

  async closeAll(): Promise<void> {
    this.#backend.clear();
    this.#executionContexts.clear();
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

  /** Only the desktop Browser shows the person its page directly. */
  onPersonInput(listener: (contextId: BrowserContextId) => void): () => void {
    return this.#native.onPersonInput?.(listener) ?? (() => undefined);
  }

  #owned(contextId: BrowserContextId): BrowserRuntimePort {
    const runtime = this.#backend.get(contextId);
    if (runtime === undefined) throw new Error("Browser context is stale or unknown.");
    return runtime;
  }

  #forget(contextId: BrowserContextId): void {
    this.#backend.delete(contextId);
    for (const [leaseId, held] of this.#executionContexts)
      if (String(held) === String(contextId)) this.#executionContexts.delete(leaseId);
  }
}
