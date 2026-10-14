import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
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
  stagePackagedAppBundle,
  type SmokeChildProcess,
} from "./packaged-smoke-process";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const appBundle = stagePackagedAppBundle(resolve(repositoryRoot, "out/Octant.app"));
const executable = resolve(appBundle, "Contents/MacOS/Octant");
const packagedRoot = resolve(appBundle, "Contents/Resources/app");
const serverEntry = resolve(packagedRoot, "apps/server/dist/main.mjs");
const serverPackage = resolve(packagedRoot, "apps/server/package.json");
const keychainHelper = resolve(appBundle, "Contents/Resources/native/octant-keychain-helper");
const forceFailureCleanup = process.argv.includes("--fail-after-ready");
const GIT_HEAD_PATTERN = /^[a-f0-9]{40,64}$/;
const GIT_HEAD_UNAVAILABLE = "The unsigned developer-package smoke could not record git HEAD.";

export interface UnsignedDeveloperPackageSmokeHost {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly repositoryRoot: string;
  readonly readHead: (repositoryRoot: string) => Promise<string>;
}

export async function prepareUnsignedDeveloperPackageSmoke(
  host: UnsignedDeveloperPackageSmokeHost,
): Promise<string> {
  // Platform first: recording HEAD off Apple Silicon would claim that host smoked the commit.
  if (host.platform !== "darwin" || host.arch !== "arm64") {
    throw new Error("The packaged desktop smoke requires Apple Silicon macOS.");
  }
  let revision: string;
  try {
    revision = (await host.readHead(host.repositoryRoot)).trim();
  } catch {
    throw new Error(GIT_HEAD_UNAVAILABLE);
  }
  if (!GIT_HEAD_PATTERN.test(revision)) {
    throw new Error(GIT_HEAD_UNAVAILABLE);
  }
  console.log(`Unsigned developer-package smoke commit: ${revision}`);
  return revision;
}

export function formatUnsignedDeveloperPackageSmokeEvidence(commit: string): string {
  return [
    "Unsigned developer-package smoke evidence:",
    `  package commit: asserted ${commit}`,
    "  launch: asserted (Keychain helper, SQLite ABI, Node-mode health, app window, shell bootstrap)",
    "  restart with existing Code Projects and a thread: asserted (Node-mode and app window)",
    "  first-run: maintainer",
    "  provider setup: maintainer",
    "  thread creation: maintainer",
    "  clean shutdown: asserted (quit and process cleanup)",
  ].join("\n");
}

async function main(): Promise<void> {
  const commit = await prepareUnsignedDeveloperPackageSmoke({
    platform: process.platform,
    arch: process.arch,
    repositoryRoot,
    readHead: readGitHead,
  });
  const dataDirectory = await mkdtemp(resolve(tmpdir(), "octant-packaged-smoke."));
  const env = sanitizedPackagedEnvironment(process.env, dataDirectory);
  try {
    await probePackagedKeychainHelper(env);
    await probePackagedSqlite(env);
    await smokePackagedNodeServer(env);
    // The app smoke below then starts on this same data folder, so the desktop
    // host also has to come up with an existing Code Project and thread.
    await smokePackagedExistingCodeDataRestart(env);
    await smokePackagedApplication(env, dataDirectory);
    console.log(formatUnsignedDeveloperPackageSmokeEvidence(commit));
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
}

async function readGitHead(repositoryRoot: string): Promise<string> {
  const path = process.env.PATH;
  if (path === undefined || path.length === 0) {
    throw new Error("git PATH is unavailable.");
  }
  return await runBoundedCommand(
    "git",
    ["-C", repositoryRoot, "rev-parse", "--verify", "HEAD"],
    { PATH: path },
    5_000,
  );
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

/**
 * Seed two Code Projects and a thread, stop the host, and start it again on
 * the same data folder.
 *
 * A fresh data folder hides a host that cannot survive its own data: on
 * Electron 43.5.0 the host aborted in a better-sqlite3 statement finalizer
 * within a second of every start on a folder holding two Code Projects, while
 * fresh folders and a folder with a single Project passed. No provider turn
 * runs; the thread names a local compatible endpoint that is never called.
 */
async function smokePackagedExistingCodeDataRestart(env: NodeJS.ProcessEnv): Promise<void> {
  const repositories = [
    await mkdtemp(resolve(tmpdir(), "octant-packaged-smoke-repository.")),
    await mkdtemp(resolve(tmpdir(), "octant-packaged-smoke-repository.")),
  ] as const;
  try {
    for (const repository of repositories) await initializeRepository(repository);
    const desktopBridgeSecret = randomBytes(32).toString("base64url");
    const seeded = await withPackagedNodeServer(env, desktopBridgeSecret, (serverUrl) =>
      seedCodeProjectsAndThread(serverUrl, desktopBridgeSecret, repositories),
    );
    await withPackagedNodeServer(env, desktopBridgeSecret, async (serverUrl) => {
      const window = await registerWindowAuthority(serverUrl, desktopBridgeSecret);
      await openCodeProject(window, seeded.projectId);
      const thread = await fetch(`${serverUrl}/api/code/threads/${seeded.threadId}`, {
        headers: window.headers,
      });
      if (thread.status !== 200) {
        throw new Error(
          `Restarted packaged host could not read its Code thread (${thread.status}).`,
        );
      }
      await stayHealthy(serverUrl, EXISTING_DATA_HOLD_MS);
    });
    console.log("Packaged restart with existing Code Projects and a thread passed.");
  } finally {
    for (const repository of repositories) {
      await rm(repository, { recursive: true, force: true });
    }
  }
}

/** Long enough to cover the startup work existing Code Projects trigger. */
const EXISTING_DATA_HOLD_MS = 10_000;

async function initializeRepository(repository: string): Promise<void> {
  const gitEnv = { PATH: "/usr/bin:/bin", HOME: repository };
  await runCommand("git", ["-C", repository, "init", "-q", "-b", "main"], gitEnv);
  await runCommand(
    "git",
    [
      "-C",
      repository,
      "-c",
      "user.name=Octant smoke",
      "-c",
      "user.email=smoke@octant.invalid",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "Seed",
    ],
    gitEnv,
  );
}

async function withPackagedNodeServer<T>(
  env: NodeJS.ProcessEnv,
  desktopBridgeSecret: string,
  use: (serverUrl: string) => Promise<T>,
): Promise<T> {
  const port = 13_776;
  const serverUrl = `http://127.0.0.1:${port}`;
  const child = spawn(executable, [serverEntry], {
    detached: true,
    env: {
      ...env,
      ELECTRON_RUN_AS_NODE: "1",
      OCTANT_SERVER_PORT: String(port),
      OCTANT_DESKTOP_BRIDGE_SECRET: desktopBridgeSecret,
    },
    stdio: "inherit",
  });
  try {
    await waitForStorageReady(serverUrl, 20_000);
    return await use(serverUrl);
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

interface SmokeWindowAuthority {
  readonly windowId: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly send: (path: string, body: unknown, step: string) => Promise<unknown>;
}

async function registerWindowAuthority(
  serverUrl: string,
  desktopBridgeSecret: string,
): Promise<SmokeWindowAuthority> {
  const capability = randomBytes(32).toString("base64url");
  const rendererIdentity = randomBytes(32).toString("base64url");
  const windowId = randomUUID();
  const registered = await fetch(`${serverUrl}/api/desktop/window-authorities`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-octant-desktop-secret": desktopBridgeSecret,
    },
    body: JSON.stringify({ windowId, capability, rendererIdentity }),
  });
  if (registered.status !== 204) {
    throw new Error("Packaged restart smoke could not register a window authority.");
  }
  const headers = {
    origin: "file://",
    "content-type": "application/json",
    "x-octant-window-capability": capability,
    "x-octant-renderer-identity": rendererIdentity,
  };
  return {
    windowId,
    headers,
    send: async (path, body, step) => {
      const response = await fetch(`${serverUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(`Packaged restart smoke could not ${step} (${response.status}).`);
      }
      return await response.json();
    },
  };
}

/** Code commands answer only for the Project the window has open. */
async function openCodeProject(window: SmokeWindowAuthority, projectId: string): Promise<void> {
  const shell = await window.send("/api/shell/bootstrap", undefined, "bootstrap the shell");
  const workspace = isRecord(shell) && isRecord(shell.workspace) ? shell.workspace : undefined;
  if (!isRecord(shell) || workspace === undefined) {
    throw new Error("Packaged restart smoke received no workspace.");
  }
  await window.send(
    "/api/shell/commands",
    {
      kind: "apply-workspace-operation",
      windowId: workspace.windowId,
      expectedVersion: shell.workspaceVersion,
      operation: {
        kind: "switch-project-surface",
        mode: "code",
        surface: { kind: "project", id: randomUUID(), projectId, mode: "code", title: "Smoke" },
      },
    },
    "open the Code Project",
  );
}

interface SeededCodeProject {
  readonly projectId: string;
  readonly bindingRevisionId: unknown;
  readonly repositoryId: unknown;
  readonly checkoutId: unknown;
}

async function createCodeProject(
  serverUrl: string,
  desktopBridgeSecret: string,
  window: SmokeWindowAuthority,
  repository: string,
): Promise<SeededCodeProject> {
  const receipt = await fetch(`${serverUrl}/api/desktop/project-binding-receipts`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-octant-desktop-secret": desktopBridgeSecret,
    },
    body: JSON.stringify({ windowId: window.windowId, projectType: "code", path: repository }),
  });
  const receiptBody: unknown = receipt.ok ? await receipt.json() : undefined;
  if (!isRecord(receiptBody) || typeof receiptBody.receiptId !== "string") {
    throw new Error(`Packaged restart smoke could not bind its repository (${receipt.status}).`);
  }
  const projectId = randomUUID();
  await window.send(
    "/api/projects/commands",
    {
      kind: "create-code-project",
      projectId,
      expectedVersion: 0,
      name: "Packaged restart smoke",
      receiptId: receiptBody.receiptId,
      hostId: "local",
    },
    "create a Code Project",
  );
  await openCodeProject(window, projectId);
  const prepared = await window.send(
    "/api/code/commands",
    { kind: "prepare-code-project-checkout", projectId },
    "prepare the checkout",
  );
  const checkout =
    isRecord(prepared) && isRecord(prepared.checkout) ? prepared.checkout : undefined;
  if (!isRecord(prepared) || checkout === undefined) {
    throw new Error("Packaged restart smoke received no prepared checkout.");
  }
  return {
    projectId,
    bindingRevisionId: prepared.bindingRevisionId,
    repositoryId: checkout.repositoryId,
    checkoutId: checkout.id,
  };
}

async function seedCodeProjectsAndThread(
  serverUrl: string,
  desktopBridgeSecret: string,
  repositories: readonly [string, string],
): Promise<{ readonly projectId: string; readonly threadId: string }> {
  const window = await registerWindowAuthority(serverUrl, desktopBridgeSecret);
  const send = window.send;
  await createCodeProject(serverUrl, desktopBridgeSecret, window, repositories[1]);
  // Created last, so it is the Project the window has open for the thread.
  const project = await createCodeProject(serverUrl, desktopBridgeSecret, window, repositories[0]);
  const providerInstanceId = randomUUID();
  const modelId = "packaged-restart-smoke";
  await send(
    "/api/providers/commands",
    {
      kind: "create-openai-compatible-provider",
      instanceId: providerInstanceId,
      expectedVersion: 0,
      displayName: "Packaged restart smoke",
      configuration: {
        kind: "openai-compatible-http",
        // Nothing listens here; the smoke never starts a turn.
        baseUrl: "http://127.0.0.1:9/v1",
        authentication: "none",
        protocol: "chat-completions",
        manualModelIds: [modelId],
      },
    },
    "create a provider",
  );
  const threadId = randomUUID();
  const now = new Date().toISOString();
  const created = await send(
    "/api/code/commands",
    {
      kind: "create-code-thread",
      thread: {
        id: threadId,
        projectId: project.projectId,
        bindingRevisionId: project.bindingRevisionId,
        repositoryId: project.repositoryId,
        checkoutId: project.checkoutId,
        title: "Packaged restart smoke",
        lifecycle: "active",
        providerInstanceId,
        modelId,
        executionPolicy: "approval-gated",
        permissionPersistence: "current-session",
        deliveryTarget: {
          branchIntent: "main",
          remoteName: "origin",
          proposedBaseRepository: "local/smoke",
          proposedBaseBranch: "main",
          outcomeKind: "local-implementation",
          confirmedAt: now,
        },
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
    },
    "create a Code thread",
  );
  if (!isRecord(created) || created.kind !== "thread-created") {
    throw new Error("Packaged restart smoke did not create its Code thread.");
  }
  return { projectId: project.projectId, threadId };
}

async function stayHealthy(serverUrl: string, durationMs: number): Promise<void> {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${serverUrl}/health`, {
      signal: AbortSignal.timeout(1_000),
    }).catch(() => undefined);
    if (response?.ok !== true) {
      throw new Error("Packaged host stopped answering after restarting on existing Code data.");
    }
    await sleep(250);
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
    await smokePackagedShellBootstrap(serverUrl, dataDirectory);
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

async function smokePackagedShellBootstrap(
  serverUrl: string,
  dataDirectory: string,
): Promise<void> {
  const desktopBridgeSecret = await waitForDesktopBridgeSecret(dataDirectory, 10_000);
  const windowId = randomUUID();
  const capability = randomBytes(32).toString("base64url");
  const rendererIdentity = randomBytes(32).toString("base64url");
  const desktopHeaders = {
    "content-type": "application/json",
    "x-octant-desktop-secret": desktopBridgeSecret,
  };
  const authority = await fetch(`${serverUrl}/api/desktop/window-authorities`, {
    method: "POST",
    headers: desktopHeaders,
    body: JSON.stringify({ windowId, capability, rendererIdentity }),
  });
  if (authority.status !== 204) {
    throw new Error("Packaged shell smoke could not register a window authority.");
  }

  let bootstrapFailure: unknown;
  try {
    const bootstrap = await fetch(`${serverUrl}/api/shell/bootstrap`, {
      method: "POST",
      headers: {
        origin: "file://",
        "x-octant-window-capability": capability,
        "x-octant-renderer-identity": rendererIdentity,
      },
    });
    if (!bootstrap.ok) {
      throw new Error(`Packaged shell bootstrap returned HTTP ${bootstrap.status}.`);
    }
    const body: unknown = await bootstrap.json();
    if (!isRecord(body) || body.connectionStatus !== "connected") {
      throw new Error("Packaged shell bootstrap did not report a connected host.");
    }

    const read = await fetch(`${serverUrl}/api/shell/bootstrap`, {
      headers: {
        origin: "file://",
        "x-octant-window-capability": capability,
        "x-octant-renderer-identity": rendererIdentity,
      },
    });
    if (!read.ok) throw new Error(`Packaged shell read returned HTTP ${read.status}.`);
  } catch (error) {
    bootstrapFailure = error;
  }
  const revoked = await fetch(`${serverUrl}/api/desktop/window-authorities`, {
    method: "DELETE",
    headers: desktopHeaders,
    body: JSON.stringify({ windowId }),
  });
  if (revoked.status !== 204) {
    throw new Error("Packaged shell smoke could not revoke its window authority.");
  }
  if (bootstrapFailure !== undefined) throw bootstrapFailure;
  console.log("Packaged shell bootstrap and renderer-bound authority smoke passed.");
}

async function waitForDesktopBridgeSecret(
  dataDirectory: string,
  timeoutMs: number,
): Promise<string> {
  const path = resolve(dataDirectory, "octant-bridge-secret");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const secret = (await readFile(path, "utf8")).trim();
      if (/^[A-Za-z0-9_-]{43}$/.test(secret)) return secret;
    } catch {
      // The desktop writes the bridge projection after its host becomes ready.
    }
    await sleep(100);
  }
  throw new Error(`Packaged desktop bridge secret was not projected within ${timeoutMs}ms.`);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

if (import.meta.main) await main();
