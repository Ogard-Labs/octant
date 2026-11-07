// Synthetic Nightly client smoke.
//
// Runs the ordinary Nightly client (`runNightlyClient` with the Nightly
// identity) in the Electron the desktop app ships, under Playwright, against a
// real development host on a throwaway data folder and port. A synthetic
// Stable (`nightly-client-harness-stable.ts`) owns that host, its bridge
// secret, the Browser runtime, and Stable's real lease owner and client
// lifetime; only the signed native window binding is stood in for, by a
// private local socket. Nothing here is packaged, signed or installed, and it
// needs no secret.
//
// Scenarios, in order, each timed:
//  1. the renderer loads with the Nightly label;
//  2. a Chat thread is created and a turn completes against a local fixture
//     provider;
//  3. brokered native-main flows: a Project folder pick through the stubbed
//     native picker, an API key added and listed, and a Code approval
//     prepared and cancelled;
//  4. the embedded Browser: a local page opens, a frame arrives, typed text
//     reaches a text field, directional key presses and releases retain their
//     identity, and a select list's popup round-trips;
//  5. lease loss destroys the renderer and recovery registers a fresh window;
//  6. a host restart, after which Nightly reconnects on the same data;
//  7. two hosts on separate folders and ports never see each other's data;
//  8. quit-one (Nightly quits, the host stays) and quit-last (Stable's UI
//     quit retains the host until the last Nightly leaves, then its guarded
//     shutdown stops it).
//
// Run from the repository root (macOS; it needs the Electron binary):
//   bun scripts/smoke-nightly-client.ts
// Set OCTANT_NIGHTLY_SMOKE_SKIP_WEB_BUILD=1 to reuse an existing
// apps/web/dist. Exits 0 when every scenario passes, 1 when one fails, and 2
// when no Electron is available. Every process it starts is tracked by PID and
// verified gone before it exits; the throwaway folder is removed.

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { _electron, type ElectronApplication, type Page } from "playwright-core";

const root = resolve(import.meta.dir, "..");
const FIXTURE_MODEL_ID = "nightly-smoke-model";
const FIXTURE_KEY = "nightly-smoke-test-key-not-a-secret";
const SCENARIO_DEADLINE_MS = 90_000;

interface ScenarioRow {
  readonly scenario: string;
  readonly status: "pass" | "fail" | "not run";
  readonly ms?: number;
  readonly detail?: string;
}

const rows: Array<ScenarioRow> = [];
const startedPids = new Map<number, string>();
const cleanups: Array<() => Promise<void>> = [];
const stables: Array<StableHarness> = [];

function track(pid: number | undefined, purpose: string): void {
  if (pid !== undefined) startedPids.set(pid, purpose);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function within<T>(label: string, ms: number, run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} took longer than ${ms}ms.`)), ms);
  });
  try {
    return await Promise.race([run(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor<T>(
  label: string,
  ms: number,
  probe: () => Promise<T | undefined> | T | undefined,
): Promise<T> {
  const deadline = Date.now() + ms;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`${label} did not happen within ${ms}ms${lastError ? `: ${lastError}` : "."}`);
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  await new Promise<void>((done) => server.close(() => done()));
  if (address === null || typeof address === "string") throw new Error("No free port.");
  return address.port;
}

async function listening(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
    return true;
  } catch {
    return false;
  }
}

async function electronBinary(): Promise<string | undefined> {
  try {
    const candidate = createRequire(join(root, "apps/desktop/package.json"))("electron") as string;
    if (await Bun.file(candidate).exists()) return candidate;
  } catch {
    // Not installed.
  }
  return undefined;
}

/**
 * A local OpenAI-compatible endpoint that streams one fixed Chat Completions
 * answer and remembers the bearer key each request carried.
 */
async function startProviderFixture(): Promise<{
  readonly baseUrl: string;
  readonly server: Server;
  readonly bearers: ReadonlyArray<string>;
}> {
  const bearers: Array<string> = [];
  const server = createHttpServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    request.resume();
    const authorization = request.headers.authorization ?? "";
    if (authorization.startsWith("Bearer ")) bearers.push(authorization.slice("Bearer ".length));
    if (request.method === "GET" && pathname === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ object: "list", data: [{ id: FIXTURE_MODEL_ID, object: "model" }] }),
      );
      return;
    }
    if (request.method === "POST" && pathname === "/v1/chat/completions") {
      response.setHeader("content-type", "text/event-stream");
      const chunk = (delta: Record<string, unknown>, finish: string | null) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-nightly-smoke",
          object: "chat.completion.chunk",
          created: 0,
          model: FIXTURE_MODEL_ID,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      response.end(
        chunk({ role: "assistant", content: "nightly " }, null) +
          chunk({ content: "smoke" }, null) +
          chunk({}, "stop") +
          "data: [DONE]\n\n",
      );
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No fixture port.");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, server, bearers };
}

/** The page the embedded Browser opens: a text field and a select list. */
async function startPageFixture(): Promise<{
  readonly url: string;
  readonly server: Server;
  readonly reports: ReadonlyArray<string>;
}> {
  const html = `<!doctype html><html><head><title>Nightly smoke page</title>
<style>body{margin:0;font:16px sans-serif}#field{position:absolute;left:20px;top:20px;width:300px;height:40px;font-size:20px}#choice{position:absolute;left:20px;top:100px;width:300px;height:40px;font-size:20px}</style></head>
<body><input id="field" autocomplete="off"><select id="choice"><option>First</option><option>Second</option><option>Third</option></select>
<script>
let presses = 0;
let keys = 0;
const arrows = [];
const report = () => { const state = "field=" + document.getElementById("field").value + ";choice=" + document.getElementById("choice").value + ";presses=" + presses + ";keys=" + keys + ";arrows=" + arrows.join(","); document.title = state; fetch("/report?" + encodeURIComponent(state)).catch(() => {}); };
addEventListener("mousedown", () => { presses++; report(); }, true);
addEventListener("keydown", (event) => { keys++; if (event.key.startsWith("Arrow")) arrows.push("down:" + event.key); report(); }, true);
addEventListener("keyup", (event) => { if (event.key.startsWith("Arrow")) arrows.push("up:" + event.key); report(); }, true);
document.getElementById("field").addEventListener("input", report);
document.getElementById("choice").addEventListener("change", report);
</script></body></html>`;
  const reports: Array<string> = [];
  const server = createHttpServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/report") {
      reports.push(decodeURIComponent(url.search.slice(1)));
      response.end();
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(html);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No page port.");
  return { url: `http://127.0.0.1:${address.port}/`, server, reports };
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((done) => server.close(() => done()));
}

interface HarnessEvent {
  readonly event: string;
  readonly [key: string]: unknown;
}

/** One process's `HARNESS` lines, waited on by predicate. */
class EventLog {
  readonly #events: Array<HarnessEvent> = [];
  readonly #waiters = new Set<() => void>();

  attach(stream: NodeJS.ReadableStream, echo: string): void {
    createInterface({ input: stream }).on("line", (line) => {
      if (!line.startsWith("HARNESS ")) {
        if (process.env.OCTANT_NIGHTLY_SMOKE_VERBOSE === "1") console.error(`${echo}: ${line}`);
        return;
      }
      try {
        this.#events.push(JSON.parse(line.slice("HARNESS ".length)) as HarnessEvent);
      } catch {
        return;
      }
      for (const waiter of this.#waiters) waiter();
    });
  }

  mark(): number {
    return this.#events.length;
  }

  matching(predicate: (event: HarnessEvent) => boolean): ReadonlyArray<HarnessEvent> {
    return this.#events.filter(predicate);
  }

  count(predicate: (event: HarnessEvent) => boolean, after = 0): number {
    return this.#events.slice(after).filter(predicate).length;
  }

  async next(
    predicate: (event: HarnessEvent) => boolean,
    after: number,
    ms: number,
  ): Promise<HarnessEvent> {
    return waitFor(`A harness event after mark ${after}`, ms, () =>
      this.#events.slice(after).find(predicate),
    );
  }
}

interface StableHarness {
  readonly child: ChildProcess;
  readonly events: EventLog;
  readonly port: number;
  readonly work: string;
  readonly socket: string;
  readonly command: (line: string) => void;
}

async function startStable(input: {
  readonly binary: string;
  readonly main: string;
  readonly work: string;
  readonly name: string;
}): Promise<StableHarness> {
  await mkdir(input.work, { recursive: true, mode: 0o700 });
  const port = await freePort();
  const socket = join(input.work, "native.sock");
  const child = spawn(input.binary, [input.main], {
    env: {
      ...process.env,
      OCTANT_HARNESS_ROOT: root,
      OCTANT_HARNESS_WORK: input.work,
      OCTANT_HARNESS_PORT: String(port),
      OCTANT_HARNESS_SOCKET: socket,
      OCTANT_HARNESS_BUN: process.execPath,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  track(child.pid, `${input.name} synthetic Stable (Electron)`);
  const events = new EventLog();
  if (child.stdout !== null) events.attach(child.stdout, input.name);
  if (child.stderr !== null) events.attach(child.stderr, input.name);
  const harness: StableHarness = {
    child,
    events,
    port,
    work: input.work,
    socket,
    command: (line) => child.stdin?.write(`${line}\n`),
  };
  stables.push(harness);
  cleanups.push(() => stopStable(harness));
  const ready = await events.next(
    (event) => event.event === "ready" || event.event === "command-failed",
    0,
    90_000,
  );
  if (ready.event !== "ready") throw new Error(`${input.name} did not start.`);
  return harness;
}

async function stopStable(harness: StableHarness): Promise<void> {
  if (harness.child.exitCode !== null || harness.child.signalCode !== null) return;
  const exited = new Promise<void>((done) => harness.child.once("exit", () => done()));
  harness.child.stdin?.end();
  const forced = setTimeout(() => harness.child.kill("SIGKILL"), 20_000);
  await exited;
  clearTimeout(forced);
}

function hostPids(harness: StableHarness): ReadonlyArray<number> {
  return harness.events
    .matching((event) => event.event === "host-process")
    .flatMap((event) => (typeof event.pid === "number" ? [event.pid] : []));
}

interface NightlyHarness {
  readonly app: ElectronApplication;
  readonly events: EventLog;
  readonly pid: number | undefined;
}

async function launchNightly(input: {
  readonly binary: string;
  readonly main: string;
  readonly stable: StableHarness;
  readonly work: string;
  readonly pickFolder: string;
}): Promise<NightlyHarness> {
  await mkdir(input.work, { recursive: true, mode: 0o700 });
  const inherited: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && !name.startsWith("OCTANT_")) inherited[name] = value;
  const app = await _electron.launch({
    executablePath: input.binary,
    args: [input.main],
    env: {
      ...inherited,
      OCTANT_HARNESS_SOCKET: input.stable.socket,
      OCTANT_HARNESS_WORK: input.work,
      OCTANT_HARNESS_PICK_FOLDER: input.pickFolder,
      OCTANT_HARNESS_MENU_PICK: "Third",
      OCTANT_HARNESS_OWNER_PID: String(process.pid),
    },
    timeout: 60_000,
  });
  const pid = app.process().pid;
  track(pid, "Nightly harness (Electron)");
  const events = new EventLog();
  const stdout = app.process().stdout;
  const stderr = app.process().stderr;
  if (stdout !== null) events.attach(stdout, "nightly");
  if (stderr !== null) events.attach(stderr, "nightly");
  cleanups.push(async () => {
    if (app.process().exitCode === null && app.process().signalCode === null)
      await within("Closing Nightly", 20_000, () => app.close()).catch(() =>
        app.process().kill("SIGKILL"),
      );
  });
  return { app, events, pid };
}

/** The Nightly window that shows the Nightly label. */
async function settledWindow(nightly: NightlyHarness): Promise<Page> {
  const page = await currentWindow(nightly);
  await nightlyLabel(page);
  return page;
}

async function currentWindow(nightly: NightlyHarness): Promise<Page> {
  return waitFor("A Nightly window", 30_000, () =>
    nightly.app.windows().find((page) => !page.isClosed() && page.url().startsWith("file:")),
  );
}

async function nightlyLabel(page: Page): Promise<void> {
  try {
    // Attached rather than visible: a first-run dialog may cover the chrome
    // and take it out of the accessibility tree while the label is drawn.
    await page
      .locator('.application-identity[aria-label^="Octant Nightly"]')
      .first()
      .waitFor({ state: "attached", timeout: 30_000 });
  } catch (error) {
    const state = await within("Reading the window", 3_000, () =>
      page.evaluate(() => ({
        readyState: document.readyState,
        visibility: document.visibilityState,
        text: document.body?.innerText.slice(0, 300) ?? "",
      })),
    ).catch((reason: unknown) => String(reason));
    // A failed run keeps what the window showed, outside the throwaway folder.
    const keep = process.env.OCTANT_NIGHTLY_SMOKE_ARTIFACTS;
    if (keep !== undefined && !page.isClosed())
      await page.screenshot({ path: join(keep, `label-${Date.now()}.png`) }).catch(() => undefined);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} Window: ${JSON.stringify(state)}`,
    );
  }
}

/** Calls the host from the renderer's own page, with its window capability. */
async function hostRequest(
  page: Page,
  path: string,
  body?: unknown,
): Promise<{ readonly status: number; readonly body: unknown }> {
  return page.evaluate(
    async ({ path, body }) => {
      const bridge = (window as unknown as { octantHost: { projectWindowCapability: string } })
        .octantHost;
      const serverUrl = new URL(location.href).searchParams.get("serverUrl") ?? "";
      const response = await fetch(new URL(path, serverUrl), {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": bridge.projectWindowCapability,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json().catch(() => undefined) };
    },
    { path, body },
  );
}

/**
 * Creates the fixture endpoint as a provider, stores its key through Nightly
 * main's native-main route (never the renderer's own host request), makes it
 * Chat's default and opens a thread.
 */
async function createFixtureThread(
  page: Page,
  input: { readonly providerInstanceId: string; readonly baseUrl: string; readonly title: string },
): Promise<string> {
  const provider = await hostRequest(page, "/api/providers/commands", {
    kind: "create-openai-compatible-provider",
    instanceId: input.providerInstanceId,
    expectedVersion: 0,
    displayName: "Nightly smoke fixture",
    configuration: {
      kind: "openai-compatible-http",
      baseUrl: input.baseUrl,
      authentication: "bearer",
      protocol: "chat-completions",
      manualModelIds: [FIXTURE_MODEL_ID],
    },
  });
  if (record(provider.body).kind !== "provider-created")
    throw new Error(`Provider: ${JSON.stringify(provider)}`);
  const added = await page.evaluate(
    ({ instance, key }) =>
      (
        window as unknown as {
          octantHost: {
            addProviderApiKey: (id: string, key: string, label: string) => Promise<unknown>;
          };
        }
      ).octantHost.addProviderApiKey(instance, key, "Smoke key"),
    { instance: input.providerInstanceId, key: FIXTURE_KEY },
  );
  if (record(added).label !== "Smoke key") throw new Error(`Key: ${JSON.stringify(added)}`);
  // The renderer can configure fresh Chat defaults when this provider becomes
  // eligible. Read this host's current version and retry only that stale write.
  for (let attempt = 0; attempt < 3; attempt++) {
    const bootstrap = await hostRequest(page, "/api/chat/bootstrap");
    if (bootstrap.status !== 200) throw new Error(`Bootstrap: ${JSON.stringify(bootstrap)}`);
    const version = record(record(bootstrap.body).settings).version;
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0)
      throw new Error("Bootstrap returned an invalid Chat settings version.");
    const settings = await hostRequest(page, "/api/chat/commands", {
      kind: "update-chat-settings",
      expectedVersion: version,
      defaultProviderInstanceId: input.providerInstanceId,
      defaultModelId: FIXTURE_MODEL_ID,
      defaultResearchEnabled: false,
      defaultResearchRouting: "automatic",
      defaultPersonalityInstructions: "Stay local and concise.",
    });
    if (settings.status === 200 && record(settings.body).kind === "settings-updated") break;
    if (settings.status === 409 && record(settings.body).category === "stale" && attempt < 2)
      continue;
    throw new Error(`Settings: ${JSON.stringify(settings)}`);
  }
  const created = await hostRequest(page, "/api/chat/commands", {
    kind: "create-chat-thread",
    title: input.title,
  });
  if (created.status !== 200) throw new Error(`Thread: ${JSON.stringify(created)}`);
  return String(record(record(created.body).thread).id);
}

async function capabilityOf(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      (window as unknown as { octantHost: { projectWindowCapability: string } }).octantHost
        .projectWindowCapability,
  );
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new Error("Expected an object.");
  return value as Record<string, unknown>;
}

async function scenario(name: string, run: () => Promise<string | void>): Promise<boolean> {
  const started = performance.now();
  try {
    const detail = await within(name, SCENARIO_DEADLINE_MS, run);
    rows.push({
      scenario: name,
      status: "pass",
      ms: Math.round(performance.now() - started),
      ...(typeof detail === "string" ? { detail } : {}),
    });
    return true;
  } catch (error) {
    rows.push({
      scenario: name,
      status: "fail",
      ms: Math.round(performance.now() - started),
      detail: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function build(work: string): Promise<{ readonly stable: string; readonly nightly: string }> {
  if (process.env.OCTANT_NIGHTLY_SMOKE_SKIP_WEB_BUILD !== "1") {
    const web = Bun.spawnSync(["bun", "run", "--cwd", join(root, "apps/web"), "build"], {
      stdout: "ignore",
      stderr: "pipe",
    });
    if (web.exitCode !== 0) throw new Error(`The renderer build failed: ${web.stderr.toString()}`);
  }
  // The client resolves its renderer three folders above its own module, as
  // the built desktop main does, so the bundle sits three folders deep.
  const rendererRoot = join(work, "renderer-root");
  const out = join(rendererRoot, "scripts", "nightly-client-harness", "out");
  await mkdir(join(rendererRoot, "apps", "web"), { recursive: true });
  await symlink(join(root, "apps/web/dist"), join(rendererRoot, "apps/web/dist"));
  const mains = await Bun.build({
    entrypoints: [
      join(root, "scripts/nightly-client-harness-stable.ts"),
      join(root, "scripts/nightly-client-harness-nightly.ts"),
    ],
    outdir: out,
    naming: "[name].mjs",
    target: "node",
    format: "esm",
    external: ["electron"],
  });
  const preloads = await Bun.build({
    entrypoints: [
      join(root, "apps/desktop/src/preload.ts"),
      join(root, "apps/desktop/src/codeOperationApprovalViewPreload.ts"),
      join(root, "apps/desktop/src/browserEditablePreload.ts"),
    ],
    outdir: out,
    naming: "[name].cjs",
    target: "node",
    format: "cjs",
    external: ["electron"],
  });
  if (!mains.success || !preloads.success)
    throw new Error(
      `The harness build failed: ${[...mains.logs, ...preloads.logs].map(String).join("\n")}`,
    );
  return {
    stable: join(out, "nightly-client-harness-stable.mjs"),
    nightly: join(out, "nightly-client-harness-nightly.mjs"),
  };
}

const binary = await electronBinary();
if (binary === undefined || process.platform !== "darwin") {
  console.error(
    JSON.stringify({
      status: "skipped",
      reason: "needs macOS and the Electron binary; run bun install",
    }),
  );
  process.exit(2);
}

const work = realpathSync(await mkdtemp(join(tmpdir(), "octant-nightly-smoke-")));
await chmod(work, 0o700);
let exitCode = 1;
const ports: Array<number> = [];
const servers: Array<Server> = [];
let finishing: Promise<void> | undefined;
// An interrupted run still stops what it started and removes its folder.
// Playwright's own Electron signal handling closes the Nightly harnesses and
// may exit first, so on exit the Stable harnesses are stopped (their hosts
// watch them and follow) and the folder is removed either way.
process.once("exit", () => {
  // Only this run's own synthetic Stable processes; their hosts follow them.
  for (const harness of stables)
    if (harness.child.exitCode === null && harness.child.signalCode === null)
      harness.child.kill("SIGKILL");
  rmSync(work, { recursive: true, force: true });
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    rows.push({ scenario: "harness", status: "fail", detail: `interrupted by ${signal}` });
    void finish().then(() => process.exit(1));
  });
try {
  const providerFixture = await startProviderFixture();
  servers.push(providerFixture.server);
  const pageFixture = await startPageFixture();
  servers.push(pageFixture.server);
  const mains = await build(work);
  const pickFolder = join(work, "picked-project");
  await mkdir(pickFolder, { recursive: true });
  // The folder the stubbed picker answers is a Git repository on `main` with
  // one commit, so a Code Project can bind it and prepare a checkout.
  for (const args of [
    ["init", "-q", "-b", "main"],
    [
      "-c",
      "user.name=Nightly smoke",
      "-c",
      "user.email=smoke@octant.invalid",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "Nightly smoke",
    ],
  ]) {
    const git = Bun.spawnSync(["git", ...args], {
      cwd: pickFolder,
      stdout: "ignore",
      stderr: "pipe",
    });
    if (git.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${git.stderr.toString()}`);
  }
  const stableA = await startStable({
    binary,
    main: mains.stable,
    work: join(work, "a"),
    name: "stable-a",
  });
  ports.push(stableA.port);
  let nightly = await launchNightly({
    binary,
    main: mains.nightly,
    stable: stableA,
    work: join(work, "a"),
    pickFolder,
  });
  let page: Page | undefined;
  let threadId = "";
  const providerInstanceId = randomUUID();
  const steps: Array<readonly [string, () => Promise<string | void>]> = [
    [
      "1. Renderer loads with the Nightly label",
      async () => {
        page = await settledWindow(nightly);
        const client = await nightly.events.next((event) => event.event === "client", 0, 30_000);
        if (client.result !== "started") throw new Error(`The client reported ${client.result}.`);
        return "Octant Nightly label rendered";
      },
    ],
    [
      "2. API key added through native main; a thread's turn completes against a local endpoint",
      async () => {
        if (page === undefined) throw new Error("No window.");
        threadId = await createFixtureThread(page, {
          providerInstanceId,
          baseUrl: providerFixture.baseUrl,
          title: "Nightly smoke",
        });
        const view = await hostRequest(page, `/api/chat/threads/${threadId}`);
        const version = record(record(view.body).thread).version;
        const turn = await hostRequest(page, "/api/chat/commands", {
          kind: "send-chat-turn",
          threadId,
          expectedVersion: version,
          prompt: "Prove the Nightly client.",
          attachmentIds: [],
        });
        if (record(turn.body).kind !== "turn-created")
          throw new Error(`Turn: ${JSON.stringify(turn)}`);
        let last = "";
        const text = await waitFor("The fixture answer", 30_000, async () => {
          if (page === undefined) return undefined;
          const current = await hostRequest(page, `/api/chat/threads/${threadId}`);
          last = JSON.stringify(current.body);
          // The answer is stored as content references; the attempt's
          // outcome says it streamed to the end.
          return last.includes('"outcome":"completed"') ? "completed" : undefined;
        }).catch((error: unknown) => {
          throw new Error(`${String(error)} Last thread view: ${last.slice(-1_500)}`);
        });
        if (!providerFixture.bearers.includes(FIXTURE_KEY))
          throw new Error("The endpoint never received the brokered key.");
        return `turn ${text}; the endpoint received the brokered key`;
      },
    ],
    [
      "3. Brokered flows: folder pick, API key list, a real Code approval prepared, shown and cancelled",
      async () => {
        if (page === undefined) throw new Error("No window.");
        const current = page;
        const mark = nightly.events.mark();
        const picked = record(
          await current.evaluate(() =>
            (
              window as unknown as {
                octantHost: { selectProjectRoot: (type: "code") => Promise<unknown> };
              }
            ).octantHost.selectProjectRoot("code"),
          ),
        );
        if (picked.kind !== "selected") throw new Error(`Pick: ${JSON.stringify(picked)}`);
        await nightly.events.next((event) => event.event === "open-dialog", mark, 5_000);
        const keys = await current.evaluate(
          (instance) =>
            (
              window as unknown as {
                octantHost: {
                  listProviderApiKeys: (id: string) => Promise<ReadonlyArray<unknown>>;
                };
              }
            ).octantHost.listProviderApiKeys(instance),
          providerInstanceId,
        );
        if (!JSON.stringify(keys).includes("Smoke key"))
          throw new Error(`Keys: ${JSON.stringify(keys)}`);
        // A real Code thread: a Code Project on the picked Git repository,
        // held by this window, with a prepared checkout.
        const shell = record((await hostRequest(current, "/api/shell/bootstrap")).body);
        const workspace = record(shell.workspace);
        const hostId = record(record(workspace.contextByMode).chat).host;
        const projectId = randomUUID();
        const project = await hostRequest(current, "/api/projects/commands", {
          kind: "create-code-project",
          projectId,
          expectedVersion: 0,
          name: "Nightly smoke code",
          receiptId: picked.receiptId,
          hostId,
        });
        if (project.status !== 200) throw new Error(`Code Project: ${JSON.stringify(project)}`);
        const held = await hostRequest(current, "/api/shell/commands", {
          kind: "apply-workspace-operation",
          windowId: workspace.windowId,
          expectedVersion: shell.workspaceVersion,
          operation: {
            kind: "switch-project-surface",
            mode: "code",
            surface: { kind: "project", id: randomUUID(), projectId, mode: "code", title: "Smoke" },
          },
        });
        if (held.status !== 200) throw new Error(`Open Code Project: ${JSON.stringify(held)}`);
        const prepared = await waitFor("A prepared checkout", 20_000, async () => {
          const answer = await hostRequest(current, "/api/code/commands", {
            kind: "prepare-code-project-checkout",
            projectId,
          });
          const body = answer.status === 200 ? record(answer.body) : undefined;
          return body !== undefined && record(body.checkout).availability === "available"
            ? body
            : undefined;
        });
        const checkout = record(prepared.checkout);
        const threadId = randomUUID();
        const now = new Date().toISOString();
        const thread = await hostRequest(current, "/api/code/commands", {
          kind: "create-code-thread",
          thread: {
            id: threadId,
            projectId,
            bindingRevisionId: prepared.bindingRevisionId,
            repositoryId: checkout.repositoryId,
            checkoutId: checkout.id,
            title: "Nightly smoke approval",
            lifecycle: "active",
            providerInstanceId,
            modelId: FIXTURE_MODEL_ID,
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
        });
        if (record(thread.body).kind !== "thread-created")
          throw new Error(`Code thread: ${JSON.stringify(thread)}`);
        // Ask for the real elevation; the native view, not the renderer,
        // would confirm it.
        const approvalMark = nightly.events.mark();
        await current.evaluate((id) => {
          const host = (
            window as unknown as {
              octantHost: { requestCodeOperationApproval: (request: unknown) => Promise<unknown> };
            }
          ).octantHost;
          (window as unknown as { smokeApproval: Promise<unknown> }).smokeApproval = host
            .requestCodeOperationApproval({
              effect: {
                kind: "change-thread-full-access",
                threadId: id,
                expectedVersion: 1,
                permissionPersistence: "current-session",
              },
            })
            .then(
              (value) => ({ settled: "resolved", value: value ?? null }),
              (error: unknown) => ({ settled: "rejected", value: String(error) }),
            );
        }, threadId);
        const challenge = await nightly.events.next(
          (event) => event.event === "approval-route" && event.route === "challenges",
          approvalMark,
          15_000,
        );
        if (challenge.status !== 201 || typeof challenge.challengeId !== "string")
          throw new Error(`The host did not prepare a challenge: ${JSON.stringify(challenge)}`);
        if (challenge.nativeMain !== true || challenge.bridgeSecret !== false)
          throw new Error(
            `The prepare was not native-main admission: ${JSON.stringify(challenge)}`,
          );
        // The owner-only native view is attached to this window and shows
        // the host's prompt.
        const shown = await waitFor("The approval view to show its prompt", 15_000, async () => {
          const texts = await nightly.app.evaluate(async ({ BrowserWindow }) =>
            Promise.all(
              BrowserWindow.getAllWindows().flatMap((window) =>
                window.contentView.children.map((child) =>
                  "webContents" in child
                    ? (child as Electron.WebContentsView).webContents
                        .executeJavaScript("document.body ? document.body.innerText : ''")
                        .catch(() => "")
                    : Promise.resolve(""),
                ),
              ),
            ),
          );
          return texts.find((text) => String(text).includes("Elevate this Code thread"));
        });
        await current.evaluate(() =>
          (
            window as unknown as {
              octantHost: { cancelCodeOperationApproval: () => Promise<void> };
            }
          ).octantHost.cancelCodeOperationApproval(),
        );
        const settled = record(
          await current.evaluate(
            () => (window as unknown as { smokeApproval: Promise<unknown> }).smokeApproval,
          ),
        );
        if (settled.settled !== "resolved" || settled.value !== null)
          throw new Error(`The cancelled approval answered ${JSON.stringify(settled)}.`);
        const cancelled = await nightly.events.next(
          (event) => event.event === "approval-route" && event.route === "cancellations",
          approvalMark,
          10_000,
        );
        if (
          cancelled.status !== 204 ||
          cancelled.challengeId !== challenge.challengeId ||
          cancelled.nativeMain !== true ||
          cancelled.bridgeSecret !== false
        )
          throw new Error(`The host did not cancel the challenge: ${JSON.stringify(cancelled)}`);
        const probe = await nightly.events.next(
          (event) => event.event === "approval-probe",
          approvalMark,
          10_000,
        );
        if (probe.status !== 403)
          throw new Error(
            `The cancelled challenge could still be confirmed (${String(probe.status)}).`,
          );
        const confirmations = nightly.events.count(
          (event) => event.event === "approval-route" && event.route === "confirmations",
          approvalMark,
        );
        if (confirmations !== 0) throw new Error("The approval view confirmed the challenge.");
        await waitFor("The approval view to close", 10_000, async () =>
          (await nightly.app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().reduce(
              (count, window) => count + window.contentView.children.length,
              0,
            ),
          )) === 0
            ? true
            : undefined,
        );
        return `folder receipt; 1 key listed; challenge prepared (201, native-main) and shown ("${
          String(shown)
            .split("\n")
            .find((line) => line.includes("Elevate")) ?? ""
        }"); cancelled (204), confirm afterwards refused (403), no view confirmation`;
      },
    ],
    [
      "4. Embedded Browser: a local page opens, frames arrive, typing and a select popup round-trip",
      async () => {
        if (page === undefined) throw new Error("No window.");
        const current = page;
        const picked = record(
          await current.evaluate(() =>
            (
              window as unknown as {
                octantHost: { selectProjectRoot: (type: "work") => Promise<unknown> };
              }
            ).octantHost.selectProjectRoot("work"),
          ),
        );
        const shell = record((await hostRequest(current, "/api/shell/bootstrap")).body);
        const workspace = record(shell.workspace);
        const hostId = record(record(workspace.contextByMode).chat).host;
        const projectId = randomUUID();
        const created = await hostRequest(current, "/api/projects/commands", {
          kind: "create-work-project",
          projectId,
          expectedVersion: 0,
          name: "Nightly smoke",
          receiptId: picked.receiptId,
          hostId,
        });
        if (created.status !== 200) throw new Error(`Project: ${JSON.stringify(created)}`);
        // The window holds the Project the way the renderer's Project switch does.
        const switched = await hostRequest(current, "/api/shell/commands", {
          kind: "apply-workspace-operation",
          windowId: workspace.windowId,
          expectedVersion: shell.workspaceVersion,
          operation: {
            kind: "switch-project-surface",
            mode: "work",
            surface: {
              kind: "project",
              id: randomUUID(),
              projectId,
              mode: "work",
              title: "Nightly smoke",
            },
          },
        });
        if (switched.status !== 200) throw new Error(`Switch: ${JSON.stringify(switched)}`);
        const opened = record(
          (
            await hostRequest(current, "/api/browser/project-contexts", {
              kind: "open",
              projectId,
              url: pageFixture.url,
            })
          ).body,
        );
        if (opened.kind !== "project-browser") throw new Error(`Open: ${JSON.stringify(opened)}`);
        const view = record(opened.browser);
        const contextId = String(record(view.context).contextId);
        const threadId = String(view.subjectId);
        const present = (request: Record<string, unknown>) =>
          current.evaluate(
            (value) =>
              (
                window as unknown as {
                  octantHost: { presentBrowser: (request: unknown) => Promise<unknown> };
                }
              ).octantHost.presentBrowser(value),
            { contextId, threadId, ...request },
          );
        const attached = record(await present({ kind: "attach" }));
        if (attached.status !== "attached") throw new Error(`Attach: ${JSON.stringify(attached)}`);
        const presentationId = attached.presentationId;
        const layout = record(
          await present({
            kind: "layout",
            presentationId,
            layout: { width: 800, height: 600, visible: true },
          }),
        );
        if (layout.status === "refused") throw new Error("The layout was refused.");
        let sequence = 0;
        let frames = 0;
        const nextFrame = async () => {
          const frame = await waitFor("A Browser frame", 15_000, async () => {
            const answer = record(
              await present({ kind: "frame", presentationId, acknowledgement: sequence }),
            );
            return answer.status === "frame" ? answer : undefined;
          });
          sequence = Number(frame.sequence);
          frames += 1;
          return frame;
        };
        const firstFrame = await nextFrame();
        if (!String(firstFrame.dataUrl).startsWith("data:image/jpeg;base64,"))
          throw new Error("The frame is not an image.");
        const input = async (value: Record<string, unknown>) => {
          const answer = record(
            await present({ kind: "input", presentationId, input: value, frameSequence: sequence }),
          );
          if (answer.status === "refused") {
            const trace = stableA.events
              .matching(
                (event) =>
                  event.id === presentationId &&
                  (event.event === "presentation-layout" ||
                    event.type === "mouseDown" ||
                    event.type === "mouseUp"),
              )
              .slice(-10)
              .map(({ id: _id, ...event }) => event);
            throw new Error(
              `Input refused: ${JSON.stringify(value)} Trace: ${JSON.stringify(trace)}`,
            );
          }
        };
        const click = async (x: number, y: number) => {
          await input({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
          await input({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
        };
        // The page reports its own state to the fixture server on each change.
        const reported = (needle: string) =>
          pageFixture.reports.some((report) => report.includes(needle)) ? true : undefined;
        const lastReport = () => JSON.stringify(pageFixture.reports.at(-1) ?? "");
        await click(120, 40);
        await nextFrame();
        // As the renderer sends a key: down, its character, then up.
        for (const character of "nightly") {
          await input({ type: "keyDown", keyCode: character });
          await input({ type: "char", keyCode: character });
          await input({ type: "keyUp", keyCode: character });
        }
        await waitFor("The typed text in the page", 15_000, () => reported("field=nightly")).catch(
          (error: unknown) => {
            throw new Error(`${String(error)} Last page report: ${lastReport()}`);
          },
        );
        const arrowEvents: Array<string> = [];
        for (const keyCode of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
          await input({ type: "keyDown", keyCode });
          await input({ type: "keyUp", keyCode });
          arrowEvents.push(`down:${keyCode}`, `up:${keyCode}`);
        }
        await waitFor("Native directional presses and releases", 15_000, () =>
          reported(`arrows=${arrowEvents.join(",")}`),
        );
        const menuMark = nightly.events.mark();
        await nextFrame();
        // Hold the physical release until AppKit's menu has actually opened:
        // this is the schedule that intermittently failed the ordinary click.
        await input({ type: "mouseDown", x: 120, y: 120, button: "left", clickCount: 1 });
        const menu = await nightly.events.next((event) => event.event === "menu", menuMark, 15_000);
        await input({ type: "mouseUp", x: 120, y: 120, button: "left", clickCount: 1 });
        if (!JSON.stringify(menu.labels).includes("Third"))
          throw new Error(`The select menu offered ${JSON.stringify(menu.labels)}.`);
        await waitFor("The chosen option in the page", 15_000, () =>
          reported("choice=Third"),
        ).catch((error: unknown) => {
          throw new Error(`${String(error)} Last page report: ${lastReport()}`);
        });
        await nextFrame();
        await input({ type: "keyDown", keyCode: "ArrowDown" });
        await present({ kind: "detach", presentationId });
        arrowEvents.push("down:ArrowDown", "up:ArrowDown");
        await waitFor("Native held-arrow release on detach", 15_000, () =>
          reported(`arrows=${arrowEvents.join(",")}`),
        );
        return `${frames} frames; typed text, native directional presses/releases, detach release and select choice reached the page`;
      },
    ],
    [
      "5. Lease loss destroys the renderer and recovery registers a fresh window",
      async () => {
        if (page === undefined) throw new Error("No window.");
        const lost = page;
        const before = await capabilityOf(lost);
        const mark = nightly.events.mark();
        // What Stable's native binding reports when the peer's incarnation
        // exits: Stable revokes the host lease, so the next renewal expires.
        stableA.command("drop-peers");
        await waitFor("The stale renderer to close", 30_000, () =>
          lost.isClosed() ? true : undefined,
        );
        page = await settledWindow(nightly);
        const after = await capabilityOf(page);
        if (after === before) throw new Error("Recovery reused the lost window's capability.");
        const registered = nightly.events.count(
          (event) => event.event === "native" && event.operation === "register",
          mark,
        );
        if (registered < 1) throw new Error("Recovery did not register a new native window.");
        return `old renderer closed; ${registered} fresh registration(s); new capability`;
      },
    ],
    [
      "6. Host restart, then Nightly reconnects on the same data",
      async () => {
        if (page === undefined) throw new Error("No window.");
        const previous = page;
        const before = await capabilityOf(previous);
        const mark = stableA.events.mark();
        stableA.command("restart-host");
        const restarted = await stableA.events.next(
          (event) => event.event === "host-restarted" || event.event === "command-failed",
          mark,
          60_000,
        );
        if (restarted.event !== "host-restarted") throw new Error(JSON.stringify(restarted));
        await waitFor("The old host's renderer to close", 45_000, () =>
          previous.isClosed() ? true : undefined,
        );
        page = await settledWindow(nightly);
        if ((await capabilityOf(page)) === before)
          throw new Error("The reconnected window kept the old capability.");
        const thread = await hostRequest(page, `/api/chat/threads/${threadId}`);
        if (thread.status !== 200) throw new Error(`The earlier thread answered ${thread.status}.`);
        return "new host instance; fresh window; earlier thread still readable";
      },
    ],
    [
      "7. Two hosts on separate folders and ports never see each other's data",
      async () => {
        if (page === undefined) throw new Error("No window.");
        const stableB = await startStable({
          binary,
          main: mains.stable,
          work: join(work, "b"),
          name: "stable-b",
        });
        ports.push(stableB.port);
        const nightlyB = await launchNightly({
          binary,
          main: mains.nightly,
          stable: stableB,
          work: join(work, "b"),
          pickFolder,
        });
        const pageB = await settledWindow(nightlyB);
        const seenInB = await hostRequest(pageB, `/api/chat/threads/${threadId}`);
        if (seenInB.status === 200) throw new Error("Host B answered host A's thread.");
        // The same provider ID is new to host B: A's providers are not there.
        const threadB = await createFixtureThread(pageB, {
          providerInstanceId,
          baseUrl: providerFixture.baseUrl,
          title: "Nightly smoke B",
        });
        const seenInA = await hostRequest(page, `/api/chat/threads/${threadB}`);
        if (seenInA.status === 200) throw new Error("Host A answered host B's thread.");
        await within("Closing Nightly B", 20_000, () => nightlyB.app.close());
        await stopStable(stableB);
        if (await listening(stableB.port)) throw new Error("Host B kept listening.");
        return `ports ${stableA.port} and ${stableB.port}; each refused the other's thread`;
      },
    ],
    [
      "8. Quit-one keeps the host; quit-last runs Stable's guarded shutdown",
      async () => {
        let mark = stableA.events.mark();
        await within("Quitting Nightly", 20_000, () => nightly.app.close());
        await stableA.events.next(
          (event) => event.event === "leases" && event.count === 0,
          mark,
          20_000,
        );
        if (!(await listening(stableA.port))) throw new Error("Quit-one stopped the host.");
        mark = stableA.events.mark();
        nightly = await launchNightly({
          binary,
          main: mains.nightly,
          stable: stableA,
          work: join(work, "a"),
          pickFolder,
        });
        page = await settledWindow(nightly);
        await stableA.events.next(
          (event) => event.event === "leases" && event.count === 1,
          mark,
          20_000,
        );
        mark = stableA.events.mark();
        stableA.command("ui-quit");
        const quit = await stableA.events.next((event) => event.event === "ui-quit", mark, 20_000);
        if (quit.result !== "retained")
          throw new Error(`Stable's UI quit answered ${quit.result}.`);
        if (!(await listening(stableA.port))) throw new Error("The retained host stopped early.");
        mark = stableA.events.mark();
        await within("Quitting the last Nightly", 20_000, () => nightly.app.close());
        await stableA.events.next((event) => event.event === "last-client-quit", mark, 20_000);
        await stableA.events.next((event) => event.event === "host-stopped", mark, 20_000);
        if (await listening(stableA.port)) throw new Error("The host outlived its last client.");
        return "host stayed after quit-one; retained, then stopped after the last client";
      },
    ],
  ];
  for (const [name, run] of steps) {
    if (rows.some((row) => row.status === "fail")) {
      rows.push({ scenario: name, status: "not run", detail: "an earlier scenario failed" });
      continue;
    }
    await scenario(name, run);
  }
  exitCode = rows.every((row) => row.status === "pass") ? 0 : 1;
} catch (error) {
  rows.push({
    scenario: "harness",
    status: "fail",
    detail: error instanceof Error ? error.message : String(error),
  });
} finally {
  await finish();
}
process.exit(exitCode);

function finish(): Promise<void> {
  finishing ??= (async () => {
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => undefined);
    for (const server of servers) await closeServer(server);
    for (const harness of stables)
      for (const pid of hostPids(harness)) track(pid, "development host");
    const survivors = await waitFor("Every started process to exit", 20_000, () =>
      [...startedPids.keys()].every((pid) => !alive(pid)) ? [] : undefined,
    ).catch(() => [...startedPids.entries()].filter(([pid]) => alive(pid)));
    const openPorts: Array<number> = [];
    for (const port of ports) if (await listening(port)) openPorts.push(port);
    await rm(work, { recursive: true, force: true });
    for (const row of rows)
      console.log(
        `${row.status.padEnd(7)} ${String(row.ms ?? "-").padStart(6)}ms  ${row.scenario}${
          row.detail === undefined ? "" : ` — ${row.detail.slice(0, 2_000)}`
        }`,
      );
    console.log(
      JSON.stringify({
        processes: [...startedPids.entries()].map(([pid, purpose]) => ({ pid, purpose })),
        survivors,
        openPorts,
      }),
    );
    if (survivors.length > 0 || openPorts.length > 0) exitCode = 1;
  })();
  return finishing;
}
