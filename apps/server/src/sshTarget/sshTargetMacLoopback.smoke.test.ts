import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Exit, Schema, Scope, Stream } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveReportedHostVersion } from "@octant/host-runtime";
import { decodeProviderInstanceId } from "@octant/contracts";
import type { ProviderRemoteProcessPlacement } from "@octant/provider-sdk";
import { decodeCodeRelativePath, decodeCodeTerminalId } from "@octant/contracts/code";
import { WindowId } from "@octant/contracts/shell";
import {
  SshDestination,
  SshExecutorPath,
  SshRemotePath,
  type SshTargetStatus,
} from "@octant/contracts/ssh-target";
import { SshRemoteProjectService } from "./sshRemoteProjectService";
import { SshRemoteTerminalService } from "./sshRemoteTerminalService";
import type { ProviderRuntimeEgress } from "./providerRuntimeEgress";
import { SshTargetConnectionService } from "./sshTargetConnectionService";
import type { SshTargetStore } from "./sshTargetStore";
import { openSshTargetTestStore } from "./sshTargetStore.test-support";

/**
 * End-to-end evidence for a macOS target on this Mac: the real executor,
 * bundled as the headless artifact bundles it, confining its canaries and
 * Git reads with this Mac's own Seatbelt, behind a stand-in for the OpenSSH
 * client that records a host key when probed and otherwise starts the
 * executor here, as a login on the target would. The stand-in is the only
 * part a real second Mac adds: `sshd`, its key, and a remote user.
 *
 * It runs only on macOS. Nothing reads or changes the person's own SSH
 * setup or home: the executor runs with a temporary home and temporary
 * folder of the test's own, and the stand-in never opens a connection.
 */

const runnable = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");

const executorEntry = fileURLToPath(new URL("./executorMain.ts", import.meta.url));
const destination = Schema.decodeUnknownSync(SshDestination)("127.0.0.1");
const executorPath = Schema.decodeUnknownSync(SshExecutorPath);
const remotePath = Schema.decodeUnknownSync(SshRemotePath);
const developmentBuild = resolveReportedHostVersion({});

let root = "";
let store: SshTargetStore | undefined;
let closeStore = () => {};
let sshServer: Server | undefined;
let sshPort = 0;

function run(command: string, args: ReadonlyArray<string>): void {
  const result = spawnSync(command, [...args], { stdio: "pipe", encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr || result.error?.message || ""}`);
  }
}

function openedStore(): SshTargetStore {
  if (store === undefined) throw new Error("the store opens before the tests");
  return store;
}

function service(runtimeEgress?: ProviderRuntimeEgress): SshTargetConnectionService {
  return new SshTargetConnectionService({
    ...(runtimeEgress === undefined ? {} : { runtimeEgress }),
    store: openedStore(),
    buildVersion: developmentBuild,
    sshExecutable: join(root, "ssh"),
    environment: { PATH: "/usr/bin:/bin" },
    reconnect: { schedule: () => () => undefined },
  });
}

async function register(connections: SshTargetConnectionService): Promise<SshTargetStatus> {
  const probe = await connections.probeHostKey(destination);
  if (probe.status !== "ok") throw new Error(`probe refused: ${probe.reason}`);
  const registered = await connections.register({
    probeId: probe.value.probeId,
    fingerprint: probe.value.fingerprint,
    executorPath: executorPath(join(root, "target", "octant")),
  });
  if (registered.status !== "ok") throw new Error(`registration refused: ${registered.reason}`);
  return registered.value;
}

function reasons(status: SshTargetStatus): ReadonlyArray<readonly [string, string]> {
  return status.admission.map((entry) => [
    entry.posture,
    entry.decision.status === "admitted" ? "admitted" : entry.decision.reason,
  ]);
}

/**
 * This host's proxy for one launch, standing in: it answers every request it
 * receives and keeps each first head, so what reached it is exactly what the
 * target's forwarder let through.
 */
async function standInHostProxy(name: string) {
  const heads: string[] = [];
  const path = join(root, name);
  const server = createServer((socket) => {
    let received = "";
    let answered = false;
    socket.setEncoding("latin1");
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (answered || !received.includes("\r\n\r\n")) return;
      answered = true;
      heads.push(received);
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nhello\n");
    });
    socket.on("error", () => socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return {
    path,
    heads,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function proxyAuthorization(token: string): string {
  return `Proxy-Authorization: Basic ${Buffer.from(`octant:${token}`).toString("base64")}`;
}

/** Whether anything accepts a connection on this Mac's loopback at `port`. */
function loopbackListens(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect({ host: "127.0.0.1", port });
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

/**
 * A placed runtime standing in for an agent: it answers one JSON request per
 * line. `fetch` sends one plain request to its forwarder (the port its proxy
 * variables name) presenting its own token, none, or another.
 */
const FIXTURE_RUNTIME = `#!${process.execPath}
"use strict";
const fs = require("node:fs");
const net = require("node:net");
const lines = require("node:readline").createInterface({ input: process.stdin });
const answer = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
lines.on("line", (line) => {
  const request = JSON.parse(line);
  let settled = false;
  const done = (ok, detail) => {
    if (settled) return;
    settled = true;
    answer({ id: request.id, ok, detail });
  };
  try {
    switch (request.op) {
      case "write":
        fs.writeFileSync(request.path, "written by the runtime");
        return done(true);
      case "port":
        return done(true, new URL(process.env.HTTP_PROXY).port);
      case "connect": {
        const socket = net.connect({ host: request.host, port: request.port });
        socket.once("connect", () => { socket.destroy(); done(true); });
        socket.once("error", (error) => done(false, error.code));
        setTimeout(() => { socket.destroy(); done(false, "timeout"); }, 3000);
        return;
      }
      case "fetch": {
        const proxy = new URL(process.env.HTTP_PROXY);
        const password = request.token === "own" ? decodeURIComponent(proxy.password) : request.token;
        const socket = net.connect({ host: proxy.hostname, port: Number(proxy.port) });
        let received = "";
        socket.once("error", (error) => done(false, error.code));
        socket.on("data", (chunk) => {
          received += chunk.toString("latin1");
          if (received.includes("\\r\\n\\r\\n")) { socket.destroy(); done(true, received.split("\\r\\n")[0]); }
        });
        socket.on("close", () => done(false, received || "closed"));
        const authorization = password === null
          ? ""
          : "Proxy-Authorization: Basic " + Buffer.from("octant:" + password).toString("base64") + "\\r\\n";
        socket.write("GET http://fetch.example/ HTTP/1.1\\r\\nHost: fetch.example\\r\\n" + authorization + "\\r\\n");
        setTimeout(() => { socket.destroy(); done(false, "timeout"); }, 10000);
        return;
      }
      default:
        return done(false, "unknown");
    }
  } catch (error) {
    done(false, error.code ?? String(error));
  }
});
lines.on("close", () => process.exit(0));
`;

/** A launched fixture runtime and a way to ask it one thing at a time. */
async function launchRuntime(placement: ProviderRemoteProcessPlacement) {
  const scope = Effect.runSync(Scope.make());
  const runtime = await Effect.runPromise(
    Scope.extend(placement.launch({ executable: placement.executable, args: [] }), scope),
  );
  let received = "";
  Effect.runFork(
    Stream.runForEach(runtime.output, (chunk) =>
      Effect.sync(() => {
        received += Buffer.from(chunk).toString("utf8");
      }),
    ),
  );
  let next = 0;
  const ask = async (
    request: Record<string, unknown>,
  ): Promise<{ readonly ok: boolean; readonly detail?: unknown }> => {
    next += 1;
    const id = next;
    await Effect.runPromise(runtime.write(Buffer.from(`${JSON.stringify({ ...request, id })}\n`)));
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const line = received
        .split("\n")
        .filter((candidate) => candidate.length > 0)
        .map((candidate) => JSON.parse(candidate) as { id: number; ok: boolean; detail?: unknown })
        .find((candidate) => candidate.id === id);
      if (line !== undefined) {
        return line.detail === undefined ? { ok: line.ok } : { ok: line.ok, detail: line.detail };
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`the runtime did not answer ${JSON.stringify(request)}`);
  };
  return { ask, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) };
}

/** A checkout the target's user owns, with a committed file changed since and an untracked one. */
function remoteCheckout(name = "remote-app"): string {
  const checkout = join(root, name);
  mkdirSync(join(checkout, "src"), { recursive: true });
  writeFileSync(join(checkout, "README.md"), "hello\n");
  writeFileSync(join(checkout, "src", "main.ts"), "export {};\n");
  const git = (...args: ReadonlyArray<string>) =>
    run("git", [
      "-C",
      checkout,
      "-c",
      "user.name=Octant",
      "-c",
      "user.email=octant@example.invalid",
      ...args,
    ]);
  git("init", "-q", "--initial-branch=main");
  git("add", ".");
  git("commit", "-q", "-m", "initial");
  writeFileSync(join(checkout, "README.md"), "hello\nchanged on the target\n");
  writeFileSync(join(checkout, "new.txt"), "untracked\n");
  return checkout;
}

describe.skipIf(!runnable)("a macOS SSH target on this Mac's Seatbelt", () => {
  beforeAll(async () => {
    // Seatbelt rules name resolved paths, and macOS's temporary folder is a
    // link into /private, so the target's folders are named as it sees them.
    root = realpathSync(mkdtempSync(join(tmpdir(), "octant-ssh-macos-")));
    run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(root, "host-key")]);
    const hostKey = readFileSync(join(root, "host-key.pub"), "utf8").trim().split(" ")[1] ?? "";

    // The SSH server's own address is what the network canary dials, so a
    // listener stands in for it.
    sshServer = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => sshServer?.listen(0, "127.0.0.1", resolve));
    const address = sshServer.address();
    sshPort = typeof address === "object" && address !== null ? address.port : 0;

    for (const directory of ["home", "home/.ssh", "target-tmp", "executor", "target"]) {
      mkdirSync(join(root, directory), { recursive: true, mode: 0o700 });
    }
    run("bun", [
      "build",
      executorEntry,
      "--target=node",
      "--format=esm",
      "--external=node-pty",
      `--outfile=${join(root, "executor", "executor.mjs")}`,
    ]);
    mkdirSync(join(root, "executor", "node_modules"));
    symlinkSync(
      dirname(createRequire(import.meta.url).resolve("node-pty/package.json")),
      join(root, "executor", "node_modules", "node-pty"),
    );
    writeFileSync(
      join(root, "target", "octant"),
      `#!/bin/sh\nexport HOME=${join(root, "home")} TMPDIR=${join(root, "target-tmp")}/\nexec ${process.execPath} ${join(root, "executor", "executor.mjs")} "$@"\n`,
      { mode: 0o700 },
    );
    // The stand-in client: a probe (`-N`) records the target's key and is
    // refused, as the real probe is; a session runs the remote command it
    // was given (the executor's path and its two words) as the login would.
    writeFileSync(
      join(root, "ssh"),
      [
        "#!/bin/sh",
        'for argument in "$@"; do',
        '  case "$argument" in',
        `    UserKnownHostsFile=*) known="\${argument#UserKnownHostsFile=}"; known="\${known#\\"}"; known="\${known%\\"}" ;;`,
        "  esac",
        "done",
        'for argument in "$@"; do',
        '  if [ "$argument" = "-N" ]; then',
        `    printf '%s ssh-ed25519 %s\\n' 127.0.0.1 ${hostKey} > "$known"`,
        "    echo 'Permission denied (publickey).' >&2",
        "    exit 255",
        "  fi",
        "done",
        'while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done',
        "shift 2",
        `export SSH_CONNECTION="127.0.0.1 50000 127.0.0.1 ${String(sshPort)}"`,
        'exec "$@"',
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    chmodSync(join(root, "home"), 0o700);
    const opened = openSshTargetTestStore(root, join(root, "Application Support"));
    store = opened.store;
    closeStore = () => opened.connection.close();
  }, 120_000);

  afterAll(async () => {
    closeStore();
    await new Promise<void>((resolve) =>
      sshServer === undefined ? resolve() : sshServer.close(() => resolve()),
    );
    if (root !== "") rmSync(root, { recursive: true, force: true });
  });

  it("attests every confined posture through Seatbelt, the writing ones through a token-gated loopback forwarder, and admits each", async () => {
    const connections = service();
    const status = await register(connections);
    expect(status).toMatchObject({ connection: "connected", platform: "macos" });
    expect(reasons(status)).toEqual([
      ["plan", "admitted"],
      ["approval-gated", "admitted"],
      ["auto-accept-edits", "admitted"],
    ]);
    // A placed runtime's own canaries pass too, so it is admitted where its
    // driver declares placement.
    for (const posture of ["plan", "approval-gated", "auto-accept-edits"] as const) {
      expect(
        connections.admitProviderRuntime(
          status.target.id,
          { remotePlacement: { postures: [posture], appToolTransport: "stdio" } },
          { posture, permissionPersistence: "current-session" },
        ),
      ).toEqual({ status: "admitted" });
    }

    // The executor's runtime directory ends with the session.
    connections.close();
    const parent = join(root, "target-tmp", `octant-executor-${String(process.getuid?.() ?? 0)}`);
    for (let attempt = 0; attempt < 50 && readdirSync(parent).length > 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(readdirSync(parent)).toEqual([]);
    connections.remove(status.target.id);
  }, 120_000);

  it("runs an approval-gated command proxied through its own loopback forwarder, which forwards only its token's connections, while Seatbelt refuses any other loopback port", async () => {
    const checkout = remoteCheckout("proxied-app");
    const hostProxy = await standInHostProxy("hp.sock");
    const { heads } = hostProxy;
    const connections = service();
    const status = await register(connections);
    try {
      const bound = await new SshRemoteProjectService({
        store: openedStore(),
        connections,
        uuid: randomUUID,
        clock: () => new Date().toISOString(),
      }).bind({ targetId: status.target.id, remoteRoot: remotePath(checkout), name: "Proxied" });
      if (bound.status !== "ok") throw new Error(`bind refused: ${bound.reason}`);
      const session = connections.session(status.target.id);
      if (session === undefined) throw new Error("no session");
      const token = randomBytes(32).toString("hex");
      const wrongToken = randomBytes(32).toString("hex");
      const command = [
        'port="${HTTP_PROXY##*:}"',
        "curl -sS --max-time 10 http://fetch.example/",
        `curl -sS -o /dev/null -w 'none:%{http_code}\\n' --max-time 10 --proxy "http://127.0.0.1:$port" http://fetch.example/`,
        `curl -sS -o /dev/null -w 'wrong:%{http_code}\\n' --max-time 10 --proxy "http://octant:${wrongToken}@127.0.0.1:$port" http://fetch.example/`,
        `curl -sS -o /dev/null --max-time 5 --noproxy '*' http://127.0.0.1:${String(sshPort)}/ 2>/dev/null; echo "other-port:$?"`,
        'echo "port:$port"',
        "echo written > written-by-command",
        // A harness command runs the xcode-select shim as a terminal does.
        '/usr/bin/git status --short >/dev/null 2>&1; echo "git-status:$?"',
      ].join("\n");
      const ran = await connections.runCommand(
        session,
        {
          posture: "approval-gated",
          permissionPersistence: "current-session",
          subject: { kind: "octant-launch" },
        },
        {
          kind: "run-command",
          root: bound.value.remoteRoot,
          command,
          posture: "approval-gated",
          network: "proxied",
          egressToken: token,
          timeoutMs: 60_000,
        },
        { egressProxy: { kind: "unix-socket", path: hostProxy.path } },
      );
      if (ran.status !== "replied" || ran.reply.kind !== "command-ran") {
        throw new Error(`the command did not run: ${JSON.stringify(ran)}`);
      }
      const stdout = Buffer.from(ran.reply.stdout, "base64").toString();
      const lines = stdout.trim().split("\n");
      expect(lines.slice(0, 4)).toEqual(["hello", "none:407", "wrong:407", "other-port:7"]);
      const forwarderPort = Number(lines[4]?.replace("port:", ""));
      expect(forwarderPort).toBeGreaterThan(0);
      expect(forwarderPort).not.toBe(sshPort);
      expect(lines[5]).toBe("git-status:0");
      expect(readFileSync(join(checkout, "written-by-command"), "utf8")).toBe("written\n");
      // Only the connection that presented the launch's token reached this host.
      expect(heads).toHaveLength(1);
      expect(heads[0]).toContain(proxyAuthorization(token));
      // The forwarder ended with its launch: nothing listens on its port now.
      expect(await loopbackListens(forwarderPort)).toBe(false);
    } finally {
      connections.close();
      connections.remove(status.target.id);
      await hostProxy.close();
    }
  }, 180_000);

  it("places a runtime in Plan and approval-gated that reaches only this host's proxy through its own token-gated forwarder, which closes with it", async () => {
    const checkout = remoteCheckout("runtime-app");
    const binaryFolder = join(root, "runtime-bin");
    mkdirSync(binaryFolder, { mode: 0o755 });
    const binary = join(binaryFolder, "agent");
    writeFileSync(binary, FIXTURE_RUNTIME, { mode: 0o755 });
    const hostProxy = await standInHostProxy("rp.sock");
    const token = randomBytes(32).toString("hex");
    const runtimeEgress: ProviderRuntimeEgress = {
      start: async () => ({
        status: "listening",
        endpoint: { kind: "unix-socket", path: hostProxy.path },
        token,
        close: async () => undefined,
      }),
    };
    const connections = service(runtimeEgress);
    const status = await register(connections);
    const instance = decodeProviderInstanceId("80000000-0000-4000-8000-000000000b01");
    try {
      const bound = await new SshRemoteProjectService({
        store: openedStore(),
        connections,
        uuid: randomUUID,
        clock: () => new Date().toISOString(),
      }).bind({ targetId: status.target.id, remoteRoot: remotePath(checkout), name: "Runtime" });
      if (bound.status !== "ok") throw new Error(`bind refused: ${bound.reason}`);
      const set = connections.setRuntimeBinary({
        targetId: status.target.id,
        providerInstanceId: instance,
        path: remotePath(binary),
      });
      if (set.status !== "ok") throw new Error(set.message);
      const session = connections.session(status.target.id);
      if (session === undefined) throw new Error("no session");
      const placementIn = (posture: "plan" | "approval-gated") => {
        const placed = connections.placement({
          session,
          driver: { remotePlacement: { postures: [posture], appToolTransport: "stdio" } },
          root: bound.value.remoteRoot,
          projectId: String(bound.value.id),
          threadId: randomUUID(),
          providerInstanceId: instance,
          posture,
          permissionPersistence: "current-session",
          currentPosture: () => posture,
        });
        if (placed.status !== "placed") throw new Error(placed.failure.message);
        return placed.placement;
      };

      for (const posture of ["plan", "approval-gated"] as const) {
        const runtime = await launchRuntime(placementIn(posture));
        const port = Number((await runtime.ask({ op: "port" })).detail);
        expect(port).toBeGreaterThan(0);
        expect(await runtime.ask({ op: "fetch", token: "own" })).toEqual({
          ok: true,
          detail: "HTTP/1.1 200 OK",
        });
        for (const presented of [null, randomBytes(32).toString("hex")]) {
          expect(await runtime.ask({ op: "fetch", token: presented })).toEqual({
            ok: true,
            detail: "HTTP/1.1 407 Proxy Authentication Required",
          });
        }
        // Seatbelt lets it reach its forwarder's port and no other.
        expect(
          await runtime.ask({ op: "connect", host: "127.0.0.1", port: sshPort }),
        ).toMatchObject({ ok: false });
        expect(
          await runtime.ask({ op: "write", path: join(checkout, `${posture}-wrote`) }),
        ).toEqual(posture === "plan" ? expect.objectContaining({ ok: false }) : { ok: true });
        await runtime.close();
        await expect.poll(() => loopbackListens(port), { timeout: 10_000 }).toBe(false);
      }
      // Only the requests that presented the launch's token reached this host.
      expect(hostProxy.heads).toHaveLength(2);
      for (const head of hostProxy.heads) expect(head).toContain(proxyAuthorization(token));
      expect(existsSync(join(checkout, "plan-wrote"))).toBe(false);
    } finally {
      connections.close();
      connections.remove(status.target.id);
      await hostProxy.close();
    }
  }, 180_000);

  it("creates a managed worktree on the macOS target and opens a Seatbelt-confined approval-gated terminal in it that commits there and writes nowhere beside it", async () => {
    const parent = join(root, "projects");
    mkdirSync(parent, { mode: 0o700 });
    const checkout = join(parent, "service");
    mkdirSync(checkout);
    writeFileSync(join(checkout, "README.md"), "service\n");
    const git = (...args: ReadonlyArray<string>) =>
      run("git", [
        "-C",
        checkout,
        "-c",
        "user.name=Octant",
        "-c",
        "user.email=octant@example.invalid",
        ...args,
      ]);
    git("init", "-q", "--initial-branch=main");
    git("add", ".");
    git("commit", "-q", "-m", "initial");

    const connections = service();
    const status = await register(connections);
    const projects = new SshRemoteProjectService({
      store: openedStore(),
      connections,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
    });
    try {
      const bound = await projects.bind({
        targetId: status.target.id,
        remoteRoot: remotePath(checkout),
        name: "Service",
      });
      if (bound.status !== "ok") throw new Error(`bind refused: ${bound.reason}`);
      const projectId = bound.value.id;
      const created = await projects.createWorktree({ projectId, name: "feature" });
      const worktreePath = join(parent, ".octant-worktrees", String(projectId), "feature");
      expect(created).toMatchObject({
        status: "ok",
        value: { name: "feature", branch: "octant/feature", path: worktreePath },
      });
      if (created.status !== "ok") return;

      const terminals = new SshRemoteTerminalService({
        projects,
        connections,
        store: openedStore(),
      });
      const window = Schema.decodeUnknownSync(WindowId)(randomUUID());
      const terminalId = decodeCodeTerminalId(randomUUID());
      expect(
        await terminals.execute(window, {
          kind: "start",
          projectId,
          terminalId,
          worktreeId: created.value.id,
          columns: 120,
          rows: 30,
        }),
      ).toMatchObject({
        kind: "project-terminal",
        terminal: { state: "running", posture: "approval-gated" },
      });
      const output = async (): Promise<string> => {
        const read = await terminals.execute(window, {
          kind: "read-output",
          projectId,
          terminalId,
          afterCharacters: 0,
        });
        return read.kind === "project-terminal" ? (read.output?.text ?? "") : read.message;
      };
      await terminals.execute(window, {
        kind: "write",
        projectId,
        terminalId,
        data: [
          "pwd",
          // Each marker is printed by `printf`, so the typed line never matches it.
          // `/usr/bin/git` is the xcode-select shim, which reads two links
          // under `/private/var`; the shell may read those and nothing
          // beside them there.
          "/usr/bin/git status --short >/dev/null && printf 'STATUS-%s\\n' OK",
          "ls /private/var/select >/dev/null 2>&1 || printf 'SELECT-%s\\n' DENIED",
          "ls /private/var/db >/dev/null 2>&1 || printf 'DB-%s\\n' DENIED",
          "echo made > made.txt && git add made.txt && git -c user.name=O -c user.email=o@example.invalid commit -qm made && printf 'COMMIT-%s\\n' OK",
          `touch ${join(parent, "beside.txt")}`,
          "printf 'END-%s\\n' SCRIPT",
          "exit",
          "",
        ].join("\r"),
      });
      await expect.poll(output, { timeout: 30_000 }).toContain("END-SCRIPT");
      const printed = await output();
      expect(printed).toContain(worktreePath);
      expect(printed).toContain("STATUS-OK");
      expect(printed).toContain("SELECT-DENIED");
      expect(printed).toContain("DB-DENIED");
      expect(printed).toContain("COMMIT-OK");
      expect(existsSync(join(parent, "beside.txt"))).toBe(false);
      expect(
        spawnSync("git", ["-C", checkout, "log", "-1", "--format=%s", "octant/feature"], {
          encoding: "utf8",
        }).stdout.trim(),
      ).toBe("made");
      expect(await projects.removeWorktree({ worktreeId: created.value.id })).toEqual({
        status: "ok",
        value: null,
      });
      expect(existsSync(worktreePath)).toBe(false);
    } finally {
      connections.close();
      connections.remove(status.target.id);
    }
  }, 180_000);

  it("binds a remote root on the macOS target and reads its files, Git status, and diff through Seatbelt-confined Git", async () => {
    const checkout = remoteCheckout();
    const connections = service();
    const status = await register(connections);
    const projects = new SshRemoteProjectService({
      store: openedStore(),
      connections,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
    });
    const bound = await projects.bind({
      targetId: status.target.id,
      remoteRoot: remotePath(checkout),
      name: "Remote app",
    });
    expect(bound).toMatchObject({ status: "ok", value: { remoteRoot: checkout } });
    if (bound.status !== "ok") return;
    const projectId = bound.value.id;

    const listed = await projects.listDirectory({ projectId });
    expect(listed).toMatchObject({ status: "ok", value: { truncated: false } });
    if (listed.status === "ok") {
      expect(listed.value.entries).toEqual([
        { kind: "file", path: "new.txt", byteLength: 10 },
        { kind: "file", path: "README.md", byteLength: 28 },
        { kind: "directory", path: "src" },
      ]);
    }
    const read = await projects.readFile({ projectId, path: decodeCodeRelativePath("README.md") });
    expect(read.status === "ok" && Buffer.from(read.value.contentBase64, "base64").toString()).toBe(
      "hello\nchanged on the target\n",
    );

    const gitStatus = await projects.gitStatus({ projectId });
    expect(gitStatus).toMatchObject({
      status: "ok",
      value: { head: { kind: "branch", name: "main" }, truncated: false },
    });
    if (gitStatus.status === "ok") {
      expect(gitStatus.value.entries).toEqual(
        expect.arrayContaining([
          { path: "README.md", index: " ", worktree: "M" },
          { path: "new.txt", index: "?", worktree: "?" },
        ]),
      );
    }
    const diff = await projects.gitDiff({ projectId, path: decodeCodeRelativePath("README.md") });
    expect(diff.status === "ok" && diff.value.text).toContain("+changed on the target");

    // A folder that holds the remote user's ~/.ssh is never bound.
    expect(
      await projects.bind({
        targetId: status.target.id,
        remoteRoot: remotePath(root),
        name: "All",
      }),
    ).toEqual({ status: "refused", reason: "root-not-confinable" });

    connections.close();
    expect(await projects.gitStatus({ projectId })).toEqual({
      status: "refused",
      reason: "not-admitted",
      decision: { status: "refused", reason: "target-unreachable" },
    });
    connections.remove(status.target.id);
  }, 180_000);
});
