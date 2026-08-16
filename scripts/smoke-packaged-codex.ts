import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
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
  waitForProcessCleanup,
  type SmokeChildProcess,
} from "./packaged-smoke-process";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const appBundle = resolve(repositoryRoot, "out/Octant.app");
const executable = resolve(appBundle, "Contents/MacOS/Octant");
const serverEntry = resolve(appBundle, "Contents/Resources/app/apps/server/dist/main.mjs");
const serverUrl = PACKAGED_SMOKE_SERVER_URL;

export interface ProcessSnapshot {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly command: string;
}

export function findOwnedCodexProcessGroup(
  baseline: ReadonlyArray<ProcessSnapshot>,
  current: ReadonlyArray<ProcessSnapshot>,
  options: { readonly serverCommand: string },
): number {
  const known = new Set(baseline.map(processKey));
  const server = current.find(
    (process) => process.command.includes(options.serverCommand) && !known.has(processKey(process)),
  );
  if (server === undefined) {
    throw new Error("Packaged Octant managed server identity is unavailable.");
  }
  const codex = current.find(
    (process) =>
      process.ppid === server.pid &&
      process.pgid === process.pid &&
      isManagedCodex(process) &&
      !known.has(processKey(process)),
  );
  if (codex === undefined) {
    throw new Error("Packaged Octant managed Codex identity is unavailable.");
  }
  return codex.pgid;
}

export function assertProcessGroupExited(
  processGroup: number,
  current: ReadonlyArray<ProcessSnapshot>,
): void {
  if (current.some((process) => process.pgid === processGroup)) {
    throw new Error(`Packaged Octant left managed process group ${processGroup}.`);
  }
}

export function findNewCodexProcessGroups(
  baseline: ReadonlyArray<ProcessSnapshot>,
  current: ReadonlyArray<ProcessSnapshot>,
): ReadonlyArray<number> {
  const known = new Set(baseline.map(processKey));
  return [
    ...new Set(
      current
        .filter((process) => isManagedCodex(process) && !known.has(processKey(process)))
        .map((process) => process.pgid),
    ),
  ];
}

export async function cleanupNewCodexProcessGroups(
  baseline: ReadonlyArray<ProcessSnapshot>,
  options: {
    readonly inspectProcesses: (timeoutMs: number) => Promise<ReadonlyArray<ProcessSnapshot>>;
    readonly signalGroup: (pid: number, signal: "SIGKILL" | "SIGTERM") => void;
    readonly timeoutMs: number;
    readonly probeTimeoutMs: number;
  },
): Promise<void> {
  const seenGroups = new Set<number>();
  const assertNoNewGroups = async (signal: "SIGKILL" | "SIGTERM", probeTimeoutMs: number) => {
    const current = await options.inspectProcesses(probeTimeoutMs);
    const groups = findNewCodexProcessGroups(baseline, current);
    for (const processGroup of groups) {
      if (!seenGroups.has(processGroup) || signal === "SIGKILL") {
        options.signalGroup(processGroup, signal);
        seenGroups.add(processGroup);
      }
    }
    if (groups.length > 0) throw new Error("Packaged Octant left a new Codex process group.");
  };

  try {
    await waitForProcessCleanup((probeTimeoutMs) => assertNoNewGroups("SIGTERM", probeTimeoutMs), {
      timeoutMs: options.timeoutMs,
      probeTimeoutMs: options.probeTimeoutMs,
    });
  } catch {
    await waitForProcessCleanup((probeTimeoutMs) => assertNoNewGroups("SIGKILL", probeTimeoutMs), {
      timeoutMs: options.timeoutMs,
      probeTimeoutMs: options.probeTimeoutMs,
    });
  }
}

export function combineLifecycleFailures(primary: unknown, cleanup: unknown): Error | undefined {
  if (primary !== undefined && cleanup !== undefined) {
    return new AggregateError(
      [
        new Error("Packaged Codex probe/start failed."),
        new Error("Packaged Codex lifecycle cleanup failed."),
      ],
      "Packaged Codex smoke failed during probe/start and cleanup.",
    );
  }
  if (primary !== undefined) return new Error("Packaged Codex probe/start failed.");
  if (cleanup !== undefined) return new Error("Packaged Codex lifecycle cleanup failed.");
  return undefined;
}

async function main(): Promise<void> {
  if (process.env.OCTANT_CODEX_SMOKE !== "1") {
    throw new Error("Set OCTANT_CODEX_SMOKE=1 to run the packaged Codex smoke.");
  }
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("The packaged Codex smoke requires Apple Silicon macOS.");
  }

  const binaryPath = await resolveCodexBinary();
  await assertSmokePortAvailable();
  const baseline = await processIdentities();
  await smokeLifecycle("graceful", binaryPath, baseline);
  await smokeLifecycle("forced", binaryPath, baseline);
  console.log("Packaged Codex probe and graceful/forced cleanup smoke passed.");
}

async function smokeLifecycle(
  shutdown: "forced" | "graceful",
  binaryPath: string,
  baseline: ReadonlyArray<ProcessSnapshot>,
): Promise<void> {
  const dataDirectory = await mkdtemp(resolve(tmpdir(), `octant-codex-${shutdown}.`));
  const env = packagedServerEnvironment(process.env, dataDirectory);
  const app = spawn(executable, [], { detached: true, env, stdio: "ignore" });
  let primaryFailure: unknown;
  let cleanupFailure: unknown;
  let ownedProcessGroup: number | undefined;
  try {
    await runSmokeStage(shutdown, "storage readiness", () => waitForStorageReady(20_000));
    const capability = await runSmokeStage(shutdown, "window authority", () =>
      waitForWindowCapability(dataDirectory, 20_000),
    );
    const provider = await runSmokeStage(shutdown, "provider create", () =>
      createProvider(capability, binaryPath),
    );
    await runSmokeStage(shutdown, "provider probe", () =>
      probeProvider(capability, provider.instanceId),
    );
    ownedProcessGroup = await runSmokeStage(shutdown, "process attribution", () =>
      waitForOwnedCodexProcessGroup(baseline, 2_000),
    );
  } catch (error) {
    primaryFailure = error;
    ownedProcessGroup = await findOwnedCodexProcessGroupIfPresent(baseline);
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
      assertNoProcesses: () =>
        waitForNoSmokeProcessLeaks({
          baseline,
          dataDirectory,
          ownedProcessGroup,
          timeoutMs: 10_000,
        }),
    });
  } catch (error) {
    cleanupFailure = error;
  } finally {
    try {
      await cleanupNewCodexProcessGroups(baseline, {
        inspectProcesses: processIdentities,
        signalGroup: signalGroupByPid,
        timeoutMs: 5_000,
        probeTimeoutMs: 1_100,
      });
    } catch (error) {
      cleanupFailure ??= error;
    }
    await rm(dataDirectory, { recursive: true, force: true });
  }
  const failure = combineLifecycleFailures(primaryFailure, cleanupFailure);
  if (failure !== undefined) throw failure;
}

async function runSmokeStage<T>(
  lifecycle: "forced" | "graceful",
  label: string,
  operation: () => Promise<T>,
): Promise<T> {
  console.log(`[packaged-codex-smoke] ${lifecycle} ${label}: start`);
  try {
    const result = await operation();
    console.log(`[packaged-codex-smoke] ${lifecycle} ${label}: pass`);
    return result;
  } catch (error) {
    console.log(
      `[packaged-codex-smoke] ${lifecycle} ${label}: fail (${packagedFailureSummary(error)})`,
    );
    throw new Error(`Packaged Codex ${lifecycle} ${label} failed.`);
  }
}

function packagedFailureSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const status = /status (\d{3})/.exec(message)?.[1];
  if (status !== undefined) return `HTTP ${status}`;
  if (/invalid response/.test(message)) return "invalid response";
  if (/did not report ready models/.test(message)) return "not ready or no models";
  if (/did not create/.test(message)) return "unexpected create result";
  return "bounded stage failure";
}

async function createProvider(
  capability: string,
  binaryPath: string,
): Promise<{ readonly instanceId: string }> {
  const headers = {
    "content-type": "application/json",
    "x-octant-window-capability": capability,
  };
  const instanceId = randomUUID();
  const created = await providerRequest("/api/providers/commands", {
    method: "POST",
    headers,
    body: JSON.stringify({
      kind: "create-codex-provider",
      instanceId,
      expectedVersion: 0,
      displayName: "Codex packaged smoke",
      binaryPath,
    }),
  });
  if (!isRecord(created) || created.kind !== "provider-created") {
    throw new Error("Packaged Provider API did not create the Codex instance.");
  }
  return { instanceId };
}

async function probeProvider(capability: string, instanceId: string): Promise<void> {
  const probed = await providerRequest(`/api/providers/${encodeURIComponent(instanceId)}/probe`, {
    method: "POST",
    headers: { "x-octant-window-capability": capability },
  });
  if (
    !isRecord(probed) ||
    probed.readiness !== "ready" ||
    !Array.isArray(probed.models) ||
    probed.models.length === 0
  ) {
    throw new Error("Packaged Codex probe did not report ready models.");
  }
}

async function providerRequest(path: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(new URL(path, serverUrl), {
    ...init,
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`Packaged Provider API request failed with status ${response.status}.`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error("Packaged Provider API returned an invalid response.");
  }
}

async function waitForWindowCapability(dataDirectory: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const process of await processIdentities(
      Math.min(1_000, Math.max(1, deadline - Date.now())),
    )) {
      if (
        !process.command.includes(dataDirectory) ||
        !process.command.includes("--type=renderer")
      ) {
        continue;
      }
      const match = /--octant-project-capability=([A-Za-z0-9_-]+)/.exec(process.command);
      if (match?.[1] !== undefined) return match[1];
    }
    await delay(100);
  }
  throw new Error(`Packaged Octant window authority was unavailable within ${timeoutMs}ms.`);
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
  if (occupied) throw new Error("Packaged Codex smoke requires Octant port 13773 to be free.");
}

async function waitForStorageReady(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(500) });
      const body = (await response.json()) as Record<string, unknown>;
      if (response.ok && body.product === "Octant" && body.storage === "ready") return;
    } catch {
      // The packaged server may still be binding its loopback socket.
    }
    await delay(100);
  }
  throw new Error(`Packaged Octant server was not storage-ready within ${timeoutMs}ms.`);
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

async function waitForNoSmokeProcessLeaks(options: {
  readonly baseline: ReadonlyArray<ProcessSnapshot>;
  readonly dataDirectory: string;
  readonly ownedProcessGroup: number | undefined;
  readonly timeoutMs: number;
}): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  const known = new Set(options.baseline.map(processKey));
  while (Date.now() < deadline) {
    const current = await processIdentities(Math.min(1_000, Math.max(1, deadline - Date.now())));
    const smokeProcess = current.find(
      (process) =>
        (process.command.includes(options.dataDirectory) ||
          process.command === executable ||
          process.command.includes(serverEntry)) &&
        !known.has(processKey(process)),
    );
    const ownedGroupProcess =
      options.ownedProcessGroup === undefined
        ? undefined
        : current.find((process) => process.pgid === options.ownedProcessGroup);
    if (smokeProcess === undefined && ownedGroupProcess === undefined) return;
    await delay(100);
  }
  if (options.ownedProcessGroup !== undefined) {
    assertProcessGroupExited(options.ownedProcessGroup, await processIdentities(1_000));
  }
  throw new Error("Packaged Octant left a smoke-owned process.");
}

async function waitForOwnedCodexProcessGroup(
  baseline: ReadonlyArray<ProcessSnapshot>,
  timeoutMs: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const processGroup = await findOwnedCodexProcessGroupIfPresent(
      baseline,
      Math.min(1_000, Math.max(1, deadline - Date.now())),
    );
    if (processGroup !== undefined) return processGroup;
    await delay(50);
  }
  throw new Error("Packaged Octant managed Codex identity is unavailable.");
}

async function findOwnedCodexProcessGroupIfPresent(
  baseline: ReadonlyArray<ProcessSnapshot>,
  probeTimeoutMs = 1_000,
): Promise<number | undefined> {
  try {
    return findOwnedCodexProcessGroup(baseline, await processIdentities(probeTimeoutMs), {
      serverCommand: serverEntry,
    });
  } catch {
    return undefined;
  }
}

async function processIdentities(timeoutMs = 5_000): Promise<ReadonlyArray<ProcessSnapshot>> {
  const output = await runCommand(
    "/bin/ps",
    ["-ax", "-o", "pid=,ppid=,pgid=,command="],
    {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    },
    timeoutMs,
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

async function resolveCodexBinary(): Promise<string> {
  const output = (await runCommand("/usr/bin/which", ["codex"], process.env)).trim();
  if (!output.startsWith("/")) throw new Error("Codex CLI is not installed on the host PATH.");
  return output;
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

function isManagedCodex(process: ProcessSnapshot): boolean {
  return /(?:^|\/)codex app-server --listen stdio:\/\/(?:\s|$)/.test(process.command);
}

function processKey(process: ProcessSnapshot): string {
  return `${process.pid}\0${process.pgid}\0${process.command}`;
}

export async function runCommand(
  command: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  timeoutMs = 5_000,
): Promise<string> {
  const child = spawn(command, args, {
    detached: process.platform !== "win32",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = readStream(child.stdout);
  const stderr = readStream(child.stderr);
  const exitCode = await waitForCommandExit(child, timeoutMs, command);
  const [output] = await Promise.all([stdout, stderr]);
  if (exitCode !== 0) throw new Error(`${command} exited with ${exitCode}.`);
  return output;
}

async function waitForCommandExit(
  child: ChildProcess,
  timeoutMs: number,
  command: string,
): Promise<number | null> {
  return await new Promise<number | null>((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      operation();
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      void terminateCommand(child, 100).then(
        () => reject(new Error(`${command} timed out.`)),
        () => reject(new Error(`${command} timed out and cleanup failed.`)),
      );
    }, timeoutMs);
    child.once("error", () => finish(() => reject(new Error(`${command} could not start.`))));
    child.once("exit", (code) => finish(() => resolve(code)));
  });
}

async function terminateCommand(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  signalCommand(child, "SIGTERM");
  if (await waitForCommandStopped(child, timeoutMs)) return;
  signalCommand(child, "SIGKILL");
  if (!(await waitForCommandStopped(child, timeoutMs))) {
    throw new Error("Smoke prerequisite command did not exit after SIGKILL.");
  }
}

function signalCommand(child: ChildProcess, signal: "SIGKILL" | "SIGTERM"): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForCommandStopped(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await delay(5);
  }
  return child.exitCode !== null || child.signalCode !== null;
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
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

if (import.meta.main) await main();
