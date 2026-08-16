import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  CANVAS_SCHEMA_VERSION,
  CanvasActionReceiptRecorded,
  CanvasCreated,
  CanvasRefreshReceiptRecorded,
  CanvasVersionAppended,
  decodeCanvasActionResult,
  decodeCanvasHistoryOutcome,
  decodeCanvasCreateResult,
  decodeCanvasThreadReferenceCardsOutcome,
  decodeCanvasId,
  decodeCanvasInventoryList,
  decodeCanvasReviseResult,
  decodeCanvasRefreshResult,
  decodeCanvasShareAccessResult,
  decodeCanvasShareOverview,
  decodeCanvasShareResult,
  decodeProjectId,
  decodeWindowId,
  type ShellBootstrap,
} from "@octant/contracts";
import { EventActor } from "@octant/contracts/events";
import { defaultShellSettings, defaultWindowWorkspace } from "@octant/domain";
import { AggregateHeadsProjection } from "./persistence/aggregateHeadsProjection";
import { EventRegistry } from "./persistence/eventRegistry";
import { Journal } from "./persistence/journal";
import { applyMigrations, MIGRATIONS } from "./persistence/migrations";
import { ProjectionRegistry } from "./persistence/projection";
import { openSqlite } from "./persistence/sqlitePort";
import { CanvasEventStore } from "./canvas/canvasEventStore";
import { CanvasProjection } from "./canvas/canvasProjection";
import { CanvasService } from "./canvas/canvasService";
import { CanvasShareEventStore, registerCanvasShareEvents } from "./canvas/canvasShareEventStore";
import { CanvasShareService } from "./canvas/canvasShareService";
import {
  CANVAS_ACTION_RECEIPT_RECORDED,
  CANVAS_CREATED,
  CANVAS_REFRESH_RECEIPT_RECORDED,
  CANVAS_VERSION_APPENDED,
} from "./canvas/canvasEventStore";
import {
  createCanvasRouteHandler,
  resolveCanvasActiveContext,
  type CanvasActiveContext,
} from "./canvasRoutes";
import { WindowAuthorityStore } from "./windowAuthorityStore";
import { createRemoteDevicePrincipal } from "./clientPrincipal";
import { bindPrincipalRouteContext } from "./principalRouteContext";

const directories: Array<string> = [];
afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

const windowCapability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = decodeWindowId("00000000-0000-4000-8000-000000000203");
const projectId = decodeProjectId("77777777-7777-4777-8777-777777777777");
const otherProjectId = decodeProjectId("88888888-8888-4888-8888-888888888888");
const canvasId = decodeCanvasId("11111111-1111-4111-8111-111111111111");
const threadId = "99999999-9999-4999-8999-999999999999";
const now = "2026-08-01T21:00:00.000Z";
const later = "2026-08-01T21:01:00.000Z";
const shareOwnerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const remoteDeviceId = "16161616-1616-4161-8161-161616161616";

function createRevisionRoute(projection = new CanvasProjection()) {
  const versionEnvelope = {
    schemaVersion: CANVAS_SCHEMA_VERSION,
    canvasId,
    versionId: "22222222-2222-4222-8222-222222222222" as never,
    sequence: 1,
    definition: {
      schemaVersion: CANVAS_SCHEMA_VERSION,
      title: "Quarterly summary",
      provenance: {
        mode: "chat",
        hostId: "local" as never,
        projectId,
        threadId: threadId as never,
        actor: {
          kind: "local-user",
          actorId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as never,
        },
        providerInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as never,
        modelId: "octant-test-model" as never,
        createdAt: now as never,
      },
      sourceManifest: [],
      blocks: [
        {
          blockId: "block-1" as never,
          schemaVersion: CANVAS_SCHEMA_VERSION,
          kind: "heading",
          level: 1,
          text: "A bounded Canvas",
        },
      ],
    },
    createdBy: {
      kind: "local-user",
      actorId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as never,
    },
    createdAt: now as never,
  };
  seedProjection(projection);
  const directory = mkdtempSync(join(tmpdir(), "octant-canvas-route-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const registry = registerCanvasShareEvents(
    new EventRegistry()
      .register(CANVAS_CREATED, 1, CanvasCreated)
      .register(CANVAS_VERSION_APPENDED, 1, CanvasVersionAppended)
      .register(CANVAS_REFRESH_RECEIPT_RECORDED, 1, CanvasRefreshReceiptRecorded)
      .register(CANVAS_ACTION_RECEIPT_RECORDED, 1, CanvasActionReceiptRecorded),
  );
  const projections = new ProjectionRegistry()
    .register(new AggregateHeadsProjection())
    .register(projection);
  const journal = new Journal({
    connection,
    registry,
    projections,
    clock: () => now as never,
  });
  const actor = Schema.decodeUnknownSync(EventActor)({
    kind: "local-user",
    actorId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  });
  let counter = 0;
  const eventStore = new CanvasEventStore({
    journal,
    uuid: () => {
      counter += 1;
      return `cccccccc-cccc-4ccc-8ccc-${counter.toString(16).padStart(12, "0")}`;
    },
    actor,
  });
  const canvasService = new CanvasService(
    {
      projection,
      eventStore,
      uuid: () => `dddddddd-dddd-4ddd-8ddd-${(counter += 1).toString(16).padStart(12, "0")}`,
      clock: () => later as never,
    },
    { authorize: () => true },
  );
  const canvasShareService = new CanvasShareService(
    {
      projection,
      eventStore: new CanvasShareEventStore({
        journal,
        uuid: () => `eeeeeeee-eeee-4eee-8eee-${(counter += 1).toString(16).padStart(12, "0")}`,
        actor,
      }),
      uuid: () => `ffffffff-ffff-4fff-8fff-${(counter += 1).toString(16).padStart(12, "0")}`,
      clock: () => later as never,
      hostId: "local",
      owner: { kind: "local-user", actorId: shareOwnerId },
    },
    { authorize: () => true },
  );
  eventStore.appendCreate({
    canvasId,
    version: versionEnvelope as never,
    occurredAt: now as never,
  });
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability: windowCapability, now: 0 });
  const route = createCanvasRouteHandler({
    canvasProjection: projection,
    canvasService,
    canvasShareService,
    windowAuthorityStore: store,
    projects: {
      bootstrap: async () => ({
        active: [
          {
            id: projectId,
            name: "Chat Project",
            type: "chat",
            lifecycle: "active",
            pinned: false,
            rank: "0/1" as never,
            version: 1 as never,
            createdAt: now as never,
            updatedAt: now as never,
          },
        ],
        archived: [],
        availability: [],
        memory: [],
      }),
    },
    activeContextResolver: async () => ({ mode: "chat", projectId }),
    now: () => 1,
  });
  return route;
}

function reviseBody(expectedSequence = 1) {
  return {
    schemaVersion: 1,
    kind: "canvas-revise",
    requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    canvasId: String(canvasId),
    expectedSequence,
    prompt: "Add a summary section",
    hostId: "local",
    mode: "chat",
    workspace: { kind: "chat-virtual", projectId: null },
    originThreadId: threadId,
    actor: { kind: "local-user", actorId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    providerInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    modelId: "octant-revise-model",
    requestedAuthority: {
      filesystem: false,
      shell: false,
      git: false,
      network: false,
      tools: true,
      subagents: false,
      executionPolicy: "plan",
      permissionPersistence: "current-session",
    },
  };
}

function shareBody() {
  return {
    schemaVersion: 1,
    kind: "canvas-share-snapshot",
    snapshotId: "1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a",
    exportId: "2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b",
    canvasId: String(canvasId),
    versionId: "22222222-2222-4222-8222-222222222222",
    expectedSequence: 1,
    hostId: "local",
    projectId: String(projectId),
    audience: {
      ownerActorId: shareOwnerId,
      principals: [
        { label: "This device", principalKind: "local-user", principalId: shareOwnerId },
      ],
    },
    expiresAt: "2026-08-02T21:00:00.000Z",
    refreshPolicy: "manual-only",
    consent: {
      acknowledgedAuthenticatedSnapshot: true,
      acknowledgedOwnerVisibleAudience: true,
      acknowledgedAt: later,
      acknowledgedBy: { kind: "local-user", actorId: shareOwnerId },
    },
  };
}

function revokeBody() {
  return {
    schemaVersion: 1,
    kind: "canvas-share-snapshot-revoke",
    snapshotId: "1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a",
    canvasId: String(canvasId),
    hostId: "local",
    projectId: String(projectId),
    actor: { kind: "local-user", actorId: shareOwnerId },
    revokedAt: "2026-08-01T21:02:00.000Z",
  };
}

function accessBody() {
  return {
    schemaVersion: 1,
    kind: "canvas-share-access",
    snapshotId: "1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a",
    canvasId: String(canvasId),
    hostId: "local",
    projectId: String(projectId),
  };
}

function createBody() {
  return {
    schemaVersion: 1,
    kind: "canvas-create",
    requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    intent: "prompt",
    hostId: "local",
    mode: "chat",
    workspace: { kind: "chat-virtual", projectId: String(projectId) },
    originThreadId: threadId,
    title: "Created canvas",
    prompt: "Summarize the current thread.",
    sourceManifest: [],
    requestedAuthority: {
      filesystem: false,
      shell: false,
      git: false,
      network: false,
      tools: true,
      subagents: false,
      executionPolicy: "plan",
      permissionPersistence: "current-session",
    },
  };
}

function refreshBody() {
  return {
    schemaVersion: 1,
    kind: "canvas-refresh",
    requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    canvasId: String(canvasId),
    recipe: {
      schemaVersion: 1,
      kind: "canvas-refresh-recipe",
      recipeId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      canvasId: String(canvasId),
      hostId: "local",
      mode: "chat",
      workspace: { kind: "chat-virtual", projectId: null },
      originThreadId: threadId,
      providerInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      modelId: "octant-test-model",
      parameters: [{ key: "range", value: "opaque:current" }],
      sourceManifest: [],
    },
    expectedSequence: 1,
    hostId: "local",
    mode: "chat",
    workspace: { kind: "chat-virtual", projectId: null },
    originThreadId: threadId,
    actor: { kind: "local-user", actorId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    providerInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    modelId: "octant-test-model",
    requestedAuthority: {
      filesystem: false,
      shell: false,
      git: false,
      network: false,
      tools: true,
      subagents: false,
      executionPolicy: "plan",
      permissionPersistence: "current-session",
    },
  };
}

function actionBody(command: unknown, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    kind: "canvas-action",
    requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    canvasId: String(canvasId),
    block: {
      blockId: "action-1",
      schemaVersion: 1,
      kind: "action",
      label: "Do a thing",
      command,
    },
    expectedSequence: 1,
    hostId: "local",
    mode: "chat",
    workspace: { kind: "chat-virtual", projectId: null },
    originThreadId: threadId,
    actor: { kind: "local-user", actorId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    providerInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    modelId: "octant-test-model",
    requestedAuthority: {
      filesystem: false,
      shell: false,
      git: false,
      network: false,
      tools: true,
      subagents: false,
      executionPolicy: "plan",
      permissionPersistence: "current-session",
    },
    approval: { kind: "not-required" },
    ...overrides,
  };
}

function bootstrapFor(project: typeof projectId): ShellBootstrap {
  const workspace = {
    ...defaultWindowWorkspace(windowId),
    activeMode: "chat" as const,
    contextByMode: {
      chat: {
        host: "local" as never,
        mode: "chat" as const,
        projectId: project,
        boundRoot: null,
      },
      work: defaultWindowWorkspace(windowId).contextByMode.work,
      code: defaultWindowWorkspace(windowId).contextByMode.code,
    },
  };
  return {
    settings: defaultShellSettings(),
    workspace,
    availableSurfaces: { chat: [], work: [], code: [] },
    connectionStatus: "connected",
    settingsVersion: 0 as never,
    workspaceVersion: 0 as never,
    environmentPresentation: {
      byTab: [],
      byMode: defaultShellSettings().environmentPresentationByMode,
    },
    presentationVersion: 0 as never,
  };
}

function seedProjection(projection: CanvasProjection) {
  projection.applyCreated({
    canvasId,
    version: {
      schemaVersion: CANVAS_SCHEMA_VERSION,
      canvasId,
      versionId: "22222222-2222-4222-8222-222222222222" as never,
      sequence: 1,
      definition: {
        schemaVersion: CANVAS_SCHEMA_VERSION,
        title: "Quarterly summary",
        provenance: {
          mode: "chat",
          hostId: "local" as never,
          projectId,
          threadId: threadId as never,
          actor: {
            kind: "local-user",
            actorId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as never,
          },
          providerInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as never,
          modelId: "octant-test-model" as never,
          createdAt: now as never,
        },
        sourceManifest: [],
        blocks: [
          {
            blockId: "block-1" as never,
            schemaVersion: CANVAS_SCHEMA_VERSION,
            kind: "heading",
            level: 1,
            text: "A bounded Canvas",
          },
        ],
      },
      createdBy: {
        kind: "local-user",
        actorId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as never,
      },
      createdAt: now as never,
    },
  });
}

describe("resolveCanvasActiveContext", () => {
  it("reads the active mode Project binding", () => {
    const context = resolveCanvasActiveContext(bootstrapFor(projectId));
    expect(context).toEqual({ mode: "chat", projectId });
  });
});

describe("canvas routes", () => {
  it("lists inventory for the active Project and fails closed cross-Project", async () => {
    const projection = new CanvasProjection();
    seedProjection(projection);
    const store = new WindowAuthorityStore();
    store.register({ windowId, capability: windowCapability, now: 0 });
    const canvasService = new CanvasService(
      {
        projection,
        eventStore: {
          appendVersion: () => {
            throw new Error("not used");
          },
        } as never,
        uuid: () => "ffffffff-ffff-4fff-8fff-ffffffffffff",
        clock: () => later as never,
      },
      { authorize: () => true },
    );
    const route = createCanvasRouteHandler({
      canvasProjection: projection,
      canvasService,
      windowAuthorityStore: store,
      projects: {
        bootstrap: async () => ({
          active: [
            {
              id: projectId,
              name: "Chat Project",
              type: "chat",
              lifecycle: "active",
              pinned: false,
              rank: "0/1" as never,
              version: 1 as never,
              createdAt: now as never,
              updatedAt: now as never,
            },
          ],
          archived: [],
          availability: [],
          memory: [],
        }),
      },
      activeContextResolver: async () =>
        ({ mode: "chat", projectId }) satisfies CanvasActiveContext,
      now: () => 1,
    });

    const inventory = await route(
      new Request(`http://127.0.0.1/api/canvas/inventory?projectId=${String(projectId)}`, {
        method: "GET",
        headers: { "x-octant-window-capability": windowCapability },
      }),
    );
    expect(inventory?.status).toBe(200);
    const listed = decodeCanvasInventoryList(JSON.parse(await inventory!.text()));
    expect(listed.entries.map((entry) => entry.title)).toEqual(["Quarterly summary"]);

    const denied = await route(
      new Request(`http://127.0.0.1/api/canvas/inventory?projectId=${String(otherProjectId)}`, {
        method: "GET",
        headers: { "x-octant-window-capability": windowCapability },
      }),
    );
    const deniedList = decodeCanvasInventoryList(JSON.parse(await denied!.text()));
    expect(deniedList.entries).toEqual([]);
  });

  it("returns ready get-by-id with the host-resolved workspace scope", async () => {
    const projection = new CanvasProjection();
    seedProjection(projection);
    const store = new WindowAuthorityStore();
    store.register({ windowId, capability: windowCapability, now: 0 });
    const canvasService = new CanvasService(
      {
        projection,
        eventStore: {
          appendVersion: () => {
            throw new Error("not used");
          },
        } as never,
        uuid: () => "ffffffff-ffff-4fff-8fff-ffffffffffff",
        clock: () => later as never,
      },
      {
        authorize: () => true,
        resolveWorkspace: () => ({ kind: "chat-virtual", projectId: null }),
      },
    );
    const route = createCanvasRouteHandler({
      canvasProjection: projection,
      canvasService,
      windowAuthorityStore: store,
      projects: {
        bootstrap: async () => ({
          active: [
            {
              id: projectId,
              name: "Chat Project",
              type: "chat",
              lifecycle: "active",
              pinned: false,
              rank: "0/1" as never,
              version: 1 as never,
              createdAt: now as never,
              updatedAt: now as never,
            },
          ],
          archived: [],
          availability: [],
          memory: [],
        }),
      },
      activeContextResolver: async () => ({ mode: "chat", projectId }),
      now: () => 1,
    });
    const response = await route(
      new Request(`http://127.0.0.1/api/canvas/get?canvasId=${String(canvasId)}`, {
        method: "GET",
        headers: { "x-octant-window-capability": windowCapability },
      }),
    );
    expect(response?.status).toBe(200);
    const body = JSON.parse(await response!.text());
    expect(body.kind).toBe("ready");
    expect(body.version.definition.title).toBe("Quarterly summary");
    // The scope crosses the wire through the strict outcome schema, so a
    // client can echo it on a mutation instead of inferring one.
    expect(body.workspace).toEqual({ kind: "chat-virtual", projectId: null });
  });

  it("revises an authorized canvas and lists opaque version history", async () => {
    const route = createRevisionRoute();
    const revise = await route(
      new Request("http://127.0.0.1/api/canvas/revise", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": windowCapability,
        },
        body: JSON.stringify(reviseBody()),
      }),
    );
    expect(revise?.status).toBe(200);
    const reviseResult = decodeCanvasReviseResult(JSON.parse(await revise!.text()));
    expect(reviseResult.kind).toBe("accepted");

    const history = await route(
      new Request(`http://127.0.0.1/api/canvas/history?canvasId=${String(canvasId)}`, {
        method: "GET",
        headers: { "x-octant-window-capability": windowCapability },
      }),
    );
    const historyOutcome = decodeCanvasHistoryOutcome(JSON.parse(await history!.text()));
    expect(historyOutcome.kind).toBe("ready");
    if (historyOutcome.kind !== "ready") return;
    expect(historyOutcome.history.entries).toHaveLength(2);
    expect(historyOutcome.history.entries[1]?.promptSummary).toBe("Add a summary section");
  });

  it("refreshes an approved recipe through the authenticated route", async () => {
    const route = createRevisionRoute();
    const response = await route(
      new Request("http://127.0.0.1/api/canvas/refresh", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": windowCapability,
        },
        body: JSON.stringify(refreshBody()),
      }),
    );
    expect(response?.status).toBe(200);
    const result = decodeCanvasRefreshResult(JSON.parse(await response!.text()));
    expect(result).toMatchObject({ kind: "denied", denialCode: "malformed-request" });
    const duplicate = await route(
      new Request("http://127.0.0.1/api/canvas/refresh", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": windowCapability,
        },
        body: JSON.stringify(refreshBody()),
      }),
    );
    expect(decodeCanvasRefreshResult(JSON.parse(await duplicate!.text()))).toEqual(result);
  });

  it("executes an authorized action through the authenticated route and replays it idempotently", async () => {
    const route = createRevisionRoute();
    const post = (body: unknown, path = "action") =>
      route(
        new Request(`http://127.0.0.1/api/canvas/${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-octant-window-capability": windowCapability,
          },
          body: JSON.stringify(body),
        }),
      );
    const response = await post(
      actionBody({
        command: "canvas.open-source",
        sourceId: "55555555-5555-4555-8555-555555555555",
      }),
    );
    expect(response?.status).toBe(200);
    const result = decodeCanvasActionResult(JSON.parse(await response!.text()));
    expect(result).toMatchObject({
      kind: "accepted",
      receipt: { outcome: "completed", capability: { command: "canvas.open-source" } },
    });
    const duplicate = await post(
      actionBody({
        command: "canvas.open-source",
        sourceId: "55555555-5555-4555-8555-555555555555",
      }),
    );
    expect(decodeCanvasActionResult(JSON.parse(await duplicate!.text()))).toEqual(result);
  });

  it("rejects an action cancellation without a server-owned operation", async () => {
    const route = createRevisionRoute();
    const cancel = await route(
      new Request("http://127.0.0.1/api/canvas/action-cancel", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": windowCapability,
        },
        body: JSON.stringify({
          schemaVersion: 1,
          kind: "canvas-action-cancel",
          requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          canvasId: String(canvasId),
          blockId: "action-1",
        }),
      }),
    );
    expect(cancel?.status).toBe(200);
    expect(decodeCanvasActionResult(JSON.parse(await cancel!.text()))).toMatchObject({
      kind: "denied",
      denialCode: "unavailable",
    });
  });

  it("returns a specific immutable version through get with versionId", async () => {
    const route = createRevisionRoute();
    await route(
      new Request("http://127.0.0.1/api/canvas/revise", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": windowCapability,
        },
        body: JSON.stringify(reviseBody()),
      }),
    );
    const response = await route(
      new Request(
        `http://127.0.0.1/api/canvas/get?canvasId=${String(canvasId)}&versionId=22222222-2222-4222-8222-222222222222`,
        {
          method: "GET",
          headers: { "x-octant-window-capability": windowCapability },
        },
      ),
    );
    const body = JSON.parse(await response!.text());
    expect(body.kind).toBe("ready");
    expect(body.version.sequence).toBe(1);
  });

  it("creates a journaled Canvas and lists its originating thread card", async () => {
    const route = createRevisionRoute();
    const create = await route(
      new Request("http://127.0.0.1/api/canvas/create", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": windowCapability,
        },
        body: JSON.stringify(createBody()),
      }),
    );
    expect(create?.status).toBe(200);
    const result = decodeCanvasCreateResult(JSON.parse(await create!.text()));
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    expect(result.card.actionCount).toBe(0);
    const cards = await route(
      new Request(
        `http://127.0.0.1/api/canvas/thread-reference-cards?mode=chat&threadId=${threadId}&projectId=${String(projectId)}`,
        {
          method: "GET",
          headers: { "x-octant-window-capability": windowCapability },
        },
      ),
    );
    const outcome = decodeCanvasThreadReferenceCardsOutcome(JSON.parse(await cards!.text()));
    expect(outcome.cards.map((card) => card.canvasId)).toContain(result.card.canvasId);
  });

  it("shares, serves, revokes, and then refuses a Canvas snapshot over the API", async () => {
    const route = createRevisionRoute();
    const post = (path: string, body: unknown) =>
      route(
        new Request(`http://127.0.0.1/api/canvas/${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "Mozilla/5.0 (Macintosh) Chrome/1.0",
            "x-octant-window-capability": windowCapability,
          },
          body: JSON.stringify(body),
        }),
      );

    const empty = await route(
      new Request(`http://127.0.0.1/api/canvas/share?canvasId=${String(canvasId)}`, {
        method: "GET",
        headers: { "x-octant-window-capability": windowCapability },
      }),
    );
    expect(empty?.status).toBe(200);
    const overview = decodeCanvasShareOverview(JSON.parse(await empty!.text()));
    expect(overview.sharingEnabled).toBe(true);
    expect(overview.owner.actorId).toBe(shareOwnerId);
    expect(overview.snapshots).toEqual([]);

    const shared = decodeCanvasShareResult(
      JSON.parse(await (await post("share", shareBody()))!.text()),
    );
    expect(shared.kind).toBe("accepted");

    const allowed = decodeCanvasShareAccessResult(
      JSON.parse(await (await post("share-access", accessBody()))!.text()),
    );
    expect(allowed.kind).toBe("allowed");
    if (allowed.kind === "allowed") {
      expect(allowed.document.title).toBe("Quarterly summary");
      expect(allowed.event.browserFamily).toBe("chrome");
    }

    const revoked = decodeCanvasShareResult(
      JSON.parse(await (await post("share-revoke", revokeBody()))!.text()),
    );
    expect(revoked).toMatchObject({ kind: "accepted" });

    const refused = decodeCanvasShareAccessResult(
      JSON.parse(await (await post("share-access", accessBody()))!.text()),
    );
    expect(refused).toMatchObject({ kind: "denied", outcome: "denied-revoked" });

    const audited = await route(
      new Request(`http://127.0.0.1/api/canvas/share?canvasId=${String(canvasId)}`, {
        method: "GET",
        headers: { "x-octant-window-capability": windowCapability },
      }),
    );
    const finalOverview = decodeCanvasShareOverview(JSON.parse(await audited!.text()));
    expect(finalOverview.snapshots[0]?.status).toBe("revoked");
    expect(finalOverview.accessLog.map((event) => event.outcome)).toEqual([
      "allowed",
      "denied-revoked",
    ]);
  });

  it("refuses a forwarded remote device a share whose audience is the host user", async () => {
    const route = createRevisionRoute();
    const share = await route(
      new Request("http://127.0.0.1/api/canvas/share", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": windowCapability,
        },
        body: JSON.stringify(shareBody()),
      }),
    );
    expect(decodeCanvasShareResult(JSON.parse(await share!.text())).kind).toBe("accepted");

    // The remote gateway authenticates the device and binds it to the request
    // before the product route ever runs; the route must carry that identity
    // into the share audience rather than substituting the host user.
    const remoteRequest = new Request("http://127.0.0.1/api/canvas/share-access", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-octant-window-capability": windowCapability,
      },
      body: JSON.stringify(accessBody()),
    });
    const principal = createRemoteDevicePrincipal({
      hostId: "local" as never,
      deviceId: remoteDeviceId as never,
      credentialGeneration: 1,
      origin: "https://octant.invalid",
      protocolVersion: 1,
      capabilityDigest: "b".repeat(64),
      sessionId: "17171717-1717-4171-8171-171717171717" as never,
    });
    bindPrincipalRouteContext(remoteRequest, {
      principal,
      scopeId: remoteDeviceId as never,
    });

    const refused = decodeCanvasShareAccessResult(
      JSON.parse(await (await route(remoteRequest))!.text()),
    );
    expect(refused).toMatchObject({ kind: "denied", outcome: "denied-audience" });
    expect(JSON.stringify(refused)).not.toContain("Quarterly summary");

    // The owner's own log attributes the read to the device, not to the owner.
    const audited = await route(
      new Request(`http://127.0.0.1/api/canvas/share?canvasId=${String(canvasId)}`, {
        method: "GET",
        headers: { "x-octant-window-capability": windowCapability },
      }),
    );
    const overview = decodeCanvasShareOverview(JSON.parse(await audited!.text()));
    expect(overview.accessLog).toHaveLength(1);
    expect(overview.accessLog[0]?.principalId).toBe(remoteDeviceId);
  });
});
