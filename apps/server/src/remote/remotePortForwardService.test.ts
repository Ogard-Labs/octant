import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeCodeThreadId,
  decodeRemotePortForwardRequest,
  type EventActor,
  type RemotePortForwardRequest,
  type RemoteServerGrantSource,
} from "@octant/contracts";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { takeWebSocketUpgrade, type WebSocketMessage } from "../webSocketRelay";
import {
  RemotePortForwardService,
  type ObserveForwardedServer,
  type RemotePortForwardServiceOptions,
} from "./remotePortForwardService";
import type { RemoteThreadServerObservation } from "./remoteServerGrantService";

const DEVICE = "33333333-3333-4333-8333-333333333333";
const SESSION = "a".repeat(64);
const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function echoServer(): Promise<number> {
  const server = createServer((socket) => socket.pipe(socket));
  servers.push(server);
  return await new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    }),
  );
}

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const HOST_ACTOR: EventActor = {
  kind: "system",
  actorId: OCTANT_LOCAL_ACTOR_ID,
};

function openJournal(connection?: SqliteConnection) {
  let store = connection;
  if (store === undefined) {
    const directory = mkdtempSync(join(tmpdir(), "octant-port-forwards-"));
    directories.push(directory);
    store = openSqlite(join(directory, "store.sqlite3"));
    applyMigrations(store, MIGRATIONS, () => "2026-11-21T10:00:00.000Z");
  }
  const runtime = createPhase1RuntimeRegistries();
  return {
    connection: store,
    journal: new Journal({
      connection: store,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => "2026-11-21T10:00:00.000Z",
    }),
  };
}

function service(
  now: () => number = () => 1_000,
  connection?: SqliteConnection,
  hub: Pick<RemotePortForwardServiceOptions, "hubActScope" | "threadProjectId"> = {},
) {
  const opened = openJournal(connection);
  const forwards = new RemotePortForwardService({
    journal: opened.journal,
    hostActor: HOST_ACTOR,
    uuid: randomUUID,
    clock: () => "2026-11-21T10:00:00.000Z",
    now,
    ...hub,
  });
  const appended = (): ReadonlyArray<{ readonly name: string; readonly payload: unknown }> =>
    (
      opened.connection
        .prepare(
          `SELECT event_name, payload_json FROM event_journal
           WHERE aggregate_type = 'remote-port-forward' ORDER BY global_sequence`,
        )
        .all() as ReadonlyArray<{ readonly event_name: string; readonly payload_json: string }>
    ).map((row) => ({ name: row.event_name, payload: JSON.parse(row.payload_json) }));
  return { forwards, appended, connection: opened.connection };
}

const request = (port: number) =>
  decodeRemotePortForwardRequest({
    kind: "open-remote-port-forward",
    requestId: "44444444-4444-4444-8444-444444444444",
    port,
  });

describe("a port forward on a paired computer", () => {
  it("carries a connection's bytes both ways to the port on this computer's loopback", async () => {
    const port = await echoServer();
    const { forwards, appended } = service();
    const opened = await forwards.open({
      deviceId: DEVICE,
      asker: "host-person",
      sessionIdDigest: SESSION,
      request: request(port),
    });
    if (opened.kind !== "remote-port-forward-opened") throw new Error(opened.message);
    expect(appended()).toEqual([
      {
        name: "remote-server.forward-opened@1",
        payload: { forwardId: opened.forward.forwardId, deviceId: DEVICE, port },
      },
    ]);

    const upgrade = await forwards.accept({
      deviceId: DEVICE,
      sessionIdDigest: SESSION,
      forwardId: String(opened.forward.forwardId),
    });
    if (upgrade.kind !== "upgraded") throw new Error(upgrade.reason);
    const acceptance = takeWebSocketUpgrade(upgrade.response);
    if (acceptance === undefined) throw new Error("no acceptance");
    const received: WebSocketMessage[] = [];
    const echoed = new Promise<void>((resolve) => {
      const events = acceptance.open({
        send: (message) => {
          received.push(message);
          resolve();
        },
        close: () => undefined,
      });
      setTimeout(() => events.message({ text: false, data: Buffer.from("ping") }), 20);
    });
    await echoed;
    expect(Buffer.from(received[0]?.data ?? []).toString("utf8")).toBe("ping");
    // An open connection keeps its proxy session from idling out.
    expect(forwards.holdsOpenConnections(SESSION)).toBe(true);
    expect(forwards.holdsOpenConnections("b".repeat(64))).toBe(false);
  });

  it("refuses an agent grant's forward, and any other device's or session's connection", async () => {
    const { forwards } = service();
    expect(
      await forwards.open({
        deviceId: DEVICE,
        asker: "agent-grant",
        sessionIdDigest: SESSION,
        request: request(5432),
      }),
    ).toMatchObject({ kind: "remote-port-forward-refused", reason: "not-the-person" });

    const opened = await forwards.open({
      deviceId: DEVICE,
      asker: "host-person",
      sessionIdDigest: SESSION,
      request: request(5432),
    });
    if (opened.kind !== "remote-port-forward-opened") throw new Error(opened.message);
    const forwardId = String(opened.forward.forwardId);
    expect(
      await forwards.accept({
        deviceId: "55555555-5555-4555-8555-555555555555",
        sessionIdDigest: SESSION,
        forwardId,
      }),
    ).toEqual({ kind: "refused", reason: "forward-closed" });
    expect(
      await forwards.accept({ deviceId: DEVICE, sessionIdDigest: "b".repeat(64), forwardId }),
    ).toEqual({
      kind: "refused",
      reason: "forward-closed",
    });
  });

  it("ends after its hour and with its proxy session, journaled with the port alone", async () => {
    let now = 1_000;
    const { forwards, appended } = service(() => now);
    for (const port of [5432, 6379]) {
      await forwards.open({
        deviceId: DEVICE,
        asker: "host-person",
        sessionIdDigest: SESSION,
        request: request(port),
      });
    }
    forwards.closeSession(SESSION);
    expect(forwards.openCount()).toBe(0);
    expect(
      appended().filter((event) => event.name === "remote-server.forward-closed@1"),
    ).toHaveLength(2);

    const opened = await forwards.open({
      deviceId: DEVICE,
      asker: "host-person",
      sessionIdDigest: SESSION,
      request: request(5432),
    });
    now += 60 * 60 * 1000;
    forwards.sweep();
    expect(forwards.openCount()).toBe(0);
    expect(appended().at(-1)).toMatchObject({
      name: "remote-server.forward-closed@1",
      payload: {
        port: 5432,
        reason: "expired",
        ...(opened.kind === "remote-port-forward-opened"
          ? { forwardId: opened.forward.forwardId }
          : {}),
      },
    });
  });

  it("cuts every forward of a revoked device even when the journal refuses the closing record", async () => {
    const opened = openJournal();
    let full = false;
    const forwards = new RemotePortForwardService({
      journal: {
        aggregateVersions: (type) => opened.journal.aggregateVersions(type),
        replayAggregateType: (input) => opened.journal.replayAggregateType(input),
        append: (input) => {
          if (full) throw new Error("disk full");
          return opened.journal.append(input);
        },
      },
      hostActor: HOST_ACTOR,
      uuid: randomUUID,
      clock: () => "2026-11-21T10:00:00.000Z",
      now: () => 1_000,
    });
    for (const port of [5432, 6379]) {
      await forwards.open({
        deviceId: DEVICE,
        asker: "host-person",
        sessionIdDigest: SESSION,
        request: request(port),
      });
    }
    full = true;
    expect(() => forwards.closeDevice(DEVICE)).not.toThrow();
    expect(forwards.openCount()).toBe(0);
  });

  it("ends a connection whose port stops reading instead of queueing without bound", async () => {
    // A service that accepts the connection and never reads it.
    const accepted: Socket[] = [];
    const silent = createServer((socket) => {
      accepted.push(socket);
      socket.pause();
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const address = silent.address();
    if (address === null || typeof address === "string") throw new Error("missing address");
    // Connected before any byte is sent, so the queue grows because the
    // service does not read, not because the connection is still opening.
    const tcp = connect({ host: "127.0.0.1", port: address.port });
    await new Promise<void>((resolve) => tcp.once("connect", () => resolve()));
    const stalled = new RemotePortForwardService({
      journal: openJournal().journal,
      hostActor: HOST_ACTOR,
      uuid: randomUUID,
      clock: () => "2026-11-21T10:00:00.000Z",
      now: () => 1_000,
      connect: () => tcp,
    });
    const held = await stalled.open({
      deviceId: DEVICE,
      asker: "host-person",
      sessionIdDigest: SESSION,
      request: request(address.port),
    });
    if (held.kind !== "remote-port-forward-opened") throw new Error(held.message);
    const upgrade = await stalled.accept({
      deviceId: DEVICE,
      sessionIdDigest: SESSION,
      forwardId: String(held.forward.forwardId),
    });
    if (upgrade.kind !== "upgraded") throw new Error(upgrade.reason);
    const acceptance = takeWebSocketUpgrade(upgrade.response);
    if (acceptance === undefined) throw new Error("no acceptance");
    const closes: number[] = [];
    const events = acceptance.open({ send: () => undefined, close: (code) => closes.push(code) });
    const chunk = Buffer.alloc(1024 * 1024);
    for (let sent = 0; sent < 64 && closes.length === 0; sent += 1) {
      events.message({ text: false, data: chunk });
    }
    expect(closes).toEqual([1009]);
    events.closed(1000, "");
    stalled.closeAll();
    tcp.destroy();
    for (const socket of accepted) socket.destroy();
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  });

  it("refuses past four forwards per device", async () => {
    const { forwards } = service();
    for (let port = 5000; port < 5004; port += 1) {
      await forwards.open({
        deviceId: DEVICE,
        asker: "host-person",
        sessionIdDigest: SESSION,
        request: request(port),
      });
    }
    expect(
      await forwards.open({
        deviceId: DEVICE,
        asker: "host-person",
        sessionIdDigest: SESSION,
        request: request(5005),
      }),
    ).toMatchObject({ reason: "forward-limit" });
  });

  it("records a forward a stopped run left open as closed when the host starts again", async () => {
    const first = service();
    const opened = await first.forwards.open({
      deviceId: DEVICE,
      asker: "host-person",
      sessionIdDigest: SESSION,
      request: request(8123),
    });
    if (opened.kind !== "remote-port-forward-opened") throw new Error(opened.message);

    const restarted = service(() => 1_000, first.connection);
    restarted.forwards.closeLeftOpen();
    restarted.forwards.closeLeftOpen();
    expect(restarted.appended().map((event) => event.name)).toEqual([
      "remote-server.forward-opened@1",
      "remote-server.forward-closed@1",
    ]);
    expect(restarted.appended().at(-1)?.payload).toEqual({
      forwardId: opened.forward.forwardId,
      deviceId: DEVICE,
      port: 8123,
      reason: "host-stopped",
    });
  });
});

const THREAD = decodeCodeThreadId("77777777-7777-4777-8777-777777777777");
const OTHER_THREAD = decodeCodeThreadId("66666666-6666-4666-8666-666666666666");
const ACT_PROJECT = "88888888-8888-4888-8888-888888888888";
const OTHER_PROJECT = "99999999-9999-4999-8999-999999999999";
const LISTENER = `lsn_${"c".repeat(32)}`;

const serverRequest = (source: unknown) =>
  decodeRemotePortForwardRequest({
    kind: "open-remote-port-forward",
    requestId: "44444444-4444-4444-8444-444444444444",
    source,
  });

const threadServer = (threadId: string = String(THREAD), projectId: string = ACT_PROJECT) =>
  serverRequest({ surface: "local-servers", threadId, projectId, listenerId: LISTENER });

const runningServiceRow = () =>
  serverRequest({ surface: "running-services", listenerId: LISTENER });

/**
 * A member in a hub whose Act item names `act.projects` while `act.ticked`,
 * one Code thread in each Project, and a listing that answers `observed`.
 */
function hubMember(observed: { value: RemoteThreadServerObservation }) {
  const act: { ticked: boolean; projects: ReadonlyArray<string> } = {
    ticked: true,
    projects: [ACT_PROJECT],
  };
  const projects = new Map([
    [String(THREAD), ACT_PROJECT],
    [String(OTHER_THREAD), OTHER_PROJECT],
  ]);
  const looked: RemoteServerGrantSource[] = [];
  const observeServer: ObserveForwardedServer = async (source) => {
    looked.push(source);
    return observed.value;
  };
  const opened = service(() => 1_000, undefined, {
    hubActScope: () => ({
      decide: (projectId) => {
        if (!act.ticked) return { status: "refused", kind: "act-not-granted" };
        return act.projects.includes(projectId)
          ? { status: "allowed" }
          : { status: "refused", kind: "project-not-named" };
      },
    }),
    threadProjectId: (threadId) => projects.get(String(threadId)),
  });
  return { ...opened, act, observeServer, looked };
}

/** Opens one connection of a forward and echoes a ping through it, or says why it was refused. */
async function connectThrough(
  forwards: RemotePortForwardService,
  forwardId: string,
  observeServer: ObserveForwardedServer,
): Promise<string> {
  const upgrade = await forwards.accept({
    deviceId: DEVICE,
    sessionIdDigest: SESSION,
    forwardId,
    observeServer,
  });
  if (upgrade.kind !== "upgraded") return upgrade.reason;
  const acceptance = takeWebSocketUpgrade(upgrade.response);
  if (acceptance === undefined) throw new Error("no acceptance");
  const received: WebSocketMessage[] = [];
  await new Promise<void>((resolve) => {
    const events = acceptance.open({
      send: (message) => {
        received.push(message);
        resolve();
      },
      close: () => undefined,
    });
    setTimeout(() => events.message({ text: false, data: Buffer.from("ping") }), 20);
  });
  return Buffer.from(received[0]?.data ?? []).toString("utf8");
}

describe("a port forward for a device its person paired at Approve and steer", () => {
  it("forwards a thread's running server outside the hub's Act item, where the hub's device is refused", async () => {
    const port = await echoServer();
    const member = hubMember({ value: { kind: "held", threadId: OTHER_THREAD, port } });
    const open = (asker: "steering-device" | "hub-introduced") =>
      member.forwards.open({
        deviceId: DEVICE,
        asker,
        sessionIdDigest: SESSION,
        request: threadServer(String(OTHER_THREAD), OTHER_PROJECT),
        observeServer: member.observeServer,
      });

    expect(await open("hub-introduced")).toMatchObject({
      kind: "remote-port-forward-refused",
      reason: "outside-act",
    });
    const opened = await open("steering-device");
    expect(opened).toMatchObject({ kind: "remote-port-forward-opened", forward: { port } });
    // Still only a thread's own server, never a port it names.
    expect(
      await member.forwards.open({
        deviceId: DEVICE,
        asker: "steering-device",
        sessionIdDigest: SESSION,
        request: request(5173),
        observeServer: member.observeServer,
      }),
    ).toMatchObject({ kind: "remote-port-forward-refused", reason: "source-required" });
  });
});

describe("a port forward for a device the hub introduced", () => {
  it("a hub-introduced device forwards a port of a running server of a thread in an Act-named Project", async () => {
    const port = await echoServer();
    const member = hubMember({ value: { kind: "held", threadId: THREAD, port } });
    const opened = await member.forwards.open({
      deviceId: DEVICE,
      asker: "hub-introduced",
      sessionIdDigest: SESSION,
      request: threadServer(),
      observeServer: member.observeServer,
    });
    if (opened.kind !== "remote-port-forward-opened") throw new Error(opened.message);
    // The port is the one the host saw the thread's server hold, for an hour.
    expect(opened.forward.port).toBe(port);
    expect(opened.forward.expiresAt).toBe(1_000 + 60 * 60 * 1000);
    expect(member.appended()).toEqual([
      {
        name: "remote-server.forward-opened@2",
        payload: {
          forwardId: opened.forward.forwardId,
          deviceId: DEVICE,
          port,
          threadId: String(THREAD),
          projectId: ACT_PROJECT,
        },
      },
    ]);
    expect(
      await connectThrough(member.forwards, String(opened.forward.forwardId), member.observeServer),
    ).toBe("ping");
    // The thread's server was looked at to open and again to connect.
    expect(member.looked).toHaveLength(2);

    // A Running services row names no thread; the host learns it from the row.
    const fromRow = await member.forwards.open({
      deviceId: DEVICE,
      asker: "hub-introduced",
      sessionIdDigest: SESSION,
      request: runningServiceRow(),
      observeServer: member.observeServer,
    });
    expect(fromRow).toMatchObject({ kind: "remote-port-forward-opened", forward: { port } });
  });

  it("refuses a hub-introduced device's forward for a Project the Act item does not name, or a port no listed server holds, with a reason", async () => {
    const observed: { value: RemoteThreadServerObservation } = {
      value: { kind: "held", threadId: OTHER_THREAD, port: 5173 },
    };
    const member = hubMember(observed);
    const open = (forwardRequest: RemotePortForwardRequest) =>
      member.forwards.open({
        deviceId: DEVICE,
        asker: "hub-introduced",
        sessionIdDigest: SESSION,
        request: forwardRequest,
        observeServer: member.observeServer,
      });

    // A thread in a Project the item does not name is refused before its listing is read.
    expect(await open(threadServer(String(OTHER_THREAD), OTHER_PROJECT))).toMatchObject({
      kind: "remote-port-forward-refused",
      reason: "outside-act",
      message:
        "This computer's Act item for its hub does not name this Project, so a device the hub introduced cannot forward ports in it here.",
    });
    expect(member.looked).toEqual([]);
    // A Running services row whose server runs in such a thread, once the host sees whose it is.
    expect(await open(runningServiceRow())).toMatchObject({
      kind: "remote-port-forward-refused",
      reason: "outside-act",
    });

    // A port the device names itself, even one a listed server holds.
    expect(await open(request(5173))).toMatchObject({
      kind: "remote-port-forward-refused",
      reason: "source-required",
    });
    // A server no listing holds now, and one Octant did not start.
    observed.value = { kind: "refused", reason: "not-found" };
    expect(await open(threadServer())).toMatchObject({
      kind: "remote-port-forward-refused",
      reason: "not-found",
      message: "That server stopped or changed. Forward it again from its list.",
    });
    observed.value = { kind: "refused", reason: "not-octant-owned" };
    expect(await open(threadServer())).toMatchObject({ reason: "not-octant-owned" });

    // Act unticked refuses even the Project the item named.
    member.act.ticked = false;
    observed.value = { kind: "held", threadId: THREAD, port: 5173 };
    expect(await open(threadServer())).toMatchObject({
      reason: "outside-act",
      message:
        "This computer has not ticked Act for its hub, so a device the hub introduced cannot forward ports here.",
    });
    // An agent grant stays refused, server or port.
    expect(
      await member.forwards.open({
        deviceId: DEVICE,
        asker: "agent-grant",
        sessionIdDigest: SESSION,
        request: threadServer(),
        observeServer: member.observeServer,
      }),
    ).toMatchObject({ reason: "not-the-person" });
    expect(member.forwards.openCount()).toBe(0);
    expect(member.appended()).toEqual([]);

    // A computer in no hub keeps its own rule for such a device: no forward.
    const alone = service(() => 1_000, undefined, {
      hubActScope: () => ({ decide: () => ({ status: "not-in-a-hub" }) }),
      threadProjectId: () => ACT_PROJECT,
    });
    expect(
      await alone.forwards.open({
        deviceId: DEVICE,
        asker: "hub-introduced",
        sessionIdDigest: SESSION,
        request: threadServer(),
        observeServer: async () => ({ kind: "held", threadId: THREAD, port: 5173 }),
      }),
    ).toMatchObject({ kind: "remote-port-forward-refused", reason: "outside-act" });
  });

  it("a forward closes at its next connection once Act is unticked or the server stops holding the port", async () => {
    const port = await echoServer();
    const observed: { value: RemoteThreadServerObservation } = {
      value: { kind: "held", threadId: THREAD, port },
    };
    const member = hubMember(observed);
    const openOne = async () => {
      const opened = await member.forwards.open({
        deviceId: DEVICE,
        asker: "hub-introduced",
        sessionIdDigest: SESSION,
        request: threadServer(),
        observeServer: member.observeServer,
      });
      if (opened.kind !== "remote-port-forward-opened") throw new Error(opened.message);
      return String(opened.forward.forwardId);
    };

    const unnamed = await openOne();
    member.act.projects = [];
    expect(await connectThrough(member.forwards, unnamed, member.observeServer)).toBe(
      "forward-closed",
    );
    expect(member.appended().at(-1)).toMatchObject({
      name: "remote-server.forward-closed@1",
      payload: { forwardId: unnamed, port, reason: "outside-act" },
    });
    // Closed for good: naming the Project again does not reopen it.
    member.act.projects = [ACT_PROJECT];
    expect(await connectThrough(member.forwards, unnamed, member.observeServer)).toBe(
      "forward-closed",
    );

    // The thread's server moved off the port, and then stopped.
    const moved = await openOne();
    observed.value = { kind: "held", threadId: THREAD, port: port + 1 };
    expect(await connectThrough(member.forwards, moved, member.observeServer)).toBe(
      "forward-closed",
    );
    observed.value = { kind: "held", threadId: THREAD, port };
    const stopped = await openOne();
    observed.value = { kind: "refused", reason: "not-found" };
    expect(await connectThrough(member.forwards, stopped, member.observeServer)).toBe(
      "forward-closed",
    );
    expect(
      member
        .appended()
        .filter((event) => event.name === "remote-server.forward-closed@1")
        .map((event) => (event.payload as { readonly reason: string }).reason),
    ).toEqual(["outside-act", "server-gone", "server-gone"]);

    // A host that could not look refuses the connection and keeps the forward.
    observed.value = { kind: "held", threadId: THREAD, port };
    const kept = await openOne();
    observed.value = { kind: "unavailable" };
    expect(await connectThrough(member.forwards, kept, member.observeServer)).toBe("unavailable");
    observed.value = { kind: "held", threadId: THREAD, port };
    expect(await connectThrough(member.forwards, kept, member.observeServer)).toBe("ping");
  });

  it("a person-paired device still forwards any port", async () => {
    const port = await echoServer();
    const member = hubMember({ value: { kind: "unavailable" } });
    member.act.ticked = false;
    const opened = await member.forwards.open({
      deviceId: DEVICE,
      asker: "host-person",
      sessionIdDigest: SESSION,
      request: request(port),
      observeServer: member.observeServer,
    });
    if (opened.kind !== "remote-port-forward-opened") throw new Error(opened.message);
    expect(opened.forward.port).toBe(port);
    expect(
      await connectThrough(member.forwards, String(opened.forward.forwardId), member.observeServer),
    ).toBe("ping");
    // Neither the Act item nor any listing is read for a port the person picked.
    expect(member.looked).toEqual([]);
    expect(member.appended().map((event) => event.name)).toEqual([
      "remote-server.forward-opened@1",
    ]);
  });

  it("records a thread server's forward a stopped run left open as closed when the host starts again", async () => {
    const member = hubMember({ value: { kind: "held", threadId: THREAD, port: 5173 } });
    const opened = await member.forwards.open({
      deviceId: DEVICE,
      asker: "hub-introduced",
      sessionIdDigest: SESSION,
      request: threadServer(),
      observeServer: member.observeServer,
    });
    if (opened.kind !== "remote-port-forward-opened") throw new Error(opened.message);
    const restarted = service(() => 1_000, member.connection);
    restarted.forwards.closeLeftOpen();
    expect(restarted.appended().at(-1)).toEqual({
      name: "remote-server.forward-closed@1",
      payload: {
        forwardId: opened.forward.forwardId,
        deviceId: DEVICE,
        port: 5173,
        reason: "host-stopped",
      },
    });
  });
});
