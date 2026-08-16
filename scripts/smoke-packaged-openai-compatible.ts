import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createQuitAppleScript, waitForChildExit } from "./package-desktop";
import {
  PACKAGED_SMOKE_SERVER_URL,
  cleanupPackagedProcess,
  packagedServerEnvironment,
  type SmokeChildProcess,
} from "./packaged-smoke-process";

export const OCTANT_KEYCHAIN_SERVICE = "app.octant.provider-credentials";
const LIVE_INPUTS = [
  "OCTANT_OPENAI_COMPATIBLE_BASE_URL",
  "OCTANT_OPENAI_COMPATIBLE_API_KEY",
  "OCTANT_OPENAI_COMPATIBLE_MODEL",
] as const;

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const appBundle = resolve(repositoryRoot, "out/Octant.app");
const executable = resolve(appBundle, "Contents/MacOS/Octant");
const packagedRoot = resolve(appBundle, "Contents/Resources/app");
const serverEntry = resolve(packagedRoot, "apps/server/dist/main.mjs");
const helperPath = resolve(appBundle, "Contents/Resources/native/octant-keychain-helper");
const serverUrl = PACKAGED_SMOKE_SERVER_URL;

export type CompatibleSmokeConfiguration =
  | { readonly kind: "native-only" }
  | {
      readonly kind: "live";
      readonly baseUrl: string;
      readonly apiKey: string;
      readonly model: string;
    };

export interface CompatibleSmokeProcess {
  readonly pid: number;
  readonly pgid: number;
  readonly command: string;
}

interface CredentialHelper {
  readonly set: (providerInstanceId: string, credential: string) => Promise<void>;
  readonly has: (providerInstanceId: string) => Promise<boolean>;
  readonly resolve: (providerInstanceId: string) => Promise<string | undefined>;
  readonly delete: (providerInstanceId: string) => Promise<void>;
}

export function readCompatibleSmokeConfiguration(
  environment: NodeJS.ProcessEnv,
): CompatibleSmokeConfiguration {
  if (environment.OCTANT_OPENAI_COMPATIBLE_SMOKE !== "1") return { kind: "native-only" };
  const missing = LIVE_INPUTS.filter(
    (name) => environment[name]?.trim().length === 0 || environment[name] === undefined,
  );
  if (missing.length > 0) {
    throw new Error(
      `Packaged OpenAI-compatible smoke requires ${formatList(missing)}; credential values are not logged.`,
    );
  }
  return {
    kind: "live",
    baseUrl: environment.OCTANT_OPENAI_COMPATIBLE_BASE_URL!,
    apiKey: environment.OCTANT_OPENAI_COMPATIBLE_API_KEY!,
    model: environment.OCTANT_OPENAI_COMPATIBLE_MODEL!,
  };
}

function formatList(values: readonly string[]): string {
  if (values.length === 1) return values[0]!;
  return `${values.slice(0, -1).join(", ")} and ${values.at(-1)}`;
}

export function createCompatibleSmokeIdentity(
  providerInstanceId: string,
  shutdown: "forced" | "graceful" | "native",
) {
  return {
    dataDirectoryPrefix: `octant-compatible-${shutdown}.`,
    providerInstanceId,
    service: OCTANT_KEYCHAIN_SERVICE,
  } as const;
}

export function compatibleProviderCommands(
  providerInstanceId: string,
  configuration: Extract<CompatibleSmokeConfiguration, { kind: "live" }>,
) {
  const providerConfiguration = (protocol: "chat-completions" | "responses") => ({
    kind: "openai-compatible-http" as const,
    baseUrl: configuration.baseUrl,
    authentication: "bearer" as const,
    protocol,
    manualModelIds: [configuration.model],
  });
  return [
    {
      kind: "create-openai-compatible-provider" as const,
      instanceId: providerInstanceId,
      expectedVersion: 0,
      displayName: "OpenAI-compatible packaged smoke",
      configuration: providerConfiguration("responses"),
    },
    {
      kind: "change-openai-compatible-configuration" as const,
      instanceId: providerInstanceId,
      expectedVersion: 1,
      configuration: providerConfiguration("chat-completions"),
    },
  ] as const;
}

export function compatibleSmokeTurnRequests(modelId: string, uuid: () => string = randomUUID) {
  return (["responses", "chat-completions"] as const).flatMap((protocol) => [
    {
      protocol,
      action: "complete" as const,
      sessionId: uuid(),
      modelId,
      prompt: "Reply in at least four short streamed chunks and include exactly: octant-smoke",
    },
    {
      protocol,
      action: "cancel-after-output" as const,
      sessionId: uuid(),
      modelId,
      prompt: "Produce a detailed streamed response with at least 2000 words.",
    },
  ]);
}

export function deriveReplacementCredential(credential: string): string {
  const replacement = createHash("sha256")
    .update("octant-packaged-smoke-replacement\0")
    .update(credential)
    .digest("base64url");
  if (replacement === credential) throw new Error("Could not derive an isolated replacement.");
  return replacement;
}

type HelperRequest =
  | { readonly operation: "set"; readonly providerInstanceId: string; readonly credential: string }
  | { readonly operation: "delete" | "has" | "resolve"; readonly providerInstanceId: string };

export function keychainHelperInvocation(command: string, request: HelperRequest) {
  return {
    command,
    args: [] as readonly string[],
    stdin: `${JSON.stringify({ version: 1, ...request })}\n`,
  };
}

export function packagedCompatibleEnvironment(
  source: NodeJS.ProcessEnv,
  dataDirectory: string,
): NodeJS.ProcessEnv {
  return {
    ...packagedServerEnvironment(source, dataDirectory),
    OCTANT_PACKAGED_PROVIDER_SMOKE_CONTROL: "1",
  };
}

export async function withCredentialLifecycle<T>(
  helper: CredentialHelper,
  providerInstanceId: string,
  credential: string,
  verify: () => Promise<T>,
): Promise<T> {
  let primaryFailure: unknown;
  let result: T | undefined;
  try {
    await helper.delete(providerInstanceId);
    if (await helper.has(providerInstanceId))
      throw new Error("Credential cleanup did not clear the item.");
    await helper.set(providerInstanceId, credential);
    if (
      !(await helper.has(providerInstanceId)) ||
      (await helper.resolve(providerInstanceId)) !== credential
    ) {
      throw new Error("Credential creation evidence failed.");
    }
    const replacement = deriveReplacementCredential(credential);
    await helper.set(providerInstanceId, replacement);
    if (
      !(await helper.has(providerInstanceId)) ||
      (await helper.resolve(providerInstanceId)) !== replacement ||
      replacement === credential
    ) {
      throw new Error("Credential replacement evidence failed.");
    }
    await helper.set(providerInstanceId, credential);
    if (
      !(await helper.has(providerInstanceId)) ||
      (await helper.resolve(providerInstanceId)) !== credential
    ) {
      throw new Error("Credential restoration evidence failed.");
    }
    result = await verify();
  } catch (error) {
    primaryFailure = error;
  }

  let cleanupFailure: unknown;
  try {
    await helper.delete(providerInstanceId);
    if (await helper.has(providerInstanceId))
      throw new Error("Credential deletion evidence failed.");
  } catch (error) {
    cleanupFailure = error;
  }
  const failure = combineCompatibleSmokeFailures(primaryFailure, cleanupFailure);
  if (failure !== undefined) throw failure;
  return result as T;
}

export function findSmokeOwnedProcess(
  current: readonly CompatibleSmokeProcess[],
  options: {
    readonly baseline: readonly CompatibleSmokeProcess[];
    readonly dataDirectory: string;
    readonly executable: string;
    readonly serverEntry: string;
    readonly helperPath: string;
  },
): CompatibleSmokeProcess | undefined {
  const known = new Set(options.baseline.map(processKey));
  return current.find(
    (entry) =>
      !known.has(processKey(entry)) &&
      ((options.dataDirectory.length > 0 && entry.command.includes(options.dataDirectory)) ||
        entry.command.includes(options.executable) ||
        entry.command.includes(options.serverEntry) ||
        entry.command.includes(options.helperPath)),
  );
}

export function combineCompatibleSmokeFailures(
  primary: unknown,
  cleanup: unknown,
): Error | undefined {
  if (primary !== undefined && cleanup !== undefined) {
    return new AggregateError(
      [
        new Error("Packaged OpenAI-compatible provider verification failed."),
        new Error("Packaged OpenAI-compatible lifecycle cleanup failed."),
      ],
      "Packaged OpenAI-compatible smoke failed during verification and cleanup.",
    );
  }
  if (primary !== undefined)
    return new Error("Packaged OpenAI-compatible provider verification failed.");
  if (cleanup !== undefined)
    return new Error("Packaged OpenAI-compatible lifecycle cleanup failed.");
  return undefined;
}

async function main(): Promise<void> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("The packaged OpenAI-compatible smoke requires Apple Silicon macOS.");
  }
  const configuration = readCompatibleSmokeConfiguration(process.env);
  await assertSmokePortAvailable();
  const baseline = await processIdentities();
  const helper = packagedCredentialHelper();

  if (configuration.kind === "native-only") {
    const identity = createCompatibleSmokeIdentity(randomUUID(), "native");
    await withCredentialLifecycle(
      helper,
      identity.providerInstanceId,
      randomUUID(),
      async () => undefined,
    );
    await waitForNoSmokeProcessLeaks(baseline, "", 5_000);
    console.log("Packaged Keychain create/replace/has/resolve/delete smoke passed.");
    return;
  }

  for (const shutdown of ["graceful", "forced"] as const) {
    const identity = createCompatibleSmokeIdentity(randomUUID(), shutdown);
    const dataDirectory = await mkdtemp(resolve(tmpdir(), identity.dataDirectoryPrefix));
    try {
      await withCredentialLifecycle(
        helper,
        identity.providerInstanceId,
        configuration.apiKey,
        async () => {
          await smokePackagedLifecycle(
            shutdown,
            identity.providerInstanceId,
            dataDirectory,
            configuration,
            baseline,
            shutdown === "graceful",
          );
        },
      );
    } finally {
      await rm(dataDirectory, { recursive: true, force: true });
    }
  }
  console.log(
    "Packaged compatible models, dual-protocol, usage, cancellation, and lifecycle smoke passed.",
  );
}

function packagedCredentialHelper(): CredentialHelper {
  const invoke = async (request: HelperRequest): Promise<Record<string, unknown>> => {
    const spec = keychainHelperInvocation(helperPath, request);
    const child = spawn(spec.command, spec.args, { stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end(spec.stdin);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    const output = Buffer.concat(stdout).toString("utf8");
    const diagnostic = Buffer.concat(stderr).toString("utf8");
    for (const chunk of [...stdout, ...stderr]) chunk.fill(0);
    if (exitCode !== 0 || diagnostic.length > 0)
      throw new Error("Packaged Keychain helper operation failed.");
    try {
      return JSON.parse(output) as Record<string, unknown>;
    } catch {
      throw new Error("Packaged Keychain helper returned an invalid response.");
    }
  };
  return {
    set: async (id, credential) =>
      void (await invoke({ operation: "set", providerInstanceId: id, credential })),
    has: async (id) =>
      (await invoke({ operation: "has", providerInstanceId: id })).present === true,
    resolve: async (id) => {
      const value = (await invoke({ operation: "resolve", providerInstanceId: id })).credential;
      return typeof value === "string" ? value : undefined;
    },
    delete: async (id) => void (await invoke({ operation: "delete", providerInstanceId: id })),
  };
}

async function smokePackagedLifecycle(
  shutdown: "forced" | "graceful",
  providerInstanceId: string,
  dataDirectory: string,
  configuration: Extract<CompatibleSmokeConfiguration, { kind: "live" }>,
  baseline: readonly CompatibleSmokeProcess[],
  verifyTurns: boolean,
): Promise<void> {
  const env = packagedCompatibleEnvironment(process.env, dataDirectory);
  const app = spawn(executable, [], { detached: true, env, stdio: "inherit" });
  let primaryFailure: unknown;
  let cleanupFailure: unknown;
  try {
    await waitForStorageReady(20_000);
    const capability = await waitForWindowCapability(dataDirectory, 20_000);
    await createAndProbeProvider(capability, providerInstanceId, configuration, verifyTurns);
  } catch (error) {
    primaryFailure = error;
  }
  try {
    await cleanupPackagedProcess({
      child: app,
      requestQuit:
        shutdown === "graceful"
          ? () => quitApplication(env)
          : async () => signalProcessGroup(app, "SIGTERM"),
      waitForExit: waitForExitResult,
      signalGroup: signalGroupByPid,
      waitForServerCleanup: () => waitForServerCleanup(10_000),
      assertNoProcesses: () => waitForNoSmokeProcessLeaks(baseline, dataDirectory, 10_000),
    });
  } catch (error) {
    cleanupFailure = error;
  }
  const failure = combineCompatibleSmokeFailures(primaryFailure, cleanupFailure);
  if (failure !== undefined) throw failure;
}

async function createAndProbeProvider(
  capability: string,
  providerInstanceId: string,
  configuration: Extract<CompatibleSmokeConfiguration, { kind: "live" }>,
  verifyTurns: boolean,
): Promise<void> {
  const headers = {
    "content-type": "application/json",
    "x-octant-window-capability": capability,
  };
  const turns = compatibleSmokeTurnRequests(configuration.model);
  for (const [index, command] of compatibleProviderCommands(
    providerInstanceId,
    configuration,
  ).entries()) {
    const changed = await providerRequest("/api/providers/commands", {
      method: "POST",
      headers,
      body: JSON.stringify(command),
    });
    const expectedKind = index === 0 ? "provider-created" : "provider-updated";
    if (!isRecord(changed) || changed.kind !== expectedKind) {
      throw new Error("Packaged Provider API did not configure the compatible instance.");
    }
    const probed = await providerRequest(
      `/api/providers/${encodeURIComponent(providerInstanceId)}/probe`,
      {
        method: "POST",
        headers: { "x-octant-window-capability": capability },
      },
    );
    if (
      !isRecord(probed) ||
      probed.readiness !== "ready" ||
      !Array.isArray(probed.models) ||
      probed.models.length === 0
    ) {
      throw new Error("Packaged compatible probe did not report ready models.");
    }
    if (verifyTurns) {
      for (const request of turns.filter(
        ({ protocol }) => protocol === command.configuration.protocol,
      )) {
        const { protocol, ...body } = request;
        const result = await providerRequest(
          `/api/providers/${encodeURIComponent(providerInstanceId)}/packaged-smoke-turn`,
          {
            method: "POST",
            headers,
            body: JSON.stringify(body),
          },
        );
        assertStrictTurnEvidence(result, protocol, request.action, configuration.apiKey);
      }
    }
  }
}

export function assertStrictTurnEvidence(
  value: unknown,
  protocol: "chat-completions" | "responses",
  action: "cancel-after-output" | "complete",
  credential: string,
): void {
  if (!isRecord(value) || !Array.isArray(value.events) || !isRecord(value.observation)) {
    throw new Error("Packaged compatible turn returned invalid evidence.");
  }
  const events = value.events.filter(isRecord);
  const textDeltas = events.filter(({ kind }) => kind === "text-delta");
  const usage = events.find(({ kind }) => kind === "usage");
  const terminal = events.at(-1)?.kind;
  if (action === "complete") {
    if (
      textDeltas.length < 2 ||
      usage === undefined ||
      typeof usage.inputTokens !== "number" ||
      !Number.isSafeInteger(usage.inputTokens) ||
      usage.inputTokens < 0 ||
      typeof usage.outputTokens !== "number" ||
      !Number.isSafeInteger(usage.outputTokens) ||
      usage.outputTokens < 0 ||
      terminal !== "completed" ||
      value.observation.observedProtocol !== protocol ||
      !isRecord(value.observation.capabilities) ||
      value.observation.capabilities.streaming !== "supported" ||
      value.observation.capabilities.usage !== "supported"
    ) {
      throw new Error("Packaged compatible completion lacked strict streaming or usage evidence.");
    }
  } else if (textDeltas.length < 1 || terminal !== "interrupted") {
    throw new Error("Packaged compatible cancellation lacked accepted output or interruption.");
  }
  if (JSON.stringify(value).includes(credential)) {
    throw new Error("Packaged compatible evidence exposed a credential.");
  }
}

async function providerRequest(path: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(new URL(path, serverUrl), {
    ...init,
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok)
    throw new Error(`Packaged Provider API request failed with status ${response.status}.`);
  try {
    return await response.json();
  } catch {
    throw new Error("Packaged Provider API returned an invalid response.");
  }
}

async function assertSmokePortAvailable(): Promise<void> {
  const occupied = await new Promise<boolean>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port: 13_773 });
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
  if (occupied)
    throw new Error(
      "Packaged OpenAI-compatible smoke cannot start because Octant port 13773 is occupied.",
    );
}

async function waitForStorageReady(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(500) });
      const body = (await response.json()) as Record<string, unknown>;
      if (response.ok && body.product === "Octant" && body.storage === "ready") return;
    } catch {}
    await delay(100);
  }
  throw new Error(`Packaged Octant server was not storage-ready within ${timeoutMs}ms.`);
}

async function waitForWindowCapability(dataDirectory: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const process of await processIdentities()) {
      if (!process.command.includes(dataDirectory) || !process.command.includes("--type=renderer"))
        continue;
      const match = /--octant-project-capability=([A-Za-z0-9_-]+)/.exec(process.command);
      if (match?.[1] !== undefined) return match[1];
    }
    await delay(100);
  }
  throw new Error(`Packaged Octant window authority was unavailable within ${timeoutMs}ms.`);
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
  throw new Error(`Packaged Octant server remained reachable after ${timeoutMs}ms.`);
}

async function waitForNoSmokeProcessLeaks(
  baseline: readonly CompatibleSmokeProcess[],
  dataDirectory: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const leaked = findSmokeOwnedProcess(await processIdentities(), {
      baseline,
      dataDirectory,
      executable,
      serverEntry,
      helperPath,
    });
    if (leaked === undefined) return;
    await delay(100);
  }
  throw new Error(
    "Packaged Octant left a smoke-owned app, server, broker owner, or helper process.",
  );
}

async function processIdentities(): Promise<readonly CompatibleSmokeProcess[]> {
  const output = await runCommand("/bin/ps", ["-ax", "-o", "pid=,pgid=,command="], {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  });
  return output
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ pid: Number(match[1]), pgid: Number(match[2]), command: match[3]! }));
}

async function quitApplication(env: NodeJS.ProcessEnv): Promise<void> {
  await runCommand("/usr/bin/osascript", ["-e", createQuitAppleScript(appBundle)], env);
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

function processKey(process: CompatibleSmokeProcess): string {
  return `${process.pid}\0${process.pgid}\0${process.command}`;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const output = Buffer.concat(stdout).toString("utf8");
  const error = Buffer.concat(stderr).toString("utf8");
  if (exitCode !== 0) throw new Error("Packaged OpenAI-compatible smoke command failed.");
  if (error.length > 0 && command !== "/bin/ps") process.stderr.write(error);
  return output;
}

if (import.meta.main) await main();
