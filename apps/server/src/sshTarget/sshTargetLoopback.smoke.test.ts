import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveReportedHostVersion } from "@octant/host-runtime";
import {
  SshDestination,
  SshExecutorPath,
  type SshTargetStatus,
} from "@octant/contracts/ssh-target";
import { SshTargetConnectionService } from "./sshTargetConnectionService";
import { SshTargetRegistry } from "./sshTargetRegistry";

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
const developmentBuild = resolveReportedHostVersion({});

let root = "";
let sshd: ChildProcess | undefined;
let sshdPort = 0;

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

function service(buildVersion = developmentBuild) {
  return new SshTargetConnectionService({
    // A data directory with a space, as macOS's Application Support is.
    registry: new SshTargetRegistry(join(root, "Application Support")),
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
    startSshd(join(root, "host-key"));
    await waitForPort(sshdPort);
  }, 120_000);

  afterAll(async () => {
    await stopSshd();
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
});
