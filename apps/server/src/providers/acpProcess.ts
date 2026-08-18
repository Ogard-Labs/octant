import { spawn, type ChildProcess } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ProviderExecutionPolicy, ProviderFailure } from "@octant/contracts";
import { decidesCodeEffectsByApproval } from "@octant/domain";
import { Effect, type Scope } from "effect";
import type { AcpProviderProfile, AcpSessionMode } from "./acpProfiles";
import { AcpFailure, makeAcpClient, type AcpClient, type AcpInitializeResult } from "./acpProtocol";
import type { ProviderProcessStartedListener } from "./providerRuntimeRegistry";
import {
  buildDenyDefaultSeatbeltProfile,
  escapeSeatbeltPath,
  requireSandboxExec,
  seatbeltAllowRule,
  seatbeltDenyRule,
  wrapCommandInSandboxExec,
} from "../process/seatbeltProfile";
import {
  materializeOsNetworkEgress,
  resolveDefaultThreadEgressPolicy,
} from "../process/threadEgressPolicy";

export type { AcpSessionMode } from "./acpProfiles";

export interface AcpLaunchSpec {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}

export interface AcpConfinementInput {
  readonly profile: AcpProviderProfile;
  readonly binaryPath: string;
  readonly root: string;
  readonly managedHome: string;
  readonly mode: AcpSessionMode;
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly environment: NodeJS.ProcessEnv;
}

export interface AcpConfinementPort {
  readonly prepare: (input: AcpConfinementInput) => Effect.Effect<AcpLaunchSpec, ProviderFailure>;
}

export interface AcpConnection {
  readonly version: string;
  readonly pid: number;
  readonly root: string;
  readonly initialized: AcpInitializeResult;
  readonly acp: AcpClient;
  readonly exited: Promise<void>;
}

export interface AcpProcessStartInput {
  readonly profile: AcpProviderProfile;
  readonly binaryPath: string;
  readonly root: string;
  readonly managedHome: string;
  readonly mode: AcpSessionMode;
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly apiKey?: string;
  readonly onProcessStarted?: ProviderProcessStartedListener;
}

export interface AcpProcessPort {
  readonly start: (
    input: AcpProcessStartInput,
  ) => Effect.Effect<AcpConnection, ProviderFailure, Scope.Scope>;
}

export interface AcpProcessOptions {
  readonly confinement?: AcpConfinementPort;
  readonly inheritedEnvironment?: NodeJS.ProcessEnv;
  readonly onDiagnostic?: (message: string) => void;
  readonly shutdownTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly stderrBytes?: number;
}

export interface AcpConfinementOptions {
  readonly platform?: NodeJS.Platform;
  readonly sandboxPath?: string;
  readonly temporaryDirectory?: string;
  /** Overrides the profile's provider-owned authentication path (tests). */
  readonly hostAuthenticationPath?: string;
}

export interface AcpProbeOptions {
  readonly inheritedEnvironment?: NodeJS.ProcessEnv;
  readonly onProcessStarted?: ProviderProcessStartedListener;
  readonly outputBytes?: number;
  readonly shutdownTimeoutMs?: number;
  readonly timeoutMs?: number;
}

export interface AcpBinaryProbe {
  readonly binaryPath: string;
  readonly version: string;
}

const DEFAULT_OUTPUT_BYTES = 4_096;
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;

function failure(category: ProviderFailure["category"], message: string): ProviderFailure {
  return { category, message };
}

function canonicalExistingDirectory(
  path: string,
  label: string,
): Effect.Effect<string, ProviderFailure> {
  if (!isAbsolute(path) || resolve(path) !== path) {
    return Effect.fail(
      failure("invalid-configuration", `${label} must be an absolute normalized path.`),
    );
  }
  return Effect.try({
    try: () => {
      const canonical = realpathSync(path);
      if (canonical !== path || !statSync(canonical).isDirectory()) throw new Error();
      return canonical;
    },
    catch: () => failure("invalid-configuration", `${label} must be a canonical directory.`),
  });
}

function canonicalManagedDirectory(
  path: string,
  label: string,
): Effect.Effect<string, ProviderFailure> {
  if (!isAbsolute(path) || resolve(path) !== path) {
    return Effect.fail(
      failure("invalid-configuration", `${label} must be an absolute normalized path.`),
    );
  }
  return Effect.try({
    try: () => {
      mkdirSync(path, { recursive: true, mode: 0o700 });
      if (lstatSync(path).isSymbolicLink()) throw new Error();
      chmodSync(path, 0o700);
      const canonical = realpathSync(path);
      if (canonical !== path || !statSync(canonical).isDirectory()) throw new Error();
      return canonical;
    },
    catch: () => failure("invalid-configuration", `${label} must be a canonical directory.`),
  });
}

function canonicalTemporaryDirectory(
  path: string,
  displayName: string,
): Effect.Effect<string, ProviderFailure> {
  if (!isAbsolute(path)) {
    return Effect.fail(
      failure(
        "invalid-configuration",
        `${displayName} temporary directory must be an absolute path.`,
      ),
    );
  }
  return Effect.try({
    try: () => {
      mkdirSync(path, { recursive: true, mode: 0o700 });
      const canonical = realpathSync(path);
      if (!statSync(canonical).isDirectory()) throw new Error();
      return canonical;
    },
    catch: () =>
      failure("invalid-configuration", `${displayName} temporary directory must be a directory.`),
  });
}

function writeManagedFiles(
  profile: AcpProviderProfile,
  input: { readonly managedHome: string; readonly executionPolicy: ProviderExecutionPolicy },
): Effect.Effect<void, ProviderFailure> {
  return Effect.try({
    try: () => {
      for (const file of profile.process.managedFiles(input)) {
        mkdirSync(dirname(file.path), { recursive: true, mode: 0o700 });
        writeFileSync(file.path, file.content, { mode: 0o600 });
        chmodSync(file.path, 0o600);
      }
    },
    catch: () =>
      failure(
        "invalid-configuration",
        `${profile.displayName} managed configuration could not be prepared.`,
      ),
  });
}

interface HostAuthenticationPaths {
  readonly readPaths: ReadonlyArray<string>;
  readonly writePaths: ReadonlyArray<string>;
}

function prepareHostAuthentication(
  profile: AcpProviderProfile,
  managedHome: string,
  overridePath: string | undefined,
): Effect.Effect<HostAuthenticationPaths, ProviderFailure> {
  const hostAuthentication = profile.process.hostAuthentication;
  if (hostAuthentication === undefined) return Effect.succeed({ readPaths: [], writePaths: [] });
  const path = overridePath ?? hostAuthentication.defaultPath;
  const label = `${profile.displayName} provider data directory`;
  if (hostAuthentication.kind === "directory") {
    const directory =
      overridePath === undefined
        ? canonicalExistingDirectory(path, label).pipe(
            Effect.mapError(() =>
              failure(
                "unauthenticated",
                `${profile.displayName} provider-owned authentication is unavailable. ${hostAuthentication.loginHint}`,
              ),
            ),
          )
        : canonicalManagedDirectory(path, label);
    return directory.pipe(
      Effect.map((canonical) => ({ readPaths: [canonical], writePaths: [canonical] })),
    );
  }
  const managedCredential = join(managedHome, hostAuthentication.managedRelativePath);
  return Effect.try({
    try: () => {
      mkdirSync(dirname(managedCredential), { recursive: true, mode: 0o700 });
      if (existsSync(path) && !existsSync(managedCredential)) symlinkSync(path, managedCredential);
      return { readPaths: existsSync(path) ? [path] : [], writePaths: [] };
    },
    catch: () =>
      failure(
        "invalid-configuration",
        `${profile.displayName} managed configuration could not be prepared.`,
      ),
  });
}

function prepareImmutableConfiguration(
  profile: AcpProviderProfile,
  configPath: string,
  configuration: string,
): Effect.Effect<void, ProviderFailure> {
  return Effect.try({
    try: () => {
      if (existsSync(configPath)) {
        const metadata = lstatSync(configPath);
        if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error();
        if ((metadata.mode & 0o777) !== 0o600) throw new Error();
        const userId = process.getuid?.();
        if (userId !== undefined && metadata.uid !== userId) throw new Error();
        if (readFileSync(configPath, "utf8") !== configuration) throw new Error();
        return;
      }
      const temporaryPath = join(
        dirname(configPath),
        `.${basename(configPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
      );
      try {
        writeFileSync(temporaryPath, configuration, { encoding: "utf8", flag: "wx", mode: 0o600 });
        linkSync(temporaryPath, configPath);
        chmodSync(configPath, 0o600);
      } finally {
        if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
      }
    },
    catch: () =>
      failure(
        "incompatible",
        `${profile.displayName} managed configuration is missing, unsafe, or has been modified.`,
      ),
  });
}

export function makeAcpConfinementLive(options: AcpConfinementOptions = {}): AcpConfinementPort {
  const platform = options.platform ?? process.platform;
  const sandboxPath = options.sandboxPath ?? "/usr/bin/sandbox-exec";
  return {
    prepare: (input) =>
      Effect.gen(function* () {
        const { profile } = input;
        const name = profile.displayName;
        if (platform !== "darwin") {
          return yield* Effect.fail(
            failure("incompatible", `${name} confinement is currently available only on macOS.`),
          );
        }
        const invalidBinary = validateBinaryPath(profile, input.binaryPath);
        if (invalidBinary !== undefined) return yield* Effect.fail(invalidBinary);
        const managedHome = yield* canonicalManagedDirectory(
          input.managedHome,
          `${name} managed home`,
        );
        const strategy = profile.process.confinement;
        if (strategy.kind === "immutable-managed-profile") {
          const syntheticHome = yield* canonicalManagedDirectory(
            join(managedHome, "home"),
            `${name} synthetic home`,
          );
          const temporaryDirectory = yield* canonicalManagedDirectory(
            options.temporaryDirectory ?? join(managedHome, "tmp"),
            `${name} temporary directory`,
          );
          const root =
            input.root === input.managedHome
              ? managedHome
              : yield* canonicalExistingDirectory(input.root, `${name} Project root`);
          const managedEntries = yield* Effect.try({
            try: () => new Set(readdirSync(managedHome)),
            catch: () =>
              failure("incompatible", `${name} managed profile could not be inspected safely.`),
          });
          if (strategy.forbiddenEntries.some((entry) => managedEntries.has(entry))) {
            return yield* Effect.fail(
              failure(
                "incompatible",
                `${name} managed profile contains forbidden executable configuration.`,
              ),
            );
          }
          const configPath = join(managedHome, strategy.configurationFileName);
          yield* prepareImmutableConfiguration(profile, configPath, strategy.configuration);
          try {
            requireSandboxExec({ platform, sandboxPath });
          } catch {
            return yield* Effect.fail(
              failure("incompatible", `${name} requires the macOS Seatbelt runtime.`),
            );
          }
          const forbiddenPaths = [
            ...strategy.forbiddenEntries.map((entry) => join(managedHome, entry)),
            ...strategy.forbiddenRootEntries.map((entry) => join(root, entry)),
          ];
          const immutableRules = [
            seatbeltDenyRule("file-write*", configPath),
            ...forbiddenPaths.flatMap((path) => [
              seatbeltDenyRule("file-read*", path),
              seatbeltDenyRule("file-write*", path),
            ]),
          ];
          const fullAccess = input.executionPolicy === "full-access";
          const sideEffects =
            decidesCodeEffectsByApproval(input.executionPolicy) && input.mode !== "chat";
          const binaryPath = realpathSync(input.binaryPath);
          const runtimeReadPaths = [
            "/System",
            "/Library",
            "/usr",
            "/bin",
            "/sbin",
            dirname(binaryPath),
            dirname(dirname(binaryPath)),
            root,
            managedHome,
            temporaryDirectory,
          ];
          const networkEgress = materializeOsNetworkEgress(
            resolveDefaultThreadEgressPolicy({
              mode: input.mode,
              executionPolicy: input.executionPolicy,
            }),
          );
          const seatbeltProfile = fullAccess
            ? ["(version 1)", "(allow default)", ...immutableRules].join("\n")
            : [
                "(version 1)",
                "(deny default)",
                "(allow signal (target self))",
                "(allow sysctl-read)",
                ...(networkEgress === "allow" ? ["(allow network*)"] : []),
                `(allow process-exec (literal "${escapeSeatbeltPath(binaryPath)}"))`,
                ...(sideEffects ? ["(allow process-exec)", "(allow process-fork)"] : []),
                ...runtimeReadPaths.map((path) => seatbeltAllowRule("file-read*", path)),
                seatbeltAllowRule("file-write*", managedHome),
                seatbeltAllowRule("file-write*", temporaryDirectory),
                ...(sideEffects ? [seatbeltAllowRule("file-write*", root)] : []),
                '(allow file-write-data (literal "/dev/null"))',
                ...immutableRules,
              ].join("\n");
          const launch = wrapCommandInSandboxExec({
            sandboxPath,
            profile: seatbeltProfile,
            executable: input.binaryPath,
            args: profile.process.args({ root, managedHome }),
          });
          return {
            command: launch.command,
            args: launch.args,
            cwd: root,
            environment: {
              ...input.environment,
              HOME: syntheticHome,
              [strategy.homeVariable]: managedHome,
              TMPDIR: temporaryDirectory,
            },
          };
        }

        const hostAuthentication = yield* prepareHostAuthentication(
          profile,
          managedHome,
          options.hostAuthenticationPath,
        );
        yield* writeManagedFiles(profile, { managedHome, executionPolicy: input.executionPolicy });
        const root =
          input.root === input.managedHome
            ? managedHome
            : yield* canonicalExistingDirectory(input.root, `${name} Project root`);
        const temporaryDirectory = yield* canonicalTemporaryDirectory(
          options.temporaryDirectory ?? input.environment.TMPDIR ?? "/tmp",
          name,
        );
        const args = profile.process.args({ root, managedHome });
        if (input.executionPolicy === "full-access") {
          return { command: input.binaryPath, args, cwd: root, environment: input.environment };
        }
        try {
          requireSandboxExec({ platform, sandboxPath });
        } catch {
          return yield* Effect.fail(
            failure("incompatible", `${name} requires the macOS Seatbelt runtime.`),
          );
        }
        const binaryDirectory = dirname(realpathSync(input.binaryPath));
        const binaryRuntimeDirectory = dirname(binaryDirectory);
        const configuredBinaryDirectory = dirname(input.binaryPath);
        try {
          const networkEgress = materializeOsNetworkEgress(
            resolveDefaultThreadEgressPolicy({
              mode: input.mode,
              executionPolicy: input.executionPolicy,
            }),
          );
          const seatbeltProfile = buildDenyDefaultSeatbeltProfile({
            boundRoot: root,
            temporaryDirectory,
            writeBoundRoot: input.executionPolicy !== "plan",
            additionalWriteRoots: [managedHome, ...hostAuthentication.writePaths],
            allowFileReadStar: true,
            networkEgress,
            readRoots: [
              root,
              managedHome,
              ...hostAuthentication.readPaths,
              binaryDirectory,
              binaryRuntimeDirectory,
              configuredBinaryDirectory,
              temporaryDirectory,
            ],
            privateHomeAllowPaths: [
              root,
              managedHome,
              ...hostAuthentication.readPaths,
              binaryRuntimeDirectory,
              configuredBinaryDirectory,
            ],
          });
          const launch = wrapCommandInSandboxExec({
            sandboxPath,
            profile: seatbeltProfile,
            executable: input.binaryPath,
            args,
          });
          return {
            command: launch.command,
            args: launch.args,
            cwd: root,
            environment: input.environment,
          };
        } catch {
          return yield* Effect.fail(
            failure("incompatible", `${name} private-path confinement could not be prepared.`),
          );
        }
      }),
  };
}

function validateBinaryPath(
  profile: AcpProviderProfile,
  binaryPath: string,
): ProviderFailure | undefined {
  if (!isAbsolute(binaryPath)) {
    return failure("invalid-configuration", `${profile.displayName} binary path must be absolute.`);
  }
  try {
    const metadata = statSync(binaryPath);
    accessSync(binaryPath, constants.X_OK);
    if (!metadata.isFile()) throw new Error();
  } catch {
    return failure(
      "invalid-configuration",
      `${profile.displayName} binary path must reference an executable file.`,
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

async function waitForGroupExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(child) && Date.now() < deadline) await wait(10);
  return !processGroupExists(child);
}

function makeTerminator(
  displayName: string,
  child: ChildProcess,
  timeoutMs: number,
): () => Promise<void> {
  let termination: Promise<void> | undefined;
  return () => {
    termination ??= (async () => {
      if (!processGroupExists(child)) return;
      signalProcessGroup(child, "SIGTERM");
      if (await waitForGroupExit(child, timeoutMs)) return;
      signalProcessGroup(child, "SIGKILL");
      if (!(await waitForGroupExit(child, timeoutMs))) {
        throw new Error(`${displayName} process group did not terminate after SIGKILL.`);
      }
    })();
    return termination;
  };
}

function cleanupEffect(displayName: string, cleanup: () => Promise<void>): Effect.Effect<void> {
  return Effect.tryPromise({
    try: cleanup,
    catch: () => new Error(`${displayName} process cleanup failed.`),
  }).pipe(Effect.orDie);
}

function parseVersion(
  profile: AcpProviderProfile,
  output: string,
): { readonly version: string; readonly supported: boolean } | undefined {
  const match = profile.process.versionPattern.exec(output);
  if (match === null) return undefined;
  const current = [Number(match[1]), Number(match[2]), Number(match[3])];
  const minimum = profile.process.minimumVersion;
  let supported = true;
  for (let index = 0; index < current.length; index += 1) {
    if (current[index]! > minimum[index]!) break;
    if (current[index]! < minimum[index]!) {
      supported = false;
      break;
    }
  }
  return { version: `${match[1]}.${match[2]}.${match[3]}`, supported };
}

export function probeAcpBinary(
  profile: AcpProviderProfile,
  binaryPath: string,
  options: AcpProbeOptions = {},
): Effect.Effect<AcpBinaryProbe, ProviderFailure> {
  const name = profile.displayName;
  const invalid = validateBinaryPath(profile, binaryPath);
  if (invalid !== undefined) return Effect.fail(invalid);
  const outputBytes = options.outputBytes ?? DEFAULT_OUTPUT_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;

  return Effect.async<AcpBinaryProbe, ProviderFailure>((resume) => {
    const child = spawn(binaryPath, ["--version"], {
      detached: process.platform !== "win32",
      env: sanitizeAcpEnvironment(profile, options.inheritedEnvironment ?? process.env, {
        managedHome: process.env.TMPDIR ?? "/tmp",
      }),
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
    const terminate = makeTerminator(name, child, shutdownTimeoutMs);
    let output = Buffer.alloc(0);
    let overflow = false;
    let settled = false;
    const cleanupListeners = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onOutput);
      child.stderr.off("data", onOutput);
      child.off("error", onError);
      child.off("close", onClose);
    };
    const finish = (result: Effect.Effect<AcpBinaryProbe, ProviderFailure>) => {
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
                Effect.fail(failure("provider-failed", `${name} process receipt is unavailable.`)),
              );
          }
        },
        () => resume(Effect.fail(failure("provider-failed", `${name} probe cleanup failed.`))),
      );
    };
    const onOutput = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = outputBytes - output.length;
      if (bytes.length > remaining) overflow = true;
      if (remaining > 0) output = Buffer.concat([output, bytes.subarray(0, remaining)]);
    };
    const onError = () =>
      finish(Effect.fail(failure("unavailable", `${name} binary could not be started.`)));
    const onClose = (code: number | null) => {
      if (overflow) {
        finish(Effect.fail(failure("protocol", `${name} version output exceeded the limit.`)));
        return;
      }
      if (code !== 0) {
        finish(Effect.fail(failure("unavailable", `${name} version probe did not succeed.`)));
        return;
      }
      const parsed = parseVersion(profile, output.toString("utf8").trimEnd());
      if (parsed === undefined) {
        finish(
          Effect.fail(failure("protocol", `${name} returned an unrecognized version response.`)),
        );
        return;
      }
      if (!parsed.supported) {
        const minimum = profile.process.minimumVersion.join(".");
        finish(Effect.fail(failure("incompatible", `${name} ${minimum} or later is required.`)));
        return;
      }
      finish(Effect.succeed({ binaryPath, version: parsed.version }));
    };
    const timeout = setTimeout(
      () => finish(Effect.fail(failure("unavailable", `${name} version probe timed out.`))),
      timeoutMs,
    );
    child.stdout.on("data", onOutput);
    child.stderr.on("data", onOutput);
    child.once("error", onError);
    child.once("close", onClose);
    return cleanupEffect(name, async () => {
      if (!settled) {
        settled = true;
        cleanupListeners();
      }
      await terminate();
    });
  });
}

export function sanitizeAcpEnvironment(
  profile: AcpProviderProfile,
  inherited: NodeJS.ProcessEnv,
  input: {
    readonly managedHome: string;
    readonly executionPolicy?: ProviderExecutionPolicy;
    readonly apiKey?: string;
  },
): NodeJS.ProcessEnv {
  const passthrough = new Set(profile.process.passthroughVariables);
  const environment = Object.fromEntries(
    Object.entries(inherited).filter(
      ([key, value]) => value !== undefined && (passthrough.has(key) || key.startsWith("LC_")),
    ),
  );
  return {
    ...environment,
    ...profile.process.environment({
      managedHome: input.managedHome,
      executionPolicy: input.executionPolicy ?? "approval-gated",
      ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
    }),
    ...profile.process.guards,
  };
}

interface ManagedConnection {
  readonly connection: AcpConnection;
  readonly terminate: () => Promise<void>;
}

function acquireConnection(
  profile: AcpProviderProfile,
  launch: AcpLaunchSpec,
  version: string,
  options: Required<Pick<AcpProcessOptions, "shutdownTimeoutMs" | "startupTimeoutMs">> &
    Pick<AcpProcessOptions, "onDiagnostic" | "stderrBytes">,
  onProcessStarted?: ProviderProcessStartedListener,
): Effect.Effect<ManagedConnection, ProviderFailure> {
  const name = profile.displayName;
  return Effect.async<ManagedConnection, ProviderFailure>((resume) => {
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      detached: process.platform !== "win32",
      env: launch.environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const terminateGroup = makeTerminator(name, child, options.shutdownTimeoutMs);
    const acp = makeAcpClient({
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      limits: {
        requestTimeoutMs: options.startupTimeoutMs,
        ...(options.stderrBytes === undefined ? {} : { stderrBytes: options.stderrBytes }),
      },
      onStderr: ({ capturedBytes, truncated }) => {
        if (capturedBytes === 0) return;
        try {
          options.onDiagnostic?.(
            `${name} runtime stderr captured (${capturedBytes} bytes${truncated ? ", truncated" : ""}).`,
          );
        } catch {
          // Diagnostic consumers cannot affect lifecycle.
        }
      },
    });
    const childExited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    let ownershipReady: Promise<void> = Promise.resolve();
    if (child.pid !== undefined && onProcessStarted !== undefined) {
      ownershipReady = onProcessStarted({ pid: child.pid, exited: childExited }).then(
        () => undefined,
      );
      void ownershipReady.catch(() => undefined);
    }
    let cleanupPromise: Promise<void> | undefined;
    let settled = false;
    const cleanup = () => {
      cleanupPromise ??= (async () => {
        const suppressStdinError = () => undefined;
        child.stdin.on("error", suppressStdinError);
        try {
          await acp.close().catch(() => undefined);
          await Promise.race([childExited, wait(25)]);
          await terminateGroup();
        } finally {
          child.stdin.off("error", suppressStdinError);
          child.stdin.destroy();
        }
      })();
      return cleanupPromise;
    };
    const exited = Promise.race([
      childExited,
      acp.exited.catch((error: unknown) => Promise.reject(error)),
    ]).then(() => undefined);
    void exited.catch(() => undefined);
    const finishFailure = (providerFailure: ProviderFailure) => {
      if (settled) return;
      settled = true;
      child.off("error", onError);
      child.off("exit", onEarlyExit);
      void cleanup().then(
        () => resume(Effect.fail(providerFailure)),
        () => resume(Effect.fail(failure("provider-failed", `${name} cleanup failed.`))),
      );
    };
    const onError = () =>
      finishFailure(failure("unavailable", `${name} ACP process could not be started.`));
    const onEarlyExit = () =>
      finishFailure(failure("unavailable", `${name} ACP process exited during startup.`));
    child.once("error", onError);
    child.once("exit", onEarlyExit);
    void ownershipReady.then(
      () =>
        acp
          .initialize(
            profile.authentication.kind === "delegated-browser"
              ? { "browser-auth-delegated": true, "terminal-auth": false }
              : undefined,
          )
          .then(
            (initialized) => {
              if (settled || child.pid === undefined) return;
              const identityMatches = profile.process.verifyAgentInfo
                ? profile.process.verifyAgentInfo(initialized)
                : initialized.agentInfo?.name === profile.process.agentName;
              if (initialized.protocolVersion !== 1 || !identityMatches) {
                finishFailure(failure("incompatible", `${name} ACP negotiation was incompatible.`));
                return;
              }
              settled = true;
              child.off("error", onError);
              child.off("exit", onEarlyExit);
              resume(
                Effect.succeed({
                  connection: {
                    version,
                    pid: child.pid,
                    root: launch.cwd,
                    initialized,
                    acp,
                    exited,
                  },
                  terminate: cleanup,
                }),
              );
            },
            (error: unknown) =>
              finishFailure(
                error instanceof AcpFailure && error.kind === "timeout"
                  ? failure("unavailable", `${name} ACP initialization timed out.`)
                  : failure("protocol", `${name} ACP initialization failed.`),
              ),
          ),
      () => finishFailure(failure("unavailable", `${name} process receipt is unavailable.`)),
    );
    return cleanupEffect(name, async () => {
      if (!settled) settled = true;
      child.off("error", onError);
      child.off("exit", onEarlyExit);
      await cleanup();
    });
  });
}

export function makeAcpProcessLive(options: AcpProcessOptions = {}): AcpProcessPort {
  const confinement = options.confinement ?? makeAcpConfinementLive();
  const inheritedEnvironment = options.inheritedEnvironment ?? process.env;
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  return {
    start: (input) =>
      Effect.gen(function* () {
        const { profile } = input;
        const probe = yield* probeAcpBinary(profile, input.binaryPath, {
          inheritedEnvironment,
          shutdownTimeoutMs,
          ...(input.onProcessStarted === undefined
            ? {}
            : { onProcessStarted: input.onProcessStarted }),
        });
        const environment = sanitizeAcpEnvironment(profile, inheritedEnvironment, {
          managedHome: input.managedHome,
          executionPolicy: input.executionPolicy,
          ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
        });
        const launch = yield* confinement.prepare({
          profile,
          binaryPath: input.binaryPath,
          root: input.root,
          managedHome: input.managedHome,
          mode: input.mode,
          executionPolicy: input.executionPolicy,
          environment,
        });
        const managed = yield* Effect.acquireRelease(
          acquireConnection(
            profile,
            launch,
            probe.version,
            {
              shutdownTimeoutMs,
              startupTimeoutMs,
              ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
              ...(options.stderrBytes === undefined ? {} : { stderrBytes: options.stderrBytes }),
            },
            input.onProcessStarted,
          ),
          ({ terminate }) => cleanupEffect(profile.displayName, terminate),
        );
        return managed.connection;
      }),
  };
}
