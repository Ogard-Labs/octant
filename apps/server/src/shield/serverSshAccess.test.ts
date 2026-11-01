import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
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
import {
  CredentialStoreFailure,
  startCredentialBroker,
  type CredentialBroker,
  type CredentialStore,
} from "@octant/host-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RepositoryTestProcessPort } from "../code/repositoryTestProcessPort";
import { createNativeHarnessShell } from "../harness/nativeHarnessShell";
import {
  agentRequestAllowed,
  knownHostLineFor,
  openServerSshAccessFor,
  resolveWithPersonConfig,
} from "./serverSshAccess";
import { makeServerSshKeysBrokerClient, type ServerSshKeys } from "./sshKeyBrokerClient";

const KEYED = "5e7e0000-0000-4000-8000-0000000000c1";
const KEYLESS = "5e7e0000-0000-4000-8000-0000000000c2";

function memoryStore(): CredentialStore {
  const entries = new Map<string, string>();
  return {
    set: async (id, value) => void entries.set(id, value),
    has: async (id) => entries.has(id),
    resolve: async (id) => {
      const value = entries.get(id);
      if (value === undefined) throw new CredentialStoreFailure("missing");
      return value;
    },
    delete: async (id) => void entries.delete(id),
  };
}

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
// host and no key of the person's is ever involved. On Linux the command runs
// in Bubblewrap, so the test needs it there.
const linux = process.platform === "linux";
const canRun =
  existsSync("/usr/sbin/sshd") &&
  (process.platform === "darwin" || (linux && existsSync("/usr/bin/bwrap")));
const sftpServer = ["/usr/libexec/sftp-server", "/usr/lib/openssh/sftp-server"].find((path) =>
  existsSync(path),
);

describe.skipIf(!canRun)("a confined command reaching a registered server", () => {
  const started: ChildProcess[] = [];
  let root = "";
  let socketRoot = "";
  let agentSocket = "";
  let personConfig = "";
  let sshdPort = 0;
  let remoteFile = "";
  let broker: CredentialBroker | undefined;
  let keys: ServerSshKeys | undefined;
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
        `Subsystem sftp ${sftpServer ?? "internal-sftp"}`,
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
      [
        `Host web1 keyed keyless\n  HostName 127.0.0.1\n  Port ${String(sshdPort)}\n  UserKnownHostsFile ${join(root, "person_known_hosts")}`,
        "Host jumped\n  HostName 127.0.0.1\n  ProxyJump web1\n",
      ].join("\n"),
    );
    // The key Octant keeps for one server, made by a real broker, which the
    // person adds to that server's authorized keys.
    broker = await startCredentialBroker(
      memoryStore(),
      undefined,
      undefined,
      memoryStore(),
      memoryStore(),
      memoryStore(),
      memoryStore(),
      memoryStore(),
      memoryStore(),
      undefined,
      memoryStore(),
    );
    keys = makeServerSshKeysBrokerClient({ url: broker.url, token: broker.token });
    appendFileSync(join(root, "authorized_keys"), `${(await keys.ensure(KEYED)) ?? ""}\n`);
    remoteFile = join(root, "remote.log");
    writeFileSync(remoteFile, "served-by-sshd\n");
  }, 30_000);

  afterAll(async () => {
    await broker?.close();
    for (const child of started) child.kill();
    rmSync(root, { recursive: true, force: true });
    rmSync(socketRoot, { recursive: true, force: true });
  });

  const servers = [
    { alias: "web1", user },
    { alias: "jumped", user },
    { alias: "keyed", user, serverId: KEYED as never, signIn: "octant-key" as const },
    { alias: "keyless", user, serverId: KEYLESS as never, signIn: "octant-key" as const },
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
    // A Linux launch reaches its proxy through a socket in a folder of its
    // own, where the capsule's forwarder is written. Nothing listens there:
    // only the server relays carry bytes.
    const egressFolder = realpathSync(mkdtempSync(join(socketRoot, "egress-")));
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
            proxy: {
              endpoint: linux
                ? { kind: "unix-socket", path: join(egressFolder, "proxy.sock") }
                : { kind: "loopback", port: 9 },
              token: "token",
            },
            finish: async () => ({ status: "summarized", summary: {} as never }),
          } as never,
        }),
      },
      serverAccess: (command, folder) =>
        openServerSshAccessFor(command, folder, servers, {
          personAgentSocket: () => agentSocket,
          resolve: (alias) => resolveWithPersonConfig(alias, personConfig),
          socketParent: socketRoot,
          keys,
          ...(linux ? { relays: "unix-socket" as const } : {}),
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

  it("signs in with the key Octant keeps for a server, and never with the person's agent for it", async () => {
    const { shell, checkout } = confinedShell();
    const keyed = await shell.run({
      command: "ssh keyed echo keyed-hello",
      cwd: checkout,
      timeoutMs: 20_000,
    });
    expect(keyed.output).toContain("keyed-hello");
    expect(keyed).toMatchObject({ status: "ran", exitCode: 0 });
    // The person's agent holds a key the server accepts, but this server was
    // registered to sign in with Octant's key, and the broker holds none for it.
    const keyless = await shell.run({
      command: "ssh keyless echo keyless-hello",
      cwd: checkout,
      timeoutMs: 20_000,
    });
    expect(keyless.output).not.toContain("keyless-hello\n");
    expect(keyless.status === "ran" ? keyless.exitCode : undefined).not.toBe(0);
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
