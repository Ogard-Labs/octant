import {
  type ClaudeAuthentication,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSessionId,
} from "@octant/contracts";
import { spawn } from "node:child_process";
import { access, lstat, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Effect, Exit, Scope, Stream } from "effect";

import type { ProviderCredentialResolver } from "./credentialBrokerClient";
import { makeClaudeAgentSdkPort, type ClaudeAgentSdkPort } from "./claudeAgentSdkPort";
import {
  makeClaudeDriver,
  type ClaudeResumeIdentity,
  type ClaudeResumeIdentityPort,
} from "./claudeDriver";
import { makeClaudeProcessLive, type ClaudeProcessPort } from "./claudeProcess";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

export const claudeSmokeBinaryPath = "/opt/homebrew/bin/claude";
export const claudeSmokeMinimumRuntimeVersion = "2.1.210";
export const claudeSmokeOuterTimeoutMs = 900_000;
export const claudeSmokeCleanupMarginMs = 45_000;
export const claudeSmokeStageTimeouts = {
  prerequisites: 10_000,
  probe: 60_000,
  plan: 120_000,
  decline: 120_000,
  accept: 120_000,
  question: 120_000,
  interrupt: 90_000,
  resume: 120_000,
  cleanup: 30_000,
} as const;

type ClaudeSmokeStage = keyof typeof claudeSmokeStageTimeouts;

export interface ClaudeSmokeMetrics {
  readonly subscriptionProbeCalls: number;
  readonly brokerHasCalls: number;
  readonly brokerResolveCalls: number;
  readonly runtimeStarts: number;
  readonly apiCredentialInjected: boolean;
  readonly apiEnvironmentIsolated: boolean;
  readonly subscriptionEnvironmentIsolated: boolean;
  readonly resumeOpenedAtExactRoot: boolean;
  readonly resumeLookupAtExactRoot: boolean;
  readonly diagnostics: number;
  readonly configDirectoryCount: number;
}

export interface ClaudeSmokeCleanupStep {
  readonly label: string;
  readonly timeoutMs?: number;
  readonly run: () => Promise<void>;
}

export interface ClaudeConfigurationMetadata {
  readonly exists: boolean;
  readonly relativePath: string;
  readonly type?: "directory" | "file" | "other" | "symlink";
  readonly mode?: string;
  readonly uid?: string;
  readonly gid?: string;
  readonly inode?: string;
  readonly size?: string;
  readonly modifiedNanoseconds?: string;
  readonly changedNanoseconds?: string;
}

type ClaudeSmokeDriver = ReturnType<typeof makeClaudeDriver>;
type AcquiredClaudeConnection = Awaited<ReturnType<typeof acquireConnection>>;

export interface ClaudeSmokeHarness {
  readonly driver: ClaudeSmokeDriver;
  readonly projectRoot: string;
  readonly prepareRepository: () => Promise<void>;
  readonly repositoryStatus: () => Promise<string>;
  readonly pathExists: (path: string) => Promise<boolean>;
  readonly usingConnection: <T>(
    operation: (acquired: AcquiredClaudeConnection) => Promise<T>,
  ) => Promise<T>;
  readonly stage: <T>(label: ClaudeSmokeStage, operation: () => Promise<T>) => Promise<T>;
  readonly cleanupOwnedResources: () => Promise<void>;
  readonly removeTemporaryRepository: () => Promise<void>;
  readonly activeSessionCount: () => number;
  readonly resumeIdentityCount: () => number;
  readonly survivingConfigDirectories: () => Promise<readonly string[]>;
  readonly userConfigurationUnchanged: () => Promise<boolean>;
  readonly expectNoNewProcesses: () => Promise<void>;
  readonly metrics: () => ClaudeSmokeMetrics;
}

export async function createClaudeSmokeHarness(
  authentication: ClaudeAuthentication,
  instanceId: ProviderInstanceId,
): Promise<ClaudeSmokeHarness> {
  const apiKey = authentication === "api-key" ? requiredApiKey() : undefined;
  const baselineProcesses = await claudeSdkProcessIds();
  const userConfigBefore =
    authentication === "api-key" ? await snapshotClaudeConfigurationMetadata() : new Map();
  const canonicalTmp = await realpath(tmpdir());
  const createdRoot = await mkdtemp(join(canonicalTmp, `octant-claude-${authentication}-`));
  const projectRoot = await realpath(createdRoot);
  const registry = new ProviderRuntimeRegistry();
  const activeConnections = new Set<AcquiredClaudeConnection>();
  const resumeIdentities = new Map<string, ClaudeResumeIdentity>();
  const configDirectories = new Set<string>();
  let subscriptionProbeCalls = 0;
  let brokerHasCalls = 0;
  let brokerResolveCalls = 0;
  let runtimeStarts = 0;
  let apiCredentialInjected = false;
  let apiEnvironmentIsolated = true;
  let subscriptionEnvironmentIsolated = true;
  let resumeOpenedAtExactRoot = false;
  let resumeLookupAtExactRoot = false;
  let diagnostics = 0;

  const liveProcess = makeClaudeProcessLive({
    probeTimeoutMs: 10_000,
    shutdownTimeoutMs: 3_000,
    onDiagnostic: () => {
      diagnostics += 1;
    },
  });
  const processPort: ClaudeProcessPort = {
    probeVersion: liveProcess.probeVersion,
    probeSubscription: (path, environment) => {
      subscriptionProbeCalls += 1;
      return liveProcess.probeSubscription(path, environment);
    },
    spawn: (input) => {
      runtimeStarts += 1;
      if (authentication === "api-key") {
        const configDirectory = input.env.CLAUDE_CONFIG_DIR;
        apiCredentialInjected ||= input.env.ANTHROPIC_API_KEY === apiKey;
        apiEnvironmentIsolated &&=
          configDirectory !== undefined &&
          isPathInside(canonicalTmp, configDirectory) &&
          input.env.CLAUDE_SECURESTORAGE_CONFIG_DIR === undefined &&
          input.env.ANTHROPIC_AUTH_TOKEN === undefined &&
          input.env.CLAUDE_CODE_OAUTH_TOKEN === undefined;
        if (configDirectory !== undefined) configDirectories.add(configDirectory);
      } else {
        subscriptionEnvironmentIsolated &&=
          input.env.ANTHROPIC_API_KEY === undefined &&
          input.env.ANTHROPIC_AUTH_TOKEN === undefined &&
          input.env.CLAUDE_CODE_OAUTH_TOKEN === undefined;
      }
      return liveProcess.spawn(input);
    },
  };
  const liveSdk = makeClaudeAgentSdkPort({
    spawnClaudeCodeProcess: processPort.spawn,
  });
  const sdk: ClaudeAgentSdkPort = {
    openQuery: (input) => {
      if (input.resumeSessionId !== undefined) {
        resumeOpenedAtExactRoot ||= input.projectRoot === projectRoot;
      }
      return liveSdk.openQuery(input);
    },
    findSession: (input) => {
      resumeLookupAtExactRoot ||= input.projectRoot === projectRoot;
      return liveSdk.findSession(input);
    },
  };
  const credentialResolver: ProviderCredentialResolver = {
    has: async (providerInstanceId) => {
      brokerHasCalls += 1;
      assertSmoke(providerInstanceId === instanceId, "Credential broker instance mismatch.");
      return apiKey !== undefined;
    },
    resolve: async (providerInstanceId) => {
      brokerResolveCalls += 1;
      assertSmoke(providerInstanceId === instanceId, "Credential broker instance mismatch.");
      if (apiKey === undefined) throw new Error("Credential is unavailable.");
      return apiKey;
    },
  };
  const driver = makeClaudeDriver({
    instanceId,
    binaryPath: claudeSmokeBinaryPath,
    authentication,
    process: processPort,
    sdk,
    ...(authentication === "api-key" ? { credentialResolver } : {}),
    runtimeRegistry: registry,
    resumeIdentityPort: makeResumeIdentityPort(resumeIdentities),
    permissionPersistence: () => "current-session",
    isProjectConfinedPath,
    startupTimeoutMs: 30_000,
    interruptTimeoutMs: 15_000,
  });
  const cleanupOwnedResources = async () => {
    let cleanupError: unknown;
    try {
      await runClaudeSmokeCleanupSteps([
        ...[...activeConnections].map((acquired) => ({
          label: "connections",
          timeoutMs: 8_000,
          run: acquired.close,
        })),
        {
          label: "registry",
          timeoutMs: 8_000,
          run: () => registry.closeAll(),
        },
      ]);
    } catch (error) {
      cleanupError = error;
    } finally {
      activeConnections.clear();
      resumeIdentities.clear();
    }
    if (cleanupError !== undefined) throw cleanupError;
  };

  return {
    driver,
    projectRoot,
    prepareRepository: () => initializeRepository(projectRoot),
    repositoryStatus: () => gitStatus(projectRoot),
    pathExists,
    usingConnection: (operation) =>
      usingConnection(driver, instanceId, projectRoot, activeConnections, operation),
    stage: (label, operation) =>
      runStage(
        authentication,
        label,
        claudeSmokeStageTimeouts[label],
        cleanupOwnedResources,
        operation,
      ),
    cleanupOwnedResources,
    removeTemporaryRepository: () => rm(projectRoot, { recursive: true, force: true }),
    activeSessionCount: () => registry.activeSessionCount(instanceId),
    resumeIdentityCount: () => resumeIdentities.size,
    survivingConfigDirectories: async () => {
      const survivors: string[] = [];
      for (const directory of configDirectories) {
        if (await pathExists(directory)) survivors.push(directory);
      }
      return survivors;
    },
    userConfigurationUnchanged: async () =>
      sameClaudeConfigurationSnapshots(
        userConfigBefore,
        await snapshotClaudeConfigurationMetadata(),
      ),
    expectNoNewProcesses: () => expectNoNewClaudeSdkProcesses(baselineProcesses, 10_000),
    metrics: () => ({
      subscriptionProbeCalls,
      brokerHasCalls,
      brokerResolveCalls,
      runtimeStarts,
      apiCredentialInjected,
      apiEnvironmentIsolated,
      subscriptionEnvironmentIsolated,
      resumeOpenedAtExactRoot,
      resumeLookupAtExactRoot,
      diagnostics,
      configDirectoryCount: configDirectories.size,
    }),
  };
}

export function collectClaudeSmokeTurn(
  events: Stream.Stream<ProviderRuntimeEvent, unknown>,
  sessionId: ProviderSessionId,
  onEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void, unknown> = () => Effect.void,
): Promise<readonly ProviderRuntimeEvent[]> {
  return Effect.runPromise(
    Stream.runCollect(
      events.pipe(
        Stream.filter((event) => event.sessionId === sessionId),
        Stream.tap(onEvent),
        Stream.take(257),
        Stream.takeUntil(isTerminalEvent),
      ),
    ),
  ).then((values) => {
    const collected = [...values];
    assertSmoke(collected.length <= 256, "Claude turn exceeded the event bound.");
    assertSmoke(isTerminalEvent(collected.at(-1)), "Claude turn returned no terminal event.");
    return collected;
  });
}

export function sanitizeClaudeSmokeError(error: unknown): string {
  return error instanceof Error && error.message.includes("timed out")
    ? "Installed Claude smoke timed out."
    : "Installed Claude smoke failed.";
}

export function versionAtLeast(actual: string, minimum: string): boolean {
  const parse = (value: string) => value.split(".").map((part) => Number(part));
  const left = parse(actual);
  const right = parse(minimum);
  if (
    left.length !== 3 ||
    right.length !== 3 ||
    left.some((part) => !Number.isSafeInteger(part) || part < 0) ||
    right.some((part) => !Number.isSafeInteger(part) || part < 0)
  ) {
    return false;
  }
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index]! > right[index]!;
  }
  return true;
}

export function assertSmoke(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export async function runClaudeSmokeCleanupSteps(
  steps: readonly ClaudeSmokeCleanupStep[],
): Promise<void> {
  const failedLabels = new Set<string>();
  for (const step of steps) {
    try {
      await withTimeout(
        Promise.resolve().then(step.run),
        step.timeoutMs ?? 8_000,
        async () => undefined,
        Math.min(step.timeoutMs ?? 8_000, 100),
        Math.min(step.timeoutMs ?? 8_000, 100),
      );
    } catch {
      failedLabels.add(/^[a-z][a-z-]*$/.test(step.label) ? step.label : "unknown");
    }
  }
  if (failedLabels.size > 0) {
    throw new Error(`Installed Claude cleanup failed: ${[...failedLabels].join(", ")}.`);
  }
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Promise<void> = async () => undefined,
  cancellationTimeoutMs = 100,
  settlementTimeoutMs = 100,
): Promise<T> {
  const timedOut = Symbol("timed-out");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let result: T | typeof timedOut;
  try {
    result = await Promise.race([
      promise,
      new Promise<typeof timedOut>((resolvePromise) => {
        timeout = setTimeout(() => resolvePromise(timedOut), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
  if (result !== timedOut) return result;
  const cancellation = await settleWithin(Promise.resolve().then(onTimeout), cancellationTimeoutMs);
  const settlement = await settleWithin(promise, settlementTimeoutMs);
  const cleanupFailed = cancellation !== "resolved" || settlement === "deadline";
  throw new Error(cleanupFailed ? "timed out and cleanup failed" : "timed out");
}

async function settleWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<"deadline" | "rejected" | "resolved"> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => "resolved" as const,
        () => "rejected" as const,
      ),
      new Promise<"deadline">((resolvePromise) => {
        timeout = setTimeout(() => resolvePromise("deadline"), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function isTerminalEvent(event: ProviderRuntimeEvent | undefined): boolean {
  return (
    event?.kind === "completed" ||
    event?.kind === "failed" ||
    event?.kind === "interrupted" ||
    event?.kind === "waiting"
  );
}

async function acquireConnection(
  driver: ClaudeSmokeDriver,
  instanceId: ProviderInstanceId,
  projectRoot: string,
) {
  const scope = await Effect.runPromise(Scope.make());
  const connection = await Effect.runPromise(
    driver.acquire({ instanceId, projectRoot }).pipe(Effect.provideService(Scope.Scope, scope)),
  );
  let closed = false;
  return {
    connection,
    close: async () => {
      if (closed) return;
      closed = true;
      await Effect.runPromise(Scope.close(scope, Exit.void));
    },
  };
}

async function usingConnection<T>(
  driver: ClaudeSmokeDriver,
  instanceId: ProviderInstanceId,
  projectRoot: string,
  active: Set<AcquiredClaudeConnection>,
  operation: (acquired: AcquiredClaudeConnection) => Promise<T>,
): Promise<T> {
  const acquired = await acquireConnection(driver, instanceId, projectRoot);
  active.add(acquired);
  try {
    return await operation(acquired);
  } finally {
    try {
      await acquired.close();
    } finally {
      active.delete(acquired);
    }
  }
}

function makeResumeIdentityPort(
  identities: Map<string, ClaudeResumeIdentity>,
): ClaudeResumeIdentityPort {
  const throwIfAborted = (signal: AbortSignal) => {
    if (signal.aborted) throw new Error("Resume identity operation was cancelled.");
  };
  return {
    lookup: async ({ sdkSessionId }, signal) => {
      throwIfAborted(signal);
      return identities.get(sdkSessionId);
    },
    put: async (identity, signal) => {
      throwIfAborted(signal);
      identities.set(identity.sdkSessionId, identity);
      if (signal.aborted) identities.delete(identity.sdkSessionId);
      throwIfAborted(signal);
    },
    remove: async ({ sdkSessionId }, signal) => {
      throwIfAborted(signal);
      identities.delete(sdkSessionId);
      throwIfAborted(signal);
    },
  };
}

function isProjectConfinedPath(projectRoot: string, candidate: string): boolean {
  if (!isAbsolute(candidate) || resolve(candidate) !== candidate) return false;
  const pathFromRoot = relative(projectRoot, candidate);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      !isAbsolute(pathFromRoot))
  );
}

function isPathInside(parent: string, candidate: string): boolean {
  if (!isAbsolute(candidate)) return false;
  const pathFromParent = relative(parent, candidate);
  return pathFromParent !== "" && pathFromParent !== ".." && !pathFromParent.startsWith("../");
}

async function initializeRepository(projectRoot: string): Promise<void> {
  await runCommand("/usr/bin/git", ["init", "--quiet"], projectRoot, 5_000);
  await writeFile(join(projectRoot, "seed.txt"), "octant claude smoke\n", "utf8");
  await runCommand("/usr/bin/git", ["add", "seed.txt"], projectRoot, 5_000);
  await runCommand(
    "/usr/bin/git",
    [
      "-c",
      "user.name=Octant Smoke",
      "-c",
      "user.email=smoke@invalid.example",
      "commit",
      "--quiet",
      "-m",
      "test fixture",
    ],
    projectRoot,
    5_000,
  );
}

async function gitStatus(projectRoot: string): Promise<string> {
  return runCommand("/usr/bin/git", ["status", "--short"], projectRoot, 5_000);
}

async function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  maxStdoutBytes = 16_384,
): Promise<string> {
  const child = spawn(command, args, {
    cwd,
    detached: process.platform !== "win32",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: homedir() },
    stdio: ["ignore", "pipe", "ignore"],
  });
  const stdoutChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stdoutOverflow = false;
  child.stdout.on("data", (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    stdoutBytes += buffer.byteLength;
    if (stdoutBytes > maxStdoutBytes) {
      stdoutOverflow = true;
      return;
    }
    stdoutChunks.push(buffer);
  });
  const exitCode = await withTimeout(
    new Promise<number | null>((resolvePromise, rejectPromise) => {
      child.once("error", rejectPromise);
      child.once("close", resolvePromise);
    }),
    timeoutMs,
    () => terminateProcessGroup(child),
  );
  if (exitCode !== 0) throw new Error("Installed smoke prerequisite command failed.");
  if (stdoutOverflow) throw new Error("Installed smoke command output exceeded its bound.");
  return Buffer.concat(stdoutChunks).toString("utf8");
}

async function claudeSdkProcessIds(): Promise<ReadonlySet<number>> {
  const output = await runCommand(
    "/bin/ps",
    ["-ax", "-o", "pid=,command="],
    resolve(tmpdir()),
    3_000,
    1_048_576,
  );
  return claudeSdkProcessIdsFromListing(output);
}

export function claudeSdkProcessIdsFromListing(output: string): ReadonlySet<number> {
  return new Set(
    output
      .split("\n")
      .filter(
        (line) =>
          line.includes(claudeSmokeBinaryPath) &&
          line.includes("--output-format") &&
          line.includes("stream-json"),
      )
      .map((line) => Number(/^\s*(\d+)/.exec(line)?.[1]))
      .filter(Number.isSafeInteger),
  );
}

async function expectNoNewClaudeSdkProcesses(
  baseline: ReadonlySet<number>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await claudeSdkProcessIds();
    if ([...current].every((pid) => baseline.has(pid))) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error("Installed Claude smoke left a runtime process.");
}

async function terminateProcessGroup(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  signalProcessGroup(child.pid, "SIGTERM");
  const deadline = Date.now() + 500;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  if (child.exitCode === null && child.signalCode === null)
    signalProcessGroup(child.pid, "SIGKILL");
}

function signalProcessGroup(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

export async function snapshotClaudeConfigurationMetadata(
  roots: readonly string[] = [
    process.env.CLAUDE_CONFIG_DIR,
    process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
    join(homedir(), ".claude"),
  ].filter((value): value is string => value !== undefined && isAbsolute(value)),
): Promise<Map<string, ClaudeConfigurationMetadata>> {
  const fingerprints = new Map<string, ClaudeConfigurationMetadata>();
  const uniqueRoots = [...new Set(roots)];
  for (const [rootIndex, root] of uniqueRoots.entries()) {
    await snapshotClaudeConfigurationEntry(root, rootIndex, "", 0, fingerprints);
  }
  return fingerprints;
}

const maxClaudeConfigurationEntries = 4_096;
const maxClaudeConfigurationDepth = 32;

async function snapshotClaudeConfigurationEntry(
  path: string,
  rootIndex: number,
  relativePath: string,
  depth: number,
  snapshot: Map<string, ClaudeConfigurationMetadata>,
): Promise<void> {
  if (snapshot.size >= maxClaudeConfigurationEntries) {
    throw new Error("Claude configuration metadata snapshot exceeded its entry bound.");
  }
  const key = `${rootIndex}:${relativePath || "."}`;
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error("Claude configuration metadata snapshot failed.");
    }
    snapshot.set(key, { exists: false, relativePath: relativePath || "." });
    return;
  }
  const type = metadata.isDirectory()
    ? "directory"
    : metadata.isFile()
      ? "file"
      : metadata.isSymbolicLink()
        ? "symlink"
        : "other";
  snapshot.set(key, {
    exists: true,
    relativePath: relativePath || ".",
    type,
    mode: metadata.mode.toString(),
    uid: metadata.uid.toString(),
    gid: metadata.gid.toString(),
    inode: metadata.ino.toString(),
    size: metadata.size.toString(),
    modifiedNanoseconds: metadata.mtimeNs.toString(),
    changedNanoseconds: metadata.ctimeNs.toString(),
  });
  if (type !== "directory") return;
  let entries: string[];
  try {
    entries = (await readdir(path)).sort();
  } catch {
    throw new Error("Claude configuration metadata snapshot failed.");
  }
  if (entries.length > 0 && depth >= maxClaudeConfigurationDepth) {
    throw new Error("Claude configuration metadata snapshot exceeded its depth bound.");
  }
  for (const entry of entries) {
    await snapshotClaudeConfigurationEntry(
      join(path, entry),
      rootIndex,
      relativePath === "" ? entry : join(relativePath, entry),
      depth + 1,
      snapshot,
    );
  }
}

export function sameClaudeConfigurationSnapshots(
  before: ReadonlyMap<string, ClaudeConfigurationMetadata>,
  after: ReadonlyMap<string, ClaudeConfigurationMetadata>,
): boolean {
  if (before.size !== after.size) return false;
  for (const [path, fingerprint] of before) {
    if (JSON.stringify(after.get(path)) !== JSON.stringify(fingerprint)) return false;
  }
  return true;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function runStage<T>(
  authentication: ClaudeAuthentication,
  label: ClaudeSmokeStage,
  timeoutMs: number,
  cleanup: () => Promise<void>,
  operation: () => Promise<T>,
): Promise<T> {
  console.log(`[claude-smoke:${authentication}] ${label}: start`);
  try {
    const result = await withTimeout(
      operation(),
      timeoutMs,
      cleanup,
      claudeSmokeCleanupMarginMs,
      1_000,
    );
    console.log(`[claude-smoke:${authentication}] ${label}: pass`);
    return result;
  } catch (error) {
    throw new Error(`${sanitizeClaudeSmokeError(error)} Stage: ${label}.`);
  }
}

function requiredApiKey(): string {
  const value = process.env.ANTHROPIC_API_KEY;
  if (value === undefined || value.trim().length === 0) {
    throw new Error(
      "API-key smoke is enabled but ANTHROPIC_API_KEY is not deliberately set; credential value is never logged.",
    );
  }
  return value;
}
