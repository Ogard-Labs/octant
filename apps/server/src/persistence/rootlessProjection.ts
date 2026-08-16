import {
  decodeRootlessFolderAttached,
  decodeRootlessFolderAttachmentDenied,
  decodeRootlessThreadCreated,
  decodeRootlessThreadId,
  decodeRootlessThreadSummary,
  decodeRootlessTurnAccepted,
  decodeRootlessTurnRequestId,
  decodeRootlessTurnUpdated,
  type EventEnvelope,
  type RootlessThreadListResult,
  type RootlessThreadSummary,
  type RootlessThreadId,
  type RootlessTurnRequestId,
} from "@octant/contracts";
import type { Projection } from "./projection";
import {
  ROOTLESS_PROJECTION_SCHEMA_VERSION,
  assertRootlessProjectionSchema,
  type ProjectedRootlessThread,
  type RootlessThreadProjectionRow,
  type RootlessTurnRequestProjectionRow,
} from "./rootlessPersistenceSchema";
import type { SqliteConnection } from "./sqlitePort";

const ROOTLESS_THREAD_CREATED = "rootless.thread-created@1";
const ROOTLESS_TURN_ACCEPTED = "rootless.turn-accepted@1";
const ROOTLESS_TURN_UPDATED = "rootless.turn-updated@1";
const ROOTLESS_FOLDER_ATTACHED = "rootless.folder-attached@1";
const ROOTLESS_FOLDER_ATTACHMENT_DENIED = "rootless.folder-attachment-denied@1";

const rootlessEventNames = new Set([
  ROOTLESS_THREAD_CREATED,
  ROOTLESS_TURN_ACCEPTED,
  ROOTLESS_TURN_UPDATED,
  ROOTLESS_FOLDER_ATTACHED,
  ROOTLESS_FOLDER_ATTACHMENT_DENIED,
]);

/**
 * Projection for rootless Work and Code threads. Handles
 * rootless.thread-created, rootless.folder-attached, and
 * rootless.folder-attachment-denied events, tracking workspace variant and
 * attachment state so the thread list can expose Unfiled classification and
 * Recents/All grouping. Rebuildable from the authoritative event journal.
 */
export class RootlessProjection implements Projection {
  readonly name = "rootless";
  readonly dependencies: ReadonlyArray<string> = ["aggregate-heads"];

  reset(connection: SqliteConnection): void {
    connection.exec(`DELETE FROM rootless_turn_request_projection;`);
    connection.exec(`DELETE FROM rootless_thread_projection;`);
  }

  apply(connection: SqliteConnection, event: EventEnvelope): void {
    if (!rootlessEventNames.has(event.eventName)) return;
    if (event.eventVersion !== 1) return;

    switch (event.eventName) {
      case ROOTLESS_THREAD_CREATED:
        this.#applyThreadCreated(connection, event);
        return;
      case ROOTLESS_TURN_ACCEPTED:
        this.#applyTurnAccepted(connection, event);
        return;
      case ROOTLESS_TURN_UPDATED:
        this.#applyTurnUpdated(connection, event);
        return;
      case ROOTLESS_FOLDER_ATTACHED:
        this.#applyFolderAttached(connection, event);
        return;
      case ROOTLESS_FOLDER_ATTACHMENT_DENIED:
        this.#applyFolderAttachmentDenied(connection, event);
        return;
    }
  }

  #applyTurnAccepted(connection: SqliteConnection, event: EventEnvelope): void {
    const payload = decodeRootlessTurnAccepted(event.payload);
    const threadId = decodeRootlessThreadId(payload.threadId);
    const existing = readRootlessThreadRow(connection, threadId);
    if (existing === undefined) return;
    assertRootlessProjectionSchema(existing.schema_version);
    const previous = JSON.parse(existing.thread_json) as ProjectedRootlessThread;
    const updated: ProjectedRootlessThread = {
      ...previous,
      initialTurn: {
        requestId: payload.requestId,
        threadId,
        turnId: payload.turnId,
        providerSessionId: payload.providerSessionId,
        status: "accepted",
        prompt: payload.prompt,
        capabilities: payload.capabilities,
        acceptedAt: payload.acceptedAt,
        updatedAt: payload.acceptedAt,
      },
      initialTurnAcceptedEventId: event.eventId,
      aggregateVersion: event.aggregateVersion,
      updatedAt: payload.acceptedAt,
    };
    persistUpdatedThread(connection, existing, updated, event);
    connection
      .prepare(
        `INSERT INTO rootless_turn_request_projection (
           request_id, thread_id, accepted_event_id, last_sequence
         ) VALUES (?, ?, ?, ?)`,
      )
      .run(payload.requestId, threadId, event.eventId, event.globalSequence);
  }

  #applyTurnUpdated(connection: SqliteConnection, event: EventEnvelope): void {
    const payload = decodeRootlessTurnUpdated(event.payload);
    const threadId = decodeRootlessThreadId(payload.threadId);
    const existing = readRootlessThreadRow(connection, threadId);
    if (existing === undefined) return;
    assertRootlessProjectionSchema(existing.schema_version);
    const previous = JSON.parse(existing.thread_json) as ProjectedRootlessThread;
    if (
      previous.initialTurn === undefined ||
      previous.initialTurn.requestId !== payload.requestId ||
      previous.initialTurn.turnId !== payload.turnId
    ) {
      return;
    }
    const updated: ProjectedRootlessThread = {
      ...previous,
      initialTurn: {
        ...previous.initialTurn,
        status: payload.status,
        ...(payload.response === undefined ? {} : { response: payload.response }),
        ...(payload.failure === undefined ? {} : { failure: payload.failure }),
        updatedAt: payload.updatedAt,
      },
      aggregateVersion: event.aggregateVersion,
      updatedAt: payload.updatedAt,
    };
    persistUpdatedThread(connection, existing, updated, event);
  }

  #applyThreadCreated(connection: SqliteConnection, event: EventEnvelope): void {
    const payload = decodeRootlessThreadCreated(event.payload);
    const threadId = decodeRootlessThreadId(payload.threadId);
    const record: ProjectedRootlessThread = {
      threadId,
      title: payload.title,
      mode: payload.mode,
      hostId: payload.hostId,
      providerInstanceId: payload.providerInstanceId,
      modelId: payload.modelId,
      workspaceKind: "rootless",
      projectId: null,
      aggregateVersion: event.aggregateVersion,
      createdAt: payload.createdAt,
      updatedAt: payload.createdAt,
    };
    upsertRootlessThread(connection).run(
      threadId,
      record.mode,
      record.hostId,
      record.workspaceKind,
      null,
      ROOTLESS_PROJECTION_SCHEMA_VERSION,
      JSON.stringify(record),
      event.aggregateVersion,
      record.createdAt,
      record.updatedAt,
      event.globalSequence,
    );
  }

  #applyFolderAttached(connection: SqliteConnection, event: EventEnvelope): void {
    const payload = decodeRootlessFolderAttached(event.payload);
    const threadId = decodeRootlessThreadId(payload.threadId);
    const existing = readRootlessThreadRow(connection, threadId);
    if (existing === undefined) return;
    assertRootlessProjectionSchema(existing.schema_version);
    const previous = JSON.parse(existing.thread_json) as ProjectedRootlessThread;
    const updated: ProjectedRootlessThread = {
      ...previous,
      workspaceKind: "project-backed",
      projectId: payload.projectId,
      aggregateVersion: event.aggregateVersion,
      updatedAt: payload.attachedAt,
    };
    upsertRootlessThread(connection).run(
      threadId,
      updated.mode,
      updated.hostId,
      updated.workspaceKind,
      String(payload.projectId),
      ROOTLESS_PROJECTION_SCHEMA_VERSION,
      JSON.stringify(updated),
      event.aggregateVersion,
      existing.created_at,
      updated.updatedAt,
      event.globalSequence,
    );
  }

  #applyFolderAttachmentDenied(connection: SqliteConnection, event: EventEnvelope): void {
    const payload = decodeRootlessFolderAttachmentDenied(event.payload);
    const threadId = decodeRootlessThreadId(payload.threadId);
    const existing = readRootlessThreadRow(connection, threadId);
    if (existing === undefined) return;
    assertRootlessProjectionSchema(existing.schema_version);
    const previous = JSON.parse(existing.thread_json) as ProjectedRootlessThread;
    const updated: ProjectedRootlessThread = {
      ...previous,
      aggregateVersion: event.aggregateVersion,
      updatedAt: payload.deniedAt,
    };
    upsertRootlessThread(connection).run(
      threadId,
      updated.mode,
      updated.hostId,
      updated.workspaceKind,
      existing.project_id,
      ROOTLESS_PROJECTION_SCHEMA_VERSION,
      JSON.stringify(updated),
      event.aggregateVersion,
      existing.created_at,
      updated.updatedAt,
      event.globalSequence,
    );
  }
}

function upsertRootlessThread(connection: SqliteConnection) {
  return connection.prepare(`
    INSERT INTO rootless_thread_projection (
      thread_id, mode, host_id, workspace_kind, project_id,
      schema_version, thread_json, aggregate_version,
      created_at, updated_at, last_sequence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (thread_id) DO UPDATE SET
      mode = excluded.mode,
      host_id = excluded.host_id,
      workspace_kind = excluded.workspace_kind,
      project_id = excluded.project_id,
      schema_version = excluded.schema_version,
      thread_json = excluded.thread_json,
      aggregate_version = excluded.aggregate_version,
      updated_at = excluded.updated_at,
      last_sequence = excluded.last_sequence
  `);
}

function readRootlessThreadRow(
  connection: SqliteConnection,
  threadId: RootlessThreadId,
): RootlessThreadProjectionRow | undefined {
  return connection
    .prepare(`SELECT * FROM rootless_thread_projection WHERE thread_id = ?`)
    .get(threadId) as RootlessThreadProjectionRow | undefined;
}

export function readRootlessThread(
  connection: SqliteConnection,
  threadId: RootlessThreadId,
): ProjectedRootlessThread | undefined {
  const row = readRootlessThreadRow(connection, threadId);
  if (row === undefined) return undefined;
  assertRootlessProjectionSchema(row.schema_version);
  return JSON.parse(row.thread_json) as ProjectedRootlessThread;
}

export function readRootlessThreads(
  connection: SqliteConnection,
): ReadonlyArray<ProjectedRootlessThread> {
  const rows = connection
    .prepare(`SELECT * FROM rootless_thread_projection ORDER BY updated_at DESC, thread_id ASC`)
    .all() as ReadonlyArray<RootlessThreadProjectionRow>;
  return rows.map((row) => {
    assertRootlessProjectionSchema(row.schema_version);
    return JSON.parse(row.thread_json) as ProjectedRootlessThread;
  });
}

export function readRootlessTurnByRequest(
  connection: SqliteConnection,
  requestId: RootlessTurnRequestId,
): ProjectedRootlessThread | undefined {
  const decoded = decodeRootlessTurnRequestId(requestId);
  const request = connection
    .prepare(`SELECT * FROM rootless_turn_request_projection WHERE request_id = ?`)
    .get(decoded) as RootlessTurnRequestProjectionRow | undefined;
  if (request === undefined) return undefined;
  return readRootlessThread(connection, decodeRootlessThreadId(request.thread_id));
}

export function readUnfiledRootlessThreads(
  connection: SqliteConnection,
): ReadonlyArray<ProjectedRootlessThread> {
  const rows = connection
    .prepare(
      `SELECT * FROM rootless_thread_projection
       WHERE workspace_kind = 'rootless'
       ORDER BY updated_at DESC, thread_id ASC`,
    )
    .all() as ReadonlyArray<RootlessThreadProjectionRow>;
  return rows.map((row) => {
    assertRootlessProjectionSchema(row.schema_version);
    return JSON.parse(row.thread_json) as ProjectedRootlessThread;
  });
}

const RECENTS_LIMIT = 20;

/**
 * Builds the grouped rootless thread list result for the renderer. `recents`
 * is the most recently updated slice (capped at RECENTS_LIMIT). `all` contains
 * every tracked thread. `unfiled` contains only threads still in the rootless
 * workspace variant. All groups are ordered by updatedAt descending.
 */
export function readRootlessThreadList(connection: SqliteConnection): RootlessThreadListResult {
  const all = readRootlessThreads(connection);
  const summaries = all.map(toSummary);
  return {
    recents: summaries.slice(0, RECENTS_LIMIT).map(withoutInitialTurn),
    all: summaries,
    unfiled: summaries
      .filter((summary) => summary.workspaceKind === "rootless")
      .map(withoutInitialTurn),
  };
}

function withoutInitialTurn(summary: RootlessThreadSummary): RootlessThreadSummary {
  const navigationSummary = { ...summary };
  delete navigationSummary.initialTurn;
  return navigationSummary;
}

function toSummary(thread: ProjectedRootlessThread): RootlessThreadSummary {
  return decodeRootlessThreadSummary({
    threadId: thread.threadId,
    title: thread.title,
    mode: thread.mode,
    hostId: thread.hostId,
    providerInstanceId: thread.providerInstanceId,
    modelId: thread.modelId,
    workspaceKind: thread.workspaceKind,
    ...(thread.projectId !== null ? { projectId: thread.projectId } : {}),
    ...(thread.initialTurn === undefined ? {} : { initialTurn: thread.initialTurn }),
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  });
}

function persistUpdatedThread(
  connection: SqliteConnection,
  existing: RootlessThreadProjectionRow,
  updated: ProjectedRootlessThread,
  event: EventEnvelope,
): void {
  upsertRootlessThread(connection).run(
    updated.threadId,
    updated.mode,
    updated.hostId,
    updated.workspaceKind,
    updated.projectId,
    ROOTLESS_PROJECTION_SCHEMA_VERSION,
    JSON.stringify(updated),
    event.aggregateVersion,
    existing.created_at,
    updated.updatedAt,
    event.globalSequence,
  );
}
