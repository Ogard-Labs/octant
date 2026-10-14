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
 * whole and writes only {@link CLAUDE_PLAN_RUNTIME_STATE_FOLDERS} inside the
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
 * The folders of the configuration directory a Plan launch may write.
 *
 * Measured on macOS 27 with Claude Code 2.1.299, one Plan turn (its start,
 * three read-tool calls, the answer) wrote exactly these under `CLAUDE_CONFIG_DIR`:
 * `sessions/<pid>.json` and its `.key` files, the transcript under
 * `projects/<checkout>/<session>.jsonl`, plus `.claude.json` (through a lock,
 * a temporary file and a copy in `backups/`) and `.last-cleanup` at the top.
 * Only the two folders are granted. The top-level files are refused: the
 * global `.claude.json` carries per-project MCP servers, `settings.json` its
 * hooks, and `skills/`, `plugins/`, `agents/` and `commands/` what a later
 * session loads, so a Plan launch able to write any of them could plant code
 * that runs on a later turn outside this sandbox. Measured under this grant,
 * a launch refused its `.claude.json` saves and still initialized; a launch on
 * the person's own `~/.claude` keeps that file in the home folder, outside
 * every grant, and already passed every Plan smoke stage.
 */
const CLAUDE_PLAN_RUNTIME_STATE_FOLDERS = ["sessions", "projects"] as const;

/**
 * Where a Plan launch may write outside the checkout, created when missing.
 *
 * The folders are made here, outside the sandbox, because the configuration
 * directory itself is no longer writable to the launch, and Bubblewrap can bind
 * only a folder that exists. On a host that keeps the subscription sign-in in
 * a file rather than the macOS Keychain, the runtime refreshes that one file,
 * `.credentials.json` in the secure-storage directory (the configuration
 * directory when none is named), and it stays writable. It is the only file
 * granted, and only where it is the login: a launch with an API key, or on
 * macOS, gets none.
 */
function planStateWriteRoots(
  boundRoot: string,
  environment: SpawnOptions["env"],
  readsSignInFromKeychain: boolean,
): { readonly readRoots: ReadonlyArray<string>; readonly writeRoots: ReadonlyArray<string> } {
  const { configuration, secureStorage } = claudeAccountStateDirectories(environment);
  const readRoots = refuseStateOverlappingCheckout(
    boundRoot,
    [configuration, secureStorage].filter((path): path is string => path !== undefined),
  );
  if (configuration === undefined) return { readRoots, writeRoots: [] };
  const folders = CLAUDE_PLAN_RUNTIME_STATE_FOLDERS.map((folder) => join(configuration, folder));
  try {
    for (const folder of folders) mkdirSync(folder, { recursive: true, mode: 0o700 });
  } catch {
    throw new ProcessConfinementError(
      "invalid-configuration",
      "Claude Plan confinement could not create the runtime's session folders.",
    );
  }
  const credentialsFile =
    readsSignInFromKeychain || environment.ANTHROPIC_API_KEY !== undefined
      ? []
      : [join(secureStorage ?? configuration, ".credentials.json")];
  // Resolved again after creation: a folder that is a link into the checkout
  // is refused like the configuration directory itself.
  return {
    readRoots,
    writeRoots: refuseStateOverlappingCheckout(boundRoot, [...folders, ...credentialsFile]),
  };
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
    // granted: `/bin/sh` stays refused, which keeps hooks and the Bash tool
    // out. The cost is that the runtime may fork, may run `security`, which
    // returns any Keychain item that trusts that tool, and may read the
    // encrypted login keychain file. The driver refuses a file tool that names
    // that folder, so the grant serves the sign-in read and not the model. A
    // launch that carries an API key reads nothing from the store and gets
    // none of this. Linux keeps the login in a file inside the account
    // directory, which the launch may rewrite (see `planStateWriteRoots`), and
    // Seatbelt rules do not apply there.
    const readsSignInFromKeychain =
      process.platform === "darwin" && spawnOptions.env.ANTHROPIC_API_KEY === undefined;
    const stateRoots = planStateWriteRoots(boundRoot, spawnOptions.env, readsSignInFromKeychain);
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
      // nothing but itself and, for a Keychain sign-in, `/usr/bin/security`.
      // Measured on macOS 27, a session hook under this profile is refused with
      // `EPERM: operation not permitted, posix_spawn '/bin/sh'`.
      writeBoundRoot: false,
      allowProcessExec: false,
      allowProcessFork: readsSignInFromKeychain,
      allowFileReadStar: true,
      ...(readsSignInFromKeychain
        ? {
            extraRules: [
              seatbeltExecRule("/usr/bin/security"),
              '(allow mach-lookup (global-name "com.apple.SecurityServer"))',
              '(allow mach-lookup (global-name "com.apple.securityd.xpc"))',
              seatbeltAllowLiteralReadRule(claudeLoginKeychainPath()),
            ],
          }
        : {}),
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
