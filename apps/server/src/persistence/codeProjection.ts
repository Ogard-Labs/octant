import {
  AggregateId as AggregateIdSchema,
  CODE_EVENT_NAMES,
  decodeCodeCheckoutIdentity,
  decodeCodeFileReference,
  decodeCodeRuntimeWork,
  decodeCodeSettings,
  decodeCodeSettingsUpdated,
  decodeCodeThreadView,
  decodePersistedCodeThread,
  decodePersistedCodeThreadCreated,
  decodePersistedCodeThreadUpdated,
  decodeCodeCheckoutObserved,
  decodeCodeCheckoutRemoved,
  decodeCodeFileReferenceUpdated,
  decodeCodeRuntimeWorkUpdated,
  decodeCodeReviewFinding,
  decodeCodeReviewFindingUpdated,
  decodeCodeThreadFollowUp,
  decodeCodeThreadFollowUpUpdated,
  decodeCodeOperationEventFrame,
  decodeCodeThreadActivity,
  type CodeThreadActivity,
  type CodeThreadFollowUp,
  type CodeCheckoutId,
  type CodeCheckoutIdentity,
  type CodeFileId,
  type CodeFileReference,
  type CodeRuntimeWork,
  type CodeRuntimeWorkId,
  type CodeReviewFindingId,
  type CodeReviewFinding,
  type CodeThread,
  type CodeThreadId,
  type CodeThreadView,
  type EventEnvelope,
} from "@octant/contracts";
import { Schema } from "effect";
import type { Projection } from "./projection";
import type { Journal } from "./journal";
import {
  assertCodeProjectionSchema,
  CODE_PROJECTION_SCHEMA_VERSION,
  CODE_SETTINGS_KEY,
  type CodeCheckoutProjectionRow,
  type CodeFileProjectionRow,
  type CodeRuntimeProjectionRow,
  type CodeReviewProjectionRow,
  type CodeSettingsProjectionRow,
  type CodeThreadActivityProjectionRow,
  type CodeThreadProjectionRow,
  type ProjectedCodeSettings,
} from "./codePersistenceSchema";
import type { SqliteConnection } from "./sqlitePort";

const decodeAggregateId = Schema.decodeUnknownSync(AggregateIdSchema);
export const CODE_SETTINGS_AGGREGATE_ID = decodeAggregateId("00000000-0000-4000-8000-000000000020");

const codeEventNames = new Set<string>([
  ...CODE_EVENT_NAMES,
  "code.review-finding-updated@1",
  "code.follow-up-updated@1",
  "code.operation-event-recorded@1",
]);

export const CODE_FOLLOW_UP_AGGREGATE_TYPE = "code-thread-follow-up";
export const CODE_OPERATION_AGGREGATE_TYPE = "code-operation";

export class CodeProjection implements Projection {
  readonly name = "code";
  readonly dependencies: ReadonlyArray<string> = ["aggregate-heads"];

  reset(connection: SqliteConnection): void {
    connection.exec(`
      DELETE FROM code_thread_activity_projection;
      DELETE FROM code_thread_follow_up_projection;
      DELETE FROM code_review_projection;
      DELETE FROM code_runtime_projection;
      DELETE FROM code_file_projection;
      DELETE FROM code_checkout_projection;
      DELETE FROM code_thread_projection;
      DELETE FROM code_settings_projection;
    `);
  }

  apply(connection: SqliteConnection, event: EventEnvelope): void {
    if (!codeEventNames.has(event.eventName)) return;
    assertEnvelope(event.eventVersion === 1);

    switch (event.eventName) {
      case "code.settings-updated@1": {
        assertEnvelope(
          event.aggregateType === "code-settings" &&
            String(event.aggregateId) === String(CODE_SETTINGS_AGGREGATE_ID),
        );
        const settings = decodeProjection(() => decodeCodeSettingsUpdated(event.payload).settings);
        assertEnvelope(settings.version === event.aggregateVersion);
        connection
          .prepare(`
            INSERT INTO code_settings_projection (
              projection_key, schema_version, settings_json, aggregate_version, last_sequence
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (projection_key) DO UPDATE SET
              schema_version = excluded.schema_version,
              settings_json = excluded.settings_json,
              aggregate_version = excluded.aggregate_version,
              last_sequence = excluded.last_sequence
            WHERE excluded.aggregate_version > code_settings_projection.aggregate_version
          `)
          .run(
            CODE_SETTINGS_KEY,
            CODE_PROJECTION_SCHEMA_VERSION,
            JSON.stringify(settings),
            event.aggregateVersion,
            event.globalSequence,
          );
        return;
      }
      case "code.thread-created@1":
      case "code.thread-updated@1": {
        assertEnvelope(event.aggregateType === "code-thread");
        // Replay through the persisted variant so pre-outcome journals (which
        // embed a delivery target without an `outcomeKind`) still decode,
        // defaulting the missing kind. New events always carry a confirmed one.
        const thread = decodeProjection(() =>
          event.eventName === "code.thread-created@1"
            ? decodePersistedCodeThreadCreated(event.payload).thread
            : decodePersistedCodeThreadUpdated(event.payload).thread,
        );
        assertEnvelope(
          String(thread.id) === String(event.aggregateId) &&
            thread.version === event.aggregateVersion,
        );
        upsertThread(connection, thread, event);
        return;
      }
      case "code.checkout-observed@1": {
        assertEnvelope(event.aggregateType === "code-checkout");
        const checkout = decodeProjection(() => decodeCodeCheckoutObserved(event.payload).checkout);
        assertEnvelope(String(checkout.id) === String(event.aggregateId));
        upsertCheckout(connection, checkout, event);
        return;
      }
      case "code.checkout-removed@1": {
        assertEnvelope(event.aggregateType === "code-checkout");
        const removed = decodeProjection(() => decodeCodeCheckoutRemoved(event.payload));
        assertEnvelope(String(removed.checkoutId) === String(event.aggregateId));
        deleteCheckout(connection, removed.checkoutId, event);
        return;
      }
      case "code.file-reference-updated@1": {
        assertEnvelope(event.aggregateType === "code-file");
        const file = decodeProjection(() => decodeCodeFileReferenceUpdated(event.payload).file);
        assertEnvelope(
          String(file.id) === String(event.aggregateId) && file.version === event.aggregateVersion,
        );
        upsertFile(connection, file, event);
        return;
      }
      case "code.runtime-work-updated@1": {
        assertEnvelope(event.aggregateType === "code-runtime");
        const work = decodeProjection(() => decodeCodeRuntimeWorkUpdated(event.payload).work);
        assertEnvelope(String(work.id) === String(event.aggregateId));
        upsertRuntimeWork(connection, work, event);
        return;
      }
      case "code.review-finding-updated@1": {
        assertEnvelope(event.aggregateType === "code-review-finding");
        const finding = decodeProjection(
          () => decodeCodeReviewFindingUpdated(event.payload).finding,
        );
        assertEnvelope(
          String(finding.id) === String(event.aggregateId) &&
            finding.version === event.aggregateVersion,
        );
        upsertReviewFinding(connection, finding, event);
        return;
      }
      case "code.operation-event-recorded@1": {
        assertEnvelope(event.aggregateType === CODE_OPERATION_AGGREGATE_TYPE);
        const frame = decodeProjection(() => decodeCodeOperationEventFrame(event.payload));
        assertEnvelope(String(frame.operationId) === String(event.aggregateId));
        // The operation aggregate is per turn, so its version says nothing about
        // the thread. The journal's global sequence is what orders one thread's
        // turns against each other, and it only ever grows.
        upsertThreadActivity(connection, frame.threadId, event.globalSequence);
        return;
      }
      case "code.follow-up-updated@1": {
        assertEnvelope(event.aggregateType === CODE_FOLLOW_UP_AGGREGATE_TYPE);
        const followUp = decodeProjection(
          () => decodeCodeThreadFollowUpUpdated(event.payload).followUp,
        );
        assertEnvelope(String(followUp.threadId) === String(event.aggregateId));
        upsertFollowUp(connection, followUp, event);
      }
    }
  }
}

function upsertThreadActivity(
  connection: SqliteConnection,
  threadId: CodeThreadId,
  globalSequence: number,
): void {
  connection
    .prepare(`
      INSERT INTO code_thread_activity_projection (thread_id, schema_version, last_sequence)
      VALUES (?, ?, ?)
      ON CONFLICT (thread_id) DO UPDATE SET
        schema_version = excluded.schema_version,
        last_sequence = excluded.last_sequence
      WHERE excluded.last_sequence > code_thread_activity_projection.last_sequence
    `)
    .run(threadId, CODE_PROJECTION_SCHEMA_VERSION, globalSequence);
}

function upsertFollowUp(
  connection: SqliteConnection,
  followUp: CodeThreadFollowUp,
  event: EventEnvelope,
): void {
  connection
    .prepare(`
      INSERT INTO code_thread_follow_up_projection (
        thread_id, schema_version, follow_up_json, state, aggregate_version, last_sequence
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (thread_id) DO UPDATE SET
        schema_version = excluded.schema_version,
        follow_up_json = excluded.follow_up_json,
        state = excluded.state,
        aggregate_version = excluded.aggregate_version,
        last_sequence = excluded.last_sequence
      WHERE excluded.aggregate_version >= code_thread_follow_up_projection.aggregate_version
    `)
    .run(
      followUp.threadId,
      CODE_PROJECTION_SCHEMA_VERSION,
      JSON.stringify(followUp),
      followUp.state,
      event.aggregateVersion,
      event.globalSequence,
    );
}

export function readCodeThreadFollowUp(
  connection: SqliteConnection,
  threadId: CodeThreadId,
): CodeThreadFollowUp | undefined {
  const row = connection
    .prepare(
      "SELECT schema_version, follow_up_json FROM code_thread_follow_up_projection WHERE thread_id = ?",
    )
    .get(threadId) as
    | { readonly schema_version: number; readonly follow_up_json: string }
    | undefined;
  if (row === undefined) return undefined;
  assertCodeProjectionSchema(row.schema_version);
  return decodeCodeThreadFollowUp(JSON.parse(row.follow_up_json));
}

export function readCodeFollowUpAggregateVersion(
  connection: SqliteConnection,
  threadId: CodeThreadId,
): number {
  const row = connection
    .prepare(
      "SELECT aggregate_version FROM aggregate_heads WHERE aggregate_type = ? AND aggregate_id = ?",
    )
    .get(CODE_FOLLOW_UP_AGGREGATE_TYPE, threadId) as
    | { readonly aggregate_version: number }
    | undefined;
  return row?.aggregate_version ?? 0;
}

export function hasProcessedCodeFollowUpTrigger(
  connection: SqliteConnection,
  threadId: CodeThreadId,
  sourceEventId: string,
): boolean {
  const row = connection
    .prepare(`
      SELECT 1 AS found
      FROM event_journal
      WHERE aggregate_type = ?
        AND aggregate_id = ?
        AND causation_id = ?
      LIMIT 1
    `)
    .get(CODE_FOLLOW_UP_AGGREGATE_TYPE, threadId, sourceEventId) as
    | { readonly found: 1 }
    | undefined;
  return row !== undefined;
}

function upsertReviewFinding(
  connection: SqliteConnection,
  finding: CodeReviewFinding,
  event: EventEnvelope,
): void {
  connection
    .prepare(`
      INSERT INTO code_review_projection (
        finding_id, thread_id, checkout_id, file_id, severity, state,
        schema_version, finding_json, aggregate_version, updated_at, last_sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (finding_id) DO UPDATE SET
        thread_id = excluded.thread_id,
        checkout_id = excluded.checkout_id,
        file_id = excluded.file_id,
        severity = excluded.severity,
        state = excluded.state,
        schema_version = excluded.schema_version,
        finding_json = excluded.finding_json,
        aggregate_version = excluded.aggregate_version,
        updated_at = excluded.updated_at,
        last_sequence = excluded.last_sequence
      WHERE excluded.aggregate_version > code_review_projection.aggregate_version
    `)
    .run(
      finding.id,
      finding.threadId,
      finding.checkoutId,
      finding.fileId,
      finding.severity,
      finding.state,
      CODE_PROJECTION_SCHEMA_VERSION,
      JSON.stringify(finding),
      event.aggregateVersion,
      finding.updatedAt,
      event.globalSequence,
    );
}

function upsertThread(
  connection: SqliteConnection,
  thread: CodeThread,
  event: EventEnvelope,
): void {
  connection
    .prepare(`
      INSERT INTO code_thread_projection (
        thread_id, project_id, checkout_id, lifecycle, schema_version,
        thread_json, aggregate_version, updated_at, last_sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (thread_id) DO UPDATE SET
        project_id = excluded.project_id,
        checkout_id = excluded.checkout_id,
        lifecycle = excluded.lifecycle,
        schema_version = excluded.schema_version,
        thread_json = excluded.thread_json,
        aggregate_version = excluded.aggregate_version,
        updated_at = excluded.updated_at,
        last_sequence = excluded.last_sequence
      WHERE excluded.aggregate_version > code_thread_projection.aggregate_version
    `)
    .run(
      thread.id,
      thread.projectId,
      thread.checkoutId,
      thread.lifecycle,
      CODE_PROJECTION_SCHEMA_VERSION,
      JSON.stringify(thread),
      event.aggregateVersion,
      thread.updatedAt,
      event.globalSequence,
    );
}

function upsertCheckout(
  connection: SqliteConnection,
  checkout: CodeCheckoutIdentity,
  event: EventEnvelope,
): void {
  connection
    .prepare(`
      INSERT INTO code_checkout_projection (
        checkout_id, repository_id, availability, schema_version,
        checkout_json, aggregate_version, observed_at, last_sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (checkout_id) DO UPDATE SET
        repository_id = excluded.repository_id,
        availability = excluded.availability,
        schema_version = excluded.schema_version,
        checkout_json = excluded.checkout_json,
        aggregate_version = excluded.aggregate_version,
        observed_at = excluded.observed_at,
        last_sequence = excluded.last_sequence
      WHERE excluded.aggregate_version > code_checkout_projection.aggregate_version
    `)
    .run(
      checkout.id,
      checkout.repositoryId,
      checkout.availability,
      CODE_PROJECTION_SCHEMA_VERSION,
      JSON.stringify(checkout),
      event.aggregateVersion,
      checkout.observedAt,
      event.globalSequence,
    );
}

function deleteCheckout(
  connection: SqliteConnection,
  checkoutId: CodeCheckoutId,
  event: EventEnvelope,
): void {
  connection.prepare("DELETE FROM code_checkout_projection WHERE checkout_id = ?").run(checkoutId);
}

function upsertFile(
  connection: SqliteConnection,
  file: CodeFileReference,
  event: EventEnvelope,
): void {
  connection
    .prepare(`
      INSERT INTO code_file_projection (
        file_id, thread_id, checkout_id, content_id, digest, byte_length,
        state, schema_version, file_json, aggregate_version, updated_at, last_sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (file_id) DO UPDATE SET
        thread_id = excluded.thread_id,
        checkout_id = excluded.checkout_id,
        content_id = excluded.content_id,
        digest = excluded.digest,
        byte_length = excluded.byte_length,
        state = excluded.state,
        schema_version = excluded.schema_version,
        file_json = excluded.file_json,
        aggregate_version = excluded.aggregate_version,
        updated_at = excluded.updated_at,
        last_sequence = excluded.last_sequence
      WHERE excluded.aggregate_version > code_file_projection.aggregate_version
    `)
    .run(
      file.id,
      file.threadId,
      file.checkoutId,
      file.contentId ?? null,
      file.digest,
      file.byteLength,
      file.state,
      CODE_PROJECTION_SCHEMA_VERSION,
      JSON.stringify(file),
      event.aggregateVersion,
      file.updatedAt,
      event.globalSequence,
    );
}

function upsertRuntimeWork(
  connection: SqliteConnection,
  work: CodeRuntimeWork,
  event: EventEnvelope,
): void {
  const evidence = "evidenceContentId" in work ? work : undefined;
  connection
    .prepare(`
      INSERT INTO code_runtime_projection (
        runtime_work_id, thread_id, work_kind, state, evidence_content_id,
        digest, byte_length, schema_version, work_json, aggregate_version,
        updated_at, last_sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (runtime_work_id) DO UPDATE SET
        thread_id = excluded.thread_id,
        work_kind = excluded.work_kind,
        state = excluded.state,
        evidence_content_id = excluded.evidence_content_id,
        digest = excluded.digest,
        byte_length = excluded.byte_length,
        schema_version = excluded.schema_version,
        work_json = excluded.work_json,
        aggregate_version = excluded.aggregate_version,
        updated_at = excluded.updated_at,
        last_sequence = excluded.last_sequence
      WHERE excluded.aggregate_version > code_runtime_projection.aggregate_version
    `)
    .run(
      work.id,
      work.threadId,
      work.kind,
      work.state,
      evidence?.evidenceContentId ?? null,
      evidence?.digest ?? null,
      evidence?.byteLength ?? null,
      CODE_PROJECTION_SCHEMA_VERSION,
      JSON.stringify(work),
      event.aggregateVersion,
      work.updatedAt,
      event.globalSequence,
    );
}

export function readCodeSettings(connection: SqliteConnection): ProjectedCodeSettings | undefined {
  const row = connection
    .prepare("SELECT * FROM code_settings_projection WHERE projection_key = ?")
    .get(CODE_SETTINGS_KEY) as CodeSettingsProjectionRow | undefined;
  if (row === undefined) return undefined;
  assertCodeProjectionSchema(row.schema_version);
  const settings = decodeCodeSettings(JSON.parse(row.settings_json));
  assertEnvelope(settings.version === row.aggregate_version);
  return {
    settings,
    aggregateVersion: row.aggregate_version,
    lastSequence: row.last_sequence,
  };
}

export function readCodeThread(
  connection: SqliteConnection,
  threadId: CodeThreadId,
): CodeThread | undefined {
  const row = connection
    .prepare("SELECT * FROM code_thread_projection WHERE thread_id = ?")
    .get(threadId) as CodeThreadProjectionRow | undefined;
  return row === undefined ? undefined : decodeThreadRow(row);
}

export function readCodeThreads(connection: SqliteConnection): ReadonlyArray<CodeThread> {
  return (
    connection
      .prepare("SELECT * FROM code_thread_projection ORDER BY updated_at DESC, thread_id ASC")
      .all() as ReadonlyArray<CodeThreadProjectionRow>
  ).map(decodeThreadRow);
}

/**
 * Every thread that has journaled operation activity, with the global sequence
 * of its latest operation event. Threads that have never run one are absent, so
 * a caller can tell "nothing has happened" from "sequence zero".
 */
export function readCodeThreadActivity(
  connection: SqliteConnection,
): ReadonlyArray<CodeThreadActivity> {
  return (
    connection
      .prepare("SELECT * FROM code_thread_activity_projection ORDER BY thread_id ASC")
      .all() as ReadonlyArray<CodeThreadActivityProjectionRow>
  ).map((row) => {
    assertCodeProjectionSchema(row.schema_version);
    return decodeCodeThreadActivity({
      threadId: row.thread_id,
      lastSequence: row.last_sequence,
    });
  });
}

export function readCodeCheckout(
  connection: SqliteConnection,
  checkoutId: CodeCheckoutId,
): CodeCheckoutIdentity | undefined {
  const row = connection
    .prepare("SELECT * FROM code_checkout_projection WHERE checkout_id = ?")
    .get(checkoutId) as CodeCheckoutProjectionRow | undefined;
  return row === undefined ? undefined : decodeCheckoutRow(row);
}

export function readCodeCheckoutAggregateVersion(
  connection: SqliteConnection,
  checkoutId: CodeCheckoutId,
): number {
  const row = connection
    .prepare("SELECT aggregate_version FROM code_checkout_projection WHERE checkout_id = ?")
    .get(checkoutId) as { readonly aggregate_version: number } | undefined;
  return row?.aggregate_version ?? 0;
}

export function readCodeCheckouts(
  connection: SqliteConnection,
): ReadonlyArray<CodeCheckoutIdentity> {
  return (
    connection
      .prepare("SELECT * FROM code_checkout_projection ORDER BY observed_at DESC, checkout_id ASC")
      .all() as ReadonlyArray<CodeCheckoutProjectionRow>
  ).map(decodeCheckoutRow);
}

export function readCodeFileReference(
  connection: SqliteConnection,
  fileId: CodeFileId,
): CodeFileReference | undefined {
  const row = connection
    .prepare("SELECT * FROM code_file_projection WHERE file_id = ?")
    .get(fileId) as CodeFileProjectionRow | undefined;
  return row === undefined ? undefined : decodeFileRow(row);
}

export function readCodeFileReferences(
  connection: SqliteConnection,
  threadId: CodeThreadId,
): ReadonlyArray<CodeFileReference> {
  return (
    connection
      .prepare("SELECT * FROM code_file_projection WHERE thread_id = ? ORDER BY file_id ASC")
      .all(threadId) as ReadonlyArray<CodeFileProjectionRow>
  ).map(decodeFileRow);
}

export function readCodeRuntimeWork(
  connection: SqliteConnection,
  workId: CodeRuntimeWorkId,
): CodeRuntimeWork | undefined {
  const row = connection
    .prepare("SELECT * FROM code_runtime_projection WHERE runtime_work_id = ?")
    .get(workId) as CodeRuntimeProjectionRow | undefined;
  return row === undefined ? undefined : decodeRuntimeRow(row);
}

export function readCodeRuntimeWorks(
  connection: SqliteConnection,
  threadId: CodeThreadId,
): ReadonlyArray<CodeRuntimeWork> {
  return (
    connection
      .prepare("SELECT * FROM code_runtime_projection WHERE thread_id = ? ORDER BY runtime_work_id")
      .all(threadId) as ReadonlyArray<CodeRuntimeProjectionRow>
  ).map(decodeRuntimeRow);
}

export function readCodeReviewFinding(
  connection: SqliteConnection,
  findingId: CodeReviewFindingId,
): CodeReviewFinding | undefined {
  const row = connection
    .prepare("SELECT * FROM code_review_projection WHERE finding_id = ?")
    .get(findingId) as CodeReviewProjectionRow | undefined;
  return row === undefined ? undefined : decodeReviewFindingRow(row);
}

export function readCodeReviewFindings(
  connection: SqliteConnection,
  threadId: CodeThreadId,
): ReadonlyArray<CodeReviewFinding> {
  return (
    connection
      .prepare(
        "SELECT * FROM code_review_projection WHERE thread_id = ? ORDER BY updated_at DESC, finding_id ASC",
      )
      .all(threadId) as ReadonlyArray<CodeReviewProjectionRow>
  ).map(decodeReviewFindingRow);
}

export function readCodeThreadView(
  connection: SqliteConnection,
  threadId: CodeThreadId,
): CodeThreadView | undefined {
  const thread = readCodeThread(connection, threadId);
  if (thread === undefined) return undefined;
  const checkout = readCodeCheckout(connection, thread.checkoutId);
  if (checkout === undefined) return undefined;
  return decodeCodeThreadView({ thread, checkout, lastSequence: thread.version });
}

export function reconcileCodeRestart(input: {
  readonly connection: SqliteConnection;
  readonly journal: Journal;
  readonly reconciledAt: string;
  readonly uuid?: () => string;
}): void {
  const uuid = input.uuid ?? randomUUID;
  const correlationId = uuid();
  const checkoutRows = input.connection
    .prepare("SELECT * FROM code_checkout_projection WHERE availability = 'available'")
    .all() as ReadonlyArray<CodeCheckoutProjectionRow>;
  for (const row of checkoutRows) {
    const checkout = decodeCheckoutRow(row);
    const reconciled = decodeCodeCheckoutIdentity({
      ...checkout,
      availability: "waiting",
      observedAt: input.reconciledAt,
    });
    input.journal.append({
      aggregate: { aggregateType: "code-checkout", aggregateId: checkout.id },
      expectedVersion: row.aggregate_version,
      events: [
        {
          eventId: uuid(),
          eventName: "code.checkout-observed@1",
          eventVersion: 1,
          correlationId,
          actor: {
            kind: "system",
            actorId: "00000000-0000-4000-8000-000000000021",
          },
          occurredAt: input.reconciledAt,
          payload: { kind: "checkout-observed", checkout: reconciled },
        },
      ],
    });
  }

  // Only running work is reconciled. `ambiguous` already says exactly what a
  // restart leaves behind — an outcome that cannot be established — and the
  // board treats it as a live wait for every kind, so rewriting it to
  // `interrupted` would invent a conclusion and let an unresolved Git push,
  // delivery, or review read as Ready.
  const runtimeRows = input.connection
    .prepare("SELECT * FROM code_runtime_projection WHERE state = 'running'")
    .all() as ReadonlyArray<CodeRuntimeProjectionRow>;
  for (const row of runtimeRows) {
    const work = decodeRuntimeRow(row);
    // A restart ends every OS process this host owned. Only a provider turn can
    // legitimately survive as a wait — it may still be owed a resume or an
    // approval — so it becomes `waiting`. File, terminal, test, Git, delivery,
    // and review work has no process left to wait for and is `interrupted`;
    // calling a dead shell "waiting" would leave the thread blocked forever.
    const state = work.kind === "provider-turn" ? "waiting" : "interrupted";
    // `updatedAt` keeps the moment this work last actually moved. Stamping the
    // restart here would make an old frozen turn look newer than a turn that
    // finished after it, and the board reads the latest provider turn to decide
    // whether the thread is still owed anything. The reconciliation time lives
    // on the event instead.
    const reconciled = decodeCodeRuntimeWork({ ...work, state });
    input.journal.append({
      aggregate: { aggregateType: "code-runtime", aggregateId: work.id },
      expectedVersion: row.aggregate_version,
      events: [
        {
          eventId: uuid(),
          eventName: "code.runtime-work-updated@1",
          eventVersion: 1,
          correlationId,
          actor: {
            kind: "system",
            actorId: "00000000-0000-4000-8000-000000000021",
          },
          occurredAt: input.reconciledAt,
          payload: { kind: "runtime-work-updated", work: reconciled },
        },
      ],
    });
  }

  const fileRows = input.connection
    .prepare("SELECT * FROM code_file_projection WHERE state = 'saving'")
    .all() as ReadonlyArray<CodeFileProjectionRow>;
  for (const row of fileRows) {
    const file = decodeFileRow(row);
    const reconciled = decodeCodeFileReference({
      ...file,
      state: "interrupted",
      version: row.aggregate_version + 1,
      updatedAt: input.reconciledAt,
    });
    input.journal.append({
      aggregate: { aggregateType: "code-file", aggregateId: file.id },
      expectedVersion: row.aggregate_version,
      events: [
        {
          eventId: uuid(),
          eventName: "code.file-reference-updated@1",
          eventVersion: 1,
          correlationId,
          actor: {
            kind: "system",
            actorId: "00000000-0000-4000-8000-000000000021",
          },
          occurredAt: input.reconciledAt,
          payload: { kind: "file-reference-updated", file: reconciled },
        },
      ],
    });
  }
}

function decodeThreadRow(row: CodeThreadProjectionRow): CodeThread {
  assertCodeProjectionSchema(row.schema_version);
  // Projection rows written before delivery outcomes existed store a delivery
  // target without an `outcomeKind`; decode through the persisted variant so
  // those cached rows survive without a forced rebuild.
  const thread = decodePersistedCodeThread(JSON.parse(row.thread_json));
  assertEnvelope(
    String(thread.id) === row.thread_id &&
      String(thread.projectId) === row.project_id &&
      String(thread.checkoutId) === row.checkout_id &&
      thread.lifecycle === row.lifecycle &&
      thread.version === row.aggregate_version &&
      String(thread.updatedAt) === row.updated_at,
  );
  return thread;
}

function decodeCheckoutRow(row: CodeCheckoutProjectionRow): CodeCheckoutIdentity {
  assertCodeProjectionSchema(row.schema_version);
  const checkout = decodeCodeCheckoutIdentity(JSON.parse(row.checkout_json));
  assertEnvelope(
    String(checkout.id) === row.checkout_id &&
      String(checkout.repositoryId) === row.repository_id &&
      checkout.availability === row.availability &&
      String(checkout.observedAt) === row.observed_at,
  );
  return checkout;
}

function decodeFileRow(row: CodeFileProjectionRow): CodeFileReference {
  assertCodeProjectionSchema(row.schema_version);
  const file = decodeCodeFileReference(JSON.parse(row.file_json));
  assertEnvelope(
    String(file.id) === row.file_id &&
      String(file.threadId) === row.thread_id &&
      String(file.checkoutId) === row.checkout_id &&
      (file.contentId === undefined ? null : String(file.contentId)) === row.content_id &&
      file.digest === row.digest &&
      file.byteLength === row.byte_length &&
      file.state === row.state &&
      file.version === row.aggregate_version &&
      String(file.updatedAt) === row.updated_at,
  );
  return file;
}

function decodeRuntimeRow(row: CodeRuntimeProjectionRow): CodeRuntimeWork {
  assertCodeProjectionSchema(row.schema_version);
  const work = decodeCodeRuntimeWork(JSON.parse(row.work_json));
  const evidence = "evidenceContentId" in work ? work : undefined;
  assertEnvelope(
    String(work.id) === row.runtime_work_id &&
      String(work.threadId) === row.thread_id &&
      work.kind === row.work_kind &&
      work.state === row.state &&
      (evidence === undefined ? null : String(evidence.evidenceContentId)) ===
        row.evidence_content_id &&
      (evidence?.digest ?? null) === row.digest &&
      (evidence?.byteLength ?? null) === row.byte_length &&
      String(work.updatedAt) === row.updated_at,
  );
  return work;
}

function decodeReviewFindingRow(row: CodeReviewProjectionRow): CodeReviewFinding {
  assertCodeProjectionSchema(row.schema_version);
  const finding = decodeCodeReviewFinding(JSON.parse(row.finding_json));
  assertEnvelope(
    String(finding.id) === row.finding_id &&
      String(finding.threadId) === row.thread_id &&
      String(finding.checkoutId) === row.checkout_id &&
      String(finding.fileId) === row.file_id &&
      finding.severity === row.severity &&
      finding.state === row.state &&
      finding.version === row.aggregate_version &&
      String(finding.updatedAt) === row.updated_at,
  );
  return finding;
}

function decodeProjection<T>(decode: () => T): T {
  try {
    return decode();
  } catch {
    throw new Error("Code projection event payload is invalid");
  }
}

function assertEnvelope(condition: boolean): asserts condition {
  if (!condition) throw new Error("Code projection event envelope is inconsistent");
}
import { randomUUID } from "node:crypto";
