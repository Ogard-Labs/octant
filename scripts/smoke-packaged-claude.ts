import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { connect as connectTcp, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { domainToASCII, fileURLToPath } from "node:url";
import { createQuitAppleScript, waitForChildExit } from "./package-desktop";
import {
  PACKAGED_SMOKE_SERVER_URL,
  cleanupPackagedProcess,
  packagedServerEnvironment,
  type SmokeChildProcess,
} from "./packaged-smoke-process";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const appBundle = resolve(repositoryRoot, "out/Octant.app");
const executable = resolve(appBundle, "Contents/MacOS/Octant");
const serverEntry = resolve(appBundle, "Contents/Resources/app/apps/server/dist/main.mjs");
const helperPath = resolve(appBundle, "Contents/Resources/native/octant-keychain-helper");
const serverUrl = PACKAGED_SMOKE_SERVER_URL;

export type ClaudeAuthentication = "api-key" | "subscription";

export interface ClaudeProcessSnapshot {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly command: string;
}

export interface ClaudeConnectObserver {
  readonly port: number;
  readonly hostnames: () => ReadonlyArray<string>;
  readonly close: () => Promise<void>;
}

interface StartConnectObserverOptions {
  readonly connect?: (
    hostname: string,
    port: number,
  ) => { readonly host: string; readonly port: number };
}

const ALLOWED_HOSTS: Readonly<Record<ClaudeAuthentication, ReadonlySet<string>>> = {
  // Reviewed against https://code.claude.com/docs/en/corporate-proxy on 2026-07-17.
  "api-key": new Set(["api.anthropic.com"]),
  subscription: new Set(["api.anthropic.com", "claude.ai"]),
};

const FORBIDDEN_HOSTS = new Set([
  "statsig.anthropic.com",
  "sentry.io",
  "downloads.claude.ai",
  "storage.googleapis.com",
  "mcp-proxy.anthropic.com",
  "raw.githubusercontent.com",
]);

type HelperRequest =
  | { readonly operation: "set"; readonly providerInstanceId: string; readonly credential: string }
  | { readonly operation: "delete" | "has"; readonly providerInstanceId: string };

export function readClaudeSmokeModes(
  environment: NodeJS.ProcessEnv,
): ReadonlyArray<ClaudeAuthentication> {
  const modes: ClaudeAuthentication[] = [];
  if (environment.OCTANT_CLAUDE_SUBSCRIPTION_SMOKE === "1") modes.push("subscription");
  if (environment.OCTANT_CLAUDE_API_KEY_SMOKE === "1") modes.push("api-key");
  if (modes.length === 0) {
    throw new Error("Select at least one packaged Claude auth mode explicitly.");
  }
  return modes;
}

export function packagedClaudeEnvironment(
  source: NodeJS.ProcessEnv,
  dataDirectory: string,
  temporaryDirectory: string,
  observerPort: number,
): NodeJS.ProcessEnv {
  return {
    ...packagedServerEnvironment({ ...source, TMPDIR: temporaryDirectory }, dataDirectory),
    OCTANT_PACKAGED_PROVIDER_SMOKE_CONTROL: "1",
    OCTANT_CLAUDE_CONNECT_OBSERVER_URL: `http://127.0.0.1:${observerPort}`,
  };
}

export function sanitizedClaudeSmokeSubprocessEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  };
  for (const name of ["HOME", "TMPDIR", "LANG"] as const) {
    if (source[name] !== undefined) environment[name] = source[name];
  }
  for (const [name, value] of Object.entries(source)) {
    if (name.startsWith("LC_") && value !== undefined) environment[name] = value;
  }
  return environment;
}

export function smokeSubprocessSpec(
  command: string,
  args: ReadonlyArray<string>,
  source: NodeJS.ProcessEnv,
) {
  return {
    command,
    args,
    env: sanitizedClaudeSmokeSubprocessEnvironment(source),
  };
}

export function claudeProviderCommand(
  instanceId: string,
  binaryPath: string,
  authentication: ClaudeAuthentication,
) {
  return {
    kind: "create-claude-provider" as const,
    instanceId,
    expectedVersion: 0,
    displayName: `Claude packaged ${authentication === "api-key" ? "API-key" : "subscription"} smoke`,
    configuration: {
      kind: "claude-agent-sdk" as const,
      binaryPath,
      authentication,
    },
  };
}

export function claudeSmokeTurnRequest(modelId: string, uuid: () => string = randomUUID) {
  return {
    sessionId: uuid(),
    modelId,
    prompt: "Reply in at least four short streamed chunks and include exactly: octant-smoke",
    action: "complete" as const,
  };
}

export function claudeSmokeTurnPath(instanceId: string): string {
  return `/api/providers/${encodeURIComponent(instanceId)}/packaged-smoke-turn`;
}

export function keychainHelperInvocation(command: string, request: HelperRequest) {
  return {
    command,
    args: [] as readonly string[],
    stdin: `${JSON.stringify({ version: 1, ...request })}\n`,
  };
}

export type ClaudeKeychainHelperFailureCode =
  | "cleanup"
  | "exit"
  | "launch"
  | "response"
  | "timeout";

export class ClaudeKeychainHelperFailure extends Error {
  readonly name = "ClaudeKeychainHelperFailure";

  constructor(readonly code: ClaudeKeychainHelperFailureCode) {
    super(`Packaged Claude Keychain helper ${code} failure.`);
  }
}

export interface ClaudeKeychainHelperHandle {
  readonly closed: Promise<number | null>;
  readonly stdin: Promise<void>;
  readonly stdout: Promise<string>;
  readonly stderr: Promise<string>;
  readonly terminate: () => Promise<void>;
}

export type StartClaudeKeychainHelper = (
  command: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  stdin: string,
) => ClaudeKeychainHelperHandle;

export function createClaudeKeychainHandleRegistry(
  options: {
    readonly drainTimeoutMs?: number;
    readonly terminationTimeoutMs?: number;
  } = {},
) {
  const activeHandles = new Set<ClaudeKeychainHelperHandle>();
  const settlements = new WeakMap<ClaudeKeychainHelperHandle, Promise<void>>();
  const drainTimeoutMs = options.drainTimeoutMs ?? 1_000;
  const terminationTimeoutMs = options.terminationTimeoutMs ?? 1_500;
  return {
    track: (handle: ClaudeKeychainHelperHandle): ClaudeKeychainHelperHandle => {
      activeHandles.add(handle);
      const settlement = Promise.allSettled([
        handle.closed,
        handle.stdin,
        handle.stdout,
        handle.stderr,
      ]).then(() => {
        activeHandles.delete(handle);
      });
      settlements.set(handle, settlement);
      return handle;
    },
    cancelActive: async (): Promise<void> => {
      const handles = [...activeHandles];
      const outcomes = await Promise.allSettled(
        handles.map(async (handle) => {
          await terminateAndDrainClaudeKeychainHelper(handle, drainTimeoutMs, terminationTimeoutMs);
          await settlements.get(handle);
        }),
      );
      const failures = outcomes.filter(({ status }) => status === "rejected");
      if (failures.length > 0) {
        throw new AggregateError(
          failures.map(() => new ClaudeKeychainHelperFailure("cleanup")),
          "Packaged Claude active Keychain helper cleanup failed.",
        );
      }
    },
    activeCount: (): number => activeHandles.size,
  };
}

export async function runBoundedClaudeKeychainHelper(
  invocation: ReturnType<typeof keychainHelperInvocation>,
  sourceEnvironment: NodeJS.ProcessEnv,
  options: {
    readonly timeoutMs?: number;
    readonly startHelper?: StartClaudeKeychainHelper;
  } = {},
): Promise<Record<string, unknown>> {
  const subprocess = smokeSubprocessSpec(invocation.command, invocation.args, sourceEnvironment);
  let handle: ClaudeKeychainHelperHandle;
  try {
    handle = (options.startHelper ?? startClaudeKeychainHelper)(
      subprocess.command,
      subprocess.args,
      subprocess.env,
      invocation.stdin,
    );
  } catch {
    throw new ClaudeKeychainHelperFailure("launch");
  }
  const timeoutMs = options.timeoutMs ?? 5_000;
  const completed = Promise.all([handle.closed, handle.stdin, handle.stdout, handle.stderr]);
  let outcome: Awaited<typeof completed> | "timed-out";
  try {
    outcome = await waitForSettlement(completed, timeoutMs);
  } catch {
    await terminateAndDrainClaudeKeychainHelper(handle).catch(() => undefined);
    throw new ClaudeKeychainHelperFailure("launch");
  }
  if (outcome === "timed-out") {
    try {
      await terminateAndDrainClaudeKeychainHelper(handle);
    } catch {
      throw new ClaudeKeychainHelperFailure("cleanup");
    }
    throw new ClaudeKeychainHelperFailure("timeout");
  }

  const [exitCode, _stdin, stdout, stderr] = outcome;
  if (exitCode !== 0 || stderr.length > 0) {
    throw new ClaudeKeychainHelperFailure("exit");
  }
  try {
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new ClaudeKeychainHelperFailure("response");
  }
}

export function assertClaudeTurnEvidence(value: unknown): void {
  if (!isRecord(value) || !Array.isArray(value.events) || !isRecord(value.observation)) {
    throw new Error("Packaged Claude turn returned invalid evidence.");
  }
  const events = value.events.filter(isRecord);
  const textDeltas = events.filter(({ kind }) => kind === "text-delta");
  const usage = events.find(({ kind }) => kind === "usage");
  if (
    textDeltas.some(({ text }) => typeof text !== "string") ||
    usage === undefined ||
    typeof usage.inputTokens !== "number" ||
    typeof usage.outputTokens !== "number" ||
    !Number.isSafeInteger(usage.inputTokens) ||
    !Number.isSafeInteger(usage.outputTokens) ||
    usage.inputTokens < 0 ||
    usage.outputTokens < 0 ||
    events.at(-1)?.kind !== "completed" ||
    value.observation.readiness !== "ready"
  ) {
    throw new Error(
      "Packaged Claude completion lacked normalized text, usage, or terminal evidence.",
    );
  }
  if (textDeltas.length < 4) {
    throw new Error("Packaged Claude completion lacked four streamed text chunks.");
  }
  if (
    !textDeltas
      .map(({ text }) => text)
      .join("")
      .includes("octant-smoke")
  ) {
    throw new Error("Packaged Claude completion lacked the exact octant-smoke sentinel.");
  }
}

export function claudeHostAllowlist(authentication: ClaudeAuthentication): ReadonlySet<string> {
  return new Set(ALLOWED_HOSTS[authentication]);
}

export function assertObservedClaudeHosts(
  authentication: ClaudeAuthentication,
  observedHostnames: ReadonlyArray<string>,
): void {
  if (observedHostnames.length === 0) {
    throw new Error(
      "Claude privacy gate blocked because the runtime may bypass the CONNECT observer.",
    );
  }
  const allowed = ALLOWED_HOSTS[authentication];
  for (const candidate of observedHostnames) {
    const hostname = normalizeHostname(candidate);
    if (FORBIDDEN_HOSTS.has(hostname) || !allowed.has(hostname)) {
      throw new Error("Claude CONNECT destination is not allowed by the reviewed mode policy.");
    }
  }
}

export function findOwnedClaudeProcessGroups(
  baseline: ReadonlyArray<ClaudeProcessSnapshot>,
  current: ReadonlyArray<ClaudeProcessSnapshot>,
  options: { readonly serverCommand: string; readonly claudeExecutable: string },
): ReadonlyArray<number> {
  const known = new Set(baseline.map(processKey));
  const server = current.find(
    (candidate) =>
      candidate.command.includes(options.serverCommand) && !known.has(processKey(candidate)),
  );
  if (server === undefined) {
    throw new Error("Packaged Octant managed server identity is unavailable.");
  }
  return current
    .filter(
      (candidate) =>
        candidate.ppid === server.pid &&
        candidate.pgid === candidate.pid &&
        commandUsesExecutable(candidate.command, options.claudeExecutable) &&
        !known.has(processKey(candidate)),
    )
    .map((candidate) => candidate.pgid)
    .sort((left, right) => left - right);
}

export function assertProcessGroupsExited(
  processGroups: ReadonlyArray<number>,
  current: ReadonlyArray<ClaudeProcessSnapshot>,
): void {
  const live = [...new Set(processGroups)]
    .filter((group) => current.some((candidate) => candidate.pgid === group))
    .sort((left, right) => left - right);
  if (live.length > 0) {
    throw new Error(`Packaged Octant left managed Claude process groups ${live.join(", ")}.`);
  }
}

export async function runClaudeCleanupChecks(
  checks: ReadonlyArray<
    readonly [name: string, check: () => Promise<void>, cancel?: () => Promise<void>]
  >,
  timeoutMs = 30_000,
): Promise<void> {
  const failures: Error[] = [];
  for (const [name, check, cancel] of checks) {
    const operation = Promise.resolve().then(check);
    try {
      const outcome = await waitForSettlement(operation, timeoutMs);
      if (outcome === "timed-out") {
        if (cancel !== undefined) {
          await waitForSettlement(Promise.resolve().then(cancel), timeoutMs).catch(
            () => "timed-out" as const,
          );
          await waitForSettlement(operation, timeoutMs).catch(() => "timed-out" as const);
        }
        throw new Error("Packaged Claude cleanup timed out.");
      }
    } catch {
      failures.push(new Error(`Packaged Claude ${name} cleanup failed.`));
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Packaged Claude cleanup checks failed.");
  }
}

export async function withIncrementalClaudeCleanup<T>(
  operation: (
    registerCleanup: (
      name: string,
      cleanup: () => Promise<void>,
      cancel?: () => Promise<void>,
    ) => void,
  ) => Promise<T>,
): Promise<T> {
  const checks: Array<
    readonly [name: string, check: () => Promise<void>, cancel?: () => Promise<void>]
  > = [];
  let result: T | undefined;
  let primaryFailure: unknown;
  let cleanupFailure: unknown;
  try {
    result = await operation((name, cleanup, cancel) => checks.push([name, cleanup, cancel]));
  } catch (error) {
    primaryFailure = error;
  }
  try {
    await runClaudeCleanupChecks(checks.reverse());
  } catch (error) {
    cleanupFailure = error;
  }
  const failure = combineClaudeLifecycleFailures(primaryFailure, cleanupFailure);
  if (failure !== undefined) throw failure;
  return result as T;
}

interface ClaudeChildLaunch {
  readonly pid?: number;
  on(event: "error", listener: (error: Error) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "spawn", listener: () => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
  off(event: "spawn", listener: () => void): unknown;
}

export async function waitForClaudeChildLaunch(
  child: ClaudeChildLaunch,
  timeoutMs = 5_000,
): Promise<void> {
  child.on("error", () => undefined);
  await new Promise<void>((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      cleanupListeners();
      reject(new Error("Packaged Octant application launch timed out."));
    }, timeoutMs);
    const onSpawn = () => {
      cleanupListeners();
      resolvePromise();
    };
    const onError = () => {
      cleanupListeners();
      reject(new Error("Packaged Octant application launch failed."));
    };
    const cleanupListeners = () => {
      clearTimeout(timeout);
      child.off("spawn", onSpawn);
      child.off("error", onError);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

export async function cleanupClaudeCredential(
  helper: Pick<CredentialHelper, "cancelActive" | "delete" | "has">,
  providerInstanceId: string,
): Promise<void> {
  const failures: Error[] = [];
  try {
    await helper.cancelActive();
  } catch {
    failures.push(new Error("Packaged Claude stale Keychain helper cleanup failed."));
  }
  try {
    await helper.delete(providerInstanceId);
  } catch {
    failures.push(new Error("Packaged Claude Keychain delete failed."));
  }
  try {
    if (await helper.has(providerInstanceId)) {
      failures.push(new Error("Packaged Claude Keychain item remains."));
    }
  } catch {
    failures.push(new Error("Packaged Claude Keychain residue check failed."));
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Packaged Claude Keychain cleanup failed.");
  }
}

export async function runClaudeLifecycleMatrix(
  run: (shutdown: "forced" | "graceful") => Promise<void>,
): Promise<void> {
  const failures: Error[] = [];
  for (const shutdown of ["graceful", "forced"] as const) {
    try {
      await run(shutdown);
    } catch {
      failures.push(new Error(`Packaged Claude ${shutdown} lifecycle failed.`));
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Packaged Claude lifecycle matrix failed.");
  }
}

export function assertClaudeTemporaryConfigRemoved(entries: ReadonlyArray<string>): void {
  if (entries.some((entry) => entry.startsWith("octant-claude-config-"))) {
    throw new Error("Packaged Claude API configuration directory remains.");
  }
}

export function combineClaudeLifecycleFailures(
  primary: unknown,
  cleanup: unknown,
): Error | undefined {
  const errors: Error[] = [];
  if (primary !== undefined) errors.push(new Error("Packaged Claude provider smoke failed."));
  if (cleanup instanceof AggregateError) {
    errors.push(
      ...cleanup.errors.map(
        (_error: unknown) => new Error("Packaged Claude cleanup check failed."),
      ),
    );
  } else if (cleanup !== undefined) {
    errors.push(new Error("Packaged Claude lifecycle cleanup failed."));
  }
  if (errors.length === 0) return undefined;
  if (errors.length === 1) return errors[0];
  return new AggregateError(errors, "Packaged Claude smoke and cleanup failed.");
}

export function redactClaudeSmokeText(text: string, secrets: ReadonlyArray<string> = []): string {
  const containsKnownSecret = secrets.some((secret) => secret.length > 0 && text.includes(secret));
  const containsCredential =
    /(?:sk-ant-[A-Za-z0-9_-]+|ANTHROPIC_API_KEY\s*=|authorization\s*=|bearer\s+|account\s*=|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i.test(
      text,
    );
  return containsKnownSecret || containsCredential ? "[redacted]" : text;
}

export async function startClaudeConnectObserver(
  options: StartConnectObserverOptions = {},
): Promise<ClaudeConnectObserver> {
  const hostnames = new Set<string>();
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    sockets.add(client);
    client.on("error", () => undefined);
    client.once("close", () => sockets.delete(client));
    let pending = Buffer.alloc(0);
    const onHandshake = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > 16_384) {
        client.destroy();
        return;
      }
      const boundary = pending.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      client.off("data", onHandshake);
      const firstLineEnd = pending.indexOf("\r\n");
      const firstLine = pending.subarray(0, firstLineEnd).toString("ascii");
      const match = /^CONNECT ([^\s:]+):([0-9]+) HTTP\/1\.[01]$/.exec(firstLine);
      if (match === null || Number(match[2]) !== 443) {
        client.destroy();
        return;
      }
      let hostname: string;
      try {
        hostname = normalizeHostname(match[1]!);
      } catch {
        client.destroy();
        return;
      }
      hostnames.add(hostname);
      const target = options.connect?.(hostname, 443) ?? { host: hostname, port: 443 };
      const upstream = connectTcp({ host: target.host, port: target.port });
      sockets.add(upstream);
      upstream.once("close", () => sockets.delete(upstream));
      upstream.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const remainder = pending.subarray(boundary + 4);
        pending = Buffer.alloc(0);
        if (remainder.length > 0) upstream.write(remainder);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.once("error", () => client.destroy());
      client.once("error", () => upstream.destroy());
    };
    client.on("data", onHandshake);
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Claude CONNECT observer did not bind a loopback port.");
  }
  let closed = false;
  return {
    port: address.port,
    hostnames: () => [...hostnames].sort(),
    close: async () => {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    },
  };
}

function normalizeHostname(candidate: string): string {
  const ascii = domainToASCII(candidate.trim().replace(/\.$/, "").toLowerCase());
  if (ascii.length === 0 || ascii.length > 253 || !/^[a-z0-9.-]+$/.test(ascii)) {
    throw new Error("CONNECT hostname is invalid.");
  }
  return ascii;
}

function commandUsesExecutable(command: string, executable: string): boolean {
  return command === executable || command.startsWith(`${executable} `);
}

function processKey(candidate: ClaudeProcessSnapshot): string {
  return `${candidate.pid}\0${candidate.pgid}\0${candidate.command}`;
}

interface CredentialHelper {
  readonly set: (providerInstanceId: string, credential: string) => Promise<void>;
  readonly has: (providerInstanceId: string) => Promise<boolean>;
  readonly delete: (providerInstanceId: string) => Promise<void>;
  readonly cancelActive: () => Promise<void>;
}

async function main(): Promise<void> {
  const modes = readClaudeSmokeModes(process.env);
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("The packaged Claude smoke requires Apple Silicon macOS.");
  }
  const binaryPath = await resolveConfiguredClaudeBinary(process.env);
  const packageCommand = smokeSubprocessSpec(
    process.execPath,
    ["run", "package:desktop"],
    process.env,
  );
  await runCommand(packageCommand.command, packageCommand.args, packageCommand.env, 180_000);
  await assertPortAvailable(13_773);
  const baseline = await processIdentities();
  const modeFailures: Error[] = [];
  for (const authentication of modes) {
    try {
      await runClaudeLifecycleMatrix((shutdown) =>
        smokePackagedLifecycle(authentication, shutdown, binaryPath, baseline),
      );
    } catch {
      modeFailures.push(new Error(`Packaged Claude ${authentication} mode failed.`));
    }
  }
  if (modeFailures.length > 0) {
    throw new AggregateError(modeFailures, "Packaged Claude selected auth modes failed.");
  }
  console.log("Packaged Claude dual-auth lifecycle and privacy smoke passed.");
}

async function smokePackagedLifecycle(
  authentication: ClaudeAuthentication,
  shutdown: "forced" | "graceful",
  binaryPath: string,
  baseline: ReadonlyArray<ClaudeProcessSnapshot>,
): Promise<void> {
  await withIncrementalClaudeCleanup(async (registerCleanup) => {
    const providerInstanceId = randomUUID();
    const dataDirectory = await mkdtemp(
      resolve(tmpdir(), `octant-claude-${authentication}-${shutdown}.`),
    );
    const temporaryDirectory = resolve(dataDirectory, "tmp");
    registerCleanup("temporary configuration", async () => {
      const entries = await readdir(temporaryDirectory).catch(() => []);
      try {
        assertClaudeTemporaryConfigRemoved(entries);
      } finally {
        await rm(dataDirectory, { recursive: true, force: true });
      }
    });
    await mkdir(temporaryDirectory, { recursive: true });

    const observer = await startClaudeConnectObserver();
    registerCleanup("listener", async () => {
      await observer.close();
      await assertPortAvailable(observer.port);
      await assertPortAvailable(13_773);
    });
    const env = packagedClaudeEnvironment(
      process.env,
      dataDirectory,
      temporaryDirectory,
      observer.port,
    );
    const helper = packagedCredentialHelper();
    registerCleanup(
      "Keychain",
      async () => {
        await cleanupClaudeCredential(helper, providerInstanceId);
      },
      helper.cancelActive,
    );
    const observedGroups = new Set<number>();
    registerCleanup("process", async () => {
      const current = await processIdentities();
      assertProcessGroupsExited([...observedGroups], current);
      assertNoSmokeOwnedProcesses(baseline, current, dataDirectory);
    });

    try {
      await helper.delete(providerInstanceId);
      if (authentication === "api-key") {
        const credential = process.env.ANTHROPIC_API_KEY;
        if (credential === undefined) {
          throw new Error("Packaged Claude API-key evidence is blocked.");
        }
        await helper.set(providerInstanceId, credential);
        if (!(await helper.has(providerInstanceId))) {
          throw new Error("Packaged Claude Keychain creation evidence failed.");
        }
      }
      const app = spawn(executable, [], { detached: true, env, stdio: "ignore" });
      registerCleanup(
        "application",
        async () => {
          if (app.pid === undefined) return;
          await cleanupPackagedProcess({
            child: app,
            requestQuit:
              shutdown === "graceful"
                ? () => quitApplication(env)
                : async () => signalProcessGroup(app, "SIGTERM"),
            waitForExit: waitForExitResult,
            signalGroup: signalGroupByPid,
            waitForServerCleanup: () => waitForServerCleanup(10_000),
            assertNoProcesses: async () => undefined,
          });
        },
        async () => signalProcessGroup(app, "SIGKILL"),
      );
      await waitForClaudeChildLaunch(app);
      await waitForStorageReady(20_000);
      const capability = await waitForWindowCapability(dataDirectory, 20_000);
      const provider = await configureAndProbeProvider(
        capability,
        providerInstanceId,
        binaryPath,
        authentication,
        baseline,
        observedGroups,
      );
      const turn = providerRequest(claudeSmokeTurnPath(providerInstanceId), {
        method: "POST",
        headers: requestHeaders(capability),
        body: JSON.stringify(claudeSmokeTurnRequest(provider.modelId)),
      });
      const result = await observeOwnedClaudeGroups(turn, baseline, binaryPath, observedGroups);
      assertClaudeTurnEvidence(result);
      if (observedGroups.size === 0) {
        throw new Error("Packaged Claude process ownership evidence was unavailable.");
      }
      assertObservedClaudeHosts(authentication, observer.hostnames());
    } catch (error) {
      try {
        assertObservedClaudeHosts(authentication, observer.hostnames());
      } catch (privacyError) {
        throw new AggregateError(
          [new Error("Packaged Claude provider evidence failed."), privacyError],
          "Packaged Claude provider and privacy evidence failed.",
        );
      }
      throw error;
    }
  });
}

async function configureAndProbeProvider(
  capability: string,
  providerInstanceId: string,
  binaryPath: string,
  authentication: ClaudeAuthentication,
  baseline: ReadonlyArray<ClaudeProcessSnapshot>,
  observedGroups: Set<number>,
): Promise<{ readonly modelId: string }> {
  const created = await providerRequest("/api/providers/commands", {
    method: "POST",
    headers: requestHeaders(capability),
    body: JSON.stringify(claudeProviderCommand(providerInstanceId, binaryPath, authentication)),
  });
  if (!isRecord(created) || created.kind !== "provider-created") {
    throw new Error("Packaged Provider API did not create the Claude instance.");
  }
  const probe = providerRequest(`/api/providers/${encodeURIComponent(providerInstanceId)}/probe`, {
    method: "POST",
    headers: { "x-octant-window-capability": capability },
  });
  const probed = await observeOwnedClaudeGroups(probe, baseline, binaryPath, observedGroups);
  if (
    !isRecord(probed) ||
    probed.readiness !== "ready" ||
    !Array.isArray(probed.models) ||
    !isRecord(probed.models[0]) ||
    typeof probed.models[0].id !== "string"
  ) {
    throw new Error("Packaged Claude probe did not report ready models.");
  }
  return { modelId: probed.models[0].id };
}

async function observeOwnedClaudeGroups<T>(
  operation: Promise<T>,
  baseline: ReadonlyArray<ClaudeProcessSnapshot>,
  binaryPath: string,
  observedGroups: Set<number>,
): Promise<T> {
  let settled = false;
  void operation.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  while (!settled) {
    try {
      for (const group of findOwnedClaudeProcessGroups(baseline, await processIdentities(), {
        serverCommand: serverEntry,
        claudeExecutable: binaryPath,
      })) {
        observedGroups.add(group);
      }
    } catch {
      // The exact process may begin and exit between bounded snapshots.
    }
    await delay(20);
  }
  return await operation;
}

function packagedCredentialHelper(): CredentialHelper {
  const registry = createClaudeKeychainHandleRegistry();
  const startHelper: StartClaudeKeychainHelper = (command, args, env, stdin) => {
    return registry.track(startClaudeKeychainHelper(command, args, env, stdin));
  };
  const invoke = async (request: HelperRequest): Promise<Record<string, unknown>> => {
    return await runBoundedClaudeKeychainHelper(
      keychainHelperInvocation(helperPath, request),
      process.env,
      { startHelper },
    );
  };
  return {
    set: async (id, credential) =>
      void (await invoke({ operation: "set", providerInstanceId: id, credential })),
    has: async (id) =>
      (await invoke({ operation: "has", providerInstanceId: id })).present === true,
    delete: async (id) => void (await invoke({ operation: "delete", providerInstanceId: id })),
    cancelActive: registry.cancelActive,
  };
}

function assertNoSmokeOwnedProcesses(
  baseline: ReadonlyArray<ClaudeProcessSnapshot>,
  current: ReadonlyArray<ClaudeProcessSnapshot>,
  dataDirectory: string,
): void {
  const known = new Set(baseline.map(processKey));
  if (
    current.some(
      (candidate) =>
        !known.has(processKey(candidate)) &&
        (candidate.command.includes(dataDirectory) ||
          candidate.command === executable ||
          candidate.command.includes(serverEntry) ||
          candidate.command.includes(helperPath)),
    )
  ) {
    throw new Error("Packaged Octant left a smoke-owned process.");
  }
}

function requestHeaders(capability: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-octant-window-capability": capability,
  };
}

async function providerRequest(path: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(new URL(path, serverUrl), {
    ...init,
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) throw new Error(`Packaged Provider API failed with status ${response.status}.`);
  try {
    return await response.json();
  } catch {
    throw new Error("Packaged Provider API returned an invalid response.");
  }
}

async function waitForStorageReady(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(500) });
      const body = (await response.json()) as Record<string, unknown>;
      if (response.ok && body.product === "Octant" && body.storage === "ready") return;
    } catch {
      // The packaged server may still be binding its loopback listener.
    }
    await delay(100);
  }
  throw new Error("Packaged Octant server was not storage-ready.");
}

async function waitForWindowCapability(dataDirectory: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const candidate of await processIdentities()) {
      if (
        !candidate.command.includes(dataDirectory) ||
        !candidate.command.includes("--type=renderer")
      )
        continue;
      const match = /--octant-project-capability=([A-Za-z0-9_-]+)/.exec(candidate.command);
      if (match?.[1] !== undefined) return match[1];
    }
    await delay(100);
  }
  throw new Error("Packaged Octant window authority was unavailable.");
}

async function waitForServerCleanup(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(250) });
    } catch {
      return;
    }
    await delay(100);
  }
  throw new Error("Packaged Octant server listener remained occupied.");
}

async function assertPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const socket = connectTcp({ host: "127.0.0.1", port });
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error("Smoke listener remains occupied."));
    });
    socket.once("error", () => resolvePromise());
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("Smoke listener cleanup could not be determined."));
    });
  });
}

async function processIdentities(): Promise<ReadonlyArray<ClaudeProcessSnapshot>> {
  const output = await runCommand(
    "/bin/ps",
    ["-ax", "-o", "pid=,ppid=,pgid=,command="],
    { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    5_000,
  );
  return output
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      command: match[4]!,
    }));
}

export async function resolveConfiguredClaudeBinary(
  environment: NodeJS.ProcessEnv,
  checkAccess: (path: string, mode: number) => Promise<void> = access,
): Promise<string> {
  const binaryPath = environment.OCTANT_CLAUDE_BINARY_PATH;
  if (binaryPath === undefined || binaryPath.trim().length === 0) {
    throw new Error("Set an explicit OCTANT_CLAUDE_BINARY_PATH for packaged Claude smoke.");
  }
  if (!isAbsolute(binaryPath)) {
    throw new Error("OCTANT_CLAUDE_BINARY_PATH must be absolute.");
  }
  await checkAccess(binaryPath, 1);
  return binaryPath;
}

async function quitApplication(env: NodeJS.ProcessEnv): Promise<void> {
  await runCommand("/usr/bin/osascript", ["-e", createQuitAppleScript(appBundle)], env, 5_000);
}

async function waitForExitResult(child: SmokeChildProcess, timeoutMs: number): Promise<boolean> {
  try {
    await waitForChildExit(child as ChildProcess, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

function signalProcessGroup(child: ChildProcess, signal: "SIGKILL" | "SIGTERM"): void {
  if (child.pid === undefined) throw new Error("Packaged Octant process has no process ID.");
  signalGroupByPid(child.pid, signal);
}

function signalGroupByPid(pid: number, signal: "SIGKILL" | "SIGTERM"): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function runCommand(
  command: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string> {
  const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  try {
    const [stdout, _stderr, code] = await Promise.all([
      readStream(child.stdout),
      readStream(child.stderr),
      new Promise<number | null>((resolvePromise, reject) => {
        child.once("error", reject);
        child.once("close", resolvePromise);
      }),
    ]);
    if (code !== 0) throw new Error("Packaged Claude smoke command failed.");
    return stdout;
  } finally {
    clearTimeout(timeout);
  }
}

function startClaudeKeychainHelper(
  command: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  stdinValue: string,
): ClaudeKeychainHelperHandle {
  const child = spawn(command, args, {
    detached: process.platform !== "win32",
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let closedState = false;
  const closed = new Promise<number | null>((resolvePromise, reject) => {
    child.once("error", (error) => {
      closedState = true;
      reject(error);
    });
    child.once("close", (exitCode) => {
      closedState = true;
      resolvePromise(exitCode);
    });
  });
  const stdin = new Promise<void>((resolvePromise, reject) => {
    const onError = (error: Error) => reject(error);
    child.stdin.once("error", onError);
    child.stdin.end(stdinValue, () => {
      child.stdin.off("error", onError);
      resolvePromise();
    });
  });
  return {
    closed,
    stdin,
    stdout: readStream(child.stdout),
    stderr: readStream(child.stderr),
    terminate: async () => {
      if (closedState || child.pid === undefined) return;
      signalHelperProcessGroup(child, "SIGTERM");
      if (
        (await waitForSettlement(
          closed.catch(() => null),
          200,
        )) !== "timed-out"
      )
        return;
      signalHelperProcessGroup(child, "SIGKILL");
      if (
        (await waitForSettlement(
          closed.catch(() => null),
          1_000,
        )) === "timed-out"
      ) {
        throw new ClaudeKeychainHelperFailure("cleanup");
      }
    },
  };
}

async function terminateAndDrainClaudeKeychainHelper(
  handle: ClaudeKeychainHelperHandle,
  drainTimeoutMs = 1_000,
  terminationTimeoutMs = 1_500,
): Promise<void> {
  let terminationFailure = false;
  try {
    if (
      (await waitForSettlement(Promise.resolve().then(handle.terminate), terminationTimeoutMs)) ===
      "timed-out"
    ) {
      terminationFailure = true;
    }
  } catch {
    terminationFailure = true;
  }
  const drained = await waitForSettlement(
    Promise.allSettled([handle.closed, handle.stdin, handle.stdout, handle.stderr]),
    drainTimeoutMs,
  );
  if (terminationFailure || drained === "timed-out") {
    throw new ClaudeKeychainHelperFailure("cleanup");
  }
}

function signalHelperProcessGroup(child: ChildProcess, signal: "SIGKILL" | "SIGTERM"): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function readStream(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (stream === null) return "";
  let output = "";
  for await (const chunk of stream) output += String(chunk);
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function waitForSettlement<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T | "timed-out"> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<"timed-out">((resolvePromise) => {
        timeout = setTimeout(() => resolvePromise("timed-out"), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

if (import.meta.main) await main();
