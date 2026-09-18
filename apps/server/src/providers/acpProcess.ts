import { spawn, type ChildProcess } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ProviderExecutionPolicy, ProviderFailure } from "@octant/contracts";
import { Effect, type Scope } from "effect";
import type { AcpProviderProfile, AcpSessionMode } from "./acpProfiles";
import { AcpFailure, makeAcpClient, type AcpClient, type AcpInitializeResult } from "./acpProtocol";
import type { ProviderProcessStartedListener } from "./providerRuntimeRegistry";
import {
  makeSeatbeltConfinementLive,
  SeatbeltConfinementError,
  requireSandboxExec,
  seatbeltDenyRule,
  wrapCommandInSandboxExec,
} from "../process/seatbeltProfile";
import { buildLinuxAllowDefaultDenyLaunch } from "../process/linuxConfinement";
import {
  materializeOsNetworkEgress,
  resolveProviderRuntimeEgressPolicy,
  resolveProbeEgressPolicy,
} from "../process/threadEgressPolicy";
import { makeBoundedProviderStderr } from "./providerProcessDiagnostic";

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
  /** A non-mutating readiness check may contact the provider without a thread. */
  readonly purpose?: "probe" | "session";
  readonly environment: NodeJS.ProcessEnv;
  /** Exact loopback ports owned by app-managed ACP tool bridges for this process. */
  readonly loopbackPorts?: ReadonlyArray<number>;
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
  /** A non-mutating readiness check may contact the provider without a thread. */
  readonly purpose?: "probe" | "session";
  readonly apiKey?: string;
  /** Exact loopback ports owned by app-managed ACP tool bridges for this process. */
  readonly loopbackPorts?: ReadonlyArray<number>;
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

function failure(
  category: ProviderFailure["category"],
  message: string,
  extras?: {
    readonly reason?: ProviderFailure["reason"];
    readonly diagnostic?: ProviderFailure["diagnostic"];
  },
): ProviderFailure {
  return {
    category,
    message,
    ...(extras?.reason === undefined ? {} : { reason: extras.reason }),
    ...(extras?.diagnostic === undefined ? {} : { diagnostic: extras.diagnostic }),
  };
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

function canonicalExistingReadPaths(
  profile: AcpProviderProfile,
): Effect.Effect<ReadonlyArray<string>, ProviderFailure> {
  return Effect.try({
    try: () => {
      const paths: string[] = [];
      for (const path of profile.process.hostReadPaths ?? []) {
        if (!isAbsolute(path) || resolve(path) !== path) throw new Error();
        if (!existsSync(path)) continue;
        const canonical = realpathSync(path);
        const metadata = statSync(canonical);
        if (!metadata.isFile() && !metadata.isDirectory()) throw new Error();
        paths.push(canonical);
      }
      return [...new Set(paths)];
    },
    catch: () =>
      failure(
        "invalid-configuration",
        `${profile.displayName} user-owned configuration path is not safe to read.`,
      ),
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
  readonly forbiddenPaths: ReadonlyArray<string>;
  readonly environment: Readonly<Record<string, string>>;
}

function prepareHostAuthentication(
  profile: AcpProviderProfile,
  managedHome: string,
  overridePath: string | undefined,
): Effect.Effect<HostAuthenticationPaths, ProviderFailure> {
  const hostAuthentication = profile.process.hostAuthentication;
  if (hostAuthentication === undefined)
    return Effect.succeed({ readPaths: [], writePaths: [], forbiddenPaths: [], environment: {} });
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
      Effect.map((canonical) => ({
        readPaths: [canonical],
        writePaths: [canonical],
        forbiddenPaths: (hostAuthentication.forbiddenEntries ?? []).map((entry) =>
          join(canonical, entry),
        ),
        environment: hostAuthentication.environment?.(canonical) ?? {},
      })),
    );
  }
  const managedCredential = join(managedHome, hostAuthentication.managedRelativePath);
  return Effect.try({
    try: () => {
      mkdirSync(dirname(managedCredential), { recursive: true, mode: 0o700 });
      if (existsSync(path) && !existsSync(managedCredential)) symlinkSync(path, managedCredential);
      return {
        readPaths: existsSync(path) ? [path] : [],
        writePaths: [],
        forbiddenPaths: [],
        environment: {},
      };
    },
    catch: () =>
      failure(
        "invalid-configuration",
        `${profile.displayName} managed configuration could not be prepared.`,
      ),
  });
}

function hostExtensionDenyPaths(
  profile: AcpProviderProfile,
  hostDirectory: string | undefined,
  root: string,
): ReadonlyArray<string> {
  const hostEntries = profile.process.hostDeniedEntries ?? [];
  const rootEntries = profile.process.forbiddenRootEntries ?? [];
  return [
    ...(hostDirectory === undefined ? [] : hostEntries.map((entry) => join(hostDirectory, entry))),
    ...rootEntries.map((entry) => join(root, entry)),
  ];
}

export function makeAcpConfinementLive(options: AcpConfinementOptions = {}): AcpConfinementPort {
  const platform = options.platform ?? process.platform;
  const sandboxPath =
    options.sandboxPath ?? (platform === "darwin" ? "/usr/bin/sandbox-exec" : "/usr/bin/bwrap");
  return {
    prepare: (input) =>
      Effect.gen(function* () {
        const { profile } = input;
        const name = profile.displayName;
        const invalidBinary = validateBinaryPath(profile, input.binaryPath);
        if (invalidBinary !== undefined) return yield* Effect.fail(invalidBinary);
        if (
          profile.process.requiresChildServer === true &&
          (input.mode === "chat" || input.executionPolicy === "plan")
        ) {
          return yield* Effect.fail(
            failure(
              "incompatible",
              `${profile.displayName} cannot run in Chat or Plan mode because its ACP entrypoint requires a child server; use Code or Work mode.`,
            ),
          );
        }
        const managedHome = yield* canonicalManagedDirectory(
          input.managedHome,
          `${name} managed home`,
        );
        const loopbackPorts = input.loopbackPorts ?? [];
        if (loopbackPorts.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)) {
          return yield* Effect.fail(
            failure("invalid-configuration", `${name} app-managed tool bridge port is invalid.`),
          );
        }
        const hostAuthentication = yield* prepareHostAuthentication(
          profile,
          managedHome,
          options.hostAuthenticationPath,
        );
        const hostReadPaths = yield* canonicalExistingReadPaths(profile);
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
        const denyPaths = [
          ...hostAuthentication.forbiddenPaths,
          ...hostExtensionDenyPaths(
            profile,
            hostAuthentication.writePaths[0] ?? hostAuthentication.readPaths[0],
            root,
          ),
        ];
        // Full access is unrestricted except for 0006's static MCP/skills/hooks
        // denials. Darwin uses allow-default plus trailing denies. Linux binds
        // the host root and overlays the same paths.
        if (input.executionPolicy === "full-access") {
          if (denyPaths.length === 0) {
            return {
              command: input.binaryPath,
              args,
              cwd: root,
              environment: { ...input.environment, ...hostAuthentication.environment },
            };
          }
          const launch = yield* Effect.try({
            try: () => {
              if (platform === "darwin") {
                requireSandboxExec({ platform, sandboxPath });
                return wrapCommandInSandboxExec({
                  sandboxPath,
                  executable: input.binaryPath,
                  args,
                  profile: [
                    "(version 1)",
                    "(allow default)",
                    ...denyPaths.flatMap((path) => [
                      seatbeltDenyRule("file-read*", path),
                      seatbeltDenyRule("file-write*", path),
                    ]),
                  ].join("\n"),
                });
              }
              if (platform === "linux") {
                return buildLinuxAllowDefaultDenyLaunch(
                  {
                    executable: input.binaryPath,
                    args,
                    cwd: root,
                    denyPaths,
                  },
                  { bwrapPath: sandboxPath },
                );
              }
              throw new SeatbeltConfinementError(
                "incompatible",
                `${name} Full access extension denials require macOS or Linux.`,
              );
            },
            catch: (error) =>
              failure(
                error instanceof SeatbeltConfinementError &&
                  error.reason === "invalid-configuration"
                  ? "invalid-configuration"
                  : "incompatible",
                error instanceof SeatbeltConfinementError
                  ? error.message
                  : `${name} Full access extension denials could not be prepared.`,
              ),
          });
          return {
            command: launch.command,
            args: launch.args,
            cwd: root,
            environment: { ...input.environment, ...hostAuthentication.environment },
          };
        }
        const binaryDirectory = dirname(realpathSync(input.binaryPath));
        const binaryRuntimeDirectory = dirname(binaryDirectory);
        const configuredBinaryDirectory = dirname(input.binaryPath);
        // Connection checks are not Chat threads. They must reach the
        // provider's own control plane to authenticate and discover models,
        // while remaining read-only and rooted in the managed home.
        const networkEgress = materializeOsNetworkEgress(
          input.purpose === "probe"
            ? resolveProbeEgressPolicy()
            : resolveProviderRuntimeEgressPolicy({
                mode: input.mode,
                executionPolicy: input.executionPolicy,
              }),
        );
        const confinement = makeSeatbeltConfinementLive({
          platform,
          sandboxPath,
        });
        const loopbackRules =
          input.loopbackPorts === undefined || input.loopbackPorts.length === 0
            ? []
            : input.loopbackPorts.map(
                (port) => `(allow network-outbound (remote ip "localhost:${port}"))`,
              );
        const extraRules = [
          ...loopbackRules,
          ...(platform === "darwin"
            ? denyPaths.flatMap((path) => [
                seatbeltDenyRule("file-read*", path),
                seatbeltDenyRule("file-write*", path),
              ])
            : []),
        ];
        const launch = yield* Effect.try({
          try: () =>
            confinement.prepare({
              executable: input.binaryPath,
              args,
              boundRoot: root,
              temporaryDirectory,
              networkEgress,
              writeBoundRoot: !(input.executionPolicy === "plan" || input.mode === "chat"),
              allowProcessExec: !(input.executionPolicy === "plan" || input.mode === "chat"),
              allowProcessFork: !(input.executionPolicy === "plan" || input.mode === "chat"),
              additionalWriteRoots: [managedHome, ...hostAuthentication.writePaths],
              additionalDenyReadPaths: denyPaths,
              additionalDenyWritePaths: denyPaths,
              allowFileReadStar: true,
              readRoots: [
                root,
                managedHome,
                ...hostAuthentication.readPaths,
                ...hostReadPaths,
                binaryDirectory,
                binaryRuntimeDirectory,
                configuredBinaryDirectory,
                temporaryDirectory,
              ],
              privateHomeAllowPaths: [
                root,
                managedHome,
                ...hostAuthentication.readPaths,
                ...hostReadPaths,
                binaryRuntimeDirectory,
                configuredBinaryDirectory,
              ],
              ...(extraRules.length === 0 ? {} : { extraRules }),
            }),
          catch: (error) =>
            failure(
              error instanceof SeatbeltConfinementError && error.reason === "invalid-configuration"
                ? "invalid-configuration"
                : "incompatible",
              error instanceof SeatbeltConfinementError
                ? error.message
                : `${name} private-path confinement could not be prepared.`,
            ),
        });
        return {
          command: launch.command,
          args: launch.args,
          cwd: root,
          environment: { ...input.environment, ...hostAuthentication.environment },
        };
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

function resolveNpmPackageVersion(
  profile: AcpProviderProfile,
  binaryPath: string,
): string | undefined {
  const npmPackageName = profile.process.npmPackageName;
  if (npmPackageName === undefined) return undefined;
  let directory: string;
  try {
    directory = dirname(realpathSync(binaryPath));
  } catch {
    return undefined;
  }
  let current = directory;
  while (true) {
    const packageJsonPath = join(current, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const content = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
          readonly name?: string;
          readonly version?: string;
        };
        if (content.name === npmPackageName && typeof content.version === "string") {
          return content.version;
        }
      } catch {
        // Keep walking for a matching package manifest.
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function probeNpmPackageVersion(
  profile: AcpProviderProfile,
  binaryPath: string,
): Effect.Effect<AcpBinaryProbe, ProviderFailure> {
  const name = profile.displayName;
  const invalid = validateBinaryPath(profile, binaryPath);
  if (invalid !== undefined) return Effect.fail(invalid);
  const resolved = resolveNpmPackageVersion(profile, binaryPath);
  if (resolved === undefined) {
    return Effect.fail(
      failure("protocol", `${name} package version could not be resolved from its install tree.`),
    );
  }
  const parsed = parseVersion(profile, resolved);
  if (parsed === undefined) {
    return Effect.fail(
      failure("protocol", `${name} returned an unrecognized package version response.`),
    );
  }
  if (!parsed.supported) {
    const minimum = profile.process.minimumVersion.join(".");
    return Effect.fail(
      failure("incompatible", `${name} ${minimum} or later is required.`, {
        reason: "runtime-incompatible",
      }),
    );
  }
  return Effect.succeed({ binaryPath, version: parsed.version });
}

export function probeAcpBinary(
  profile: AcpProviderProfile,
  binaryPath: string,
  options: AcpProbeOptions = {},
): Effect.Effect<AcpBinaryProbe, ProviderFailure> {
  if (profile.process.npmPackageName !== undefined) {
    return probeNpmPackageVersion(profile, binaryPath);
  }
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
      finish(
        Effect.fail(
          failure("unavailable", `${name} binary could not be started.`, {
            reason: "runtime-unavailable",
          }),
        ),
      );
    const onClose = (code: number | null) => {
      if (overflow) {
        finish(Effect.fail(failure("protocol", `${name} version output exceeded the limit.`)));
        return;
      }
      if (code !== 0) {
        finish(
          Effect.fail(
            failure("unavailable", `${name} version probe did not succeed.`, {
              reason: "runtime-unavailable",
            }),
          ),
        );
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
        finish(
          Effect.fail(
            failure("incompatible", `${name} ${minimum} or later is required.`, {
              reason: "runtime-incompatible",
            }),
          ),
        );
        return;
      }
      finish(Effect.succeed({ binaryPath, version: parsed.version }));
    };
    const timeout = setTimeout(
      () =>
        finish(
          Effect.fail(
            failure("unavailable", `${name} version probe timed out.`, {
              reason: "runtime-unavailable",
            }),
          ),
        ),
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
    const boundedStderr = makeBoundedProviderStderr(options.stderrBytes);
    child.stderr.on("data", boundedStderr.append);
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
      child.off("close", onEarlyExit);
      void cleanup().then(
        () => resume(Effect.fail(providerFailure)),
        () => resume(Effect.fail(failure("provider-failed", `${name} cleanup failed.`))),
      );
    };
    const onError = () =>
      finishFailure({
        ...failure("unavailable", `${name} ACP process could not be started.`),
        diagnostic: { stage: "launch", kind: "spawn-failed", detectedVersion: version },
      });
    const onEarlyExit = (exitCode: number | null, signal: NodeJS.Signals | null) =>
      finishFailure({
        ...failure("unavailable", `${name} ACP process exited during startup.`),
        diagnostic: {
          stage: "initialization",
          kind: exitCode === null ? "signaled" : "exited",
          ...(exitCode === null ? {} : { exitCode }),
          ...(signal === null ? {} : { signal }),
          detectedVersion: version,
          ...(boundedStderr.context() === undefined
            ? {}
            : { stderrContext: boundedStderr.context() }),
        },
      });
    child.once("error", onError);
    child.once("close", onEarlyExit);
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
                finishFailure({
                  ...failure("incompatible", `${name} ACP negotiation was incompatible.`),
                  diagnostic: {
                    stage: "initialization",
                    kind: "protocol-failed",
                    detectedVersion: version,
                  },
                });
                return;
              }
              settled = true;
              child.off("error", onError);
              child.off("close", onEarlyExit);
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
            (error: unknown) => {
              if (!(error instanceof AcpFailure) || error.kind !== "timeout") {
                void Promise.race([childExited, wait(25)]).then(() => {
                  if (child.exitCode !== null || child.signalCode !== null) {
                    onEarlyExit(child.exitCode, child.signalCode);
                    return;
                  }
                  finishFailure({
                    ...failure("protocol", `${name} ACP initialization failed.`),
                    diagnostic: {
                      stage: "initialization",
                      kind: "protocol-failed",
                      detectedVersion: version,
                      ...(boundedStderr.context() === undefined
                        ? {}
                        : { stderrContext: boundedStderr.context() }),
                    },
                  });
                });
                return;
              }
              finishFailure({
                ...failure("unavailable", `${name} ACP initialization timed out.`),
                diagnostic: {
                  stage: "initialization",
                  kind: "timed-out",
                  detectedVersion: version,
                  ...(boundedStderr.context() === undefined
                    ? {}
                    : { stderrContext: boundedStderr.context() }),
                },
              });
            },
          ),
      () => finishFailure(failure("unavailable", `${name} process receipt is unavailable.`)),
    );
    return cleanupEffect(name, async () => {
      if (!settled) settled = true;
      child.off("error", onError);
      child.off("close", onEarlyExit);
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
          ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
          environment,
          ...(input.loopbackPorts === undefined ? {} : { loopbackPorts: input.loopbackPorts }),
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
