import { spawn, type ChildProcess } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";

import type { ProviderExecutionPolicy, ProviderFailure } from "@octant/contracts";
import { Effect, type Scope } from "effect";

import { prepareConfinedVersionProbe } from "../process/confinedVersionProbe";
import {
  makeProcessConfinementLive,
  ProcessConfinementError,
  seatbeltDenyRule,
  type ProcessConfinementPort,
} from "../process/seatbeltProfile";
import {
  materializeOsNetworkEgress,
  resolveProbeEgressPolicy,
  resolveProviderRuntimeEgressPolicy,
} from "../process/threadEgressPolicy";
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

/**
 * What one app-server process carries. A thread lease is one root under one
 * mode and posture, so Octant's profile can be exact for it; a catalog lease
 * reads the account and models and runs no turn, so it gets a root of its own
 * with nothing in it.
 */
export type CodexLaunchAuthority =
  | { readonly kind: "catalog" }
  | {
      readonly kind: "thread";
      readonly root: string;
      /** The Project's extra folders, granted what the root is granted. */
      readonly extraFolders?: ReadonlyArray<string>;
      readonly mode: "chat" | "work" | "code";
      readonly executionPolicy: ProviderExecutionPolicy;
    };

export interface CodexProcessPort {
  readonly start: (input: {
    readonly binaryPath: string;
    readonly authority: CodexLaunchAuthority;
    readonly environment?: NodeJS.ProcessEnv;
    readonly onProcessStarted?: ProviderProcessStartedListener;
  }) => Effect.Effect<CodexAppServerConnection, ProviderFailure, Scope.Scope>;
}

export interface CodexProbeOptions {
  readonly inheritedEnvironment?: NodeJS.ProcessEnv;
  readonly shutdownTimeoutMs?: number;
  readonly timeoutMs?: number;
  readonly onProcessStarted?: ProviderProcessStartedListener;
  readonly confinement?: ProcessConfinementPort;
}

export interface CodexProcessOptions {
  readonly inheritedEnvironment?: NodeJS.ProcessEnv;
  readonly onDiagnostic?: (message: string) => void;
  readonly octantVersion?: string;
  readonly shutdownTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly stderrBytes?: number;
  readonly versionProbeConfinement?: ProcessConfinementPort;
  /** Confinement for the app-server below Full access; defaults to the platform's. */
  readonly confinement?: ProcessConfinementPort;
  readonly platform?: NodeJS.Platform;
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

// The app-server spawned below is long-lived and runs model-generated shell
// commands without Octant confinement around it, so every inherited variable
// is readable by the model. A denylist here let a host `GITHUB_TOKEN` or
// `AWS_SECRET_ACCESS_KEY` cross with no OS boundary behind it; the allowlist
// below carries only what the Codex CLI itself reads, as `codex doctor`
// reports for auth, custom CA, and proxy configuration. A general-purpose
// credential — a GitHub token, AWS IAM access keys — is not on the list: it
// grants far more than model access, and everything on the list is readable by
// the model. A model provider's own credential is on it.
const SAFE_ENVIRONMENT = new Set([
  "COLORTERM",
  "HOME",
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
  "TERMINFO",
  "TERMINFO_DIRS",
  "TERM_PROGRAM",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
]);
// Codex reads both spellings, and a host that sets only the lowercase form is
// the common case on Unix. Dropping one spelling silently removes a corporate
// proxy the CLI needs to reach the provider at all.
const PROXY_VARIABLES = new Set([
  "ALL_PROXY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "all_proxy",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]);
const CODEX_NATIVE_VARIABLES = new Set([
  "CODEX_CA_CERTIFICATE",
  "CODEX_HOME",
  "CODEX_OSS_BASE_URL",
  "CODEX_OSS_PORT",
  "CODEX_SQLITE_HOME",
  "OPENAI_BASE_URL",
  "OPENAI_ORGANIZATION",
  "OPENAI_PROJECT",
]);
// The auth variables the CLI itself names when no stored credential is found,
// plus the bearer token its built-in Bedrock provider takes: scoped to model
// access, so the same class as `OPENAI_API_KEY`. Without it, a Bedrock
// account signs in only through its token command or a sign-in stored in its
// own Codex home; every other route is refused (`codexBedrockSignIn`). A
// `config.toml` model provider may declare any other variable as its
// `env_key`; that variable does not cross, and `codex doctor` names the
// refusal ("active model provider auth env var is missing") rather than
// failing obscurely.
const CODEX_CREDENTIALS = new Set([
  "AWS_BEARER_TOKEN_BEDROCK",
  "CODEX_ACCESS_TOKEN",
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
]);
// The region Bedrock bearer authentication requires, and nothing that leads
// to an AWS identity. A profile name or a shared-config location used to
// cross, but it only told the CLI, and every command the model runs under it,
// where to read reusable IAM keys; the files under `~/.aws` stay readable
// through `HOME` regardless, so the driver refuses a Bedrock sign-in that
// would rely on them (`codexBedrockSignIn`).
const AWS_REGION_VARIABLES = new Set(["AWS_DEFAULT_REGION", "AWS_REGION"]);

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

/** A release, not its prereleases: `0.145.0-alpha.1` predates `0.145.0`. */
export function isAtLeastRelease(
  version: string,
  floor: readonly [number, number, number],
): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(-)?/.exec(version);
  if (match === null) return false;
  const core = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (const [index, part] of core.entries()) {
    const floorPart = floor[index] ?? 0;
    if (part !== floorPart) return part > floorPart;
  }
  return match[4] === undefined;
}

/**
 * Octant keeps provider-native subagents off: a Codex child runs on its own
 * thread, which the driver neither shows nor answers approvals for, so a child
 * waiting on one would hang the turn out of sight. The overrides ride on the
 * command line so the user's `CODEX_HOME` and `config.toml` stay untouched and
 * every thread this process starts or resumes inherits them.
 *
 * Measured against codex-cli 0.155.1: the model catalog declares a
 * multi-agent version per model, and that turns the collaboration tools on
 * even with both feature flags off. Only `agents.enabled = false` outranks it,
 * and only while `multi_agent_v2` stays off, since that feature outranks
 * `agents.enabled` in turn. Before 0.145.0 the feature flags alone decided,
 * and `[agents]` was a table of role definitions there, so `agents.enabled`
 * would parse as a role and refuse the whole config.
 *
 * Codex's own memories stay off for the same reason Claude runs with no
 * setting sources: memory is Octant's, scoped to a Project. With the feature
 * on, codex-cli 0.159.2 put the user's global memory summary into every
 * thread's instructions, told the model to search `~/.codex/memories`, and
 * added that folder to the sandbox's readable roots, so a memory from any
 * other workspace reached every Octant thread in every mode.
 */
export function codexAppServerArgs(version: string): readonly string[] {
  return [
    "app-server",
    "--listen",
    "stdio://",
    "-c",
    "features.multi_agent=false",
    "-c",
    "features.multi_agent_v2=false",
    "-c",
    "features.memories=false",
    ...(isAtLeastRelease(version, [0, 145, 0]) ? ["-c", "agents.enabled=false"] : []),
  ];
}

export function sanitizeCodexEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([key, value]) =>
        value !== undefined &&
        (SAFE_ENVIRONMENT.has(key) ||
          PROXY_VARIABLES.has(key) ||
          CODEX_NATIVE_VARIABLES.has(key) ||
          CODEX_CREDENTIALS.has(key) ||
          AWS_REGION_VARIABLES.has(key) ||
          key.startsWith("LC_")),
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

const ACCOUNT_AUTH_VARIABLES = [
  "AWS_BEARER_TOKEN_BEDROCK",
  "CODEX_ACCESS_TOKEN",
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
] as const;

/**
 * Per-account app-server environment. An extra account, on its assigned home,
 * loses the inherited auth variables so it cannot share the host's key, and
 * loses `CODEX_SQLITE_HOME`, which would point its thread state database at
 * the host's instead of at its own home. The first account, on the host
 * profile, keeps them: existing installs authenticate and store state that
 * way, and Settings has no Codex API-key field to populate the broker.
 *
 * Octant never reads `auth.json` or the keyring, and never writes
 * `cli_auth_credentials_store` into the user's config. Codex names its
 * keyring entry by a hash of the canonical `CODEX_HOME` path (read in the
 * Codex source at `rust-v0.162.1`, `login/src/auth/storage.rs`), so two homes
 * hold two logins without forcing file storage.
 */
export function codexAccountProcessEnvironment(input: {
  readonly binaryPath: string;
  readonly hostEnvironment: NodeJS.ProcessEnv;
  readonly codexHome: string;
  readonly inheritHostAuth?: boolean;
  readonly brokerApiKey?: string;
}): NodeJS.ProcessEnv {
  const environment = codexProcessEnvironment(input.binaryPath, input.hostEnvironment);
  if (input.inheritHostAuth !== true) {
    for (const name of ACCOUNT_AUTH_VARIABLES) {
      delete environment[name];
    }
    delete environment.CODEX_SQLITE_HOME;
  }
  environment.CODEX_HOME = input.codexHome;
  if (input.brokerApiKey !== undefined && input.brokerApiKey.trim() !== "") {
    environment.OPENAI_API_KEY = input.brokerApiKey;
  }
  return environment;
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
  // Preparing inside the suspend keeps one scratch directory per run: an
  // Effect a caller holds and never runs leaves nothing behind, and one it runs
  // twice does not hand the second run a directory the first already released.
  return Effect.suspend(() => {
    const probe = prepareConfinedVersionProbe({
      binaryPath,
      displayName: "Codex",
      environment: () =>
        codexProcessEnvironment(binaryPath, options.inheritedEnvironment ?? process.env),
      ...(options.confinement === undefined ? {} : { confinement: options.confinement }),
    });
    if (probe.status === "refused") return Effect.fail(failure(probe.reason, probe.message));
    const { launch } = probe;

    return Effect.async<CodexBinaryProbe, ProviderFailure>((resume) => {
      const child = spawn(launch.command, [...launch.args], {
        cwd: launch.workingDirectory,
        detached: process.platform !== "win32",
        env: launch.environment,
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
      const terminateProcess = makeProcessTerminator(child, shutdownTimeoutMs);
      // The scratch directory outlives the process it was granted to unless it
      // goes away with it, and every settle path here runs the terminator.
      const terminate = () => terminateProcess().finally(launch.release);
      // The version line is read from stdout alone. Codex writes the version
      // there and keeps stderr for advice: given a throwaway home it warns that
      // it cannot install its PATH aliases, which a version read does not need
      // and which folded into one buffer made the whole read unrecognizable.
      let output = Buffer.alloc(0);
      let outputOverflow = false;
      let settled = false;

      const cleanupListeners = () => {
        clearTimeout(timeout);
        child.stdout.off("data", onStdout);
        child.stderr.off("data", onStderr);
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
          () =>
            resume(Effect.fail(failure("provider-failed", "Codex binary probe cleanup failed."))),
        );
      };
      const onStdout = (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = PROBE_OUTPUT_BYTES - output.length;
        if (bytes.length > remaining) outputOverflow = true;
        if (remaining > 0) output = Buffer.concat([output, bytes.subarray(0, remaining)]);
      };
      // Stderr is still bounded, so a program that floods it is refused rather
      // than read forever; its bytes never reach the version line.
      let stderrBytes = 0;
      const onStderr = (chunk: Buffer | string) => {
        stderrBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.from(chunk).length;
        if (stderrBytes > PROBE_OUTPUT_BYTES) outputOverflow = true;
      };
      const onError = () =>
        finish(
          Effect.fail(failure("unavailable", "Codex binary could not be started for probing.")),
        );
      const onClose = (code: number | null) => {
        if (outputOverflow) {
          finish(
            Effect.fail(failure("protocol", "Codex binary version output exceeded the limit.")),
          );
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

      child.stdout.on("data", onStdout);
      child.stderr.on("data", onStderr);
      child.once("error", onError);
      child.once("close", onClose);

      return cleanupEffect(async () => {
        if (settled) return;
        settled = true;
        cleanupListeners();
        await terminate();
      });
    });
  });
}

/**
 * Files in the account home that change what later threads may do: its
 * configuration (MCP servers, hooks, sandbox defaults), the variables Codex
 * loads from `.env`, its exec-policy rules, and the skills and instructions
 * every thread reads. The runtime writes its sessions, state databases, logs
 * and sign-in refresh under the same home, so the home is writable and these
 * are taken back out. A command under Codex's own `read-only` sandbox could
 * not write them, and a thread under Octant's must not gain that.
 */
const CODEX_HOME_AUTHORITY_ENTRIES = [
  ".env",
  "AGENTS.md",
  "AGENTS.override.md",
  "config.toml",
  "hooks.json",
  "plugins",
  "prompts",
  "rules",
  "skills",
] as const;

/**
 * The macOS services the runtime asks for beyond the shared builder's grants.
 * Measured with codex-cli 0.164.0 on macOS 27.0.1 against a ChatGPT sign-in:
 * without the preferences daemon (both names) and a read of its shared
 * memory, `account/read` failed with "failed to load workspace requirements"
 * (Codex reads its managed configuration through preferences); without
 * `com.apple.SecurityServer` it failed with "workspace routing discovery
 * failed" (its TLS client consults it). Each grant was bisected away alone
 * and the read failed again. None opens a file.
 */
const CODEX_SEATBELT_SERVICE_RULES = [
  '(allow mach-lookup (global-name "com.apple.cfprefsd.daemon") (global-name "com.apple.cfprefsd.agent"))',
  '(allow ipc-posix-shm-read-data (ipc-posix-name-prefix "apple.cfprefs."))',
  '(allow mach-lookup (global-name "com.apple.SecurityServer"))',
] as const;

interface CodexLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string | undefined;
  readonly environment: NodeJS.ProcessEnv;
  readonly release: () => void;
}

function existingRealPaths(paths: ReadonlyArray<string | undefined>): ReadonlyArray<string> {
  const resolved = new Set<string>();
  for (const path of paths) {
    if (path === undefined || !isAbsolute(path) || !existsSync(path)) continue;
    try {
      resolved.add(realpathSync(path));
    } catch {
      // A path that disappears between the checks is left out rather than
      // granted at a stale location.
    }
  }
  return [...resolved];
}

/**
 * Builds the app-server launch for one lease. Full access keeps the runtime
 * unwrapped, as the sandbox rules define it. Every other posture, and the catalog lease,
 * runs under Octant's deny-default profile: the thread's root (writable only
 * where the posture writes), the account home, a private temporary directory,
 * and the program itself. The rest of `HOME` is denied, which is what Codex's
 * own `read-only` sandbox never did: it reads the whole disk.
 */
export function prepareCodexLaunch(input: {
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly authority: CodexLaunchAuthority;
  readonly environment: NodeJS.ProcessEnv;
  readonly confinement: ProcessConfinementPort;
  readonly platform: NodeJS.Platform;
}):
  | { readonly status: "prepared"; readonly launch: CodexLaunch }
  | { readonly status: "refused"; readonly failure: ProviderFailure } {
  const { authority } = input;
  if (authority.kind === "thread" && authority.executionPolicy === "full-access") {
    return {
      status: "prepared",
      launch: {
        command: input.binaryPath,
        args: input.args,
        cwd: authority.root,
        environment: input.environment,
        release: () => undefined,
      },
    };
  }
  let temporaryDirectory: string | undefined;
  const release = () => {
    if (temporaryDirectory !== undefined) {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  };
  try {
    temporaryDirectory = realpathSync(mkdtempSync(join(tmpdir(), "octant-codex-")));
    chmodSync(temporaryDirectory, 0o700);
    const root = authority.kind === "thread" ? realpathSync(authority.root) : temporaryDirectory;
    if (!statSync(root).isDirectory()) throw new Error("Codex root is not a directory.");
    // A folder removed from disk since it was added is left out rather than
    // failing the launch; the main folder above must still exist.
    const extraFolders =
      authority.kind === "thread" ? existingRealPaths(authority.extraFolders ?? []) : [];
    const mode = authority.kind === "thread" ? authority.mode : "chat";
    const executionPolicy = authority.kind === "thread" ? authority.executionPolicy : "plan";
    const home = input.environment.HOME ?? homedir();
    const codexHome = input.environment.CODEX_HOME ?? join(home, ".codex");
    const accountRoots = existingRealPaths([codexHome, input.environment.CODEX_SQLITE_HOME]);
    const authorityEntries = existingRealPaths([codexHome]).flatMap((resolvedHome) =>
      CODEX_HOME_AUTHORITY_ENTRIES.map((entry) => join(resolvedHome, entry)),
    );
    const programPaths = existingRealPaths([
      input.binaryPath,
      dirname(input.binaryPath),
      codexPackageRoot(input.binaryPath),
    ]);
    const networkEgress = materializeOsNetworkEgress(
      authority.kind === "thread"
        ? resolveProviderRuntimeEgressPolicy({ mode, executionPolicy })
        : resolveProbeEgressPolicy(),
    );
    const environment: NodeJS.ProcessEnv = { ...input.environment, TMPDIR: temporaryDirectory };
    const launch = input.confinement.prepare({
      executable: input.binaryPath,
      args: input.args,
      boundRoot: root,
      extraBoundRoots: extraFolders,
      temporaryDirectory,
      networkEgress,
      writeBoundRoot: !(executionPolicy === "plan" || mode === "chat"),
      additionalWriteRoots: accountRoots,
      readRoots: [...accountRoots, ...programPaths],
      privateHomeAllowPaths: [
        root,
        ...extraFolders,
        temporaryDirectory,
        ...accountRoots,
        ...programPaths,
      ],
      allowFileReadStar: true,
      ...(input.environment.PATH === undefined
        ? {}
        : { interpreterSearchPath: input.environment.PATH }),
      // Seatbelt applies the last matching rule, and the home's write grant is
      // emitted after the builder's own denials, so on macOS these follow it
      // as extra rules. Bubblewrap overlays each one read-only, and refuses a
      // path that does not exist, which Seatbelt simply denies creating.
      ...(input.platform === "darwin"
        ? {
            extraRules: [
              ...CODEX_SEATBELT_SERVICE_RULES,
              ...authorityEntries.map((path) => seatbeltDenyRule("file-write*", path)),
            ],
          }
        : { additionalDenyWritePaths: authorityEntries.filter((path) => existsSync(path)) }),
    });
    return {
      status: "prepared",
      launch: { ...launch, cwd: root, environment, release },
    };
  } catch (error) {
    release();
    return {
      status: "refused",
      failure: failure(
        error instanceof ProcessConfinementError && error.reason === "invalid-configuration"
          ? "invalid-configuration"
          : "incompatible",
        error instanceof ProcessConfinementError
          ? error.message
          : "Codex process confinement could not be prepared.",
      ),
    };
  }
}

/**
 * The npm launcher (`bin/codex.js`) starts the platform binary vendored in the
 * package beside it, so the launch has to read and execute inside that package.
 * A native binary needs only itself.
 */
function codexPackageRoot(binaryPath: string): string | undefined {
  try {
    const program = realpathSync(binaryPath);
    if (!program.endsWith(".js")) return undefined;
    const packageRoot = dirname(dirname(program));
    return existsSync(join(packageRoot, "package.json")) ? packageRoot : undefined;
  } catch {
    return undefined;
  }
}

function acquireCodexAppServer(
  launch: CodexLaunch,
  version: string,
  options: ResolvedCodexProcessOptions,
  onProcessStarted?: ProviderProcessStartedListener,
): Effect.Effect<ManagedCodexConnection, ProviderFailure> {
  return Effect.async<ManagedCodexConnection, ProviderFailure>((resume) => {
    const child = spawn(launch.command, [...launch.args], {
      ...(launch.cwd === undefined ? {} : { cwd: launch.cwd }),
      detached: process.platform !== "win32",
      env: launch.environment,
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
          launch.release();
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
            // Dynamic tools are an experimental app-server field. Opt in at
            // connection startup so a later thread/start can carry the
            // app-owned catalogue through the structured protocol.
            capabilities: { experimentalApi: true, requestAttestation: false },
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
    versionProbeConfinement: options.versionProbeConfinement,
  };
  const platform = options.platform ?? process.platform;
  const confinement = options.confinement ?? makeProcessConfinementLive({ platform });

  return {
    start: ({ binaryPath, authority, environment, onProcessStarted }) =>
      Effect.suspend(() => {
        let terminate: (() => Promise<void>) | undefined;
        const launchEnvironment =
          environment ??
          (resolved.inheritedEnvironment === undefined
            ? undefined
            : codexProcessEnvironment(binaryPath, resolved.inheritedEnvironment));
        // Codex never creates its home: it refuses one that is missing with
        // "CODEX_HOME points to …, but that path does not exist" (codex-cli
        // 0.162.1). An account's assigned home is new, so it has to exist
        // before the first start, and before the person runs the sign-in
        // command against it.
        const accountHome = environment?.CODEX_HOME;
        if (accountHome !== undefined && isAbsolute(accountHome)) {
          try {
            mkdirSync(accountHome, { recursive: true, mode: 0o700 });
          } catch {
            return Effect.fail(
              failure("invalid-configuration", "Codex account home could not be created."),
            );
          }
        }
        return Effect.acquireReleaseInterruptible(
          Effect.gen(function* () {
            const probe = yield* probeCodexBinary(binaryPath, {
              ...(launchEnvironment === undefined
                ? {}
                : { inheritedEnvironment: launchEnvironment }),
              shutdownTimeoutMs: resolved.shutdownTimeoutMs,
              ...(onProcessStarted === undefined ? {} : { onProcessStarted }),
              ...(resolved.versionProbeConfinement === undefined
                ? {}
                : { confinement: resolved.versionProbeConfinement }),
            });
            const prepared = prepareCodexLaunch({
              binaryPath,
              args: codexAppServerArgs(probe.version),
              authority,
              environment: launchEnvironment ?? codexProcessEnvironment(binaryPath, process.env),
              confinement,
              platform,
            });
            if (prepared.status === "refused") return yield* Effect.fail(prepared.failure);
            const managed = yield* acquireCodexAppServer(
              prepared.launch,
              probe.version,
              { ...resolved, inheritedEnvironment: launchEnvironment },
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
