import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { EventActor, decodeUtcTimestamp, decodeWindowId } from "@octant/contracts";
import {
  BLOCKED_TOOLS_AGGREGATE_TYPE,
  PROVIDER_TOOL_BLOCKED_SET,
} from "@octant/contracts/blocked-tools";
import type {
  ProviderConnection,
  ProviderDriver,
  ProviderSessionResume,
  ProviderSessionStart,
} from "@octant/provider-sdk/driver";
import { AggregateHeadsProjection } from "./persistence/aggregateHeadsProjection";
import { EventRegistry } from "./persistence/eventRegistry";
import { Journal } from "./persistence/journal";
import { applyMigrations, MIGRATIONS } from "./persistence/migrations";
import { ProjectionRegistry } from "./persistence/projection";
import { openSqlite, type SqliteConnection } from "./persistence/sqlitePort";
import { bindPrincipalRouteContext } from "./principalRouteContext";
import {
  BLOCKED_TOOLS_COMMAND_PATH,
  BLOCKED_TOOLS_PATH,
  createBlockedToolsRouteHandler,
} from "./blockedToolsRoutes";
import { withBlockedTools } from "./providers/blockedToolsDriver";
import { BlockedToolsService, registerBlockedToolsEvents } from "./providers/blockedToolsService";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const now = "2026-11-18T10:00:00.000Z";
const actor = Schema.decodeUnknownSync(EventActor)({
  kind: "local-user",
  actorId: "99999999-9999-4999-8999-999999999999",
});
const windowId = decodeWindowId("75000000-0000-4000-8000-000000000001");
const capability = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop4";
const deviceId = "75000000-0000-4000-8000-0000000000de";
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-blocked-tools-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

function host(connection: SqliteConnection) {
  const journal = new Journal({
    connection,
    registry: registerBlockedToolsEvents(new EventRegistry()),
    projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
    clock: () => now,
  });
  const service = new BlockedToolsService({
    journal,
    uuid: () => crypto.randomUUID(),
    clock: () => decodeUtcTimestamp(now),
    actor,
  });
  const windowAuthorityStore = new WindowAuthorityStore();
  windowAuthorityStore.register({ windowId, capability, now: 0 });
  const handler = createBlockedToolsRouteHandler({ service, windowAuthorityStore, now: () => 0 });
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
  const remote = new Request(`http://127.0.0.1:3100${BLOCKED_TOOLS_COMMAND_PATH}`, {
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

const block = (
  version: number,
  provider: "claude" | "codex" | "opencode" | "pi" = "claude",
  tool = "WebFetch",
  blocked = true,
) => ({ kind: "set-provider-tool-blocked", provider, tool, blocked, expectedVersion: version });

describe("blocked provider tools in Settings", () => {
  it("starts empty, blocks a tool from a window, journals it, and keeps it after a restart", async () => {
    const connection = openConnection();
    const { handler, service } = host(connection);
    expect(service.settings().tools).toEqual([]);
    const response = await handler(fromWindow(BLOCKED_TOOLS_COMMAND_PATH, "POST", block(0)));
    expect(response?.status).toBe(200);
    expect(service.toolsFor("claude")).toEqual(["WebFetch"]);
    // A block is per provider: OpenCode's tool of the same name still runs.
    expect(service.toolsFor("opencode")).toEqual([]);

    const restarted = host(connection);
    expect(restarted.service.toolsFor("claude")).toEqual(["WebFetch"]);
    const events = [
      ...restarted.journal.replayAggregateType({
        aggregateType: BLOCKED_TOOLS_AGGREGATE_TYPE,
        afterSequence: 0,
        limit: 100,
      }),
    ];
    expect(events.map((event) => [event.eventName, event.actor])).toEqual([
      [PROVIDER_TOOL_BLOCKED_SET, actor],
    ]);
    const read = await restarted.handler(fromWindow(BLOCKED_TOOLS_PATH, "GET"));
    expect(await read?.json()).toMatchObject({
      tools: [{ provider: "claude", tool: "WebFetch" }],
      version: 1,
    });
  });

  it("lets a device the host's own person paired change the list, and refuses an agent, a hub device and a caller without a window", async () => {
    const { handler, service, journal } = host(openConnection());
    for (const refusedCaller of [
      fromDevice(block(0), "hub-roster"),
      fromDevice(block(0), undefined, "octant-agent-access"),
      fromDevice(block(0)),
    ]) {
      const response = await handler(refusedCaller);
      expect(response?.status).toBe(403);
      expect(await response?.json()).toMatchObject({ reason: "unauthorized" });
    }
    const withoutCapability = new Request(`http://127.0.0.1:3100${BLOCKED_TOOLS_COMMAND_PATH}`, {
      method: "POST",
      body: JSON.stringify(block(0)),
    });
    expect((await handler(withoutCapability))?.status).toBe(401);
    expect(service.toolsFor("claude")).toEqual([]);

    expect((await handler(fromDevice(block(0), "host-person")))?.status).toBe(200);
    expect(service.toolsFor("claude")).toEqual(["WebFetch"]);
    const [event] = [
      ...journal.replayAggregateType({
        aggregateType: BLOCKED_TOOLS_AGGREGATE_TYPE,
        afterSequence: 0,
        limit: 100,
      }),
    ];
    expect(event?.actor).toMatchObject({ kind: "remote-device", deviceId });
  });

  it("refuses a Codex tool Codex cannot switch off, a stale version and a malformed name", async () => {
    const { handler, service } = host(openConnection());
    const unsupported = await handler(
      fromWindow(BLOCKED_TOOLS_COMMAND_PATH, "POST", block(0, "codex", "apply_patch")),
    );
    expect(unsupported?.status).toBe(409);
    expect(await unsupported?.json()).toMatchObject({ reason: "unsupported" });
    expect(
      (await handler(fromWindow(BLOCKED_TOOLS_COMMAND_PATH, "POST", block(0, "codex", "shell"))))
        ?.status,
    ).toBe(200);
    expect(
      (
        await handler(
          fromWindow(BLOCKED_TOOLS_COMMAND_PATH, "POST", block(1, "codex", "docs__search")),
        )
      )?.status,
    ).toBe(200);
    expect(service.toolsFor("codex")).toEqual(["shell", "docs__search"]);
    const stale = await handler(
      fromWindow(BLOCKED_TOOLS_COMMAND_PATH, "POST", block(0, "codex", "shell", false)),
    );
    expect(await stale?.json()).toMatchObject({ reason: "stale-version" });
    const malformed = await handler(
      fromWindow(BLOCKED_TOOLS_COMMAND_PATH, "POST", block(2, "claude", "Web Fetch")),
    );
    expect(malformed?.status).toBe(400);
  });

  it("hands every session start and resume the provider's list as it is at that launch", async () => {
    let current: ReadonlyArray<string> = ["Bash"];
    const starts: Array<ProviderSessionStart> = [];
    const resumes: Array<ProviderSessionResume> = [];
    const connection = {
      start: (input: ProviderSessionStart) => {
        starts.push(input);
        return Effect.succeed({ sessionId: input.sessionId });
      },
      resume: (input: ProviderSessionResume) => {
        resumes.push(input);
        return Effect.succeed({ sessionId: input.sessionId });
      },
    } as unknown as ProviderConnection;
    const driver = withBlockedTools(
      { acquire: () => Effect.succeed(connection) } as unknown as ProviderDriver,
      () => current,
    );
    const acquired = await Effect.runPromise(Effect.scoped(driver.acquire({} as never)));
    const start = { sessionId: "s-1", modelId: "m", executionPolicy: "full-access" } as never;
    await Effect.runPromise(acquired.start(start));
    current = [];
    await Effect.runPromise(acquired.start(start));
    current = ["WebFetch"];
    await Effect.runPromise(
      acquired.resume({ sessionId: "s-1", executionPolicy: "plan", resumeCursor: {} } as never),
    );
    expect(starts.map((input) => input.blockedTools)).toEqual([["Bash"], undefined]);
    expect(resumes.map((input) => input.blockedTools)).toEqual([["WebFetch"]]);
  });
});
