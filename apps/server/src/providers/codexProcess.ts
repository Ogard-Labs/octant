import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute } from "node:path";

import type { ProviderFailure } from "@octant/contracts";
import { Effect, type Scope } from "effect";

import { decodeInitializeResult } from "./codexProtocol";
import {
  CodexRpcClientFailure,
  makeCodexRpcClient,
  type CodexRpcClient,
  type CodexRpcStderrCapture,
} from "./codexRpcClient";
import type { ProviderProcessStartedListener } from "./providerRuntimeRegistry";

export interface CodexBinaryProbe {
  readonly binaryPath: string;
  readonly version: string;
}

export interface CodexAppServerConnection {
  readonly version: string;
  readonly pid: number;
  readonly rpc: CodexRpcClient;
  readonly exited: Promise<void>;
}

export interface CodexProcessPort {
  readonly start: (input: {
    readonly binaryPath: string;
    readonly onProcessStarted?: ProviderProcessStartedListener;
  }) => Effect.Effect<CodexAppServerConnection, ProviderFailure, Scope.Scope>;
}

export interface CodexProbeOptions {
  readonly inheritedEnvironment?: NodeJS.ProcessEnv;
  readonly shutdownTimeoutMs?: number;
  readonly timeoutMs?: number;
  readonly onProcessStarted?: ProviderProcessStartedListener;
}

export interface CodexProcessOptions {
  readonly inheritedEnvironment?: NodeJS.ProcessEnv;
  readonly onDiagnostic?: (message: string) => void;
  readonly octantVersion?: string;
  readonly shutdownTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly stderrBytes?: number;
}

const DEFAULT_OCTANT_VERSION = "0.0.0";
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_VERSION_TIMEOUT_MS = 5_000;
const VERSION_LINE_PATTERN = /^codex-cli ([^\r\n]+)\r?\n?$/;
const SEMVER_CORE_IDENTIFIER_PATTERN = /^(?:0|[1-9]\d*)$/;
const SEMVER_IDENTIFIER_PATTERN = /^[0-9A-Za-z-]+$/;
const SEMVER_NUMERIC_IDENTIFIER_PATTERN = /^\d+$/;
const PROBE_OUTPUT_BYTES = 4_096;

interface ManagedCodexConnection {
  readonly connection: CodexAppServerConnection;
  readonly terminate: () => Promise<void>;
}

interface ResolvedCodexProcessOptions {
  readonly inheritedEnvironment: NodeJS.ProcessEnv | undefined;
  readonly onDiagnostic: ((message: string) => void) | undefined;
  readonly octantVersion: string;
  readonly shutdownTimeoutMs: number;
  readonly startupTimeoutMs: number;
  readonly stderrBytes: number | undefined;
}

function failure(category: ProviderFailure["category"], message: string): ProviderFailure {
  return { category, message };
}

function validateBinaryPath(binaryPath: string): ProviderFailure | undefined {
  if (!isAbsolute(binaryPath)) {
    return failure("invalid-configuration", "Codex binary path must be absolute.");
  }
  try {
    const metadata = statSync(binaryPath);
    accessSync(binaryPath, constants.X_OK);
    if (!metadata.isFile()) throw new Error("not a file");
  } catch {
    return failure("invalid-configuration", "Codex binary path must reference an executable file.");
  }
  return undefined;
}

function parseSemVer(version: string): string | undefined {
  const buildSeparator = version.indexOf("+");
  const coreAndPrerelease = buildSeparator < 0 ? version : version.slice(0, buildSeparator);
  const build = buildSeparator < 0 ? undefined : version.slice(buildSeparator + 1);
  if (build !== undefined) {
    if (build.includes("+")) return undefined;
    const identifiers = build.split(".");
    if (
      identifiers.some(
        (identifier) => identifier === "" || !SEMVER_IDENTIFIER_PATTERN.test(identifier),
      )
    ) {
      return undefined;
    }
  }

  const prereleaseSeparator = coreAndPrerelease.indexOf("-");
  const core =
    prereleaseSeparator < 0 ? coreAndPrerelease : coreAndPrerelease.slice(0, prereleaseSeparator);
  const prerelease =
    prereleaseSeparator < 0 ? undefined : coreAndPrerelease.slice(prereleaseSeparator + 1);
  const coreIdentifiers = core.split(".");
  if (
    coreIdentifiers.length !== 3 ||
    coreIdentifiers.some((identifier) => !SEMVER_CORE_IDENTIFIER_PATTERN.test(identifier))
  ) {
    return undefined;
  }
  if (prerelease !== undefined) {
    const identifiers = prerelease.split(".");
    if (
      identifiers.some(
        (identifier) =>
          identifier === "" ||
          !SEMVER_IDENTIFIER_PATTERN.test(identifier) ||
          (SEMVER_NUMERIC_IDENTIFIER_PATTERN.test(identifier) &&
            identifier.length > 1 &&
            identifier.startsWith("0")),
      )
    ) {
      return undefined;
    }
  }
  return version;
}

function parseCodexVersion(output: string): string | undefined {
  const candidate = VERSION_LINE_PATTERN.exec(output)?.[1];
  return candidate === undefined ? undefined : parseSemVer(candidate);
}

export function sanitizeCodexEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([key, value]) =>
        value !== undefined &&
        !key.startsWith("OCTANT_") &&
        key !== "ELECTRON_RUN_AS_NODE" &&
        key !== "NODE_OPTIONS",
    ),
  );
}

export function codexProcessEnvironment(
  binaryPath: string,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const sanitized = sanitizeCodexEnvironment(environment);
  const binaryDirectory = dirname(binaryPath);
  const path = sanitized.PATH?.split(delimiter).filter(Boolean) ?? [];
  return {
    ...sanitized,
    PATH: [binaryDirectory, ...path.filter((entry) => entry !== binaryDirectory)].join(delimiter),
  };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processGroupExists(child: ChildProcess): boolean {
  if (child.pid === undefined) return false;
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM" && child.exitCode !== null) return false;
    return true;
  }
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForProcessGroupExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(child) && Date.now() < deadline) await wait(10);
  return !processGroupExists(child);
}

function makeProcessTerminator(
  child: ChildProcess,
  shutdownTimeoutMs: number,
): () => Promise<void> {
  let termination: Promise<void> | undefined;
  return () => {
    termination ??= (async () => {
      if (!processGroupExists(child)) return;
      signalProcessGroup(child, "SIGTERM");
      if (await waitForProcessGroupExit(child, shutdownTimeoutMs)) return;
      signalProcessGroup(child, "SIGKILL");
      const forcedShutdownTimeoutMs = Math.min(5_000, Math.max(250, shutdownTimeoutMs * 3));
      if (!(await waitForProcessGroupExit(child, forcedShutdownTimeoutMs))) {
        throw new Error("Codex process group did not terminate after SIGKILL.");
      }
    })();
    return termination;
  };
}

function cleanupEffect(cleanup: () => Promise<void>): Effect.Effect<void> {
  return Effect.tryPromise({
    try: cleanup,
    catch: () => new Error("Codex process cleanup failed."),
  }).pipe(Effect.orDie);
}

function safeDiagnostic(handler: CodexProcessOptions["onDiagnostic"], message: string): void {
  try {
    handler?.(message);
  } catch {
    // Diagnostics cannot affect lifecycle or reveal suppressed process output.
  }
}

export function probeCodexBinary(
  binaryPath: string,
  options: CodexProbeOptions = {},
): Effect.Effect<CodexBinaryProbe, ProviderFailure> {
  const invalid = validateBinaryPath(binaryPath);
  if (invalid !== undefined) return Effect.fail(invalid);

  const timeoutMs = options.timeoutMs ?? DEFAULT_VERSION_TIMEOUT_MS;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;

  return Effect.async<CodexBinaryProbe, ProviderFailure>((resume) => {
    const child = spawn(binaryPath, ["--version"], {
      detached: process.platform !== "win32",
      env: codexProcessEnvironment(binaryPath, options.inheritedEnvironment ?? process.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let childExitedObserved = false;
    const childExited = new Promise<void>((resolveExit) =>
      child.once("exit", () => {
        childExitedObserved = true;
        resolveExit();
      }),
    );
    let ownershipReady: Promise<void> = Promise.resolve();
    if (child.pid !== undefined && options.onProcessStarted !== undefined) {
      ownershipReady = options
        .onProcessStarted({ pid: child.pid, exited: childExited })
        .then(() => undefined);
      void ownershipReady.catch(() => undefined);
    }
    const terminate = makeProcessTerminator(child, shutdownTimeoutMs);
    let output = Buffer.alloc(0);
    let outputOverflow = false;
    let settled = false;

    const cleanupListeners = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onOutput);
      child.stderr.off("data", onOutput);
      child.off("error", onError);
      child.off("close", onClose);
    };
    const finish = (result: Effect.Effect<CodexBinaryProbe, ProviderFailure>) => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      void terminate().then(
        async () => {
          try {
            await ownershipReady;
            resume(result);
          } catch {
            if (childExitedObserved) resume(result);
            else
              resume(
                Effect.fail(failure("provider-failed", "Codex process receipt is unavailable.")),
              );
          }
        },
        () => resume(Effect.fail(failure("provider-failed", "Codex binary probe cleanup failed."))),
      );
    };
    const onOutput = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = PROBE_OUTPUT_BYTES - output.length;
      if (bytes.length > remaining) outputOverflow = true;
      if (remaining > 0) output = Buffer.concat([output, bytes.subarray(0, remaining)]);
    };
    const onError = () =>
      finish(Effect.fail(failure("unavailable", "Codex binary could not be started for probing.")));
    const onClose = (code: number | null) => {
      if (outputOverflow) {
        finish(Effect.fail(failure("protocol", "Codex binary version output exceeded the limit.")));
        return;
      }
      if (code !== 0) {
        finish(Effect.fail(failure("unavailable", "Codex binary probe did not succeed.")));
        return;
      }
      const version = parseCodexVersion(output.toString("utf8"));
      finish(
        version === undefined
          ? Effect.fail(failure("protocol", "Codex binary returned an unrecognized version."))
          : Effect.succeed({ binaryPath, version }),
      );
    };
    const timeout = setTimeout(
      () => finish(Effect.fail(failure("unavailable", "Codex binary probe timed out."))),
      timeoutMs,
    );

    child.stdout.on("data", onOutput);
    child.stderr.on("data", onOutput);
    child.once("error", onError);
    child.once("close", onClose);

    return cleanupEffect(async () => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      await terminate();
    });
  });
}

function acquireCodexAppServer(
  binaryPath: string,
  version: string,
  options: ResolvedCodexProcessOptions,
  onProcessStarted?: ProviderProcessStartedListener,
): Effect.Effect<ManagedCodexConnection, ProviderFailure> {
  return Effect.async<ManagedCodexConnection, ProviderFailure>((resume) => {
    const child = spawn(binaryPath, ["app-server", "--listen", "stdio://"], {
      detached: process.platform !== "win32",
      env: codexProcessEnvironment(binaryPath, options.inheritedEnvironment ?? process.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const terminateGroup = makeProcessTerminator(child, options.shutdownTimeoutMs);
    const rpc = makeCodexRpcClient({
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      limits: {
        requestTimeoutMs: options.startupTimeoutMs,
        ...(options.stderrBytes === undefined ? {} : { stderrBytes: options.stderrBytes }),
      },
      onStderr: (capture) => reportStderr(options.onDiagnostic, capture),
    });
    let settled = false;

    const childExited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    let ownershipReady: Promise<void> = Promise.resolve();
    if (child.pid !== undefined && onProcessStarted !== undefined) {
      ownershipReady = onProcessStarted({ pid: child.pid, exited: childExited }).then(
        () => undefined,
      );
      void ownershipReady.catch(() => undefined);
    }
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () => {
      cleanupPromise ??= (async () => {
        const suppressStdinError = () => undefined;
        const removeStdinErrorSuppression = () => child.stdin.off("error", suppressStdinError);
        child.stdin.on("error", suppressStdinError);
        child.stdin.once("close", removeStdinErrorSuppression);
        const close = rpc.close();
        try {
          await Promise.race([childExited, wait(25)]);
          await terminateGroup();
        } finally {
          child.stdin.destroy();
          await Promise.race([close.catch(() => undefined), wait(options.shutdownTimeoutMs)]);
        }
      })();
      return cleanupPromise;
    };
    const exited = Promise.race([
      childExited.then(() => ({ kind: "child" as const })),
      rpc.exited.then(
        () => ({ kind: "rpc" as const }),
        (error: unknown) => ({ kind: "rpc-failure" as const, error }),
      ),
    ]).then(async (result) => {
      if (result.kind === "child") return;
      await cleanup();
      if (result.kind === "rpc-failure") throw result.error;
    });
    void exited.catch(() => undefined);
    const finishFailure = (providerFailure: ProviderFailure) => {
      if (settled) return;
      settled = true;
      child.off("error", onError);
      child.off("exit", onEarlyExit);
      void cleanup().then(
        () => resume(Effect.fail(providerFailure)),
        () => resume(Effect.fail(failure("provider-failed", "Codex process cleanup failed."))),
      );
    };
    const onError = () =>
      finishFailure(failure("unavailable", "Codex app-server could not be started."));
    const onEarlyExit = () =>
      finishFailure(failure("unavailable", "Codex app-server exited before initialization."));

    child.once("error", onError);
    child.once("exit", onEarlyExit);

    void (async () => {
      try {
        await ownershipReady;
        await rpc.request(
          "initialize",
          {
            clientInfo: {
              name: "Octant",
              title: "Octant",
              version: options.octantVersion,
            },
            capabilities: { experimentalApi: false, requestAttestation: false },
          },
          decodeInitializeResult,
        );
        await rpc.notify("initialized");
        if (settled || child.pid === undefined) return;
        settled = true;
        child.off("error", onError);
        child.off("exit", onEarlyExit);
        resume(
          Effect.succeed({
            connection: { version, pid: child.pid, rpc, exited },
            terminate: cleanup,
          }),
        );
      } catch (error) {
        finishFailure(initializationFailure(error));
      }
    })();

    return cleanupEffect(async () => {
      if (!settled) settled = true;
      child.off("error", onError);
      child.off("exit", onEarlyExit);
      await cleanup();
    });
  });
}

function reportStderr(
  handler: CodexProcessOptions["onDiagnostic"],
  capture: CodexRpcStderrCapture,
): void {
  if (capture.capturedBytes === 0) return;
  safeDiagnostic(
    handler,
    `Codex app-server stderr captured (${capture.capturedBytes} bytes${capture.truncated ? ", truncated" : ""}).`,
  );
}

function initializationFailure(error: unknown): ProviderFailure {
  if (error instanceof CodexRpcClientFailure && error.kind === "timeout") {
    return failure(
      "unavailable",
      "Codex app-server did not initialize before the startup timeout.",
    );
  }
  if (error instanceof CodexRpcClientFailure && error.kind === "protocol") {
    return failure("protocol", "Codex app-server initialization response was invalid.");
  }
  return failure("unavailable", "Codex app-server initialization failed.");
}

export function makeCodexProcessLive(options: CodexProcessOptions = {}): CodexProcessPort {
  const resolved = {
    inheritedEnvironment: options.inheritedEnvironment,
    onDiagnostic: options.onDiagnostic,
    octantVersion: options.octantVersion ?? DEFAULT_OCTANT_VERSION,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    stderrBytes: options.stderrBytes,
  };

  return {
    start: ({ binaryPath, onProcessStarted }) =>
      Effect.suspend(() => {
        let terminate: (() => Promise<void>) | undefined;
        return Effect.acquireReleaseInterruptible(
          Effect.gen(function* () {
            const probe = yield* probeCodexBinary(binaryPath, {
              ...(resolved.inheritedEnvironment === undefined
                ? {}
                : { inheritedEnvironment: resolved.inheritedEnvironment }),
              shutdownTimeoutMs: resolved.shutdownTimeoutMs,
              ...(onProcessStarted === undefined ? {} : { onProcessStarted }),
            });
            const managed = yield* acquireCodexAppServer(
              binaryPath,
              probe.version,
              resolved,
              onProcessStarted,
            );
            terminate = managed.terminate;
            return managed.connection;
          }),
          () => (terminate === undefined ? Effect.void : cleanupEffect(terminate)),
        );
      }),
  };
}
