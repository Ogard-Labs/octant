import { spawn, type ChildProcessByStdio } from "node:child_process";
import {
  chmodSync,
  constants,
  accessSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import type { Readable } from "node:stream";
import type { ProviderFailure } from "@octant/contracts";
import { Effect, type Scope } from "effect";
import { childProcessEnvironment } from "../childProcessEnvironment";
import type { ProviderProcessStartedListener } from "./providerRuntimeRegistry";

export interface OpenCodeBinaryProbe {
  readonly binaryPath: string;
  readonly version: string;
}

export type OpenCodeRuntime = "legacy" | "beta";

export interface OpenCodeServerConnection {
  /** Attested only when user/project MCP, plugins, and skills cannot enter the process. */
  readonly isolatedConfiguration?: true;
  readonly authorization: string;
  readonly pid: number;
  /** Runtime protocol attested by the binary version probe before startup. */
  readonly runtime?: OpenCodeRuntime;
  /** Version emitted by the same probe that selected the runtime protocol. */
  readonly version?: string;
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
  /** Optional host-owned routing projection; credentials remain provider-owned. */
  readonly runtimeConfigResolver?: OpenCodeConfigResolver;
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
const PROJECTED_CONFIG_LIMIT = 2 * 1024 * 1024;
const PROJECTED_CONFIG_DEPTH_LIMIT = 8;
const LEGACY_VERSION_PATTERN = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
const BETA_VERSION_PATTERN = /^opencode2 (v\d+\.\d+\.\d+-[0-9A-Za-z.-]+)$/;
const READINESS_PATTERN = /^(?:opencode )?server listening on (http:\/\/[^\s]+)$/;

interface ParsedOpenCodeVersion {
  readonly runtime: OpenCodeRuntime;
  readonly version: string;
}

type OpenCodeChild = ChildProcessByStdio<null, Readable, Readable>;

interface ResolvedOpenCodeProcessOptions {
  readonly inheritedEnvironment: NodeJS.ProcessEnv | undefined;
  readonly runtimeConfig: PrivateRuntimeConfig;
  readonly onDiagnostic: ((message: string) => void) | undefined;
  readonly shutdownTimeoutMs: number;
  readonly startupTimeoutMs: number;
  readonly terminateProcessGroup: ((pid: number) => Promise<void>) | undefined;
}

interface ManagedOpenCodeServer {
  readonly connection: OpenCodeServerConnection;
  readonly terminate: () => Promise<void>;
}

export interface PrivateRuntimeConfig {
  readonly content: string;
}

export interface PrivateOpenCodeProfile {
  readonly environment: NodeJS.ProcessEnv;
  readonly cleanup: () => void;
}

export interface OpenCodeConfigResolverInput {
  readonly binaryPath: string;
  readonly cwd: string;
}

export type OpenCodeConfigResolver = (input: OpenCodeConfigResolverInput) => Promise<unknown>;

type JsonRecord = { readonly [key: string]: unknown };
const SAFE_SECRET_REFERENCE = /^\{(?:env|file):[^{}\r\n]+\}$/;
const SENSITIVE_ROUTING_KEY = /(?:api[_-]?key|access[_-]?token|secret|password|credential)/i;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function projectRoutingValue(value: unknown, depth = 0): unknown {
  if (depth > PROJECTED_CONFIG_DEPTH_LIMIT) {
    throw new Error("OpenCode resolved configuration exceeds the private nesting limit.");
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => projectRoutingValue(entry, depth + 1));
  if (!isRecord(value)) return undefined;
  const projected: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const next = projectRoutingValue(entry, depth + 1);
    if (next !== undefined) projected[key] = next;
  }
  return projected;
}

function projectProviders(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const projected: Record<string, unknown> = {};
  const allowedKeys = ["name", "npm", "options", "models"] as const;
  for (const [providerId, provider] of Object.entries(value)) {
    if (!isRecord(provider)) continue;
    const projectedProvider: Record<string, unknown> = {};
    for (const key of allowedKeys) {
      const entry = projectRoutingValue(provider[key]);
      if (entry !== undefined) projectedProvider[key] = entry;
    }
    projected[providerId] = projectedProvider;
  }
  return projected;
}

function removeRawRoutingSecrets(value: unknown, key?: string): unknown {
  if (key !== undefined && SENSITIVE_ROUTING_KEY.test(key) && typeof value === "string") {
    return SAFE_SECRET_REFERENCE.test(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => removeRawRoutingSecrets(entry))
      .filter((entry): entry is Exclude<typeof entry, undefined> => entry !== undefined);
  }
  if (!isRecord(value)) return value;
  const sanitized: Record<string, unknown> = {};
  for (const [entryKey, entry] of Object.entries(value)) {
    const next = removeRawRoutingSecrets(entry, entryKey);
    if (next !== undefined) sanitized[entryKey] = next;
  }
  return sanitized;
}

/** Projects resolver output to provider/model routing and no executable surfaces. */
export function projectOpenCodeRuntimeConfig(resolved: unknown): PrivateRuntimeConfig {
  const resolvedRecord = isRecord(resolved) ? resolved : {};
  const allowedTopLevel = new Set([
    "$schema",
    "model",
    "small_model",
    "enabled_providers",
    "disabled_providers",
    "provider",
  ]);
  const sanitized: Record<string, unknown> = {};
  for (const key of allowedTopLevel) {
    const value = resolvedRecord[key];
    if (value === undefined) continue;
    sanitized[key] = key === "provider" ? projectProviders(value) : projectRoutingValue(value);
  }
  const content = JSON.stringify(sanitized);
  if (content === undefined || Buffer.byteLength(content, "utf8") > PROJECTED_CONFIG_LIMIT) {
    throw new Error("OpenCode resolved configuration exceeds the private routing limit.");
  }
  return { content };
}

/** Captures one explicitly supplied resolver result without forwarding its raw payload. */
export async function captureOpenCodeRuntimeConfig(
  input: OpenCodeConfigResolverInput,
  resolver: OpenCodeConfigResolver,
): Promise<PrivateRuntimeConfig | undefined> {
  const resolved = await resolver(input);
  return resolved === undefined ? undefined : projectOpenCodeRuntimeConfig(resolved);
}

function scrubOpenCodeConfigEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scrubbed = { ...environment };
  for (const name of [
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_CONTENT",
    "OPENCODE_CONFIG_DIR",
    "OPENCODE_PERMISSION",
    "OPENCODE_PLUGIN_META_FILE",
    "OPENCODE_TUI_CONFIG",
    "TMPDIR",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
  ]) {
    delete scrubbed[name];
  }
  return scrubbed;
}

function privateDirectory(prefix: string, root: string): string {
  const directory = mkdtempSync(`${root}/octant-${prefix}-`);
  chmodSync(directory, 0o700);
  return directory;
}

/** Creates owner-only runtime paths without changing the provider's auth store. */
export function createPrivateOpenCodeProfile(
  config: PrivateRuntimeConfig,
  inheritedEnvironment: NodeJS.ProcessEnv,
  temporaryDirectory: () => string = tmpdir,
): PrivateOpenCodeProfile {
  const root = temporaryDirectory();
  const directories: string[] = [];
  try {
    const configHome = privateDirectory("config-home", root);
    directories.push(configHome);
    const configDirectory = privateDirectory("config-dir", root);
    directories.push(configDirectory);
    const configPath = join(configHome, "opencode.json");
    let projected: JsonRecord = {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(config.content);
    } catch {
      throw new Error("OpenCode private routing configuration is not valid JSON.");
    }
    const bounded = projectOpenCodeRuntimeConfig(parsed);
    const boundedParsed: unknown = JSON.parse(bounded.content);
    const scrubbed = removeRawRoutingSecrets(boundedParsed);
    if (isRecord(scrubbed)) projected = scrubbed;
    // These rules are owned by Octant and override any resolver output. The
    // provider can still read its auth data through XDG_DATA_HOME, while
    // executable extensions and compatibility tools stay denied.
    const ownedConfig: Record<string, unknown> = {
      ...projected,
      permission: { skill: { "*": "deny" }, "*_*": "deny" },
    };
    writeFileSync(configPath, JSON.stringify(ownedConfig), { mode: 0o600 });
    chmodSync(configPath, 0o600);
    const cacheHome = privateDirectory("cache", root);
    directories.push(cacheHome);
    const stateHome = privateDirectory("state", root);
    directories.push(stateHome);
    const tempHome = privateDirectory("tmp", root);
    directories.push(tempHome);
    const environment = scrubOpenCodeConfigEnvironment(
      childProcessEnvironment(inheritedEnvironment),
    );
    Object.assign(environment, {
      OPENCODE_CONFIG: configPath,
      OPENCODE_CONFIG_DIR: configDirectory,
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "1",
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      TMPDIR: tempHome,
      XDG_CACHE_HOME: cacheHome,
      XDG_CONFIG_HOME: configHome,
      XDG_STATE_HOME: stateHome,
    });
    let closed = false;
    return {
      environment,
      cleanup: () => {
        if (closed) return;
        closed = true;
        for (const directory of directories) rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function parseOpenCodeVersion(output: string): ParsedOpenCodeVersion | undefined {
  const firstLine = output.split(/\r?\n/)[0]?.trim();
  if (firstLine === undefined) return undefined;
  const beta = BETA_VERSION_PATTERN.exec(firstLine)?.[1];
  if (beta !== undefined) return { runtime: "beta", version: firstLine };
  if (LEGACY_VERSION_PATTERN.test(firstLine)) return { runtime: "legacy", version: firstLine };
  return undefined;
}

function runtimeForVersion(version: string): OpenCodeRuntime {
  return version.startsWith("opencode2 ") ? "beta" : "legacy";
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
      const version = parseOpenCodeVersion(output)?.version;
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
  runtime: OpenCodeRuntime,
  version: string,
  onProcessStarted?: ProviderProcessStartedListener,
): Effect.Effect<ManagedOpenCodeServer, ProviderFailure> {
  const invalid = validateBinaryPath(input.binaryPath);
  if (invalid !== undefined) return Effect.fail(invalid);

  return Effect.async<ManagedOpenCodeServer, ProviderFailure>((resume) => {
    let profile: PrivateOpenCodeProfile;
    try {
      profile = createPrivateOpenCodeProfile(
        options.runtimeConfig,
        options.inheritedEnvironment ?? process.env,
      );
    } catch {
      resume(
        Effect.fail(
          failure(
            "invalid-configuration",
            "OpenCode private runtime profile could not be created.",
          ),
        ),
      );
      return cleanupDefect(async () => undefined);
    }
    const password = randomBytes(32).toString("base64url");
    const username = runtime === "beta" ? "opencode" : "octant";
    const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
    let child: OpenCodeChild;
    try {
      child = spawn(
        input.binaryPath,
        ["serve", "--pure", "--hostname", "127.0.0.1", "--port", "0"],
        {
          cwd: input.cwd,
          detached: process.platform !== "win32",
          env: {
            ...profile.environment,
            OPENCODE_SERVER_USERNAME: username,
            OPENCODE_SERVER_PASSWORD: password,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch {
      profile.cleanup();
      resume(Effect.fail(failure("unavailable", "OpenCode server could not be started.")));
      return cleanupDefect(async () => undefined);
    }
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
    const cleanupProfile = () => {
      try {
        profile.cleanup();
      } catch {
        // Profile cleanup is best effort after the owned process is gone.
      }
    };
    const terminateOwned = () => terminate().finally(cleanupProfile);
    const finishFailure = (providerFailure: ProviderFailure) => {
      if (settled) return;
      settled = true;
      cleanup();
      void terminateOwned().then(
        () => {
          cleanupProfile();
          resume(Effect.fail(providerFailure));
        },
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
              connection: {
                authorization,
                pid: child.pid!,
                isolatedConfiguration: true,
                runtime,
                version,
                url,
              },
              terminate: terminateOwned,
            }),
          ),
        () =>
          void terminateOwned().then(
            () => {
              cleanupProfile();
              resume(
                Effect.fail(failure("provider-failed", "OpenCode process receipt is unavailable.")),
              );
            },
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
      await terminateOwned();
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
      Effect.gen(function* () {
        // Probe first so the server command and auth identity follow the
        // runtime that actually answered, rather than treating the beta
        // label as a legacy semantic version.
        const probe = yield* probeOpenCodeBinary(input.binaryPath);
        const runtime = runtimeForVersion(probe.version);
        const runtimeConfig = yield* Effect.tryPromise({
          try: async () =>
            options.runtimeConfigResolver === undefined
              ? projectOpenCodeRuntimeConfig({})
              : ((await captureOpenCodeRuntimeConfig(
                  { binaryPath: input.binaryPath, cwd: input.cwd },
                  options.runtimeConfigResolver,
                )) ?? projectOpenCodeRuntimeConfig({})),
          catch: () =>
            failure("invalid-configuration", "OpenCode runtime routing could not be prepared."),
        });
        let terminate: (() => Promise<void>) | undefined;
        return yield* Effect.acquireReleaseInterruptible(
          acquireOpenCodeServer(
            input,
            { ...resolvedOptions, runtimeConfig },
            runtime,
            probe.version,
            input.onProcessStarted,
          ).pipe(
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
