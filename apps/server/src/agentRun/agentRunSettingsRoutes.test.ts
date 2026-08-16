import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Schema } from "effect";
import { AgentRunPolicySettings, decodeWindowId } from "@octant/contracts";
import { EventActor } from "@octant/contracts/events";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite } from "../persistence/sqlitePort";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { AGENT_RUN_SETTINGS_UPDATED, AgentRunSettingsStore } from "./agentRunSettingsStore";
import { createAgentRunSettingsRouteHandler } from "./agentRunSettingsRoutes";

const directories: string[] = [];
const now = "2026-08-01T15:00:00.000Z";
afterEach(() => {
  while (directories.length) {
    const d = directories.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

const windowId = decodeWindowId("11111111-1111-4111-8111-111111111111");
const capability = () => randomBytes(32).toString("base64url");
const actor = Schema.decodeUnknownSync(EventActor)({
  kind: "local-user",
  actorId: "77777777-7777-4777-8777-777777777777",
});

function createHandler() {
  const directory = mkdtempSync(join(tmpdir(), "octant-agentrun-settings-routes-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const registry = new EventRegistry().register(
    AGENT_RUN_SETTINGS_UPDATED,
    1,
    AgentRunPolicySettings,
  );
  const projections = new ProjectionRegistry().register(new AggregateHeadsProjection());
  const journal = new Journal({ connection, registry, projections, clock: () => now });
  let uuidCounter = 0;
  const uuid = () => {
    uuidCounter += 1;
    return `aaaaaaaa-aaaa-4aaa-8aaa-${uuidCounter.toString(16).padStart(12, "0")}`;
  };
  const store = new AgentRunSettingsStore({ journal, uuid, actor, clock: () => now });
  const windowAuthorityStore = new WindowAuthorityStore();
  const token = capability();
  windowAuthorityStore.register({ windowId, capability: token, now: 0 });
  const handler = createAgentRunSettingsRouteHandler({ windowAuthorityStore, store, now: () => 0 });
  return { handler, store, token };
}

describe("agentRunSettingsRoutes", () => {
  it("returns the current settings for an authenticated window", async () => {
    const { handler, token } = createHandler();
    const response = await handler(
      new Request("http://127.0.0.1/api/agent-run-settings", {
        headers: { "x-octant-window-capability": token },
      }),
    );
    expect(response?.status).toBe(200);
    const body = (await response!.json()) as { settings: { creationPosture: string } };
    expect(body.settings.creationPosture).toBe("ask");
  });

  it("rejects unauthenticated reads", async () => {
    const { handler } = createHandler();
    const response = await handler(new Request("http://127.0.0.1/api/agent-run-settings"));
    expect(response?.status).toBe(401);
  });

  it("updates the posture and persists it", async () => {
    const { handler, store, token } = createHandler();
    const response = await handler(
      new Request("http://127.0.0.1/api/agent-run-settings", {
        method: "PUT",
        headers: {
          "x-octant-window-capability": token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ creationPosture: "off", expectedVersion: 0 }),
      }),
    );
    expect(response?.status).toBe(200);
    expect(store.current().creationPosture).toBe("off");
  });

  it("returns 409 on a stale expected version instead of silently applying it", async () => {
    const { handler, token } = createHandler();
    await handler(
      new Request("http://127.0.0.1/api/agent-run-settings", {
        method: "PUT",
        headers: {
          "x-octant-window-capability": token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ creationPosture: "automatic", expectedVersion: 0 }),
      }),
    );
    const stale = await handler(
      new Request("http://127.0.0.1/api/agent-run-settings", {
        method: "PUT",
        headers: {
          "x-octant-window-capability": token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ creationPosture: "off", expectedVersion: 0 }),
      }),
    );
    expect(stale?.status).toBe(409);
  });

  it("rejects an unauthenticated update", async () => {
    const { handler } = createHandler();
    const response = await handler(
      new Request("http://127.0.0.1/api/agent-run-settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ creationPosture: "off", expectedVersion: 0 }),
      }),
    );
    expect(response?.status).toBe(401);
  });
});
