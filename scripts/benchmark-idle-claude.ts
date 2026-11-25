import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { arch, cpus, loadavg, release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createCodeProject,
  isRecord,
  registerWindowAuthority,
} from "./packaged-smoke-code-project";

// What many idle Claude threads cost the host. The built host runs with a HOME
// and data folder of its own and the real Claude driver and Agent SDK; the
// `claude` program is a stand-in that speaks the SDK's stream-json protocol, so
// no account is read, nothing leaves the machine and no provider turn is spent.
// Each phase settles past every idle grace the host has, then reads the CPU
// seconds `ps` reports for the host and for every stand-in over the window:
//
//   empty       the host with no thread
//   idle        THREADS threads, each having finished one turn
//   background  LIVE of those threads whose turn left a background command running
//
// The stand-in idles in `read`, so its own CPU says nothing about Claude Code's;
// how many of them are alive is the figure that decides what idle threads cost.
// No window is subscribed, and `ps` time leaves out the host's own children
// (git, for example): this is the host's idle cost, not the whole app's.
const threads = Number(process.argv[2] ?? "40");
const seconds = Number(process.argv[3] ?? "60");
const dist = resolve(process.argv[4] ?? "apps/server/dist");
const node = execFileSync(process.argv[5] ?? "node", ["-p", "process.execPath"], {
  encoding: "utf8",
}).trim();
const SETTLE_MS = 40_000;
const LIVE = Math.min(10, threads);
if (!Number.isInteger(threads) || threads < 1 || threads > 200 || !(seconds >= 1)) {
  throw new Error(
    "Usage: bun scripts/benchmark-idle-claude.ts [threads 1-200] [seconds] [dist] [node]",
  );
}

// Stopped by a signal or after this long, the run still stops its host and
// stand-ins and removes its folder.
const MAX_RUN_MS = 30 * 60_000;
const controller = new AbortController();
const stop = () => controller.abort();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
const lifetime = setTimeout(stop, MAX_RUN_MS);
const root = await realpath(await mkdtemp(join(tmpdir(), "octant-idle-claude.")));
const launches = join(root, "launches.log");
const claude = join(root, "bin", "claude");
const home = join(root, "home");
const repository = join(root, "repository");
const secret = randomBytes(32).toString("base64url");
const modelId = "claude-sonnet-5-5";

try {
  await mkdir(join(root, "bin"));
  await mkdir(home);
  await mkdir(repository);
  await writeFile(launches, "");
  await writeFile(join(root, "stand-in.js"), standIn(launches));
  // Compiled, as the real program is: the host's confined probe may run the
  // program itself but not an interpreter found elsewhere on the machine.
  execFileSync(process.execPath, [
    "build",
    "--compile",
    join(root, "stand-in.js"),
    "--outfile",
    claude,
  ]);
  // macOS scans a new program at its first launch, for longer than the host's probe waits.
  execFileSync(claude, ["--version"]);
  const git = (...args: string[]) =>
    execFileSync("/usr/bin/git", args, {
      cwd: repository,
      env: { HOME: home, PATH: "/usr/bin:/bin" },
    });
  git("init", "--quiet", "--initial-branch=main");
  await writeFile(join(repository, "README.md"), "Idle fixture\n");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "Start",
  );

  const port = await freePort();
  const host = spawn(node, [join(dist, "main.mjs")], {
    env: {
      HOME: home,
      TMPDIR: root,
      PATH: `${join(root, "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`,
      OCTANT_DATA_DIR: join(root, "data"),
      OCTANT_SERVER_PORT: String(port),
      OCTANT_DESKTOP_BRIDGE_SECRET: secret,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  host.stderr.on("data", (chunk: Buffer) => {
    errors = (errors + chunk.toString("utf8")).slice(-4_000);
  });
  const exited = new Promise<void>((done) => host.once("close", () => done()));
  try {
    const serverUrl = `http://127.0.0.1:${port}`;
    await until("the host to become ready", async () => {
      if (host.exitCode !== null) throw new Error(`The host exited.\n${errors}`);
      const body: unknown = await fetch(`${serverUrl}/health`)
        .then((response) => response.json())
        .catch(() => undefined);
      return isRecord(body) && body.storage === "ready";
    });
    const pid = host.pid;
    if (pid === undefined) throw new Error("The host has no process id.");
    console.log(
      JSON.stringify({
        machine: {
          uname: release(),
          cpu: cpus()[0]?.model,
          logicalCpus: cpus().length,
          arch: arch(),
        },
        node: execFileSync(node, ["--version"], { encoding: "utf8" }).trim(),
        threads,
        seconds,
      }),
    );

    await delay(SETTLE_MS, undefined, { signal: controller.signal });
    report("empty", await sample(pid));

    const window = await registerWindowAuthority(serverUrl, secret);
    const providerInstanceId = randomUUID();
    await window.send(
      "/api/providers/commands",
      {
        kind: "create-claude-provider",
        instanceId: providerInstanceId,
        expectedVersion: 0,
        displayName: "Stand-in",
        configuration: {
          kind: "claude-agent-sdk",
          binaryPath: claude,
          authentication: "subscription",
        },
      },
      "create the provider",
    );
    await until("the account check", async () => {
      const probed = await window.send(
        "/api/providers/commands",
        { kind: "probe-provider", instanceId: providerInstanceId },
        "check the account",
      );
      return isRecord(probed) && isRecord(probed.result) && probed.result.readiness === "ready";
    });
    const project = await createCodeProject({
      serverUrl,
      desktopBridgeSecret: secret,
      window,
      repository,
      name: "Idle",
    });
    const open: Array<{ readonly threadId: string; readonly sessionId: string }> = [];
    const turn = async (
      thread: { readonly threadId: string; readonly sessionId: string },
      prompt: string,
    ) => {
      const stored = await fetch(`${serverUrl}/api/code/evidence`, {
        method: "PUT",
        headers: {
          ...window.headers,
          "content-type": "text/plain; charset=utf-8",
          "x-octant-code-thread-id": thread.threadId,
        },
        body: prompt,
      });
      if (!stored.ok) throw new Error(`The prompt was not stored (${await stored.text()}).`);
      const operationId = randomUUID();
      const started = await window.send(
        "/api/code/commands",
        {
          kind: "start-provider-turn",
          operationId,
          threadId: thread.threadId,
          checkoutId: project.checkoutId,
          sessionId: thread.sessionId,
          prompt: await stored.json(),
        },
        "start a turn",
      );
      if (!isRecord(started) || started.kind !== "provider-turn-state") {
        throw new Error(`The turn did not start: ${JSON.stringify(started)}`);
      }
      await until(`a turn of ${thread.threadId}`, async () => {
        const read = await fetch(
          `${serverUrl}/api/code/threads/${thread.threadId}/conversation?afterCursor=0&limit=50`,
          { headers: window.headers },
        );
        const page: unknown = await read.json();
        const turns = isRecord(page) && Array.isArray(page.turns) ? page.turns : [];
        const last: unknown = turns.at(-1);
        if (!isRecord(last) || last.operationId !== operationId) return false;
        if (last.status === "failed") throw new Error(`The turn failed: ${JSON.stringify(last)}`);
        return last.status === "completed";
      });
    };
    for (let index = 0; index < threads; index += 1) {
      const threadId = randomUUID();
      const now = new Date().toISOString();
      await window.send(
        "/api/code/commands",
        {
          kind: "create-code-thread",
          thread: {
            id: threadId,
            projectId: project.projectId,
            bindingRevisionId: project.bindingRevisionId,
            repositoryId: project.repositoryId,
            checkoutId: project.checkoutId,
            title: `Idle ${String(index + 1)}`,
            lifecycle: "active",
            providerInstanceId,
            modelId,
            executionPolicy: "approval-gated",
            permissionPersistence: "current-session",
            deliveryTarget: {
              branchIntent: "main",
              remoteName: "origin",
              proposedBaseRepository: "local/fixture",
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
      const thread = { threadId, sessionId: randomUUID() };
      open.push(thread);
      await turn(thread, "Say hello.");
    }
    await delay(SETTLE_MS, undefined, { signal: controller.signal });
    report("idle", await sample(pid));

    const before = (await readFile(launches, "utf8")).trim().split("\n").length;
    const first = open[0];
    if (first === undefined) throw new Error("No thread was opened.");
    await turn(first, "Carry on.");
    const resumed = (await readFile(launches, "utf8")).trim().split("\n").slice(before);
    console.log(
      JSON.stringify({
        resume: {
          launches: resumed.length,
          resumedStoredSession:
            resumed.length > 0 && resumed.every((line) => line.includes("--resume")),
        },
      }),
    );

    for (const thread of open.slice(0, LIVE)) await turn(thread, "BACKGROUND");
    await delay(SETTLE_MS, undefined, { signal: controller.signal });
    report(`background (${String(LIVE)} threads)`, await sample(pid));
  } finally {
    const forceStop = setTimeout(() => host.kill("SIGKILL"), 10_000);
    host.kill("SIGTERM");
    await exited;
    clearTimeout(forceStop);
  }
  console.log(JSON.stringify({ standInsLeft: standIns().length }));
} finally {
  for (const { pid } of standIns()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // It exited between the listing and the kill.
    }
  }
  await rm(root, { recursive: true, force: true });
  clearTimeout(lifetime);
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}

interface Reading {
  readonly hostCpuPercent: number;
  readonly standIns: number;
  readonly standInCpuPercent: number;
  readonly hostRssMiB: number;
}

async function sample(pid: number): Promise<Reading> {
  const started = performance.now();
  const hostBefore = cpuSeconds(pid) ?? 0;
  const standInsBefore = new Map(standIns().map(({ pid: id }) => [id, cpuSeconds(id)]));
  await delay(seconds * 1_000, undefined, { signal: controller.signal });
  const elapsed = (performance.now() - started) / 1_000;
  // Only stand-ins alive across the whole window, each against its own start.
  let standInCpu = 0;
  for (const [id, before] of standInsBefore) {
    const after = cpuSeconds(id);
    if (before !== undefined && after !== undefined) standInCpu += after - before;
  }
  return {
    hostCpuPercent: percent((cpuSeconds(pid) ?? hostBefore) - hostBefore, elapsed),
    standIns: standIns().length,
    standInCpuPercent: percent(standInCpu, elapsed),
    hostRssMiB: Math.round(Number(ps("rss=", pid) ?? 0) / 1024),
  };
}

function report(phase: string, reading: Reading): void {
  console.log(JSON.stringify({ phase, ...reading, loadAverage: loadavg()[0] }));
}

function percent(cpu: number, elapsed: number): number {
  return Math.round((cpu / elapsed) * 100_000) / 1_000;
}

function ps(field: string, pid: number): string | undefined {
  try {
    return execFileSync("/bin/ps", ["-o", field, "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

/** User and system time, which `ps` prints as `[hours:]minutes:seconds.hundredths`; undefined once it exited. */
function cpuSeconds(pid: number): number | undefined {
  return ps("time=", pid)
    ?.split(":")
    .reduce((total, part) => total * 60 + Number(part), 0);
}

/** Every live stand-in, found by this run's own program path. */
function standIns(): ReadonlyArray<{ readonly pid: number }> {
  return execFileSync("/bin/ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
    maxBuffer: 1 << 26,
  })
    .split("\n")
    .filter((line) => line.includes(`${claude} `) || line.endsWith(claude))
    .map((line) => ({ pid: Number(line.trim().split(/\s+/)[0]) }));
}

async function until(what: string, ready: () => Promise<boolean>): Promise<void> {
  const deadline = performance.now() + 60_000;
  while (!(await ready())) {
    controller.signal.throwIfAborted();
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await delay(100);
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  await new Promise<void>((done) => server.close(() => done()));
  if (address === null || typeof address === "string") throw new Error("No free port.");
  return address.port;
}

/** A `claude` that answers the host's probes and one reply per message, then waits for input. */
function standIn(launchLog: string): string {
  return `const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.300 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" })); process.exit(0); }
// The host's account probe is confined and may write nothing; only a session's launch is logged.
try { require("node:fs").appendFileSync(${JSON.stringify(launchLog)}, JSON.stringify(args) + "\\n"); } catch {}
const value = (name) => { const at = args.indexOf(name); return at < 0 ? args.find((arg) => arg.startsWith(name + "="))?.slice(name.length + 1) : args[at + 1]; };
const session = value("--resume") ?? value("--session-id") ?? require("node:crypto").randomUUID();
const uuid = () => require("node:crypto").randomUUID();
const send = (message) => process.stdout.write(JSON.stringify({ session_id: session, uuid: uuid(), ...message }) + "\\n");
const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
let initialized = false;
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    const response = message.request.subtype === "initialize"
      ? { commands: [], agents: [], output_style: "default", available_output_styles: ["default"], account: {},
          models: [{ value: ${JSON.stringify(modelId)}, displayName: "Stand-in", description: "Stand-in" }] }
      : message.request.subtype === "mcp_set_servers"
      ? { added: Object.keys(message.request.servers), removed: [], errors: {} }
      : {};
    process.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response } }) + "\\n");
    return;
  }
  if (message.type !== "user") return;
  const text = JSON.stringify(message.message.content);
  send({ type: "system", subtype: "session_state_changed", state: "running" });
  if (!initialized) {
    initialized = true;
    send({ type: "system", subtype: "init", cwd: process.cwd(), model: value("--model"), permissionMode: value("--permission-mode") ?? "default",
      tools: [], mcp_servers: [], slash_commands: [], output_style: "default", claude_code_version: "2.1.300", apiKeySource: "none", agents: [], skills: [], plugins: [] });
  }
  // The host looks a session up in Claude's own store before it resumes it.
  const fs = require("node:fs"), path = require("node:path");
  const store = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(process.env.HOME, ".claude"), "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));
  fs.mkdirSync(store, { recursive: true });
  fs.appendFileSync(path.join(store, session + ".jsonl"), JSON.stringify({ type: "user", uuid: uuid(), parentUuid: null, isSidechain: false, sessionId: session, cwd: process.cwd(),
    version: "2.1.300", timestamp: new Date().toISOString(), message: { role: "user", content: "Say hello." } }) + "\\n");
  if (text.includes("BACKGROUND")) send({ type: "system", subtype: "task_started", task_id: "task-" + session.slice(0, 8), task_type: "local_bash", description: "Dev server" });
  send({ type: "assistant", parent_tool_use_id: null, message: { id: "msg_" + uuid(), type: "message", role: "assistant", model: value("--model"),
    content: [{ type: "text", text: "Hello." }], stop_reason: "end_turn", stop_sequence: null, usage } });
  send({ type: "result", subtype: "success", is_error: false, result: "Hello.", duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0,
    stop_reason: "end_turn", usage, modelUsage: {}, permission_denials: [] });
  send({ type: "system", subtype: "session_state_changed", state: "idle" });
});
`;
}
