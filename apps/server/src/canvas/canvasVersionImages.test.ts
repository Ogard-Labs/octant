import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import {
  CANVAS_SCHEMA_VERSION,
  CANVAS_VERSION_IMAGES_AGGREGATE_TYPE,
  CANVAS_VERSION_IMAGES_RECORDED,
  EventActor,
  LOCAL_HOST_ID,
  decodeCanvasBlock,
  decodeCanvasId,
  decodeCanvasVersion,
  decodeProjectId,
  decodeUtcTimestamp,
  decodeWorkThreadId,
  type CanvasVersion,
} from "@octant/contracts";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { liveWorkFilesystem } from "../work/workFilesystemPort";
import { readCanvasDesignAssetFile, type CanvasDesignAssetPorts } from "./canvasDesignAssets";
import { CanvasEventStore } from "./canvasEventStore";
import { CanvasProjection } from "./canvasProjection";
import { CanvasService } from "./canvasService";
import { CanvasVersionImageStore } from "./canvasVersionImages";

const PNG_A = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PNG_B = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6]);
const SHA_A = createHash("sha256").update(PNG_A).digest("hex");
const SHA_B = createHash("sha256").update(PNG_B).digest("hex");

const projectId = decodeProjectId("22222222-2222-4222-8222-222222222222");
const threadId = decodeWorkThreadId("33333333-3333-4333-8333-333333333333");
const actor = Schema.decodeUnknownSync(EventActor)({
  kind: "system",
  actorId: "00000000-0000-4000-8000-000000000001",
});
const localUserActor = Schema.decodeUnknownSync(EventActor)({
  kind: "local-user",
  actorId: "00000000-0000-4000-8000-000000000002",
});

let connection: SqliteConnection | undefined;
let journal: Journal;
let root: string | undefined;
let dbDirectory: string | undefined;

beforeEach(async () => {
  const now = new Date().toISOString();
  dbDirectory = await mkdtemp(join(tmpdir(), "octant-version-images-db-"));
  connection = openSqlite(join(dbDirectory, "journal.sqlite"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  root = await mkdtemp(join(tmpdir(), "octant-version-images-"));
  await writeFile(join(root, "home.png"), PNG_A);
});

afterEach(async () => {
  connection?.close();
  connection = undefined;
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  if (dbDirectory !== undefined) await rm(dbDirectory, { recursive: true, force: true });
  root = undefined;
  dbDirectory = undefined;
});

function designWithProjectFile(path = "home.png") {
  return decodeCanvasBlock({
    blockId: "screen",
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "design",
    title: "Screen",
    size: "phone",
    assets: [{ assetId: "shot", source: { kind: "project-file", path } }],
    frames: [{ frameId: "f1", title: "Home", html: '<img src="octant-asset:shot" alt="">' }],
  });
}

function designWithGeneratedImage() {
  return decodeCanvasBlock({
    blockId: "screen",
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "design",
    title: "Screen",
    size: "phone",
    assets: [
      {
        assetId: "hero",
        source: {
          kind: "generated-image",
          imageId: "44444444-4444-4444-8444-444444444444",
        },
      },
    ],
    frames: [{ frameId: "f1", title: "Home", html: '<img src="octant-asset:hero" alt="">' }],
  });
}

function versionWith(input: {
  readonly canvasId?: string;
  readonly versionId?: string;
  readonly sequence?: number;
  readonly createdAt?: string;
  readonly blocks: ReadonlyArray<ReturnType<typeof decodeCanvasBlock>>;
}): CanvasVersion {
  const canvasId = input.canvasId ?? "11111111-1111-4111-8111-111111111111";
  const versionId = input.versionId ?? randomUUID();
  const createdAt = input.createdAt ?? new Date(Date.now() + 10_000).toISOString();
  return decodeCanvasVersion({
    schemaVersion: CANVAS_SCHEMA_VERSION,
    canvasId,
    versionId,
    sequence: input.sequence ?? 1,
    definition: {
      schemaVersion: CANVAS_SCHEMA_VERSION,
      title: "Screens",
      blocks: input.blocks,
      sourceManifest: [],
      provenance: {
        hostId: LOCAL_HOST_ID,
        mode: "work",
        projectId,
        threadId,
        actor: { kind: "local-user", actorId: "00000000-0000-4000-8000-000000000002" },
        providerInstanceId: "00000000-0000-4000-8000-000000000003",
        modelId: "octant-local",
        createdAt,
      },
    },
    createdBy: { kind: "local-user", actorId: "00000000-0000-4000-8000-000000000002" },
    createdAt,
  });
}

function livePorts(): Pick<CanvasDesignAssetPorts, "projectFile"> {
  return {
    projectFile: async ({ path, maximumBytes }) =>
      readCanvasDesignAssetFile({
        filesystem: liveWorkFilesystem,
        root: root ?? "",
        path,
        maximumBytes,
      }),
  };
}

describe("Canvas version Project image digests", () => {
  it("journals only SHA-256 digests and no image bytes, and appends nothing when no Project file is declared", async () => {
    const store = new CanvasVersionImageStore({
      journal,
      ports: livePorts(),
      uuid: randomUUID,
      actor,
    });

    const withoutProjectFiles = versionWith({ blocks: [designWithGeneratedImage()] });
    await store.record(withoutProjectFiles);
    const noRows = journal.replayAggregate({
      aggregateType: CANVAS_VERSION_IMAGES_AGGREGATE_TYPE,
      aggregateId: String(withoutProjectFiles.canvasId),
      afterVersion: 0,
      limit: 10,
    });
    expect(noRows).toEqual([]);

    const withProjectFile = versionWith({
      canvasId: "55555555-5555-4555-8555-555555555555",
      blocks: [designWithProjectFile("home.png")],
    });
    await store.record(withProjectFile);

    const rows = journal.replayAggregate({
      aggregateType: CANVAS_VERSION_IMAGES_AGGREGATE_TYPE,
      aggregateId: String(withProjectFile.canvasId),
      afterVersion: 0,
      limit: 10,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventName).toBe(CANVAS_VERSION_IMAGES_RECORDED);
    const rawPayload = JSON.stringify(rows[0]?.payload);
    expect(rawPayload).toContain(SHA_A);
    expect(rawPayload).not.toContain(Buffer.from(PNG_A).toString("base64"));

    const blockRecord = await store.forBlock(
      String(withProjectFile.canvasId),
      String(withProjectFile.versionId),
      "screen",
    );
    expect(blockRecord?.get("shot")).toEqual({
      blockId: "screen",
      assetId: "shot",
      status: "recorded",
      sha256: SHA_A,
    });
  });

  it("records a file as unavailable when its change time is later than the version's createdAt", async () => {
    const createdAt = "2026-11-28T12:00:00.000Z";
    const createdAtMs = BigInt(Date.parse(createdAt));
    const store = new CanvasVersionImageStore({
      journal,
      ports: {
        projectFile: async ({ path }) =>
          path === "replaced.png"
            ? {
                status: "read",
                bytes: PNG_B,
                // Changed 5ms after the version committed.
                changedAt: (createdAtMs + 5n) * 1_000_000n,
              }
            : {
                status: "read",
                bytes: PNG_A,
                // Changed before commit (even within the same millisecond).
                changedAt: createdAtMs * 1_000_000n + 400_000n,
              },
      },
      uuid: randomUUID,
      actor,
    });
    const version = versionWith({
      createdAt,
      blocks: [
        decodeCanvasBlock({
          blockId: "screen",
          schemaVersion: CANVAS_SCHEMA_VERSION,
          kind: "design",
          title: "Screen",
          size: "phone",
          assets: [
            { assetId: "kept", source: { kind: "project-file", path: "kept.png" } },
            { assetId: "replaced", source: { kind: "project-file", path: "replaced.png" } },
          ],
          frames: [{ frameId: "f1", title: "Home", html: '<img src="octant-asset:kept" alt="">' }],
        }),
      ],
    });

    await store.record(version);

    const record = await store.forBlock(
      String(version.canvasId),
      String(version.versionId),
      "screen",
    );
    expect(record?.get("kept")).toEqual({
      blockId: "screen",
      assetId: "kept",
      status: "recorded",
      sha256: SHA_A,
    });
    expect(record?.get("replaced")).toEqual({
      blockId: "screen",
      assetId: "replaced",
      status: "unavailable",
    });
  });

  it("records versions authored locally and on refresh, but skips carried-in and replica-adopted versions", async () => {
    const projection = new CanvasProjection();
    const eventStore = new CanvasEventStore({
      journal,
      uuid: randomUUID,
      actor: localUserActor,
    });
    const imageStore = new CanvasVersionImageStore({
      journal,
      ports: livePorts(),
      uuid: randomUUID,
      actor,
    });
    const announced = vi.fn();
    let clockMs = Date.now() + 10_000;
    const workspace = {
      kind: "work-root" as const,
      projectId,
      rootId: "66666666-6666-4666-8666-666666666666" as never,
    };
    const context = {
      mode: "work" as const,
      projectId: String(projectId),
      hostId: String(LOCAL_HOST_ID),
      workspace,
      originThreadId: String(threadId),
    };
    const project = { id: String(projectId), type: "work" as const, lifecycle: "active" as const };
    const source = {
      sourceId: "77777777-7777-4777-8777-777777777777",
      kind: "artifact" as const,
      hostId: LOCAL_HOST_ID,
      projectId,
      opaqueRef: "brief-1",
      displayName: "Brief",
    };
    const service = new CanvasService(
      {
        projection,
        eventStore,
        uuid: randomUUID,
        clock: () => decodeUtcTimestamp(new Date((clockMs += 1_000)).toISOString()),
        onVersionCommitted: announced,
        onLocalVersionCommitted: (version) => {
          void imageStore.record(version);
        },
      },
      {
        authorize: () => true,
        resolveWorkspace: () => workspace,
        refreshSource: async (entry, _request, currentDefinition) => ({
          sourceId: entry.sourceId,
          status: "ready",
          refreshedDefinition: currentDefinition,
        }),
      },
    );

    // 1. Local create records version 1.
    const created = service.create(
      {
        schemaVersion: 1,
        kind: "canvas-create",
        requestId: randomUUID(),
        intent: "blank",
        hostId: LOCAL_HOST_ID,
        mode: "work",
        workspace,
        originThreadId: threadId,
        title: "Local canvas",
        sourceManifest: [source],
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
      },
      context,
      project,
      [designWithProjectFile("home.png")],
    );
    expect(created.kind).toBe("accepted");
    if (created.kind !== "accepted") throw new Error("expected create");
    await imageStore.whenIdle();
    const createdRecord = await imageStore.forBlock(
      String(created.receipt.canvasId),
      String(created.receipt.versionId),
      "screen",
    );
    expect(createdRecord?.get("shot")).toEqual({
      blockId: "screen",
      assetId: "shot",
      status: "recorded",
      sha256: SHA_A,
    });

    // 2. Refresh records version 2 without announcing to mirror/replica.
    if (root === undefined) throw new Error("expected test root");
    await writeFile(join(root, "home.png"), PNG_B);
    clockMs = Date.now() + 20_000;
    announced.mockClear();
    const refreshed = await service.refresh(
      {
        schemaVersion: 1,
        kind: "canvas-refresh",
        requestId: randomUUID(),
        canvasId: created.receipt.canvasId,
        expectedSequence: 1,
        hostId: LOCAL_HOST_ID,
        mode: "work",
        workspace,
        originThreadId: threadId,
        actor: { kind: "local-user", actorId: "00000000-0000-4000-8000-000000000002" },
        providerInstanceId: "00000000-0000-4000-8000-000000000003",
        modelId: "octant-local",
        recipe: {
          schemaVersion: 1,
          kind: "canvas-refresh-recipe",
          recipeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          canvasId: created.receipt.canvasId,
          hostId: LOCAL_HOST_ID,
          mode: "work",
          workspace,
          originThreadId: threadId,
          providerInstanceId: "00000000-0000-4000-8000-000000000003",
          modelId: "octant-local",
          sourceManifest: [source],
          parameters: [],
        },
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
      },
      context,
      project,
    );
    expect(refreshed.kind).toBe("accepted");
    if (refreshed.kind !== "accepted" || refreshed.receipt.versionId === undefined) {
      throw new Error("expected accepted refresh");
    }
    expect(announced).not.toHaveBeenCalled();
    await imageStore.whenIdle();
    const refreshedRecord = await imageStore.forBlock(
      String(created.receipt.canvasId),
      String(refreshed.receipt.versionId),
      "screen",
    );
    expect(refreshedRecord?.get("shot")).toEqual({
      blockId: "screen",
      assetId: "shot",
      status: "recorded",
      sha256: SHA_B,
    });

    // 3. Carried-in version announces, but records NO image digests.
    const carriedCanvasId = decodeCanvasId("88888888-8888-4888-8888-888888888888");
    const carriedVersion = versionWith({
      canvasId: String(carriedCanvasId),
      blocks: [designWithProjectFile("home.png")],
    });
    service.carryMovedCanvas({
      canvasId: carriedCanvasId,
      versions: [{ versionId: carriedVersion.versionId, source: carriedVersion }],
      provenance: {
        hostId: LOCAL_HOST_ID,
        projectId: String(projectId),
        threadId: String(threadId),
      },
      carriesOutsideContent: false,
    });
    await imageStore.whenIdle();
    expect(
      await imageStore.recordForVersion(String(carriedCanvasId), String(carriedVersion.versionId)),
    ).toBeUndefined();

    // 4. Replica-adopted version announces, but records NO image digests.
    const adoptedCanvasId = decodeCanvasId("99999999-9999-4999-8999-999999999999");
    const adoptedSource = versionWith({
      canvasId: String(adoptedCanvasId),
      blocks: [designWithProjectFile("home.png")],
    });
    const adopted = service.adoptVersion(
      {
        canvasId: adoptedCanvasId,
        versionId: adoptedSource.versionId,
        content: adoptedSource.definition,
        createdAt: adoptedSource.createdAt,
      },
      context,
      project,
    );
    expect(adopted.kind).toBe("adopted");
    await imageStore.whenIdle();
    expect(
      await imageStore.recordForVersion(String(adoptedCanvasId), String(adoptedSource.versionId)),
    ).toBeUndefined();
  });
});
