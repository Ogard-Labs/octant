import { decodeCanvasDocumentRecipeCatalog } from "@octant/contracts/canvas-skill";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { CanvasDesignRunTickets } from "./canvas/canvasDesignPage";
import { CanvasShareEventStore, registerCanvasShareEvents } from "./canvas/canvasShareEventStore";
import { CanvasCommentService, registerCanvasCommentEvents } from "./canvas/canvasCommentService";
import { CanvasShareService } from "./canvas/canvasShareService";
import { CanvasExportFolderService } from "./canvas/canvasExportFolderService";
import { registerCanvasExportFolderEvents } from "./canvas/canvasExportFolderEventStore";
import { createCanvasExportFilePort } from "./canvas/canvasExportFilePort";
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

/** The folder the stubbed browser listed, and the id it listed it under. */
const exportFolderCandidateId = "88888888-8888-4888-8888-888888888888";

const readFolderCandidate = Schema.decodeUnknownSync(Schema.Struct({ candidateId: Schema.String }));

function createRevisionRoute(
  projection = new CanvasProjection(),
  options: {
    /** Seed the Canvas as owned by its thread, with no Project, and open the window on no Project. */
    readonly threadOwned?: boolean;
    readonly activeMode?: "chat" | "work";
  } = {},
) {
  const canvasProjectId = options.threadOwned === true ? null : projectId;
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
        projectId: canvasProjectId,
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
        {
          blockId: "board-1" as never,
          schemaVersion: CANVAS_SCHEMA_VERSION,
          kind: "diagram",
          nodes: [
            { nodeId: "api" as never, label: "API" },
            { nodeId: "db" as never, label: "Database" },
          ],
          edges: [{ edgeId: "api-db" as never, source: "api" as never, target: "db" as never }],
        },
      ],
    },
    createdBy: {
      kind: "local-user",
      actorId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as never,
    },
    createdAt: now as never,
  };
  seedProjection(projection, canvasProjectId);
  const directory = mkdtempSync(join(tmpdir(), "octant-canvas-route-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const registry = registerCanvasExportFolderEvents(
    registerCanvasCommentEvents(
      registerCanvasShareEvents(
        new EventRegistry()
          .register(CANVAS_CREATED, 1, CanvasCreated)
          .register(CANVAS_VERSION_APPENDED, 1, CanvasVersionAppended)
          .register(CANVAS_REFRESH_RECEIPT_RECORDED, 1, CanvasRefreshReceiptRecorded)
          .register(CANVAS_ACTION_RECEIPT_RECORDED, 1, CanvasActionReceiptRecorded),
      ),
    ),
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
    {
      authorize: () => true,
      ...(options.threadOwned === true ? { threadMayOwnCanvas: () => true } : {}),
    },
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
  const canvasCommentService = new CanvasCommentService(
    {
      journal,
      projection,
      uuid: () => `abababab-abab-4bab-8bab-${(counter += 1).toString(16).padStart(12, "0")}`,
      actor,
    },
    { authorize: () => true },
  );
  const exportFolderDirectory = mkdtempSync(join(tmpdir(), "octant-export-route-"));
  directories.push(exportFolderDirectory);
  const canvasExportFolderService = new CanvasExportFolderService({
    journal,
    uuid: () => `cdcdcdcd-cdcd-4dcd-8dcd-${(counter += 1).toString(16).padStart(12, "0")}`,
    actor,
    clock: () => later as never,
    files: createCanvasExportFilePort(),
    home: tmpdir(),
    standingOutsideApproval: false,
  });
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability: windowCapability, now: 0 });
  const route = createCanvasRouteHandler({
    canvasProjection: projection,
    canvasService,
    canvasShareService,
    canvasExportFolderService,
    resolveFolderCandidate: async (_windowId, input) => {
      const { candidateId } = readFolderCandidate(input);
      if (candidateId !== exportFolderCandidateId) {
        throw new Error("That folder is no longer available to choose.");
      }
      return exportFolderDirectory;
    },
    canvasCommentService,
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
    activeContextResolver: async () => ({
      mode: options.activeMode ?? "chat",
      projectId: options.threadOwned === true ? null : projectId,
    }),
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

function seedProjection(
  projection: CanvasProjection,
  canvasProjectId: typeof projectId | null = projectId,
) {
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
          projectId: canvasProjectId,
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
          {
            blockId: "board-1" as never,
            schemaVersion: CANVAS_SCHEMA_VERSION,
            kind: "diagram",
            nodes: [
              { nodeId: "api" as never, label: "API" },
              { nodeId: "db" as never, label: "Database" },
            ],
            edges: [{ edgeId: "api-db" as never, source: "api" as never, target: "db" as never }],
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

  it("resolves a design's images for an authorized window from the version's own provenance, and nothing for another Project", async () => {
    const projection = new CanvasProjection();
    seedProjection(projection);
    const current = projection.getById(canvasId)?.currentVersion;
    if (current === undefined) throw new Error("expected a seeded Canvas");
    const versionId = "33333333-3333-4333-8333-333333333333";
    projection.applyVersionAppended({
      canvasId,
      version: {
        ...current,
        versionId: versionId as never,
        sequence: 2,
        definition: {
          ...current.definition,
          blocks: [
            {
              blockId: "phone" as never,
              schemaVersion: CANVAS_SCHEMA_VERSION,
              kind: "design",
              title: "Onboarding",
              size: "phone",
              assets: [
                {
                  assetId: "hero" as never,
                  source: {
                    kind: "generated-image",
                    imageId: "44444444-4444-4444-8444-444444444444" as never,
                  },
                },
              ],
              frames: [
                {
                  frameId: "home" as never,
                  title: "Home",
                  html: '<img src="octant-asset:hero" alt="">',
                },
              ],
            },
          ],
        },
      },
    });
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
    const resolveDesignAssets = vi.fn(async () => [
      {
        assetId: "hero" as never,
        status: "resolved" as const,
        mediaType: "image/png" as const,
        data: "iVBORw0KGgo=",
      },
    ]);
    let active = projectId;
    const route = createCanvasRouteHandler({
      canvasProjection: projection,
      canvasService,
      windowAuthorityStore: store,
      resolveDesignAssets,
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
      activeContextResolver: async () => ({ mode: "chat", projectId: active }),
      now: () => 1,
    });
    const ask = async (query: string) => {
      const response = await route(
        new Request(`http://127.0.0.1/api/canvas/design-assets?${query}`, {
          method: "GET",
          headers: { "x-octant-window-capability": windowCapability },
        }),
      );
      return { status: response?.status, body: JSON.parse((await response?.text()) ?? "{}") };
    };
    const query = `canvasId=${String(canvasId)}&versionId=${versionId}&blockId=phone`;

    const ready = await ask(query);
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({
      kind: "ready",
      canvasId: String(canvasId),
      versionId,
      blockId: "phone",
      assets: [
        { assetId: "hero", status: "resolved", mediaType: "image/png", data: "iVBORw0KGgo=" },
      ],
    });
    expect(resolveDesignAssets).toHaveBeenCalledWith(
      expect.objectContaining({ blockId: "phone" }),
      expect.objectContaining({ mode: "chat", projectId, threadId }),
    );

    // A block that is not a design, and a request that names more than it should.
    expect(
      (await ask(`canvasId=${String(canvasId)}&versionId=${versionId}&blockId=nope`)).body,
    ).toMatchObject({ kind: "unavailable" });
    expect((await ask(`${query}&path=/etc/hosts`)).status).toBe(400);

    // A window looking at another Project is told nothing and resolves nothing.
    resolveDesignAssets.mockClear();
    active = otherProjectId;
    expect((await ask(query)).body).toEqual({ kind: "unauthorized", canvasId: String(canvasId) });
    expect(resolveDesignAssets).not.toHaveBeenCalled();
  });

  it("serves a running design once, for one fresh ticket an authorized window asked for", async () => {
    const projection = new CanvasProjection();
    seedProjection(projection);
    const current = projection.getById(canvasId)?.currentVersion;
    if (current === undefined) throw new Error("expected a seeded Canvas");
    const versionId = "33333333-3333-4333-8333-333333333333";
    const checkout = {
      blockId: "checkout" as never,
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "design" as const,
      title: "Checkout",
      size: "phone" as const,
      runsScript: true as const,
      assets: [
        {
          assetId: "hero" as never,
          source: {
            kind: "generated-image" as const,
            imageId: "44444444-4444-4444-8444-444444444444" as never,
          },
        },
      ],
      frames: [
        {
          frameId: "cart" as never,
          title: "Cart",
          html: '<img src="octant-asset:hero" alt=""><button onclick="pay()">Pay</button><script>function pay() {}</script>',
        },
        { frameId: "done" as never, title: "Done", html: "<p>Paid</p>" },
      ],
    };
    const still = { ...checkout, blockId: "still" as never, runsScript: undefined };
    projection.applyVersionAppended({
      canvasId,
      version: {
        ...current,
        versionId: versionId as never,
        sequence: 2,
        definition: { ...current.definition, blocks: [checkout, still] },
      },
    });
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
    let clock = 1_000;
    const tickets = new CanvasDesignRunTickets(() => clock);
    const resolveDesignAssets = vi.fn(async () => [
      {
        assetId: "hero" as never,
        status: "resolved" as const,
        mediaType: "image/png" as const,
        data: "iVBORw0KGgo=",
      },
    ]);
    let active: { mode: "chat" | "work"; projectId: typeof projectId } = {
      mode: "chat",
      projectId,
    };
    const route = createCanvasRouteHandler({
      canvasProjection: projection,
      canvasService,
      windowAuthorityStore: store,
      resolveDesignAssets,
      designRunTickets: tickets,
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
      activeContextResolver: async () => active,
      now: () => 1,
    });
    const run = async (body: Record<string, unknown>, capability = windowCapability) => {
      const response = await route(
        new Request("http://127.0.0.1/api/canvas/design-run", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-octant-window-capability": capability,
          },
          body: JSON.stringify(body),
        }),
      );
      return { status: response?.status, body: JSON.parse((await response?.text()) ?? "{}") };
    };
    const load = async (page: string, headers: Record<string, string> = {}) => {
      const response = await route(
        new Request(`http://127.0.0.1${page}`, {
          method: "GET",
          headers: { "sec-fetch-dest": "iframe", ...headers },
        }),
      );
      if (response === undefined) throw new Error("expected the page route");
      return response;
    };
    const asked = { canvasId: String(canvasId), versionId, blockId: "checkout" };

    const ready = await run({ ...asked, frameId: "done" });
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({ kind: "ready", versionId, blockId: "checkout" });
    const page = ready.body.page as string;
    expect(page).toMatch(/^\/api\/canvas\/design-page\?ticket=[A-Za-z0-9_-]{43}$/);
    // The page address holds the ticket and nothing that names the window.
    expect(page).not.toContain(windowCapability);

    const served = await load(page);
    expect(served.status).toBe(200);
    expect(Object.fromEntries(served.headers)).toEqual({
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    const html = await served.text();
    // The bridge runs before the author's script, and the declared image is
    // written in so the page requests nothing.
    expect(html.indexOf("octant-design-frame@1")).toBeLessThan(html.indexOf("function pay()"));
    expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(html).not.toContain("octant-asset:");
    expect(html).toMatch(/id="done" data-start/);
    expect(resolveDesignAssets).toHaveBeenCalledWith(
      expect.objectContaining({ blockId: "checkout" }),
      expect.objectContaining({ mode: "chat", projectId, threadId }),
    );

    // A replayed ticket opens nothing, and the refusal carries the same policy.
    const replayed = await load(page);
    expect(replayed.status).toBe(403);
    expect(replayed.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    expect(await replayed.text()).not.toContain("function pay()");

    // A ticket used after it expires opens nothing either.
    const late = await run(asked);
    clock += 10_001;
    expect((await load(late.body.page as string)).status).toBe(403);

    // Only a frame loads the page, and only by its ticket.
    const fresh = await run(asked);
    expect((await load(fresh.body.page as string, { "sec-fetch-dest": "document" })).status).toBe(
      403,
    );
    expect((await load(`${fresh.body.page as string}&canvasId=x`)).status).toBe(400);
    expect((await load(`/api/canvas/design-page?ticket=${"A".repeat(43)}`)).status).toBe(403);

    // A static design, a design from another version, or a screen it lacks.
    expect((await run({ ...asked, blockId: "still" })).body).toMatchObject({
      kind: "unavailable",
    });
    expect(
      (await run({ ...asked, versionId: "99999999-9999-4999-8999-999999999999" })).body.kind,
    ).not.toBe("ready");
    expect((await run({ ...asked, frameId: "missing" })).body).toMatchObject({
      kind: "unavailable",
    });
    expect((await run({ ...asked, extra: true })).status).toBe(400);

    // An unknown window, a window in another Project, or one in another mode
    // gets no ticket.
    expect((await run(asked, "B".repeat(43))).status).toBe(401);
    active = { mode: "chat", projectId: otherProjectId };
    expect((await run(asked)).body).toEqual({ kind: "unauthorized", canvasId: String(canvasId) });
    active = { mode: "work", projectId };
    expect((await run(asked)).body.kind).not.toBe("ready");
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

  it("journals a dragged node through the authenticated route and refuses the same drag without a window", async () => {
    const route = createRevisionRoute();
    const command = {
      kind: "canvas-diagram-layout-revise",
      canvasId,
      versionId: "33333333-3333-4333-8333-333333333333",
      blockId: "board-1",
      positions: [{ nodeId: "db", x: 320, y: 40 }],
      actor: { kind: "local-user", actorId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      expectedSequence: 1,
      schemaVersion: CANVAS_SCHEMA_VERSION,
      issuedAt: now,
    };
    const unauthenticated = await route(
      new Request("http://127.0.0.1/api/canvas/layout-revise", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      }),
    );
    expect(unauthenticated?.status).toBe(401);

    const response = await route(
      new Request("http://127.0.0.1/api/canvas/layout-revise", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": windowCapability,
        },
        body: JSON.stringify(command),
      }),
    );
    expect(response?.status).toBe(200);
    expect(JSON.parse(await response!.text())).toMatchObject({
      kind: "accepted",
      versionId: "33333333-3333-4333-8333-333333333333",
      sequence: 2,
    });

    const reread = await route(
      new Request(`http://127.0.0.1/api/canvas/get?canvasId=${String(canvasId)}`, {
        method: "GET",
        headers: { "x-octant-window-capability": windowCapability },
      }),
    );
    const body = JSON.parse(await reread!.text());
    expect(body.version.sequence).toBe(2);
    // The host records the drag as its own person, whatever actor the
    // request carried.
    expect(body.version.createdBy).toEqual({
      kind: "local-user",
      actorId: "00000000-0000-4000-8000-000000000002",
    });
    const board = body.version.definition.blocks.find(
      (block: { blockId: string }) => block.blockId === "board-1",
    );
    expect(board.layout).toBe("manual");
    expect(board.nodes[1]).toMatchObject({ nodeId: "db", x: 320, y: 40, positioned: true });
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

  it("serves a Canvas owned by a Chat thread outside every Project to a Chat window with no Project, lists it on that thread, and files its exports under the host folder", async () => {
    const route = createRevisionRoute(new CanvasProjection(), { threadOwned: true });
    const headers = { "x-octant-window-capability": windowCapability };

    const got = await route(
      new Request(`http://127.0.0.1/api/canvas/get?canvasId=${String(canvasId)}`, {
        method: "GET",
        headers,
      }),
    );
    const body = JSON.parse(await got!.text());
    expect(body.kind).toBe("ready");
    expect(body.version.definition.provenance.projectId).toBeNull();

    const cards = await route(
      new Request(
        `http://127.0.0.1/api/canvas/thread-reference-cards?mode=chat&threadId=${threadId}&projectId=null`,
        { method: "GET", headers },
      ),
    );
    const outcome = decodeCanvasThreadReferenceCardsOutcome(JSON.parse(await cards!.text()));
    expect(outcome.cards.map((card) => String(card.canvasId))).toEqual([String(canvasId)]);
    expect(outcome.cards[0]?.scope.workspace).toEqual({ kind: "chat-virtual", projectId: null });

    const created = await route(
      new Request("http://127.0.0.1/api/canvas/create", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({
          ...createBody(),
          workspace: { kind: "chat-virtual", projectId: null },
        }),
      }),
    );
    const result = decodeCanvasCreateResult(JSON.parse(await created!.text()));
    expect(result.kind).toBe("accepted");

    const folder = await route(
      new Request(`http://127.0.0.1/api/canvas/export-folder?canvasId=${String(canvasId)}`, {
        method: "GET",
        headers,
      }),
    );
    expect(JSON.parse(await folder!.text())).toMatchObject({
      kind: "canvas-export-folder-view",
      scope: "host",
    });

    // The Canvas is the thread's, not Work's: a window in another mode is
    // refused it the way it would be refused any Chat Canvas.
    const workRoute = createRevisionRoute(new CanvasProjection(), {
      threadOwned: true,
      activeMode: "work",
    });
    const refused = await workRoute(
      new Request(`http://127.0.0.1/api/canvas/get?canvasId=${String(canvasId)}`, {
        method: "GET",
        headers,
      }),
    );
    expect(JSON.parse(await refused!.text()).kind).toBe("unauthorized");
  });

  it("lists the recipes a person may start a Canvas from, and only to an authenticated window", async () => {
    const route = createRevisionRoute();
    const listed = await route(
      new Request("http://127.0.0.1/api/canvas/recipes", {
        method: "GET",
        headers: { "x-octant-window-capability": windowCapability },
      }),
    );
    expect(listed?.status).toBe(200);
    const catalog = decodeCanvasDocumentRecipeCatalog(JSON.parse(await listed!.text()));
    expect(catalog.recipes.map((recipe) => String(recipe.id))).toContain("implementation-plan");

    const anonymous = await route(
      new Request("http://127.0.0.1/api/canvas/recipes", { method: "GET" }),
    );
    expect(anonymous?.status).toBe(401);
    const withQuery = await route(
      new Request("http://127.0.0.1/api/canvas/recipes?projectId=x", {
        method: "GET",
        headers: { "x-octant-window-capability": windowCapability },
      }),
    );
    expect(withQuery?.status).toBe(400);
  });

  it("creates a Canvas from a recipe through the authenticated route", async () => {
    const route = createRevisionRoute();
    const { prompt: _prompt, ...body } = createBody() as Record<string, unknown>;
    const create = await route(
      new Request("http://127.0.0.1/api/canvas/create", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": windowCapability,
        },
        body: JSON.stringify({ ...body, intent: "template", templateId: "postmortem" }),
      }),
    );
    const result = decodeCanvasCreateResult(JSON.parse(await create!.text()));
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    const read = await route(
      new Request(`http://127.0.0.1/api/canvas/get?canvasId=${String(result.receipt.canvasId)}`, {
        method: "GET",
        headers: { "x-octant-window-capability": windowCapability },
      }),
    );
    const outcome = JSON.parse(await read!.text());
    expect(outcome.version.definition.blocks[0]).toMatchObject({
      kind: "heading",
      text: "What happened",
    });
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

describe("canvas comment routes", () => {
  const commentId = "abababab-abab-4bab-8bab-000000000101";

  function commentBody(expectedSequence: number) {
    return {
      kind: "canvas-comment-add",
      canvasId,
      commentId,
      anchor: { kind: "node", blockId: "board-1", nodeId: "db" },
      author: { kind: "local-user", actorId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      body: "Should this be Postgres?",
      expectedSequence,
      issuedAt: now,
    };
  }

  it("journals a comment from the host window and reads it back with a host origin", async () => {
    const route = createRevisionRoute();
    const unauthenticated = await route(
      new Request("http://127.0.0.1/api/canvas/comment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(commentBody(0)),
      }),
    );
    expect(unauthenticated?.status).toBe(401);

    const accepted = await route(
      new Request("http://127.0.0.1/api/canvas/comment", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": windowCapability,
        },
        body: JSON.stringify(commentBody(0)),
      }),
    );
    expect(JSON.parse(await accepted!.text())).toMatchObject({ kind: "accepted", sequence: 1 });

    const read = await route(
      new Request(`http://127.0.0.1/api/canvas/comments?canvasId=${String(canvasId)}`, {
        method: "GET",
        headers: { "x-octant-window-capability": windowCapability },
      }),
    );
    const outcome = JSON.parse(await read!.text());
    expect(outcome.kind).toBe("ready");
    expect(outcome.threads[0].comment).toMatchObject({
      body: "Should this be Postgres?",
      origin: { kind: "host" },
      anchor: { kind: "node", blockId: "board-1", nodeId: "db" },
    });

    const stale = await route(
      new Request("http://127.0.0.1/api/canvas/comment", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": windowCapability,
        },
        body: JSON.stringify({
          ...commentBody(0),
          commentId: "abababab-abab-4bab-8bab-000000000102",
        }),
      }),
    );
    expect(JSON.parse(await stale!.text())).toMatchObject({
      kind: "denied",
      denialCode: "stale-version",
    });
  });

  it("records the paired device a comment came through, beside the local author", async () => {
    const route = createRevisionRoute();
    const remoteRequest = new Request("http://127.0.0.1/api/canvas/comment", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-octant-window-capability": windowCapability,
      },
      body: JSON.stringify(commentBody(0)),
    });
    bindPrincipalRouteContext(remoteRequest, {
      principal: createRemoteDevicePrincipal({
        hostId: "local" as never,
        deviceId: remoteDeviceId as never,
        credentialGeneration: 1,
        origin: "https://octant.invalid",
        protocolVersion: 1,
        capabilityDigest: "b".repeat(64),
        sessionId: "17171717-1717-4171-8171-171717171717" as never,
      }),
      scopeId: remoteDeviceId as never,
    });
    expect(JSON.parse(await (await route(remoteRequest))!.text())).toMatchObject({
      kind: "accepted",
    });
    const read = await route(
      new Request(`http://127.0.0.1/api/canvas/comments?canvasId=${String(canvasId)}`, {
        method: "GET",
        headers: { "x-octant-window-capability": windowCapability },
      }),
    );
    const outcome = JSON.parse(await read!.text());
    expect(outcome.threads[0].comment.origin).toEqual({
      kind: "remote-device",
      deviceId: remoteDeviceId,
    });
    expect(outcome.threads[0].comment.author).toEqual({
      kind: "local-user",
      actorId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
  });
});

describe("canvas export folder routes", () => {
  function chooseRequest(expectedVersion: number, candidateId = exportFolderCandidateId) {
    return new Request("http://127.0.0.1/api/canvas/export-folder", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-octant-window-capability": windowCapability,
      },
      body: JSON.stringify({
        schemaVersion: 1,
        kind: "choose-canvas-export-folder",
        canvasId: String(canvasId),
        mode: "work",
        candidateId,
        scope: "project",
        expectedVersion,
      }),
    });
  }

  function readRequest() {
    return new Request(`http://127.0.0.1/api/canvas/export-folder?canvasId=${String(canvasId)}`, {
      method: "GET",
      headers: { "x-octant-window-capability": windowCapability },
    });
  }

  it("reports no chosen folder and the Project scope a Canvas would remember", async () => {
    const route = createRevisionRoute();

    const response = await route(readRequest());
    const view = JSON.parse(await response!.text());

    expect(view.kind).toBe("canvas-export-folder-view");
    expect(view.scope).toBe("project");
    expect(view.folder).toBeUndefined();
    expect(view.settings.version).toBe(0);
  });

  it("remembers the folder a person chose for a Canvas's Project", async () => {
    const route = createRevisionRoute();

    const chosen = JSON.parse(await (await route(chooseRequest(0)))!.text());
    expect(chosen.kind).toBe("canvas-export-folder-settings");
    expect(chosen.settings.overrides).toHaveLength(1);
    expect(chosen.settings.overrides[0].projectId).toBe(String(projectId));

    const view = JSON.parse(await (await route(readRequest()))!.text());
    expect(view.folder).toBe(chosen.settings.overrides[0].folder);
    expect(view.folder).toContain("octant-export-route-");
  });

  it("refuses a choice made against a version the person has not seen", async () => {
    const route = createRevisionRoute();
    await route(chooseRequest(0));

    const stale = JSON.parse(await (await route(chooseRequest(0)))!.text());

    expect(stale).toMatchObject({
      kind: "canvas-export-folder-refused",
      reason: "stale-version",
    });
  });

  it("refuses a choice that names a folder the host never listed", async () => {
    const route = createRevisionRoute();

    const refused = JSON.parse(
      await (await route(chooseRequest(0, "00000000-0000-4000-8000-00000000dead")))!.text(),
    );

    expect(refused).toMatchObject({
      kind: "canvas-export-folder-refused",
      reason: "candidate-unavailable",
    });
    const view = JSON.parse(await (await route(readRequest()))!.text());
    expect(view.folder).toBeUndefined();
  });

  it("refuses to remember a folder for a window this host never authenticated", async () => {
    const route = createRevisionRoute();

    const response = await route(
      new Request("http://127.0.0.1/api/canvas/export-folder", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          kind: "choose-canvas-export-folder",
          canvasId: String(canvasId),
          mode: "work",
          candidateId: exportFolderCandidateId,
          scope: "project",
          expectedVersion: 0,
        }),
      }),
    );

    expect(response?.status).toBe(401);
  });

  it("refuses a malformed choose as a value rather than a failure", async () => {
    const route = createRevisionRoute();

    const response = await route(
      new Request("http://127.0.0.1/api/canvas/export-folder", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": windowCapability,
        },
        body: JSON.stringify({ kind: "choose-canvas-export-folder" }),
      }),
    );

    expect(JSON.parse(await response!.text())).toMatchObject({
      kind: "canvas-export-folder-refused",
      reason: "malformed",
    });
  });
});
