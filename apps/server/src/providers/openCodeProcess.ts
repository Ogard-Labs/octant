import { spawn, type ChildProcessByStdio } from "node:child_process";
import { constants, accessSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";
import type { ProviderFailure } from "@octant/contracts";
import { Effect, type Scope } from "effect";
import { childProcessEnvironment } from "../childProcessEnvironment";
import type { ProviderProcessStartedListener } from "./providerRuntimeRegistry";

export interface OpenCodeBinaryProbe {
  readonly binaryPath: string;
  readonly version: string;
}

export interface OpenCodeServerConnection {
  readonly authorization: string;
  readonly pid: number;
  readonly url: URL;
}

export interface OpenCodeProcessStartInput {
  readonly binaryPath: string;
  readonly cwd: string;
}

export interface OpenCodeProcessPort {
  readonly start: (
    input: OpenCodeProcessStartInput & {
      readonly onProcessStarted?: ProviderProcessStartedListener;
    },
  ) => Effect.Effect<OpenCodeServerConnection, ProviderFailure, Scope.Scope>;
}

export interface OpenCodeProcessOptions {
  readonly inheritedEnvironment?: NodeJS.ProcessEnv;
  readonly onDiagnostic?: (message: string) => void;
  readonly shutdownTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
}

export interface OpenCodeProcessDependencies {
  readonly terminateProcessGroup?: (pid: number) => Promise<void>;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const VERSION_TIMEOUT_MS = 5_000;
const VERSION_PATTERN = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\r?\n?$/;
const READINESS_PATTERN = /^opencode server listening on (http:\/\/[^\s]+)$/;

type OpenCodeChild = ChildProcessByStdio<null, Readable, Readable>;

interface ResolvedOpenCodeProcessOptions {
  readonly inheritedEnvironment: NodeJS.ProcessEnv | undefined;
  readonly onDiagnostic: ((message: string) => void) | undefined;
  readonly shutdownTimeoutMs: number;
  readonly startupTimeoutMs: number;
  readonly terminateProcessGroup: ((pid: number) => Promise<void>) | undefined;
}

interface ManagedOpenCodeServer {
  readonly connection: OpenCodeServerConnection;
  readonly terminate: () => Promise<void>;
}

function failure(category: ProviderFailure["category"], message: string): ProviderFailure {
  return { category, message };
}

function validateBinaryPath(binaryPath: string): ProviderFailure | undefined {
  if (!isAbsolute(binaryPath)) {
    return failure("invalid-configuration", "OpenCode binary path must be absolute.");
  }

  try {
    const metadata = statSync(binaryPath);
    accessSync(binaryPath, constants.X_OK);
    if (!metadata.isFile()) throw new Error("not a file");
  } catch {
    return failure(
      "invalid-configuration",
      "OpenCode binary path must reference an executable file.",
    );
  }

  return undefined;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processGroupExists(child: OpenCodeChild): boolean {
  if (child.pid === undefined) return false;
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function signalProcessGroup(child: OpenCodeChild, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForProcessGroupExit(child: OpenCodeChild, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(child) && Date.now() < deadline) await wait(10);
  return !processGroupExists(child);
}

function makeProcessTerminator(
  child: OpenCodeChild,
  shutdownTimeoutMs: number,
  terminateProcessGroup?: (pid: number) => Promise<void>,
): () => Promise<void> {
  let termination: Promise<void> | undefined;
  return () => {
    termination ??= (async () => {
      if (terminateProcessGroup !== undefined && child.pid !== undefined) {
        await terminateProcessGroup(child.pid);
        return;
      }
      if (!processGroupExists(child)) return;
      signalProcessGroup(child, "SIGTERM");
      if (await waitForProcessGroupExit(child, shutdownTimeoutMs)) return;
      signalProcessGroup(child, "SIGKILL");
      if (!(await waitForProcessGroupExit(child, shutdownTimeoutMs))) {
        throw new Error("OpenCode process group did not terminate after SIGKILL.");
      }
    })();
    return termination;
  };
}

function cleanupFailure(): ProviderFailure {
  return failure("provider-failed", "OpenCode process cleanup failed.");
}

function cleanupDefect(terminate: () => Promise<void>): Effect.Effect<void> {
  return Effect.tryPromise({
    try: terminate,
    catch: () => new Error("OpenCode process cleanup failed."),
  }).pipe(Effect.orDie);
}

function safeDiagnostic(handler: OpenCodeProcessOptions["onDiagnostic"], message: string): void {
  try {
    handler?.(message);
  } catch {
    // Diagnostics cannot affect provider lifecycle or expose the suppressed process output.
  }
}

export function probeOpenCodeBinary(
  binaryPath: string,
  onProcessStarted?: ProviderProcessStartedListener,
): Effect.Effect<OpenCodeBinaryProbe, ProviderFailure> {
  const invalid = validateBinaryPath(binaryPath);
  if (invalid !== undefined) return Effect.fail(invalid);

  return Effect.async<OpenCodeBinaryProbe, ProviderFailure>((resume) => {
    const child = spawn(binaryPath, ["--version"], {
      detached: process.platform !== "win32",
      env: childProcessEnvironment(process.env),
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
    if (child.pid !== undefined && onProcessStarted !== undefined) {
      ownershipReady = onProcessStarted({ pid: child.pid, exited: childExited }).then(
        () => undefined,
      );
      void ownershipReady.catch(() => undefined);
    }
    const terminate = makeProcessTerminator(child, 250);
    let output = "";
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onOutput);
      child.stderr.off("data", onOutput);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const finish = (result: Effect.Effect<OpenCodeBinaryProbe, ProviderFailure>) => {
      if (settled) return;
      settled = true;
      cleanup();
      void terminate().then(
        async () => {
          try {
            await ownershipReady;
            resume(result);
          } catch {
            if (childExitedObserved) resume(result);
            else
              resume(
                Effect.fail(failure("provider-failed", "OpenCode process receipt is unavailable.")),
              );
          }
        },
        () => resume(Effect.fail(cleanupFailure())),
      );
    };
    const onOutput = (chunk: Buffer) => {
      if (output.length < 4_096) output += chunk.toString("utf8", 0, 4_096 - output.length);
    };
    const onError = () =>
      finish(
        Effect.fail(failure("unavailable", "OpenCode binary could not be started for probing.")),
      );
    const onExit = (code: number | null) => {
      if (code !== 0) {
        finish(Effect.fail(failure("unavailable", "OpenCode binary probe did not succeed.")));
        return;
      }
      const version = VERSION_PATTERN.exec(output)?.[1];
      finish(
        version === undefined
          ? Effect.fail(failure("protocol", "OpenCode binary returned an unrecognized version."))
          : Effect.succeed({ binaryPath, version }),
      );
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      finish(Effect.fail(failure("unavailable", "OpenCode binary probe timed out.")));
    }, VERSION_TIMEOUT_MS);

    child.stdout.on("data", onOutput);
    child.stderr.on("data", onOutput);
    child.once("error", onError);
    child.once("exit", onExit);

    return cleanupDefect(async () => {
      cleanup();
      await terminate();
    });
  });
}

function acquireOpenCodeServer(
  input: OpenCodeProcessStartInput,
  options: ResolvedOpenCodeProcessOptions,
  onProcessStarted?: ProviderProcessStartedListener,
): Effect.Effect<ManagedOpenCodeServer, ProviderFailure> {
  const invalid = validateBinaryPath(input.binaryPath);
  if (invalid !== undefined) return Effect.fail(invalid);

  return Effect.async<ManagedOpenCodeServer, ProviderFailure>((resume) => {
    const password = randomBytes(32).toString("base64url");
    const authorization = `Basic ${Buffer.from(`octant:${password}`).toString("base64")}`;
    const child = spawn(input.binaryPath, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: input.cwd,
      detached: process.platform !== "win32",
      env: {
        ...childProcessEnvironment(options.inheritedEnvironment ?? process.env),
        OPENCODE_SERVER_USERNAME: "octant",
        OPENCODE_SERVER_PASSWORD: password,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const childExited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    let ownershipReady: Promise<void> = Promise.resolve();
    if (child.pid !== undefined && onProcessStarted !== undefined) {
      ownershipReady = onProcessStarted({ pid: child.pid, exited: childExited }).then(
        () => undefined,
      );
      void ownershipReady.catch(() => undefined);
    }
    const terminate = makeProcessTerminator(
      child,
      options.shutdownTimeoutMs,
      options.terminateProcessGroup,
    );
    let settled = false;
    let stdout = "";
    let stderr = "";

    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const finishFailure = (providerFailure: ProviderFailure) => {
      if (settled) return;
      settled = true;
      cleanup();
      void terminate().then(
        () => resume(Effect.fail(providerFailure)),
        () => resume(Effect.fail(cleanupFailure())),
      );
    };
    const acceptLine = (line: string) => {
      const match = READINESS_PATTERN.exec(line);
      if (match === null) return;
      let url: URL;
      try {
        url = new URL(match[1]!);
      } catch {
        finishFailure(failure("protocol", "OpenCode server reported invalid readiness data."));
        return;
      }
      if (url.hostname !== "127.0.0.1") {
        finishFailure(
          failure("protocol", "OpenCode server reported a non-loopback readiness endpoint."),
        );
        return;
      }
      if (
        url.protocol !== "http:" ||
        url.username !== "" ||
        url.password !== "" ||
        url.pathname !== "/" ||
        url.search !== "" ||
        url.hash !== "" ||
        url.port === "" ||
        Number(url.port) < 1 ||
        Number(url.port) > 65_535
      ) {
        finishFailure(failure("protocol", "OpenCode server reported invalid readiness data."));
        return;
      }
      if (settled || child.pid === undefined) return;
      settled = true;
      cleanup();
      void ownershipReady.then(
        () =>
          resume(
            Effect.succeed({
              connection: { authorization, pid: child.pid!, url },
              terminate,
            }),
          ),
        () =>
          void terminate().then(
            () =>
              resume(
                Effect.fail(failure("provider-failed", "OpenCode process receipt is unavailable.")),
              ),
            () => resume(Effect.fail(cleanupFailure())),
          ),
      );
    };
    const consumeLines = (source: "stdout" | "stderr", chunk: Buffer) => {
      let pending = source === "stdout" ? stdout : stderr;
      pending += chunk.toString("utf8");
      if (pending.length > 16_384) pending = pending.slice(-16_384);
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        const rawLine = pending.slice(0, newline);
        acceptLine(rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine);
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      if (source === "stdout") stdout = pending;
      else stderr = pending;
    };
    const onStdout = (chunk: Buffer) => consumeLines("stdout", chunk);
    const onStderr = (chunk: Buffer) => consumeLines("stderr", chunk);
    const onError = () => {
      safeDiagnostic(options.onDiagnostic, "OpenCode server failed to start.");
      finishFailure(failure("unavailable", "OpenCode server could not be started."));
    };
    const onExit = () => {
      safeDiagnostic(options.onDiagnostic, "OpenCode server exited before readiness.");
      finishFailure(failure("unavailable", "OpenCode server exited before becoming ready."));
    };
    const timeout = setTimeout(() => {
      safeDiagnostic(options.onDiagnostic, "OpenCode server readiness timed out.");
      finishFailure(
        failure("unavailable", "OpenCode server did not become ready before the startup timeout."),
      );
    }, options.startupTimeoutMs);

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);

    return cleanupDefect(async () => {
      if (!settled) settled = true;
      cleanup();
      await terminate();
    });
  });
}

export function makeOpenCodeProcessLive(
  options: OpenCodeProcessOptions = {},
  dependencies: OpenCodeProcessDependencies = {},
): OpenCodeProcessPort {
  const resolvedOptions = {
    inheritedEnvironment: options.inheritedEnvironment,
    onDiagnostic: options.onDiagnostic,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    terminateProcessGroup: dependencies.terminateProcessGroup,
  };

  return {
    start: (input) =>
      Effect.suspend(() => {
        let terminate: (() => Promise<void>) | undefined;
        return Effect.acquireReleaseInterruptible(
          acquireOpenCodeServer(input, resolvedOptions, input.onProcessStarted).pipe(
            Effect.tap((managed) =>
              Effect.sync(() => {
                terminate = managed.terminate;
              }),
            ),
            Effect.map((managed) => managed.connection),
          ),
          () => (terminate === undefined ? Effect.void : cleanupDefect(terminate)),
        );
      }),
  };
}
