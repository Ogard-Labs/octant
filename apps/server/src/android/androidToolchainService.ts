import type { AndroidArtifactScope } from "./androidRuntimeStore";
import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  decodeAndroidEmulatorEvidence,
  decodeAndroidEmulatorRequest,
  sameToolActionAuthority,
  decodeAndroidEmulatorId,
  decodeAndroidEmulatorRecord,
  decodeAndroidRuntimeSnapshot,
  decodeAndroidSdkDiscovery,
  decodeAndroidSdkId,
  type AndroidActionProgress,
  type AndroidDiscoveryRequest,
  type AndroidEmulatorEvidence,
  type AndroidEmulatorRecord,
  type AndroidEmulatorRequest,
  type AndroidRuntimeSnapshot,
  type AndroidSdkDiscovery,
  type AndroidToolchainFailure,
  type ToolActionCancellation,
} from "@octant/contracts";
import {
  evaluateAndroidEmulatorRequest,
  isAndroidEmulatorInputKind,
  isAndroidEmulatorOpenInputKind,
  redactedAndroidInputDiagnostic,
  type AndroidExecutionScope,
} from "@octant/domain";

export interface AndroidProcessResult {
  readonly termination: "exited" | "cancelled" | "timed-out" | "unavailable";
  readonly exitCode: number | null;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly cleanupUncertain: boolean;
}

export interface AndroidExecutionContext extends AndroidExecutionScope {
  readonly checkoutRoot: string;
  readonly artifactRoot: string;
}

export type AndroidDiscoveryResult =
  | {
      readonly kind: "discovered";
      readonly sdk: AndroidSdkDiscovery;
      readonly emulators: ReadonlyArray<AndroidEmulatorRecord>;
    }
  | { readonly kind: "failure"; readonly failure: AndroidToolchainFailure };

export interface AndroidScreenWatch {
  readonly kind: "watching";
  readonly screen: { readonly width: number; readonly height: number };
  readonly frames: ReadableStream<Uint8Array>;
}

export interface AndroidToolchainServiceOptions {
  readonly execute: (
    input: {
      readonly argv: ReadonlyArray<string>;
      readonly cwd: string;
      readonly environment: Readonly<Record<string, string>>;
      readonly timeoutMs: number;
    },
    signal?: AbortSignal,
  ) => Promise<AndroidProcessResult>;
  /**
   * The emulator binary does not exit. Boot starts it this way and then waits
   * on adb; without this, boot is unavailable rather than hanging the action.
   */
  readonly spawnDetached?: (input: {
    readonly argv: ReadonlyArray<string>;
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>;
  }) => Promise<
    { readonly kind: "spawned" } | { readonly kind: "unavailable"; readonly message: string }
  >;
  readonly realpath: (path: string) => Promise<string>;
  readonly observeEmulators?: (emulators: ReadonlyArray<AndroidEmulatorRecord>) => void;
  readonly writeArtifact: (
    reference: string,
    bytes: Uint8Array,
    scope: AndroidArtifactScope,
  ) => Promise<void>;
  readonly readArtifact: (
    reference: string,
    scope: AndroidArtifactScope,
  ) => Promise<Uint8Array | undefined>;
  readonly now: () => string;
  readonly newId: () => string;
  readonly environment?: () => Readonly<Record<string, string | undefined>>;
  readonly access?: (path: string) => Promise<void>;
}

const MAX_RECENT = 64;
const MAX_DIAGNOSTICS = 16;
const SCREEN_POLL_MS = 400;
const MAXIMUM_FRAME_BYTES = 8 * 1024 * 1024;

export class AndroidToolchainService {
  readonly #options: AndroidToolchainServiceOptions;
  readonly #access: (path: string) => Promise<void>;
  #sequence = 0;
  #discoveryStarted = 0;
  #discoveryCommitted = 0;
  readonly #lifetime = new AbortController();
  readonly #commands = new Set<Promise<AndroidProcessResult>>();
  readonly #screenWatches = new Set<AbortController>();
  #sdk: AndroidSdkDiscovery = unavailableSdk("1970-01-01T00:00:00.000Z");
  #emulators: ReadonlyArray<AndroidEmulatorRecord> = [];
  readonly #recent: Array<{
    readonly evidence: AndroidEmulatorEvidence;
    readonly context: AndroidExecutionContext;
    readonly fingerprint: string;
  }> = [];
  readonly #active = new Map<
    string,
    {
      readonly controller: AbortController;
      readonly context: AndroidExecutionContext;
      readonly done: Promise<void>;
      readonly markDone: () => void;
      progress: AndroidActionProgress;
    }
  >();
  readonly #paneOpenRequests = new Map<
    string,
    {
      readonly requestId: string;
      readonly emulatorId: AndroidEmulatorRecord["emulatorId"];
      readonly requestedAt: string;
      readonly threadId: AndroidExecutionContext["threadId"];
      readonly checkoutId: AndroidExecutionContext["checkoutId"];
    }
  >();

  constructor(options: AndroidToolchainServiceOptions) {
    this.#options = options;
    this.#access = options.access ?? ((path) => access(path));
  }

  async discover(
    request: AndroidDiscoveryRequest,
    context: AndroidExecutionContext,
  ): Promise<AndroidDiscoveryResult> {
    if (this.#lifetime.signal.aborted) {
      return {
        kind: "failure",
        failure: { category: "unavailable", message: "The Android runtime is closed." },
      };
    }
    if (
      request.authority.extension.kind !== "core" ||
      request.authority.mode !== "code" ||
      !sameToolActionAuthority(request.authority, context.authority) ||
      request.threadId !== context.threadId ||
      request.checkoutId !== context.checkoutId
    ) {
      return {
        kind: "failure",
        failure: {
          category: "unauthorized",
          message: "Android discovery is outside this task's authority.",
        },
      };
    }
    const discovery = ++this.#discoveryStarted;
    const beforeDiscovery = new Map(
      this.#emulators.map((emulator) => [emulator.emulatorId, emulator]),
    );
    const sdk = await this.#discoverSdk();
    if (!sdk.available || sdk.emulatorPath === undefined || sdk.adbPath === undefined) {
      if (discovery > this.#discoveryCommitted) {
        this.#discoveryCommitted = discovery;
        this.#sdk = sdk;
        this.#emulators = [];
        this.#options.observeEmulators?.([]);
        this.#sequence += 1;
      }
      return this.#discoverySnapshot();
    }
    const listed = await this.#command([sdk.emulatorPath, "-list-avds"], context, 30_000);
    const names = succeeded(listed)
      ? text(listed.stdout)
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
      : [];
    const devices = await this.#command([sdk.adbPath, "devices", "-l"], context, 15_000);
    const serials = succeeded(devices) ? parseAdbDevices(text(devices.stdout)) : [];
    const emulators: AndroidEmulatorRecord[] = [];
    for (const name of names) {
      let emulatorId: AndroidEmulatorRecord["emulatorId"];
      try {
        emulatorId = decodeAndroidEmulatorId(name);
      } catch {
        continue;
      }
      const serial = await this.#serialForAvd(sdk.adbPath, name, serials, context);
      emulators.push(
        decodeAndroidEmulatorRecord({
          emulatorId,
          name,
          state: serial === undefined ? "shutdown" : "booted",
          ...(serial === undefined ? {} : { serial }),
        }),
      );
    }
    // An older result must not resurrect devices removed by a newer discovery,
    // including devices that were not yet in the snapshot when both began.
    if (discovery < this.#discoveryCommitted) return this.#discoverySnapshot();
    // A boot or shutdown may finish while these commands run.
    // Records are immutable: changed identities carry the newer state and serial.
    const reconciled = new Map(emulators.map((emulator) => [emulator.emulatorId, emulator]));
    for (const current of this.#emulators) {
      if (beforeDiscovery.get(current.emulatorId) !== current)
        reconciled.set(current.emulatorId, current);
    }
    this.#discoveryCommitted = discovery;
    this.#sdk = sdk;
    this.#emulators = [...reconciled.values()];
    this.#options.observeEmulators?.(this.#emulators);
    this.#sequence += 1;
    return this.#discoverySnapshot();
  }

  #discoverySnapshot(): AndroidDiscoveryResult {
    if (
      !this.#sdk.available ||
      this.#sdk.emulatorPath === undefined ||
      this.#sdk.adbPath === undefined
    ) {
      return {
        kind: "failure",
        failure: {
          category: "sdk-not-found",
          message:
            "The Android SDK is unavailable on this host. Install platform-tools and an emulator, then retry.",
        },
      };
    }
    return { kind: "discovered", sdk: this.#sdk, emulators: this.#emulators };
  }

  async execute(
    request: AndroidEmulatorRequest,
    context: AndroidExecutionContext,
  ): Promise<AndroidEmulatorEvidence> {
    const startedAt = this.#options.now();
    if (this.#lifetime.signal.aborted)
      return evidence(
        request,
        "unavailable",
        startedAt,
        this.#options.now(),
        [{ severity: "note", message: "The Android runtime is closed." }],
        [],
        "not-required",
      );
    const decision = evaluateAndroidEmulatorRequest(request, context, this.#emulators, this.#sdk);
    if (decision.kind === "denied") {
      return this.#record(
        deniedEvidence(request, decision.reason, startedAt, this.#options.now()),
        request,
        context,
      );
    }
    if (isAndroidEmulatorInputKind(request.kind) || isAndroidEmulatorOpenInputKind(request.kind)) {
      const prior = this.#findCompleted(request, context);
      if (prior !== undefined) return prior;
    }
    if (this.#active.has(String(request.actionId))) {
      return deniedEvidence(request, "action-already-running", startedAt, this.#options.now());
    }
    const controller = new AbortController();
    const active = this.#activate(request, controller, context);
    try {
      return this.#record(
        await this.#run(request, context, controller.signal, startedAt),
        request,
        context,
      );
    } finally {
      this.#active.delete(String(request.actionId));
      active.markDone();
    }
  }

  async cancel(
    cancellation: ToolActionCancellation,
    context: AndroidExecutionContext,
  ): Promise<boolean> {
    const active = this.#active.get(String(cancellation.actionId));
    if (
      active === undefined ||
      !androidContextMatches(active.context, context) ||
      !sameToolActionAuthority(cancellation.authority, context.authority) ||
      cancellation.correlationId !== active.progress.correlationId
    )
      return false;
    active.controller.abort();
    return true;
  }

  snapshot(context: AndroidExecutionContext): AndroidRuntimeSnapshot {
    const pane = this.#paneOpenRequests.get(String(context.threadId));
    return decodeAndroidRuntimeSnapshot({
      sequence: this.#sequence,
      snapshotAt: this.#options.now(),
      sdk: this.#sdk,
      emulators: this.#emulators,
      active: [...this.#active.values()]
        .filter((entry) => androidContextMatches(entry.context, context))
        .map((entry) => entry.progress),
      recentEvidence: this.#recent
        .filter((entry) => androidContextMatches(entry.context, context))
        .map((entry) => entry.evidence),
      ...(pane !== undefined &&
      pane.threadId === context.threadId &&
      pane.checkoutId === context.checkoutId
        ? {
            paneOpenRequest: {
              requestId: pane.requestId,
              emulatorId: pane.emulatorId,
              requestedAt: pane.requestedAt,
            },
          }
        : {}),
    });
  }

  requestPaneOpen(
    context: AndroidExecutionContext,
    emulatorId: AndroidEmulatorRecord["emulatorId"],
  ): AndroidRuntimeSnapshot {
    // Pane-open intents are transient UI hints, not task history. Keep recent
    // requests without retaining every task visited during the host lifetime.
    const threadKey = String(context.threadId);
    this.#paneOpenRequests.delete(threadKey);
    if (this.#paneOpenRequests.size >= 256) {
      const oldest = this.#paneOpenRequests.keys().next().value;
      if (oldest !== undefined) this.#paneOpenRequests.delete(oldest);
    }
    this.#paneOpenRequests.set(threadKey, {
      requestId: this.#options.newId(),
      emulatorId,
      requestedAt: this.#options.now(),
      threadId: context.threadId,
      checkoutId: context.checkoutId,
    });
    this.#sequence += 1;
    return this.snapshot(context);
  }

  async readScreenshotArtifact(
    reference: string,
    context: AndroidExecutionContext,
  ): Promise<
    | { readonly kind: "found"; readonly bytes: Uint8Array }
    | { readonly kind: "unavailable"; readonly message: string }
    | { readonly kind: "unauthorized"; readonly message: string }
  > {
    const bytes = await this.#options.readArtifact(reference, context);
    if (bytes === undefined) {
      return { kind: "unavailable", message: "That screenshot is not available." };
    }
    return { kind: "found", bytes };
  }

  async close(): Promise<void> {
    this.#lifetime.abort();
    const activeActions = [...this.#active.values()];
    for (const active of activeActions) active.controller.abort();
    for (const watch of this.#screenWatches) watch.abort();
    await Promise.allSettled([...this.#commands, ...activeActions.map(({ done }) => done)]);
    this.#screenWatches.clear();
  }

  async watchScreen(
    emulatorId: string,
    context: AndroidExecutionContext,
    signal: AbortSignal,
  ): Promise<AndroidScreenWatch | { readonly kind: "unavailable"; readonly message: string }> {
    if (this.#lifetime.signal.aborted)
      return { kind: "unavailable", message: "The Android runtime is closed." };
    const emulator = this.#emulators.find(
      (candidate) => String(candidate.emulatorId) === emulatorId,
    );
    if (emulator === undefined || emulator.state !== "booted" || emulator.serial === undefined) {
      return { kind: "unavailable", message: "That emulator is not booted." };
    }
    const adb = this.#sdk.adbPath;
    if (adb === undefined) {
      return { kind: "unavailable", message: "adb is unavailable on this host." };
    }
    const serial = emulator.serial;
    const lifetime = new AbortController();
    this.#screenWatches.add(lifetime);
    const finish = () => {
      lifetime.abort();
      signal.removeEventListener("abort", finish);
      this.#screenWatches.delete(lifetime);
    };
    lifetime.signal.addEventListener(
      "abort",
      () => {
        signal.removeEventListener("abort", finish);
        this.#screenWatches.delete(lifetime);
      },
      { once: true },
    );
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
    let first: Uint8Array | undefined;
    try {
      if (!lifetime.signal.aborted)
        first = await this.#screencap(adb, serial, context, lifetime.signal);
    } catch {
      finish();
      return { kind: "unavailable", message: "The emulator screen could not be captured." };
    }
    if (first === undefined || lifetime.signal.aborted) {
      finish();
      return { kind: "unavailable", message: "The emulator screen could not be captured." };
    }
    const size = pngSize(first);
    if (size === undefined) {
      finish();
      return { kind: "unavailable", message: "The emulator screen capture was not a PNG." };
    }
    const firstFrame = first;
    let last = firstFrame;
    const frames = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          controller.enqueue(lengthPrefixed(firstFrame));
        },
        pull: async (controller) => {
          try {
            while (!lifetime.signal.aborted) {
              await sleep(SCREEN_POLL_MS, lifetime.signal);
              if (lifetime.signal.aborted) break;
              const next = await this.#screencap(adb, serial, context, lifetime.signal);
              if (next === undefined || sameBytes(next, last)) continue;
              last = next;
              controller.enqueue(lengthPrefixed(next));
              return;
            }
            controller.close();
            finish();
          } catch (error) {
            finish();
            controller.error(error);
          }
        },
        cancel: finish,
      },
      { highWaterMark: 0 },
    );
    return { kind: "watching", screen: size, frames };
  }

  async #run(
    request: AndroidEmulatorRequest,
    context: AndroidExecutionContext,
    signal: AbortSignal,
    startedAt: string,
  ): Promise<AndroidEmulatorEvidence> {
    const adb = this.#sdk.adbPath;
    const emulatorBin = this.#sdk.emulatorPath;
    if (request.kind === "open-input") {
      const note = redactedAndroidInputDiagnostic(request);
      return await this.#logged(request, "succeeded", startedAt, [note], "not-required");
    }
    if (request.kind === "boot") {
      if (emulatorBin === undefined) return await this.#unavailable(request, startedAt, "emulator");
      const spawn = this.#options.spawnDetached;
      if (spawn === undefined) {
        return await this.#unavailable(request, startedAt, "emulator");
      }
      this.#setState(request.emulatorId, "booting");
      const started = await spawn({
        argv: [emulatorBin, "-avd", String(request.emulatorId), "-no-window", "-no-audio"],
        cwd: context.checkoutRoot,
        environment: androidEnv(this.#options.environment?.() ?? {}, this.#sdk),
      });
      if (started.kind !== "spawned") {
        this.#setState(request.emulatorId, "shutdown");
        return await this.#unavailable(request, startedAt, "emulator");
      }
      const ready = await this.#waitUntilBooted(
        request.emulatorId,
        context,
        request.timeoutMs,
        signal,
      );
      this.#setState(request.emulatorId, ready ? "booted" : "shutdown");
      return await this.#logged(
        request,
        ready ? "succeeded" : signal.aborted ? "cancelled" : "timed-out",
        startedAt,
        [
          {
            severity: "note",
            message: ready ? "emulator booted" : "emulator did not become ready",
          },
        ],
        "complete",
      );
    }
    if (adb === undefined) return await this.#unavailable(request, startedAt, "adb");
    const serial = this.#serialOf(request.emulatorId);
    if (serial === undefined) {
      return deniedEvidence(request, "destination-not-booted", startedAt, this.#options.now());
    }
    if (request.kind === "shutdown") {
      const target = serial;
      const result = await this.#command(
        [adb, "-s", target, "emu", "kill"],
        context,
        request.timeoutMs,
        signal,
      );
      if (succeeded(result)) this.#setState(request.emulatorId, "shutdown", true);
      return await this.#fromProcess(request, result, startedAt);
    }
    if (request.kind === "screenshot") {
      const bytes = await this.#screencap(adb, serial, context, signal);
      if (bytes === undefined) return await this.#unavailable(request, startedAt, "screencap");
      const reference = `android-screenshot-${request.actionId}`;
      await this.#storeArtifact(reference, bytes, context);
      return evidence(
        request,
        "succeeded",
        startedAt,
        this.#options.now(),
        [],
        [{ kind: "screenshot", reference }],
        "complete",
      );
    }
    if (isAndroidEmulatorInputKind(request.kind)) {
      const argv = inputArgv(adb, serial, request);
      if (argv === undefined) {
        return deniedEvidence(request, "invalid-destination", startedAt, this.#options.now());
      }
      const result = await this.#command(argv, context, request.timeoutMs, signal);
      const note = succeeded(result)
        ? redactedAndroidInputDiagnostic(request)
        : { severity: "note" as const, message: `${request.kind} ${outcomeFor(result)}` };
      return await this.#logged(
        request,
        outcomeFor(result),
        startedAt,
        [note],
        result.cleanupUncertain ? "uncertain" : "complete",
      );
    }
    if (request.kind === "install") {
      if (request.apkPath === undefined) {
        return deniedEvidence(request, "invalid-destination", startedAt, this.#options.now());
      }
      let apk: string;
      try {
        apk = await confinedCheckoutFile(
          context.checkoutRoot,
          request.apkPath,
          this.#options.realpath,
        );
      } catch {
        return deniedEvidence(request, "invalid-destination", startedAt, this.#options.now());
      }
      const result = await this.#command(
        [adb, "-s", serial, "install", "-r", apk],
        context,
        request.timeoutMs,
        signal,
      );
      return await this.#fromProcess(request, result, startedAt);
    }
    if (request.kind === "launch") {
      if (request.packageName === undefined) {
        return deniedEvidence(request, "invalid-destination", startedAt, this.#options.now());
      }
      const result = await this.#command(
        [
          adb,
          "-s",
          serial,
          "shell",
          "monkey",
          "-p",
          request.packageName,
          "-c",
          "android.intent.category.LAUNCHER",
          "1",
        ],
        context,
        request.timeoutMs,
        signal,
      );
      return await this.#fromProcess(request, result, startedAt);
    }
    return deniedEvidence(request, "invalid-destination", startedAt, this.#options.now());
  }

  async #discoverSdk(): Promise<AndroidSdkDiscovery> {
    const env = this.#options.environment?.() ?? process.env;
    const home = env.ANDROID_HOME ?? env.ANDROID_SDK_ROOT ?? defaultSdkHome();
    const emulatorPath = home === undefined ? undefined : join(home, "emulator", "emulator");
    const adbPath = home === undefined ? undefined : join(home, "platform-tools", "adb");
    const emulatorOk = emulatorPath !== undefined && (await this.#exists(emulatorPath));
    const adbOk = adbPath !== undefined && (await this.#exists(adbPath));
    return decodeAndroidSdkDiscovery({
      sdkId: decodeAndroidSdkId(this.#options.newId()),
      ...(home === undefined ? {} : { sdkRoot: home }),
      ...(adbOk ? { adbPath } : {}),
      ...(emulatorOk ? { emulatorPath } : {}),
      available: emulatorOk && adbOk,
      discoveredAt: this.#options.now(),
    });
  }

  async #exists(path: string): Promise<boolean> {
    try {
      await this.#access(path);
      return true;
    } catch {
      return false;
    }
  }

  async #serialForAvd(
    adb: string,
    avd: string,
    serials: ReadonlyArray<string>,
    context: AndroidExecutionContext,
  ): Promise<string | undefined> {
    for (const serial of serials) {
      const named = await this.#command([adb, "-s", serial, "emu", "avd", "name"], context, 5_000);
      const lines = text(named.stdout).trim().split(/\r?\n/);
      if (
        succeeded(named) &&
        lines[0] === avd &&
        (lines.length === 1 || (lines.length === 2 && lines[1] === "OK"))
      )
        return serial;
    }
    return undefined;
  }

  async #waitUntilBooted(
    emulatorId: AndroidEmulatorRecord["emulatorId"],
    context: AndroidExecutionContext,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const adb = this.#sdk.adbPath;
    if (adb === undefined) return false;
    while (Date.now() < deadline && !signal.aborted) {
      const devices = await this.#command([adb, "devices", "-l"], context, 10_000, signal);
      const serials = succeeded(devices) ? parseAdbDevices(text(devices.stdout)) : [];
      const serial = await this.#serialForAvd(adb, String(emulatorId), serials, context);
      if (serial !== undefined) {
        const booted = await this.#command(
          [adb, "-s", serial, "shell", "getprop", "sys.boot_completed"],
          context,
          10_000,
          signal,
        );
        if (succeeded(booted) && text(booted.stdout).trim() === "1") {
          this.#setState(emulatorId, "booted", false, serial);
          return true;
        }
      }
      await sleep(1_000, signal);
    }
    return false;
  }

  async #screencap(
    adb: string,
    serial: string,
    context: AndroidExecutionContext,
    signal?: AbortSignal,
  ): Promise<Uint8Array | undefined> {
    const result = await this.#command(
      [adb, "-s", serial, "exec-out", "screencap", "-p"],
      context,
      15_000,
      signal,
    );
    if (
      !succeeded(result) ||
      result.stdout.byteLength < 24 ||
      result.stdout.byteLength > MAXIMUM_FRAME_BYTES
    )
      return undefined;
    return result.stdout;
  }

  async #command(
    argv: ReadonlyArray<string>,
    context: AndroidExecutionContext,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<AndroidProcessResult> {
    const combined =
      signal === undefined
        ? this.#lifetime.signal
        : AbortSignal.any([signal, this.#lifetime.signal]);
    if (combined.aborted)
      return {
        termination: "cancelled",
        exitCode: null,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        cleanupUncertain: false,
      };
    const command = this.#options.execute(
      {
        argv,
        cwd: context.checkoutRoot,
        environment: androidEnv(this.#options.environment?.() ?? {}, this.#sdk),
        timeoutMs,
      },
      combined,
    );
    this.#commands.add(command);
    try {
      return await command;
    } finally {
      this.#commands.delete(command);
    }
  }

  #activate(
    request: AndroidEmulatorRequest,
    controller: AbortController,
    context: AndroidExecutionContext,
  ) {
    const progress: AndroidActionProgress = {
      actionId: request.actionId,
      correlationId: request.correlationId,
      authority: request.authority,
      kind: request.kind,
      state: "running",
      step: stepFor(request.kind),
      sequence: 1,
      updatedAt: this.#options.now() as AndroidActionProgress["updatedAt"],
    };
    const { promise: done, resolve: markDone } = Promise.withResolvers<void>();
    const active = { controller, progress, context, done, markDone };
    this.#active.set(String(request.actionId), active);
    return active;
  }

  #findCompleted(
    request: AndroidEmulatorRequest,
    context: AndroidExecutionContext,
  ): AndroidEmulatorEvidence | undefined {
    for (let index = this.#recent.length - 1; index >= 0; index -= 1) {
      const entry = this.#recent[index];
      if (entry === undefined || entry.evidence.outcome === "unauthorized") continue;
      if (String(entry.evidence.actionId) !== String(request.actionId)) continue;
      if (
        !androidContextMatches(entry.context, context) ||
        entry.fingerprint !== androidRequestFingerprint(request)
      ) {
        return deniedEvidence(
          request,
          "action-identity-conflict",
          this.#options.now(),
          this.#options.now(),
        );
      }
      return replayedFrom(entry.evidence);
    }
    return undefined;
  }

  #record(
    value: AndroidEmulatorEvidence,
    request: AndroidEmulatorRequest,
    context: AndroidExecutionContext,
  ): AndroidEmulatorEvidence {
    this.#recent.push({
      evidence: value,
      context,
      fingerprint: androidRequestFingerprint(request),
    });
    if (this.#recent.length > MAX_RECENT) this.#recent.splice(0, this.#recent.length - MAX_RECENT);
    this.#sequence += 1;
    return value;
  }

  async #storeArtifact(
    reference: string,
    bytes: Uint8Array,
    context: AndroidExecutionContext,
  ): Promise<void> {
    await this.#options.writeArtifact(reference, bytes, context);
  }

  async #logged(
    request: AndroidEmulatorRequest,
    outcome: AndroidEmulatorEvidence["outcome"],
    startedAt: string,
    diagnostics: AndroidEmulatorEvidence["diagnostics"],
    cleanup: AndroidEmulatorEvidence["cleanup"],
  ): Promise<AndroidEmulatorEvidence> {
    const reference = `android-log-${request.actionId}`;
    await this.#options.writeArtifact(
      reference,
      new TextEncoder().encode(diagnostics.map((item) => item.message).join("\n") + "\n"),
      request,
    );
    return evidence(
      request,
      outcome,
      startedAt,
      this.#options.now(),
      diagnostics,
      [{ kind: "log", reference }],
      cleanup,
    );
  }

  async #fromProcess(
    request: AndroidEmulatorRequest,
    result: AndroidProcessResult,
    startedAt: string,
  ): Promise<AndroidEmulatorEvidence> {
    const message =
      text(result.stderr).trim() ||
      text(result.stdout).trim() ||
      `${request.kind} ${outcomeFor(result)}`;
    return await this.#logged(
      request,
      outcomeFor(result),
      startedAt,
      [{ severity: "note", message: message.slice(0, 2048) }],
      result.cleanupUncertain ? "uncertain" : "complete",
    );
  }

  async #unavailable(
    request: AndroidEmulatorRequest,
    startedAt: string,
    tool: string,
  ): Promise<AndroidEmulatorEvidence> {
    return await this.#logged(
      request,
      "unavailable",
      startedAt,
      [{ severity: "note", message: `${tool} is unavailable on this host.` }],
      "not-required",
    );
  }

  #serialOf(emulatorId: AndroidEmulatorRecord["emulatorId"]): string | undefined {
    return this.#emulators.find((candidate) => candidate.emulatorId === emulatorId)?.serial;
  }

  #setState(
    emulatorId: AndroidEmulatorRecord["emulatorId"],
    state: AndroidEmulatorRecord["state"],
    clearSerial = false,
    serial?: string,
  ): void {
    this.#emulators = this.#emulators.map((emulator) => {
      if (emulator.emulatorId !== emulatorId) return emulator;
      const next: AndroidEmulatorRecord = {
        emulatorId: emulator.emulatorId,
        name: emulator.name,
        state,
        ...(emulator.apiLevel === undefined ? {} : { apiLevel: emulator.apiLevel }),
      };
      if (clearSerial) return next;
      const resolved = serial ?? emulator.serial;
      return resolved === undefined ? next : { ...next, serial: resolved };
    });
    this.#options.observeEmulators?.(this.#emulators);
  }
}

const replayedEvidence = new WeakSet<object>();

function replayedFrom<Evidence extends object>(value: Evidence): Evidence {
  const replay = { ...value };
  replayedEvidence.add(replay);
  return replay;
}

export function isReplayedAndroidEvidence(value: object): boolean {
  return replayedEvidence.has(value);
}

function unavailableSdk(discoveredAt: string): AndroidSdkDiscovery {
  return decodeAndroidSdkDiscovery({
    sdkId: decodeAndroidSdkId("00000000-0000-4000-8000-000000000001"),
    available: false,
    discoveredAt,
  });
}

function androidEnv(
  env: Readonly<Record<string, string | undefined>>,
  sdk: AndroidSdkDiscovery,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const name of ["HOME", "TMPDIR", "TEMP", "TMP", "ANDROID_HOME", "ANDROID_SDK_ROOT"]) {
    const value = env[name];
    if (value !== undefined) next[name] = value;
  }
  if (sdk.sdkRoot !== undefined) {
    next.ANDROID_HOME = sdk.sdkRoot;
    next.ANDROID_SDK_ROOT = sdk.sdkRoot;
  }
  return next;
}

function defaultSdkHome(): string | undefined {
  const mac = join(homedir(), "Library", "Android", "sdk");
  const linux = join(homedir(), "Android", "Sdk");
  return process.platform === "darwin" ? mac : linux;
}

function parseAdbDevices(output: string): ReadonlyArray<string> {
  const serials: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^(emulator-[0-9]+)\s+device\b/.exec(line.trim());
    if (match?.[1] !== undefined) serials.push(match[1]);
  }
  return serials;
}

function inputArgv(
  adb: string,
  serial: string,
  request: AndroidEmulatorRequest,
): ReadonlyArray<string> | undefined {
  if (request.kind === "tap" && request.point !== undefined) {
    return [
      adb,
      "-s",
      serial,
      "shell",
      "input",
      "tap",
      String(Math.round(request.point.x)),
      String(Math.round(request.point.y)),
    ];
  }
  if (request.kind === "swipe" && request.point !== undefined && request.toPoint !== undefined) {
    return [
      adb,
      "-s",
      serial,
      "shell",
      "input",
      "swipe",
      String(Math.round(request.point.x)),
      String(Math.round(request.point.y)),
      String(Math.round(request.toPoint.x)),
      String(Math.round(request.toPoint.y)),
      String(request.durationMs ?? 300),
    ];
  }
  if (request.kind === "type-text" && request.text !== undefined) {
    return [adb, "-s", serial, "shell", "input", "text", adbText(request.text)];
  }
  if (request.kind === "key-press" && request.key !== undefined) {
    const keycode = androidKey(request.key);
    if (keycode === undefined) return undefined;
    return [adb, "-s", serial, "shell", "input", "keyevent", keycode];
  }
  return undefined;
}

function adbText(value: string): string {
  // adb joins argv into a command that the device shell parses again.
  // Quote the whole token so typed punctuation cannot become shell syntax.
  return `'${value.replaceAll(" ", "%s").replaceAll("'", "'\\''")}'`;
}

function androidKey(key: string): string | undefined {
  const keys: Record<string, string> = {
    home: "KEYCODE_HOME",
    lock: "KEYCODE_POWER",
    return: "KEYCODE_ENTER",
    enter: "KEYCODE_ENTER",
    escape: "KEYCODE_BACK",
    back: "KEYCODE_BACK",
    space: "KEYCODE_SPACE",
    delete: "KEYCODE_DEL",
    left: "KEYCODE_DPAD_LEFT",
    right: "KEYCODE_DPAD_RIGHT",
    up: "KEYCODE_DPAD_UP",
    down: "KEYCODE_DPAD_DOWN",
  };
  return keys[key.toLowerCase()];
}

function stepFor(kind: AndroidEmulatorRequest["kind"]): AndroidActionProgress["step"] {
  if (kind === "boot") return "preparing-destination";
  if (kind === "screenshot") return "capturing-screen";
  if (kind === "install") return "installing";
  if (kind === "launch") return "launching";
  if (isAndroidEmulatorInputKind(kind) || isAndroidEmulatorOpenInputKind(kind)) {
    return "injecting-input";
  }
  return "cleaning-up";
}

function succeeded(result: AndroidProcessResult): boolean {
  return result.termination === "exited" && result.exitCode === 0 && !result.cleanupUncertain;
}

function outcomeFor(result: AndroidProcessResult): AndroidEmulatorEvidence["outcome"] {
  if (result.cleanupUncertain) return "interrupted";
  if (result.termination === "cancelled") return "cancelled";
  if (result.termination === "timed-out") return "timed-out";
  if (result.termination === "unavailable") return "unavailable";
  if (result.exitCode === null) return "process-died";
  return result.exitCode === 0 ? "succeeded" : "failed";
}

function deniedEvidence(
  request: AndroidEmulatorRequest,
  reason: string,
  startedAt: string,
  completedAt: string,
): AndroidEmulatorEvidence {
  const outcome =
    reason === "invalid-destination" || reason.startsWith("destination-")
      ? "invalid-destination"
      : reason === "toolchain-unavailable"
        ? "unavailable"
        : "unauthorized";
  return evidence(
    request,
    outcome,
    startedAt,
    completedAt,
    [{ severity: "note", message: reason }],
    [],
    "not-required",
  );
}

function evidence(
  request: AndroidEmulatorRequest,
  outcome: AndroidEmulatorEvidence["outcome"],
  startedAt: string,
  completedAt: string,
  diagnostics: AndroidEmulatorEvidence["diagnostics"],
  artifacts: AndroidEmulatorEvidence["artifacts"],
  cleanup: AndroidEmulatorEvidence["cleanup"],
): AndroidEmulatorEvidence {
  return decodeAndroidEmulatorEvidence({
    actionId: request.actionId,
    correlationId: request.correlationId,
    authority: request.authority,
    kind: request.kind,
    emulatorId: request.emulatorId,
    ...(request.requestedBy === undefined ? {} : { requestedBy: request.requestedBy }),
    outcome,
    diagnostics: diagnostics.slice(0, MAX_DIAGNOSTICS),
    artifacts,
    cleanup,
    durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt) || 0),
    completedAt,
  });
}

async function confinedCheckoutFile(
  checkoutRoot: string,
  relativePath: string,
  realpath: (path: string) => Promise<string>,
): Promise<string> {
  if (isAbsolute(relativePath)) throw new Error("absolute path denied");
  const canonicalRoot = await realpath(checkoutRoot);
  const candidate = await realpath(resolve(canonicalRoot, relativePath));
  const fromRoot = relative(canonicalRoot, candidate);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error("path outside checkout");
  }
  return candidate;
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function pngSize(
  bytes: Uint8Array,
): { readonly width: number; readonly height: number } | undefined {
  if (bytes.byteLength < 24) return undefined;
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function lengthPrefixed(frame: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + frame.byteLength);
  new DataView(out.buffer).setUint32(0, frame.byteLength);
  out.set(frame, 4);
  return out;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveSleep) => {
    if (signal.aborted) {
      resolveSleep();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolveSleep();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function androidContextMatches(
  left: AndroidExecutionContext,
  right: AndroidExecutionContext,
): boolean {
  return (
    sameToolActionAuthority(left.authority, right.authority) &&
    String(left.threadId) === String(right.threadId) &&
    String(left.checkoutId) === String(right.checkoutId)
  );
}

function androidRequestFingerprint(request: AndroidEmulatorRequest): string {
  return createHash("sha256")
    .update(JSON.stringify(decodeAndroidEmulatorRequest(request)))
    .digest("hex");
}
