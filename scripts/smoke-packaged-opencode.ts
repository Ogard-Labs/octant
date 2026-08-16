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
  type SmokeChildProcess,
} from "./packaged-smoke-process";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const appBundle = resolve(repositoryRoot, "out/Octant.app");
const executable = resolve(appBundle, "Contents/MacOS/Octant");
const serverEntry = resolve(appBundle, "Contents/Resources/app/apps/server/dist/main.mjs");
const serverUrl = PACKAGED_SMOKE_SERVER_URL;
const openCodeCommand = "opencode serve --hostname 127.0.0.1 --port 0";

export interface ProcessSnapshot {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly command: string;
}

export function findOwnedOpenCodeProcessGroup(
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
  const openCode = current.find(
    (process) =>
      process.ppid === server.pid &&
      process.pgid === process.pid &&
      isManagedOpenCode(process) &&
      !known.has(processKey(process)),
  );
  if (openCode === undefined) {
    throw new Error("Packaged Octant managed OpenCode identity is unavailable.");
  }
  return openCode.pgid;
}

export function assertProcessGroupExited(
  processGroup: number,
  current: ReadonlyArray<ProcessSnapshot>,
): void {
  if (current.some((process) => process.pgid === processGroup)) {
    throw new Error(`Packaged Octant left managed process group ${processGroup}.`);
  }
}

export function combineLifecycleFailures(primary: unknown, cleanup: unknown): Error | undefined {
  if (primary !== undefined && cleanup !== undefined) {
    return new AggregateError(
      [
        new Error("Packaged OpenCode probe/start failed."),
        new Error("Packaged OpenCode lifecycle cleanup failed."),
      ],
      "Packaged OpenCode smoke failed during probe/start and cleanup.",
    );
  }
  if (primary !== undefined) return new Error("Packaged OpenCode probe/start failed.");
  if (cleanup !== undefined) return new Error("Packaged OpenCode lifecycle cleanup failed.");
  return undefined;
}

type ProcessIdentity = ProcessSnapshot;

async function main(): Promise<void> {
  if (process.env.OCTANT_OPENCODE_SMOKE !== "1") {
    throw new Error("Set OCTANT_OPENCODE_SMOKE=1 to run the packaged OpenCode smoke.");
  }
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("The packaged OpenCode smoke requires Apple Silicon macOS.");
  }

  const binaryPath = await resolveOpenCodeBinary();
  await runCommand(process.execPath, ["run", "package:desktop"], process.env);
  await assertSmokePortAvailable();

  const baseline = await processIdentities();
  await smokeLifecycle("graceful", binaryPath, baseline);
  await smokeLifecycle("forced", binaryPath, baseline);
  console.log("Packaged OpenCode probe and graceful/forced cleanup smoke passed.");
}

async function smokeLifecycle(
  shutdown: "forced" | "graceful",
  binaryPath: string,
  baseline: ReadonlyArray<ProcessIdentity>,
): Promise<void> {
  const dataDirectory = await mkdtemp(resolve(tmpdir(), `octant-opencode-${shutdown}.`));
  const env = packagedServerEnvironment(process.env, dataDirectory);
  const app = spawn(executable, [], { detached: true, env, stdio: "inherit" });
  let primaryFailure: unknown;
  let cleanupFailure: unknown;
  let ownedOpenCodeProcessGroup: number | undefined;
  try {
    await waitForStorageReady(20_000);
    const capability = await waitForWindowCapability(dataDirectory, 20_000);
    await createAndProbeProvider(capability, binaryPath);
    ownedOpenCodeProcessGroup = await waitForOwnedOpenCodeProcessGroup(baseline, 2_000);
  } catch (error) {
    primaryFailure = error;
    ownedOpenCodeProcessGroup = await findOwnedOpenCodeProcessGroupIfPresent(baseline);
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
          ownedOpenCodeProcessGroup,
          timeoutMs: 10_000,
        }),
    });
  } catch (error) {
    cleanupFailure = error;
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
  const failure = combineLifecycleFailures(primaryFailure, cleanupFailure);
  if (failure !== undefined) throw failure;
}

async function createAndProbeProvider(capability: string, binaryPath: string): Promise<void> {
  const headers = {
    "content-type": "application/json",
    "x-octant-window-capability": capability,
  };
  const instanceId = randomUUID();
  const created = await providerRequest("/api/providers/commands", {
    method: "POST",
    headers,
    body: JSON.stringify({
      kind: "create-opencode-provider",
      instanceId,
      expectedVersion: 0,
      displayName: "OpenCode packaged smoke",
      binaryPath,
    }),
  });
  if (!isRecord(created) || created.kind !== "provider-created") {
    throw new Error("Packaged Provider API did not create the OpenCode instance.");
  }

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
    throw new Error("Packaged OpenCode probe did not report ready models.");
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
    for (const process of await processIdentities()) {
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
  if (occupied) {
    throw new Error(
      "Packaged OpenCode smoke cannot start because Octant port 13773 is already occupied.",
    );
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
  readonly baseline: ReadonlyArray<ProcessIdentity>;
  readonly dataDirectory: string;
  readonly ownedOpenCodeProcessGroup: number | undefined;
  readonly timeoutMs: number;
}): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  const known = new Set(options.baseline.map(processKey));
  while (Date.now() < deadline) {
    const current = await processIdentities();
    const smokeProcess = current.find(
      (process) =>
        (process.command.includes(options.dataDirectory) ||
          process.command === executable ||
          process.command.includes(serverEntry)) &&
        !known.has(processKey(process)),
    );
    const ownedGroupProcess =
      options.ownedOpenCodeProcessGroup === undefined
        ? undefined
        : current.find((process) => process.pgid === options.ownedOpenCodeProcessGroup);
    if (smokeProcess === undefined && ownedGroupProcess === undefined) return;
    await delay(100);
  }
  if (options.ownedOpenCodeProcessGroup !== undefined) {
    assertProcessGroupExited(options.ownedOpenCodeProcessGroup, await processIdentities());
  }
  throw new Error("Packaged Octant left a smoke-owned process.");
}

async function waitForOwnedOpenCodeProcessGroup(
  baseline: ReadonlyArray<ProcessIdentity>,
  timeoutMs: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const processGroup = await findOwnedOpenCodeProcessGroupIfPresent(baseline);
    if (processGroup !== undefined) return processGroup;
    await delay(50);
  }
  throw new Error("Packaged Octant managed OpenCode identity is unavailable.");
}

async function findOwnedOpenCodeProcessGroupIfPresent(
  baseline: ReadonlyArray<ProcessIdentity>,
): Promise<number | undefined> {
  try {
    return findOwnedOpenCodeProcessGroup(baseline, await processIdentities(), {
      serverCommand: serverEntry,
    });
  } catch {
    return undefined;
  }
}

async function processIdentities(): Promise<ReadonlyArray<ProcessIdentity>> {
  const output = await runCommand("/bin/ps", ["-ax", "-o", "pid=,ppid=,pgid=,command="], {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  });
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

async function resolveOpenCodeBinary(): Promise<string> {
  const output = (await runCommand("/usr/bin/which", ["opencode"], process.env)).trim();
  if (!output.startsWith("/")) throw new Error("OpenCode CLI is not installed on the host PATH.");
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

function isManagedOpenCode(process: ProcessIdentity): boolean {
  return process.command.includes(openCodeCommand);
}

function processKey(process: ProcessIdentity): string {
  return `${process.pid}\0${process.pgid}\0${process.command}`;
}

async function runCommand(
  command: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  const [stdout, stderr, exitCode] = await Promise.all([
    readStream(child.stdout),
    readStream(child.stderr),
    new Promise<number | null>((resolve) => child.once("exit", resolve)),
  ]);
  if (exitCode !== 0) throw new Error(`${command} exited with ${exitCode}: ${stderr.trim()}`);
  return stdout;
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
