import {
  decodeProviderObservedState,
  decodeProviderFailure,
  type ProviderInstanceId,
  type ProviderObservedState,
} from "@octant/contracts";
import type { ProviderFailure } from "@octant/contracts";
import { Effect } from "effect";
import type { CompatibleProtocol } from "./openAiProtocolSelection";
import {
  persistProcessReceipt,
  reconcileProcessReceipts,
  type OwnedProcessReceiptHandle,
} from "../process/nodeOwnedProcessReceipt";

export interface ProviderRuntimeResource<T> {
  readonly value: T;
  /** PID of the owned provider process, kept outside the consumer-facing value. */
  readonly pid?: number;
  /** Receipt persisted at spawn time, before provider startup/readiness completes. */
  readonly receipt?: OwnedProcessReceiptHandle;
  readonly close: () => Promise<void>;
  readonly exited?: Promise<void>;
}

export interface ProviderProcessStarted {
  readonly pid: number;
  readonly exited: Promise<void>;
}

export type ProviderProcessStartedListener = (
  process: ProviderProcessStarted,
) => Promise<OwnedProcessReceiptHandle>;

export interface ProviderRuntimeRegistryOptions {
  readonly receiptDirectory?: string;
  readonly processIdentity?: (pid: number) => Promise<string | undefined>;
  readonly processGroupExists?: (pid: number) => Promise<boolean> | boolean;
  readonly killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
  readonly shutdownTimeoutMs?: number;
  readonly observeAcquireMs?: (durationMs: number) => void;
}

export interface ProviderRuntimeAcquireOptions<T> {
  readonly idleMs: number;
  readonly start: (
    onProcessStarted?: ProviderProcessStartedListener,
  ) => Promise<ProviderRuntimeResource<T>>;
}

export function trackProviderProcess<
  T extends { readonly pid: number; readonly exited: Promise<void> },
>(
  registry: ProviderRuntimeRegistry,
  instanceId: ProviderInstanceId,
  process: T,
): Effect.Effect<T, ProviderFailure> {
  if (typeof (registry as Partial<ProviderRuntimeRegistry>).trackProcess !== "function") {
    return Effect.succeed(process);
  }
  return Effect.tryPromise({
    try: async () => {
      await registry.trackProcess(instanceId, process);
      return process;
    },
    catch: () => ({ category: "unavailable", message: "Provider process receipt is unavailable." }),
  });
}

interface RuntimeEntry<T = unknown> {
  readonly resource: Promise<ProviderRuntimeResource<T>>;
  refs: number;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  closing?: Promise<void>;
}

export class ProviderRuntimeInvalidationRejected extends Error {
  override readonly name = "ProviderRuntimeInvalidationRejected";
}

export class ProviderRuntimeRegistry {
  readonly #receiptDirectory: string | undefined;
  readonly #processIdentity: ((pid: number) => Promise<string | undefined>) | undefined;
  readonly #processGroupExists: (pid: number) => Promise<boolean> | boolean;
  readonly #killProcessGroup: ((pid: number, signal: NodeJS.Signals) => void) | undefined;
  readonly #shutdownTimeoutMs: number;
  readonly #observeAcquireMs: ((durationMs: number) => void) | undefined;
  readonly #observedByInstance = new Map<ProviderInstanceId, ProviderObservedState>();
  readonly #activeSessionsByInstance = new Map<ProviderInstanceId, number>();
  readonly #compatibleProtocols = new Map<ProviderInstanceId, CompatibleProtocol>();
  readonly #runtimes = new Map<ProviderInstanceId, RuntimeEntry>();
  readonly #invalidationListeners = new Map<ProviderInstanceId, Set<() => void>>();

  constructor(options: ProviderRuntimeRegistryOptions = {}) {
    this.#receiptDirectory = options.receiptDirectory;
    this.#processIdentity = options.processIdentity;
    this.#processGroupExists = options.processGroupExists ?? defaultProcessGroupExists;
    this.#killProcessGroup = options.killProcessGroup;
    this.#shutdownTimeoutMs = options.shutdownTimeoutMs ?? 2_000;
    this.#observeAcquireMs = options.observeAcquireMs;
  }

  observedStates(): ReadonlyArray<ProviderObservedState> {
    return [...this.#observedByInstance.values()];
  }

  observedState(instanceId: ProviderInstanceId): ProviderObservedState | undefined {
    return this.#observedByInstance.get(instanceId);
  }

  setObservedState(value: unknown): ProviderObservedState {
    const observed = decodeProviderObservedState(value);
    this.#observedByInstance.set(observed.instanceId, observed);
    return observed;
  }

  clearObservedState(instanceId: ProviderInstanceId): void {
    this.#observedByInstance.delete(instanceId);
  }

  compatibleProtocol(instanceId: ProviderInstanceId): CompatibleProtocol | undefined {
    return this.#compatibleProtocols.get(instanceId);
  }

  setCompatibleProtocol(instanceId: ProviderInstanceId, protocol: CompatibleProtocol): void {
    this.#compatibleProtocols.set(instanceId, protocol);
  }

  clearCompatibleProtocol(instanceId: ProviderInstanceId): void {
    this.#compatibleProtocols.delete(instanceId);
  }

  activeSessionCount(instanceId: ProviderInstanceId): number {
    return this.#activeSessionsByInstance.get(instanceId) ?? 0;
  }

  activeSessionTotal(): number {
    let total = 0;
    for (const count of this.#activeSessionsByInstance.values()) total += count;
    return total;
  }

  attentionRequired(): boolean {
    for (const observed of this.#observedByInstance.values()) {
      if (observed.readiness !== "ready") return true;
      if (this.activeSessionCount(observed.instanceId) > 0 && observed.processState !== "running") {
        return true;
      }
    }
    return false;
  }

  setActiveSessionCount(instanceId: ProviderInstanceId, count: number): void {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error("Provider active session count must be a non-negative integer.");
    }
    if (count === 0) this.#activeSessionsByInstance.delete(instanceId);
    else this.#activeSessionsByInstance.set(instanceId, count);
  }

  acquireRuntime<T>(
    instanceId: ProviderInstanceId,
    options: ProviderRuntimeAcquireOptions<T>,
  ): Effect.Effect<T, ProviderFailure, import("effect").Scope.Scope> {
    let acquired: RuntimeEntry<T> | undefined;
    const acquire = Effect.tryPromise({
      try: async () => {
        const startedAt = performance.now();
        let createdRuntimeEntry = false;
        let entry = this.#runtimes.get(instanceId) as RuntimeEntry<T> | undefined;
        if (entry === undefined) {
          createdRuntimeEntry = true;
          entry = {
            refs: 0,
            resource: options
              .start((process) => this.trackProcess(instanceId, process))
              .then((resource) => this.#trackResource(instanceId, resource)),
            idleTimer: undefined,
          };
          this.#runtimes.set(instanceId, entry as RuntimeEntry);
          void entry.resource.then(
            (resource) => {
              if (resource.exited !== undefined) {
                void resource.exited.then(
                  () => this.#invalidateUnexpectedExit(instanceId, entry!),
                  () => this.#invalidateUnexpectedExit(instanceId, entry!),
                );
              }
            },
            () => {
              if (this.#runtimes.get(instanceId) === entry) this.#runtimes.delete(instanceId);
            },
          );
        }
        if (entry.idleTimer !== undefined) {
          clearTimeout(entry.idleTimer);
          entry.idleTimer = undefined;
        }
        entry.refs += 1;
        acquired = entry;
        const value = (await entry.resource).value;
        if (createdRuntimeEntry) {
          try {
            this.#observeAcquireMs?.(performance.now() - startedAt);
          } catch {
            // Operational observations must not change a successful acquire.
          }
        }
        return value;
      },
      catch: (error): ProviderFailure => {
        try {
          return decodeProviderFailure(error);
        } catch {
          return { category: "unavailable", message: "Provider runtime is unavailable." };
        }
      },
    });

    return Effect.acquireRelease(acquire, () =>
      Effect.promise(async () => {
        const entry = acquired;
        if (entry === undefined || entry.refs === 0) return;
        entry.refs -= 1;
        if (entry.refs !== 0 || this.#runtimes.get(instanceId) !== entry) return;
        if (options.idleMs === 0) await this.#closeEntry(instanceId, entry);
        else {
          entry.idleTimer = setTimeout(() => {
            // Idle cleanup is recoverable through the persisted process receipt.
            // Observe a failed close so it cannot become an unhandled rejection
            // or surface as a native main-process dialog.
            void this.#closeEntry(instanceId, entry).catch(() => undefined);
          }, options.idleMs);
        }
      }),
    );
  }

  onRuntimeInvalidated(instanceId: ProviderInstanceId, listener: () => void): () => void {
    let listeners = this.#invalidationListeners.get(instanceId);
    if (listeners === undefined) {
      listeners = new Set();
      this.#invalidationListeners.set(instanceId, listeners);
    }
    listeners.add(listener);
    return () => listeners?.delete(listener);
  }

  hasRuntime(instanceId: ProviderInstanceId): boolean {
    return this.#runtimes.has(instanceId);
  }

  async invalidateRuntime(instanceId: ProviderInstanceId): Promise<void> {
    if (this.activeSessionCount(instanceId) !== 0) {
      throw new ProviderRuntimeInvalidationRejected(
        "Stop active sessions before changing this provider runtime.",
      );
    }
    const entry = this.#runtimes.get(instanceId);
    try {
      if (entry !== undefined) await this.#closeEntry(instanceId, entry);
    } finally {
      this.clearObservedState(instanceId);
      this.clearCompatibleProtocol(instanceId);
      for (const listener of this.#invalidationListeners.get(instanceId) ?? []) listener();
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all(
      [...this.#runtimes.entries()].map(([instanceId, entry]) =>
        this.#closeEntry(instanceId, entry),
      ),
    );
  }

  async reconcile(): Promise<void> {
    await reconcileProcessReceipts({
      supervisor: "provider",
      ...(this.#receiptDirectory === undefined ? {} : { receiptDirectory: this.#receiptDirectory }),
      ...(this.#processIdentity === undefined ? {} : { processIdentity: this.#processIdentity }),
      processGroupExists: this.#processGroupExists,
      ...(this.#killProcessGroup === undefined ? {} : { killProcessGroup: this.#killProcessGroup }),
      shutdownTimeoutMs: this.#shutdownTimeoutMs,
    });
  }

  /**
   * Persist a receipt for a provider process that is managed directly by a
   * provider driver rather than through acquireRuntime. The receipt is removed
   * only after the process reports that it exited and its detached process
   * group is confirmed gone; an uncertain shutdown stays recoverable on the
   * next server start.
   */
  async trackProcess(
    instanceId: string,
    process: { readonly pid: number; readonly exited: Promise<void> },
  ): Promise<OwnedProcessReceiptHandle> {
    if (!Number.isSafeInteger(process.pid) || process.pid < 1) {
      return { ready: Promise.resolve(), remove: async () => undefined };
    }
    const receipt = await persistProcessReceipt(
      {
        supervisor: "provider",
        ...(this.#receiptDirectory === undefined
          ? {}
          : { receiptDirectory: this.#receiptDirectory }),
        ...(this.#processIdentity === undefined ? {} : { processIdentity: this.#processIdentity }),
      },
      String(instanceId),
      process.pid,
    );
    await receipt.ready;
    const removeWhenReleased = async () => {
      try {
        if (await this.#waitForProcessGroupExit(process.pid)) await receipt.remove();
      } catch {
        // Keep the receipt when group ownership cannot be confirmed. Startup
        // reconciliation can safely retry it after the provider scope closes.
      }
    };
    void process.exited.then(removeWhenReleased, removeWhenReleased);
    return receipt;
  }

  async #trackResource<T>(
    instanceId: ProviderInstanceId,
    resource: ProviderRuntimeResource<T>,
  ): Promise<ProviderRuntimeResource<T>> {
    const pid = resource.pid;
    if (!Number.isSafeInteger(pid) || (pid as number) < 1) {
      return resource;
    }
    let receipt = resource.receipt;
    try {
      receipt ??= await persistProcessReceipt(
        {
          supervisor: "provider",
          ...(this.#receiptDirectory === undefined
            ? {}
            : { receiptDirectory: this.#receiptDirectory }),
          ...(this.#processIdentity === undefined
            ? {}
            : { processIdentity: this.#processIdentity }),
        },
        String(instanceId),
        pid as number,
      );
      await receipt.ready;
    } catch (error) {
      await resource.close().catch(() => undefined);
      throw error;
    }
    return {
      ...resource,
      close: async () => {
        await resource.close();
        await receipt.remove();
      },
    };
  }

  async #closeEntry(instanceId: ProviderInstanceId, entry: RuntimeEntry): Promise<void> {
    if (entry.closing !== undefined) return entry.closing;
    if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
    if (this.#runtimes.get(instanceId) === entry) this.#runtimes.delete(instanceId);
    entry.closing = entry.resource.then((resource) => resource.close());
    return entry.closing;
  }

  #invalidateUnexpectedExit(instanceId: ProviderInstanceId, entry: RuntimeEntry): void {
    if (this.#runtimes.get(instanceId) !== entry || entry.closing !== undefined) return;
    this.#runtimes.delete(instanceId);
    this.clearObservedState(instanceId);
    this.clearCompatibleProtocol(instanceId);
    for (const listener of this.#invalidationListeners.get(instanceId) ?? []) listener();
    void this.#closeEntry(instanceId, entry).catch(() => undefined);
  }

  async #waitForProcessGroupExit(pid: number): Promise<boolean> {
    if (this.#receiptDirectory === undefined) return true;
    const deadline = Date.now() + this.#shutdownTimeoutMs;
    while (await this.#processGroupExists(pid)) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return true;
  }
}

function defaultProcessGroupExists(pid: number): boolean {
  try {
    process.kill(process.platform === "win32" ? pid : -Math.abs(pid), 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}
