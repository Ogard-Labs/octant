import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createActivateAppleScript,
  createQuitAppleScript,
  waitForChildExit,
} from "./package-desktop";
import {
  cleanupPackagedProcess,
  PACKAGED_SMOKE_PROCESS_PROBE_TIMEOUT_MS,
  runBoundedCommand,
  sanitizedPackagedEnvironment,
  waitForProcessCleanup,
  type SmokeChildProcess,
} from "./packaged-smoke-process";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const appBundle = resolve(repositoryRoot, "out/Octant.app");
const executable = resolve(appBundle, "Contents/MacOS/Octant");
const packagedRoot = resolve(appBundle, "Contents/Resources/app");
const serverEntry = resolve(packagedRoot, "apps/server/dist/main.mjs");
const serverPackage = resolve(packagedRoot, "apps/server/package.json");
const keychainHelper = resolve(appBundle, "Contents/Resources/native/octant-keychain-helper");
const forceFailureCleanup = process.argv.includes("--fail-after-ready");

await main();

async function main(): Promise<void> {
  const dataDirectory = await mkdtemp(resolve(tmpdir(), "octant-packaged-smoke."));
  const env = sanitizedPackagedEnvironment(process.env, dataDirectory);
  try {
    await probePackagedKeychainHelper(env);
    await probePackagedSqlite(env);
    await smokePackagedNodeServer(env);
    await smokePackagedApplication(env, dataDirectory);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
}

async function probePackagedKeychainHelper(env: NodeJS.ProcessEnv): Promise<void> {
  await access(keychainHelper, 1);
  const description = await runCommand("/usr/bin/file", ["-b", keychainHelper], env);
  if (!description.includes("arm64")) {
    throw new Error("Packaged Octant Keychain helper is not Apple Silicon executable.");
  }
  console.log("Packaged executable Apple Silicon Keychain helper probe passed.");
}

async function probePackagedSqlite(env: NodeJS.ProcessEnv): Promise<void> {
  const probe = [
    'const { createRequire } = require("node:module");',
    "const requireFromServer = createRequire(process.argv[1]);",
    'const Database = requireFromServer("better-sqlite3");',
    'const database = new Database(":memory:");',
    'database.exec("CREATE TABLE probe(value INTEGER); INSERT INTO probe VALUES (43)");',
    'const value = database.prepare("SELECT value FROM probe").pluck().get();',
    "database.close();",
    'if (value !== 43) throw new Error("Octant SQLite ABI probe returned the wrong value.");',
  ].join(" ");
  await runCommand(executable, ["-e", probe, serverPackage], {
    ...env,
    ELECTRON_RUN_AS_NODE: "1",
  });
  console.log("Packaged SQLite Electron ABI probe passed.");
}

async function smokePackagedNodeServer(env: NodeJS.ProcessEnv): Promise<void> {
  const port = 13_774;
  const serverUrl = `http://127.0.0.1:${port}`;
  const child = spawn(executable, [serverEntry], {
    detached: true,
    env: {
      ...env,
      ELECTRON_RUN_AS_NODE: "1",
      OCTANT_SERVER_PORT: String(port),
    },
    stdio: "inherit",
  });
  try {
    await waitForStorageReady(serverUrl, 20_000);
    console.log("Packaged Electron Node-mode health smoke passed.");
  } finally {
    await cleanupPackagedProcess({
      child,
      requestQuit: async () => signalProcessGroup(child, "SIGTERM"),
      waitForExit: waitForExitResult,
      signalGroup: signalGroupByPid,
      waitForServerCleanup: () => waitForServerCleanup(serverUrl, 10_000),
      assertNoProcesses: () =>
        waitForProcessCleanup(
          (remainingMs) => assertNoPackagedProcesses([serverEntry], remainingMs),
          {
            timeoutMs: 10_000,
            probeTimeoutMs: PACKAGED_SMOKE_PROCESS_PROBE_TIMEOUT_MS,
          },
        ),
    });
  }
}

async function smokePackagedApplication(
  env: NodeJS.ProcessEnv,
  dataDirectory: string,
): Promise<void> {
  const port = 13_775;
  const serverUrl = `http://127.0.0.1:${port}`;
  const app = spawn(executable, [], {
    detached: true,
    env: { ...env, OCTANT_SERVER_PORT: String(port) },
    stdio: "inherit",
  });
  let smokeFailure: unknown;
  try {
    await waitForStorageReady(serverUrl, 20_000);
    await waitForRenderer(dataDirectory, 20_000);
    await activateApplication(appBundle, env);
    if (forceFailureCleanup) {
      throw new Error("Intentional packaged smoke failure after readiness.");
    }
  } catch (error) {
    smokeFailure = error;
  }

  await cleanupPackagedProcess({
    child: app,
    requestQuit: forceFailureCleanup
      ? async () => {
          throw new Error("Force process-group cleanup for the failure-path smoke.");
        }
      : () => quitApplication(appBundle, env),
    waitForExit: waitForExitResult,
    signalGroup: signalGroupByPid,
    waitForServerCleanup: () => waitForServerCleanup(serverUrl, 10_000),
    assertNoProcesses: () =>
      waitForProcessCleanup(
        (remainingMs) => assertNoPackagedProcesses([executable, serverEntry], remainingMs),
        {
          timeoutMs: 10_000,
          probeTimeoutMs: PACKAGED_SMOKE_PROCESS_PROBE_TIMEOUT_MS,
        },
      ),
  });

  if (smokeFailure !== undefined) throw smokeFailure;
  console.log("Packaged Octant no-Bun smoke passed: window/server ready and processes cleaned up.");
}

async function waitForStorageReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) });
      const body = (await response.json()) as Record<string, unknown>;
      if (
        response.ok &&
        body.product === "Octant" &&
        body.status === "ok" &&
        body.storage === "ready"
      ) {
        return;
      }
    } catch {
      // The packaged Node-mode server may still be binding its loopback socket.
    }
    await sleep(100);
  }
  throw new Error(`Packaged Octant server was not storage-ready within ${timeoutMs}ms.`);
}

async function waitForRenderer(dataDirectory: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const output = await processListing(
      Math.min(PACKAGED_SMOKE_PROCESS_PROBE_TIMEOUT_MS, Math.max(1, deadline - Date.now())),
    );
    if (output.includes(dataDirectory) && output.includes("--type=renderer")) return;
    await sleep(100);
  }
  throw new Error(`Packaged Octant renderer did not start within ${timeoutMs}ms.`);
}

async function quitApplication(appPath: string, env: NodeJS.ProcessEnv): Promise<void> {
  await runCommand("/usr/bin/osascript", ["-e", createQuitAppleScript(appPath)], env);
}

async function activateApplication(appPath: string, env: NodeJS.ProcessEnv): Promise<void> {
  await runCommand("/usr/bin/osascript", ["-e", createActivateAppleScript(appPath)], env);
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
  const pid = child.pid;
  if (pid === undefined) throw new Error("Packaged Octant process has no process ID.");
  signalGroupByPid(pid, signal);
}

function signalGroupByPid(pid: number, signal: "SIGKILL" | "SIGTERM"): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForServerCleanup(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`${url}/health`, { signal: AbortSignal.timeout(250) });
    } catch {
      return;
    }
    await sleep(100);
  }
  throw new Error(`Packaged Octant server remained reachable after ${timeoutMs}ms.`);
}

async function assertNoPackagedProcesses(
  forbiddenCommands: ReadonlyArray<string>,
  timeoutMs: number,
): Promise<void> {
  const output = await processListing(timeoutMs);
  const found = forbiddenCommands.find((command) => output.includes(command));
  if (found !== undefined) throw new Error(`Packaged Octant left a process for ${found}.`);
}

async function processListing(timeoutMs: number): Promise<string> {
  return await runBoundedCommand(
    "/bin/ps",
    ["-ax", "-o", "command="],
    { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    timeoutMs,
  );
}

async function runCommand(
  command: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return await runBoundedCommand(command, args, env, 5_000);
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
