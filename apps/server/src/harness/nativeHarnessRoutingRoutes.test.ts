import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  EventActor,
  decodeNativeHarnessSlotCandidate,
  decodeProjectId,
  decodeWindowId,
} from "@octant/contracts";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite } from "../persistence/sqlitePort";
import { bindPrincipalRouteContext } from "../principalRouteContext";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { registerNativeHarnessEvents } from "./nativeHarnessEvents";
import { createNativeHarnessRoutingRouteHandler } from "./nativeHarnessRoutingRoutes";
import { NativeHarnessRoutingStore } from "./nativeHarnessRoutingStore";

const directories: string[] = [];
const now = "2026-11-15T12:00:00.000Z";
const windowId = decodeWindowId("00000000-0000-4000-8000-000000000611");
const actor = Schema.decodeUnknownSync(EventActor)({
  kind: "local-user",
  actorId: "77777777-7777-4777-8777-777777777777",
});
const model = decodeNativeHarnessSlotCandidate({
  hostId: "00000000-0000-4000-8000-0000000000aa",
  providerInstanceId: "00000000-0000-4000-8000-000000000001",
  modelId: "big",
});

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "octant-routing-routes-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  let counter = 0;
  const store = new NativeHarnessRoutingStore({
    journal: new Journal({
      connection,
      registry: registerNativeHarnessEvents(new EventRegistry()),
      projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
      clock: () => now,
    }),
    uuid: () => `aaaaaaaa-aaaa-4aaa-8aaa-${(++counter).toString(16).padStart(12, "0")}`,
    actor,
    clock: () => now,
  });
  const handler = createNativeHarnessRoutingRouteHandler({
    windowAuthorityStore: new WindowAuthorityStore(),
    store,
  });
  const put = (authenticated: boolean) => {
    const request = new Request("http://127.0.0.1/api/native-harness/routing", {
      method: "PUT",
      body: JSON.stringify({
        configuration: {
          slots: [{ id: "deep", candidates: [model], askBeforeUsing: true }],
          jobSlots: [],
        },
        expectedVersion: 0,
      }),
    });
    if (authenticated) {
      bindPrincipalRouteContext(request, {
        principal: { kind: "local-window" } as never,
        scopeId: windowId,
      });
    }
    return handler(request);
  };
  const projectRead = (projectId: string) => {
    const request = new Request(
      `http://127.0.0.1/api/native-harness/routing/projects/${projectId}`,
    );
    bindPrincipalRouteContext(request, {
      principal: { kind: "local-window" } as never,
      scopeId: windowId,
    });
    return handler(request);
  };
  return { store, put, projectRead };
}

describe("native harness role routes", () => {
  it("refuses a role change that does not come from a person's window and changes nothing", async () => {
    const { store, put } = fixture();
    const response = await put(false);
    expect(response?.status).toBe(401);
    expect(store.host().version).toBe(0);
  });

  it("saves a role and its flags when a person's window asks", async () => {
    const { store, put } = fixture();
    const response = await put(true);
    expect(response?.status).toBe(200);
    expect(store.host().configuration.slots[0]?.askBeforeUsing).toBe(true);
  });

  it("tells a client the version a cleared Project override still has, so it can set one again", async () => {
    const { store, projectRead } = fixture();
    const projectId = decodeProjectId("00000000-0000-4000-8000-0000000000ee");
    store.updateHost({
      configuration: { slots: [{ id: "deep" as never, candidates: [model] }], jobSlots: [] },
      expectedVersion: 0 as never,
    });
    store.applyProjectCommand({
      kind: "set-project-routing-override",
      projectId,
      configuration: { slots: [{ id: "deep" as never, candidates: [model] }], jobSlots: [] },
      expectedVersion: 0 as never,
    });
    store.applyProjectCommand({
      kind: "clear-project-routing-override",
      projectId,
      expectedVersion: 1 as never,
    });
    const body = (await (await projectRead(String(projectId)))?.json()) as {
      override: unknown;
      version: number;
    };
    expect(body).toEqual({ override: null, version: 2 });
  });
});
