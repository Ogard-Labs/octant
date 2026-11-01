import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, connect, type AddressInfo, type Socket } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

/**
 * A throwaway `sshd` and `ssh-agent` on loopback, owned by the test that
 * starts them: no real server and no key of the person's is ever involved.
 * The server is this machine, logged into as the current user with a key
 * made here, through a relay the test can cut to drop the connection.
 */
export const canRunThrowawaySshd =
  process.platform !== "win32" &&
  existsSync("/usr/sbin/sshd") &&
  existsSync("/usr/bin/ssh-keygen") &&
  existsSync("/usr/bin/ssh-agent");

export interface ThrowawaySshd {
  readonly root: string;
  readonly alias: string;
  /** An alias whose host key is not in the known hosts. */
  readonly unknownHostAlias: string;
  /** An alias where nothing listens. */
  readonly closedAlias: string;
  readonly user: string;
  readonly configFile: string;
  readonly agentSocket: string;
  /** Ends every connection passing through the relay now, as a dropped network would. */
  readonly dropConnections: () => void;
  readonly stop: () => void;
}

export async function startThrowawaySshd(): Promise<ThrowawaySshd> {
  const started: ChildProcess[] = [];
  const root = realpathSync(mkdtempSync(join(tmpdir(), "octant-server-test-")));
  // A Unix socket path has a short length limit, so the agent's lives in /tmp.
  const socketRoot = realpathSync(mkdtempSync("/tmp/octant-sshd-"));
  for (const name of ["hostkey", "userkey"]) {
    spawnSync("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(root, name)]);
  }
  writeFileSync(join(root, "authorized_keys"), readFileSync(join(root, "userkey.pub")), {
    mode: 0o600,
  });
  const sshdPort = await freePort();
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
    ].join("\n"),
  );
  started.push(
    spawn("/usr/sbin/sshd", ["-D", "-e", "-f", join(root, "sshd_config")], { stdio: "ignore" }),
  );
  const agentSocket = join(socketRoot, "agent");
  started.push(spawn("/usr/bin/ssh-agent", ["-D", "-a", agentSocket], { stdio: "ignore" }));
  await waitFor(() => existsSync(agentSocket));
  spawnSync("/usr/bin/ssh-add", ["-q", join(root, "userkey")], {
    env: { ...process.env, SSH_AUTH_SOCK: agentSocket },
  });
  await waitFor(() => portOpen(sshdPort));

  // The relay the person's config points at, so a test can drop the line.
  const relayed = new Set<Socket>();
  const relay = createServer((incoming) => {
    const outgoing = connect(sshdPort, "127.0.0.1");
    relayed.add(incoming);
    relayed.add(outgoing);
    incoming.pipe(outgoing).pipe(incoming);
    const forget = () => {
      relayed.delete(incoming);
      relayed.delete(outgoing);
      incoming.destroy();
      outgoing.destroy();
    };
    incoming.on("error", forget).on("close", forget);
    outgoing.on("error", forget).on("close", forget);
  });
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
  const relayPort = (relay.address() as AddressInfo).port;
  const closedPort = await freePort();

  const hostKey = readFileSync(join(root, "hostkey.pub"), "utf8").split(" ").slice(0, 2).join(" ");
  writeFileSync(join(root, "known_hosts"), `[127.0.0.1]:${String(relayPort)} ${hostKey}\n`);
  writeFileSync(join(root, "empty_known_hosts"), "");
  const configFile = join(root, "person_config");
  writeFileSync(
    configFile,
    [
      "Host web1",
      "  HostName 127.0.0.1",
      `  Port ${String(relayPort)}`,
      `  UserKnownHostsFile ${join(root, "known_hosts")}`,
      "Host stranger",
      "  HostName 127.0.0.1",
      `  Port ${String(relayPort)}`,
      `  UserKnownHostsFile ${join(root, "empty_known_hosts")}`,
      "Host closed",
      "  HostName 127.0.0.1",
      `  Port ${String(closedPort)}`,
      `  UserKnownHostsFile ${join(root, "known_hosts")}`,
      "",
    ].join("\n"),
  );
  return {
    root,
    alias: "web1",
    unknownHostAlias: "stranger",
    closedAlias: "closed",
    user: userInfo().username,
    configFile,
    agentSocket,
    dropConnections: () => {
      for (const socket of relayed) socket.destroy();
      relayed.clear();
    },
    stop: () => {
      relay.close();
      for (const socket of relayed) socket.destroy();
      for (const child of started) child.kill();
      rmSync(root, { recursive: true, force: true });
      rmSync(socketRoot, { recursive: true, force: true });
    },
  };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The throwaway sshd did not start in time.");
}
