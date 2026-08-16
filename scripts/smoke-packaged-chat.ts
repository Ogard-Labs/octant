import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createQuitAppleScript, waitForChildExit } from "./package-desktop";
import {
  PACKAGED_SMOKE_SERVER_URL,
  cleanupPackagedProcess,
  PACKAGED_SMOKE_PROCESS_PROBE_TIMEOUT_MS,
  packagedServerEnvironment,
  runBoundedCommand,
  waitForProcessCleanup,
  type SmokeChildProcess,
} from "./packaged-smoke-process";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const appBundle = resolve(repositoryRoot, "out/Octant.app");
const executable = resolve(appBundle, "Contents/MacOS/Octant");
const packagedRoot = resolve(appBundle, "Contents/Resources/app");
const serverEntry = resolve(packagedRoot, "apps/server/dist/main.mjs");
const serverUrl = PACKAGED_SMOKE_SERVER_URL;
const FIXTURE_MODEL_ID = "octant-smoke:latest";
const FIXTURE_IMAGE_BYTES = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);
export interface PackagedChatSmokeDirectories {
  readonly root: string;
  readonly dataDirectory: string;
  readonly configDirectory: string;
  readonly scratchDirectory: string;
  readonly attachmentDirectory: string;
}

export interface PackagedChatProcess {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly command: string;
}

export function createPackagedChatSmokeDirectories(root: string): PackagedChatSmokeDirectories {
  const dataDirectory = join(root, "data");
  return {
    root,
    dataDirectory,
    configDirectory: join(root, "config"),
    scratchDirectory: join(dataDirectory, "chat", "scratch"),
    attachmentDirectory: join(dataDirectory, "chat", "threads"),
  };
}

export function packagedChatEnvironment(
  source: NodeJS.ProcessEnv,
  directories: PackagedChatSmokeDirectories,
): NodeJS.ProcessEnv {
  return packagedServerEnvironment(
    { ...source, HOME: directories.configDirectory, TMPDIR: directories.scratchDirectory },
    directories.dataDirectory,
  );
}

export function findOwnedPackagedChatProcesses(
  current: readonly PackagedChatProcess[],
  options: { readonly appPid: number; readonly serverEntry: string },
): { readonly app: PackagedChatProcess; readonly server: PackagedChatProcess } {
  const app = current.find((process) => process.pid === options.appPid);
  if (app === undefined) throw new Error("Packaged Octant managed app identity is unavailable.");
  const server = current.find(
    (process) => process.ppid === app.pid && process.command.includes(options.serverEntry),
  );
  if (server === undefined) {
    throw new Error("Packaged Octant managed server identity is unavailable.");
  }
  return { app, server };
}

export function assertNoOwnedPackagedChatProcesses(
  current: readonly PackagedChatProcess[],
  options: {
    readonly appPid: number;
    readonly processGroup: number;
    readonly ownedServerPid: number;
  },
): void {
  if (
    current.some(
      (process) =>
        process.pid === options.appPid ||
        process.pid === options.ownedServerPid ||
        process.pgid === options.processGroup,
    )
  ) {
    throw new Error("Packaged Octant left a smoke-owned Chat process.");
  }
}

interface PackagedChatLifecycleOptions<Setup, Baseline, App, Result> {
  readonly createRoot: () => Promise<string>;
  readonly setup: (root: string) => Promise<Setup>;
  readonly inspectBaseline: (root: string, setup: Setup) => Promise<Baseline>;
  readonly spawnApp: (root: string, setup: Setup, baseline: Baseline) => App;
  readonly verify: (root: string, setup: Setup, baseline: Baseline, app: App) => Promise<Result>;
  readonly cleanupApp: (root: string, setup: Setup, baseline: Baseline, app: App) => Promise<void>;
  readonly cleanupSetup: (root: string, setup: Setup) => Promise<void>;
  readonly removeRoot: (root: string) => Promise<void>;
}

export async function withPackagedChatLifecycle<Setup, Baseline, App, Result>(
  options: PackagedChatLifecycleOptions<Setup, Baseline, App, Result>,
): Promise<Result> {
  let root: string | undefined;
  let setup: Setup | undefined;
  let baseline: Baseline | undefined;
  let app: App | undefined;
  let result: Result | undefined;
  let primaryFailure: unknown;
  const cleanupFailures: Error[] = [];
  try {
    root = await options.createRoot();
    setup = await options.setup(root);
    baseline = await options.inspectBaseline(root, setup);
    app = options.spawnApp(root, setup, baseline);
    result = await options.verify(root, setup, baseline, app);
  } catch (error) {
    primaryFailure = error;
  } finally {
    if (root !== undefined && setup !== undefined && baseline !== undefined && app !== undefined) {
      await options.cleanupApp(root, setup, baseline, app).catch((error: unknown) => {
        cleanupFailures.push(
          new Error("Packaged Chat app cleanup failed.", { cause: normalizeFailure(error) }),
        );
      });
    }
    if (root !== undefined && setup !== undefined) {
      await options.cleanupSetup(root, setup).catch((error: unknown) => {
        cleanupFailures.push(
          new Error("Packaged Chat fixture cleanup failed.", { cause: normalizeFailure(error) }),
        );
      });
    }
    if (root !== undefined) {
      await options.removeRoot(root).catch((error: unknown) => {
        cleanupFailures.push(
          new Error("Packaged Chat root cleanup failed.", { cause: normalizeFailure(error) }),
        );
      });
    }
  }
  if (primaryFailure !== undefined) {
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [normalizeFailure(primaryFailure), ...cleanupFailures],
        "Packaged Chat smoke failed during verification and cleanup.",
      );
    }
    throw primaryFailure;
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, "Packaged Chat smoke cleanup failed.");
  }
  return result as Result;
}

function normalizeFailure(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

interface ProviderFixture {
  readonly baseUrl: string;
  readonly assertReceivedNativeImage: () => void;
  readonly close: () => Promise<void>;
}

export async function startPackagedChatProviderFixture(): Promise<ProviderFixture> {
  let receivedNativeImage = false;
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    response.statusCode = 200;
    if (request.method === "GET" && pathname === "/api/version") {
      return sendFixtureJson(response, { version: "0.1.0" });
    }
    if (request.method === "GET" && pathname === "/api/tags") {
      return sendFixtureJson(response, {
        models: [{ name: FIXTURE_MODEL_ID, model: FIXTURE_MODEL_ID }],
      });
    }
    if (request.method === "POST" && pathname === "/api/show") {
      return sendFixtureJson(response, {
        capabilities: ["completion", "vision"],
        model_info: { "octant.context_length": 8_192 },
      });
    }
    if (request.method === "POST" && pathname === "/api/chat") {
      receivedNativeImage ||= await requestHasNativeImageModality(request);
      response.setHeader("content-type", "application/x-ndjson");
      response.end(
        [
          {
            model: FIXTURE_MODEL_ID,
            message: { role: "assistant", content: "packaged " },
            done: false,
          },
          {
            model: FIXTURE_MODEL_ID,
            message: { role: "assistant", content: "chat smoke" },
            done: false,
          },
          {
            model: FIXTURE_MODEL_ID,
            message: { role: "assistant", content: "" },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 3,
            eval_count: 2,
          },
        ]
          .map((frame) => JSON.stringify(frame))
          .join("\n") + "\n",
      );
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await listenOnLoopback(server);
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("Packaged Chat provider fixture address is unavailable.");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    assertReceivedNativeImage: () => {
      if (!receivedNativeImage) {
        throw new Error("Packaged Chat fixture did not receive a native image modality.");
      }
    },
    close: () => closeServer(server),
  };
}

async function requestHasNativeImageModality(request: IncomingMessage): Promise<boolean> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return false;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return false;
  }
  if (!isRecord(value) || !Array.isArray(value.messages)) return false;
  return value.messages.some((message) => {
    if (!isRecord(message) || message.role !== "user" || !Array.isArray(message.images)) {
      return false;
    }
    return message.images.some((image) => typeof image === "string" && image.length > 0);
  });
}

function sendFixtureJson(response: import("node:http").ServerResponse, value: unknown): void {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

async function listenOnLoopback(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => {
      if (
        error === undefined ||
        (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING"
      ) {
        resolvePromise();
      } else {
        reject(error);
      }
    });
    server.closeAllConnections();
  });
}

export function isFinalizedPackagedAttachment(
  value: unknown,
  threadId: string,
  attachmentId: string,
): boolean {
  return (
    isRecord(value) &&
    value.id === attachmentId &&
    value.threadId === threadId &&
    value.status === "finalized"
  );
}

export function completedAssistantText(view: Record<string, unknown>): string | undefined {
  const contents = Array.isArray(view.contents) ? view.contents : [];
  const contentById = new Map(
    contents.flatMap((content) => {
      if (
        !isRecord(content) ||
        typeof content.contentId !== "string" ||
        content.role !== "assistant" ||
        typeof content.body !== "string"
      ) {
        return [];
      }
      return [[content.contentId, content.body] as const];
    }),
  );
  const turns = Array.isArray(view.turns) ? view.turns : [];
  for (const turn of turns.toReversed()) {
    if (!isRecord(turn) || !Array.isArray(turn.attempts)) continue;
    for (const attempt of turn.attempts.toReversed()) {
      if (
        !isRecord(attempt) ||
        attempt.outcome !== "completed" ||
        !Array.isArray(attempt.responseRefs)
      ) {
        continue;
      }
      const bodies = attempt.responseRefs.flatMap((reference) => {
        if (!isRecord(reference) || typeof reference.contentId !== "string") return [];
        const body = contentById.get(reference.contentId);
        return body === undefined ? [] : [body];
      });
      return bodies.join("");
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("The packaged Chat smoke requires Apple Silicon macOS.");
  }
  await Promise.all([access(executable, 1), access(serverEntry)]);
  await assertSmokePortAvailable();
  await withPackagedChatLifecycle({
    createRoot: () => mkdtemp(resolve(tmpdir(), "octant-packaged-chat.")),
    setup: async (root) => {
      const directories = createPackagedChatSmokeDirectories(root);
      await Promise.all([
        mkdir(directories.dataDirectory, { recursive: true, mode: 0o700 }),
        mkdir(directories.configDirectory, { recursive: true, mode: 0o700 }),
        mkdir(directories.scratchDirectory, { recursive: true, mode: 0o700 }),
        mkdir(directories.attachmentDirectory, { recursive: true, mode: 0o700 }),
      ]);
      return {
        directories,
        env: packagedChatEnvironment(process.env, directories),
        fixture: await startPackagedChatProviderFixture(),
      };
    },
    inspectBaseline: () => processIdentities(),
    spawnApp: (_root, setup) => ({
      child: spawn(executable, [], { detached: true, env: setup.env, stdio: "ignore" }),
      identities: undefined as
        | { readonly app: PackagedChatProcess; readonly server: PackagedChatProcess }
        | undefined,
    }),
    verify: async (_root, setup, _baseline, app) => {
      await waitForStorageReady(20_000);
      app.identities = await waitForOwnedProcesses(app.child, 5_000);
      const capability = await waitForWindowCapability(setup.directories.dataDirectory, 20_000);
      const providerInstanceId = randomUUID();
      await createFixtureProvider(capability, providerInstanceId, setup.fixture.baseUrl);
      await initializeChatSettings(capability, providerInstanceId);
      const threadId = await createChatThread(capability);
      const attachmentId = await uploadChatAttachment(capability, threadId);
      await smokeChatTurn(capability, threadId, attachmentId);
      setup.fixture.assertReceivedNativeImage();
      await Promise.all([
        access(setup.directories.scratchDirectory),
        access(setup.directories.attachmentDirectory),
        access(
          join(setup.directories.attachmentDirectory, threadId, attachmentId, "finalized.bin"),
        ),
      ]);
    },
    cleanupApp: async (_root, setup, baseline, app) => {
      app.identities ??= await findOwnedProcessesIfPresent(app.child);
      await cleanupPackagedProcess({
        child: app.child,
        requestQuit: () => quitApplication(setup.env),
        waitForExit: waitForExitResult,
        signalGroup: signalGroupByPid,
        waitForServerCleanup: () => waitForServerCleanup(10_000),
        assertNoProcesses: () =>
          waitForProcessCleanup(
            (remainingMs) =>
              assertPackagedChatCleanup(
                baseline,
                app.child.pid,
                app.identities?.server.pid,
                remainingMs,
              ),
            { timeoutMs: 10_000, probeTimeoutMs: PACKAGED_SMOKE_PROCESS_PROBE_TIMEOUT_MS },
          ),
      });
    },
    cleanupSetup: (_root, setup) => setup.fixture.close(),
    removeRoot: (root) => rm(root, { recursive: true, force: true }),
  });
  console.log(
    "Packaged Chat deterministic stream, isolated storage, attachment, and exact cleanup smoke passed.",
  );
}

async function createChatThread(capability: string): Promise<string> {
  const result = await chatRequest("/api/chat/commands", capability, {
    kind: "create-chat-thread",
    title: "Packaged Chat smoke",
  });
  if (!isRecord(result) || result.kind !== "thread-created" || !isRecord(result.thread)) {
    throw new Error("Packaged Chat create-thread evidence is invalid.");
  }
  const threadId = result.thread.id;
  if (typeof threadId !== "string" || threadId.length === 0) {
    throw new Error("Packaged Chat create-thread result omitted the thread identity.");
  }
  return threadId;
}

async function createFixtureProvider(
  capability: string,
  providerInstanceId: string,
  baseUrl: string,
): Promise<void> {
  const result = await providerRequest("/api/providers/commands", capability, {
    kind: "create-ollama-provider",
    instanceId: providerInstanceId,
    expectedVersion: 0,
    displayName: "Packaged Chat deterministic fixture",
    configuration: { kind: "ollama-native-http", baseUrl },
  });
  if (!isRecord(result) || result.kind !== "provider-created") {
    throw new Error("Packaged Chat fixture provider creation evidence is invalid.");
  }
}

async function initializeChatSettings(
  capability: string,
  providerInstanceId: string,
): Promise<void> {
  const result = await chatRequest("/api/chat/commands", capability, {
    kind: "update-chat-settings",
    expectedVersion: 0,
    defaultProviderInstanceId: providerInstanceId,
    defaultModelId: FIXTURE_MODEL_ID,
    defaultResearchEnabled: false,
    defaultResearchRouting: "automatic",
    defaultPersonalityInstructions: "Stay local and concise.",
  });
  if (!isRecord(result) || result.kind !== "settings-updated") {
    throw new Error("Packaged Chat settings initialization evidence is invalid.");
  }
}

async function smokeChatTurn(
  capability: string,
  threadId: string,
  attachmentId: string,
): Promise<void> {
  const view = await readChatThread(capability, threadId);
  const thread = isRecord(view.thread) ? view.thread : undefined;
  if (thread === undefined || typeof thread.version !== "number") {
    throw new Error("Packaged Chat thread version evidence is invalid.");
  }
  const result = await chatRequest("/api/chat/commands", capability, {
    kind: "send-chat-turn",
    threadId,
    expectedVersion: thread.version,
    prompt: "Prove this packaged deterministic Chat stream.",
    attachmentIds: [attachmentId],
  });
  if (!isRecord(result) || result.kind !== "turn-created") {
    throw new Error("Packaged Chat turn creation evidence is invalid.");
  }

  const completedView = await waitForCompletedChatThread(capability, threadId, 20_000);
  const assistantText = completedAssistantText(completedView);
  if (assistantText !== "packaged chat smoke") {
    throw new Error(
      `Packaged Chat completion lacked deterministic assistant content: ${JSON.stringify(assistantText)}.`,
    );
  }
  const afterSequence = 0;
  const response = await fetch(
    new URL(
      `/api/chat/threads/${encodeURIComponent(threadId)}/events?afterSequence=${afterSequence}`,
      serverUrl,
    ),
    {
      headers: { "x-octant-window-capability": capability },
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok) throw new Error(`Packaged Chat replay failed with status ${response.status}.`);
  const frames = (await response.text())
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
  const outcomes = frames.flatMap((frame) => {
    if (!isRecord(frame) || !isRecord(frame.event) || frame.event.kind !== "attempt-updated") {
      return [];
    }
    const attempt = isRecord(frame.event.attempt) ? frame.event.attempt : undefined;
    return typeof attempt?.outcome === "string" ? [attempt.outcome] : [];
  });
  if (!outcomes.includes("streaming") || !outcomes.includes("completed")) {
    throw new Error("Packaged Chat replay lacked streaming and completed attempt evidence.");
  }
}

async function waitForCompletedChatThread(
  capability: string,
  threadId: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const view = await readChatThread(capability, threadId);
    const turns = Array.isArray(view.turns) ? view.turns : [];
    const outcomes = turns.flatMap((turn) => {
      if (!isRecord(turn) || !Array.isArray(turn.attempts)) return [];
      return turn.attempts.flatMap((attempt) =>
        isRecord(attempt) && typeof attempt.outcome === "string" ? [attempt.outcome] : [],
      );
    });
    if (outcomes.includes("completed")) return view;
    if (outcomes.some((outcome) => ["failed", "cancelled", "interrupted"].includes(outcome))) {
      throw new Error(`Packaged Chat turn ended as ${outcomes.at(-1)}.`);
    }
    await delay(50);
  }
  throw new Error(`Packaged Chat turn did not complete within ${timeoutMs}ms.`);
}

async function readChatThread(
  capability: string,
  threadId: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(
    new URL(`/api/chat/threads/${encodeURIComponent(threadId)}`, serverUrl),
    {
      headers: { "x-octant-window-capability": capability },
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok) throw new Error(`Packaged Chat read failed with status ${response.status}.`);
  const result = (await response.json()) as unknown;
  if (!isRecord(result)) throw new Error("Packaged Chat read evidence is invalid.");
  return result;
}

async function providerRequest(path: string, capability: string, body: unknown): Promise<unknown> {
  const response = await fetch(new URL(path, serverUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-octant-window-capability": capability,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`Packaged Provider API request failed with status ${response.status}.`);
  }
  return await response.json();
}

async function uploadChatAttachment(capability: string, threadId: string): Promise<string> {
  const attachmentId = randomUUID();
  const response = await fetch(new URL("/api/chat/attachments", serverUrl), {
    method: "POST",
    headers: {
      "content-type": "image/png",
      "x-octant-window-capability": capability,
      "x-octant-chat-thread-id": threadId,
      "x-octant-chat-attachment-id": attachmentId,
      "x-octant-chat-display-name": "packaged-chat-smoke.png",
    },
    body: FIXTURE_IMAGE_BYTES,
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok)
    throw new Error(`Packaged Chat attachment upload failed with status ${response.status}.`);
  const result = (await response.json()) as unknown;
  if (!isFinalizedPackagedAttachment(result, threadId, attachmentId)) {
    throw new Error("Packaged Chat attachment evidence is invalid.");
  }
  return attachmentId;
}

async function chatRequest(path: string, capability: string, body: unknown): Promise<unknown> {
  const response = await fetch(new URL(path, serverUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-octant-window-capability": capability,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Packaged Chat request failed with status ${response.status}.`);
  return await response.json();
}

async function waitForStorageReady(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(500) });
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
      // The packaged managed server may still be binding its loopback socket.
    }
    await delay(100);
  }
  throw new Error(`Packaged Octant server was not storage-ready within ${timeoutMs}ms.`);
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

async function waitForOwnedProcesses(
  app: ChildProcess,
  timeoutMs: number,
): Promise<{ readonly app: PackagedChatProcess; readonly server: PackagedChatProcess }> {
  const appPid = app.pid;
  if (appPid === undefined) throw new Error("Packaged Octant app has no process ID.");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return findOwnedPackagedChatProcesses(await processIdentities(), { appPid, serverEntry });
    } catch {
      await delay(50);
    }
  }
  throw new Error("Packaged Octant managed app/server identities were unavailable.");
}

async function findOwnedProcessesIfPresent(
  app: ChildProcess,
): Promise<
  { readonly app: PackagedChatProcess; readonly server: PackagedChatProcess } | undefined
> {
  if (app.pid === undefined) return undefined;
  try {
    return findOwnedPackagedChatProcesses(await processIdentities(), {
      appPid: app.pid,
      serverEntry,
    });
  } catch {
    return undefined;
  }
}

async function assertPackagedChatCleanup(
  baseline: readonly PackagedChatProcess[],
  appPid: number | undefined,
  serverPid: number | undefined,
  timeoutMs: number,
): Promise<void> {
  const current = await processIdentities(timeoutMs);
  if (appPid !== undefined && serverPid !== undefined) {
    assertNoOwnedPackagedChatProcesses(current, {
      appPid,
      processGroup: appPid,
      ownedServerPid: serverPid,
    });
    return;
  }
  const baselinePids = new Set(baseline.map((process) => process.pid));
  if (
    current.some(
      (process) => !baselinePids.has(process.pid) && process.command.includes(serverEntry),
    )
  ) {
    throw new Error("Packaged Octant left an unattributed Chat server process.");
  }
}

async function quitApplication(env: NodeJS.ProcessEnv): Promise<void> {
  await runBoundedCommand(
    "/usr/bin/osascript",
    ["-e", createQuitAppleScript(appBundle)],
    env,
    5_000,
  );
}

async function waitForExitResult(child: SmokeChildProcess, timeoutMs: number): Promise<boolean> {
  try {
    await waitForChildExit(child as ChildProcess, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

function signalGroupByPid(pid: number, signal: "SIGKILL" | "SIGTERM"): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
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

async function assertSmokePortAvailable(): Promise<void> {
  const occupied = await new Promise<boolean>((resolvePromise) => {
    const socket = connect({ host: "127.0.0.1", port: 13_773 });
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolvePromise(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolvePromise(false);
    });
    socket.once("error", () => resolvePromise(false));
  });
  if (occupied)
    throw new Error("Packaged Chat smoke cannot start because Octant port 13773 is occupied.");
}

async function processIdentities(timeoutMs = 5_000): Promise<readonly PackagedChatProcess[]> {
  const output = await runBoundedCommand(
    "/bin/ps",
    ["-ax", "-o", "pid=,ppid=,pgid=,command="],
    { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    timeoutMs,
  );
  return output.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) return [];
    return [
      {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        pgid: Number(match[3]),
        command: match[4] ?? "",
      },
    ];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

if (import.meta.main) await main();
