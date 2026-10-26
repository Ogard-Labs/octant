import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveReportedHostVersion } from "@octant/host-runtime";
import { decodeCodeRelativePath } from "@octant/contracts/code";
import { decodeUtcTimestamp } from "@octant/contracts/events";
import { decodeProjectId } from "@octant/contracts/projects";
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
 * End-to-end evidence for remote SSH targets: the system OpenSSH client, a
 * loopback `sshd` as the target, and the real executor, bundled as the
 * headless artifact bundles it. Each "target" is the same machine reached
 * through a different executor path, a wrapper that sets up what that target
 * would be like: a non-root user with working bubblewrap, a non-root user
 * whose `/usr/bin/bwrap` is missing or is a fake that confines nothing, or a
 * root login.
 *
 * It runs only as root on Linux with OpenSSH server and bubblewrap installed,
 * because dropping the executor to another user and replacing
 * `/usr/bin/bwrap` inside a private mount namespace both need root. Nothing
 * reads or changes the person's own SSH setup: the client runs with a
 * configuration file of the test's own (`-F`), the server with its own host
 * keys and authorized keys, and the executor with a temporary home.
 */

const SSHD = "/usr/sbin/sshd";
const SSH = "/usr/bin/ssh";
const BWRAP = "/usr/bin/bwrap";
const NOBODY = 65_534;
const runnable =
  process.platform === "linux" &&
  process.getuid?.() === 0 &&
  [SSHD, SSH, BWRAP, "/usr/bin/setpriv", "/usr/bin/unshare", "/run/sshd"].every((path) =>
    existsSync(path),
  );

const executorEntry = fileURLToPath(new URL("./executorMain.ts", import.meta.url));
const destination = Schema.decodeUnknownSync(SshDestination)("127.0.0.1");
const executorPath = Schema.decodeUnknownSync(SshExecutorPath);
const remotePath = Schema.decodeUnknownSync(SshRemotePath);
const developmentBuild = resolveReportedHostVersion({});

let root = "";
let sshd: ChildProcess | undefined;
let sshdPort = 0;
let store: SshTargetStore | undefined;
let closeStore = () => {};

function run(command: string, args: ReadonlyArray<string>): void {
  const result = spawnSync(command, [...args], { stdio: "pipe", encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr || result.error?.message || ""}`);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}

async function waitForPort(port: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (open) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("sshd did not start");
}

function startSshd(hostKey: string): void {
  writeFileSync(
    join(root, "sshd_config"),
    [
      `Port ${String(sshdPort)}`,
      "ListenAddress 127.0.0.1",
      `HostKey ${hostKey}`,
      `AuthorizedKeysFile ${join(root, "authorized_keys")}`,
      `PidFile ${join(root, "sshd.pid")}`,
      "StrictModes no",
      "UsePAM no",
      "PermitRootLogin prohibit-password",
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "",
    ].join("\n"),
  );
  sshd = spawn(SSHD, ["-D", "-e", "-f", join(root, "sshd_config")], { stdio: "ignore" });
}

async function stopSshd(): Promise<void> {
  const running = sshd;
  sshd = undefined;
  if (running === undefined || running.exitCode !== null) return;
  await new Promise((resolve) => {
    running.once("close", resolve);
    running.kill("SIGTERM");
  });
}

/** One target: an executor path whose wrapper prepares what that target is like. */
function target(name: string, body: string): ReturnType<typeof executorPath> {
  const directory = join(root, "targets", name);
  mkdirSync(directory, { recursive: true, mode: 0o755 });
  const path = join(directory, "octant");
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return executorPath(path);
}

function asNobody(bwrapReplacement?: string): string {
  const executor = `setpriv --reuid=${String(NOBODY)} --regid=${String(NOBODY)} --clear-groups -- ${process.execPath} ${join(root, "executor", "executor.mjs")}`;
  const environment = `export HOME=${join(root, "nobody-home")} TMPDIR=${join(root, "nobody-tmp")}`;
  if (bwrapReplacement === undefined) return `${environment}\nexec ${executor}`;
  return `${environment}\nexec unshare --mount --propagation private -- /bin/sh -c 'mount --bind ${bwrapReplacement} ${BWRAP} && exec ${executor}'`;
}

function openedStore(): SshTargetStore {
  if (store === undefined) throw new Error("the store opens before the tests");
  return store;
}

function service(buildVersion = developmentBuild) {
  return new SshTargetConnectionService({
    store: openedStore(),
    buildVersion,
    sshExecutable: join(root, "ssh"),
    environment: { PATH: "/usr/bin:/bin" },
  });
}

async function register(
  connections: SshTargetConnectionService,
  path: ReturnType<typeof executorPath>,
): Promise<SshTargetStatus> {
  const probe = await connections.probeHostKey(destination);
  if (probe.status !== "ok") throw new Error(`probe refused: ${probe.reason}`);
  const registered = await connections.register({
    probeId: probe.value.probeId,
    fingerprint: probe.value.fingerprint,
    executorPath: path,
  });
  if (registered.status !== "ok") throw new Error(`registration refused: ${registered.reason}`);
  return registered.value;
}

function projectsOn(connections: SshTargetConnectionService): SshRemoteProjectService {
  return new SshRemoteProjectService({
    store: openedStore(),
    connections,
    uuid: randomUUID,
    clock: () => new Date().toISOString(),
  });
}

/**
 * A checkout the target's user owns, with a committed file changed since, an
 * untracked one, and a link that leads out of it to a file beside it.
 */
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
  writeFileSync(join(root, "outside-secret"), "not the checkout's\n");
  symlinkSync(join(root, "outside-secret"), join(checkout, "escape"));
  symlinkSync(checkout, join(root, "remote-link"));
  run("chown", ["-R", `${String(NOBODY)}:${String(NOBODY)}`, checkout]);
  return checkout;
}

function reasons(status: SshTargetStatus): ReadonlyArray<string> {
  return status.admission.map((entry) =>
    entry.decision.status === "admitted" ? "admitted" : entry.decision.reason,
  );
}

describe.skipIf(!runnable)("SSH targets against a loopback sshd", () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "octant-ssh-loopback-"));
    chmodSync(root, 0o755);
    for (const key of ["host-key", "host-key-rotated", "user-key"]) {
      run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(root, key)]);
    }
    writeFileSync(join(root, "authorized_keys"), readFileSync(join(root, "user-key.pub")));
    sshdPort = await freePort();
    writeFileSync(
      join(root, "client_config"),
      [
        "Host *",
        `  Port ${String(sshdPort)}`,
        "  User root",
        `  IdentityFile ${join(root, "user-key")}`,
        "  IdentitiesOnly yes",
        "",
      ].join("\n"),
    );
    // The person's configuration in this test is the test's own file.
    writeFileSync(
      join(root, "ssh"),
      `#!/bin/sh\nexec ${SSH} -F ${join(root, "client_config")} "$@"\n`,
      {
        mode: 0o700,
      },
    );
    for (const directory of ["nobody-home", "nobody-home/.ssh", "nobody-tmp"]) {
      mkdirSync(join(root, directory), { mode: 0o700 });
      chownSync(join(root, directory), NOBODY, NOBODY);
    }
    mkdirSync(join(root, "root-home", ".ssh"), { recursive: true, mode: 0o700 });
    mkdirSync(join(root, "root-tmp"), { mode: 0o700 });
    writeFileSync(join(root, "bwrap-not-executable"), "", { mode: 0o644 });
    writeFileSync(
      join(root, "bwrap-confines-nothing"),
      '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "--" ]; then shift; exec "$@"; fi\n  shift\ndone\nexit 0\n',
      { mode: 0o755 },
    );
    mkdirSync(join(root, "executor"), { mode: 0o755 });
    run("bun", [
      "build",
      executorEntry,
      "--target=node",
      "--format=esm",
      `--outfile=${join(root, "executor", "executor.mjs")}`,
    ]);
    chmodSync(join(root, "executor", "executor.mjs"), 0o644);
    // A data directory with a space, as macOS's Application Support is.
    const opened = openSshTargetTestStore(root, join(root, "Application Support"));
    store = opened.store;
    closeStore = () => opened.connection.close();
    startSshd(join(root, "host-key"));
    await waitForPort(sshdPort);
  }, 120_000);

  afterAll(async () => {
    await stopSshd();
    closeStore();
    if (root !== "") rmSync(root, { recursive: true, force: true });
  });

  it("attests a non-root target with working bubblewrap and admits every confined posture", async () => {
    const connections = service();
    const status = await register(connections, target("confined", asNobody()));
    expect(status).toMatchObject({
      connection: "connected",
      remoteUser: "nobody",
      platform: "linux",
    });
    expect(reasons(status)).toEqual(["admitted", "admitted", "admitted"]);

    // The executor and its runtime directory end with the session.
    connections.close();
    const runtimeParent = join(root, "nobody-tmp", `octant-executor-${String(NOBODY)}`);
    for (let attempt = 0; attempt < 50 && readdirSync(runtimeParent).length > 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(readdirSync(runtimeParent)).toEqual([]);
    connections.remove(status.target.id);
  }, 120_000);

  it("refuses a target whose bubblewrap is missing", async () => {
    const connections = service();
    const status = await register(
      connections,
      target("no-bwrap", asNobody(join(root, "bwrap-not-executable"))),
    );
    expect(status.connection).toBe("connected");
    expect(reasons(status)).toEqual([
      "confinement-backend-missing",
      "confinement-backend-missing",
      "confinement-backend-missing",
    ]);
    connections.close();
    connections.remove(status.target.id);
  }, 120_000);

  it("refuses every posture when a fake confinement lets a canary escape, naming the escape", async () => {
    const connections = service();
    const status = await register(
      connections,
      target("fake-bwrap", asNobody(join(root, "bwrap-confines-nothing"))),
    );
    expect(reasons(status)).toEqual([
      "confinement-canary-escaped",
      "confinement-canary-escaped",
      "confinement-canary-escaped",
    ]);
    expect(status.admission[0]?.decision).toMatchObject({
      reason: "confinement-canary-escaped",
      posture: "plan",
    });
    connections.close();
    connections.remove(status.target.id);
  }, 120_000);

  it("refuses an executor of another build without asking it to attest", async () => {
    const connections = service("0.0.0-another-build");
    const status = await register(connections, target("other-build", asNobody()));
    expect(status.connection).toBe("executor-version-mismatch");
    expect(reasons(status)).toEqual([
      "executor-version-mismatch",
      "executor-version-mismatch",
      "executor-version-mismatch",
    ]);
    connections.close();
    connections.remove(status.target.id);
  }, 120_000);

  it("refuses a root login", async () => {
    const connections = service();
    const status = await register(
      connections,
      target(
        "root-login",
        `export HOME=${join(root, "root-home")} TMPDIR=${join(root, "root-tmp")}\nexec ${process.execPath} ${join(root, "executor", "executor.mjs")}`,
      ),
    );
    expect(status).toMatchObject({ connection: "connected", remoteUser: "root" });
    expect(reasons(status)).toEqual(["remote-root-user", "remote-root-user", "remote-root-user"]);
    connections.close();
    connections.remove(status.target.id);
  }, 120_000);

  it("refuses a changed host key until the person confirms the new one", async () => {
    const connections = service();
    const registered = await register(connections, target("rotated", asNobody()));
    expect(reasons(registered)).toEqual(["admitted", "admitted", "admitted"]);
    connections.close();

    await stopSshd();
    startSshd(join(root, "host-key-rotated"));
    await waitForPort(sshdPort);
    try {
      const reconnected = await connections.connect(registered.target.id);
      expect(reconnected).toMatchObject({
        status: "ok",
        value: { connection: "host-key-changed" },
      });
      if (reconnected.status === "ok") {
        expect(reasons(reconnected.value)).toEqual([
          "host-key-changed",
          "host-key-changed",
          "host-key-changed",
        ]);
      }

      const probe = await connections.probeHostKey(destination);
      if (probe.status !== "ok") throw new Error("probe refused");
      expect(probe.value.fingerprint).not.toBe(registered.fingerprint);
      const repinned = await connections.repin({
        targetId: registered.target.id,
        probeId: probe.value.probeId,
        fingerprint: probe.value.fingerprint,
      });
      expect(repinned).toMatchObject({ status: "ok", value: { connection: "connected" } });
      if (repinned.status === "ok") {
        expect(reasons(repinned.value)).toEqual(["admitted", "admitted", "admitted"]);
      }
    } finally {
      connections.close();
      connections.remove(registered.target.id);
      await stopSshd();
      startSshd(join(root, "host-key"));
      await waitForPort(sshdPort);
    }
  }, 180_000);

  it("binds a remote root on an attested target and reads its files, Git status, and diff from the target", async () => {
    const checkout = remoteCheckout();
    const connections = service();
    const status = await register(connections, target("project-reads", asNobody()));
    expect(reasons(status)).toEqual(["admitted", "admitted", "admitted"]);
    const projects = projectsOn(connections);

    // The journal records the folder the executor resolved, not the link.
    const bound = await projects.bind({
      targetId: status.target.id,
      remoteRoot: remotePath(join(root, "remote-link")),
      name: "Remote app",
    });
    expect(bound).toMatchObject({ status: "ok", value: { remoteRoot: checkout } });
    if (bound.status !== "ok") return;
    const projectId = bound.value.id;
    expect(projects.list().map((project) => project.id)).toContain(projectId);

    const listed = await projects.listDirectory({ projectId });
    expect(listed).toMatchObject({ status: "ok", value: { truncated: false } });
    if (listed.status !== "ok") return;
    expect(listed.value.entries).toEqual([
      { kind: "file", path: "new.txt", byteLength: 10 },
      { kind: "file", path: "README.md", byteLength: 28 },
      { kind: "directory", path: "src" },
    ]);
    expect(
      await projects.listDirectory({ projectId, directory: decodeCodeRelativePath("src") }),
    ).toMatchObject({
      status: "ok",
      value: { entries: [{ kind: "file", path: "src/main.ts" }] },
    });

    const read = await projects.readFile({ projectId, path: decodeCodeRelativePath("README.md") });
    expect(read.status === "ok" && Buffer.from(read.value.contentBase64, "base64").toString()).toBe(
      "hello\nchanged on the target\n",
    );
    // The link leads out of the root; the executor refuses it on the target.
    expect(await projects.readFile({ projectId, path: decodeCodeRelativePath("escape") })).toEqual({
      status: "refused",
      reason: "outside-root",
    });

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

    // With its session gone, the Project reads nothing until it attests again.
    connections.close();
    expect(await projects.gitStatus({ projectId })).toEqual({
      status: "refused",
      reason: "not-admitted",
      decision: { status: "refused", reason: "target-unreachable" },
    });
    connections.remove(status.target.id);
    expect(await projects.listDirectory({ projectId })).toEqual({
      status: "refused",
      reason: "not-admitted",
      decision: { status: "refused", reason: "target-removed" },
    });
  }, 180_000);

  it("runs no program a hostile checkout's Git configuration names when it reads status and diff", async () => {
    const checkout = join(root, "hostile-app");
    mkdirSync(checkout);
    const git = (...args: ReadonlyArray<string>) =>
      run("git", [
        "-C",
        checkout,
        "-c",
        "user.name=O",
        "-c",
        "user.email=o@example.invalid",
        ...args,
      ]);
    git("init", "-q", "--initial-branch=main");
    writeFileSync(join(checkout, "notes.txt"), "kept\n");
    git("add", ".");
    git("commit", "-q", "-m", "initial");
    // Each program lives in the root, which the confined Git can read, and
    // prints what a diff would show if it ran.
    const program = join(checkout, "hostile.sh");
    writeFileSync(program, "#!/bin/sh\ncat\necho HOSTILE-PROGRAM-RAN\n", { mode: 0o755 });
    writeFileSync(join(checkout, ".gitattributes"), "* filter=hostile diff=hostile\n");
    const included = join(checkout, "included.config");
    writeFileSync(included, `[core]\n\tpager = ${program}\n`);
    writeFileSync(
      join(checkout, ".git", "config"),
      [
        "[core]",
        "\trepositoryformatversion = 0",
        "\tbare = false",
        `\tfsmonitor = ${program}`,
        `\tpager = ${program}`,
        `\thooksPath = ${checkout}`,
        `\tsshCommand = ${program}`,
        "[diff]",
        `\texternal = ${program}`,
        '[diff "hostile"]',
        `\tcommand = ${program}`,
        `\ttextconv = ${program}`,
        '[filter "hostile"]',
        `\tclean = ${program}`,
        `\tsmudge = ${program}`,
        "[pager]",
        `\tdiff = ${program}`,
        `\tstatus = ${program}`,
        "[include]",
        `\tpath = ${included}`,
        '[includeIf "gitdir:/"]',
        `\tpath = ${included}`,
        "",
      ].join("\n"),
    );
    writeFileSync(join(checkout, "notes.txt"), "kept\nchanged\n");
    run("chown", ["-R", `${String(NOBODY)}:${String(NOBODY)}`, checkout]);

    const connections = service();
    const status = await register(connections, target("hostile-reads", asNobody()));
    expect(reasons(status)).toEqual(["admitted", "admitted", "admitted"]);
    const projects = projectsOn(connections);
    const bound = await projects.bind({
      targetId: status.target.id,
      remoteRoot: remotePath(checkout),
      name: "Hostile",
    });
    if (bound.status !== "ok") throw new Error(`bind refused: ${bound.reason}`);
    const projectId = bound.value.id;
    try {
      const gitStatus = await projects.gitStatus({ projectId });
      expect(gitStatus).toMatchObject({ status: "ok", value: { head: { name: "main" } } });
      expect(JSON.stringify(gitStatus)).not.toContain("HOSTILE-PROGRAM-RAN");
      for (const path of [undefined, decodeCodeRelativePath("notes.txt")]) {
        const diff = await projects.gitDiff({ projectId, ...(path === undefined ? {} : { path }) });
        expect(diff.status === "ok" && diff.value.text).toContain("+changed");
        expect(JSON.stringify(diff)).not.toContain("HOSTILE-PROGRAM-RAN");
      }
    } finally {
      connections.close();
      connections.remove(status.target.id);
    }
  }, 180_000);

  it("refuses to bind or read a remote root on a target whose canary escaped", async () => {
    const connections = service();
    const status = await register(
      connections,
      target("fake-bwrap-project", asNobody(join(root, "bwrap-confines-nothing"))),
    );
    const projects = projectsOn(connections);
    const bound = await projects.bind({
      targetId: status.target.id,
      remoteRoot: remotePath(join(root, "remote-app")),
      name: "Remote app",
    });
    expect(bound).toMatchObject({
      status: "refused",
      reason: "not-admitted",
      decision: { reason: "confinement-canary-escaped" },
    });
    // A Project bound while the target attested reads nothing once it does not.
    const projectId = decodeProjectId(randomUUID());
    openedStore().bindProject({
      id: projectId,
      name: "Bound earlier",
      targetId: status.target.id,
      remoteRoot: remotePath(join(root, "remote-app")),
      boundAt: decodeUtcTimestamp(new Date().toISOString()),
    });
    expect(
      await projects.readFile({ projectId, path: decodeCodeRelativePath("README.md") }),
    ).toMatchObject({
      status: "refused",
      reason: "not-admitted",
      decision: { reason: "confinement-canary-escaped" },
    });
    connections.close();
    connections.remove(status.target.id);
  }, 120_000);
});
