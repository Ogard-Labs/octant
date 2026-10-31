import { NativeSessionRuntimePool, type RetainedNativeRuntime } from "./nativeSessionRuntimePool";
import {
  decodeProviderObservedState,
  decodeProviderFailure,
  type ProviderInstanceId,
  type ProviderModelId,
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
  readonly observeAcquireMs?: (durationMs: number, kind: "started" | "reused") => void;
}

export interface ProviderRuntimeAcquireOptions<T> {
  readonly idleMs: number;
  /**
   * Separates processes on one instance that carry different authority, such
   * as one root under one posture. Without it the instance has one runtime.
   * A leased runtime's own exit is its holder's to observe: it does not end
   * the instance's other runtimes or clear what the instance was observed to be.
   */
  readonly lease?: string;
  readonly start: (
    onProcessStarted?: ProviderProcessStartedListener,
  ) => Promise<ProviderRuntimeResource<T>>;
}

/**
 * The registry as a provider driver holds it. The Verify tools record is the
 * host's: a driver that could write it would admit Octant's tools for a model
 * no person verified, so the record's writer is left out.
 */
export type ProviderDriverRuntimeRegistry = Omit<ProviderRuntimeRegistry, "setVerifiedToolModels">;

export function trackProviderProcess<
  T extends { readonly pid: number; readonly exited: Promise<void> },
>(
  registry: ProviderDriverRuntimeRegistry,
  instanceId: ProviderInstanceId,
  process: T,
): Effect.Effect<T, ProviderFailure> {
  if (typeof (registry as Partial<ProviderDriverRuntimeRegistry>).trackProcess !== "function") {
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
  readonly instanceId: ProviderInstanceId;
  readonly key: string;
  readonly lease: string | undefined;
  readonly resource: Promise<ProviderRuntimeResource<T>>;
  refs: number;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** Release order, so the lease idle longest is the first one closed. */
  idleSince?: number;
  closing?: Promise<void>;
}

/**
 * Idle leased runtimes kept per instance. A Codex lease measured about 100 MB
 * resident (launcher and app-server) on macOS 27, so an instance whose threads
 * span many roots keeps the most recently used few warm for the next turn and
 * closes the rest rather than holding one process per root until each idles out.
 */
const IDLE_LEASES_PER_INSTANCE = 3;

function runtimeKey(instanceId: ProviderInstanceId, lease: string | undefined): string {
  return lease === undefined ? String(instanceId) : `${String(instanceId)}\u0000${lease}`;
}

export class ProviderRuntimeInvalidationRejected extends Error {
  override readonly name = "ProviderRuntimeInvalidationRejected";
}

export class ProviderExecutableUpdateRejected extends Error {
  override readonly name = "ProviderExecutableUpdateRejected";
}

export class ProviderRuntimeRegistry {
  readonly #receiptDirectory: string | undefined;
  readonly #processIdentity: ((pid: number) => Promise<string | undefined>) | undefined;
  readonly #processGroupExists: (pid: number) => Promise<boolean> | boolean;
  readonly #killProcessGroup: ((pid: number, signal: NodeJS.Signals) => void) | undefined;
  readonly #shutdownTimeoutMs: number;
  readonly #observeAcquireMs:
    | ((durationMs: number, kind: "started" | "reused") => void)
    | undefined;
  readonly #observedByInstance = new Map<ProviderInstanceId, ProviderObservedState>();
  readonly #verifiedToolModelsByInstance = new Map<
    ProviderInstanceId,
    ReadonlyArray<ProviderModelId>
  >();
  readonly #activeSessionsByInstance = new Map<ProviderInstanceId, number>();
  readonly #compatibleProtocols = new Map<ProviderInstanceId, CompatibleProtocol>();
  readonly #runtimes = new Map<string, RuntimeEntry>();
  #idleSequence = 0;
  readonly #idleNativeSessions = new NativeSessionRuntimePool();
  #closed = false;
  readonly #nativeSessionShutdown = new Map<symbol, () => Promise<void>>();
  readonly #nativeSessions = new Map<ProviderInstanceId, Map<string, symbol>>();
  readonly #invalidationListeners = new Map<ProviderInstanceId, Set<() => void>>();
  readonly #updatingByExecutable = new Map<string, ReadonlySet<string>>();
  readonly #executableByInstance = new Map<string, string>();

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

  /**
   * Replaces what the instance was last observed to be. The Verify tools
   * record is never taken from the value: drivers and probes write here, and a
   * driver that claimed a model verified would otherwise widen tool admission
   * for it. The host's own record is kept across the replacement instead.
   */
  setObservedState(value: unknown): ProviderObservedState {
    return this.#storeObservedState(decodeProviderObservedState(value));
  }

  /**
   * Records which models a host-run Verify tools proved, either just now or as
   * restored from the persisted catalog. Only the provider service and Chat's
   * restore after a restart call this. Without an observation to attach it to
   * nothing is recorded, so a record cannot outlive a cleared observation.
   */
  setVerifiedToolModels(
    instanceId: ProviderInstanceId,
    modelIds: ReadonlyArray<ProviderModelId>,
  ): ProviderObservedState | undefined {
    const current = this.#observedByInstance.get(instanceId);
    if (current === undefined) return undefined;
    this.#verifiedToolModelsByInstance.set(instanceId, [...modelIds]);
    return this.#storeObservedState(current);
  }

  clearObservedState(instanceId: ProviderInstanceId): void {
    this.#observedByInstance.delete(instanceId);
    this.#verifiedToolModelsByInstance.delete(instanceId);
  }

  #storeObservedState(value: ProviderObservedState): ProviderObservedState {
    const { verifiedToolModelIds: _notTheHostRecord, ...observed } = value;
    const verified = this.#verifiedToolModelsByInstance.get(observed.instanceId);
    const stored: ProviderObservedState =
      verified === undefined ? observed : { ...observed, verifiedToolModelIds: verified };
    this.#observedByInstance.set(stored.instanceId, stored);
    return stored;
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
    if (count > 0 && this.executableUpdateInProgress(instanceId)) {
      throw new ProviderExecutableUpdateRejected("Stop the CLI update before starting a session.");
    }
    if (count === 0) this.#activeSessionsByInstance.delete(instanceId);
    else this.#activeSessionsByInstance.set(instanceId, count);
  }

  takeNativeSessionRuntime<T>(
    instanceId: ProviderInstanceId,
    identity: string,
    compatibility: string,
  ): Promise<RetainedNativeRuntime<T> | undefined> {
    if (this.executableUpdateInProgress(instanceId)) return Promise.resolve(undefined);
    return this.#idleNativeSessions.take(instanceId, identity, compatibility);
  }

  retainNativeSessionRuntime<T>(
    instanceId: ProviderInstanceId,
    identity: string,
    resource: RetainedNativeRuntime<T>,
  ): Promise<void> {
    return this.#idleNativeSessions.retain(instanceId, identity, resource);
  }

  #hasLeasedNativeSession(instanceId: ProviderInstanceId): boolean {
    return [...(this.#nativeSessions.get(instanceId)?.keys() ?? [])].some(
      (identity) => !this.#idleNativeSessions.has(instanceId, identity),
    );
  }

  claimNativeSession(
    instanceId: ProviderInstanceId,
    nativeIdentity: string,
  ):
    | {
        readonly status: "claimed";
        readonly release: () => void;
        readonly onShutdown: (cleanup: () => Promise<void>) => void;
      }
    | { readonly status: "refused"; readonly failure: ProviderFailure } {
    if (this.#closed || this.executableUpdateInProgress(instanceId)) {
      return {
        status: "refused",
        failure: {
          category: "unavailable",
          message: "Stop the CLI update before starting a session.",
        },
      };
    }
    const sessions = this.#nativeSessions.get(instanceId) ?? new Map<string, symbol>();
    if (sessions.has(nativeIdentity)) {
      return {
        status: "refused",
        failure: {
          category: "protocol",
          message: "The native session already has an active owner.",
        },
      };
    }
    const owner = Symbol();
    sessions.set(nativeIdentity, owner);
    this.#nativeSessions.set(instanceId, sessions);
    return {
      status: "claimed",
      onShutdown: (cleanup) => {
        if (sessions.get(nativeIdentity) === owner) this.#nativeSessionShutdown.set(owner, cleanup);
      },
      release: () => {
        if (sessions.get(nativeIdentity) !== owner) return;
        sessions.delete(nativeIdentity);
        this.#nativeSessionShutdown.delete(owner);
        if (sessions.size === 0 && this.#nativeSessions.get(instanceId) === sessions) {
          this.#nativeSessions.delete(instanceId);
        }
      },
    };
  }

  claimExecutableUpdate(
    executableKey: string,
    instanceIds: ReadonlyArray<ProviderInstanceId>,
  ): void {
    if (this.#updatingByExecutable.has(executableKey)) {
      throw new ProviderExecutableUpdateRejected(
        "A CLI update is already running for this executable.",
      );
    }
    for (const instanceId of instanceIds) {
      if (this.activeSessionCount(instanceId) !== 0 || this.#hasLeasedNativeSession(instanceId)) {
        throw new ProviderRuntimeInvalidationRejected(
          "Stop active sessions before updating this provider CLI.",
        );
      }
    }
    const claimed = new Set(instanceIds.map((instanceId) => String(instanceId)));
    this.#updatingByExecutable.set(executableKey, claimed);
    for (const instanceId of claimed) this.#executableByInstance.set(instanceId, executableKey);
  }

  releaseExecutableUpdate(executableKey: string): void {
    const claimed = this.#updatingByExecutable.get(executableKey);
    this.#updatingByExecutable.delete(executableKey);
    if (claimed === undefined) return;
    for (const instanceId of claimed) {
      if (this.#executableByInstance.get(instanceId) === executableKey) {
        this.#executableByInstance.delete(instanceId);
      }
    }
  }

  executableUpdateInProgress(instanceId: ProviderInstanceId): boolean {
    return this.#executableByInstance.has(String(instanceId));
  }

  acquireRuntime<T>(
    instanceId: ProviderInstanceId,
    options: ProviderRuntimeAcquireOptions<T>,
  ): Effect.Effect<T, ProviderFailure, import("effect").Scope.Scope> {
    let acquired: RuntimeEntry<T> | undefined;
    const acquire = Effect.tryPromise({
      try: async () => {
        if (this.executableUpdateInProgress(instanceId)) {
          throw {
            category: "unavailable",
            message: "Stop the CLI update before starting a session.",
          } satisfies ProviderFailure;
        }
        const startedAt = performance.now();
        let createdRuntimeEntry = false;
        const key = runtimeKey(instanceId, options.lease);
        let entry = this.#runtimes.get(key) as RuntimeEntry<T> | undefined;
        if (entry === undefined) {
          createdRuntimeEntry = true;
          entry = {
            instanceId,
            key,
            lease: options.lease,
            refs: 0,
            resource: options
              .start((process) => this.trackProcess(instanceId, process))
              .then((resource) => this.#trackResource(instanceId, resource)),
            idleTimer: undefined,
          };
          const created = entry;
          this.#runtimes.set(key, created as RuntimeEntry);
          void created.resource.then(
            (resource) => {
              if (resource.exited !== undefined) {
                void resource.exited.then(
                  () => this.#invalidateUnexpectedExit(created),
                  () => this.#invalidateUnexpectedExit(created),
                );
              }
            },
            () => {
              if (this.#runtimes.get(key) === created) this.#runtimes.delete(key);
            },
          );
        }
        if (entry.idleTimer !== undefined) {
          clearTimeout(entry.idleTimer);
          entry.idleTimer = undefined;
        }
        delete entry.idleSince;
        entry.refs += 1;
        acquired = entry;
        const value = (await entry.resource).value;
        try {
          this.#observeAcquireMs?.(
            performance.now() - startedAt,
            createdRuntimeEntry ? "started" : "reused",
          );
        } catch {
          // Operational observations must not change a successful acquire.
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
        if (entry.refs !== 0 || this.#runtimes.get(entry.key) !== entry) return;
        if (options.idleMs === 0) await this.#closeEntry(entry);
        else {
          entry.idleSince = ++this.#idleSequence;
          entry.idleTimer = setTimeout(() => {
            // Idle cleanup is recoverable through the persisted process receipt.
            // Observe a failed close so it cannot become an unhandled rejection
            // or surface as a native main-process dialog.
            void this.#closeEntry(entry).catch(() => undefined);
          }, options.idleMs);
          if (entry.lease !== undefined) this.#closeIdleLeasesBeyondLimit(instanceId);
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

  /**
   * Closes one leased runtime now when nothing holds it, instead of after its
   * idle delay. A runtime a connection still holds is left running, so no
   * other session loses its process.
   */
  async closeIdleLease(
    instanceId: ProviderInstanceId,
    lease: string,
  ): Promise<"closed" | "held" | "absent"> {
    const entry = this.#runtimes.get(runtimeKey(instanceId, lease));
    if (entry === undefined) return "absent";
    if (entry.refs !== 0) return "held";
    await this.#closeEntry(entry);
    return "closed";
  }

  hasRuntime(instanceId: ProviderInstanceId): boolean {
    return this.#entriesOf(instanceId).length > 0;
  }

  #entriesOf(instanceId: ProviderInstanceId): ReadonlyArray<RuntimeEntry> {
    return [...this.#runtimes.values()].filter(
      (entry) => String(entry.instanceId) === String(instanceId),
    );
  }

  #closeIdleLeasesBeyondLimit(instanceId: ProviderInstanceId): void {
    const idle = this.#entriesOf(instanceId)
      .filter(
        (entry) => entry.lease !== undefined && entry.refs === 0 && entry.idleSince !== undefined,
      )
      .sort((left, right) => (right.idleSince ?? 0) - (left.idleSince ?? 0));
    for (const entry of idle.slice(IDLE_LEASES_PER_INSTANCE)) {
      void this.#closeEntry(entry).catch(() => undefined);
    }
  }

  async invalidateRuntime(instanceId: ProviderInstanceId): Promise<void> {
    if (this.activeSessionCount(instanceId) !== 0 || this.#hasLeasedNativeSession(instanceId)) {
      throw new ProviderRuntimeInvalidationRejected(
        "Stop active sessions before changing this provider runtime.",
      );
    }
    try {
      await Promise.all(this.#entriesOf(instanceId).map((entry) => this.#closeEntry(entry)));
      await this.#idleNativeSessions.invalidate(instanceId);
    } finally {
      this.clearObservedState(instanceId);
      this.clearCompatibleProtocol(instanceId);
      for (const listener of this.#invalidationListeners.get(instanceId) ?? []) listener();
    }
  }

  async closeAll(): Promise<void> {
    this.#closed = true;
    const results = await Promise.allSettled([
      this.#idleNativeSessions.close(),
      ...[...this.#nativeSessionShutdown.values()].map((cleanup) =>
        Promise.resolve().then(cleanup),
      ),
      ...[...this.#runtimes.values()].map((entry) => this.#closeEntry(entry)),
    ]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
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

  async #closeEntry(entry: RuntimeEntry): Promise<void> {
    if (entry.closing !== undefined) return entry.closing;
    if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
    if (this.#runtimes.get(entry.key) === entry) this.#runtimes.delete(entry.key);
    entry.closing = entry.resource.then((resource) => resource.close());
    return entry.closing;
  }

  #invalidateUnexpectedExit(entry: RuntimeEntry): void {
    if (this.#runtimes.get(entry.key) !== entry || entry.closing !== undefined) return;
    this.#runtimes.delete(entry.key);
    if (entry.lease === undefined) {
      this.clearObservedState(entry.instanceId);
      this.clearCompatibleProtocol(entry.instanceId);
      for (const listener of this.#invalidationListeners.get(entry.instanceId) ?? []) listener();
    }
    void this.#closeEntry(entry).catch(() => undefined);
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
