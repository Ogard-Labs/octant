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
  decodeCanvasId,
  decodeCanvasVersion,
  type CanvasVersion,
} from "@octant/contracts";
import { EventActor } from "@octant/contracts/events";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import {
  CANVAS_ACTION_RECEIPT_RECORDED,
  CANVAS_CREATED,
  CANVAS_REFRESH_RECEIPT_RECORDED,
  CANVAS_VERSION_APPENDED,
  CanvasEventStore,
} from "./canvasEventStore";
import { CanvasProjection } from "./canvasProjection";
import { CanvasService } from "./canvasService";
import { createCanvasRefreshSourceResolver } from "./canvasRefreshSourceResolver";

const directories: Array<string> = [];
const now = "2026-08-01T21:00:00.000Z";
const later = "2026-08-01T21:01:00.000Z";

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-canvas-service-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

const ids = {
  canvas: "11111111-1111-4111-8111-111111111111",
  version: "22222222-2222-4222-8222-222222222222",
  version2: "33333333-3333-4333-8333-333333333333",
  request: "44444444-4444-4444-8444-444444444444",
  source: "55555555-5555-4555-8555-555555555555",
  project: "66666666-6666-4666-8666-666666666666",
  thread: "77777777-7777-4777-8777-777777777777",
  provider: "88888888-8888-4888-8888-888888888888",
  actor: "99999999-9999-4999-8999-999999999999",
} as const;

const canvasId = decodeCanvasId(ids.canvas);
const actor = Schema.decodeUnknownSync(EventActor)({ kind: "local-user", actorId: ids.actor });

const provenance = {
  mode: "chat",
  hostId: "local",
  projectId: ids.project,
  threadId: ids.thread,
  actor: { kind: "local-user", actorId: ids.actor },
  providerInstanceId: ids.provider,
  modelId: "octant-test-model",
  createdAt: now,
} as const;

const definition = {
  schemaVersion: CANVAS_SCHEMA_VERSION,
  title: "Canvas service fixture",
  provenance,
  sourceManifest: [],
  blocks: [
    {
      blockId: "block-1",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "heading",
      level: 1,
      text: "A bounded Canvas",
    },
  ],
} as const;

function version(overrides: Record<string, unknown> = {}): CanvasVersion {
  return decodeCanvasVersion({
    schemaVersion: CANVAS_SCHEMA_VERSION,
    canvasId: ids.canvas,
    versionId: ids.version,
    sequence: 1,
    definition,
    createdBy: provenance.actor,
    createdAt: now,
    ...overrides,
  });
}

function reviseRequest(expectedSequence = 1) {
  return {
    schemaVersion: 1,
    kind: "canvas-revise",
    requestId: ids.request,
    canvasId: ids.canvas,
    expectedSequence,
    prompt: "Add a summary section",
    hostId: "local",
    mode: "chat",
    workspace: { kind: "chat-virtual", projectId: null },
    originThreadId: ids.thread,
    actor: provenance.actor,
    providerInstanceId: ids.provider,
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
  } as const;
}

function createRequest() {
  return {
    schemaVersion: 1,
    kind: "canvas-create",
    requestId: ids.request,
    intent: "prompt",
    hostId: "local",
    mode: "chat",
    workspace: { kind: "chat-virtual", projectId: ids.project },
    originThreadId: ids.thread,
    title: "Created from thread",
    prompt: "Summarize this thread.",
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
  } as const;
}

function refreshRequest() {
  return {
    schemaVersion: 1,
    kind: "canvas-refresh",
    requestId: "44444444-4444-4444-8444-444444444444",
    canvasId: ids.canvas,
    recipe: {
      schemaVersion: 1,
      kind: "canvas-refresh-recipe",
      recipeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      canvasId: ids.canvas,
      hostId: "local",
      mode: "chat",
      workspace: { kind: "chat-virtual", projectId: null },
      originThreadId: ids.thread,
      providerInstanceId: ids.provider,
      modelId: "octant-test-model",
      parameters: [],
      sourceManifest: [],
    },
    expectedSequence: 1,
    hostId: "local",
    mode: "chat",
    workspace: { kind: "chat-virtual", projectId: null },
    originThreadId: ids.thread,
    actor: provenance.actor,
    providerInstanceId: ids.provider,
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
  } as const;
}

function createService(
  connection = openConnection(),
  refreshSource?: import("./canvasService").CanvasServiceDependencies["refreshSource"],
  initialVersion = version(),
  resolveWorkspace?: import("./canvasService").CanvasServiceDependencies["resolveWorkspace"],
  skillAuthorized?: import("./canvasService").CanvasServiceDependencies["skillAuthorized"],
  parameterAuthorized?: import("./canvasService").CanvasServiceDependencies["parameterAuthorized"],
  resolveSkillContribution?: import("./canvasService").CanvasServiceDependencies["resolveSkillContribution"],
) {
  const projection = new CanvasProjection();
  const registry = new EventRegistry()
    .register(CANVAS_CREATED, 1, CanvasCreated)
    .register(CANVAS_VERSION_APPENDED, 1, CanvasVersionAppended)
    .register(CANVAS_REFRESH_RECEIPT_RECORDED, 1, CanvasRefreshReceiptRecorded);
  const projections = new ProjectionRegistry()
    .register(new AggregateHeadsProjection())
    .register(projection);
  const journal = new Journal({
    connection,
    registry,
    projections,
    clock: () => now,
  });
  let counter = 0;
  const uuid = () => {
    counter += 1;
    const suffix = counter.toString(16).padStart(12, "0");
    return `bbbbbbbb-bbbb-4bbb-8bbb-${suffix}`;
  };
  const eventStore = new CanvasEventStore({ journal, uuid, actor });
  const service = new CanvasService(
    {
      projection,
      eventStore,
      uuid,
      clock: () => later as never,
    },
    {
      authorize: () => true,
      ...(refreshSource === undefined ? {} : { refreshSource }),
      ...(resolveWorkspace === undefined ? {} : { resolveWorkspace }),
      ...(skillAuthorized === undefined ? {} : { skillAuthorized }),
      ...(parameterAuthorized === undefined ? {} : { parameterAuthorized }),
      ...(resolveSkillContribution === undefined ? {} : { resolveSkillContribution }),
    },
  );
  eventStore.appendCreate({ canvasId, version: initialVersion, occurredAt: now as never });
  projection.applyCreated({ canvasId, version: initialVersion });
  return { service, projection, journal, connection, eventStore };
}

describe("CanvasService", () => {
  it("journals a new immutable version on revise and exposes opaque history", () => {
    const { service } = createService();
    const result = service.revise(
      reviseRequest(),
      { mode: "chat", projectId: ids.project },
      {
        id: ids.project,
        type: "chat",
        lifecycle: "active",
      },
    );
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    expect(result.receipt.sequence).toBe(2);
    const history = service.history(
      canvasId,
      { mode: "chat", projectId: ids.project },
      {
        id: ids.project,
        type: "chat",
        lifecycle: "active",
      },
    );
    expect(history.kind).toBe("ready");
    if (history.kind !== "ready") return;
    expect(history.history.entries).toHaveLength(2);
    expect(history.history.entries[1]?.promptSummary).toBe("Add a summary section");
  });

  it("returns prior versions through get with an explicit version id", () => {
    const { service } = createService();
    const accepted = service.revise(
      reviseRequest(),
      { mode: "chat", projectId: ids.project },
      {
        id: ids.project,
        type: "chat",
        lifecycle: "active",
      },
    );
    if (accepted.kind !== "accepted") return;
    const prior = service.get(
      canvasId,
      { mode: "chat", projectId: ids.project },
      { id: ids.project, type: "chat", lifecycle: "active" },
      ids.version as never,
    );
    expect(prior.kind).toBe("ready");
    if (prior.kind !== "ready") return;
    expect(prior.version.sequence).toBe(1);
  });

  it("denies stale revise requests without mutating the projection head", () => {
    const { service, projection } = createService();
    const denied = service.revise(
      reviseRequest(2),
      { mode: "chat", projectId: ids.project },
      {
        id: ids.project,
        type: "chat",
        lifecycle: "active",
      },
    );
    expect(denied).toMatchObject({ kind: "denied", denialCode: "stale-version" });
    expect(projection.getById(canvasId)?.currentVersion.sequence).toBe(1);
  });

  it("does not persist secret-shaped fields in journaled canvas payloads", () => {
    const { service, journal } = createService();
    service.revise(
      reviseRequest(),
      { mode: "chat", projectId: ids.project },
      {
        id: ids.project,
        type: "chat",
        lifecycle: "active",
      },
    );
    const batch = journal.replay({ afterSequence: 0 as never, limit: 100 });
    for (const envelope of batch) {
      const serialized = JSON.stringify(envelope.payload);
      expect(serialized).not.toMatch(/"credential"|"password"|"secret"/i);
    }
    const appended = batch.find((event) => event.eventName === CANVAS_VERSION_APPENDED);
    expect(appended).toBeDefined();
    expect(JSON.stringify(appended?.payload ?? {})).toContain("Add a summary section");
  });

  it("creates a first version and returns a durable thread card", () => {
    const { service, projection } = createService();
    const result = service.create(
      createRequest(),
      { mode: "chat", projectId: ids.project },
      { id: ids.project, type: "chat", lifecycle: "active" },
    );
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    expect(result.receipt.intent).toBe("prompt");
    expect(result.card.actionCount).toBe(0);
    expect(
      projection
        .byThread({ mode: "chat", projectId: ids.project as never, threadId: ids.thread })
        .some((entry) => String(entry.canvasId) === String(result.card.canvasId)),
    ).toBe(true);
  });

  it("reauthorizes and journals a complete refresh, then replays duplicates idempotently", async () => {
    const source = {
      sourceId: ids.source,
      kind: "artifact" as const,
      hostId: "local",
      projectId: ids.project,
      opaqueRef: "artifact:idempotent",
      displayName: "Idempotent source",
    };
    const current = version({ definition: { ...definition, sourceManifest: [source] } });
    const request = {
      ...refreshRequest(),
      recipe: { ...refreshRequest().recipe, sourceManifest: [source] },
    };
    const { service, projection, journal } = createService(
      openConnection(),
      (resolved) => ({
        sourceId: resolved.sourceId,
        status: "ready",
        refreshedDefinition: current.definition,
      }),
      current,
    );
    const first = await service.refresh(
      request,
      { mode: "chat", projectId: ids.project },
      { id: ids.project, type: "chat", lifecycle: "active" },
    );
    expect(first.kind).toBe("accepted");
    if (first.kind !== "accepted") return;
    expect(first.receipt.outcome).toBe("ready");
    expect(first.receipt.recipe?.sourceManifest).toEqual([source]);
    expect(first.receipt.sequence).toBe(2);
    expect(projection.getById(canvasId)?.currentVersion.sequence).toBe(2);
    const duplicate = await service.refresh(
      request,
      { mode: "chat", projectId: ids.project },
      { id: ids.project, type: "chat", lifecycle: "active" },
    );
    expect(duplicate).toEqual(first);
    expect(journal.replay({ afterSequence: 0 as never, limit: 100 })).toHaveLength(2);
  });

  it("denies a refresh when its skill is no longer installed at the requested version", async () => {
    let resolved = false;
    const { service } = createService(
      openConnection(),
      () => {
        resolved = true;
        return {
          sourceId: ids.source as never,
          status: "ready",
          refreshedDefinition: definition as never,
        };
      },
      version(),
      undefined,
      () => false,
    );
    const request = {
      ...refreshRequest(),
      recipe: {
        ...refreshRequest().recipe,
        skill: {
          qualifiedId:
            "agents-skills-directory:project:review:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          version: "1.0.0",
        },
      },
    };
    const result = await service.refresh(
      request,
      { mode: "chat", projectId: ids.project },
      { id: ids.project, type: "chat", lifecycle: "active" },
    );
    expect(result).toMatchObject({ kind: "denied", denialCode: "malformed-request" });
    expect(resolved).toBe(false);
  });

  describe("trusted skill contributions", () => {
    const skillDigest = `sha256:${"a".repeat(64)}`;
    const skillQualifiedId = `agents-skills-directory:project:review:${skillDigest}`;
    const skillSource = {
      sourceId: ids.source,
      kind: "artifact" as const,
      hostId: "local",
      projectId: ids.project,
      opaqueRef: "artifact:skill",
      displayName: "Skill source",
    };
    const skillContribution = {
      schemaVersion: 1 as const,
      kind: "canvas-skill-contribution" as const,
      qualifiedId: skillQualifiedId as never,
      version: "1.0.0" as never,
      digest: skillDigest as never,
      sourceKind: "agents-skills-directory" as const,
      supportedSources: ["artifact"] as const,
      layouts: [],
      presentationRules: [],
    };
    const skillRefreshRequest = () => ({
      ...refreshRequest(),
      recipe: {
        ...refreshRequest().recipe,
        sourceManifest: [skillSource],
        skill: { qualifiedId: skillQualifiedId, version: "1.0.0" },
      },
    });

    it("completes a refresh when the selected skill contributes a trusted presentation", async () => {
      const current = version({ definition: { ...definition, sourceManifest: [skillSource] } });
      const { service } = createService(
        openConnection(),
        (resolvedSource) => ({
          sourceId: resolvedSource.sourceId,
          status: "ready",
          refreshedDefinition: current.definition,
        }),
        current,
        undefined,
        () => true,
        undefined,
        () => ({ kind: "admitted", contribution: skillContribution as never }),
      );
      const result = await service.refresh(
        skillRefreshRequest(),
        { mode: "chat", projectId: ids.project },
        { id: ids.project, type: "chat", lifecycle: "active" },
      );
      expect(result).toMatchObject({ kind: "accepted" });
    });

    it("denies the refresh when the skill contribution is untrusted", async () => {
      const current = version({ definition: { ...definition, sourceManifest: [skillSource] } });
      let resolved = false;
      const { service } = createService(
        openConnection(),
        () => {
          resolved = true;
          return {
            sourceId: ids.source as never,
            status: "ready",
            refreshedDefinition: current.definition as never,
          };
        },
        current,
        undefined,
        () => true,
        undefined,
        () => ({ kind: "denied", denialCode: "untrusted", message: "Skill is not trusted." }),
      );
      const result = await service.refresh(
        skillRefreshRequest(),
        { mode: "chat", projectId: ids.project },
        { id: ids.project, type: "chat", lifecycle: "active" },
      );
      expect(result).toMatchObject({ kind: "denied", denialCode: "unauthorized" });
      // The prior complete version is preserved: no source was reauthorized.
      expect(resolved).toBe(false);
    });

    it("denies the refresh as incompatible when the skill does not support the source", async () => {
      const current = version({ definition: { ...definition, sourceManifest: [skillSource] } });
      const { service } = createService(
        openConnection(),
        (resolvedSource) => ({
          sourceId: resolvedSource.sourceId,
          status: "ready",
          refreshedDefinition: current.definition,
        }),
        current,
        undefined,
        () => true,
        undefined,
        () => ({
          kind: "denied",
          denialCode: "unsupported-source",
          message: "Skill does not support the 'artifact' source kind used by this Canvas.",
        }),
      );
      const result = await service.refresh(
        skillRefreshRequest(),
        { mode: "chat", projectId: ids.project },
        { id: ids.project, type: "chat", lifecycle: "active" },
      );
      expect(result).toMatchObject({ kind: "denied", denialCode: "incompatible" });
    });
  });

  it("denies renderer-forged parameter references without a server registry match", async () => {
    const source = {
      sourceId: ids.source,
      kind: "artifact" as const,
      hostId: "local",
      projectId: ids.project,
      opaqueRef: "artifact:parameter",
      displayName: "Parameter source",
    };
    const current = version({ definition: { ...definition, sourceManifest: [source] } });
    let resolved = false;
    const { service } = createService(
      openConnection(),
      () => {
        resolved = true;
        return {
          sourceId: ids.source as never,
          status: "ready",
          refreshedDefinition: current.definition as never,
        };
      },
      current,
      undefined,
      undefined,
      () => false,
    );
    const request = {
      ...refreshRequest(),
      recipe: {
        ...refreshRequest().recipe,
        parameters: [{ key: "range", value: "opaque:renderer-forged" }],
        sourceManifest: [source],
      },
    };
    const result = await service.refresh(
      request,
      { mode: "chat", projectId: ids.project },
      { id: ids.project, type: "chat", lifecycle: "active" },
    );
    expect(result).toMatchObject({ kind: "denied", denialCode: "unauthorized" });
    expect(resolved).toBe(false);
  });

  it("reconstructs idempotency receipts from the journal after service restart", async () => {
    const source = {
      sourceId: ids.source,
      kind: "artifact" as const,
      hostId: "local",
      projectId: ids.project,
      opaqueRef: "artifact:restart",
      displayName: "Restart source",
    };
    const current = version({ definition: { ...definition, sourceManifest: [source] } });
    const request = {
      ...refreshRequest(),
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaad",
      recipe: { ...refreshRequest().recipe, sourceManifest: [source] },
    };
    const first = createService(
      openConnection(),
      (resolved) => ({
        sourceId: resolved.sourceId,
        status: "ready",
        refreshedDefinition: current.definition,
      }),
      current,
    );
    const accepted = await first.service.refresh(
      request,
      { mode: "chat", projectId: ids.project },
      { id: ids.project, type: "chat", lifecycle: "active" },
    );
    const restarted = new CanvasService(
      {
        projection: first.projection,
        eventStore: first.eventStore,
        uuid: () => "cccccccc-cccc-4ccc-8ccc-000000000001",
        clock: () => later as never,
      },
      { authorize: () => true },
    );
    const replayed = await restarted.refresh(
      request,
      { mode: "chat", projectId: ids.project },
      { id: ids.project, type: "chat", lifecycle: "active" },
    );
    expect(replayed).toEqual(accepted);
  });

  it("returns stale-version when distinct refreshes race the same Canvas head", async () => {
    const source = {
      sourceId: ids.source,
      kind: "artifact" as const,
      hostId: "local",
      projectId: ids.project,
      opaqueRef: "artifact:race",
      displayName: "Race source",
    };
    const current = version({ definition: { ...definition, sourceManifest: [source] } });
    const request = (requestId: string) => ({
      ...refreshRequest(),
      requestId,
      recipe: { ...refreshRequest().recipe, sourceManifest: [source] },
    });
    const { service } = createService(
      openConnection(),
      (resolved) => ({
        sourceId: resolved.sourceId,
        status: "ready",
        refreshedDefinition: current.definition,
      }),
      current,
    );
    const [first, second] = await Promise.all([
      service.refresh(
        request("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaae"),
        { mode: "chat", projectId: ids.project },
        { id: ids.project, type: "chat", lifecycle: "active" },
      ),
      service.refresh(
        request("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaf"),
        { mode: "chat", projectId: ids.project },
        { id: ids.project, type: "chat", lifecycle: "active" },
      ),
    ]);
    expect([first, second].filter((result) => result.kind === "accepted")).toHaveLength(1);
    expect([first, second].filter((result) => result.kind === "denied")).toHaveLength(1);
    expect([first, second]).toContainEqual(
      expect.objectContaining({ kind: "denied", denialCode: "stale-version" }),
    );
    const loserRequestId =
      first.kind === "denied"
        ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaae"
        : "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaf";
    const loserCancel = await service.cancelRefresh({
      schemaVersion: 1,
      kind: "canvas-refresh-cancel",
      requestId: loserRequestId,
      recipeId: refreshRequest().recipe.recipeId,
      canvasId: ids.canvas,
    });
    expect(loserCancel).toMatchObject({ kind: "denied", denialCode: "unavailable" });
  });

  it("uses the canonical source and persists a regenerated definition", async () => {
    const source = {
      sourceId: ids.source,
      kind: "artifact" as const,
      hostId: "local",
      projectId: ids.project,
      opaqueRef: "artifact:canonical",
      displayName: "Canonical source",
    };
    const current = version({
      definition: { ...definition, sourceManifest: [source] },
    });
    let resolvedOpaqueRef: string | undefined;
    const refreshedDefinition = {
      ...current.definition,
      sourceManifest: [
        {
          ...source,
          sourceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as never,
          opaqueRef: "artifact:resolver-invented" as never,
        },
      ],
      provenance: {
        ...current.definition.provenance,
        projectId: "77777777-7777-4777-8777-777777777777" as never,
      },
      blocks: [
        ...current.definition.blocks,
        {
          blockId: "refreshed",
          schemaVersion: CANVAS_SCHEMA_VERSION,
          kind: "rich-text" as const,
          text: "Fresh source content",
        },
      ],
    } as unknown as import("@octant/contracts").CanvasDefinition;
    const { service, projection } = createService(
      openConnection(),
      (resolved, request) => {
        resolvedOpaqueRef = resolved.opaqueRef;
        return {
          sourceId: resolved.sourceId,
          status: "ready",
          refreshedDefinition,
          observedVersion: {
            contentSha256: "1111111111111111111111111111111111111111111111111111111111111111",
            observedAt: later as never,
          },
        };
      },
      current,
    );
    const request = {
      ...refreshRequest(),
      recipe: {
        ...refreshRequest().recipe,
        sourceManifest: [{ ...source, opaqueRef: "artifact:renderer-copy" }],
      },
    };
    const rejected = await service.refresh(
      request,
      { mode: "chat", projectId: ids.project },
      { id: ids.project, type: "chat", lifecycle: "active" },
    );
    expect(rejected).toMatchObject({ kind: "accepted", receipt: { outcome: "partial" } });
    expect(resolvedOpaqueRef).toBeUndefined();

    const canonicalRequest = {
      ...refreshRequest(),
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab",
      recipe: { ...refreshRequest().recipe, sourceManifest: [source] },
    };
    const accepted = await service.refresh(
      canonicalRequest,
      { mode: "chat", projectId: ids.project },
      { id: ids.project, type: "chat", lifecycle: "active" },
    );
    expect(accepted).toMatchObject({ kind: "accepted", receipt: { outcome: "ready" } });
    expect(resolvedOpaqueRef).toBe("artifact:canonical");
    expect(
      projection.getById(canvasId)?.currentVersion.definition.sourceManifest[0]?.opaqueRef,
    ).toBe("artifact:canonical");
    expect(projection.getById(canvasId)?.currentVersion.definition.blocks).toHaveLength(2);
    expect(projection.getById(canvasId)?.currentVersion.definition.blocks[1]).toMatchObject({
      text: "Fresh source content",
    });
    expect(
      String(projection.getById(canvasId)?.currentVersion.definition.provenance.projectId),
    ).toBe(ids.project);
    expect(String(projection.getById(canvasId)?.currentVersion.createdBy.actorId)).toBe(
      "00000000-0000-4000-8000-000000000002",
    );
    const retry = await service.refresh(
      {
        ...canonicalRequest,
        requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa0",
        expectedSequence: 2,
      },
      { mode: "chat", projectId: ids.project },
      { id: ids.project, type: "chat", lifecycle: "active" },
    );
    expect(retry).toMatchObject({ kind: "accepted", receipt: { outcome: "ready" } });
  });

  it("fails closed for real sources when no authoritative resolver is installed", async () => {
    const source = {
      sourceId: ids.source,
      kind: "artifact" as const,
      hostId: "local",
      projectId: ids.project,
      opaqueRef: "artifact:unresolved",
      displayName: "Unresolved source",
    };
    const { service, projection } = createService(
      openConnection(),
      undefined,
      version({ definition: { ...definition, sourceManifest: [source] } }),
    );
    const result = await service.refresh(
      { ...refreshRequest(), recipe: { ...refreshRequest().recipe, sourceManifest: [source] } },
      { mode: "chat", projectId: ids.project },
      { id: ids.project, type: "chat", lifecycle: "active" },
    );
    expect(result).toMatchObject({ kind: "accepted", receipt: { outcome: "failed" } });
    expect(projection.getById(canvasId)?.currentVersion.sequence).toBe(1);
  });

  it("keeps the prior complete version for stale sources", async () => {
    const source = {
      sourceId: "55555555-5555-4555-8555-555555555555",
      kind: "artifact" as const,
      hostId: "local",
      projectId: ids.project,
      opaqueRef: "artifact:source",
      displayName: "Source",
      sourceVersion: {
        contentSha256: "0000000000000000000000000000000000000000000000000000000000000000",
        observedAt: now,
      },
    };
    const { service, projection } = createService(openConnection(), () => ({
      sourceId: source.sourceId as never,
      status: "stale",
      message: "Source changed.",
    }));
    const request = {
      ...refreshRequest(),
      recipe: { ...refreshRequest().recipe, sourceManifest: [source] },
    };
    const result = await service.refresh(
      request,
      { mode: "chat", projectId: ids.project },
      { id: ids.project, type: "chat", lifecycle: "active" },
    );
    expect(result).toMatchObject({ kind: "accepted", receipt: { outcome: "partial" } });
    expect(projection.getById(canvasId)?.currentVersion.sequence).toBe(1);
  });

  it("rejects cancellation without a server-owned refresh operation", async () => {
    const { service } = createService();
    const cancel = await service.cancelRefresh({
      schemaVersion: 1,
      kind: "canvas-refresh-cancel",
      requestId: refreshRequest().requestId,
      recipeId: refreshRequest().recipe.recipeId,
      canvasId: ids.canvas,
    });
    expect(cancel).toMatchObject({ kind: "denied", denialCode: "unavailable" });
  });

  it("interrupts an active multi-source refresh when cancellation is recorded", async () => {
    const source = {
      sourceId: ids.source,
      kind: "artifact" as const,
      hostId: "local",
      projectId: ids.project,
      opaqueRef: "artifact:slow",
      displayName: "Slow source",
    };
    const current = version({ definition: { ...definition, sourceManifest: [source] } });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const request = {
      ...refreshRequest(),
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac",
      recipe: {
        ...refreshRequest().recipe,
        sourceManifest: [source],
      },
    };
    const { service } = createService(
      openConnection(),
      async () => {
        entered();
        await blocked;
        return { sourceId: source.sourceId as never, status: "stale", message: "changed" };
      },
      current,
    );
    const running = service.refresh(
      request,
      { mode: "chat", projectId: ids.project },
      { id: ids.project, type: "chat", lifecycle: "active" },
    );
    const duplicate = service.refresh(
      request,
      { mode: "chat", projectId: ids.project },
      { id: ids.project, type: "chat", lifecycle: "active" },
    );
    await started;
    const forgedCancel = await service.cancelRefresh({
      schemaVersion: 1,
      kind: "canvas-refresh-cancel",
      requestId: request.requestId,
      recipeId: request.recipe.recipeId,
      canvasId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    expect(forgedCancel).toMatchObject({ kind: "denied", denialCode: "unavailable" });
    const forgedRefresh = await service.refresh(
      {
        ...request,
        canvasId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        recipe: {
          ...request.recipe,
          canvasId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        },
      },
      { mode: "chat", projectId: ids.project },
      { id: ids.project, type: "chat", lifecycle: "active" },
    );
    expect(forgedRefresh).toMatchObject({ kind: "denied", denialCode: "unauthorized" });
    const cancel = await service.cancelRefresh({
      schemaVersion: 1,
      kind: "canvas-refresh-cancel",
      requestId: request.requestId,
      recipeId: request.recipe.recipeId,
      canvasId: ids.canvas,
    });
    expect(cancel).toMatchObject({ kind: "accepted", receipt: { outcome: "cancelled" } });
    release();
    await expect(running).resolves.toMatchObject({
      kind: "accepted",
      receipt: { outcome: "cancelled" },
    });
    await expect(duplicate).resolves.toMatchObject({
      kind: "accepted",
      receipt: { outcome: "cancelled" },
    });
  });

  it("refreshes a real source through the production resolver and journals the regenerated definition", async () => {
    const source = {
      sourceId: ids.source,
      kind: "artifact" as const,
      hostId: "local",
      projectId: ids.project,
      opaqueRef: "artifact:production",
      displayName: "Production artifact",
    };
    const current = version({ definition: { ...definition, sourceManifest: [source] } });
    const productionResolver = createCanvasRefreshSourceResolver({
      clock: () => later as never,
      artifactState: (projectId, opaqueRef) => {
        expect(projectId).toBe(ids.project);
        expect(opaqueRef).toBe("artifact:production");
        return {
          displayName: "Production artifact",
          relativePath: "notes/production.md",
          contentSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          deleted: false,
        };
      },
    });
    const { service, projection } = createService(openConnection(), productionResolver, current);
    const result = await service.refresh(
      { ...refreshRequest(), recipe: { ...refreshRequest().recipe, sourceManifest: [source] } },
      { mode: "chat", projectId: ids.project },
      { id: ids.project, type: "chat", lifecycle: "active" },
    );
    expect(result).toMatchObject({
      kind: "accepted",
      receipt: {
        outcome: "ready",
        sequence: 2,
        sources: [
          {
            sourceId: ids.source,
            status: "ready",
            observedVersion: {
              contentSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            },
          },
        ],
      },
    });
    const head = projection.getById(canvasId)?.currentVersion;
    expect(head?.sequence).toBe(2);
    expect(head?.definition.blocks).toHaveLength(2);
    expect(head?.definition.blocks[1]).toMatchObject({
      kind: "artifact-reference",
      sourceId: ids.source,
      label: "Production artifact",
      detail: "notes/production.md",
    });
    expect(head?.definition.sourceManifest[0]?.sourceVersion?.contentSha256).toBe(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
  });

  it("fails closed through the production resolver when a source is missing", async () => {
    const source = {
      sourceId: ids.source,
      kind: "artifact" as const,
      hostId: "local",
      projectId: ids.project,
      opaqueRef: "artifact:gone",
      displayName: "Gone artifact",
    };
    const current = version({ definition: { ...definition, sourceManifest: [source] } });
    const productionResolver = createCanvasRefreshSourceResolver({
      clock: () => later as never,
      artifactState: () => undefined,
    });
    const { service, projection } = createService(openConnection(), productionResolver, current);
    const result = await service.refresh(
      { ...refreshRequest(), recipe: { ...refreshRequest().recipe, sourceManifest: [source] } },
      { mode: "chat", projectId: ids.project },
      { id: ids.project, type: "chat", lifecycle: "active" },
    );
    expect(result).toMatchObject({
      kind: "accepted",
      receipt: { outcome: "partial", sources: [{ sourceId: ids.source, status: "missing" }] },
    });
    expect(projection.getById(canvasId)?.currentVersion.sequence).toBe(1);
  });
});

const actionAuthority = {
  filesystem: false,
  shell: false,
  git: false,
  network: false,
  tools: true,
  subagents: false,
  executionPolicy: "plan",
  permissionPersistence: "current-session",
} as const;

function actionRequest(
  command: unknown,
  approval: unknown = { kind: "not-required" },
  overrides: Record<string, unknown> = {},
) {
  return {
    schemaVersion: 1,
    kind: "canvas-action",
    requestId: ids.request,
    canvasId: ids.canvas,
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
    originThreadId: ids.thread,
    actor: provenance.actor,
    providerInstanceId: ids.provider,
    modelId: "octant-test-model",
    requestedAuthority: actionAuthority,
    approval,
    ...overrides,
  } as const;
}

function createActionService(
  extraDependencies: Partial<import("./canvasService").CanvasServiceDependencies> = {},
  initialVersion = version(),
  connection = openConnection(),
) {
  const projection = new CanvasProjection();
  const registry = new EventRegistry()
    .register(CANVAS_CREATED, 1, CanvasCreated)
    .register(CANVAS_VERSION_APPENDED, 1, CanvasVersionAppended)
    .register(CANVAS_REFRESH_RECEIPT_RECORDED, 1, CanvasRefreshReceiptRecorded)
    .register(CANVAS_ACTION_RECEIPT_RECORDED, 1, CanvasActionReceiptRecorded);
  const projections = new ProjectionRegistry()
    .register(new AggregateHeadsProjection())
    .register(projection);
  const journal = new Journal({ connection, registry, projections, clock: () => now });
  let counter = 0;
  const uuid = () => {
    counter += 1;
    return `bbbbbbbb-bbbb-4bbb-8bbb-${counter.toString(16).padStart(12, "0")}`;
  };
  const eventStore = new CanvasEventStore({ journal, uuid, actor });
  const service = new CanvasService(
    { projection, eventStore, uuid, clock: () => later as never },
    { authorize: () => true, ...extraDependencies },
  );
  eventStore.appendCreate({ canvasId, version: initialVersion, occurredAt: now as never });
  projection.applyCreated({ canvasId, version: initialVersion });
  return { service, projection, journal, connection, eventStore };
}

const activeProject = { id: ids.project, type: "chat", lifecycle: "active" } as const;
const chatContext = { mode: "chat", projectId: ids.project } as const;

function actionReceiptCount(journal: ReturnType<typeof createActionService>["journal"]): number {
  return journal
    .replay({ afterSequence: 0 as never, limit: 100 })
    .filter((event) => event.eventName === CANVAS_ACTION_RECEIPT_RECORDED).length;
}

describe("CanvasService actions", () => {
  it("executes an authorized read action and journals an auditable receipt", async () => {
    const { service, journal } = createActionService();
    const result = await service.executeAction(
      actionRequest({ command: "canvas.open-source", sourceId: ids.source }),
      chatContext,
      activeProject,
    );
    expect(result).toMatchObject({
      kind: "accepted",
      receipt: {
        outcome: "completed",
        capability: { command: "canvas.open-source", effect: "read", requiresApproval: false },
        report: { kind: "source-opened", sourceId: ids.source },
      },
    });
    expect(actionReceiptCount(journal)).toBe(1);
  });

  it("hands off request-refresh honestly without faking a completed refresh", async () => {
    const { service, projection } = createActionService();
    const result = await service.executeAction(
      actionRequest({ command: "canvas.request-refresh" }),
      chatContext,
      activeProject,
    );
    expect(result).toMatchObject({
      kind: "accepted",
      receipt: {
        outcome: "requested",
        report: { kind: "refresh-requested", canvasId: ids.canvas },
      },
    });
    // A hand-off never appends a new Canvas version.
    expect(projection.getById(canvasId)?.currentVersion.sequence).toBe(1);
  });

  it("replays a duplicate action request idempotently", async () => {
    const { service, journal } = createActionService();
    const request = actionRequest({ command: "canvas.open-thread", threadRef: "opaque:t" });
    const first = await service.executeAction(request, chatContext, activeProject);
    const duplicate = await service.executeAction(request, chatContext, activeProject);
    expect(duplicate).toEqual(first);
    expect(actionReceiptCount(journal)).toBe(1);
  });

  it("denies a stale action without recording a receipt", async () => {
    const { service, journal } = createActionService();
    const result = await service.executeAction(
      actionRequest({ command: "canvas.request-refresh" }, undefined, { expectedSequence: 2 }),
      chatContext,
      activeProject,
    );
    expect(result).toMatchObject({ kind: "denied", denialCode: "stale-version" });
    expect(actionReceiptCount(journal)).toBe(0);
  });

  it("gates a thread-proposing action behind explicit approval", async () => {
    const { service } = createActionService();
    const denied = await service.executeAction(
      actionRequest({ command: "canvas.propose-thread" }),
      chatContext,
      activeProject,
    );
    expect(denied).toMatchObject({ kind: "denied", denialCode: "approval-required" });
    const approved = await service.executeAction(
      actionRequest(
        { command: "canvas.propose-thread" },
        {
          kind: "approved",
          approvalId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        },
      ),
      chatContext,
      activeProject,
    );
    expect(approved).toMatchObject({
      kind: "accepted",
      receipt: {
        outcome: "requested",
        report: { kind: "thread-proposed", approvalId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
      },
    });
  });

  it("fails closed when the user explicitly denied the action", async () => {
    const { service } = createActionService();
    const result = await service.executeAction(
      actionRequest({ command: "canvas.propose-thread" }, { kind: "denied" }),
      chatContext,
      activeProject,
    );
    expect(result).toMatchObject({ kind: "denied", denialCode: "approval-denied" });
  });

  it("rejects a reused requestId that names a different action block", async () => {
    const { service } = createActionService();
    await service.executeAction(
      actionRequest({ command: "canvas.request-refresh" }),
      chatContext,
      activeProject,
    );
    const forged = await service.executeAction(
      actionRequest({ command: "canvas.request-refresh" }, undefined, {
        block: {
          blockId: "action-2",
          schemaVersion: 1,
          kind: "action",
          label: "Forged",
          command: { command: "canvas.request-refresh" },
        },
      }),
      chatContext,
      activeProject,
    );
    expect(forged).toMatchObject({ kind: "denied", denialCode: "unauthorized" });
  });

  it("denies a command whose capability was revoked before dispatch", async () => {
    let dispatched = false;
    const { service, journal } = createActionService({
      reauthorizeCommand: () => ({
        ok: false,
        code: "revoked",
        message: "The command capability was revoked.",
      }),
      executeCommand: () => {
        dispatched = true;
        return { outcome: "completed", report: { kind: "refresh-requested", canvasId } };
      },
    });
    const result = await service.executeAction(
      actionRequest({ command: "canvas.request-refresh" }),
      chatContext,
      activeProject,
    );
    expect(result).toMatchObject({ kind: "denied", denialCode: "revoked" });
    expect(dispatched).toBe(false);
    expect(actionReceiptCount(journal)).toBe(0);
  });

  it("rejects cancellation without a server-owned action operation", async () => {
    const { service } = createActionService();
    const cancel = await service.cancelAction({
      schemaVersion: 1,
      kind: "canvas-action-cancel",
      requestId: ids.request,
      canvasId: ids.canvas,
      blockId: "action-1",
    });
    expect(cancel).toMatchObject({ kind: "denied", denialCode: "unavailable" });
  });

  it("interrupts an in-flight action when cancellation is recorded", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { service, journal } = createActionService({
      executeCommand: async () => {
        entered();
        await blocked;
        return { outcome: "requested", report: { kind: "refresh-requested", canvasId } };
      },
    });
    const request = actionRequest({ command: "canvas.request-refresh" });
    const running = service.executeAction(request, chatContext, activeProject);
    const duplicate = service.executeAction(request, chatContext, activeProject);
    await started;
    const forgedCancel = await service.cancelAction({
      schemaVersion: 1,
      kind: "canvas-action-cancel",
      requestId: ids.request,
      canvasId: ids.canvas,
      blockId: "action-2",
    });
    expect(forgedCancel).toMatchObject({ kind: "denied", denialCode: "unavailable" });
    const cancel = await service.cancelAction({
      schemaVersion: 1,
      kind: "canvas-action-cancel",
      requestId: ids.request,
      canvasId: ids.canvas,
      blockId: "action-1",
    });
    expect(cancel).toMatchObject({ kind: "accepted", receipt: { outcome: "cancelled" } });
    release();
    await expect(running).resolves.toMatchObject({
      kind: "accepted",
      receipt: { outcome: "cancelled" },
    });
    await expect(duplicate).resolves.toMatchObject({
      kind: "accepted",
      receipt: { outcome: "cancelled" },
    });
    // Only the single cancelled receipt is journaled, not a second completion.
    expect(actionReceiptCount(journal)).toBe(1);
  });

  it("reconstructs action idempotency receipts after a service restart", async () => {
    const first = createActionService();
    const request = actionRequest({ command: "canvas.open-thread", threadRef: "opaque:reconnect" });
    const accepted = await first.service.executeAction(request, chatContext, activeProject);
    expect(accepted.kind).toBe("accepted");
    const restarted = new CanvasService(
      {
        projection: first.projection,
        eventStore: first.eventStore,
        uuid: () => "cccccccc-cccc-4ccc-8ccc-000000000001",
        clock: () => later as never,
      },
      { authorize: () => true },
    );
    const replayed = await restarted.executeAction(request, chatContext, activeProject);
    expect(replayed).toEqual(accepted);
    // The rebuilt receipt is served from the journal without a second append.
    expect(actionReceiptCount(first.journal)).toBe(1);
  });

  it("denies an action whose claimed workspace differs from the host-resolved scope", async () => {
    const { service, journal } = createActionService({
      resolveWorkspace: () => ({
        kind: "work-root",
        projectId: ids.project as never,
        rootId: ids.thread as never,
      }),
    });

    const result = await service.executeAction(
      actionRequest({ command: "canvas.open-source", sourceId: ids.source }),
      chatContext,
      activeProject,
    );

    expect(result).toMatchObject({ kind: "denied", denialCode: "scope-mismatch" });
    expect(actionReceiptCount(journal)).toBe(0);
  });

  it("denies an action when the host cannot resolve the Canvas workspace", async () => {
    const { service, journal } = createActionService({ resolveWorkspace: () => undefined });

    const result = await service.executeAction(
      actionRequest({ command: "canvas.open-source", sourceId: ids.source }),
      chatContext,
      activeProject,
    );

    expect(result).toMatchObject({ kind: "denied", denialCode: "scope-mismatch" });
    expect(actionReceiptCount(journal)).toBe(0);
  });
});

describe("CanvasService published workspace scope", () => {
  it("publishes the host-resolved workspace on a ready read", () => {
    const workspace = {
      kind: "work-root",
      projectId: ids.project as never,
      rootId: ids.thread as never,
    } as const;
    const { service } = createActionService({ resolveWorkspace: () => workspace });

    const outcome = service.get(canvasId, chatContext, activeProject);

    expect(outcome.kind).toBe("ready");
    if (outcome.kind !== "ready") return;
    // The client echoes this scope back; it never derives one of its own.
    expect(outcome.workspace).toEqual(workspace);
  });

  it("publishes no workspace when the host cannot resolve one", () => {
    const { service } = createActionService({ resolveWorkspace: () => undefined });

    const outcome = service.get(canvasId, chatContext, activeProject);

    expect(outcome.kind).toBe("ready");
    if (outcome.kind !== "ready") return;
    expect(outcome.workspace).toBeUndefined();
  });

  it("publishes the skills the host says may present this Canvas", () => {
    const options = [
      {
        skill: { qualifiedId: `agents-skills-directory:project:review:sha256:${"0".repeat(64)}` },
        displayName: "Review",
      },
    ] as never;
    const { service } = createActionService({
      resolveWorkspace: () => ({ kind: "chat-virtual", projectId: null }),
      listRefreshSkills: () => options,
    });

    const outcome = service.get(canvasId, chatContext, activeProject);

    expect(outcome.kind).toBe("ready");
    if (outcome.kind !== "ready") return;
    expect(outcome.refreshSkills).toEqual(options);
  });

  it("publishes no skills when the workspace scope is unresolved", () => {
    const listRefreshSkills = vi.fn(() => [] as never);
    const { service } = createActionService({
      resolveWorkspace: () => undefined,
      listRefreshSkills,
    });

    const outcome = service.get(canvasId, chatContext, activeProject);

    expect(outcome.kind).toBe("ready");
    if (outcome.kind !== "ready") return;
    expect(outcome.refreshSkills).toBeUndefined();
    // Skill eligibility is scoped by the workspace, so an unresolved scope must
    // not be answered with an unscoped list.
    expect(listRefreshSkills).not.toHaveBeenCalled();
  });
});
