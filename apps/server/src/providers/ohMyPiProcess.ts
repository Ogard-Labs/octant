import { execFile, spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { ProviderFailure } from "@octant/contracts";
import { Effect, type Scope } from "effect";
import { makePiRpcClient, type PiRpcClient } from "./piRpcClient";
import type { ProviderProcessStartedListener } from "./providerRuntimeRegistry";

/**
 * Oh My Pi is intentionally distinct from the Pi driver. It uses the same
 * newline-delimited RPC transport family, but version/binary/identity pins and
 * fail-closed authority defaults are owned by this adapter.
 */

export interface OhMyPiRpcConnection {
  readonly version: string;
  readonly protocolVersion: number;
  readonly supportedProtocolVersions: readonly number[];
  readonly pid: number;
  readonly rpc: PiRpcClient;
  readonly exited: Promise<void>;
}

export interface OhMyPiProcessPort {
  readonly startProbe: (input: {
    readonly binaryPath: string;
    readonly managedHome: string;
    readonly supportedVersion: string;
    readonly onProcessStarted?: ProviderProcessStartedListener;
  }) => Effect.Effect<OhMyPiRpcConnection, ProviderFailure, Scope.Scope>;
}

export interface OhMyPiProcessOptions {
  readonly inheritedEnvironment?: NodeJS.ProcessEnv;
  readonly shutdownTimeoutMs?: number;
  readonly versionTimeoutMs?: number;
  readonly readyTimeoutMs?: number;
}

const SAFE_ENVIRONMENT = new Set([
  "COLORTERM",
  "LANG",
  "LANGUAGE",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
]);

function failure(category: ProviderFailure["category"], message: string): ProviderFailure {
  return { category, message };
}

export function sanitizeOhMyPiEnvironment(
  host: NodeJS.ProcessEnv,
  managedHome: string,
): NodeJS.ProcessEnv {
  return Object.fromEntries([
    ...Object.entries(host).filter(
      ([key, value]) => value !== undefined && (SAFE_ENVIRONMENT.has(key) || key.startsWith("LC_")),
    ),
    ["HOME", managedHome],
    ["NO_COLOR", "1"],
    // Keep Oh My Pi state isolated from the user's interactive OMP profile.
    ["OMP_HOME", managedHome],
  ]);
}

export function ohMyPiProbeArguments(): ReadonlyArray<string> {
  return [
    "--mode",
    "rpc",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-tools",
    "--no-lsp",
    "--profile",
    "octant-oh-my-pi-probe",
  ];
}

function validateBinary(binaryPath: string): ProviderFailure | undefined {
  if (!isAbsolute(binaryPath) || resolve(binaryPath) !== binaryPath) {
    return failure(
      "invalid-configuration",
      "Oh My Pi binary path must be absolute and normalized.",
    );
  }
  try {
    if (!statSync(binaryPath).isFile()) throw new Error();
    accessSync(binaryPath, constants.X_OK);
  } catch {
    return failure(
      "invalid-configuration",
      "Oh My Pi binary path must reference an executable file.",
    );
  }
  return undefined;
}

function inspectVersion(
  binaryPath: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolveVersion, reject) => {
    execFile(
      binaryPath,
      ["--version"],
      { env: environment, timeout: timeoutMs, maxBuffer: 1024 },
      (error, stdout) => {
        const version = stdout.trim().replace(/^omp\//, "");
        if (error !== null || !/^\d+\.\d+\.\d+$/.test(version)) reject(new Error());
        else resolveVersion(version);
      },
    );
  });
}

async function readReadyFrame(
  stdout: NodeJS.ReadableStream,
  timeoutMs: number,
): Promise<{
  readonly protocolVersion: number;
  readonly supportedProtocolVersions: readonly number[];
}> {
  return await new Promise((resolveReady, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("ready-timeout"));
    }, timeoutMs);
    const onData = (chunk: Buffer | string) => {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) {
        if (buffer.length > 1_048_576) {
          cleanup();
          reject(new Error("ready-invalid"));
        }
        return;
      }
      const line = buffer.subarray(0, newline).toString("utf8");
      // Put remaining bytes back for the RPC client by unshifting via pause/unshift.
      const rest = buffer.subarray(newline + 1);
      cleanup();
      if (typeof (stdout as NodeJS.ReadStream).unshift === "function") {
        if (rest.length > 0) (stdout as NodeJS.ReadStream).unshift(rest);
      }
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const protocolVersion = parsed.protocolVersion;
        const supported = parsed.supportedProtocolVersions;
        if (
          parsed.type !== "ready" ||
          typeof protocolVersion !== "number" ||
          !Number.isSafeInteger(protocolVersion) ||
          !Array.isArray(supported) ||
          !supported.every((value) => typeof value === "number" && Number.isSafeInteger(value))
        ) {
          reject(new Error("ready-invalid"));
          return;
        }
        resolveReady({
          protocolVersion,
          supportedProtocolVersions: supported as readonly number[],
        });
      } catch {
        reject(new Error("ready-invalid"));
      }
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("ready-timeout"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      stdout.off("data", onData);
      stdout.off("end", onEnd);
      stdout.off("error", onEnd);
    };
    stdout.on("data", onData);
    stdout.on("end", onEnd);
    stdout.on("error", onEnd);
  });
}

async function terminate(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const deadline = Date.now() + timeoutMs;
  while (child.exitCode === null && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  if (child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

export function makeOhMyPiProcessLive(options: OhMyPiProcessOptions = {}): OhMyPiProcessPort {
  const inherited = options.inheritedEnvironment ?? process.env;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 2_000;
  const versionTimeoutMs = options.versionTimeoutMs ?? 5_000;
  const readyTimeoutMs = options.readyTimeoutMs ?? 5_000;

  return {
    startProbe: (input) =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          const invalid = validateBinary(input.binaryPath);
          if (invalid !== undefined) return yield* Effect.fail(invalid);
          if (!/^\d+\.\d+\.\d+$/.test(input.supportedVersion)) {
            return yield* Effect.fail(
              failure("invalid-configuration", "Oh My Pi supported version must be pinned."),
            );
          }
          if (!isAbsolute(input.managedHome) || resolve(input.managedHome) !== input.managedHome) {
            return yield* Effect.fail(
              failure(
                "invalid-configuration",
                "Oh My Pi managed home must be absolute and normalized.",
              ),
            );
          }
          const environment = sanitizeOhMyPiEnvironment(inherited, input.managedHome);
          const version = yield* Effect.tryPromise({
            try: () => inspectVersion(input.binaryPath, environment, versionTimeoutMs),
            catch: () => failure("incompatible", "Oh My Pi version could not be verified."),
          });
          if (version !== input.supportedVersion) {
            return yield* Effect.fail(
              failure(
                "incompatible",
                `Oh My Pi version ${version} is not the pinned supported version ${input.supportedVersion}.`,
              ),
            );
          }
          const child = yield* Effect.try({
            try: () =>
              spawn(input.binaryPath, [...ohMyPiProbeArguments()], {
                cwd: input.managedHome,
                env: environment,
                detached: true,
                stdio: ["pipe", "pipe", "pipe"],
              }),
            catch: () => failure("unavailable", "Oh My Pi process could not be started."),
          });
          if (child.pid === undefined || child.stdin === null || child.stdout === null) {
            yield* Effect.promise(() => terminate(child, shutdownTimeoutMs));
            return yield* Effect.fail(
              failure("unavailable", "Oh My Pi process could not be started."),
            );
          }
          const exited = new Promise<void>((resolveExit, rejectExit) => {
            child.once("exit", (code, signal) => {
              if (code === 0 || signal === "SIGTERM" || signal === "SIGKILL") resolveExit();
              else rejectExit(new Error("Oh My Pi process exited unexpectedly."));
            });
            child.once("error", rejectExit);
          });
          void exited.catch(() => undefined);
          let ownershipReady: Promise<void> = Promise.resolve();
          if (input.onProcessStarted !== undefined) {
            ownershipReady = input
              .onProcessStarted({ pid: child.pid, exited })
              .then(() => undefined);
            void ownershipReady.catch(() => undefined);
          }
          const ready = yield* Effect.tryPromise({
            try: async () => {
              try {
                await ownershipReady;
              } catch {
                await terminate(child, shutdownTimeoutMs);
                throw new Error("receipt-unavailable");
              }
              return readReadyFrame(child.stdout!, readyTimeoutMs);
            },
            catch: (error) =>
              error instanceof Error && error.message === "receipt-unavailable"
                ? failure("unavailable", "Oh My Pi process receipt is unavailable.")
                : failure(
                    "protocol",
                    "Oh My Pi did not emit a valid ready RPC frame before probe timeout.",
                  ),
          });
          const rpc = makePiRpcClient({ stdin: child.stdin, stdout: child.stdout });
          if (!ready.supportedProtocolVersions.includes(1)) {
            return yield* Effect.fail(
              failure("incompatible", "Oh My Pi RPC protocol is incompatible with Octant."),
            );
          }
          return {
            connection: {
              version,
              protocolVersion: ready.protocolVersion,
              supportedProtocolVersions: ready.supportedProtocolVersions,
              pid: child.pid,
              rpc,
              exited,
            },
            child,
          };
        }),
        ({ connection, child }) =>
          Effect.promise(async () => {
            await connection.rpc.close().catch(() => undefined);
            await terminate(child, shutdownTimeoutMs);
          }),
      ).pipe(Effect.map(({ connection }) => connection)),
  };
}

export function ohMyPiManagedHome(dataDirectory: string, instanceId: string): string {
  return join(dataDirectory, "providers", "oh-my-pi", instanceId);
}
