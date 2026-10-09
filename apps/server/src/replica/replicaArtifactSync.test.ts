import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import type { CredentialStore } from "@octant/host-runtime";
import {
  EventActor,
  LOCAL_HOST_ID,
  ReplayCursor,
  ReplicaOrigin,
  decodeCanvasVersion,
  encodeReplicaEntry,
  type CanvasId,
  type CanvasVersion,
  type ReplicaMembershipResult,
  type UtcTimestamp,
} from "@octant/contracts";
import { replicaArtifactHeads, replicaArtifactHidden } from "@octant/domain/replica-entry-policy";
import type { ReplicaStore, ReplicaStorePutResult } from "@octant/plugin-api/replica-store";
import { ArtifactLibraryService } from "../canvas/artifactLibraryService";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { catchUpProjection, ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { erasePurgedProjectData } from "../persistence/threadPurge";
import { REPLICA_ARTIFACT_EVENT_NAMES, ReplicaArtifactQueued } from "./replicaArtifactEvents";
import { ReplicaArtifactProjection } from "./replicaArtifactProjection";
import {
  ReplicaArtifactImport,
  ReplicaArtifactSyncService,
  replicaArtifactEntryFor,
  replicaSyncedLibraryEntries,
} from "./replicaArtifactSyncService";
import { createReplicaDeviceKey, makeReplicaDeviceSigner } from "./replicaDeviceKeyService";
import {
  createReplicaMembershipJournal,
  registerReplicaMembershipEvents,
  ReplicaMembershipProjection,
  type ReplicaMembershipJournal,
} from "./replicaMembershipProjection";
import {
  deriveReplicaJoinMatchingCode,
  ReplicaMembershipService,
  type ReplicaStoreSelection,
} from "./replicaMembershipService";
import { registerReplicaStoreSettingsEvents } from "./replicaStoreSettingsEvents";
import { ReplicaStoreSettingsService } from "./replicaStoreSettingsService";
import { bucketFake, type BucketFake } from "./s3BucketFake.test-support";
import {
  SyncedArtifactService,
  type SyncedArtifactPorts,
  type SyncedArtifactThread,
} from "./syncedArtifactService";

const NOW = "2026-10-08T09:00:00.000Z";
const actor = Schema.decodeUnknownSync(EventActor)({
  kind: "local-user",
  actorId: "99999999-9999-4999-8999-999999999999",
});
const BUCKET = "octant-sync";
const decodeQueued = Schema.decodeUnknownSync(ReplicaArtifactQueued);
const decodeOrigin = Schema.decodeUnknownSync(ReplicaOrigin);
const ids = {
  canvas: "10000000-0000-4000-8000-000000000001" as CanvasId,
  second: "10000000-0000-4000-8000-000000000002" as CanvasId,
  third: "10000000-0000-4000-8000-000000000003" as CanvasId,
  v1: "20000000-0000-4000-8000-000000000001",
  v2a: "20000000-0000-4000-8000-00000000002a",
  v2b: "20000000-0000-4000-8000-00000000002b",
  studioProject: "30000000-0000-4000-8000-000000000001",
  laptopProject: "30000000-0000-4000-8000-000000000002",
  thread: "40000000-0000-4000-8000-000000000001",
};

const directories: string[] = [];
let uuid = 0;
afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

function scratch(parent: string): string {
  const directory = realpathSync(mkdtempSync(join(parent, "octant-artifact-sync-")));
  directories.push(directory);
  return directory;
}

function nextUuid(): string {
  uuid += 1;
  return `00000000-0000-4000-8000-${String(uuid).padStart(12, "0")}`;
}

function memoryCredentials(): CredentialStore {
  const values = new Map<string, string>();
  return {
    async set(id, credential) {
      values.set(id, credential);
    },
    async has(id) {
      return values.has(id);
    },
    async resolve(id) {
      const value = values.get(id);
      if (value === undefined) throw new Error("missing");
      return value;
    },
    async delete(id) {
      values.delete(id);
    },
  };
}

/** Where every host in one scenario keeps its replica. */
type SharedStore =
  | { readonly kind: "folder"; readonly folder: string }
  | { readonly kind: "s3"; readonly bucket: BucketFake }
  | { readonly kind: "direct"; readonly selection: () => ReplicaStoreSelection };

/** What a computer keeps between runs: its journal and its keychain. */
interface Disk {
  readonly connection: SqliteConnection;
  readonly deviceKeys: CredentialStore;
  readonly bucketKeys: CredentialStore;
}

function disk(): Disk {
  const connection = openSqlite(join(scratch(tmpdir()), "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => NOW);
  return { connection, deviceKeys: memoryCredentials(), bucketKeys: memoryCredentials() };
}

/** A journal that refuses every append after the named event has been written `times` times. */
function stoppable(
  inner: ReplicaMembershipJournal,
  power: { stopAfter: string | undefined; times: number },
): ReplicaMembershipJournal {
  return {
    append: (input) => {
      if (power.times <= 0 && power.stopAfter !== undefined) throw new Error("The host stopped.");
      inner.append(input);
      if (input.eventName === power.stopAfter) power.times -= 1;
    },
  };
}

/**
 * One computer: its journal, projections, store settings, membership, and
 * artifact sync, with a local Canvas list standing in for the Canvas
 * projection. Built again on the same disk, it is that computer restarted.
 */
function computer(
  name: string,
  shared: SharedStore,
  options: {
    readonly disk?: Disk;
    readonly stopAfter?: { readonly eventName: string; readonly times: number };
    readonly planMode?: boolean;
  } = {},
) {
  const saved = options.disk ?? disk();
  const membershipProjection = new ReplicaMembershipProjection();
  const artifactProjection = new ReplicaArtifactProjection();
  const journal = new Journal({
    connection: saved.connection,
    registry: registerReplicaStoreSettingsEvents(
      registerReplicaMembershipEvents(new EventRegistry()),
    ),
    projections: new ProjectionRegistry()
      .register(new AggregateHeadsProjection())
      .register(membershipProjection)
      .register(artifactProjection),
    clock: () => NOW,
  });
  for (const projection of [membershipProjection, artifactProjection]) {
    catchUpProjection({
      connection: saved.connection,
      journal,
      projection,
      clock: () => NOW,
    });
  }
  const settings = new ReplicaStoreSettingsService({
    journal,
    uuid: nextUuid,
    actor,
    clock: () => NOW as UtcTimestamp,
    home: homedir(),
    standingOutsideApproval: false,
    credentials: saved.bucketKeys,
    ...(shared.kind === "s3" ? { s3Transport: shared.bucket.transport } : {}),
    readFileFlags: async () => 0,
    memberOfReplica: () => membershipProjection.state().local !== undefined,
  });
  const power = {
    stopAfter: options.stopAfter?.eventName,
    times: options.stopAfter?.times ?? 0,
  };
  const replicaJournal = stoppable(
    createReplicaMembershipJournal({
      journal,
      uuid: nextUuid,
      clock: () => NOW,
      actor: { kind: "local-user", actorId: "77777777-7777-4777-8777-777777777777" },
    }),
    power,
  );
  const store = shared.kind === "direct" ? shared.selection : () => settings.selection();
  const canvases = new Map<string, CanvasVersion[]>();
  const projects = new Map<string, string>([
    [ids.studioProject, "Launch"],
    [ids.laptopProject, "Field notes"],
  ]);
  const membership = new ReplicaMembershipService({
    store,
    credentials: {
      create: () => createReplicaDeviceKey(saved.deviceKeys),
      sign: (instanceId, payload) =>
        makeReplicaDeviceSigner(saved.deviceKeys, instanceId).sign(payload),
    },
    journal: replicaJournal,
    artifacts: new ReplicaArtifactImport({
      membership: () => membershipProjection.state(),
      artifacts: () => artifactProjection.state(),
      localCanvasIds: () => [...canvases.keys()] as CanvasId[],
      journal: replicaJournal,
    }),
    state: () => membershipProjection.state(),
    localHostId: LOCAL_HOST_ID,
    clock: () => Date.parse(NOW),
  });
  const sync = new ReplicaArtifactSyncService({
    membership,
    store,
    membershipState: () => membershipProjection.state(),
    artifactState: () => artifactProjection.state(),
    journal: replicaJournal,
    uuid: nextUuid,
    canvas: (canvasId) => {
      const versions = canvases.get(String(canvasId));
      const current = versions?.at(-1);
      return versions === undefined || current === undefined
        ? undefined
        : { currentVersion: current, versions };
    },
    projectName: (projectId) => projects.get(projectId),
    planMode: () => options.planMode === true,
  });
  const library = new ArtifactLibraryService({
    projection: { snapshot: () => new Map() },
    projects: () => [],
    liveShares: () => new Set(),
    synced: () => replicaSyncedLibraryEntries(artifactProjection.state()),
    clock: () => NOW as UtcTimestamp,
  });

  // Threads this computer has, as the binding policy sees them, and every
  // content reference recorded as external content on a thread.
  const threads: SyncedArtifactThread[] = [];
  const ingested: { threadId: string; contentReference: string; sourceLabel: string }[] = [];
  /** Commit a version the way the Canvas service does: append, then announce. */
  const append = (version: CanvasVersion) => {
    canvases.set(String(version.canvasId), [
      ...(canvases.get(String(version.canvasId)) ?? []),
      version,
    ]);
    void sync.versionCommitted(version);
    return { kind: "committed" as const, version };
  };
  const syncedArtifacts = new SyncedArtifactService({
    artifacts: () => artifactProjection.state(),
    membership: () => membershipProjection.state(),
    sync,
    localCanvas: (canvasId) => {
      const versions = canvases.get(String(canvasId));
      const current = versions?.at(-1);
      return versions === undefined || current === undefined
        ? undefined
        : { currentVersion: current, versions, projectName: "Here" };
    },
    threads: () => threads,
    ingest: (input) => {
      ingested.push(input);
      return true;
    },
    adopt: ({ canvasId, versionId, content, createdAt, threadId }) => {
      const current = canvases.get(String(canvasId))?.at(-1);
      const thread = threads.find((candidate) => candidate.threadId === threadId);
      if (current === undefined && thread === undefined) {
        return { kind: "denied", message: "No thread." };
      }
      return append(
        decodeCanvasVersion({
          schemaVersion: 1,
          canvasId,
          versionId,
          sequence: (current?.sequence ?? 0) + 1,
          definition: {
            ...content,
            provenance: current?.definition.provenance ?? {
              ...content.provenance,
              hostId: "local",
              projectId: thread?.projectId,
              threadId: thread?.threadId,
            },
          },
          createdBy: actor,
          createdAt,
        }),
      );
    },
    revise: ({ canvasId, blocks }) => {
      const current = canvases.get(String(canvasId))?.at(-1);
      if (current === undefined) return { kind: "denied", message: "Not open here." };
      return append(
        decodeCanvasVersion({
          ...current,
          versionId: nextUuid(),
          sequence: current.sequence + 1,
          definition: { ...current.definition, blocks },
        }),
      );
    },
    entry: (canvasId) =>
      canvases.has(String(canvasId))
        ? ({ canvasId } as unknown as ReturnType<SyncedArtifactPorts["entry"]>)
        : undefined,
    uuid: nextUuid,
    clock: () => NOW as UtcTimestamp,
  });

  /** Commit a version locally, the way the Canvas service announces one. */
  const commit = async (version: CanvasVersion) => {
    canvases.set(String(version.canvasId), [
      ...(canvases.get(String(version.canvasId)) ?? []),
      version,
    ]);
    await sync.versionCommitted(version);
  };
  const events = () => {
    const all: { eventName: string; payload: unknown }[] = [];
    let afterSequence = 0;
    for (;;) {
      const page = journal.replay(
        Schema.decodeUnknownSync(ReplayCursor)({ afterSequence, limit: 1_000 }),
      );
      for (const event of page) all.push({ eventName: event.eventName, payload: event.payload });
      const last = page.at(-1);
      if (last === undefined || page.length < 1_000) return all;
      afterSequence = Number(last.globalSequence);
    }
  };
  const id = () => {
    const local = membershipProjection.state().local;
    if (local === undefined) throw new Error(`${name} has no identity.`);
    return local.instanceId;
  };
  const turnSyncOn = async () => {
    if (shared.kind === "folder") {
      const chosen = await settings.chooseFolder({
        folder: shared.folder,
        expectedVersion: settings.settings().version,
      });
      if (chosen.kind !== "replica-store-settings-view") throw new Error("folder refused");
    }
    if (shared.kind === "s3") {
      const configured = await settings.configureS3({
        settings: {
          endpoint: "https://s3.example.test",
          region: "eu-north-1",
          bucket: BUCKET,
          addressing: "path",
        },
        credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "example-secret-value" },
        expectedVersion: settings.settings().version,
      });
      if (configured.kind !== "replica-store-settings-view") throw new Error("bucket refused");
    }
    if (shared.kind !== "direct") {
      await settings.setSync({ syncOn: true, expectedVersion: settings.settings().version });
    }
  };
  return {
    name,
    disk: saved,
    journal,
    connection: saved.connection,
    settings,
    membership,
    membershipProjection,
    artifactProjection,
    sync,
    library,
    canvases,
    commit,
    threads,
    ingested,
    syncedArtifacts,
    events,
    id,
    turnSyncOn,
  };
}

type Computer = ReturnType<typeof computer>;

function expectKind<K extends ReplicaMembershipResult["kind"]>(
  outcome: ReplicaMembershipResult | undefined,
  kind: K,
): Extract<ReplicaMembershipResult, { kind: K }> {
  if (outcome?.kind !== kind) throw new Error(`expected ${kind}, got ${JSON.stringify(outcome)}`);
  return outcome as Extract<ReplicaMembershipResult, { kind: K }>;
}

/** `joiner` asks; `approver` reads, approves with its code; the joiner confirms. */
async function joinThrough(joiner: Computer, approver: Computer): Promise<void> {
  const request = expectKind(
    await joiner.membership.execute({ kind: "write-join-request", displayName: joiner.name }),
    "join-requested",
  );
  expectKind(await approver.membership.execute({ kind: "pull" }), "pulled");
  const state = approver.membershipProjection.state();
  if (state.local === undefined || state.founder === undefined) throw new Error("no replica");
  const code = deriveReplicaJoinMatchingCode({
    joinRequest: request.entry,
    approver: state.local,
    founder: state.founder,
  });
  expectKind(
    await approver.membership.execute({
      kind: "approve-join",
      joinRequest: request.entry,
      confirmationCode: code,
    }),
    "join-approved",
  );
  expectKind(
    await joiner.membership.execute({
      kind: "confirm-join",
      approver: approver.id(),
      confirmationCode: code,
    }),
    "join-confirmed",
  );
}

/** The Studio Mac founds the replica and the MacBook Air joins it, both with sync on. */
async function pair(shared: SharedStore) {
  const studio = computer("Studio Mac", shared);
  const laptop = computer("MacBook Air", shared);
  await studio.turnSyncOn();
  await laptop.turnSyncOn();
  expectKind(
    await studio.membership.execute({ kind: "create-replica", displayName: studio.name }),
    "replica-created",
  );
  await joinThrough(laptop, studio);
  return { studio, laptop };
}

function canvasVersion(input: {
  readonly canvasId?: CanvasId;
  readonly versionId: string;
  readonly sequence: number;
  readonly text: string;
  readonly title?: string;
  readonly projectId?: string;
  readonly createdAt?: string;
}): CanvasVersion {
  const createdAt = input.createdAt ?? NOW;
  const projectId = input.projectId ?? ids.studioProject;
  return decodeCanvasVersion({
    schemaVersion: 1,
    canvasId: input.canvasId ?? ids.canvas,
    versionId: input.versionId,
    sequence: input.sequence,
    definition: {
      schemaVersion: 1,
      title: input.title ?? "Launch plan",
      provenance: {
        hostId: "local",
        projectId,
        actor: { kind: "system", actorId: "88888888-8888-4888-8888-888888888888" },
        providerInstanceId: "77777777-7777-4777-8777-777777777777",
        modelId: "octant-test-model",
        createdAt,
        mode: "work",
        threadId: ids.thread,
      },
      sourceManifest: [],
      blocks: [{ blockId: "t1", schemaVersion: 1, kind: "rich-text", text: input.text }],
    },
    createdBy: { kind: "system", actorId: "88888888-8888-4888-8888-888888888888" },
    createdAt,
  });
}

function headsOf(host: Computer, canvasId: CanvasId = ids.canvas) {
  const artifact = host.artifactProjection.state().artifact(canvasId);
  return artifact === undefined ? [] : replicaArtifactHeads(artifact);
}

function eventsNamed(host: Computer, eventName: string) {
  return host.events().filter((event) => event.eventName === eventName);
}

/** A write-once store in memory that counts every call and can go offline. */
function memoryStore() {
  const files = new Map<string, Uint8Array>();
  const state = { calls: 0, offline: false };
  const store: ReplicaStore = {
    kind: "replica-store",
    async status() {
      state.calls += 1;
      return state.offline ? "not-connected" : "ready";
    },
    async list() {
      state.calls += 1;
      if (state.offline) return { status: "not-connected" };
      return { status: "ready", entries: [...files.keys()].map((key) => ({ key })), reports: [] };
    },
    async get(key) {
      state.calls += 1;
      if (state.offline) return { status: "not-connected" };
      const bytes = files.get(key);
      return bytes === undefined ? { status: "missing" } : { status: "ready", bytes };
    },
    async putIfAbsent(key, bytes): Promise<ReplicaStorePutResult> {
      state.calls += 1;
      if (state.offline) return { status: "not-connected" };
      if (files.has(key)) return { status: "already-exists" };
      files.set(key, bytes);
      return { status: "stored" };
    },
  };
  return { store, files, state };
}

/**
 * Sign and write an artifact entry outside any sync service, as a computer
 * with that key could: a stranger, or a member writing around its own filter.
 */
async function writeArtifactEntry(
  files: Map<string, Uint8Array>,
  writer: {
    readonly keys: CredentialStore;
    readonly instanceId: string;
    readonly displayName: string;
    readonly publicKey: string;
    readonly sequence: number;
  },
  version: CanvasVersion,
): Promise<void> {
  const queued: ReplicaArtifactQueued = decodeQueued({
    queueId: nextUuid(),
    kind: "artifact-version",
    artifact: { canvasId: version.canvasId, hostId: writer.instanceId, projectName: "Launch" },
    parents: [],
    bundle: {
      octant: {
        format: "octant.artifact-bundle/1",
        canvasId: version.canvasId,
        versionId: version.versionId,
        sequence: version.sequence,
        title: version.definition.title,
        mode: "work",
        projectId: ids.studioProject,
        hostId: writer.instanceId,
        createdAt: NOW,
      },
      definition: version.definition,
    },
  });
  const entry = replicaArtifactEntryFor(
    queued,
    decodeOrigin({
      instanceId: writer.instanceId,
      displayName: writer.displayName,
      sequence: writer.sequence,
      publicKey: writer.publicKey,
    }),
  );
  const bytes = new TextEncoder().encode(encodeReplicaEntry(entry));
  const signed = await makeReplicaDeviceSigner(writer.keys, writer.instanceId).sign(bytes);
  if (signed.status !== "signed") throw new Error("signing refused");
  const path = `${writer.instanceId}/${String(writer.sequence)}`;
  files.set(`${path}.json`, bytes);
  files.set(`${path}.sig`, new TextEncoder().encode(signed.signature));
}

const STORES: ReadonlyArray<readonly [string, () => SharedStore]> = [
  ["a synced folder", () => ({ kind: "folder", folder: scratch(homedir()) })],
  ["an S3-compatible bucket", () => ({ kind: "s3", bucket: bucketFake(BUCKET) })],
];

describe.each(STORES)("artifact sync between two computers through %s", (_label, makeStore) => {
  it("shows a Canvas made on one computer on the other, keeps two heads, and carries a deletion", async () => {
    const shared = makeStore();
    const { studio, laptop } = await pair(shared);

    // A Canvas made on the Studio Mac shows up on the MacBook Air with the
    // Studio Mac's name and the Project it was filed under there.
    const v1 = canvasVersion({ versionId: ids.v1, sequence: 1, text: "Ship the preview first." });
    await studio.commit(v1);
    expect(studio.artifactProjection.state().outbox).toEqual([]);
    const pulled = expectKind(await laptop.sync.pull(), "pulled");
    expect(pulled.artifacts).toEqual([
      expect.objectContaining({ instanceId: studio.id(), outcome: "imported" }),
    ]);
    const imported = laptop.artifactProjection.state().artifact(ids.canvas);
    expect(imported?.versions.map((version) => version.writtenBy.displayName)).toEqual([
      "Studio Mac",
    ]);
    expect(imported?.versions[0]?.local).toBe(false);
    expect(imported?.originHostId).toBe(String(studio.id()));
    const listing = laptop.library.list({ tab: "all" }, { kind: "local-window" } as never);
    expect(listing.synced).toEqual([
      expect.objectContaining({
        canvasId: ids.canvas,
        computerName: "Studio Mac",
        projectName: "Launch",
        title: "Launch plan",
        headCount: 1,
      }),
    ]);
    // Imported, not bound: no local Canvas exists for it on the laptop.
    expect(laptop.canvases.has(String(ids.canvas))).toBe(false);

    // Both computers revise the same version. The laptop's revision stands in
    // for one made after a person opened the imported Canvas there.
    laptop.canvases.set(String(ids.canvas), [v1]);
    await studio.commit(
      canvasVersion({ versionId: ids.v2a, sequence: 2, text: "Ship the preview on Monday." }),
    );
    await laptop.commit(
      canvasVersion({
        versionId: ids.v2b,
        sequence: 2,
        text: "Ship the preview after the beta.",
        projectId: ids.laptopProject,
      }),
    );
    await studio.sync.sync();
    await laptop.sync.sync();
    const twoHeads = [
      { kind: "version", versionId: ids.v2a },
      { kind: "version", versionId: ids.v2b },
    ];
    expect(headsOf(studio)).toEqual(twoHeads);
    expect(headsOf(laptop)).toEqual(twoHeads);
    // Each side records the other's revision as a second head, not a replacement.
    const concurrent = (host: Computer) =>
      eventsNamed(host, REPLICA_ARTIFACT_EVENT_NAMES.reconciled).map(
        (event) => (event.payload as { outcome: string }).outcome,
      );
    expect(concurrent(studio)).toEqual(["concurrent-head"]);
    expect(concurrent(laptop)).toEqual(["imported", "concurrent-head"]);

    // A deletion on the Studio Mac reaches the laptop as a tombstone over both
    // heads, and the laptop hides the artifact.
    await studio.sync.artifactDeleted(ids.canvas);
    const afterDelete = expectKind(await laptop.sync.pull(), "pulled");
    expect(afterDelete.artifacts).toEqual([
      expect.objectContaining({ instanceId: studio.id(), outcome: "tombstone" }),
    ]);
    const deleted = laptop.artifactProjection.state().artifact(ids.canvas);
    expect(deleted?.tombstones[0]?.parentVersionIds.toSorted()).toEqual([ids.v2a, ids.v2b].sort());
    expect(deleted === undefined ? false : replicaArtifactHidden(deleted)).toBe(true);
    // Its versions stay in the history; nothing was overwritten.
    expect(deleted?.versions.map((version) => String(version.versionId)).sort()).toEqual(
      [ids.v1, ids.v2a, ids.v2b].sort(),
    );
  });
});

describe("artifact sync", () => {
  it("rebuilds the same state after a restart in the middle of a pull", async () => {
    const shared: SharedStore = { kind: "folder", folder: scratch(homedir()) };
    const { studio, laptop } = await pair(shared);
    const observer = computer("Mac mini", shared);
    await observer.turnSyncOn();
    await joinThrough(observer, studio);
    for (const [index, canvasId] of [ids.canvas, ids.second, ids.third].entries()) {
      await studio.commit(
        canvasVersion({
          canvasId,
          versionId: `20000000-0000-4000-8000-00000000010${String(index)}`,
          sequence: 1,
          text: `Plan ${String(index)}`,
          title: `Plan ${String(index)}`,
        }),
      );
    }

    // The laptop stops right after it journals its second import.
    const stopping = computer(laptop.name, shared, {
      disk: laptop.disk,
      stopAfter: { eventName: REPLICA_ARTIFACT_EVENT_NAMES.reconciled, times: 2 },
    });
    await expect(stopping.sync.pull()).rejects.toThrow("The host stopped.");
    expect(eventsNamed(stopping, REPLICA_ARTIFACT_EVENT_NAMES.reconciled)).toHaveLength(2);

    // It starts again on the same journal and pulls again.
    const restarted = computer(laptop.name, shared, { disk: laptop.disk });
    const resumed = expectKind(await restarted.sync.pull(), "pulled");
    expect(resumed.artifacts).toHaveLength(1);
    expectKind(await observer.sync.pull(), "pulled");

    const summary = (host: Computer) =>
      host.artifactProjection
        .state()
        .artifacts.map((artifact) => ({
          canvasId: String(artifact.canvasId),
          versions: artifact.versions.map((version) => ({
            versionId: String(version.versionId),
            writtenBy: version.writtenBy,
          })),
          heads: replicaArtifactHeads(artifact),
        }))
        .sort((left, right) => left.canvasId.localeCompare(right.canvasId));
    // Same state as a computer whose pull was never interrupted.
    expect(summary(restarted)).toEqual(summary(observer));
    expect(eventsNamed(restarted, REPLICA_ARTIFACT_EVENT_NAMES.reconciled)).toHaveLength(3);
    // And replaying the journal from the start again gives the same state.
    const replayed = computer(laptop.name, shared, { disk: laptop.disk });
    expect(summary(replayed)).toEqual(summary(restarted));
    expect(replayed.membershipProjection.state().settledSlots).toEqual(
      restarted.membershipProjection.state().settledSlots,
    );
    // A further pull reads nothing it already settled.
    expect(expectKind(await replayed.sync.pull(), "pulled").artifacts).toEqual([]);
  });

  it("queues publishes durably while the store is unreachable and drains them in order", async () => {
    const memory = memoryStore();
    const shared: SharedStore = {
      kind: "direct",
      selection: () => ({ status: "selected", store: memory.store }),
    };
    const { studio } = await pair(shared);
    memory.state.offline = true;

    const first = canvasVersion({ versionId: ids.v1, sequence: 1, text: "First" });
    const second = canvasVersion({ versionId: ids.v2a, sequence: 2, text: "Second" });
    await studio.commit(first);
    await studio.commit(second);

    // The local versions stand; the failure is a receipt, once per reason.
    expect(studio.canvases.get(String(ids.canvas))).toEqual([first, second]);
    const outbox = studio.artifactProjection.state().outbox;
    expect(outbox.map((queued) => String(queued.bundle.octant.versionId))).toEqual([
      ids.v1,
      ids.v2a,
    ]);
    expect(outbox[0]?.lastFailure).toBe("not-connected");
    expect(eventsNamed(studio, REPLICA_ARTIFACT_EVENT_NAMES.publishFailed)).toEqual([
      {
        eventName: REPLICA_ARTIFACT_EVENT_NAMES.publishFailed,
        payload: { queueId: outbox[0]?.queueId, reason: "not-connected" },
      },
    ]);

    // The queue survives a restart, and drains oldest first once the store is back.
    const restarted = computer(studio.name, shared, { disk: studio.disk });
    expect(restarted.artifactProjection.state().outbox).toHaveLength(2);
    memory.state.offline = false;
    await restarted.sync.drain();
    expect(restarted.artifactProjection.state().outbox).toEqual([]);
    const published = eventsNamed(restarted, REPLICA_ARTIFACT_EVENT_NAMES.published).map(
      (event) => event.payload as { queueId: string; sequence: number },
    );
    expect(published.map((event) => event.queueId)).toEqual(outbox.map((queued) => queued.queueId));
    const [firstSlot, secondSlot] = published.map((event) => event.sequence);
    expect(firstSlot).toBeLessThan(secondSlot ?? 0);
    expect(
      memory.files.has(`${String(restarted.id())}/${String(firstSlot)}.json`) &&
        memory.files.has(`${String(restarted.id())}/${String(secondSlot)}.json`),
    ).toBe(true);
  });

  it("journals a refused pull once and holds no content from it", async () => {
    const memory = memoryStore();
    const shared: SharedStore = {
      kind: "direct",
      selection: () => ({ status: "selected", store: memory.store }),
    };
    const { laptop } = await pair(shared);
    // A computer nobody admitted signs an artifact entry with its own key.
    const strangerKeys = memoryCredentials();
    const stranger = await createReplicaDeviceKey(strangerKeys);
    await writeArtifactEntry(
      memory.files,
      { keys: strangerKeys, ...stranger, displayName: "Stranger", sequence: 1 },
      canvasVersion({ versionId: ids.v1, sequence: 1, text: "Hello" }),
    );

    const firstPull = expectKind(await laptop.sync.pull(), "pulled");
    const secondPull = expectKind(await laptop.sync.pull(), "pulled");
    for (const pulled of [firstPull, secondPull]) {
      expect(pulled.refused).toContainEqual({
        instanceId: stranger.instanceId,
        sequence: 1,
        reason: "unknown-instance",
      });
    }
    expect(eventsNamed(laptop, REPLICA_ARTIFACT_EVENT_NAMES.reconciled)).toEqual([
      {
        eventName: REPLICA_ARTIFACT_EVENT_NAMES.reconciled,
        payload: {
          instanceId: stranger.instanceId,
          sequence: 1,
          outcome: "refused",
          reason: "unknown-instance",
        },
      },
    ]);
    expect(laptop.artifactProjection.state().artifacts).toEqual([]);
  });

  it("refuses to publish or import an artifact whose text carries a secret or a path", async () => {
    const memory = memoryStore();
    const shared: SharedStore = {
      kind: "direct",
      selection: () => ({ status: "selected", store: memory.store }),
    };
    const { studio, laptop } = await pair(shared);
    const leaking = canvasVersion({
      versionId: ids.v1,
      sequence: 1,
      text: "Logs are in /Users/henrik/Library/Logs/octant.log",
    });
    const files = memory.files.size;
    await studio.commit(leaking);
    expect(memory.files.size).toBe(files);
    expect(studio.artifactProjection.state().outbox).toEqual([]);
    expect(eventsNamed(studio, REPLICA_ARTIFACT_EVENT_NAMES.publishRefused)).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ reason: "unsafe-content", versionId: ids.v1 }),
      }),
    ]);

    // A member's copy that reached the store some other way is refused on import.
    const state = studio.membershipProjection.state();
    const local = state.local;
    if (local === undefined) throw new Error("no identity");
    const sequence = state.localSequence + 1;
    await writeArtifactEntry(
      memory.files,
      {
        keys: studio.disk.deviceKeys,
        instanceId: String(local.instanceId),
        displayName: local.displayName,
        publicKey: local.publicKey,
        sequence,
      },
      leaking,
    );
    const pulled = expectKind(await laptop.sync.pull(), "pulled");
    expect(pulled.refused).toContainEqual({
      instanceId: local.instanceId,
      sequence,
      reason: "unsafe-content",
    });
    expect(laptop.artifactProjection.state().artifacts).toEqual([]);
    // The slot is settled: the next pull does not read it again.
    expect(laptop.membershipProjection.state().holds(local.instanceId, sequence)).toBe(true);
  });

  it("makes no store call in Plan mode", async () => {
    const memory = memoryStore();
    const shared: SharedStore = {
      kind: "direct",
      selection: () => ({ status: "selected", store: memory.store }),
    };
    const { studio } = await pair(shared);
    const planning = computer(studio.name, shared, { disk: studio.disk, planMode: true });
    const calls = memory.state.calls;
    await planning.commit(canvasVersion({ versionId: ids.v1, sequence: 1, text: "Draft" }));
    await planning.sync.artifactDeleted(ids.canvas);
    expect(memory.state.calls).toBe(calls);
    expect(eventsNamed(planning, REPLICA_ARTIFACT_EVENT_NAMES.queued)).toEqual([]);
  });

  it("makes no store call and queues nothing with sync off", async () => {
    const bucket = bucketFake(BUCKET);
    const shared: SharedStore = { kind: "s3", bucket };
    const { studio } = await pair(shared);
    await studio.settings.setSync({
      syncOn: false,
      expectedVersion: studio.settings.settings().version,
    });
    const requests = bucket.requests.length;

    await studio.commit(canvasVersion({ versionId: ids.v1, sequence: 1, text: "Offline" }));
    await studio.sync.artifactDeleted(ids.canvas);
    await studio.sync.sync();
    const stop = studio.sync.start(60_000, {
      setInterval: () => undefined,
      clearInterval: () => undefined,
    });
    stop();
    await studio.sync.drain();

    expect(bucket.requests.length).toBe(requests);
    expect(eventsNamed(studio, REPLICA_ARTIFACT_EVENT_NAMES.queued)).toEqual([]);
    expect(eventsNamed(studio, "replica.command-refused@2")).toEqual([]);
  });

  it("erases its replica copies when a person erases the Canvas, without importing it again", async () => {
    const memory = memoryStore();
    const shared: SharedStore = {
      kind: "direct",
      selection: () => ({ status: "selected", store: memory.store }),
    };
    const { studio, laptop } = await pair(shared);
    await studio.commit(
      canvasVersion({ versionId: ids.v1, sequence: 1, text: "Quarterly salary bands" }),
    );
    expectKind(await laptop.sync.pull(), "pulled");
    const studioSequence = studio.membershipProjection.state().localSequence;

    for (const host of [studio, laptop]) {
      erasePurgedProjectData({
        connection: host.connection,
        projectId: ids.studioProject,
        canvasIds: [ids.canvas],
      });
      host.artifactProjection.evict([ids.canvas]);
      expect(host.artifactProjection.state().artifact(ids.canvas)).toBeUndefined();
    }

    const restartedStudio = computer(studio.name, shared, { disk: studio.disk });
    const restartedLaptop = computer(laptop.name, shared, { disk: laptop.disk });
    for (const host of [restartedStudio, restartedLaptop]) {
      expect(JSON.stringify(host.events())).not.toContain("Quarterly salary bands");
      expect(host.artifactProjection.state().artifact(ids.canvas)).toBeUndefined();
    }
    // The studio keeps its place in its own sequence; the laptop keeps the
    // slot settled, so a pull does not bring the erased content back.
    expect(restartedStudio.membershipProjection.state().localSequence).toBe(studioSequence);
    expect(expectKind(await restartedLaptop.sync.pull(), "pulled").artifacts).toEqual([]);
    expect(restartedLaptop.artifactProjection.state().artifact(ids.canvas)).toBeUndefined();
  });
});

/** A thread on one computer, compatible with a Work artifact unless told otherwise. */
function workThread(
  threadId: string,
  facts: Partial<SyncedArtifactThread["facts"]> = {},
): SyncedArtifactThread {
  return {
    threadId,
    title: "Launch review",
    updatedAt: NOW,
    projectId: ids.laptopProject,
    projectName: "Field notes",
    facts: {
      mode: "work",
      active: true,
      projectActive: true,
      readOnly: false,
      workspaceResolved: true,
      ...facts,
    },
  };
}

function queuedParents(host: Computer): ReadonlyArray<ReadonlyArray<string>> {
  return eventsNamed(host, REPLICA_ARTIFACT_EVENT_NAMES.queued).map((event) =>
    (event.payload as { parents: { versionId: string }[] }).parents.map((parent) =>
      String(parent.versionId),
    ),
  );
}

describe("synced artifacts in the library", () => {
  const laptopThread = "40000000-0000-4000-8000-0000000000aa";

  it("opens a synced artifact only in a compatible thread, as external content, and never republishes it", async () => {
    const shared: SharedStore = { kind: "folder", folder: scratch(homedir()) };
    const { studio, laptop } = await pair(shared);
    await studio.commit(canvasVersion({ versionId: ids.v1, sequence: 1, text: "Ship it." }));
    await laptop.sync.pull();

    // Nothing on the laptop can take a Work artifact: an archived Work thread
    // and a Code thread in Plan mode. The refusal says so, and nothing binds.
    laptop.threads.push(
      workThread("40000000-0000-4000-8000-0000000000a1", { active: false }),
      workThread("40000000-0000-4000-8000-0000000000a2", { mode: "code", readOnly: true }),
    );
    const detail = await laptop.syncedArtifacts.execute({ kind: "detail", canvasId: ids.canvas });
    expect(detail).toMatchObject({
      kind: "artifact-synced-detail",
      status: "current",
      openHere: false,
      threads: [],
      versions: [expect.objectContaining({ computerName: "Studio Mac", thisComputer: false })],
    });
    expect(
      await laptop.syncedArtifacts.execute({
        kind: "open",
        canvasId: ids.canvas,
        threadId: "40000000-0000-4000-8000-0000000000a1",
      }),
    ).toMatchObject({ kind: "artifact-synced-refused", reason: "no-compatible-thread" });
    expect(laptop.canvases.has(String(ids.canvas))).toBe(false);
    expect(laptop.ingested).toEqual([]);

    // With a compatible thread, a thread of the wrong mode is still refused.
    laptop.threads.push(workThread(laptopThread));
    expect(
      await laptop.syncedArtifacts.execute({
        kind: "open",
        canvasId: ids.canvas,
        threadId: "40000000-0000-4000-8000-0000000000a2",
      }),
    ).toMatchObject({ kind: "artifact-synced-refused", reason: "incompatible-thread" });

    // Opened in the compatible thread: recorded as external content on that
    // thread first, then bound there under the id it has everywhere.
    expect(
      await laptop.syncedArtifacts.execute({
        kind: "open",
        canvasId: ids.canvas,
        threadId: laptopThread,
      }),
    ).toMatchObject({ kind: "artifact-synced-opened" });
    expect(laptop.ingested).toEqual([
      {
        threadId: laptopThread,
        contentReference: `replica-artifact:${ids.canvas}:${ids.v1}`,
        sourceLabel: "Synced from Studio Mac",
      },
    ]);
    const bound = laptop.canvases.get(String(ids.canvas));
    expect(bound?.map((version) => String(version.versionId))).toEqual([ids.v1]);
    expect(String(bound?.[0]?.definition.provenance.threadId)).toBe(laptopThread);
    expect(String(bound?.[0]?.definition.provenance.projectId)).toBe(ids.laptopProject);
    // The Studio Mac's version is already in the store; the laptop queues nothing.
    expect(eventsNamed(laptop, REPLICA_ARTIFACT_EVENT_NAMES.queued)).toEqual([]);
    expect(
      await laptop.syncedArtifacts.execute({
        kind: "open",
        canvasId: ids.canvas,
        threadId: laptopThread,
      }),
    ).toMatchObject({ kind: "artifact-synced-refused", reason: "already-open-here" });
  });

  it("keeps one of two versions by publishing a version that resolves both on every computer", async () => {
    const shared: SharedStore = { kind: "folder", folder: scratch(homedir()) };
    const { studio, laptop } = await pair(shared);
    const v1 = canvasVersion({ versionId: ids.v1, sequence: 1, text: "Ship it." });
    await studio.commit(v1);
    await laptop.sync.pull();
    laptop.threads.push(workThread(laptopThread));
    await laptop.syncedArtifacts.execute({
      kind: "open",
      canvasId: ids.canvas,
      threadId: laptopThread,
    });

    // Both computers revise v1.
    await studio.commit(canvasVersion({ versionId: ids.v2a, sequence: 2, text: "Ship Monday." }));
    const laptopV1 = laptop.canvases.get(String(ids.canvas))?.[0];
    if (laptopV1 === undefined) throw new Error("not bound");
    await laptop.commit(
      decodeCanvasVersion({
        ...laptopV1,
        versionId: ids.v2b,
        sequence: 2,
        definition: {
          ...laptopV1.definition,
          blocks: [
            { blockId: "t1", schemaVersion: 1, kind: "rich-text", text: "Ship after beta." },
          ],
        },
      }),
    );
    await studio.sync.sync();
    await laptop.sync.sync();

    const detail = await laptop.syncedArtifacts.execute({ kind: "detail", canvasId: ids.canvas });
    if (detail.kind !== "artifact-synced-detail") throw new Error(JSON.stringify(detail));
    expect(detail.status).toBe("two-versions");
    expect(
      detail.versions
        .filter((version) => version.candidate)
        .map((version) => [String(version.versionId), version.computerName, version.thisComputer])
        .sort(),
    ).toEqual(
      [
        [ids.v2a, "Studio Mac", false],
        [ids.v2b, "MacBook Air", true],
      ].sort(),
    );
    expect(detail.versions.every((version) => version.computerName !== "")).toBe(true);
    // Each candidate carries a preview, so the two can be compared side by side.
    expect(
      detail.versions.filter((version) => version.candidate && version.preview !== undefined),
    ).toHaveLength(2);

    expect(
      await laptop.syncedArtifacts.execute({
        kind: "keep",
        canvasId: ids.canvas,
        versionId: ids.v1 as never,
      }),
    ).toMatchObject({ reason: "unknown-version" });
    const kept = await laptop.syncedArtifacts.execute({
      kind: "keep",
      canvasId: ids.canvas,
      versionId: ids.v2a as never,
    });
    expect(kept).toMatchObject({ kind: "artifact-synced-published", published: true });
    // The kept version takes the Studio Mac's content and names both as parents.
    const laptopHead = laptop.canvases.get(String(ids.canvas))?.at(-1);
    expect(laptopHead?.definition.blocks).toEqual(
      v1.definition.blocks.map(() => expect.anything()),
    );
    expect((laptopHead?.definition.blocks[0] as { text: string } | undefined)?.text).toBe(
      "Ship Monday.",
    );
    expect(queuedParents(laptop).at(-1)).toEqual([ids.v2a, ids.v2b].sort());
    expect(
      await laptop.syncedArtifacts.execute({ kind: "detail", canvasId: ids.canvas }),
    ).toMatchObject({ status: "current" });

    // The Studio Mac takes the resolving version in on its next pull, on top
    // of the version it had: nothing left to choose there either. Not while
    // its thread is archived: nothing is recorded on a thread that cannot
    // take it.
    await studio.sync.sync();
    studio.threads.push({
      ...workThread(ids.thread, { active: false }),
      projectId: ids.studioProject,
    });
    expect(studio.syncedArtifacts.catchUp()).toBe(0);
    expect(studio.ingested).toEqual([]);
    studio.threads.splice(0, 1, { ...workThread(ids.thread), projectId: ids.studioProject });
    expect(headsOf(studio)).toEqual([{ kind: "version", versionId: laptopHead?.versionId }]);
    studio.syncedArtifacts.catchUp();
    expect(String(studio.canvases.get(String(ids.canvas))?.at(-1)?.versionId)).toBe(
      String(laptopHead?.versionId),
    );
    expect(
      await studio.syncedArtifacts.execute({ kind: "detail", canvasId: ids.canvas }),
    ).toMatchObject({ status: "current" });
  });

  it("merges two versions into a new one through the revise path, naming both as parents", async () => {
    const shared: SharedStore = { kind: "folder", folder: scratch(homedir()) };
    const { studio, laptop } = await pair(shared);
    const observer = computer("Mac mini", shared);
    await observer.turnSyncOn();
    await joinThrough(observer, studio);
    // Two computers revise one version; the laptop holds neither open.
    const v1 = canvasVersion({ versionId: ids.v1, sequence: 1, text: "Ship it." });
    await studio.commit(v1);
    await observer.sync.pull();
    observer.canvases.set(String(ids.canvas), [v1]);
    await studio.commit(canvasVersion({ versionId: ids.v2a, sequence: 2, text: "Ship Monday." }));
    await observer.commit(
      canvasVersion({ versionId: ids.v2b, sequence: 2, text: "Ship after beta." }),
    );
    await observer.sync.sync();
    await laptop.sync.pull();

    // Merge needs a thread when it is not open here.
    expect(
      await laptop.syncedArtifacts.execute({ kind: "merge", canvasId: ids.canvas }),
    ).toMatchObject({ reason: "no-compatible-thread" });
    laptop.threads.push(workThread(laptopThread));
    expect(
      await laptop.syncedArtifacts.execute({ kind: "merge", canvasId: ids.canvas }),
    ).toMatchObject({ reason: "thread-required" });

    const merged = await laptop.syncedArtifacts.execute({
      kind: "merge",
      canvasId: ids.canvas,
      threadId: laptopThread,
    });
    expect(merged).toMatchObject({ kind: "artifact-synced-opened" });
    const history = laptop.canvases.get(String(ids.canvas)) ?? [];
    // Bound at one of the two, then a revision carrying both sides.
    expect(history).toHaveLength(2);
    expect(
      history[1]?.definition.blocks.map((block) => (block as { text: string }).text).sort(),
    ).toEqual(["Ship Monday.", "Ship after beta."].sort());
    expect(queuedParents(laptop)).toEqual([[ids.v2a, ids.v2b].sort()]);
    expect(laptop.ingested.map((record) => record.contentReference).sort()).toEqual(
      [
        `replica-artifact:${ids.canvas}:${ids.v2a}`,
        `replica-artifact:${ids.canvas}:${ids.v2b}`,
      ].sort(),
    );
    expect(
      await laptop.syncedArtifacts.execute({ kind: "detail", canvasId: ids.canvas }),
    ).toMatchObject({ status: "current", openHere: true });
  });

  it("restores an artifact deleted elsewhere by publishing a version over the deletion", async () => {
    const shared: SharedStore = { kind: "folder", folder: scratch(homedir()) };
    const { studio, laptop } = await pair(shared);
    await studio.commit(canvasVersion({ versionId: ids.v1, sequence: 1, text: "Ship it." }));
    await studio.sync.artifactDeleted(ids.canvas);
    await laptop.sync.pull();

    const listing = laptop.library.list({ tab: "all" }, { kind: "local-window" } as never);
    expect(listing.synced).toEqual([
      expect.objectContaining({ status: "deleted", deletedOn: "Studio Mac", title: "Launch plan" }),
    ]);
    expect(
      await laptop.syncedArtifacts.execute({
        kind: "keep",
        canvasId: ids.canvas,
        versionId: ids.v1 as never,
      }),
    ).toMatchObject({ reason: "not-two-versions" });

    const restored = await laptop.syncedArtifacts.execute({
      kind: "restore",
      canvasId: ids.canvas,
    });
    expect(restored).toMatchObject({ kind: "artifact-synced-published", published: true });
    expect(queuedParents(laptop)).toEqual([[ids.v1]]);
    // Restored here without opening it in a thread, and on the Studio Mac
    // once it pulls; the deletion stays in the history.
    expect(laptop.library.list({ tab: "all" }, { kind: "local-window" } as never).synced).toEqual([
      expect.objectContaining({ status: "current", computerName: "MacBook Air" }),
    ]);
    expect(laptop.canvases.has(String(ids.canvas))).toBe(false);
    await studio.sync.pull();
    expect(headsOf(studio).map((head) => head.kind)).toEqual(["version", "tombstone"]);
    expect(
      await laptop.syncedArtifacts.execute({ kind: "restore", canvasId: ids.canvas }),
    ).toMatchObject({ reason: "not-deleted" });
  });

  it("refuses to resolve two versions open here with sync off, rather than leave the choice behind", async () => {
    const shared: SharedStore = { kind: "folder", folder: scratch(homedir()) };
    const { studio, laptop } = await pair(shared);
    await studio.commit(canvasVersion({ versionId: ids.v1, sequence: 1, text: "Ship it." }));
    await laptop.sync.pull();
    laptop.threads.push(workThread(laptopThread));
    await laptop.syncedArtifacts.execute({
      kind: "open",
      canvasId: ids.canvas,
      threadId: laptopThread,
    });
    await studio.commit(canvasVersion({ versionId: ids.v2a, sequence: 2, text: "Ship Monday." }));
    await laptop.sync.pull();
    const laptopV1 = laptop.canvases.get(String(ids.canvas))?.[0];
    if (laptopV1 === undefined) throw new Error("not bound");
    await laptop.settings.setSync({
      syncOn: false,
      expectedVersion: laptop.settings.settings().version,
    });
    await laptop.commit(decodeCanvasVersion({ ...laptopV1, versionId: ids.v2b, sequence: 2 }));
    for (const command of [
      { kind: "keep", canvasId: ids.canvas, versionId: ids.v2a as never },
      { kind: "merge", canvasId: ids.canvas },
    ] as const) {
      expect(await laptop.syncedArtifacts.execute(command)).toMatchObject({ reason: "sync-off" });
    }
    expect(laptop.canvases.get(String(ids.canvas))).toHaveLength(2);
  });

  it("refuses to publish a choice with sync off", async () => {
    const shared: SharedStore = { kind: "folder", folder: scratch(homedir()) };
    const { studio, laptop } = await pair(shared);
    await studio.commit(canvasVersion({ versionId: ids.v1, sequence: 1, text: "Ship it." }));
    await studio.sync.artifactDeleted(ids.canvas);
    await laptop.sync.pull();
    await laptop.settings.setSync({
      syncOn: false,
      expectedVersion: laptop.settings.settings().version,
    });
    expect(
      await laptop.syncedArtifacts.execute({ kind: "restore", canvasId: ids.canvas }),
    ).toMatchObject({ kind: "artifact-synced-refused", reason: "sync-off" });
    expect(eventsNamed(laptop, REPLICA_ARTIFACT_EVENT_NAMES.queued)).toEqual([]);
  });
});
