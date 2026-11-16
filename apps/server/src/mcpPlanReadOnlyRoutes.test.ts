import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Schema } from "effect";
import { EventActor, decodeUtcTimestamp, decodeWindowId } from "@octant/contracts";
import {
  MCP_PLAN_READ_ONLY_AGGREGATE_TYPE,
  MCP_SERVER_PLAN_READ_ONLY_SET,
} from "@octant/contracts/mcp-plan-read-only";
import { AggregateHeadsProjection } from "./persistence/aggregateHeadsProjection";
import { EventRegistry } from "./persistence/eventRegistry";
import { Journal } from "./persistence/journal";
import { applyMigrations, MIGRATIONS } from "./persistence/migrations";
import { ProjectionRegistry } from "./persistence/projection";
import { openSqlite, type SqliteConnection } from "./persistence/sqlitePort";
import { bindPrincipalRouteContext } from "./principalRouteContext";
import {
  MCP_PLAN_READ_ONLY_COMMAND_PATH,
  MCP_PLAN_READ_ONLY_PATH,
  createMcpPlanReadOnlyRouteHandler,
} from "./mcpPlanReadOnlyRoutes";
import {
  McpPlanReadOnlyService,
  registerMcpPlanReadOnlyEvents,
} from "./providers/mcpPlanReadOnlyService";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const now = "2026-11-16T10:00:00.000Z";
const actor = Schema.decodeUnknownSync(EventActor)({
  kind: "local-user",
  actorId: "99999999-9999-4999-8999-999999999999",
});
const windowId = decodeWindowId("74000000-0000-4000-8000-000000000001");
const capability = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop4";
const deviceId = "74000000-0000-4000-8000-0000000000de";
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-mcp-plan-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

function host(connection: SqliteConnection) {
  const journal = new Journal({
    connection,
    registry: registerMcpPlanReadOnlyEvents(new EventRegistry()),
    projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
    clock: () => now,
  });
  const service = new McpPlanReadOnlyService({
    journal,
    uuid: () => crypto.randomUUID(),
    clock: () => decodeUtcTimestamp(now),
    actor,
  });
  const windowAuthorityStore = new WindowAuthorityStore();
  windowAuthorityStore.register({ windowId, capability, now: 0 });
  const handler = createMcpPlanReadOnlyRouteHandler({
    service,
    windowAuthorityStore,
    now: () => 0,
  });
  return { journal, service, handler };
}

function fromWindow(path: string, method: string, body?: unknown): Request {
  return new Request(`http://127.0.0.1:3100${path}`, {
    method,
    headers: { "content-type": "application/json", "x-octant-window-capability": capability },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function fromDevice(body: unknown, admittedBy?: "host-person" | "hub-roster", origin?: string) {
  const remote = new Request(`http://127.0.0.1:3100${MCP_PLAN_READ_ONLY_COMMAND_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  bindPrincipalRouteContext(remote, {
    principal: {
      kind: "remote-device",
      deviceId,
      ...(admittedBy === undefined ? {} : { admittedBy }),
      ...(origin === undefined ? {} : { origin }),
    } as never,
    scopeId: decodeWindowId(deviceId),
  });
  return remote;
}

const mark = (version: number, readOnly = true) => ({
  kind: "set-mcp-server-plan-read-only",
  provider: "claude",
  serverName: "docs-search",
  readOnly,
  expectedVersion: version,
});

describe("MCP servers allowed in Plan", () => {
  it("marks a server from a window, journals the mark, and keeps it after a restart", async () => {
    const connection = openConnection();
    const { handler, service } = host(connection);
    const response = await handler(fromWindow(MCP_PLAN_READ_ONLY_COMMAND_PATH, "POST", mark(0)));
    expect(response?.status).toBe(200);
    expect(service.serversFor("claude")).toEqual(["docs-search"]);
    // The mark is per provider: Codex's server of the same name stays withheld.
    expect(service.serversFor("codex")).toEqual([]);

    const restarted = host(connection);
    expect(restarted.service.serversFor("claude")).toEqual(["docs-search"]);
    const events = [
      ...restarted.journal.replayAggregateType({
        aggregateType: MCP_PLAN_READ_ONLY_AGGREGATE_TYPE,
        afterSequence: 0,
        limit: 100,
      }),
    ];
    expect(events.map((event) => [event.eventName, event.actor])).toEqual([
      [MCP_SERVER_PLAN_READ_ONLY_SET, actor],
    ]);
    const read = await restarted.handler(fromWindow(MCP_PLAN_READ_ONLY_PATH, "GET"));
    expect(await read?.json()).toMatchObject({
      servers: [{ provider: "claude", serverName: "docs-search" }],
      version: 1,
    });
  });

  it("marks a server from a device the host's own person paired, journaled as that device, and refuses every other remote caller", async () => {
    const connection = openConnection();
    const { handler, service, journal } = host(connection);
    for (const refusedCaller of [
      fromDevice(mark(0)),
      fromDevice(mark(0), "hub-roster"),
      fromDevice(mark(0), undefined, "octant-agent-access"),
    ]) {
      const response = await handler(refusedCaller);
      expect(response?.status).toBe(403);
      expect(await response?.json()).toMatchObject({ reason: "unauthorized" });
    }
    const withoutCapability = new Request(
      `http://127.0.0.1:3100${MCP_PLAN_READ_ONLY_COMMAND_PATH}`,
      { method: "POST", body: JSON.stringify(mark(0)) },
    );
    expect((await handler(withoutCapability))?.status).toBe(401);
    expect(service.serversFor("claude")).toEqual([]);

    expect((await handler(fromDevice(mark(0), "host-person")))?.status).toBe(200);
    expect(service.serversFor("claude")).toEqual(["docs-search"]);
    const [event] = [
      ...journal.replayAggregateType({
        aggregateType: MCP_PLAN_READ_ONLY_AGGREGATE_TYPE,
        afterSequence: 0,
        limit: 100,
      }),
    ];
    expect(event?.actor).toMatchObject({ kind: "remote-device", deviceId });
  });

  it("unmarks a server, refuses a stale version, and refuses a name a tool name could not carry", async () => {
    const { handler, service } = host(openConnection());
    await handler(fromWindow(MCP_PLAN_READ_ONLY_COMMAND_PATH, "POST", mark(0)));
    const stale = await handler(
      fromWindow(MCP_PLAN_READ_ONLY_COMMAND_PATH, "POST", mark(0, false)),
    );
    expect(await stale?.json()).toMatchObject({ reason: "stale-version" });
    await handler(fromWindow(MCP_PLAN_READ_ONLY_COMMAND_PATH, "POST", mark(1, false)));
    expect(service.serversFor("claude")).toEqual([]);
    const malformed = await handler(
      fromWindow(MCP_PLAN_READ_ONLY_COMMAND_PATH, "POST", {
        ...mark(2),
        serverName: "docs__search",
      }),
    );
    expect(malformed?.status).toBe(400);
  });
});
