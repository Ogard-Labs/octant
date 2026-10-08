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
import type {
  AndroidScreenFallbackReason,
  AndroidScreenTransport,
} from "@octant/contracts/android-toolchain-rpc";
import { takeJpegFrames } from "@octant/domain/managed-device-stream";
import type { ServeAvdAttachment, ServeAvdOpening, ServeAvdPort } from "./serveAvdBrokerClient";

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
  /** The serve-avd stream, or adb screencap snapshots and why the stream is not used. */
  readonly transport: AndroidScreenTransport;
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
  /** Managed serve-avd for an already booted emulator serial. Absent means adb. */
  readonly serveAvd?: ServeAvdPort;
  readonly fetchImpl?: typeof fetch;
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
    let fallback: AndroidScreenFallbackReason = "not-emulator";
    if (/^emulator-[0-9]+$/.test(serial) && !lifetime.signal.aborted) {
      const managed = await this.#watchManaged(serial, lifetime.signal);
      if (managed.kind === "fallback") fallback = managed.reason;
      else {
        const reader = managed.frames.getReader();
        const frames = new ReadableStream<Uint8Array>(
          {
            pull: async (controller) => {
              const next = await reader.read();
              if (next.done) {
                finish();
                controller.close();
                return;
              }
              controller.enqueue(next.value);
            },
            cancel: async () => {
              await reader.cancel();
              finish();
            },
          },
          { highWaterMark: 0 },
        );
        return { kind: "watching", screen: managed.screen, frames, transport: { kind: "stream" } };
      }
    }
    if (lifetime.signal.aborted) {
      finish();
      return { kind: "unavailable", message: "The emulator screen could not be captured." };
    }
    const adb = this.#sdk.adbPath;
    if (adb === undefined) {
      finish();
      return { kind: "unavailable", message: "adb is unavailable on this host." };
    }
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
    return {
      kind: "watching",
      screen: size,
      frames,
      transport: { kind: "screencap", reason: fallback },
    };
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
      // `emu kill` needs the console-auth token that confined launches do not
      // mount. Powering off through adbd reaches the same outcome and keeps the
      // console-control secret out of the sandbox; `adb root` is best-effort so
      // adbd can honour `reboot -p` on userdebug images, and a production image
      // that refuses either step reports an honest failure instead of the
      // console's `KO` the state update would mistake for success.
      await this.#command([adb, "-s", target, "root"], context, 15_000, signal);
      const result = await this.#command(
        [adb, "-s", target, "shell", "reboot", "-p"],
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
      const managed = await this.#serveAvdInput(request, serial, signal, startedAt);
      if (managed !== undefined) return managed;
      const argv = inputArgv(adb, serial, request);
      if (argv === undefined) {
        return deniedEvidence(request, "invalid-destination", startedAt, this.#options.now());
      }
      const result = await this.#command(argv, context, request.timeoutMs, signal);
      if (lostServerMidCommand(result)) {
        // The device may already have acted, so this is not a failure to
        // retry: a retried type-text typed its text twice.
        return await this.#logged(
          request,
          "interrupted",
          startedAt,
          [
            {
              severity: "note",
              message: `${request.kind} may have reached the emulator; adb lost its server before the device answered`,
            },
          ],
          "complete",
        );
      }
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
    const home = env.ANDROID_HOME ?? env.ANDROID_SDK_ROOT ?? (await this.#installedSdkHome());
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

  async #installedSdkHome(): Promise<string | undefined> {
    const candidates = defaultSdkHomes();
    for (const candidate of candidates) {
      // A partial install (adb without the emulator) must not hide a complete
      // SDK further down the list.
      if (
        (await this.#exists(join(candidate, "platform-tools", "adb"))) &&
        (await this.#exists(join(candidate, "emulator", "emulator")))
      ) {
        return candidate;
      }
    }
    return candidates[0];
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
      // `adb emu avd name` talks to the emulator console, which authenticates
      // against ~/.emulator_console_auth_token — a file confined launches do
      // not mount. `getprop` travels over adbd, whose keys live under the
      // already-mounted ~/.android, so this match works inside confinement.
      const named = await this.#command(
        [adb, "-s", serial, "shell", "getprop", "ro.boot.qemu.avd_name"],
        context,
        5_000,
      );
      if (succeeded(named) && text(named.stdout).trim() === avd) return serial;
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

  async #watchManaged(
    serial: string,
    signal: AbortSignal,
  ): Promise<
    | Omit<AndroidScreenWatch, "transport">
    | { readonly kind: "fallback"; readonly reason: AndroidScreenFallbackReason }
  > {
    const opened = await this.#openServeAvd(serial, signal);
    if (opened.status !== "attached") return { kind: "fallback", reason: opened.reason };
    const noFrames = { kind: "fallback", reason: "no-frames" } as const;
    const attachment = opened.attachment;
    if (signal.aborted) return noFrames;
    const fetchImpl = this.#options.fetchImpl ?? fetch;
    const screen = await readServeAvdScreen(fetchImpl, attachment, serial, signal);
    if (screen === undefined || signal.aborted) return noFrames;
    const headers = headerDeadline(signal, 5_000);
    let response: Response;
    try {
      response = await fetchImpl(attachment.streamUrl, {
        redirect: "error",
        credentials: "omit",
        signal: headers.signal,
      });
    } catch {
      return noFrames;
    } finally {
      headers.stop();
    }
    if (!response.ok || response.body === null) {
      await response.body?.cancel();
      return noFrames;
    }
    const reader = response.body.getReader();
    const first = await firstJpeg(reader, signal, 5_000);
    if (first === undefined) {
      await reader.cancel().catch(() => undefined);
      return noFrames;
    }
    let rest = first.rest;
    const pending = [...first.frames];
    const frames = new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          try {
            while (!signal.aborted) {
              const next = pending.shift();
              if (next !== undefined) {
                controller.enqueue(lengthPrefixed(next));
                return;
              }
              const chunk = await reader.read();
              if (chunk.done) break;
              const taken = takeJpegFrames(concatBytes(rest, chunk.value));
              rest = taken.rest;
              pending.push(...taken.frames);
            }
            controller.close();
          } catch (error) {
            controller.error(error);
          } finally {
            if (signal.aborted) await reader.cancel().catch(() => undefined);
          }
        },
        cancel: () => reader.cancel(),
      },
      { highWaterMark: 0 },
    );
    return { kind: "watching", screen, frames };
  }

  /**
   * Sends one input through serve-avd when the broker has attached a booted
   * serial. Undefined means nothing was sent and adb should deliver it.
   * A refused action is not also sent through adb.
   */
  async #serveAvdInput(
    request: AndroidEmulatorRequest,
    serial: string,
    signal: AbortSignal,
    startedAt: string,
  ): Promise<AndroidEmulatorEvidence | undefined> {
    if (this.#options.serveAvd === undefined || !/^emulator-[0-9]+$/.test(serial)) {
      return undefined;
    }
    const command = serveAvdCommand(request);
    if (command === undefined) return undefined;
    const opened = await this.#openServeAvd(serial, signal);
    if (opened.status !== "attached" || signal.aborted) return undefined;
    const attachment = opened.attachment;
    const fetchImpl = this.#options.fetchImpl ?? fetch;
    let body: Readonly<Record<string, unknown>> | undefined;
    if (command.kind === "direct") body = command.body;
    else {
      const screen = await readServeAvdScreen(fetchImpl, attachment, serial, signal);
      if (screen === undefined) return undefined;
      body = command.build(screen);
      if (body === undefined) return undefined;
    }
    let response: Response;
    try {
      response = await fetchImpl(
        `${attachment.origin}/helper/${encodeURIComponent(serial)}/action`,
        {
          method: "POST",
          redirect: "error",
          credentials: "omit",
          signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
    } catch {
      return await this.#logged(
        request,
        "unavailable",
        startedAt,
        [{ severity: "note", message: `${request.kind} did not reach the emulator stream` }],
        "uncertain",
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }
    const refused = !response.ok || (isRecord(payload) && payload.ok === false);
    return await this.#logged(
      request,
      refused ? "failed" : "succeeded",
      startedAt,
      [
        redactedAndroidInputDiagnostic(request),
        { severity: "note", message: "sent through serve-avd" },
      ],
      "complete",
    );
  }

  /** Attaches serve-avd to a booted emulator, using the same SDK the server runs adb from. */
  async #openServeAvd(
    serial: string,
    signal: AbortSignal,
  ): Promise<
    | Extract<ServeAvdOpening, { readonly status: "attached" }>
    | { readonly status: "unavailable"; readonly reason: AndroidScreenFallbackReason }
  > {
    const port = this.#options.serveAvd;
    if (port === undefined) return { status: "unavailable", reason: "no-desktop" };
    const sdkRoot = this.#sdk.sdkRoot;
    try {
      return await port.open(serial, sdkRoot === undefined ? { signal } : { sdkRoot, signal });
    } catch {
      return { status: "unavailable", reason: "desktop-unreachable" };
    }
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

/**
 * Directories a confined toolchain command must read and write even though
 * they sit beneath the private-home deny: `~/.android` holds the AVD store,
 * the adb keys, and the emulator's lock and launch files, and a configured
 * `ANDROID_AVD_HOME` replaces where the AVDs themselves live. Without the
 * grant `emulator -list-avds` exits 0 with an empty list on a host that has
 * devices, so the pane reports none forever.
 */
export function androidToolchainStorePaths(
  environment: Readonly<Record<string, string | undefined>>,
): ReadonlyArray<string> {
  const paths = [join(homedir(), ".android")];
  const avdHome = environment.ANDROID_AVD_HOME;
  // An explicitly empty override is unset: an empty string is not an absolute
  // path, and forwarding it would make the confinement builder refuse every
  // Android command instead of just one override.
  if (avdHome !== undefined && avdHome !== "" && !paths.includes(avdHome)) paths.push(avdHome);
  return paths;
}

function androidEnv(
  env: Readonly<Record<string, string | undefined>>,
  sdk: AndroidSdkDiscovery,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const name of [
    "HOME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "ANDROID_HOME",
    "ANDROID_SDK_ROOT",
    "ANDROID_AVD_HOME",
  ]) {
    const value = env[name];
    // Empty is unset: an empty path override is not usable toolchain state.
    if (value !== undefined && value !== "") next[name] = value;
  }
  if (sdk.sdkRoot !== undefined) {
    next.ANDROID_HOME = sdk.sdkRoot;
    next.ANDROID_SDK_ROOT = sdk.sdkRoot;
  }
  // Whichever adb client finds no server running forks the shared one, and that
  // server inherits this environment. With mDNS discovery on, adb 37's server
  // aborts about two seconds after it starts on macOS 27 (a Rust panic in its
  // mDNS network watcher), so every command restarted it, the emulator dropped
  // to `offline`, input took seconds to land, and a command whose server died
  // mid-flight exited 255 after the device had already acted. Octant reaches
  // emulators over adb's local transport and never uses wireless discovery.
  next.ADB_MDNS = "0";
  return next;
}

/**
 * Where an SDK lives when neither `ANDROID_HOME` nor `ANDROID_SDK_ROOT` says.
 * Android Studio installs under the home directory; the Homebrew
 * `android-commandlinetools` cask installs under the Homebrew prefix, and an
 * app launched from Finder never sees the shell profile that would export it.
 */
function defaultSdkHomes(): ReadonlyArray<string> {
  if (process.platform !== "darwin") return [join(homedir(), "Android", "Sdk")];
  return [
    join(homedir(), "Library", "Android", "sdk"),
    "/opt/homebrew/share/android-commandlinetools",
    "/usr/local/share/android-commandlinetools",
  ];
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

/**
 * Whether an `adb shell` command exited without either side saying why. A
 * client that never reached the device names the reason (`adb: device
 * offline`, `device 'emulator-5554' not found`, `cannot connect to daemon`),
 * and a device-side failure prints its exception; when the server dies after
 * the command was handed to the device, the client exits 255 with only adb's
 * own `* daemon …` start notices on stderr.
 */
function lostServerMidCommand(result: AndroidProcessResult): boolean {
  // 255 is what the client returned when its server was aborted mid-command;
  // any other code is the device's own exit status and stays a failure.
  if (result.termination !== "exited" || result.exitCode !== 255) return false;
  if (result.cleanupUncertain) return false;
  return text(result.stderr)
    .split(/\r?\n/)
    .every((line) => line.trim() === "" || line.startsWith("* "));
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

type ServeAvdCommand =
  | { readonly kind: "direct"; readonly body: Readonly<Record<string, unknown>> }
  | {
      readonly kind: "point";
      readonly build: (screen: {
        readonly width: number;
        readonly height: number;
      }) => Readonly<Record<string, unknown>> | undefined;
    };

/** Keys serve-avd names directly. Anything else stays on one adb keyevent. */
function serveAvdCommand(request: AndroidEmulatorRequest): ServeAvdCommand | undefined {
  if (request.kind === "tap" && request.point !== undefined) {
    const point = request.point;
    return {
      kind: "point",
      build: (screen) => {
        const at = screenFraction(point, screen);
        return at === undefined ? undefined : { action: "tap", x: at.x, y: at.y };
      },
    };
  }
  if (request.kind === "swipe" && request.point !== undefined && request.toPoint !== undefined) {
    const from = request.point;
    const to = request.toPoint;
    const durationMs = request.durationMs ?? 300;
    return {
      kind: "point",
      build: (screen) => {
        const start = screenFraction(from, screen);
        const end = screenFraction(to, screen);
        if (start === undefined || end === undefined) return undefined;
        return {
          action: "swipe",
          x1: start.x,
          y1: start.y,
          x2: end.x,
          y2: end.y,
          durationMs,
        };
      },
    };
  }
  if (request.kind === "type-text" && request.text !== undefined) {
    return { kind: "direct", body: { action: "text", text: request.text } };
  }
  if (request.kind === "key-press" && request.key !== undefined) {
    const name = request.key.toLowerCase();
    if (name === "home") return { kind: "direct", body: { action: "button", button: "home" } };
    if (name === "back" || name === "escape") {
      return { kind: "direct", body: { action: "button", button: "back" } };
    }
    if (name === "lock") return { kind: "direct", body: { action: "button", button: "power" } };
    if (name === "enter" || name === "return") {
      return { kind: "direct", body: { action: "key", code: "Enter" } };
    }
  }
  return undefined;
}

/** Aborts the stream request if headers do not arrive. The body keeps the parent signal. */
function headerDeadline(
  parent: AbortSignal,
  timeoutMs: number,
): { readonly signal: AbortSignal; stop: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onParent = () => controller.abort();
  if (parent.aborted) controller.abort();
  else parent.addEventListener("abort", onParent, { once: true });
  return {
    signal: controller.signal,
    stop: () => clearTimeout(timer),
  };
}

function screenFraction(
  point: { readonly x: number; readonly y: number },
  screen: { readonly width: number; readonly height: number },
): { readonly x: number; readonly y: number } | undefined {
  if (screen.width <= 0 || screen.height <= 0) return undefined;
  return { x: point.x / screen.width, y: point.y / screen.height };
}

async function readServeAvdScreen(
  fetchImpl: typeof fetch,
  attachment: ServeAvdAttachment,
  serial: string,
  signal: AbortSignal,
): Promise<{ readonly width: number; readonly height: number } | undefined> {
  let response: Response;
  try {
    response = await fetchImpl(`${attachment.origin}/helper/${encodeURIComponent(serial)}/config`, {
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
    });
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return undefined;
  }
  if (!isRecord(body) || typeof body.width !== "number" || typeof body.height !== "number") {
    return undefined;
  }
  if (!Number.isFinite(body.width) || !Number.isFinite(body.height)) return undefined;
  if (body.width <= 0 || body.height <= 0 || body.width > 20_000 || body.height > 20_000) {
    return undefined;
  }
  return { width: body.width, height: body.height };
}

type ReadChunk = { readonly done: false; readonly value: Uint8Array } | { readonly done: true };

async function firstJpeg(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{ readonly frames: readonly Uint8Array[]; readonly rest: Uint8Array } | undefined> {
  let rest: Uint8Array = new Uint8Array();
  const deadline = Date.now() + timeoutMs;
  while (!signal.aborted && Date.now() < deadline) {
    const chunk = await readChunk(reader, deadline - Date.now(), signal);
    if (chunk === undefined || chunk.done) return undefined;
    const taken = takeJpegFrames(concatBytes(rest, chunk.value));
    rest = taken.rest;
    if (taken.frames.length > 0) return { frames: taken.frames, rest };
  }
  return undefined;
}

function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ReadChunk | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: ReadChunk | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => finish(undefined);
    const timer = setTimeout(() => finish(undefined), Math.max(0, timeoutMs));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        if (result.done) finish({ done: true });
        else finish({ done: false, value: result.value });
      },
      () => finish(undefined),
    );
  });
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right;
  const out = new Uint8Array(left.byteLength + right.byteLength);
  out.set(left, 0);
  out.set(right, left.byteLength);
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
