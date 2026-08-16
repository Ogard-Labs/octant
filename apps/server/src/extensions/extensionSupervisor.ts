import { isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";
import type {
  ExtensionSupervisorPort,
  ExtensionSupervisorReceipt,
} from "./extensionLifecycleService";

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_COMPONENTS = 32;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_CRASH_RESTARTS = 2;
const DEFAULT_CRASH_WINDOW_MS = 60_000;

export type ExtensionRuntimeState =
  | "starting"
  | "ready"
  | "stopping"
  | "stopped"
  | "disable-pending"
  | "crashed"
  | "quarantined";

export interface ExtensionProcessExit {
  readonly code: number | null;
  readonly signal: string | null;
}

export interface ExtensionProcessHandle {
  readonly pid: number;
  readonly ready: Promise<void>;
  readonly wait: Promise<ExtensionProcessExit>;
  readonly stop: () => Promise<void>;
  readonly cancel?: () => Promise<void>;
  readonly stdin?: Writable;
  readonly stdout?: Readable;
  readonly stderr?: Readable;
  once(event: "exit", listener: (exit: ExtensionProcessExit) => void): unknown;
}

export interface ExtensionProcessStartInput {
  readonly extensionId: string;
  readonly packageId: string;
  readonly componentId: string;
  readonly version: string;
  readonly digest: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly maxOutputBytes: number;
  readonly signal: AbortSignal;
  readonly readiness?: "handshake" | "spawn";
  readonly sandbox?: ExtensionProcessSandbox;
}

export interface ExtensionProcessSandbox {
  readonly kind: "macos-seatbelt";
  readonly scope: {
    readonly hostId: string;
    readonly mode: "chat" | "work" | "code";
    readonly projectId: string | null;
    readonly threadId: string | null;
    readonly providerFamily: string;
  };
  readonly allowRead: ReadonlyArray<string>;
  readonly allowWrite: ReadonlyArray<string>;
  readonly allowNetwork: boolean;
}

export interface ExtensionProcessReceipt {
  readonly extensionId: string;
  readonly packageId: string;
  readonly componentId: string;
  readonly version: string;
  readonly digest: string;
  readonly state: "running" | "uncertain";
  readonly stop?: () => Promise<void>;
  readonly remove?: () => Promise<void>;
}

export interface ExtensionProcessPort {
  readonly start: (input: ExtensionProcessStartInput) => Promise<ExtensionProcessHandle>;
  readonly receipts: () => Promise<ReadonlyArray<ExtensionProcessReceipt>>;
}

export interface ExtensionRuntimeStartInput {
  readonly extensionId: string;
  readonly packageId: string;
  readonly componentId: string;
  readonly version: string;
  readonly digest: string;
  readonly entryPoint: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly effective: boolean;
  readonly blockReason?: string;
  readonly approved: boolean;
  readonly authority: { readonly kind: "trusted-extension"; readonly extensionId: string };
  readonly readiness?: "handshake" | "spawn";
  readonly sandbox?: ExtensionProcessSandbox;
}

export interface ExtensionRuntimeEvidence {
  readonly kind: "extension-runtime";
  readonly extensionId: string;
  readonly packageId: string;
  readonly componentId: string;
  readonly version: string;
  readonly digest: string;
  readonly state: ExtensionRuntimeState;
  readonly observedAt: string;
  readonly reason?:
    | "admission-blocked"
    | "startup-failed"
    | "startup-timeout"
    | "cancelled"
    | "drain-timeout"
    | "process-crashed"
    | "crash-loop"
    | "restart-reconciled";
}

export class ExtensionSupervisorError extends Error {
  override readonly name = "ExtensionSupervisorError";

  constructor(
    readonly category:
      | "invalid"
      | "blocked"
      | "conflict"
      | "unavailable"
      | "interrupted"
      | "waiting"
      | "failed",
    message: string,
  ) {
    super(message);
  }
}

export interface ExtensionSupervisorOptions {
  readonly process: ExtensionProcessPort;
  readonly clock: () => string;
  readonly authorizeLaunch: (
    input: ExtensionRuntimeStartInput,
    signal: AbortSignal,
  ) => Promise<boolean>;
  readonly evidence?: (event: ExtensionRuntimeEvidence) => void;
  readonly limits?: Partial<{
    readonly maxOutputBytes: number;
    readonly maxComponents: number;
    readonly startupTimeoutMs: number;
    readonly drainTimeoutMs: number;
    readonly maxCrashRestarts: number;
    readonly crashWindowMs: number;
  }>;
}

interface RuntimeRecord {
  readonly input: ExtensionRuntimeStartInput;
  process: ExtensionProcessHandle | undefined;
  acquisition: Promise<ExtensionProcessHandle> | undefined;
  cleanup: Promise<void> | undefined;
  state: ExtensionRuntimeState;
  crashTimes: number[];
  generation: number;
  controller: AbortController | undefined;
}

export class ExtensionSupervisor implements ExtensionSupervisorPort {
  readonly #process: ExtensionProcessPort;
  readonly #clock: () => string;
  readonly #authorizeLaunch: (
    input: ExtensionRuntimeStartInput,
    signal: AbortSignal,
  ) => Promise<boolean>;
  readonly #evidence: ((event: ExtensionRuntimeEvidence) => void) | undefined;
  readonly #maxOutputBytes: number;
  readonly #maxComponents: number;
  readonly #startupTimeoutMs: number;
  readonly #drainTimeoutMs: number;
  readonly #maxCrashRestarts: number;
  readonly #crashWindowMs: number;
  readonly #runtimes = new Map<string, RuntimeRecord>();
  readonly #blockedExtensions = new Set<string>();
  readonly #generationByExtension = new Map<string, number>();

  constructor(options: ExtensionSupervisorOptions) {
    this.#process = options.process;
    this.#clock = options.clock;
    this.#authorizeLaunch = options.authorizeLaunch;
    this.#evidence = options.evidence;
    this.#maxOutputBytes = boundedLimit(options.limits?.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES);
    this.#maxComponents = boundedLimit(options.limits?.maxComponents, DEFAULT_MAX_COMPONENTS);
    this.#startupTimeoutMs = boundedLimit(
      options.limits?.startupTimeoutMs,
      DEFAULT_STARTUP_TIMEOUT_MS,
    );
    this.#drainTimeoutMs = boundedLimit(options.limits?.drainTimeoutMs, DEFAULT_DRAIN_TIMEOUT_MS);
    this.#maxCrashRestarts = boundedLimit(
      options.limits?.maxCrashRestarts,
      DEFAULT_MAX_CRASH_RESTARTS,
    );
    this.#crashWindowMs = boundedLimit(options.limits?.crashWindowMs, DEFAULT_CRASH_WINDOW_MS);
  }

  async start(input: ExtensionRuntimeStartInput, signal = new AbortController().signal) {
    this.#assertAdmission(input);
    const key = runtimeKey(input);
    let existing = this.#runtimes.get(key);
    if (existing !== undefined && !sameIdentity(existing.input, input)) {
      if (existing.state === "stopped") {
        this.#runtimes.delete(key);
        existing = undefined;
      } else {
        throw new ExtensionSupervisorError(
          "conflict",
          "A different extension package identity already owns this runtime key.",
        );
      }
    }
    if (existing?.state === "quarantined") {
      throw new ExtensionSupervisorError("blocked", "Extension component is quarantined.");
    }
    if (existing !== undefined && existing.state !== "stopped" && existing.state !== "crashed") {
      return this.#receipt(existing);
    }
    const restartingKey = existing?.state === "crashed" ? key : undefined;
    if (this.#activeCount(restartingKey) >= this.#maxComponents) {
      throw new ExtensionSupervisorError("unavailable", "Extension runtime capacity is exhausted.");
    }
    const generation = this.#generationByExtension.get(input.extensionId) ?? 0;
    const controller = new AbortController();
    const unlinkCallerSignal = linkAbortSignal(signal, controller);
    const record: RuntimeRecord = existing ?? {
      input,
      process: undefined,
      acquisition: undefined,
      cleanup: undefined,
      state: "starting",
      crashTimes: [],
      generation,
      controller,
    };
    record.generation = generation;
    record.controller = controller;
    record.state = "starting";
    record.process = undefined;
    this.#runtimes.set(key, record);
    this.#emit(record, "starting");

    try {
      this.#assertStartActive(record, generation, controller.signal);
      const authorized = await withSignalAndTimeout(
        Promise.resolve().then(() => this.#authorizeLaunch(input, controller.signal)),
        controller.signal,
        this.#startupTimeoutMs,
        "startup-timeout",
      );
      this.#assertStartActive(record, generation, controller.signal);
      if (!authorized) {
        throw new ExtensionSupervisorError(
          "blocked",
          "Extension runtime launch is not owned by the installed package.",
        );
      }
      const processPromise = Promise.resolve().then(() =>
        this.#process.start({
          extensionId: input.extensionId,
          packageId: input.packageId,
          componentId: input.componentId,
          version: input.version,
          digest: input.digest,
          command: input.command,
          args: [...input.args],
          cwd: input.cwd,
          env: boundedEnvironment(input.env, input.extensionId, input.readiness === "spawn"),
          maxOutputBytes: this.#maxOutputBytes,
          signal: controller.signal,
          ...(input.readiness === undefined ? {} : { readiness: input.readiness }),
          ...(input.sandbox === undefined ? {} : { sandbox: input.sandbox }),
        }),
      );
      record.acquisition = processPromise;
      const process = await withSignalAndTimeout(
        processPromise,
        controller.signal,
        this.#startupTimeoutMs,
        "startup-timeout",
      ).catch((error) => {
        this.#ensureLateCleanup(record);
        throw error;
      });
      if (record.acquisition === processPromise) record.acquisition = undefined;
      record.process = process;
      process.once("exit", (exit) => void this.#handleExit(record, exit));
      await withSignalAndTimeout(
        process.ready,
        controller.signal,
        this.#startupTimeoutMs,
        "startup-timeout",
      );
      this.#assertStartActive(record, generation, controller.signal);
      record.state = "ready";
      this.#emit(record, "ready");
      return this.#receipt(record);
    } catch (error) {
      controller.abort();
      const wasDisablePending = (record.state as ExtensionRuntimeState) === "disable-pending";
      const cleanupFailed = await this.#stopProcess(record).then(
        () => false,
        () => true,
      );
      const cleanupPending =
        cleanupFailed || record.acquisition !== undefined || record.cleanup !== undefined;
      record.state = cleanupPending
        ? "disable-pending"
        : wasDisablePending
          ? "disable-pending"
          : error instanceof ExtensionSupervisorError && error.category === "interrupted"
            ? "stopped"
            : "quarantined";
      this.#emit(
        record,
        record.state,
        cleanupPending
          ? "drain-timeout"
          : error instanceof ExtensionSupervisorError && error.category === "interrupted"
            ? "cancelled"
            : error instanceof ExtensionSupervisorError && error.category === "waiting"
              ? "startup-timeout"
              : "startup-failed",
      );
      if (record.state === "stopped" && error instanceof ExtensionSupervisorError) throw error;
      if (error instanceof ExtensionSupervisorError && error.category === "interrupted") {
        throw error;
      }
      throw new ExtensionSupervisorError(
        cleanupPending ||
          (error instanceof ExtensionSupervisorError && error.category === "waiting")
          ? "waiting"
          : error instanceof ExtensionSupervisorError && error.category === "unavailable"
            ? "unavailable"
            : "failed",
        "Extension component did not become ready.",
      );
    } finally {
      unlinkCallerSignal();
    }
  }

  async startInteractive(
    input: ExtensionRuntimeStartInput,
    signal = new AbortController().signal,
  ): Promise<{
    readonly receipt: ExtensionSupervisorReceipt;
    readonly process: ExtensionProcessHandle;
  }> {
    const interactiveInput = { ...input, readiness: "spawn" as const };
    const receipt = await this.start(interactiveInput, signal);
    const record = this.#runtimes.get(runtimeKey(interactiveInput));
    if (record?.process?.stdin === undefined || record.process.stdout === undefined) {
      throw new ExtensionSupervisorError(
        "unavailable",
        "Extension runtime does not expose supervised stdio.",
      );
    }
    const owned = record.process;
    const stdin = owned.stdin;
    const stdout = owned.stdout;
    if (stdin === undefined || stdout === undefined) {
      throw new ExtensionSupervisorError(
        "unavailable",
        "Extension runtime does not expose supervised stdio.",
      );
    }
    const stop = () => this.stopInteractive(interactiveInput);
    return {
      receipt,
      process: {
        pid: owned.pid,
        ready: owned.ready,
        wait: owned.wait,
        stop,
        cancel: stop,
        stdin,
        stdout,
        ...(owned.stderr === undefined ? {} : { stderr: owned.stderr }),
        once: owned.once.bind(owned),
      },
    };
  }

  async stopInteractive(input: ExtensionRuntimeStartInput): Promise<void> {
    const key = runtimeKey(input);
    const record = this.#runtimes.get(key);
    if (record === undefined) return;
    await this.#stopOwned(record);
    record.state = "stopped";
    record.controller = undefined;
    this.#emit(record, "stopped");
    this.#runtimes.delete(key);
  }

  async blockNewActivation(extensionId: string): Promise<void> {
    const generation = (this.#generationByExtension.get(extensionId) ?? 0) + 1;
    this.#generationByExtension.set(extensionId, generation);
    this.#blockedExtensions.add(extensionId);
    for (const record of this.#runtimes.values()) {
      if (record.input.extensionId !== extensionId || record.state === "quarantined") continue;
      const wasStarting = record.state === "starting";
      record.state = "disable-pending";
      if (wasStarting) {
        record.controller?.abort();
        const cancellation = record.process?.cancel?.();
        void cancellation?.catch(() => undefined);
      }
      this.#emit(record, "disable-pending");
    }
  }

  async drain(extensionId: string): Promise<{ readonly state: "drained" | "waiting" | "broken" }> {
    const records = [...this.#runtimes.values()].filter(
      (record) =>
        record.input.extensionId === extensionId &&
        record.state !== "stopped" &&
        (record.process !== undefined || record.state === "disable-pending"),
    );
    try {
      await Promise.all(records.map((record) => this.#stopOwned(record)));
    } catch (error) {
      for (const record of records) {
        record.state = "disable-pending";
        this.#emit(
          record,
          "disable-pending",
          error instanceof ExtensionSupervisorError && error.category === "waiting"
            ? "drain-timeout"
            : "process-crashed",
        );
      }
      return {
        state:
          error instanceof ExtensionSupervisorError && error.category === "waiting"
            ? "waiting"
            : "broken",
      };
    }
    for (const record of records) {
      record.state = "stopped";
      record.process = undefined;
      record.controller = undefined;
      this.#emit(record, "stopped");
      this.#runtimes.delete(runtimeKey(record.input));
    }
    return { state: "drained" };
  }

  async unregister(extensionId: string): Promise<void> {
    const active = [...this.#runtimes.values()].some(
      (record) =>
        record.input.extensionId === extensionId &&
        record.state !== "stopped" &&
        (record.state !== "quarantined" || record.process !== undefined),
    );
    if (active)
      throw new ExtensionSupervisorError("waiting", "Extension runtime cleanup is pending.");
    for (const [key, record] of this.#runtimes) {
      if (record.input.extensionId === extensionId) this.#runtimes.delete(key);
    }
    this.#blockedExtensions.delete(extensionId);
  }

  async receipts(): Promise<ReadonlyArray<ExtensionSupervisorReceipt>> {
    return [...this.#runtimes.values()].map((record) => this.#receipt(record));
  }

  async reconcile(): Promise<void> {
    for (const receipt of await this.#process.receipts()) {
      const input = {
        extensionId: receipt.extensionId,
        packageId: receipt.packageId,
        componentId: receipt.componentId,
        version: receipt.version,
        digest: receipt.digest,
        entryPoint: "recovered",
        command: "recovered",
        args: [],
        cwd: "recovered",
        env: {},
        effective: false,
        approved: false,
        authority: { kind: "trusted-extension" as const, extensionId: receipt.extensionId },
      } satisfies ExtensionRuntimeStartInput;
      const record: RuntimeRecord = {
        input,
        process: undefined,
        acquisition: undefined,
        cleanup: undefined,
        state: "quarantined",
        crashTimes: [],
        generation: this.#generationByExtension.get(input.extensionId) ?? 0,
        controller: undefined,
      };
      this.#runtimes.set(runtimeKey(input), record);
      this.#emit(record, "quarantined", "restart-reconciled");
      if (receipt.stop === undefined) continue;
      try {
        await withTimeout(receipt.stop(), this.#drainTimeoutMs, "drain-timeout");
        await receipt.remove?.();
        this.#runtimes.delete(runtimeKey(input));
      } catch {
        record.state = "disable-pending";
        this.#emit(record, "disable-pending", "drain-timeout");
      }
    }
  }

  #assertAdmission(input: ExtensionRuntimeStartInput): void {
    if (this.#blockedExtensions.has(input.extensionId)) {
      throw new ExtensionSupervisorError(
        "blocked",
        "Extension activation is disabled pending cleanup.",
      );
    }
    if (!input.effective || !input.approved || input.authority.extensionId !== input.extensionId) {
      this.#emitInput(input, "quarantined", "admission-blocked");
      throw new ExtensionSupervisorError(
        "blocked",
        input.blockReason ?? "Extension component is not effective.",
      );
    }
    if (!isAbsolute(input.entryPoint) || !isAbsolute(input.command) || !isAbsolute(input.cwd)) {
      throw new ExtensionSupervisorError(
        "invalid",
        "Extension runtime launch metadata is invalid.",
      );
    }
    if (
      input.args.some((argument) => argument.includes("\0")) ||
      Object.keys(input.env).some((key) => key.length > 128 || key.includes("\0"))
    ) {
      throw new ExtensionSupervisorError(
        "invalid",
        "Extension runtime launch metadata is invalid.",
      );
    }
  }

  #assertStartActive(record: RuntimeRecord, generation: number, signal: AbortSignal): void {
    if (
      signal.aborted ||
      record.generation !== generation ||
      (this.#generationByExtension.get(record.input.extensionId) ?? 0) !== generation ||
      this.#blockedExtensions.has(record.input.extensionId) ||
      record.state !== "starting"
    ) {
      throw new ExtensionSupervisorError("interrupted", "Extension start was cancelled.");
    }
  }

  async #stopOwned(record: RuntimeRecord): Promise<void> {
    record.state = "stopping";
    this.#emit(record, "stopping");
    const lateCleanup = this.#ensureLateCleanup(record);
    if (lateCleanup !== undefined) {
      await withTimeout(lateCleanup, this.#drainTimeoutMs, "drain-timeout");
    }
    const process = record.process;
    if (process === undefined) return;
    const cancellation = process.cancel?.();
    void cancellation?.catch(() => undefined);
    await withTimeout(process.stop(), this.#drainTimeoutMs, "drain-timeout");
    record.process = undefined;
  }

  async #stopProcess(record: RuntimeRecord): Promise<void> {
    if (record.process === undefined) return;
    const process = record.process;
    await withTimeout(process.stop(), this.#drainTimeoutMs, "drain-timeout");
    record.process = undefined;
  }

  async #stopLateProcess(record: RuntimeRecord, process: ExtensionProcessHandle): Promise<void> {
    if (record.process === undefined) record.process = process;
    try {
      await withTimeout(process.stop(), this.#drainTimeoutMs, "drain-timeout");
    } finally {
      if (record.process === process) record.process = undefined;
    }
  }

  #ensureLateCleanup(record: RuntimeRecord): Promise<void> | undefined {
    if (record.cleanup !== undefined) return record.cleanup;
    const acquisition = record.acquisition;
    if (acquisition === undefined) return undefined;
    const cleanup = acquisition
      .then((process) => this.#stopLateProcess(record, process))
      .catch(() => undefined)
      .finally(() => {
        if (record.acquisition === acquisition) record.acquisition = undefined;
        if (record.cleanup === cleanup) record.cleanup = undefined;
      });
    record.cleanup = cleanup;
    return cleanup;
  }

  async #handleExit(record: RuntimeRecord, _exit: ExtensionProcessExit): Promise<void> {
    if (record.state === "disable-pending" || record.state === "stopped") {
      record.process = undefined;
      return;
    }
    if (record.state === "stopping") {
      record.process = undefined;
      return;
    }
    record.process = undefined;
    record.state = "crashed";
    this.#emit(record, "crashed", "process-crashed");
    const now = Date.now();
    record.crashTimes = [
      ...record.crashTimes.filter((time) => now - time <= this.#crashWindowMs),
      now,
    ];
    // An interactive MCP session owns the child stdin/stdout transport. A
    // blind supervisor restart would orphan that transport and advertise stale
    // tools. Leave it crashed so the session manager can remove and reconnect
    // it through a fresh authority reconciliation.
    if (record.input.readiness === "spawn") return;
    if (record.crashTimes.length > this.#maxCrashRestarts) {
      record.state = "quarantined";
      this.#emit(record, "quarantined", "crash-loop");
      return;
    }
    try {
      await this.start(record.input);
    } catch {
      record.state = "quarantined";
      this.#emit(record, "quarantined", "startup-failed");
    }
  }

  #activeCount(excludingKey?: string): number {
    return [...this.#runtimes.entries()].filter(
      ([key, record]) =>
        key !== excludingKey && record.state !== "stopped" && record.state !== "quarantined",
    ).length;
  }

  #receipt(record: RuntimeRecord): ExtensionSupervisorReceipt {
    return {
      extensionId: record.input.extensionId,
      packageId: record.input.packageId,
      componentId: record.input.componentId,
      state: record.state,
    };
  }

  #emit(
    record: RuntimeRecord,
    state: ExtensionRuntimeState,
    reason?: ExtensionRuntimeEvidence["reason"],
  ): void {
    try {
      const event = {
        kind: "extension-runtime" as const,
        extensionId: record.input.extensionId,
        packageId: record.input.packageId,
        componentId: record.input.componentId,
        version: record.input.version,
        digest: record.input.digest,
        state,
        observedAt: this.#clock(),
        ...(reason === undefined ? {} : { reason }),
      } satisfies ExtensionRuntimeEvidence;
      this.#evidence?.(event);
    } catch {
      // Evidence persistence cannot widen or break runtime authority.
    }
  }

  #emitInput(
    input: ExtensionRuntimeStartInput,
    state: ExtensionRuntimeState,
    reason: NonNullable<ExtensionRuntimeEvidence["reason"]>,
  ): void {
    try {
      const event = {
        kind: "extension-runtime",
        extensionId: input.extensionId,
        packageId: input.packageId,
        componentId: input.componentId,
        version: input.version,
        digest: input.digest,
        state,
        observedAt: this.#clock(),
        reason,
      } satisfies ExtensionRuntimeEvidence;
      this.#evidence?.(event);
    } catch {
      // Evidence persistence cannot widen or break runtime authority.
    }
  }
}

function runtimeKey(
  input: Pick<ExtensionRuntimeStartInput, "extensionId" | "componentId" | "sandbox">,
): string {
  return `${input.extensionId}:${input.componentId}:${sandboxScopeKey(input.sandbox)}`;
}

function sameIdentity(
  left: ExtensionRuntimeStartInput,
  right: ExtensionRuntimeStartInput,
): boolean {
  return (
    left.extensionId === right.extensionId &&
    left.packageId === right.packageId &&
    left.componentId === right.componentId &&
    left.version === right.version &&
    left.digest === right.digest &&
    sandboxScopeKey(left.sandbox) === sandboxScopeKey(right.sandbox)
  );
}

function sandboxScopeKey(sandbox: ExtensionProcessSandbox | undefined): string {
  if (sandbox === undefined) return "global";
  const { scope } = sandbox;
  return [
    scope.hostId,
    scope.mode,
    scope.projectId ?? "",
    scope.threadId ?? "",
    scope.providerFamily,
  ].join("\u0000");
}

function boundedLimit(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isSafeInteger(value) || value < 1 ? fallback : value;
}

function boundedEnvironment(
  environment: Readonly<Record<string, string>>,
  extensionId: string,
  interactive: boolean,
): Readonly<Record<string, string>> {
  if (interactive) {
    return Object.fromEntries(
      Object.entries(environment).filter(
        ([key, value]) =>
          /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) &&
          key !== "OCTANT_CREDENTIAL" &&
          !value.includes("\0"),
      ),
    );
  }
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([key, value]) =>
        key.startsWith("OCTANT_") && key !== "OCTANT_CREDENTIAL" && value === extensionId,
    ),
  );
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  reason: "startup-timeout" | "drain-timeout",
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new ExtensionSupervisorError(
                "waiting",
                reason === "startup-timeout"
                  ? "Extension runtime startup timed out."
                  : "Extension runtime drain timed out.",
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function linkAbortSignal(source: AbortSignal, target: AbortController): () => void {
  const onAbort = () => target.abort(source.reason);
  if (source.aborted) target.abort(source.reason);
  else source.addEventListener("abort", onAbort, { once: true });
  return () => source.removeEventListener("abort", onAbort);
}

async function withSignalAndTimeout<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
  reason: "startup-timeout" | "drain-timeout",
): Promise<T> {
  if (signal.aborted) {
    throw new ExtensionSupervisorError("interrupted", "Extension start was cancelled.");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      onAbort = () =>
        reject(new ExtensionSupervisorError("interrupted", "Extension start was cancelled."));
      signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(
        () =>
          reject(
            new ExtensionSupervisorError(
              "waiting",
              reason === "startup-timeout"
                ? "Extension runtime startup timed out."
                : "Extension runtime drain timed out.",
            ),
          ),
        timeoutMs,
      );
      void promise.then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}
