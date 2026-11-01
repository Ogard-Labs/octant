import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, connect, type AddressInfo } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RepositoryTestProcessPort } from "../code/repositoryTestProcessPort";
import { createNativeHarnessShell } from "../harness/nativeHarnessShell";
import {
  agentRequestAllowed,
  knownHostLineFor,
  openServerSshAccessFor,
  resolveWithPersonConfig,
} from "./serverSshAccess";

describe("the host-owned agent socket", () => {
  const message = (type: number, body: Buffer = Buffer.alloc(0)) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(1 + body.length);
    return Buffer.concat([length, Buffer.from([type]), body]);
  };
  const extension = (name: string) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(name.length);
    return message(27, Buffer.concat([length, Buffer.from(name, "latin1")]));
  };

  it("passes on only listing keys, signing a login, and binding a session", () => {
    expect(agentRequestAllowed(message(11))).toBe(true);
    expect(agentRequestAllowed(message(13))).toBe(true);
    expect(agentRequestAllowed(extension("session-bind@openssh.com"))).toBe(true);
    // Add, remove, remove all, lock, and any other extension.
    for (const type of [17, 18, 19, 22, 25]) expect(agentRequestAllowed(message(type))).toBe(false);
    expect(agentRequestAllowed(extension("query"))).toBe(false);
  });

  it("records a known host's key under the alias the config names", () => {
    expect(knownHostLineFor("web1", "|1|abc=|def= ssh-ed25519 AAAAkey")).toBe(
      "web1 ssh-ed25519 AAAAkey",
    );
    expect(knownHostLineFor("web1", "@cert-authority *.example.net ssh-ed25519 AAAAca")).toBe(
      "@cert-authority web1 ssh-ed25519 AAAAca",
    );
    expect(knownHostLineFor("web1", "# Host found: line 3")).toBeUndefined();
  });
});

// A throwaway sshd and ssh-agent on loopback, owned by this test: no real
// host and no key of the person's is ever involved.
const canRun = process.platform === "darwin" && existsSync("/usr/sbin/sshd");

describe.skipIf(!canRun)("a confined command reaching a registered server", () => {
  const started: ChildProcess[] = [];
  let root = "";
  let socketRoot = "";
  let agentSocket = "";
  let personConfig = "";
  let sshdPort = 0;
  let remoteFile = "";
  const user = userInfo().username;

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "octant-ssh-test-")));
    socketRoot = realpathSync(mkdtempSync("/tmp/octant-ssh-test-"));
    for (const name of ["hostkey", "userkey"]) {
      spawnSync("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(root, name)]);
    }
    writeFileSync(join(root, "authorized_keys"), readFileSync(join(root, "userkey.pub")), {
      mode: 0o600,
    });
    sshdPort = await freePort();
    writeFileSync(
      join(root, "sshd_config"),
      [
        `Port ${String(sshdPort)}`,
        "ListenAddress 127.0.0.1",
        `HostKey ${join(root, "hostkey")}`,
        `AuthorizedKeysFile ${join(root, "authorized_keys")}`,
        "PasswordAuthentication no",
        "KbdInteractiveAuthentication no",
        "UsePAM no",
        "StrictModes no",
        `PidFile ${join(root, "sshd.pid")}`,
        "Subsystem sftp /usr/libexec/sftp-server",
      ].join("\n"),
    );
    started.push(
      spawn("/usr/sbin/sshd", ["-D", "-e", "-f", join(root, "sshd_config")], { stdio: "ignore" }),
    );
    agentSocket = join(socketRoot, "agent");
    started.push(spawn("/usr/bin/ssh-agent", ["-D", "-a", agentSocket], { stdio: "ignore" }));
    await waitFor(() => existsSync(agentSocket));
    spawnSync("/usr/bin/ssh-add", ["-q", join(root, "userkey")], {
      env: { ...process.env, SSH_AUTH_SOCK: agentSocket },
    });
    await waitFor(() => portOpen(sshdPort));
    // The person's own config and known hosts, as `ssh` on the host reads them.
    personConfig = join(root, "person_config");
    writeFileSync(
      join(root, "person_known_hosts"),
      `[127.0.0.1]:${String(sshdPort)} ${readFileSync(join(root, "hostkey.pub"), "utf8").split(" ").slice(0, 2).join(" ")}\n`,
    );
    writeFileSync(
      personConfig,
      `Host web1\n  HostName 127.0.0.1\n  Port ${String(sshdPort)}\n  UserKnownHostsFile ${join(root, "person_known_hosts")}\nHost jumped\n  HostName 127.0.0.1\n  ProxyJump web1\n`,
    );
    remoteFile = join(root, "remote.log");
    writeFileSync(remoteFile, "served-by-sshd\n");
  }, 30_000);

  afterAll(() => {
    for (const child of started) child.kill();
    rmSync(root, { recursive: true, force: true });
    rmSync(socketRoot, { recursive: true, force: true });
  });

  const servers = [
    { alias: "web1", user },
    { alias: "jumped", user },
  ];

  function confinedShell() {
    const base = realpathSync(mkdtempSync(join(root, "launch-")));
    const checkout = join(base, "checkout");
    const work = join(base, "work");
    const scripts = join(base, "scripts");
    for (const directory of [checkout, work, scripts]) mkdirSync(directory, { mode: 0o700 });
    const port = new RepositoryTestProcessPort({
      receiptDirectory: join(base, "receipts"),
      temporaryDirectory: work,
      harnessShellScriptDirectory: scripts,
    });
    const shell = createNativeHarnessShell({
      process: port,
      scriptDirectory: scripts,
      sshAgentSocket: () => agentSocket,
      egress: {
        scope: { threadId: "t" as never, projectId: "p" as never },
        launchId: () => "l" as never,
        startLaunch: async () => ({
          status: "listening",
          launch: {
            // No egress proxy listens here: only the server relays carry bytes.
            proxy: { endpoint: { kind: "loopback", port: 9 }, token: "token" },
            finish: async () => ({ status: "summarized", summary: {} as never }),
          } as never,
        }),
      },
      serverAccess: (command, folder) =>
        openServerSshAccessFor(command, folder, servers, {
          personAgentSocket: () => agentSocket,
          resolve: (alias) => resolveWithPersonConfig(alias, personConfig),
          socketParent: socketRoot,
        }),
    });
    return { shell, checkout };
  }

  it("runs a remote command on the registered server through the sandbox", async () => {
    const { shell, checkout } = confinedShell();
    const run = await shell.run({
      command: "ssh web1 echo confined-hello",
      cwd: checkout,
      timeoutMs: 20_000,
    });
    expect(run.output).toContain("confined-hello");
    expect(run).toMatchObject({ status: "ran", exitCode: 0 });
  }, 30_000);

  it("copies a file down with scp and rsync into the folder", async () => {
    const { shell, checkout } = confinedShell();
    const scp = await shell.run({
      command: `scp web1:${remoteFile} got-scp.log`,
      cwd: checkout,
      timeoutMs: 20_000,
    });
    expect(scp).toMatchObject({ status: "ran", exitCode: 0 });
    expect(readFileSync(join(checkout, "got-scp.log"), "utf8")).toBe("served-by-sshd\n");
    const rsync = await shell.run({
      command: `rsync web1:${remoteFile} got-rsync.log`,
      cwd: checkout,
      timeoutMs: 20_000,
    });
    expect(rsync).toMatchObject({ status: "ran", exitCode: 0 });
    expect(readFileSync(join(checkout, "got-rsync.log"), "utf8")).toBe("served-by-sshd\n");
  }, 30_000);

  it("reaches no server the command does not name plainly, nor the server's port directly", async () => {
    const { shell, checkout } = confinedShell();
    for (const command of [
      `cd . && ssh web1 echo reached`,
      `ssh unregistered echo reached`,
      `ssh -p ${String(sshdPort)} 127.0.0.1 echo reached`,
      `ssh jumped echo reached`,
      `/usr/bin/nc -w 3 127.0.0.1 ${String(sshdPort)} </dev/null && echo reached`,
    ]) {
      const run = await shell.run({ command, cwd: checkout, timeoutMs: 20_000 });
      expect(run.output, command).not.toContain("reached\n");
    }
  }, 60_000);

  it("keeps the key and the person's agent out of a command's reach", async () => {
    const { shell, checkout } = confinedShell();
    for (const command of [
      `cat ${join(root, "userkey")}`,
      `SSH_AUTH_SOCK=${agentSocket} /usr/bin/ssh-add -l`,
    ]) {
      const run = await shell.run({ command, cwd: checkout, timeoutMs: 20_000 });
      expect(run.status === "ran" ? run.exitCode : undefined, command).not.toBe(0);
    }
  }, 30_000);

  it("lets the host's agent socket list keys and sign, never remove or add one", async () => {
    const folder = realpathSync(mkdtempSync(join(root, "access-")));
    const access = await openServerSshAccessFor("ssh web1 true", folder, servers, {
      personAgentSocket: () => agentSocket,
      resolve: (alias) => resolveWithPersonConfig(alias, personConfig),
      socketParent: socketRoot,
    });
    expect(access?.agentSocket).toBeDefined();
    // Run apart from this process: the host's socket answers on its event loop.
    const through = (args: ReadonlyArray<string>) =>
      new Promise<number | null>((done) => {
        const child = spawn("/usr/bin/ssh-add", [...args], {
          env: { ...process.env, SSH_AUTH_SOCK: access?.agentSocket ?? "" },
          stdio: "ignore",
        });
        child.on("exit", (code) => done(code));
      });
    expect(await through(["-l"])).toBe(0);
    expect(await through(["-D"])).not.toBe(0);
    expect(await through(["-q", join(root, "hostkey")])).not.toBe(0);
    await access?.close();
    const listed = spawnSync("/usr/bin/ssh-add", ["-l"], {
      env: { ...process.env, SSH_AUTH_SOCK: agentSocket },
      encoding: "utf8",
    });
    expect(listed.stdout.trim().split("\n")).toHaveLength(1);
    expect(existsSync(access?.agentSocket ?? "")).toBe(false);
  }, 30_000);
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
  });
}

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the test server.");
}
