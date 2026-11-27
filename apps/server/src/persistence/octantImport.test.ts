import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
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
import { reapsStaleProviderSession } from "@octant/domain";
import { readProviderInstances } from "../providers/providerProjection";
import {
  WorkTurnProjection,
  hydrateWorkTurnProjectionFromJournal,
} from "../work/workTurnProjection";
import {
  CHAT_SETTINGS_AGGREGATE_ID,
  readChatSettings,
  readChatThread,
  readChatThreads,
  readChatThreadView,
  writeChatContent,
} from "./chatProjection";
import { removeMirrorFiles } from "./threadArtifactPurge";
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
import { listPendingUsageResumes, readUsageResumeState } from "./usageResumeProjection";
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

const MIRROR_SETTINGS_ID = "0a1f0000-0000-4000-8000-000000000475";

function setMirror(store: Store, fallback: Record<string, unknown>, version: number): void {
  append(store, "artifact-mirror", MIRROR_SETTINGS_ID, "artifact.mirror-setting-changed@1", {
    settings: {
      kind: "artifact-mirror-settings",
      fallback,
      overrides: [],
      autoCommit: false,
      version,
      updatedAt: now,
    },
  });
}

function mirrorFallbackIn(folder: string): unknown {
  const events = eventsIn(folder, "artifact-mirror", MIRROR_SETTINGS_ID);
  const settings = events.at(-1)?.payload.settings as { readonly fallback?: unknown } | undefined;
  return settings?.fallback;
}

function codeThreadPayload(id: string) {
  return {
    kind: "thread-created",
    thread: {
      id,
      projectId: ids.project,
      bindingRevisionId: "0c7a0000-0000-4000-8000-000000000d01",
      repositoryId: `repo_${"a".repeat(64)}`,
      checkoutId: "0c7a0000-0000-4000-8000-000000000d02",
      title: "Code thread",
      lifecycle: "active",
      providerInstanceId: provider,
      modelId: "model-a",
      executionPolicy: "approval-gated",
      permissionPersistence: "current-session",
      deliveryTarget: {
        branchIntent: "feature",
        remoteName: "origin",
        proposedBaseRepository: "octant-dev/octant",
        proposedBaseBranch: "main",
        outcomeKind: "merged-pr",
        confirmedAt: now,
      },
      version: 1,
      createdAt: now,
      updatedAt: now,
    },
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

  it("merges a later import: Nightly-only work stays, Octant-only work comes over, and a thread both changed arrives as a copy", () => {
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

    const nightlyBefore = eventsIn(paths.nightly, "chat-thread", ids.shared);
    const second = imported(runImport(paths));

    expect(second.conflicts).toEqual([]);
    expect(second.copies).toHaveLength(1);
    const copy = second.copies[0];
    if (copy === undefined) throw new Error("the conflicting thread must arrive as a copy");
    expect(copy).toMatchObject({ mode: "chat", octantThreadId: ids.shared });
    expect(copy.copyThreadId).not.toBe(ids.shared);
    expect(eventsIn(paths.nightly, "chat-thread", ids.shared)).toEqual(nightlyBefore);
    expect(titleIn(paths.nightly, ids.shared)).toBe("Renamed in Nightly");
    expect(titleIn(paths.nightly, copy.copyThreadId)).toBe("Renamed in Octant (from Octant)");
    expect(titleIn(paths.nightly, ids.octantOnly)).toBe("Continued in Octant");
    expect(titleIn(paths.nightly, ids.octantLater)).toBe("Started in Octant");
    expect(titleIn(paths.nightly, ids.nightlyLater)).toBe("Started in Nightly");

    // Octant goes on with the conflicting thread: its new events land on the
    // copy, which is not copied again, and Nightly's thread stays as it was.
    octant = openStore(paths.octant);
    renameThread(octant, ids.shared, "Renamed in Octant again");
    octant.close();
    const third = imported(runImport(paths));
    expect(third.conflicts).toEqual([]);
    expect(third.copies).toEqual([]);
    expect(titleIn(paths.nightly, ids.shared)).toBe("Renamed in Nightly");
    expect(titleIn(paths.nightly, copy.copyThreadId)).toBe("Renamed in Octant again (from Octant)");
    expect(eventsIn(paths.nightly, "chat-thread", copy.copyThreadId)).toHaveLength(3);
    expect(eventsIn(paths.nightly, "chat-thread", ids.shared)).toEqual(nightlyBefore);

    // Nightly continues the copy and Octant its thread: the copy is Nightly's
    // thread now, and Octant's arrives as a new copy beside both.
    const again = openStore(paths.nightly);
    renameThread(again, copy.copyThreadId, "Copy renamed in Nightly");
    again.close();
    octant = openStore(paths.octant);
    renameThread(octant, ids.shared, "Renamed in Octant a third time");
    octant.close();
    const fourth = imported(runImport(paths));
    const newer = fourth.copies[0];
    if (newer === undefined) throw new Error("a diverged copy must make a new copy");
    expect(newer.copyThreadId).not.toBe(copy.copyThreadId);
    expect(titleIn(paths.nightly, copy.copyThreadId)).toBe("Copy renamed in Nightly");
    expect(titleIn(paths.nightly, newer.copyThreadId)).toBe(
      "Renamed in Octant a third time (from Octant)",
    );
  });

  it("brings a conflicting thread's content and files with its copy under the copy's own ids", () => {
    const paths = folders();
    let octant = openStore(paths.octant);
    createThread(octant, ids.shared, "Shared");
    octant.close();
    imported(runImport(paths));
    const nightly = openStore(paths.nightly);
    renameThread(nightly, ids.shared, "Renamed in Nightly");
    nightly.close();
    octant = openStore(paths.octant);
    renameThread(octant, ids.shared, "Renamed in Octant");
    const contentId = "0c7a0000-0000-4000-8000-000000000801";
    const body = "What Octant's thread said.";
    octant.connection
      .prepare(
        `INSERT INTO chat_content_store (content_id, thread_id, content_role, body_text, digest, byte_length)
         VALUES (?, ?, 'user', ?, ?, ?)`,
      )
      .run(
        contentId,
        ids.shared,
        body,
        createHash("sha256").update(body).digest("hex"),
        Buffer.byteLength(body),
      );
    octant.close();
    put(paths.octant, `chat/threads/${ids.shared}/a1/finalized.bin`, "octant's attachment");

    const outcome = imported(runImport(paths));

    const copy = outcome.copies[0];
    if (copy === undefined) throw new Error("the conflicting thread must arrive as a copy");
    const store = openStore(paths.nightly);
    try {
      const rows = store.connection
        .prepare("SELECT content_id, thread_id, body_text FROM chat_content_store")
        .all() as ReadonlyArray<{
        readonly content_id: string;
        readonly thread_id: string;
        readonly body_text: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.thread_id).toBe(copy.copyThreadId);
      expect(rows[0]?.body_text).toBe(body);
      expect(rows[0]?.content_id).not.toBe(contentId);
    } finally {
      store.close();
    }
    const arrived = tree(paths.nightly);
    expect(arrived[`chat/threads/${copy.copyThreadId}/a1/finalized.bin`]).toBe(
      "octant's attachment",
    );
    expect(Object.keys(arrived).filter((path) => path.includes(ids.shared))).toEqual([]);
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
    // A record the registry reads but the provider projection refuses: the
    // removal names a version other than its journal position.
    const instanceId = "0c7a0000-0000-4000-8000-000000000c01";
    rawEvent(octant, "provider-instance", instanceId, 1, "provider.instance-removed@1", {
      instanceId,
      version: 7,
    });
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

    // Nightly's record stays whole; the record comes over whole with the copy.
    expect(second.conflicts).toEqual([]);
    expect(eventsIn(paths.nightly, "fixture", record)).toHaveLength(2);
    const store = openStore(paths.nightly);
    try {
      const copied = store.connection
        .prepare(
          "SELECT count(*) AS events FROM event_journal WHERE aggregate_type = 'fixture' AND aggregate_id <> ?",
        )
        .get(record) as { readonly events: number };
      expect(copied.events).toBe(3);
    } finally {
      store.close();
    }
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

  it("never brings Octant's mirror receipts, so purging an imported Canvas in Nightly leaves Octant's mirrored file", async () => {
    const paths = folders();
    const mirror = realpathSync(mkdtempSync(join(tmpdir(), "octant-import-mirror-")));
    directories.push(mirror);
    writeFileSync(join(mirror, "note.md"), "Octant's mirrored note");
    const octant = openStore(paths.octant);
    const canvasId = "0c7a0000-0000-4000-8000-000000000801";
    append(octant, "artifact-mirror", canvasId, "artifact.mirror-written@1", {
      receipt: {
        canvasId,
        versionId: "0c7a0000-0000-4000-8000-000000000802",
        projectId: null,
        destination: { kind: "global-folder", canonicalRoot: mirror },
        paths: ["note.md"],
        outcome: "written",
        commit: { status: "not-requested" },
        observedAt: now,
      },
    });
    octant.close();

    imported(runImport(paths));
    const merged = openStore(paths.nightly);
    await removeMirrorFiles(merged.connection, [canvasId]);
    merged.close();

    expect(existsSync(join(mirror, "note.md"))).toBe(true);
  });

  it("holds back Octant's removal of a provider Nightly left unchanged and lists it as kept", () => {
    const paths = folders();
    const instanceId = "0c7a0000-0000-4000-8000-000000000901";
    let octant = openStore(paths.octant);
    append(octant, "provider-instance", instanceId, "provider.instance-created@1", {
      instance: {
        id: instanceId,
        displayName: "OpenCode local",
        driverKind: "opencode",
        configuration: { kind: "opencode-cli", binaryPath: "/opt/homebrew/bin/opencode" },
        enabled: true,
        environmentPolicy: "inherit-host",
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
    });
    octant.close();
    imported(runImport(paths));
    octant = openStore(paths.octant);
    append(octant, "provider-instance", instanceId, "provider.instance-removed@1", {
      instanceId,
      version: 2,
    });
    octant.close();

    const second = imported(runImport(paths));

    expect(second.kept).toEqual([{ aggregateType: "provider-instance", aggregateId: instanceId }]);
    const merged = openStore(paths.nightly);
    expect(readProviderInstances(merged.connection).map((instance) => String(instance.id))).toEqual(
      [instanceId],
    );
    merged.close();
  });

  it("brings Chat and Work turns that were running in Octant settled, so Nightly's start has nothing to continue", () => {
    const paths = folders();
    const octant = openStore(paths.octant);
    createThread(octant, ids.shared, "Answering");
    const body = "Summarize the release.";
    const contentId = "0c7a0000-0000-4000-8000-000000000a01";
    const digest = createHash("sha256").update(body).digest("hex");
    const turnId = "0c7a0000-0000-4000-8000-000000000a02";
    octant.journal.append(
      {
        aggregate: { aggregateType: "chat-thread", aggregateId: ids.shared },
        expectedVersion: 1,
        events: [
          {
            eventId: randomUUID(),
            eventName: "chat.turn-created@1",
            eventVersion: 1,
            correlationId: randomUUID(),
            actor,
            occurredAt: now,
            payload: {
              kind: "turn-created",
              turn: {
                id: turnId,
                threadId: ids.shared,
                sequence: 1,
                userMessageRef: { contentId, digest, byteLength: body.length },
                attachmentIds: [],
                attempts: [
                  {
                    id: "0c7a0000-0000-4000-8000-000000000a03",
                    turnId,
                    threadId: ids.shared,
                    providerInstanceId: provider,
                    providerSessionId: "0c7a0000-0000-4000-8000-000000000a04",
                    modelId: "model-a",
                    contextManifestId: "0c7a0000-0000-4000-8000-000000000a05",
                    outcome: "streaming",
                    responseRefs: [],
                    citationIds: [],
                    createdAt: now,
                    updatedAt: now,
                  },
                ],
                createdAt: now,
              },
            },
          },
        ],
      },
      {
        beforeEvents(inner) {
          writeChatContent(inner, {
            contentId,
            threadId: ids.shared,
            role: "user",
            body,
            digest,
            byteLength: body.length,
          });
        },
      },
    );
    const requestId = "0c7a0000-0000-4000-8000-000000000a11";
    append(octant, "work-turn", requestId, "work.turn-accepted@1", {
      kind: "turn-accepted",
      requestId,
      threadId: "0c7a0000-0000-4000-8000-000000000a12",
      turnId: "0c7a0000-0000-4000-8000-000000000a13",
      projectId: ids.project,
      authority: {
        hostId: "0c7a0000-0000-4000-8000-000000000a14",
        projectId: ids.project,
        bindingRevisionId: "0c7a0000-0000-4000-8000-000000000a15",
        workingDirectory: ".",
        confinementPosture: "project-root-confined",
        providerInstanceId: provider,
        modelId: "model-a",
      },
      providerSessionId: "0c7a0000-0000-4000-8000-000000000a16",
      prompt: "Continue the report.",
      capabilities: {
        workspace: "project-backed",
        confinement: "project-root-confined",
        shell: "denied",
        git: "denied",
        worktree: "denied",
        pullRequest: "denied",
        code: "denied",
      },
      acceptedAt: now,
    });
    octant.close();

    imported(runImport(paths));

    // The same selections Nightly's start makes before continuing anything.
    const merged = openStore(paths.nightly);
    const reapable = readChatThreads(merged.connection).flatMap((thread) =>
      (readChatThreadView(merged.connection, thread.id)?.turns ?? []).flatMap((turn) =>
        turn.attempts.filter(
          (attempt) =>
            reapsStaleProviderSession({
              attempt,
              ownedByThisProcess: false,
              now: Date.parse(now),
              staleAfterMs: 0,
            }).kind === "reap",
        ),
      ),
    );
    expect(reapable).toEqual([]);
    const workTurns = new WorkTurnProjection();
    hydrateWorkTurnProjectionFromJournal({
      replay: (cursor) =>
        merged.journal.replayAggregateType({
          aggregateType: cursor.aggregateType ?? "work-turn",
          afterSequence: cursor.afterSequence,
          limit: cursor.limit,
        }),
      projection: workTurns,
    });
    expect(workTurns.markInterruptedOnRestart(now)).toEqual([]);
    merged.close();
  });

  it("records in each import the Code threads that import brought, and no Chat thread", () => {
    const paths = folders();
    const codeThread = (id: string) => ({
      kind: "thread-created",
      thread: {
        id,
        projectId: ids.project,
        bindingRevisionId: "0c7a0000-0000-4000-8000-000000000d01",
        repositoryId: `repo_${"a".repeat(64)}`,
        checkoutId: "0c7a0000-0000-4000-8000-000000000d02",
        title: "Code thread",
        lifecycle: "active",
        providerInstanceId: provider,
        modelId: "model-a",
        executionPolicy: "approval-gated",
        permissionPersistence: "current-session",
        deliveryTarget: {
          branchIntent: "feature",
          remoteName: "origin",
          proposedBaseRepository: "octant-dev/octant",
          proposedBaseBranch: "main",
          outcomeKind: "merged-pr",
          confirmedAt: now,
        },
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
    });
    const firstCode = "0c7a0000-0000-4000-8000-000000000d11";
    const laterCode = "0c7a0000-0000-4000-8000-000000000d12";
    let octant = openStore(paths.octant);
    append(octant, "code-thread", firstCode, "code.thread-created@1", codeThread(firstCode));
    createThread(octant, ids.shared, "A Chat thread");
    octant.close();
    imported(runImport(paths));
    octant = openStore(paths.octant);
    append(octant, "code-thread", laterCode, "code.thread-created@1", codeThread(laterCode));
    octant.close();
    imported(runImport(paths));

    const records = eventsIn(
      paths.nightly,
      "octant-import",
      "0c7a0000-0000-4000-8000-000000000001",
    );
    expect(records.map((record) => record.payload.codeThreadIds)).toEqual([
      [firstCode],
      [laterCode],
    ]);
  });

  it("brings the repository mirror setting Octant switched to from a folder before the first import", () => {
    const paths = folders();
    const octant = openStore(paths.octant);
    setMirror(
      octant,
      { kind: "global-folder", canonicalRoot: "/Users/someone/Octant/Artifacts" },
      1,
    );
    setMirror(octant, { kind: "project-repository", relativeDirectory: "docs/artifacts" }, 2);
    octant.close();

    const outcome = imported(runImport(paths));

    expect(outcome.kept).toEqual([]);
    expect(mirrorFallbackIn(paths.nightly)).toEqual({
      kind: "project-repository",
      relativeDirectory: "docs/artifacts",
    });
  });

  it("brings a held folder mirror setting once Octant switches to its repository", () => {
    const paths = folders();
    let octant = openStore(paths.octant);
    setMirror(
      octant,
      { kind: "global-folder", canonicalRoot: "/Users/someone/Octant/Artifacts" },
      1,
    );
    octant.close();
    expect(imported(runImport(paths)).kept).toEqual([
      { aggregateType: "artifact-mirror", aggregateId: MIRROR_SETTINGS_ID },
    ]);
    octant = openStore(paths.octant);
    setMirror(octant, { kind: "project-repository", relativeDirectory: "docs/artifacts" }, 2);
    octant.close();

    const second = imported(runImport(paths));

    expect(second.kept).toEqual([]);
    expect(mirrorFallbackIn(paths.nightly)).toEqual({
      kind: "project-repository",
      relativeDirectory: "docs/artifacts",
    });
  });

  it("brings a Chat thread waiting on a usage limit with its scheduled resume settled, so Nightly schedules nothing", () => {
    const paths = folders();
    const octant = openStore(paths.octant);
    createThread(octant, ids.shared, "Waiting on a limit");
    const resetsAt = "2026-11-27T18:00:00.000Z";
    const record = {
      threadId: ids.shared,
      turnId: "0c7a0000-0000-4000-8000-000000000e01",
      attemptId: "0c7a0000-0000-4000-8000-000000000e02",
      providerInstanceId: provider,
      usageLimit: { kind: "exhausted", resetsAt },
      resetsAt,
      scheduledAt: now,
    };
    const event = (eventName: string, payload: unknown) => ({
      eventId: randomUUID(),
      eventName,
      eventVersion: 1,
      correlationId: randomUUID(),
      actor,
      occurredAt: now,
      payload,
    });
    octant.journal.append({
      aggregate: { aggregateType: "chat-thread", aggregateId: ids.shared },
      expectedVersion: 1,
      events: [
        event("usage-resume.scheduled@1", { resume: record }),
        event("chat.thread-updated@1", {
          kind: "thread-updated",
          thread: {
            ...thread(ids.shared, "Waiting on a limit", 3),
            usageResume: { record, status: "scheduled" },
          },
        }),
      ],
    });
    expect(listPendingUsageResumes(octant.connection)).toHaveLength(1);
    octant.close();

    imported(runImport(paths));

    const merged = openStore(paths.nightly);
    expect(listPendingUsageResumes(merged.connection)).toEqual([]);
    expect(readChatThread(merged.connection, ids.shared as ChatThread["id"])).toMatchObject({
      version: 5,
      usageResume: { status: "invalidated" },
    });
    merged.close();
  });

  it("brings Octant's repository mirror setting after it was held for a folder over an imported one", () => {
    const paths = folders();
    let octant = openStore(paths.octant);
    setMirror(octant, { kind: "project-repository", relativeDirectory: "docs/old" }, 1);
    octant.close();
    imported(runImport(paths));
    octant = openStore(paths.octant);
    setMirror(
      octant,
      { kind: "global-folder", canonicalRoot: "/Users/someone/Octant/Artifacts" },
      2,
    );
    octant.close();
    expect(imported(runImport(paths)).kept).toEqual([
      { aggregateType: "artifact-mirror", aggregateId: MIRROR_SETTINGS_ID },
    ]);
    octant = openStore(paths.octant);
    setMirror(octant, { kind: "project-repository", relativeDirectory: "docs/new" }, 3);
    octant.close();

    const third = imported(runImport(paths));

    expect(third.kept).toEqual([]);
    expect(mirrorFallbackIn(paths.nightly)).toEqual({
      kind: "project-repository",
      relativeDirectory: "docs/new",
    });
  });

  it("keeps Nightly's own mirror setting when Octant's comes back from a folder", () => {
    const paths = folders();
    let octant = openStore(paths.octant);
    setMirror(octant, { kind: "project-repository", relativeDirectory: "docs/old" }, 1);
    octant.close();
    imported(runImport(paths));
    octant = openStore(paths.octant);
    setMirror(
      octant,
      { kind: "global-folder", canonicalRoot: "/Users/someone/Octant/Artifacts" },
      2,
    );
    octant.close();
    imported(runImport(paths));
    const nightly = openStore(paths.nightly);
    setMirror(nightly, { kind: "project-repository", relativeDirectory: "docs/mine" }, 2);
    nightly.close();
    octant = openStore(paths.octant);
    setMirror(octant, { kind: "project-repository", relativeDirectory: "docs/new" }, 3);
    octant.close();

    const third = imported(runImport(paths));

    expect(third.kept).toEqual([
      { aggregateType: "artifact-mirror", aggregateId: MIRROR_SETTINGS_ID },
    ]);
    expect(mirrorFallbackIn(paths.nightly)).toEqual({
      kind: "project-repository",
      relativeDirectory: "docs/mine",
    });
  });

  it("brings Work and Code threads waiting on a usage limit with their resumes settled, and takes Octant's next update for each later", () => {
    const paths = folders();
    const workThread = "0c7a0000-0000-4000-8000-000000000f01";
    const codeThread = "0c7a0000-0000-4000-8000-000000000f02";
    const workRow = (title: string, version: number) => ({
      id: workThread,
      projectId: ids.project,
      title,
      lifecycle: "active",
      providerInstanceId: provider,
      modelId: "model-a",
      version,
      createdAt: now,
      updatedAt: now,
    });
    const codeRow = (title: string, version: number) => ({
      ...(codeThreadPayload(codeThread).thread as Record<string, unknown>),
      title,
      version,
    });
    const resetsAt = "2026-11-27T18:00:00.000Z";
    const record = (threadId: string) => ({
      threadId,
      turnId: "0c7a0000-0000-4000-8000-000000000f11",
      providerInstanceId: provider,
      usageLimit: { kind: "exhausted", resetsAt },
      resetsAt,
      scheduledAt: now,
    });
    const event = (eventName: string, payload: unknown) => ({
      eventId: randomUUID(),
      eventName,
      eventVersion: 1,
      correlationId: randomUUID(),
      actor,
      occurredAt: now,
      payload,
    });
    const rename = (store: Store, mode: "work" | "code", title: string) => {
      const aggregateId = mode === "work" ? workThread : codeThread;
      const head = store.connection
        .prepare(
          "SELECT max(aggregate_version) AS head FROM event_journal WHERE aggregate_type = ? AND aggregate_id = ?",
        )
        .get(`${mode}-thread`, aggregateId) as { readonly head: number };
      const row = mode === "work" ? workRow(title, head.head + 1) : codeRow(title, head.head + 1);
      store.journal.append({
        aggregate: { aggregateType: `${mode}-thread`, aggregateId },
        expectedVersion: head.head,
        events: [event(`${mode}.thread-updated@1`, { kind: "thread-updated", thread: row })],
      });
    };
    let octant = openStore(paths.octant);
    append(octant, "work-thread", workThread, "work.thread-created@1", {
      kind: "thread-created",
      thread: workRow("Work waiting", 1),
    });
    append(
      octant,
      "code-thread",
      codeThread,
      "code.thread-created@1",
      codeThreadPayload(codeThread),
    );
    for (const mode of ["work", "code"] as const) {
      const aggregateId = mode === "work" ? workThread : codeThread;
      const row = mode === "work" ? workRow("Work waiting", 3) : codeRow("Code thread", 3);
      octant.journal.append({
        aggregate: { aggregateType: `${mode}-thread`, aggregateId },
        expectedVersion: 1,
        events: [
          event("usage-resume.scheduled@1", { resume: record(aggregateId) }),
          event(`${mode}.thread-updated@1`, {
            kind: "thread-updated",
            thread: { ...row, usageResume: { record: record(aggregateId), status: "scheduled" } },
          }),
        ],
      });
    }
    expect(listPendingUsageResumes(octant.connection)).toHaveLength(2);
    octant.close();

    imported(runImport(paths));

    let merged = openStore(paths.nightly);
    expect(listPendingUsageResumes(merged.connection)).toEqual([]);
    expect(readUsageResumeState(merged.connection, "work-thread", workThread)?.status).toBe(
      "invalidated",
    );
    expect(readUsageResumeState(merged.connection, "code-thread", codeThread)?.status).toBe(
      "invalidated",
    );
    merged.close();
    octant = openStore(paths.octant);
    rename(octant, "work", "Work renamed in Octant");
    rename(octant, "code", "Code renamed in Octant");
    octant.close();

    const second = imported(runImport(paths));

    expect(second.conflicts).toEqual([]);
    expect(second.kept).toEqual([]);
    const titles = (aggregateType: string, aggregateId: string) =>
      eventsIn(paths.nightly, aggregateType, aggregateId)
        .map((entry) => (entry.payload.thread as { readonly title?: string } | undefined)?.title)
        .filter((title) => title !== undefined);
    expect(titles("work-thread", workThread)).toContain("Work renamed in Octant");
    expect(titles("code-thread", codeThread)).toContain("Code renamed in Octant");
    merged = openStore(paths.nightly);
    expect(listPendingUsageResumes(merged.connection)).toEqual([]);
    merged.close();
  });

  it("leaves behind a mirror setting that writes to a folder of Octant's, and lists it", () => {
    const paths = folders();
    const settingsId = "0a1f0000-0000-4000-8000-000000000475";
    const octant = openStore(paths.octant);
    append(octant, "artifact-mirror", settingsId, "artifact.mirror-setting-changed@1", {
      settings: {
        kind: "artifact-mirror-settings",
        fallback: { kind: "global-folder", canonicalRoot: "/Users/someone/Octant/Artifacts" },
        overrides: [],
        autoCommit: false,
        version: 1,
        updatedAt: now,
      },
    });
    octant.close();

    const outcome = imported(runImport(paths));

    expect(outcome.kept).toEqual([{ aggregateType: "artifact-mirror", aggregateId: settingsId }]);
    expect(eventsIn(paths.nightly, "artifact-mirror", settingsId)).toEqual([]);
  });

  it("brings a mirror setting that writes inside the Project's repository", () => {
    const paths = folders();
    const settingsId = "0a1f0000-0000-4000-8000-000000000475";
    const octant = openStore(paths.octant);
    append(octant, "artifact-mirror", settingsId, "artifact.mirror-setting-changed@1", {
      settings: {
        kind: "artifact-mirror-settings",
        fallback: { kind: "project-repository", relativeDirectory: "docs/artifacts" },
        overrides: [],
        autoCommit: false,
        version: 1,
        updatedAt: now,
      },
    });
    octant.close();

    const outcome = imported(runImport(paths));

    expect(outcome.kept).toEqual([]);
    expect(eventsIn(paths.nightly, "artifact-mirror", settingsId)).toHaveLength(1);
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
  it("brings the files of the threads that came over and a conflicting thread's only with its copy", () => {
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

    expect(outcome.conflicts).toEqual([]);
    const copy = outcome.copies[0];
    if (copy === undefined) throw new Error("the conflicting thread must arrive as a copy");
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
    expect(arrived[`work-threads/${copy.copyThreadId}/a1/finalized.bin`]).toBe("held back");
    expect(outcome.counts.files).toBe(17);
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
