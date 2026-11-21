import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeRemotePortForwardRequest, type EventActor } from "@octant/contracts";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { takeWebSocketUpgrade, type WebSocketMessage } from "../webSocketRelay";
import { RemotePortForwardService } from "./remotePortForwardService";

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

function service(now: () => number = () => 1_000, connection?: SqliteConnection) {
  const opened = openJournal(connection);
  const forwards = new RemotePortForwardService({
    journal: opened.journal,
    hostActor: HOST_ACTOR,
    uuid: randomUUID,
    clock: () => "2026-11-21T10:00:00.000Z",
    now,
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
    const opened = forwards.open({
      deviceId: DEVICE,
      actsAsHostPerson: true,
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

    const upgrade = forwards.accept({
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

  it("refuses a device the computer's person did not pair, and any other device's or session's connection", () => {
    const { forwards } = service();
    expect(
      forwards.open({
        deviceId: DEVICE,
        actsAsHostPerson: false,
        sessionIdDigest: SESSION,
        request: request(5432),
      }),
    ).toMatchObject({ kind: "remote-port-forward-refused", reason: "not-the-person" });

    const opened = forwards.open({
      deviceId: DEVICE,
      actsAsHostPerson: true,
      sessionIdDigest: SESSION,
      request: request(5432),
    });
    if (opened.kind !== "remote-port-forward-opened") throw new Error(opened.message);
    const forwardId = String(opened.forward.forwardId);
    expect(
      forwards.accept({
        deviceId: "55555555-5555-4555-8555-555555555555",
        sessionIdDigest: SESSION,
        forwardId,
      }),
    ).toEqual({ kind: "refused", reason: "forward-closed" });
    expect(
      forwards.accept({ deviceId: DEVICE, sessionIdDigest: "b".repeat(64), forwardId }),
    ).toEqual({
      kind: "refused",
      reason: "forward-closed",
    });
  });

  it("ends after its hour and with its proxy session, journaled with the port alone", () => {
    let now = 1_000;
    const { forwards, appended } = service(() => now);
    for (const port of [5432, 6379]) {
      forwards.open({
        deviceId: DEVICE,
        actsAsHostPerson: true,
        sessionIdDigest: SESSION,
        request: request(port),
      });
    }
    forwards.closeSession(SESSION);
    expect(forwards.openCount()).toBe(0);
    expect(
      appended().filter((event) => event.name === "remote-server.forward-closed@1"),
    ).toHaveLength(2);

    const opened = forwards.open({
      deviceId: DEVICE,
      actsAsHostPerson: true,
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

  it("refuses past four forwards per device", () => {
    const { forwards } = service();
    for (let port = 5000; port < 5004; port += 1) {
      forwards.open({
        deviceId: DEVICE,
        actsAsHostPerson: true,
        sessionIdDigest: SESSION,
        request: request(port),
      });
    }
    expect(
      forwards.open({
        deviceId: DEVICE,
        actsAsHostPerson: true,
        sessionIdDigest: SESSION,
        request: request(5005),
      }),
    ).toMatchObject({ reason: "forward-limit" });
  });

  it("records a forward a stopped run left open as closed when the host starts again", () => {
    const first = service();
    const opened = first.forwards.open({
      deviceId: DEVICE,
      actsAsHostPerson: true,
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
