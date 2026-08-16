import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import type {
  Options as ClaudeAgentSdkOptions,
  SpawnedProcess,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import type { ProviderFailure } from "@octant/contracts";
import { Effect } from "effect";

import { sanitizeClaudeEnvironment } from "./claudeEnvironment";
import type { ProviderProcessStartedListener } from "./providerRuntimeRegistry";

export type SpawnClaudeCodeProcess = NonNullable<ClaudeAgentSdkOptions["spawnClaudeCodeProcess"]>;

export interface ClaudeProcessPort {
  readonly probeVersion: (binaryPath: string) => Effect.Effect<string, ProviderFailure>;
  readonly probeSubscription: (
    binaryPath: string,
    environment: NodeJS.ProcessEnv,
  ) => Effect.Effect<"authenticated" | "unauthenticated", ProviderFailure>;
  readonly spawn: SpawnClaudeCodeProcess;
}

export interface ClaudeProcessOptions {
  readonly inheritedEnvironment?: NodeJS.ProcessEnv;
  readonly onDiagnostic?: (message: string) => void;
  readonly probeOutputBytes?: number;
  readonly probeTimeoutMs?: number;
  readonly runtimeStderrBytes?: number;
  readonly shutdownTimeoutMs?: number;
  /** Called for each detached runtime child so the server can persist ownership. */
  readonly onProcessStarted?: ProviderProcessStartedListener;
}

const DEFAULT_PROBE_OUTPUT_BYTES = 4_096;
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_RUNTIME_STDERR_BYTES = 4_096;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;
const VERSION_PATTERN = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?: \(Claude Code\))?\r?\n?$/;

type ProbeKind = "authentication" | "version";

interface ResolvedClaudeProcessOptions {
  readonly inheritedEnvironment: NodeJS.ProcessEnv;
  readonly onDiagnostic: ((message: string) => void) | undefined;
  readonly probeOutputBytes: number;
  readonly probeTimeoutMs: number;
  readonly runtimeStderrBytes: number;
  readonly shutdownTimeoutMs: number;
  readonly onProcessStarted: ClaudeProcessOptions["onProcessStarted"];
}

interface BoundedCapture {
  readonly bytes: Buffer;
  readonly overflow: boolean;
}

function failure(category: ProviderFailure["category"], message: string): ProviderFailure {
  return { category, message };
}

function validateBinaryPath(binaryPath: string): ProviderFailure | undefined {
  if (!isAbsolute(binaryPath)) {
    return failure("invalid-configuration", "Claude binary path must be absolute.");
  }
  try {
    const metadata = statSync(binaryPath);
    accessSync(binaryPath, constants.X_OK);
    if (!metadata.isFile()) throw new Error("not a file");
  } catch {
    return failure(
      "invalid-configuration",
      "Claude binary path must reference an executable file.",
    );
  }
  return undefined;
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
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
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
): (initialSignal?: NodeJS.Signals) => Promise<void> {
  let termination: Promise<void> | undefined;
  return (initialSignal = "SIGTERM") => {
    termination ??= (async () => {
      if (!processGroupExists(child)) return;
      signalProcessGroup(child, initialSignal);
      if (initialSignal === "SIGKILL") {
        if (!(await waitForProcessGroupExit(child, shutdownTimeoutMs))) {
          throw new Error("Claude process group did not terminate after SIGKILL.");
        }
        return;
      }
      if (await waitForProcessGroupExit(child, shutdownTimeoutMs)) return;
      signalProcessGroup(child, "SIGKILL");
      if (!(await waitForProcessGroupExit(child, shutdownTimeoutMs))) {
        throw new Error("Claude process group did not terminate after SIGKILL.");
      }
    })();
    return termination;
  };
}

function cleanupEffect(cleanup: () => Promise<void>): Effect.Effect<void> {
  return Effect.tryPromise({
    try: cleanup,
    catch: () => new Error("Claude process cleanup failed."),
  }).pipe(Effect.orDie);
}

function safeDiagnostic(handler: ClaudeProcessOptions["onDiagnostic"], message: string): void {
  try {
    handler?.(message);
  } catch {
    // Diagnostics cannot affect lifecycle or expose suppressed process output.
  }
}

function captureChunk(
  current: BoundedCapture,
  chunk: Buffer | string,
  limit: number,
): BoundedCapture {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = Math.max(0, limit - current.bytes.length);
  return {
    bytes:
      remaining === 0
        ? current.bytes
        : Buffer.concat([current.bytes, bytes.subarray(0, remaining)]),
    overflow: current.overflow || bytes.length > remaining,
  };
}

function parseAuthenticationStatus(
  output: string,
): "authenticated" | "unauthenticated" | undefined {
  try {
    const value: unknown = JSON.parse(output);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const loggedIn = (value as { readonly loggedIn?: unknown }).loggedIn;
    return loggedIn === true ? "authenticated" : loggedIn === false ? "unauthenticated" : undefined;
  } catch {
    return undefined;
  }
}

function runProbe(
  binaryPath: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  kind: "authentication",
  options: ResolvedClaudeProcessOptions,
): Effect.Effect<"authenticated" | "unauthenticated", ProviderFailure>;
function runProbe(
  binaryPath: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  kind: "version",
  options: ResolvedClaudeProcessOptions,
): Effect.Effect<string, ProviderFailure>;
function runProbe(
  binaryPath: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  kind: ProbeKind,
  options: ResolvedClaudeProcessOptions,
): Effect.Effect<string, ProviderFailure> {
  const invalid = validateBinaryPath(binaryPath);
  if (invalid !== undefined) return Effect.fail(invalid);

  return Effect.async<string, ProviderFailure>((resume) => {
    const child = spawn(binaryPath, args, {
      detached: process.platform !== "win32",
      env: environment,
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
    const terminate = makeProcessTerminator(child, options.shutdownTimeoutMs);
    let stdout: BoundedCapture = { bytes: Buffer.alloc(0), overflow: false };
    let stderr: BoundedCapture = { bytes: Buffer.alloc(0), overflow: false };
    let settled = false;
    let cleanupPromise: Promise<void> | undefined;

    const cleanupListeners = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("close", onClose);
    };
    const cleanupProcess = () => {
      cleanupPromise ??= terminate();
      return cleanupPromise;
    };
    const finish = (result: Effect.Effect<string, ProviderFailure>) => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      void cleanupProcess().then(
        async () => {
          try {
            await ownershipReady;
            resume(result);
          } catch {
            if (childExitedObserved) resume(result);
            else
              resume(
                Effect.fail(failure("provider-failed", "Claude process receipt is unavailable.")),
              );
          }
        },
        () => resume(Effect.fail(failure("provider-failed", "Claude probe cleanup failed."))),
      );
    };
    const onStdout = (chunk: Buffer | string) => {
      stdout = captureChunk(stdout, chunk, options.probeOutputBytes);
    };
    const onStderr = (chunk: Buffer | string) => {
      stderr = captureChunk(stderr, chunk, options.probeOutputBytes);
    };
    const onError = () =>
      finish(Effect.fail(failure("unavailable", `Claude ${kind} probe could not be started.`)));
    const onClose = (code: number | null) => {
      if (stdout.overflow || stderr.overflow) {
        finish(Effect.fail(failure("protocol", `Claude ${kind} probe output exceeded the limit.`)));
        return;
      }
      if (kind === "version") {
        if (code !== 0) {
          finish(Effect.fail(failure("unavailable", "Claude version probe did not succeed.")));
          return;
        }
        const version = VERSION_PATTERN.exec(stdout.bytes.toString("utf8"))?.[1];
        finish(
          version === undefined
            ? Effect.fail(failure("protocol", "Claude binary returned an unrecognized version."))
            : Effect.succeed(version),
        );
        return;
      }

      const status = parseAuthenticationStatus(stdout.bytes.toString("utf8"));
      if (
        status === undefined ||
        (status === "authenticated" && code !== 0) ||
        (status === "unauthenticated" && code !== 1)
      ) {
        finish(
          Effect.fail(failure("protocol", "Claude authentication status response was invalid.")),
        );
        return;
      }
      finish(Effect.succeed(status));
    };
    const timeout = setTimeout(
      () => finish(Effect.fail(failure("unavailable", `Claude ${kind} probe timed out.`))),
      options.probeTimeoutMs,
    );

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("close", onClose);

    return cleanupEffect(async () => {
      if (!settled) {
        settled = true;
        cleanupListeners();
      }
      await cleanupProcess();
    });
  });
}

function spawnOwnedClaudeProcess(
  spawnOptions: SpawnOptions,
  options: ResolvedClaudeProcessOptions,
): SpawnedProcess {
  const invalid = validateBinaryPath(spawnOptions.command);
  if (invalid !== undefined) throw new Error(invalid.message);
  const credentials = [
    spawnOptions.env.ANTHROPIC_API_KEY,
    spawnOptions.env.ANTHROPIC_AUTH_TOKEN,
    spawnOptions.env.CLAUDE_CODE_OAUTH_TOKEN,
  ].filter((credential): credential is string => credential !== undefined && credential.length > 0);
  if (credentials.some((credential) => spawnOptions.args.some((arg) => arg.includes(credential)))) {
    throw new Error("Claude process arguments must not contain credentials.");
  }

  const child = spawn(spawnOptions.command, spawnOptions.args, {
    cwd: spawnOptions.cwd,
    detached: process.platform !== "win32",
    env: spawnOptions.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events = new EventEmitter();
  const terminate = makeProcessTerminator(child, options.shutdownTimeoutMs);
  let cleanupComplete = false;
  let terminationRequested = false;
  let stderrBytes = 0;
  let stderrTruncated = false;
  let diagnosticReported = false;
  let stderrClosed = false;
  let resolveStderrClosed: () => void = () => undefined;
  const stderrClosedPromise = new Promise<void>((resolve) => {
    resolveStderrClosed = resolve;
  });

  const reportStderr = () => {
    if (diagnosticReported || stderrBytes === 0) return;
    diagnosticReported = true;
    safeDiagnostic(
      options.onDiagnostic,
      `Claude runtime stderr captured (${stderrBytes} bytes${stderrTruncated ? ", truncated" : ""}).`,
    );
  };
  const onStderr = (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
    const captured = Math.min(bytes, Math.max(0, options.runtimeStderrBytes - stderrBytes));
    stderrBytes += captured;
    if (captured < bytes) stderrTruncated = true;
  };
  const requestTermination = (signal: NodeJS.Signals = "SIGTERM") => {
    const existed = processGroupExists(child);
    terminationRequested = terminationRequested || existed;
    void terminate(signal).catch(() => undefined);
    return existed;
  };
  const onAbort = () => requestTermination("SIGTERM");
  const onChildExit = (code: number | null, signal: NodeJS.Signals | null) => {
    spawnOptions.signal.removeEventListener("abort", onAbort);
    void terminate("SIGTERM")
      .then(async () => {
        if (!stderrClosed) await stderrClosedPromise;
        cleanupComplete = true;
        events.emit("exit", code, signal);
        resolveExited();
      })
      .catch(() => {
        cleanupComplete = true;
        events.emit("error", new Error("Claude process cleanup failed."));
        events.emit("exit", code, signal);
        resolveExited();
      });
  };

  let resolveExited: () => void = () => undefined;
  const exited = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });

  child.stderr.on("data", onStderr);
  child.stderr.once("close", () => {
    let pending: Buffer | string | null = child.stderr.read();
    while (pending !== null) {
      onStderr(pending);
      pending = child.stderr.read();
    }
    stderrClosed = true;
    reportStderr();
    resolveStderrClosed();
  });
  child.once("error", (error) => events.emit("error", error));
  child.once("exit", onChildExit);
  spawnOptions.signal.addEventListener("abort", onAbort, { once: true });
  if (spawnOptions.signal.aborted) requestTermination("SIGTERM");
  if (child.pid !== undefined) {
    try {
      void Promise.resolve(options.onProcessStarted?.({ pid: child.pid, exited })).catch(() => {
        requestTermination("SIGTERM");
      });
    } catch {
      requestTermination("SIGTERM");
    }
  }

  return {
    stdin: child.stdin,
    stdout: child.stdout,
    get killed() {
      return terminationRequested || child.killed;
    },
    get exitCode() {
      return cleanupComplete ? child.exitCode : null;
    },
    get signalCode() {
      return cleanupComplete ? child.signalCode : null;
    },
    kill: requestTermination,
    on(event, listener) {
      events.on(event, listener);
    },
    once(event, listener) {
      events.once(event, listener);
    },
    off(event, listener) {
      events.off(event, listener);
    },
  };
}

export function makeClaudeProcessLive(options: ClaudeProcessOptions = {}): ClaudeProcessPort {
  const resolved: ResolvedClaudeProcessOptions = {
    inheritedEnvironment: options.inheritedEnvironment ?? process.env,
    onDiagnostic: options.onDiagnostic,
    probeOutputBytes: options.probeOutputBytes ?? DEFAULT_PROBE_OUTPUT_BYTES,
    probeTimeoutMs: options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    runtimeStderrBytes: options.runtimeStderrBytes ?? DEFAULT_RUNTIME_STDERR_BYTES,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    onProcessStarted: options.onProcessStarted,
  };

  return {
    probeVersion: (binaryPath) =>
      runProbe(
        binaryPath,
        ["--version"],
        sanitizeClaudeEnvironment("subscription", resolved.inheritedEnvironment),
        "version",
        resolved,
      ),
    probeSubscription: (binaryPath, environment) =>
      runProbe(binaryPath, ["auth", "status", "--json"], environment, "authentication", resolved),
    spawn: (spawnOptions) => spawnOwnedClaudeProcess(spawnOptions, resolved),
  };
}
