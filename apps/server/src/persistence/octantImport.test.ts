import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  decodeChatThread,
  decodeEventActor,
  decodeProject,
  decodeProjectId,
  type ChatSettings,
  type ChatThread,
  type Project,
} from "@octant/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { AutomationEventStore } from "../automation/automationEventStore";
import { automationDefinitionFixture } from "../automation/automationTestFixtures";
import { createCoordinatorWakeJournal } from "../coordinator/coordinatorWakeJournal";
import { CHAT_SETTINGS_AGGREGATE_ID, readChatSettings, readChatThread } from "./chatProjection";
import { Journal } from "./journal";
import { applyMigrations, MIGRATIONS } from "./migrations";
import { importFromOctant, type OctantImportOutcome } from "./octantImport";
import {
  COPIED_CONTENT_TABLES,
  COPIED_MARKER_TABLES,
  EXCLUDED_TABLES,
  JOURNAL_TABLES,
  TRIGGER_MAINTAINED_TABLES,
} from "./octantImportTables";
import { readProject } from "./projectProjection";
import { THREAD_RETENTION_AGGREGATE_ID } from "./threadRetentionProjection";
import { readDeviceRegistrations, readHostIdentity } from "./remoteAccessProjection";
import { createPhase1RuntimeRegistries } from "./runtimeRegistry";
import { openSqlite, type SqliteConnection } from "./sqlitePort";

const now = "2026-11-27T12:00:00.000Z";
const actor = { kind: "system" as const, actorId: "0c7a0000-0000-4000-8000-0000000000a1" };
const provider = "0c7a0000-0000-4000-8000-0000000000a2";
const ids = {
  project: decodeProjectId("0c7a0000-0000-4000-8000-000000000101"),
  shared: "0c7a0000-0000-4000-8000-000000000201",
  octantOnly: "0c7a0000-0000-4000-8000-000000000202",
  octantLater: "0c7a0000-0000-4000-8000-000000000203",
  nightlyOwn: "0c7a0000-0000-4000-8000-000000000301",
  nightlyLater: "0c7a0000-0000-4000-8000-000000000302",
} as const;

const directories: Array<string> = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface Store {
  readonly connection: SqliteConnection;
  readonly journal: Journal;
  close(): void;
}

function folders(): { readonly octant: string; readonly nightly: string } {
  const base = mkdtempSync(join(tmpdir(), "octant-import-"));
  directories.push(base);
  const octant = join(base, "Octant");
  const nightly = join(base, "Octant Nightly");
  mkdirSync(octant);
  mkdirSync(nightly);
  return { octant, nightly };
}

function openStore(folder: string): Store {
  const connection = openSqlite(join(folder, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  return { connection, journal, close: () => connection.close() };
}

function append(
  store: Store,
  aggregateType: string,
  aggregateId: string,
  eventName: string,
  payload: unknown,
): void {
  const head = store.connection
    .prepare(
      "SELECT coalesce(max(aggregate_version), 0) AS head FROM event_journal WHERE aggregate_type = ? AND aggregate_id = ?",
    )
    .get(aggregateType, aggregateId) as { readonly head: number };
  store.journal.append({
    aggregate: { aggregateType, aggregateId },
    expectedVersion: head.head,
    events: [
      {
        eventId: randomUUID(),
        eventName,
        eventVersion: 1,
        correlationId: randomUUID(),
        actor,
        occurredAt: now,
        payload,
      },
    ],
  });
}

function thread(id: string, title: string, version = 1): ChatThread {
  return decodeChatThread({
    id,
    title,
    lifecycle: "active",
    providerInstanceId: provider,
    modelId: "model-a",
    researchEnabled: false,
    researchRouting: "automatic",
    personalityInstructions: "Be direct.",
    version,
    createdAt: now,
    updatedAt: now,
  });
}

function createThread(store: Store, id: string, title: string): void {
  append(store, "chat-thread", id, "chat.thread-created@1", {
    kind: "thread-created",
    thread: thread(id, title),
  });
}

function renameThread(store: Store, id: string, title: string): void {
  const current = readChatThread(store.connection, id as ChatThread["id"]);
  if (current === undefined) throw new Error("the thread must exist to be renamed");
  append(store, "chat-thread", id, "chat.thread-updated@1", {
    kind: "thread-updated",
    thread: thread(id, title, current.version + 1),
  });
}

function project(name: string): Project {
  return decodeProject({
    id: ids.project,
    type: "chat",
    name,
    lifecycle: "active",
    pinned: false,
    rank: "1/2",
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
}

function setChatModel(store: Store, model: string): void {
  const version = (readChatSettings(store.connection)?.aggregateVersion ?? 0) + 1;
  const settings = {
    defaultProviderInstanceId: provider,
    defaultModelId: model,
    defaultResearchEnabled: false,
    defaultResearchRouting: "automatic",
    defaultPersonalityInstructions: "Be calm.",
    version,
    updatedAt: now,
  } as ChatSettings;
  append(store, "chat-settings", CHAT_SETTINGS_AGGREGATE_ID, "chat.settings-updated@1", {
    kind: "settings-updated",
    settings,
  });
}

function runImport(paths: { readonly octant: string; readonly nightly: string }) {
  return importFromOctant({
    octantDataDirectory: paths.octant,
    nightlyDataDirectory: paths.nightly,
    clock: () => now,
  });
}

function imported(outcome: OctantImportOutcome) {
  if (outcome.kind !== "imported") throw new Error(`import ${JSON.stringify(outcome)}`);
  return outcome;
}

function fileHashes(folder: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(folder)
      .filter((name) => name !== "octant.sqlite3-shm")
      .sort()
      .map((name) => [
        name,
        createHash("sha256")
          .update(readFileSync(join(folder, name)))
          .digest("hex"),
      ]),
  );
}

function storeHash(folder: string): string {
  return createHash("sha256")
    .update(readFileSync(join(folder, "octant.sqlite3")))
    .digest("hex");
}

function titleIn(folder: string, id: string): string | undefined {
  const store = openStore(folder);
  try {
    return readChatThread(store.connection, id as ChatThread["id"])?.title;
  } finally {
    store.close();
  }
}

function rawEvent(
  store: Store,
  aggregateType: string,
  aggregateId: string,
  version: number,
  eventName: string,
  payload: unknown,
): void {
  store.connection
    .prepare(
      `INSERT INTO event_journal (event_id, aggregate_type, aggregate_id, aggregate_version,
         event_name, event_version, host_id, correlation_id, actor_kind, actor_id, occurred_at,
         payload_json)
       VALUES (?, ?, ?, ?, ?, 1, 'local', ?, 'system', ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      aggregateType,
      aggregateId,
      version,
      eventName,
      randomUUID(),
      actor.actorId,
      now,
      JSON.stringify(payload),
    );
}

function eventsIn(
  folder: string,
  aggregateType: string,
  aggregateId: string,
): ReadonlyArray<{ readonly name: string; readonly payload: Record<string, unknown> }> {
  const store = openStore(folder);
  try {
    return (
      store.connection
        .prepare(
          `SELECT event_name, payload_json FROM event_journal
           WHERE aggregate_type = ? AND aggregate_id = ? ORDER BY aggregate_version`,
        )
        .all(aggregateType, aggregateId) as ReadonlyArray<{
        readonly event_name: string;
        readonly payload_json: string;
      }>
    ).map((row) => ({
      name: row.event_name,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    }));
  } finally {
    store.close();
  }
}

function wakeup(id: string, status: "pending" | "ended", change: "scheduled" | "ended") {
  return {
    wakeup: {
      id,
      mode: "work",
      threadId: ids.octantOnly,
      providerToolName: "ScheduleWakeup",
      prompt: "Check the build.",
      schedule: { kind: "delay" },
      humanSchedule: "in 10 minutes",
      createdAt: now,
      nextFireAt: "2026-11-27T12:10:00.000Z",
      status,
      ...(status === "ended" ? { endedReason: "fired" } : {}),
    },
    change,
  };
}

describe("importing Octant's data into Nightly", () => {
  it("reads a running Octant's store without changing any of its files but SQLite's shared-memory index", () => {
    const paths = folders();
    const octant = openStore(paths.octant);
    createThread(octant, ids.shared, "From Octant");
    const before = fileHashes(paths.octant);

    imported(runImport(paths));

    expect(fileHashes(paths.octant)).toEqual(before);
    octant.close();
    expect(titleIn(paths.nightly, ids.shared)).toBe("From Octant");
  });

  it("reads a stopped Octant's store without creating or changing any of its files", () => {
    const paths = folders();
    const octant = openStore(paths.octant);
    createThread(octant, ids.shared, "From Octant");
    octant.close();
    const before = fileHashes(paths.octant);

    imported(runImport(paths));

    expect(fileHashes(paths.octant)).toEqual(before);
    expect(readdirSync(paths.octant).filter((name) => name.endsWith("-wal"))).toEqual([]);
  });

  it("refuses a store a newer host migrated and leaves Nightly's store exactly as it was", () => {
    const paths = folders();
    const octant = openStore(paths.octant);
    octant.connection
      .prepare(
        "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
      )
      .run(1_000_000, "from_a_newer_host", "0".repeat(64), now);
    octant.close();
    const nightly = openStore(paths.nightly);
    createThread(nightly, ids.nightlyOwn, "Nightly's own");
    nightly.close();
    const before = storeHash(paths.nightly);

    expect(runImport(paths)).toEqual({ kind: "refused", reason: "octant-newer" });
    expect(storeHash(paths.nightly)).toBe(before);
    expect(existsSync(join(paths.nightly, "import"))).toBe(true);
    expect(readdirSync(join(paths.nightly, "import"))).toEqual([]);
  });

  it("refuses a missing Octant folder and one inside Nightly's", () => {
    const paths = folders();
    rmSync(paths.octant, { recursive: true });
    expect(runImport(paths)).toEqual({ kind: "refused", reason: "octant-missing" });

    const inside = join(paths.nightly, "Octant");
    mkdirSync(inside);
    openStore(inside).close();
    expect(runImport({ octant: inside, nightly: paths.nightly })).toEqual({
      kind: "refused",
      reason: "unsafe-folder",
    });
  });

  it("brings Octant's threads, Projects and settings on the first import and keeps Nightly's own threads", () => {
    const paths = folders();
    const octant = openStore(paths.octant);
    append(octant, "project", ids.project, "project.created@1", {
      project: project("Octant notes"),
    });
    createThread(octant, ids.shared, "From Octant");
    setChatModel(octant, "octant-model");
    octant.close();
    const nightly = openStore(paths.nightly);
    createThread(nightly, ids.nightlyOwn, "Nightly's own");
    setChatModel(nightly, "nightly-model");
    nightly.close();

    const outcome = imported(runImport(paths));

    expect(outcome.conflicts).toEqual([]);
    expect(outcome.counts.threads).toBe(1);
    const merged = openStore(paths.nightly);
    expect(readChatThread(merged.connection, ids.shared as ChatThread["id"])?.title).toBe(
      "From Octant",
    );
    expect(readChatThread(merged.connection, ids.nightlyOwn as ChatThread["id"])?.title).toBe(
      "Nightly's own",
    );
    expect(readProject(merged.connection, ids.project)?.name).toBe("Octant notes");
    expect(readChatSettings(merged.connection)?.settings.defaultModelId).toBe("octant-model");
    merged.close();
    expect(existsSync(join(paths.nightly, "octant.sqlite3.backup-before-octant-import"))).toBe(
      true,
    );
  });

  it("merges a later import: Nightly-only work stays, Octant-only work comes over, and a thread both changed is held back as a conflict", () => {
    const paths = folders();
    let octant = openStore(paths.octant);
    createThread(octant, ids.shared, "Shared");
    createThread(octant, ids.octantOnly, "Octant only");
    octant.close();
    imported(runImport(paths));

    const nightly = openStore(paths.nightly);
    renameThread(nightly, ids.shared, "Renamed in Nightly");
    createThread(nightly, ids.nightlyLater, "Started in Nightly");
    nightly.close();
    octant = openStore(paths.octant);
    renameThread(octant, ids.shared, "Renamed in Octant");
    renameThread(octant, ids.octantOnly, "Continued in Octant");
    createThread(octant, ids.octantLater, "Started in Octant");
    octant.close();

    const second = imported(runImport(paths));

    expect(second.conflicts).toEqual([{ mode: "chat", octantThreadId: ids.shared }]);
    expect(titleIn(paths.nightly, ids.shared)).toBe("Renamed in Nightly");
    expect(titleIn(paths.nightly, ids.octantOnly)).toBe("Continued in Octant");
    expect(titleIn(paths.nightly, ids.octantLater)).toBe("Started in Octant");
    expect(titleIn(paths.nightly, ids.nightlyLater)).toBe("Started in Nightly");

    // Octant goes on with the conflicting thread while Nightly leaves it be:
    // it stays held back, since Nightly's stream never took the turn between.
    octant = openStore(paths.octant);
    renameThread(octant, ids.shared, "Renamed in Octant again");
    octant.close();
    const third = imported(runImport(paths));
    expect(third.conflicts).toEqual([{ mode: "chat", octantThreadId: ids.shared }]);
    expect(titleIn(paths.nightly, ids.shared)).toBe("Renamed in Nightly");
  });

  it("leaves Octant's host identity and paired devices behind", () => {
    const paths = folders();
    const octant = openStore(paths.octant);
    const octantHost = "11111111-1111-4111-8111-111111111111";
    append(octant, "remote-host", octantHost, "remote.host-identity-initialized@1", {
      hostId: octantHost,
      displayName: "Octant's Mac",
      hostKeyFingerprint: "a".repeat(64),
      keyGeneration: 1,
      createdAt: now,
    });
    append(
      octant,
      "remote-device",
      "22222222-2222-4222-8222-222222222222",
      "remote.device-registered@1",
      {
        device: {
          hostId: octantHost,
          deviceId: "22222222-2222-4222-8222-222222222222",
          deviceKeyFingerprint: "b".repeat(64),
          devicePublicKey: "public-key",
          deviceLabel: "Phone",
          origin: "https://mac.example.test",
          protocolFloor: 1,
          credentialGeneration: 1,
          createdAt: now,
          expiresAt: "2027-02-26T12:00:00.000Z",
          lastSeenAt: now,
          state: "active",
        },
      },
    );
    createThread(octant, ids.shared, "From Octant");
    octant.close();
    const nightly = openStore(paths.nightly);
    const nightlyHost = "33333333-3333-4333-8333-333333333333";
    append(nightly, "remote-host", nightlyHost, "remote.host-identity-initialized@1", {
      hostId: nightlyHost,
      displayName: "Nightly",
      hostKeyFingerprint: "c".repeat(64),
      keyGeneration: 1,
      createdAt: now,
    });
    nightly.close();

    imported(runImport(paths));

    const merged = openStore(paths.nightly);
    expect(readHostIdentity(merged.connection)).toMatchObject({
      host_id: nightlyHost,
      key_fingerprint: "c".repeat(64),
    });
    expect(readDeviceRegistrations(merged.connection)).toEqual([]);
    merged.close();
  });

  it("brings running work settled: wake-ups missed, routines paused and coordinator wakes held, without writing to Octant", () => {
    const paths = folders();
    const octant = openStore(paths.octant);
    const wakeupId = "0c7a0000-0000-4000-8000-000000000401";
    append(octant, "thread-wakeup", wakeupId, "thread-wakeup.changed@1", {
      wakeup: {
        id: wakeupId,
        mode: "work",
        threadId: ids.octantOnly,
        providerToolName: "ScheduleWakeup",
        prompt: "Check the build.",
        schedule: { kind: "delay" },
        humanSchedule: "in 10 minutes",
        createdAt: now,
        nextFireAt: "2026-11-27T12:10:00.000Z",
        status: "pending",
      },
      change: "scheduled",
    });
    const automation = automationDefinitionFixture();
    new AutomationEventStore({
      journal: octant.journal,
      uuid: randomUUID,
      actor: decodeEventActor(actor),
    }).appendDefinitionCreated({ automation });
    const coordinatorThread = "0c7a0000-0000-4000-8000-000000000402";
    const wakeId = "0c7a0000-0000-4000-8000-000000000403";
    createCoordinatorWakeJournal({
      journal: octant.journal,
      connection: octant.connection,
      clock: () => now,
    }).decided(coordinatorThread, {
      wakeId,
      cause: "message",
      senderThreadId: ids.octantOnly,
      hop: 0,
    });
    const octantEvents = octant.connection
      .prepare("SELECT count(*) AS value FROM event_journal")
      .get();
    octant.close();

    const outcome = imported(runImport(paths));

    expect(outcome.counts.settled).toBe(3);
    const reopened = openStore(paths.octant);
    expect(
      reopened.connection.prepare("SELECT count(*) AS value FROM event_journal").get(),
    ).toEqual(octantEvents);
    reopened.close();
    const merged = openStore(paths.nightly);
    const last = (aggregateType: string, aggregateId: string) =>
      JSON.parse(
        (
          merged.connection
            .prepare(
              `SELECT payload_json FROM event_journal WHERE aggregate_type = ? AND aggregate_id = ?
               ORDER BY aggregate_version DESC LIMIT 1`,
            )
            .get(aggregateType, aggregateId) as { readonly payload_json: string }
        ).payload_json,
      ) as Record<string, unknown>;
    expect(last("thread-wakeup", wakeupId)).toMatchObject({
      change: "missed",
      wakeup: { status: "missed" },
    });
    expect(last("automation-definition", String(automation.id))).toMatchObject({
      reason: "host-mismatch",
    });
    expect(last("coordinator-wake", coordinatorThread)).toEqual({ wakeId, outcome: "held" });
    merged.close();
  });

  it("an import that fails before the swap leaves Nightly's store byte for byte as it was", () => {
    const paths = folders();
    const octant = openStore(paths.octant);
    createThread(octant, ids.shared, "From Octant");
    // A record the registry reads but the Chat projection refuses: the
    // thread's own version disagrees with its journal position.
    octant.connection
      .prepare(
        `INSERT INTO event_journal (event_id, aggregate_type, aggregate_id, aggregate_version,
           event_name, event_version, host_id, correlation_id, actor_kind, actor_id, occurred_at,
           payload_json)
         VALUES (?, 'chat-thread', ?, 2, 'chat.thread-updated@1', 1, 'local', ?, 'system', ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        ids.shared,
        randomUUID(),
        actor.actorId,
        now,
        JSON.stringify({ kind: "thread-updated", thread: thread(ids.shared, "Broken", 7) }),
      );
    octant.close();
    const nightly = openStore(paths.nightly);
    createThread(nightly, ids.nightlyOwn, "Nightly's own");
    nightly.close();
    const before = storeHash(paths.nightly);

    expect(runImport(paths)).toEqual({ kind: "failed", stage: "rebuild" });
    expect(storeHash(paths.nightly)).toBe(before);
    expect(readdirSync(join(paths.nightly, "import"))).toEqual([]);
  });

  it("continues a wake-up the import settled from Octant's own later events", () => {
    const paths = folders();
    let octant = openStore(paths.octant);
    const wakeupId = "0c7a0000-0000-4000-8000-000000000411";
    append(
      octant,
      "thread-wakeup",
      wakeupId,
      "thread-wakeup.changed@1",
      wakeup(wakeupId, "pending", "scheduled"),
    );
    octant.close();
    imported(runImport(paths));
    octant = openStore(paths.octant);
    append(
      octant,
      "thread-wakeup",
      wakeupId,
      "thread-wakeup.changed@1",
      wakeup(wakeupId, "ended", "ended"),
    );
    octant.close();

    const second = imported(runImport(paths));

    expect(second.kept).toEqual([]);
    expect(
      eventsIn(paths.nightly, "thread-wakeup", wakeupId).map((event) => event.payload.change),
    ).toEqual(["scheduled", "ended"]);
  });

  it("merges Octant's later turns into a thread whose coordinator wake the import held", () => {
    const paths = folders();
    let octant = openStore(paths.octant);
    createThread(octant, ids.shared, "One");
    const wakeId = "0c7a0000-0000-4000-8000-000000000412";
    const wakes = (store: Store) =>
      createCoordinatorWakeJournal({
        journal: store.journal,
        connection: store.connection,
        clock: () => now,
      });
    wakes(octant).decided(ids.shared, {
      wakeId,
      cause: "message",
      senderThreadId: ids.shared,
      hop: 0,
    });
    octant.close();
    imported(runImport(paths));
    octant = openStore(paths.octant);
    // Octant's own host holds its wake after a restart, then the person goes on.
    wakes(octant).settled(ids.shared, { wakeId, outcome: "held" });
    renameThread(octant, ids.shared, "Two");
    octant.close();

    const second = imported(runImport(paths));

    expect(second.conflicts).toEqual([]);
    expect(titleIn(paths.nightly, ids.shared)).toBe("Two");
    expect(
      eventsIn(paths.nightly, "coordinator-wake", ids.shared).map((event) => event.name),
    ).toEqual(["coordinator.wake-decided@1", "coordinator.wake-settled@1"]);
  });

  it("takes Octant's edit of a routine the import blocked and blocks it again", () => {
    const paths = folders();
    let octant = openStore(paths.octant);
    const created = automationDefinitionFixture();
    const store = (journal: Journal) =>
      new AutomationEventStore({ journal, uuid: randomUUID, actor: decodeEventActor(actor) });
    store(octant.journal).appendDefinitionCreated({ automation: created });
    octant.close();
    imported(runImport(paths));
    octant = openStore(paths.octant);
    store(octant.journal).appendDefinitionUpdated({
      automation: automationDefinitionFixture({
        displayName: "Edited in Octant" as never,
        definitionRevision: 2 as never,
        version: 2 as never,
      }),
      previousDefinitionRevision: created.definitionRevision,
      expectedVersion: 1,
    });
    octant.close();

    const second = imported(runImport(paths));

    expect(second.kept).toEqual([]);
    expect(
      eventsIn(paths.nightly, "automation-definition", String(created.id)).map(
        (event) => event.name,
      ),
    ).toEqual([
      "automation-definition-created@1",
      "automation-definition-updated@1",
      "automation-blocked@1",
    ]);
  });

  it("keeps Nightly's purge records and takes Octant's retention window on the first import", () => {
    const paths = folders();
    const octant = openStore(paths.octant);
    append(
      octant,
      "thread-retention",
      THREAD_RETENTION_AGGREGATE_ID,
      "thread-retention.window-set@1",
      {
        kind: "window-set",
        scope: { kind: "host" },
        window: { kind: "forever" },
        updatedAt: now,
      },
    );
    octant.close();
    const nightly = openStore(paths.nightly);
    const purged = "0c7a0000-0000-4000-8000-000000000777";
    append(
      nightly,
      "thread-retention",
      THREAD_RETENTION_AGGREGATE_ID,
      "thread-retention.thread-purged@1",
      {
        kind: "thread-purged",
        mode: "chat",
        threadId: purged,
        purgedAt: now,
      },
    );
    nightly.close();

    imported(runImport(paths));

    const merged = openStore(paths.nightly);
    expect(merged.connection.prepare("SELECT thread_id FROM thread_purge_tombstone").all()).toEqual(
      [{ thread_id: purged }],
    );
    expect(
      merged.connection.prepare("SELECT scope_kind FROM thread_retention_projection").all(),
    ).toEqual([{ scope_kind: "host" }]);
    merged.close();
  });

  it("never brings Octant's public share links", () => {
    const paths = folders();
    const octant = openStore(paths.octant);
    // Unreadable on purpose: a share record that came over would refuse the
    // import, since every row that comes over is decoded first.
    const link = "0c7a0000-0000-4000-8000-000000000501";
    rawEvent(octant, "canvas-public-share", link, 1, "canvas.public-share-published@1", {});
    rawEvent(
      octant,
      "canvas-public-share-revocation",
      link,
      1,
      "canvas.public-share-revocation-pending@1",
      {},
    );
    octant.close();

    imported(runImport(paths));

    expect(eventsIn(paths.nightly, "canvas-public-share", link)).toEqual([]);
    expect(eventsIn(paths.nightly, "canvas-public-share-revocation", link)).toEqual([]);
  });

  it("holds back an aggregate that names its thread on only some events together with that thread", () => {
    const paths = folders();
    let octant = openStore(paths.octant);
    createThread(octant, ids.shared, "Shared");
    const record = "0c7a0000-0000-4000-8000-000000000601";
    rawEvent(octant, "fixture", record, 1, "fixture.recorded", {
      value: "first",
      threadId: ids.shared,
    });
    rawEvent(octant, "fixture", record, 2, "fixture.recorded", { value: "second" });
    octant.close();
    imported(runImport(paths));
    const nightly = openStore(paths.nightly);
    renameThread(nightly, ids.shared, "Renamed in Nightly");
    nightly.close();
    octant = openStore(paths.octant);
    renameThread(octant, ids.shared, "Renamed in Octant");
    rawEvent(octant, "fixture", record, 3, "fixture.recorded", { value: "third" });
    octant.close();

    const second = imported(runImport(paths));

    expect(second.conflicts).toEqual([{ mode: "chat", octantThreadId: ids.shared }]);
    expect(eventsIn(paths.nightly, "fixture", record)).toHaveLength(2);
  });

  it("lists an aggregate an earlier import held back instead of treating it as deleted in Nightly", () => {
    const paths = folders();
    let octant = openStore(paths.octant);
    const record = "0c7a0000-0000-4000-8000-000000000602";
    // A stream that does not start at version 1 cannot land where Octant's
    // versions expect it, so the first import holds it back.
    rawEvent(octant, "fixture", record, 2, "fixture.recorded", { value: "second" });
    octant.close();
    const first = imported(runImport(paths));
    expect(first.kept).toEqual([{ aggregateType: "fixture", aggregateId: record }]);
    octant = openStore(paths.octant);
    rawEvent(octant, "fixture", record, 3, "fixture.recorded", { value: "third" });
    octant.close();

    const second = imported(runImport(paths));

    expect(second.kept).toEqual([{ aggregateType: "fixture", aggregateId: record }]);
  });

  it("keeps Nightly's own observation of a checkout both hosts observed without listing it", () => {
    const paths = folders();
    let octant = openStore(paths.octant);
    const checkoutId = "0c7a0000-0000-4000-8000-000000000701";
    const observe = (store: Store, availability: "available" | "waiting") =>
      append(store, "code-checkout", checkoutId, "code.checkout-observed@1", {
        kind: "checkout-observed",
        checkout: {
          id: checkoutId,
          repositoryId: `repo_${"a".repeat(64)}`,
          kind: "plain-folder",
          availability,
          head: { kind: "none" },
          observedAt: now,
        },
      });
    observe(octant, "available");
    octant.close();
    imported(runImport(paths));
    // Each host reobserves the folder on its own start.
    const nightly = openStore(paths.nightly);
    observe(nightly, "waiting");
    nightly.close();
    octant = openStore(paths.octant);
    observe(octant, "waiting");
    octant.close();

    const second = imported(runImport(paths));

    expect(second.kept).toEqual([]);
    expect(eventsIn(paths.nightly, "code-checkout", checkoutId)).toHaveLength(2);
  });

  it("classifies every table of the store as rebuilt, copied, journal or left behind", () => {
    const paths = folders();
    const store = openStore(paths.nightly);
    const tables = (
      store.connection
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as ReadonlyArray<{ readonly name: string }>
    ).map((row) => row.name);
    // A projection table is one a registered projection clears on reset:
    // the merged store rebuilds it from the journal.
    const rebuilt = new Set<string>();
    const watch = (sql: string) => {
      for (const table of tables) {
        if (new RegExp(`DELETE FROM ${table}\\b`).test(sql)) rebuilt.add(table);
      }
    };
    const watching: SqliteConnection = {
      ...store.connection,
      exec: (sql) => {
        watch(sql);
        store.connection.exec(sql);
      },
      prepare: (sql) => {
        watch(sql);
        return store.connection.prepare(sql);
      },
    };
    for (const projection of createPhase1RuntimeRegistries().projections.all()) {
      projection.reset(watching);
    }
    store.close();

    const named = new Set<string>([
      ...COPIED_CONTENT_TABLES,
      ...COPIED_MARKER_TABLES,
      ...JOURNAL_TABLES,
      ...EXCLUDED_TABLES,
      ...TRIGGER_MAINTAINED_TABLES,
    ]);
    expect([...named].filter((table) => rebuilt.has(table))).toEqual([]);
    expect(tables.filter((table) => !rebuilt.has(table) && !named.has(table))).toEqual([]);
  });
});

function put(folder: string, path: string, content: string, mode = 0o600): void {
  const target = join(folder, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, { mode });
}

/** Every regular file below a folder, by relative path, with its content. */
function tree(folder: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name !== "octant.sqlite3-shm") {
        files[relative(folder, path)] = readFileSync(path, "utf8");
      }
    }
  };
  walk(folder);
  return files;
}

/** The files beside the store, which is all an import copies. */
function sideFiles(folder: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(tree(folder)).filter(
      ([path]) => path.includes("/") && !path.startsWith("import/"),
    ),
  );
}

const receipt = (threadId: string) => ({
  version: 1,
  receiptId: "0c7a0000-0000-4000-8000-0000000004a1",
  threadId,
  state: "ready",
});

describe("importing the files that belong to Octant's data", () => {
  it("brings the files of the threads that came over and leaves a held-back thread's behind", () => {
    const paths = folders();
    const octant = openStore(paths.octant);
    createThread(octant, ids.octantOnly, "Octant only");
    createThread(octant, ids.shared, "Octant's copy");
    octant.close();
    const nightly = openStore(paths.nightly);
    createThread(nightly, ids.shared, "Nightly's copy");
    nightly.close();
    for (const folder of [
      "chat/threads",
      "work-threads",
      "code-threads",
      "generated-images",
      "generated-video",
      "browser-captures",
    ]) {
      put(paths.octant, `${folder}/${ids.octantOnly}/a1/finalized.bin`, folder);
      put(paths.octant, `${folder}/${ids.shared}/a1/finalized.bin`, "held back");
    }
    put(paths.octant, `work-threads/${ids.octantOnly}/a1/staged.bin.tmp`, "half written");
    put(paths.octant, `project-icons/${ids.project}.png`, "icon");
    put(paths.octant, "backgrounds/b1.png", "background");
    put(paths.octant, "extensions/user-added-servers.json", "{}");
    put(paths.octant, "extensions/versions/e/p/1/content/run.js", "code", 0o700);
    put(paths.octant, "extensions/metadata/t.json", "{}", 0o400);
    const store = openStore(paths.octant);
    append(store, "project", ids.project, "project.created@1", { project: project("Notes") });
    store.close();

    const outcome = imported(runImport(paths));

    expect(outcome.conflicts).toEqual([{ mode: "chat", octantThreadId: ids.shared }]);
    const arrived = tree(paths.nightly);
    expect(arrived[`chat/threads/${ids.octantOnly}/a1/finalized.bin`]).toBe("chat/threads");
    expect(arrived[`work-threads/${ids.octantOnly}/a1/finalized.bin`]).toBe("work-threads");
    expect(arrived[`code-threads/${ids.octantOnly}/a1/finalized.bin`]).toBe("code-threads");
    expect(arrived[`generated-images/${ids.octantOnly}/a1/finalized.bin`]).toBe("generated-images");
    expect(arrived[`generated-video/${ids.octantOnly}/a1/finalized.bin`]).toBe("generated-video");
    expect(arrived[`browser-captures/${ids.octantOnly}/a1/finalized.bin`]).toBe("browser-captures");
    expect(arrived[`project-icons/${ids.project}.png`]).toBe("icon");
    expect(arrived["backgrounds/b1.png"]).toBe("background");
    expect(arrived["extensions/user-added-servers.json"]).toBe("{}");
    expect(arrived["extensions/versions/e/p/1/content/run.js"]).toBe("code");
    expect(Object.keys(arrived).filter((path) => path.includes(ids.shared))).toEqual([]);
    expect(Object.keys(arrived).filter((path) => path.endsWith(".tmp"))).toEqual([]);
    expect(outcome.counts.files).toBe(11);
    const mode = (path: string) => statSync(join(paths.nightly, path)).mode & 0o777;
    expect(mode(`work-threads/${ids.octantOnly}/a1/finalized.bin`)).toBe(0o600);
    expect(mode("extensions/versions/e/p/1/content/run.js")).toBe(0o700);
    expect(mode("extensions/metadata/t.json")).toBe(0o400);
    expect(readdirSync(join(paths.nightly, "import"))).toEqual([]);
  });

  it("never overwrites a file Nightly already holds and adds only the ones it lacks", () => {
    const paths = folders();
    const octant = openStore(paths.octant);
    createThread(octant, ids.octantOnly, "Octant only");
    octant.close();
    put(paths.octant, `work-threads/${ids.octantOnly}/a1/finalized.bin`, "octant's");
    put(paths.octant, `work-threads/${ids.octantOnly}/a2/finalized.bin`, "octant's other");
    put(paths.octant, "backgrounds/b1.png", "octant's background");
    put(paths.nightly, `work-threads/${ids.octantOnly}/a1/finalized.bin`, "nightly's");
    put(paths.nightly, "backgrounds/b1.png", "nightly's background");
    put(paths.nightly, "backgrounds/own.png", "nightly's own");

    imported(runImport(paths));

    const arrived = tree(paths.nightly);
    expect(arrived[`work-threads/${ids.octantOnly}/a1/finalized.bin`]).toBe("nightly's");
    expect(arrived[`work-threads/${ids.octantOnly}/a2/finalized.bin`]).toBe("octant's other");
    expect(arrived["backgrounds/b1.png"]).toBe("nightly's background");
    expect(arrived["backgrounds/own.png"]).toBe("nightly's own");
  });

  it("leaves everything that belongs to Octant's host behind", () => {
    const paths = folders();
    const octant = openStore(paths.octant);
    createThread(octant, ids.octantOnly, "Octant only");
    octant.close();
    const behind = [
      "remote/private-listener-host-key.pem",
      "hub/membership.json",
      "run/host.sock",
      "config/settings.json",
      "state/window.json",
      "octant-host.json",
      "octant-bridge-secret",
      "agent-messages/am-1.txt",
      "chat/scratch/s.txt",
      "chat/side-chat/sidecars.json",
      "canvas-share-images/i.png",
      "icon-sets/icon-set-1/x.png",
      "integrations/linear-connection.json",
      "agent-run-scratch/r/x",
      "providers/plan-usage.json",
      "extensions/runtime-receipts/r.json",
      "extensions/mcp-server-sign-ins.json",
      "extensions/staging/t/receipt.json",
      "computer-use/driver",
      "browser-extensions/e",
      "compile-cache/c.bin",
    ];
    for (const path of behind) put(paths.octant, path, "octant's");

    const outcome = imported(runImport(paths));

    expect(outcome.counts.files).toBe(0);
    expect(Object.keys(tree(paths.nightly)).filter((path) => behind.includes(path))).toEqual([]);
  });

  it("brings a worktree receipt of an imported thread marked as Octant's and keeps one Nightly already has", () => {
    const paths = folders();
    const octant = openStore(paths.octant);
    createThread(octant, ids.octantOnly, "Octant only");
    createThread(octant, ids.octantLater, "Octant later");
    octant.close();
    const claim = `.claim-${"a".repeat(64)}.json`;
    const own = "0c7a0000-0000-4000-8000-0000000004a1";
    const other = "0c7a0000-0000-4000-8000-0000000004a2";
    const unrelated = "0c7a0000-0000-4000-8000-0000000004a3";
    put(
      paths.octant,
      `managed-worktree-receipts/${own}.json`,
      JSON.stringify(receipt(ids.octantOnly)),
    );
    put(
      paths.octant,
      `managed-worktree-receipts/${claim}`,
      JSON.stringify(receipt(ids.octantOnly)),
    );
    put(
      paths.octant,
      `managed-worktree-receipts/${other}.json`,
      JSON.stringify(receipt(ids.octantLater)),
    );
    put(
      paths.octant,
      `managed-worktree-receipts/${unrelated}.json`,
      JSON.stringify(receipt(ids.nightlyOwn)),
    );
    put(paths.nightly, `managed-worktree-receipts/${other}.json`, "nightly's receipt");

    imported(runImport(paths));

    const read = (name: string) =>
      JSON.parse(readFileSync(join(paths.nightly, "managed-worktree-receipts", name), "utf8"));
    expect(read(`${own}.json`)).toEqual({ ...receipt(ids.octantOnly), importedFrom: "octant" });
    expect(read(claim)).toEqual({ ...receipt(ids.octantOnly), importedFrom: "octant" });
    expect(
      readFileSync(join(paths.nightly, "managed-worktree-receipts", `${other}.json`), "utf8"),
    ).toBe("nightly's receipt");
    expect(existsSync(join(paths.nightly, "managed-worktree-receipts", `${unrelated}.json`))).toBe(
      false,
    );
  });

  it("does not follow a link in Octant's folder", () => {
    const paths = folders();
    const octant = openStore(paths.octant);
    createThread(octant, ids.octantOnly, "Octant only");
    octant.close();
    const outside = join(dirname(paths.octant), "outside");
    put(outside, "secret.txt", "outside");
    put(outside, "b/background.png", "outside");
    put(paths.octant, `work-threads/${ids.octantOnly}/a1/finalized.bin`, "inside");
    symlinkSync(
      join(outside, "secret.txt"),
      join(paths.octant, `work-threads/${ids.octantOnly}/leak.txt`),
    );
    symlinkSync(join(outside, "b"), join(paths.octant, "backgrounds"));
    symlinkSync(outside, join(paths.octant, `code-threads`));

    imported(runImport(paths));

    expect(sideFiles(paths.nightly)).toEqual({
      [`work-threads/${ids.octantOnly}/a1/finalized.bin`]: "inside",
    });
    expect(lstatSync(join(paths.octant, "backgrounds")).isSymbolicLink()).toBe(true);
  });

  it("takes back every copied file when the import fails before the store is swapped", () => {
    const paths = folders();
    const octant = openStore(paths.octant);
    createThread(octant, ids.octantOnly, "Octant only");
    octant.close();
    put(paths.octant, `work-threads/${ids.octantOnly}/a1/finalized.bin`, "octant's");
    put(paths.octant, "backgrounds/b1.png", "octant's background");
    // A file where Octant's folder needs a folder stops the copy halfway.
    put(paths.nightly, "backgrounds", "not a folder");
    openStore(paths.nightly).close();
    const before = storeHash(paths.nightly);

    expect(runImport(paths)).toEqual({ kind: "failed", stage: "files" });

    expect(storeHash(paths.nightly)).toBe(before);
    expect(tree(paths.nightly)["backgrounds"]).toBe("not a folder");
    expect(
      Object.keys(tree(paths.nightly)).filter((path) => path.startsWith("work-threads")),
    ).toEqual([]);
    expect(existsSync(join(paths.nightly, "work-threads"))).toBe(false);
    expect(readdirSync(join(paths.nightly, "import"))).toEqual([]);
  });

  it("removes exactly what an earlier import that never committed copied", () => {
    const paths = folders();
    const octant = openStore(paths.octant);
    createThread(octant, ids.octantOnly, "Octant only");
    octant.close();
    const interrupted = "0c7a0000-0000-4000-8000-0000000004b1";
    put(paths.nightly, "generated-images/t/a/finalized.bin", "left by the interrupted import");
    put(paths.nightly, "generated-images/t/own/finalized.bin", "nightly's own");
    put(
      paths.nightly,
      `import/${interrupted}.json`,
      JSON.stringify({
        importId: interrupted,
        files: ["generated-images/t/a/finalized.bin", "../outside.txt"],
        directories: ["generated-images/t/a", "generated-images/t", "generated-images"],
      }),
    );

    imported(runImport(paths));

    const left = tree(paths.nightly);
    expect(left["generated-images/t/a/finalized.bin"]).toBeUndefined();
    expect(left["generated-images/t/own/finalized.bin"]).toBe("nightly's own");
    expect(existsSync(join(paths.nightly, "import", `${interrupted}.json`))).toBe(false);
  });

  it("brings the library images of the image jobs that came over", () => {
    const paths = folders();
    const library = "00000000-0000-4000-8000-00000000f1e1";
    const jobId = "0c7a0000-0000-4000-8000-000000000501";
    const image = "0c7a0000-0000-4000-8000-000000000502";
    const unrelated = "0c7a0000-0000-4000-8000-000000000503";
    const digest = "a".repeat(64);
    const artifact = {
      attachmentId: image,
      hash: digest,
      size: 4,
      mime: "image/png",
      evidence: {
        profileInstanceId: provider,
        modelId: "model-a",
        promptHash: digest,
        jobId,
      },
    };
    const octant = openStore(paths.octant);
    rawEvent(octant, "image-job", jobId, 1, "image.job-queued@1", {
      job: {
        id: jobId,
        status: "queued",
        threadKind: "image-library",
        scopeId: library,
        profileInstanceId: provider,
        modelId: "model-a",
        promptHash: digest,
        artifacts: [],
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
    });
    rawEvent(octant, "image-job", jobId, 2, "image.job-status-changed@1", {
      jobId,
      fromStatus: "queued",
      toStatus: "completed",
      version: 2,
      updatedAt: now,
      artifacts: [artifact],
    });
    octant.close();
    put(paths.octant, `generated-images/${library}/${image}/finalized.bin`, "library image");
    put(paths.octant, `generated-images/${library}/${unrelated}/finalized.bin`, "no job came over");

    imported(runImport(paths));

    expect(sideFiles(paths.nightly)).toEqual({
      [`generated-images/${library}/${image}/finalized.bin`]: "library image",
    });
  });

  it("leaves Octant's folder exactly as it was", () => {
    const paths = folders();
    const octant = openStore(paths.octant);
    createThread(octant, ids.octantOnly, "Octant only");
    octant.close();
    put(paths.octant, `work-threads/${ids.octantOnly}/a1/finalized.bin`, "octant's");
    put(
      paths.octant,
      `managed-worktree-receipts/0c7a0000-0000-4000-8000-0000000004a1.json`,
      JSON.stringify(receipt(ids.octantOnly)),
    );
    const before = tree(paths.octant);

    imported(runImport(paths));

    expect(tree(paths.octant)).toEqual(before);
  });
});
