import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import { createServer, type Server } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveReportedHostVersion } from "@octant/host-runtime";
import { decodeCodeRelativePath } from "@octant/contracts/code";
import {
  SshDestination,
  SshExecutorPath,
  SshRemotePath,
  type SshTargetStatus,
} from "@octant/contracts/ssh-target";
import { SshRemoteProjectService } from "./sshRemoteProjectService";
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

function service(): SshTargetConnectionService {
  return new SshTargetConnectionService({
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

/** A checkout the target's user owns, with a committed file changed since and an untracked one. */
function remoteCheckout(): string {
  const checkout = join(root, "remote-app");
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
    const sshPort = typeof address === "object" && address !== null ? address.port : 0;

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

  it("attests Plan through Seatbelt, admits it, and refuses the writing postures until their forwarder is settled", async () => {
    const connections = service();
    const status = await register(connections);
    expect(status).toMatchObject({ connection: "connected", platform: "macos" });
    expect(reasons(status)).toEqual([
      ["plan", "admitted"],
      ["approval-gated", "not-attested"],
      ["auto-accept-edits", "not-attested"],
    ]);

    // The executor's runtime directory ends with the session.
    connections.close();
    const parent = join(root, "target-tmp", `octant-executor-${String(process.getuid?.() ?? 0)}`);
    for (let attempt = 0; attempt < 50 && readdirSync(parent).length > 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(readdirSync(parent)).toEqual([]);
    connections.remove(status.target.id);
  }, 120_000);

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
