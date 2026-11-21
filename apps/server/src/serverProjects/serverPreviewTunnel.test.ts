import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessAuthorityClock } from "../processAuthorityClock";
import {
  ServerPreviewTunnels,
  serverPreviewSshArguments,
  type ServerPortForwardRecord,
} from "./serverPreviewTunnel";

const server = { alias: "web", user: "deploy" };
const owned: ServerPreviewTunnels[] = [];
afterEach(async () => {
  await Promise.all(owned.splice(0).map((tunnel) => tunnel.close()));
});
function fixture(
  now: () => number = () => Date.now(),
  extra: { readonly refuses?: () => string | undefined; readonly sshPath?: string } = {},
) {
  let current = true;
  const closedOwners = new Set<string>();
  const records: unknown[] = [];
  const forwards: ServerPortForwardRecord[] = [];
  const tunnels = new ServerPreviewTunnels({
    address: () => (current ? { server, identity: "binding-1" } : undefined),
    ownerCurrent: (owner) => !closedOwners.has(owner),
    agentSocket: () => undefined,
    record: (record) => {
      records.push(record);
      return true;
    },
    recordForward: (record) => {
      forwards.push(record);
      return true;
    },
    now,
    ...(extra.refuses === undefined ? {} : { refuses: extra.refuses }),
    ...(extra.sshPath === undefined ? {} : { sshPath: extra.sshPath }),
  });
  owned.push(tunnels);
  return {
    tunnels,
    records,
    forwards,
    revoke: () => {
      current = false;
    },
    closeOwner: (owner: string) => {
      closedOwners.add(owner);
    },
  };
}
describe("owned server previews", () => {
  it("uses a dedicated stdio forward while retaining command-channel trust restrictions", () => {
    const args = serverPreviewSshArguments(server, 5173);
    for (const option of [
      "ClearAllForwardings=yes",
      "BatchMode=yes",
      "StrictHostKeyChecking=yes",
      "ForwardAgent=no",
      "ControlPath=none",
      "ControlMaster=no",
    ])
      expect(args).toContain(option);
    expect(args.slice(-6)).toEqual(["-W", "127.0.0.1:5173", "-l", "deploy", "--", "web"]);
  });
  it("refuses an unavailable Project before listening or recording", async () => {
    const { tunnels, records, revoke } = fixture();
    revoke();
    expect(await tunnels.start("project", "window", 5173, 0)).toMatchObject({ kind: "refused" });
    expect(records).toEqual([]);
  });
  it("refuses a suspended machine before listening, and starts no ssh stream once it is suspended", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "octant-preview-ssh-"));
    const marker = join(scratch, "spawned");
    const ssh = join(scratch, "ssh");
    writeFileSync(ssh, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o755 });
    let suspended = true;
    const { tunnels, records } = fixture(undefined, {
      refuses: () => (suspended ? "This machine is suspended." : undefined),
      sshPath: ssh,
    });
    try {
      expect(await tunnels.start("project", "window", 5173, 0)).toEqual({
        kind: "refused",
        reason: "machine-suspended",
      });
      expect(records).toEqual([]);

      suspended = false;
      const opened = await tunnels.start("project", "window", 5173, 0);
      if (opened.kind !== "tunnel") throw new Error("Expected a listening preview");
      suspended = true;
      await new Promise<void>((resolve) => {
        const socket = connect(opened.view.localPort, "127.0.0.1");
        socket.on("close", () => resolve());
        socket.on("error", () => resolve());
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
  it("refuses a stale capability before creating a listener or recording ownership", async () => {
    const { tunnels, records } = fixture();
    expect(await tunnels.start("project", "window", 5173, 0, () => false)).toEqual({
      kind: "refused",
      reason: "owner-revoked",
    });
    expect(records).toEqual([]);
    expect(tunnels.read("project", "window")).toBeUndefined();
  });
  it("reports a port collision without replacing the listener", async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    const address = occupied.address();
    if (address === null || typeof address === "string") throw new Error("missing address");
    const { tunnels } = fixture();
    try {
      expect(await tunnels.start("project", "window", 5173, address.port)).toMatchObject({
        kind: "refused",
        reason: "port-unavailable",
      });
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });
  it("keeps the selected endpoint, refuses another owner and closes on binding removal", async () => {
    const { tunnels, revoke, records } = fixture();
    const opened = await tunnels.start("project", "window", 5173, 0);
    expect(opened.kind).toBe("tunnel");
    if (opened.kind !== "tunnel") return;
    expect(opened.view).toMatchObject({ remotePort: 5173, status: "listening" });
    expect(await tunnels.start("project", "other-window", 3000, 0)).toMatchObject({
      kind: "refused",
      reason: "already-owned",
    });
    revoke();
    await tunnels.reconcile();
    expect(tunnels.read("project", "window")).toMatchObject({ status: "revoked" });
    expect(records).toHaveLength(2);
    await expect(
      new Promise<void>((resolve, reject) => {
        const socket = connect(opened.view.localPort, "127.0.0.1");
        socket.on("connect", () => {
          socket.destroy();
          resolve();
        });
        socket.on("error", reject);
      }),
    ).rejects.toThrow();
  });
  it("lets another window open the Project's preview after the owning window closes", async () => {
    const { tunnels, closeOwner } = fixture();
    expect((await tunnels.start("project", "window", 5173, 0)).kind).toBe("tunnel");
    closeOwner("window");
    await tunnels.reconcile();
    expect(tunnels.read("project", "window")).toMatchObject({ status: "revoked" });
    const replaced = await tunnels.start("project", "other-window", 3000, 0);
    expect(replaced).toMatchObject({
      kind: "tunnel",
      view: { remotePort: 3000, status: "listening" },
    });
    expect(tunnels.read("project", "window")).toBeUndefined();
  });
  it("closes a tunnel after its hour of elapsed time even when the wall clock is set back", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const openedAt = Date.UTC(2026, 10, 1);
      vi.setSystemTime(openedAt);
      let elapsedMs = 1_000;
      const clock = new ProcessAuthorityClock({
        wallClock: () => Date.now(),
        suspendAwareElapsedSource: () => elapsedMs,
      });
      const { tunnels } = fixture(clock.now());
      expect((await tunnels.start("project", "window", 5173, 0)).kind).toBe("tunnel");
      elapsedMs += 60 * 60 * 1_000 + 1;
      vi.setSystemTime(openedAt - 60 * 60 * 1_000);
      await tunnels.reconcile();
      expect(tunnels.read("project", "window")).toMatchObject({ status: "revoked" });
    } finally {
      vi.useRealTimers();
    }
  });
});

/** A stand-in for `ssh -W 127.0.0.1:<port>` that joins its stdio to that port here. */
function standInSsh(scratch: string): string {
  const ssh = join(scratch, "ssh");
  writeFileSync(
    ssh,
    [
      `#!${process.execPath}`,
      `const net = require("node:net");`,
      `const target = process.argv[process.argv.indexOf("-W") + 1];`,
      `const socket = net.connect(Number(target.split(":")[1]), "127.0.0.1");`,
      `process.stdin.pipe(socket);`,
      `socket.pipe(process.stdout);`,
      `socket.on("close", () => process.exit(0));`,
      `socket.on("error", () => process.exit(255));`,
      ``,
    ].join("\n"),
    { mode: 0o755 },
  );
  return ssh;
}

function refusesConnection(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.on("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(true));
  });
}

describe("server port forwards", () => {
  it("forwards a TCP port on a server Project's server to this computer's loopback and carries bytes both ways", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "octant-forward-ssh-"));
    // The server's database, here on this computer's loopback, answers each
    // chunk so both directions are seen.
    const database = createServer((socket) => {
      socket.on("data", (chunk) => socket.write(`pong:${chunk.toString()}`));
    });
    await new Promise<void>((resolve) => database.listen(0, "127.0.0.1", resolve));
    const address = database.address();
    if (address === null || typeof address === "string") throw new Error("missing address");
    const remotePort = address.port;
    const { tunnels, forwards } = fixture(undefined, { sshPath: standInSsh(scratch) });
    try {
      const opened = await tunnels.startForward("project", "window", remotePort);
      if (opened.kind !== "forward") throw new Error(`Expected a forward, got ${opened.reason}`);
      // The stand-in database holds the server's port number on this computer,
      // so the forward listens on another free port of 127.0.0.1.
      expect(opened.view).toMatchObject({ projectId: "project", remotePort, status: "listening" });
      expect(opened.view.localPort).not.toBe(remotePort);
      const answer = await new Promise<string>((resolve, reject) => {
        const client = connect(opened.view.localPort, "127.0.0.1");
        client.on("connect", () => client.write("ping"));
        client.on("data", (chunk) => {
          resolve(chunk.toString());
          client.destroy();
        });
        client.on("error", reject);
      });
      expect(answer).toBe("pong:ping");
      expect(tunnels.readForward("project", "window")).toMatchObject({ status: "listening" });
      expect(tunnels.readForward("project", "other-window")).toBeUndefined();
      // A forward is not the Project's preview, which stays free to open.
      expect(tunnels.read("project", "window")).toBeUndefined();
      expect(forwards).toEqual([
        { event: "opened", projectId: "project", remotePort, localPort: opened.view.localPort },
      ]);
    } finally {
      await tunnels.close();
      await new Promise<void>((resolve) => database.close(() => resolve()));
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("still opens a forward for an unused Project after many Projects opened and stopped theirs", async () => {
    const { tunnels } = fixture();
    for (let index = 0; index < 64; index += 1) {
      const project = `project-${String(index)}`;
      const opened = await tunnels.startForward(project, "window", 5432);
      if (opened.kind !== "forward") throw new Error(`Expected a forward, got ${opened.reason}`);
      expect((await tunnels.stopForward(project, "window")).kind).toBe("forward");
    }
    expect((await tunnels.startForward("unused", "window", 5432)).kind).toBe("forward");
  });

  it("still delivers the reply of a service that answers only after the client finishes sending", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "octant-forward-half-close-"));
    const service = createServer({ allowHalfOpen: true }, (socket) => {
      const received: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => received.push(chunk));
      socket.on("end", () => socket.end(`reply:${Buffer.concat(received).toString()}`));
    });
    await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
    const address = service.address();
    if (address === null || typeof address === "string") throw new Error("missing address");
    const { tunnels } = fixture(undefined, { sshPath: standInSsh(scratch) });
    try {
      const opened = await tunnels.startForward("project", "window", address.port);
      if (opened.kind !== "forward") throw new Error(`Expected a forward, got ${opened.reason}`);
      const answer = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const client = connect({
          port: opened.view.localPort,
          host: "127.0.0.1",
          allowHalfOpen: true,
        });
        client.on("connect", () => client.end("request"));
        client.on("data", (chunk: Buffer) => chunks.push(chunk));
        client.on("end", () => {
          resolve(Buffer.concat(chunks).toString());
          client.destroy();
        });
        client.on("error", reject);
      });
      expect(answer).toBe("reply:request");
    } finally {
      await tunnels.close();
      await new Promise<void>((resolve) => service.close(() => resolve()));
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("a forward ends after its hour and at stop, journaled with the port alone", async () => {
    let now = 1_000;
    const { tunnels, forwards } = fixture(() => now);
    const first = await tunnels.startForward("project", "window", 5432);
    if (first.kind !== "forward") throw new Error(`Expected a forward, got ${first.reason}`);
    now += 60 * 60 * 1_000;
    await tunnels.reconcile();
    expect(tunnels.readForward("project", "window")).toMatchObject({ status: "revoked" });
    expect(await refusesConnection(first.view.localPort)).toBe(true);

    const second = await tunnels.startForward("project", "window", 5432);
    if (second.kind !== "forward") throw new Error(`Expected a forward, got ${second.reason}`);
    expect(await tunnels.stopForward("project", "window")).toMatchObject({
      kind: "forward",
      view: { status: "stopped" },
    });
    expect(await refusesConnection(second.view.localPort)).toBe(true);

    const third = await tunnels.startForward("project", "window", 5432);
    if (third.kind !== "forward") throw new Error(`Expected a forward, got ${third.reason}`);
    await tunnels.close();

    const ports = (localPort: number) => ({ projectId: "project", remotePort: 5432, localPort });
    expect(forwards).toEqual([
      { event: "opened", ...ports(first.view.localPort) },
      { event: "closed", ...ports(first.view.localPort), reason: "expired" },
      { event: "opened", ...ports(second.view.localPort) },
      { event: "closed", ...ports(second.view.localPort), reason: "stopped" },
      { event: "opened", ...ports(third.view.localPort) },
      { event: "closed", ...ports(third.view.localPort), reason: "host-stopped" },
    ]);
  });
});
