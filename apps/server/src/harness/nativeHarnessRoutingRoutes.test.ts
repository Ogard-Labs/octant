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

function fixture(seen: ReadonlyArray<string> = []) {
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
  const asked: unknown[] = [];
  const handler = createNativeHarnessRoutingRouteHandler({
    windowAuthorityStore: new WindowAuthorityStore(),
    store,
    seesImages: (input) => {
      asked.push(input);
      return { kind: "available", describedBy: { model: "Haiku 5.5", provider: "Anthropic" } };
    },
    windowSeesProject: (_window, projectId) => seen.includes(String(projectId)),
  });
  const seesImages = (query: string) => {
    const request = new Request(`http://127.0.0.1/api/native-harness/routing/sees-images?${query}`);
    bindPrincipalRouteContext(request, {
      principal: { kind: "local-window" } as never,
      scopeId: windowId,
    });
    return handler(request);
  };
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
  return { store, put, projectRead, seesImages, asked };
}

describe("native harness role routes", () => {
  it("refuses to say whether Sees images works for a Project the window cannot see", async () => {
    const visible = "00000000-0000-4000-8000-0000000000e1";
    const hidden = "00000000-0000-4000-8000-0000000000e2";
    const { seesImages, asked } = fixture([visible]);
    const model = "providerInstanceId=00000000-0000-4000-8000-000000000001&modelId=luna";
    expect((await seesImages(`projectId=${hidden}&${model}`))?.status).toBe(403);
    expect(asked).toEqual([]);
    const answer = await seesImages(`projectId=${visible}&${model}`);
    expect(answer?.status).toBe(200);
    expect(await answer?.json()).toMatchObject({ kind: "available" });
    expect((await seesImages(model))?.status).toBe(200);
  });

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
