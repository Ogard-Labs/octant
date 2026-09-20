import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  decodeAndroidEmulatorEvidence,
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
  }) => Promise<{ readonly kind: "spawned" } | { readonly kind: "unavailable"; readonly message: string }>;
  readonly realpath: (path: string) => Promise<string>;
  readonly observeEmulators?: (emulators: ReadonlyArray<AndroidEmulatorRecord>) => void;
  readonly writeArtifact: (reference: string, bytes: Uint8Array) => Promise<void>;
  readonly readArtifact: (reference: string) => Promise<Uint8Array | undefined>;
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
  #sdk: AndroidSdkDiscovery = unavailableSdk("1970-01-01T00:00:00.000Z");
  #emulators: ReadonlyArray<AndroidEmulatorRecord> = [];
  readonly #recent: AndroidEmulatorEvidence[] = [];
  readonly #active = new Map<
    string,
    {
      readonly controller: AbortController;
      progress: AndroidActionProgress;
    }
  >();
  #paneOpenRequest:
    | {
        readonly requestId: string;
        readonly emulatorId: AndroidEmulatorRecord["emulatorId"];
        readonly requestedAt: string;
        readonly threadId: AndroidExecutionContext["threadId"];
        readonly checkoutId: AndroidExecutionContext["checkoutId"];
      }
    | undefined;
  readonly #artifacts = new Map<string, { readonly bytes: Uint8Array; readonly threadId: string }>();

  constructor(options: AndroidToolchainServiceOptions) {
    this.#options = options;
    this.#access = options.access ?? ((path) => access(path));
  }

  async discover(
    request: AndroidDiscoveryRequest,
    context: AndroidExecutionContext,
  ): Promise<AndroidDiscoveryResult> {
    const sdk = await this.#discoverSdk();
    this.#sdk = sdk;
    if (!sdk.available || sdk.emulatorPath === undefined || sdk.adbPath === undefined) {
      this.#emulators = [];
      this.#options.observeEmulators?.([]);
      this.#sequence += 1;
      return {
        kind: "failure",
        failure: {
          category: "sdk-not-found",
          message:
            "The Android SDK is unavailable on this host. Install platform-tools and an emulator, then retry.",
        },
      };
    }
    const listed = await this.#command(
      [sdk.emulatorPath, "-list-avds"],
      context,
      30_000,
    );
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
    this.#emulators = emulators;
    this.#options.observeEmulators?.(emulators);
    this.#sequence += 1;
    return { kind: "discovered", sdk, emulators };
  }

  async execute(
    request: AndroidEmulatorRequest,
    context: AndroidExecutionContext,
  ): Promise<AndroidEmulatorEvidence> {
    const startedAt = this.#options.now();
    if (isAndroidEmulatorInputKind(request.kind) || isAndroidEmulatorOpenInputKind(request.kind)) {
      const prior = this.#findCompleted(request);
      if (prior !== undefined) return prior;
    }
    const decision = evaluateAndroidEmulatorRequest(request, context, this.#emulators, this.#sdk);
    if (decision.kind === "denied") {
      return this.#record(deniedEvidence(request, decision.reason, startedAt, this.#options.now()));
    }
    const controller = new AbortController();
    this.#activate(request, controller);
    try {
      return this.#record(await this.#run(request, context, controller.signal, startedAt));
    } finally {
      this.#active.delete(String(request.actionId));
    }
  }

  async cancel(
    cancellation: ToolActionCancellation,
    _context: AndroidExecutionContext,
  ): Promise<boolean> {
    const active = this.#active.get(String(cancellation.actionId));
    if (active === undefined) return false;
    active.controller.abort();
    return true;
  }

  snapshot(context: AndroidExecutionContext): AndroidRuntimeSnapshot {
    const pane = this.#paneOpenRequest;
    return decodeAndroidRuntimeSnapshot({
      sequence: this.#sequence,
      snapshotAt: this.#options.now(),
      sdk: this.#sdk,
      emulators: this.#emulators,
      active: [...this.#active.values()].map((entry) => entry.progress),
      recentEvidence: this.#recent.slice(-MAX_RECENT),
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
    this.#paneOpenRequest = {
      requestId: this.#options.newId(),
      emulatorId,
      requestedAt: this.#options.now(),
      threadId: context.threadId,
      checkoutId: context.checkoutId,
    };
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
    const stored = this.#artifacts.get(reference);
    if (stored !== undefined) {
      if (stored.threadId !== String(context.threadId)) {
        return { kind: "unauthorized", message: "That screenshot does not belong to this thread." };
      }
      return { kind: "found", bytes: stored.bytes };
    }
    const bytes = await this.#options.readArtifact(reference);
    if (bytes === undefined) {
      return { kind: "unavailable", message: "That screenshot is not available." };
    }
    return { kind: "found", bytes };
  }

  async close(): Promise<void> {
    for (const active of this.#active.values()) active.controller.abort();
    this.#active.clear();
  }

  async watchScreen(
    emulatorId: string,
    context: AndroidExecutionContext,
    signal: AbortSignal,
  ): Promise<AndroidScreenWatch | { readonly kind: "unavailable"; readonly message: string }> {
    const emulator = this.#emulators.find((candidate) => String(candidate.emulatorId) === emulatorId);
    if (emulator === undefined || emulator.state !== "booted" || emulator.serial === undefined) {
      return { kind: "unavailable", message: "That emulator is not booted." };
    }
    const adb = this.#sdk.adbPath;
    if (adb === undefined) {
      return { kind: "unavailable", message: "adb is unavailable on this host." };
    }
    const first = await this.#screencap(adb, emulator.serial, context, signal);
    if (first === undefined) {
      return { kind: "unavailable", message: "The emulator screen could not be captured." };
    }
    const size = pngSize(first);
    if (size === undefined) {
      return { kind: "unavailable", message: "The emulator screen capture was not a PNG." };
    }
    const serial = emulator.serial;
    let last = first;
    const frames = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(lengthPrefixed(first));
        const tick = async () => {
          while (!signal.aborted) {
            await sleep(SCREEN_POLL_MS, signal);
            if (signal.aborted) break;
            const next = await this.#screencap(adb, serial, context, signal);
            if (next === undefined) continue;
            if (sameBytes(next, last)) continue;
            last = next;
            try {
              controller.enqueue(lengthPrefixed(next));
            } catch {
              break;
            }
          }
          try {
            controller.close();
          } catch {
            // Already closed.
          }
        };
        void tick();
      },
      cancel: () => undefined,
    });
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
      const ready = await this.#waitUntilBooted(request.emulatorId, context, request.timeoutMs, signal);
      this.#setState(request.emulatorId, ready ? "booted" : "shutdown");
      return await this.#logged(
        request,
        ready ? "succeeded" : signal.aborted ? "cancelled" : "timed-out",
        startedAt,
        [{ severity: "note", message: ready ? "emulator booted" : "emulator did not become ready" }],
        "complete",
      );
    }
    if (adb === undefined) return await this.#unavailable(request, startedAt, "adb");
    const serial = this.#serialOf(request.emulatorId);
    if (request.kind === "shutdown") {
      const target = serial ?? "emulator-5554";
      const result = await this.#command(
        [adb, "-s", target, "emu", "kill"],
        context,
        request.timeoutMs,
        signal,
      );
      if (succeeded(result)) this.#setState(request.emulatorId, "shutdown", true);
      return await this.#fromProcess(request, result, startedAt);
    }
    if (serial === undefined) {
      return deniedEvidence(request, "destination-not-booted", startedAt, this.#options.now());
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
    if (!succeeded(result) || result.stdout.byteLength < 24) return undefined;
    return result.stdout;
  }

  async #command(
    argv: ReadonlyArray<string>,
    context: AndroidExecutionContext,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<AndroidProcessResult> {
    return await this.#options.execute(
      {
        argv,
        cwd: context.checkoutRoot,
        environment: androidEnv(this.#options.environment?.() ?? {}, this.#sdk),
        timeoutMs,
      },
      signal,
    );
  }

  #activate(request: AndroidEmulatorRequest, controller: AbortController) {
    const progress: AndroidActionProgress = {
      actionId: request.actionId,
      correlationId: request.correlationId,
      authority: request.authority,
      kind: request.kind,
      state: "running",
      step: stepFor(request.kind),
      sequence: 1,
      updatedAt: this.#options.now(),
    };
    const active = { controller, progress };
    this.#active.set(String(request.actionId), active);
    return active;
  }

  #findCompleted(request: AndroidEmulatorRequest): AndroidEmulatorEvidence | undefined {
    for (let index = this.#recent.length - 1; index >= 0; index -= 1) {
      const entry = this.#recent[index];
      if (entry === undefined) continue;
      if (String(entry.actionId) !== String(request.actionId)) continue;
      if (entry.kind !== request.kind) continue;
      return replayedFrom(entry);
    }
    return undefined;
  }

  #record(value: AndroidEmulatorEvidence): AndroidEmulatorEvidence {
    this.#recent.push(value);
    if (this.#recent.length > MAX_RECENT) this.#recent.splice(0, this.#recent.length - MAX_RECENT);
    this.#sequence += 1;
    return value;
  }

  async #storeArtifact(
    reference: string,
    bytes: Uint8Array,
    context: AndroidExecutionContext,
  ): Promise<void> {
    this.#artifacts.set(reference, { bytes, threadId: String(context.threadId) });
    await this.#options.writeArtifact(reference, bytes);
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
    );
    return evidence(request, outcome, startedAt, this.#options.now(), diagnostics, [
      { kind: "log", reference },
    ], cleanup);
  }

  async #fromProcess(
    request: AndroidEmulatorRequest,
    result: AndroidProcessResult,
    startedAt: string,
  ): Promise<AndroidEmulatorEvidence> {
    const message = text(result.stderr).trim() || text(result.stdout).trim() || `${request.kind} ${outcomeFor(result)}`;
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
    return [adb, "-s", serial, "shell", "input", "tap", String(Math.round(request.point.x)), String(Math.round(request.point.y))];
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
  return value.replaceAll(" ", "%s").replaceAll("'", "\\'");
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
  return evidence(request, outcome, startedAt, completedAt, [
    { severity: "note", message: reason },
  ], [], "not-required");
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

function pngSize(bytes: Uint8Array): { readonly width: number; readonly height: number } | undefined {
  if (bytes.byteLength < 24) return undefined;
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function lengthPrefixed(frame: Uint8Array): Uint8Array {
  const bounded = frame.byteLength > MAXIMUM_FRAME_BYTES ? frame.slice(0, MAXIMUM_FRAME_BYTES) : frame;
  const out = new Uint8Array(4 + bounded.byteLength);
  new DataView(out.buffer).setUint32(0, bounded.byteLength);
  out.set(bounded, 4);
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
    const timer = setTimeout(resolveSleep, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolveSleep();
      },
      { once: true },
    );
  });
}
