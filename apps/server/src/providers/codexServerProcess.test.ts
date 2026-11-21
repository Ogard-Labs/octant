import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Scope } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { decodeWindowId, type CodeThread } from "@octant/contracts";
import type { ServerProject } from "@octant/contracts/server-projects";
import type { ProviderServerPlacement } from "@octant/provider-sdk/driver";
import { ServerConnection } from "../serverProjects/serverConnection";
import {
  bindServerCodeTurn,
  SERVER_PLACEMENT_STRICT_REFUSAL,
  serverCodeCheckout,
} from "../serverProjects/serverProjectThreads";
import { ServerRuntimeRecords } from "../serverProjects/serverRuntimeRecords";
import {
  makeCodexProcessLive,
  SERVER_FULL_ACCESS_SANDBOX_REFUSAL,
  SERVER_STRICT_REFUSAL,
} from "./codexProcess";
import { codexServerSignInRefusal } from "./codexServerProcess";

const scratches: string[] = [];
/**
 * Programs a test left running on purpose, stopped when it ends, each only
 * while its PID still has the start identity recorded for it, so a PID the
 * system has since given to another process is never signalled.
 */
const leftovers: Array<{ readonly pid: number; readonly started: string }> = [];
function startedOf(pid: number): string {
  try {
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}
function leaveRunning(pid: number): void {
  leftovers.push({ pid, started: startedOf(pid) });
}
afterEach(() => {
  for (const { pid, started } of leftovers.splice(0)) {
    if (started === "" || startedOf(pid) !== started) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  for (const scratch of scratches.splice(0)) rmSync(scratch, { recursive: true, force: true });
});

/**
 * A stand-in server: `ssh` runs the remote command in `sh` as a login whose
 * home is in the scratch folder, carrying the program's streams as real ssh
 * does, so a program it started outlives it when it is killed. A `codex` on
 * its PATH answers `--version` and `login status` (signed out while a
 * `signed-out` file exists; each read is logged), and speaks enough of the
 * app-server protocol to initialize, reporting the folder it was started in.
 * While a `hang` file exists the app-server ignores the end of its input, as
 * a program left running after its connection drops does. While an `offline`
 * file exists, `ssh` reaches nothing.
 */
function standInServer() {
  const scratch = mkdtempSync(join(tmpdir(), "octant-codex-server-"));
  scratches.push(scratch);
  const bin = join(scratch, "bin");
  const home = join(scratch, "home");
  const folder = join(home, "service");
  const marks = {
    signedOut: join(scratch, "signed-out"),
    statusReads: join(scratch, "status-reads"),
    launched: join(scratch, "launched"),
    hang: join(scratch, "hang"),
    offline: join(scratch, "offline"),
    refusedOffline: join(scratch, "refused-offline"),
  };
  mkdirSync(bin);
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(bin, "codex"),
    `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === '--version') { console.log('codex-cli 0.170.0'); process.exit(0); }
if (process.argv[2] === 'login' && process.argv[3] === 'status') {
  fs.appendFileSync(${JSON.stringify(marks.statusReads)}, 'read\\n');
  if (fs.existsSync(${JSON.stringify(marks.signedOut)})) { console.error('Not logged in'); process.exit(1); }
  console.error('Logged in using ChatGPT');
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(marks.launched)}, 'launched');
if (fs.existsSync(${JSON.stringify(marks.hang)})) setInterval(() => undefined, 1000);
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: 'cwd=' + process.cwd() + ' args=' + process.argv.slice(2).join(' ') } }) + '\\n');
  }
});`,
  );
  chmodSync(join(bin, "codex"), 0o700);
  const ssh = join(scratch, "ssh");
  writeFileSync(
    ssh,
    `#!/usr/bin/env node
const fs = require('node:fs');
if (fs.existsSync(${JSON.stringify(marks.offline)})) {
  fs.appendFileSync(${JSON.stringify(marks.refusedOffline)}, 'refused\\n');
  console.error('ssh: connect to host devbox port 22: Network is unreachable');
  process.exit(255);
}
const { spawn } = require('node:child_process');
const env = { ...process.env, HOME: ${JSON.stringify(home)}, PATH: ${JSON.stringify(bin)} + ':' + process.env.PATH };
const child = spawn('sh', ['-c', process.argv[process.argv.length - 1]], { stdio: 'pipe', env });
child.stdin.on('error', () => undefined);
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.on('close', (code) => { process.exitCode = code ?? 1; process.stdin.destroy(); });`,
  );
  chmodSync(ssh, 0o700);
  const connection = new ServerConnection({
    sshPath: ssh,
    agentSocket: () => undefined,
    controlDirectory: () => scratch,
  });
  const runtimes = new ServerRuntimeRecords({ connection, hostId: () => "stand-in-host" });
  return { connection, runtimes, folder, home, marks };
}

type StandIn = ReturnType<typeof standInServer>;

const server = { alias: "devbox", user: "build" };

function placedThread(folder: string) {
  const project = {
    id: "11111111-1111-4111-8111-111111111111" as ServerProject["id"],
    name: "Service",
    serverId: "5e7e0000-0000-4000-8000-000000000001" as ServerProject["serverId"],
    folder,
    boundAt: "2026-11-01T12:00:00.000Z" as ServerProject["boundAt"],
  };
  const derived = serverCodeCheckout(project);
  const thread = {
    id: "22222222-2222-4222-8222-222222222222",
    projectId: project.id,
    bindingRevisionId: derived.bindingRevisionId,
    repositoryId: derived.checkout.repositoryId,
    checkoutId: derived.checkout.id,
    providerInstanceId: "00000000-0000-4000-8000-0000000000ee",
    modelId: "gpt-model",
    executionPolicy: "approval-gated",
  } as unknown as CodeThread;
  return { project, thread };
}

function bind(
  connection: ServerConnection,
  folder: string,
  input: { readonly placesOnServer: boolean; readonly strict: boolean },
  runtimes = new ServerRuntimeRecords({ connection, hostId: () => "stand-in-host" }),
) {
  const { project, thread } = placedThread(folder);
  return bindServerCodeTurn(
    {
      store: {
        codeProject: (id) => (id === String(project.id) ? project : undefined),
        addressOf: () => ({ kind: "address", server, folder }),
        serverOf: () => undefined,
      },
      connection,
      composition: { forServerCode: () => undefined },
      runtimes,
      record: () => "recorded",
    },
    {
      thread,
      windowId: decodeWindowId("00000000-0000-4000-8000-000000000471"),
      secrets: [],
      ...input,
    },
  );
}

/** A turn's placement on the stand-in, sharing the host's one record of its programs. */
function placed(stand: StandIn): ProviderServerPlacement {
  const bound = bind(
    stand.connection,
    stand.folder,
    { placesOnServer: true, strict: false },
    stand.runtimes,
  );
  if (bound.status !== "placed") throw new Error(`not placed: ${bound.status}`);
  return bound.placement;
}

function startCodex(
  port: ReturnType<typeof makeCodexProcessLive>,
  placement: ProviderServerPlacement,
  folder: string,
) {
  return port.start({
    binaryPath: "/nonexistent/codex-on-this-host",
    authority: {
      kind: "thread",
      root: folder,
      mode: "code",
      executionPolicy: "approval-gated",
      strict: false,
    },
    server: placement,
  });
}

/** The names of the records the stand-in login holds. */
function recordsOn(home: string): ReadonlyArray<string> {
  const folder = join(home, ".octant", "server-runtimes");
  return existsSync(folder) ? readdirSync(folder) : [];
}

function recordPath(home: string, name: string): string {
  return join(home, ".octant", "server-runtimes", name);
}

/** Whether a process is still running: present, and not a zombie waiting to be reaped. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
  } catch {
    return true;
  }
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Starts an app-server that ignores the end of its input and waits for the
 * record its start wrote on the server. Stopping it closes its input, which
 * it ignores, so the host ends the connection and the program is left there.
 */
async function startHanging(stand: StandIn) {
  writeFileSync(stand.marks.hang, "");
  const scope = await Effect.runPromise(Scope.make());
  await Effect.runPromise(
    startCodex(makeCodexProcessLive(), placed(stand), stand.folder).pipe(
      Effect.provideService(Scope.Scope, scope),
    ),
  );
  const name = await waitFor(() => recordsOn(stand.home)[0]);
  const [pid = "", ...started] = readFileSync(recordPath(stand.home, name), "utf8")
    .trim()
    .split(" ");
  const recorded = Number(pid);
  leaveRunning(recorded);
  return {
    name,
    pid: recorded,
    started: started.join(" "),
    stop: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
}

describe.skipIf(process.platform === "win32")("Codex on a server Project's server", () => {
  it("runs Codex's app-server in the Project's folder on the server over the SSH stream", async () => {
    const { connection, folder } = standInServer();
    const bound = bind(connection, folder, { placesOnServer: true, strict: false });
    if (bound.status !== "placed") throw new Error(`not placed: ${bound.status}`);

    const started = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const codex = yield* makeCodexProcessLive().start({
            binaryPath: "/nonexistent/codex-on-this-host",
            authority: {
              kind: "thread",
              root: folder,
              mode: "code",
              executionPolicy: "approval-gated",
              strict: false,
            },
            server: bound.placement,
          });
          const agent = yield* Effect.promise(() =>
            codex.rpc.request("initialize", {}, (value) => value as { userAgent: string }),
          );
          return {
            version: codex.version,
            networkOpen: codex.networkOpen,
            agent: agent.userAgent,
          };
        }),
      ),
    );
    expect(started.version).toBe("0.170.0");
    expect(started.networkOpen).toBe(true);
    expect(started.agent).toContain(`cwd=${folder}`);
    expect(started.agent).toContain("args=app-server --listen stdio://");
  });

  it("refuses Codex on a server under Strict, before anything runs there", async () => {
    const { connection, folder } = standInServer();
    expect(bind(connection, folder, { placesOnServer: true, strict: true })).toEqual({
      status: "refused",
      message: SERVER_PLACEMENT_STRICT_REFUSAL,
    });
    const bound = bind(connection, folder, { placesOnServer: true, strict: false });
    if (bound.status !== "placed") throw new Error("not placed");
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        makeCodexProcessLive().start({
          binaryPath: "/nonexistent/codex",
          authority: {
            kind: "thread",
            root: folder,
            mode: "code",
            executionPolicy: "approval-gated",
          },
          server: bound.placement,
        }),
      ),
    );
    expect(JSON.stringify(exit)).toContain(SERVER_STRICT_REFUSAL);
  });

  it("refuses Full access with its sandbox on a server rather than running unconfined", async () => {
    const { connection, folder } = standInServer();
    const bound = bind(connection, folder, { placesOnServer: true, strict: false });
    if (bound.status !== "placed") throw new Error("not placed");
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        makeCodexProcessLive().start({
          binaryPath: "/nonexistent/codex",
          authority: {
            kind: "thread",
            root: folder,
            mode: "code",
            executionPolicy: "full-access",
            fullAccessSandbox: true,
            strict: false,
          },
          server: bound.placement,
        }),
      ),
    );
    expect(JSON.stringify(exit)).toContain(SERVER_FULL_ACCESS_SANDBOX_REFUSAL);
  });

  it("refuses a runtime that does not report server placement, with a reason", () => {
    const { connection, folder } = standInServer();
    const bound = bind(connection, folder, { placesOnServer: false, strict: false });
    expect(bound.status).toBe("refused");
    if (bound.status === "refused") expect(bound.message).toMatch(/runs on the server itself/);
  });

  it("says Codex is missing on the server rather than running anything here", async () => {
    const { connection, folder } = standInServer();
    rmSync(join(folder, "..", "..", "bin", "codex"));
    const bound = bind(connection, folder, { placesOnServer: true, strict: false });
    if (bound.status !== "placed") throw new Error("not placed");
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        makeCodexProcessLive().start({
          binaryPath: "/nonexistent/codex",
          authority: {
            kind: "thread",
            root: folder,
            mode: "code",
            executionPolicy: "approval-gated",
            strict: false,
          },
          server: bound.placement,
        }),
      ),
    );
    expect(JSON.stringify(exit)).toContain("Codex isn't installed on devbox");
  });

  it("refuses a Codex turn on a server where Codex is not signed in, naming the server", async () => {
    const stand = standInServer();
    writeFileSync(stand.marks.signedOut, "");
    const port = makeCodexProcessLive();
    const refused = await Effect.runPromise(
      Effect.flip(Effect.scoped(startCodex(port, placed(stand), stand.folder))),
    );
    expect(refused).toEqual({
      category: "unauthenticated",
      message: codexServerSignInRefusal("devbox"),
    });
    expect(refused.message).toContain("Project terminal");
    expect(existsSync(stand.marks.launched)).toBe(false);

    // A "not signed in" is not held: once the person signs in there, the next turn starts.
    rmSync(stand.marks.signedOut);
    const version = await Effect.runPromise(
      Effect.scoped(
        startCodex(port, placed(stand), stand.folder).pipe(Effect.map((codex) => codex.version)),
      ),
    );
    expect(version).toBe("0.170.0");
  });

  it("a signed-in provider starts, and its sign-in is not re-read before every turn", async () => {
    const stand = standInServer();
    const port = makeCodexProcessLive();
    for (let turn = 0; turn < 3; turn += 1) {
      const version = await Effect.runPromise(
        Effect.scoped(
          startCodex(port, placed(stand), stand.folder).pipe(Effect.map((codex) => codex.version)),
        ),
      );
      expect(version).toBe("0.170.0");
    }
    expect(readFileSync(stand.marks.statusReads, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("a program left running after a dropped connection is stopped at the next connection", async () => {
    const stand = standInServer();
    const left = await startHanging(stand);
    expect(running(left.pid)).toBe(true);

    // The connection ends without the program's own exit while the server
    // cannot be reached, so the sweep that end sets off reaches nothing.
    writeFileSync(stand.marks.offline, "");
    await left.stop();
    await waitFor(() => (existsSync(stand.marks.refusedOffline) ? true : undefined));
    expect(running(left.pid)).toBe(true);
    expect(recordsOn(stand.home)).toContain(left.name);

    // The next connection to that server stops it and removes its record.
    rmSync(stand.marks.offline);
    rmSync(stand.marks.hang);
    await Effect.runPromise(
      Effect.scoped(startCodex(makeCodexProcessLive(), placed(stand), stand.folder)),
    );
    await waitFor(() =>
      !running(left.pid) && !recordsOn(stand.home).includes(left.name) ? true : undefined,
    );
  }, 30_000);

  it("a recorded process whose PID now belongs to another program is left running", async () => {
    const stand = standInServer();
    const left = await startHanging(stand);
    // The server has since given the recorded PID to another program: the
    // record still holds the first program's start identity.
    const other = spawn("sleep", ["60"], { stdio: "ignore" });
    const otherPid = other.pid;
    if (otherPid === undefined) throw new Error("sleep did not start");
    leaveRunning(otherPid);
    // A start identity that cannot be the new program's, since two programs
    // started in the same second would share a coarse one.
    writeFileSync(recordPath(stand.home, left.name), `${otherPid} ${left.started}-earlier\n`);

    await left.stop();
    await waitFor(() => (recordsOn(stand.home).includes(left.name) ? undefined : true));
    expect(running(otherPid)).toBe(true);
  }, 30_000);
});
