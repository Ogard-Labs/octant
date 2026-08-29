import {
  decodeChatAttemptUpdated,
  decodeChatAttachment,
  decodeChatCitation,
  decodeChatContentBody,
  decodeChatAttachmentUpdated,
  decodeChatDeleted,
  decodeChatDeletionRequested,
  decodeChatCitationRecorded,
  decodeChatSettings,
  decodeChatSettingsUpdated,
  decodeChatThread,
  decodeChatNavigationThread,
  decodeChatThreadCreated,
  decodeChatThreadId,
  decodeChatThreadUpdated,
  decodeChatThreadView,
  decodeChatTurn,
  decodeChatTurnCreated,
  decodeChatTurnId,
  decodeChatTurnRouteDecided,
  decodeChatTurnRouteDecision,
  decodeContextSubjectRef,
  decodeThreadFollowUpUpdated,
  decodeThreadWorkUpdated,
  MAX_CHAT_TRANSCRIPT_SEARCH_HITS,
  MAX_CHAT_TRANSCRIPT_SEARCH_SNIPPET_LENGTH,
  ThreadFollowUp as ThreadFollowUpSchema,
  ThreadWorkItem as ThreadWorkItemSchema,
  type ChatSettings,
  type ChatNavigationThread,
  type ChatThread,
  type ChatThreadId,
  type ChatThreadView,
  type ChatTranscriptSearchHit,
  type ChatTurn,
  type ChatTurnRouteDecision,
  type EventEnvelope,
  type ThreadFollowUp,
} from "@octant/contracts";
import { AggregateId as AggregateIdSchema } from "@octant/contracts";
import type { AggregateVersion } from "@octant/contracts/events";
import type { ThreadWorkList } from "@octant/domain/thread-work-policy";
import { resolveChatMessageParts } from "@octant/domain/chat-message-parts";
import { Schema } from "effect";
import type { Projection } from "./projection";
import {
  assertChatProjectionSchema,
  CHAT_PROJECTION_SCHEMA_VERSION,
  CHAT_SETTINGS_KEY,
  type ChatContentRole,
  type PendingChatPurge,
  type ProjectedChatContent,
} from "./chatPersistenceSchema";
import { purgeAgentRunSubjectContent } from "./agentRunContentStore";
import { purgeContextSubjectContent } from "./contextProjection";
import type { SqliteConnection, SqliteStatement } from "./sqlitePort";

const decodeAggregateId = Schema.decodeUnknownSync(AggregateIdSchema);
const decodeThreadWorkItem = Schema.decodeUnknownSync(ThreadWorkItemSchema);
const decodeThreadFollowUp = Schema.decodeUnknownSync(ThreadFollowUpSchema);

/**
 * Aggregate type for the immutable per-turn multi-model route decision.
 * Keyed by turnId (not threadId) since it decides once for that
 * turn's entire lifetime, independent of the thread's own version.
 */
export const CHAT_TURN_ROUTE_AGGREGATE_TYPE = "chat-turn-route";

export const CHAT_SETTINGS_AGGREGATE_ID = decodeAggregateId("00000000-0000-4000-8000-000000000010");

export interface ProjectedChatSettings {
  readonly settings: ChatSettings;
  readonly aggregateVersion: number;
}

const chatEventNames = new Set([
  "chat.settings-updated@1",
  "chat.thread-created@1",
  "chat.thread-updated@1",
  "chat.turn-created@1",
  "chat.attempt-updated@1",
  "chat.turn-route-decided@1",
  "chat.attachment-updated@1",
  "chat.citation-recorded@1",
  "thread.work-updated@1",
  "thread.follow-up-updated@1",
  "chat.deletion-requested@1",
  "chat.deleted@1",
]);

export class ChatProjection implements Projection {
  readonly name = "chat";
  readonly dependencies: ReadonlyArray<string> = ["aggregate-heads"];

  reset(connection: SqliteConnection): void {
    connection.exec(`
      DELETE FROM chat_purge_projection;
      DELETE FROM thread_follow_up_projection;
      DELETE FROM thread_work_item_projection;
      DELETE FROM chat_transcript_search_projection;
      DELETE FROM chat_search_projection;
      DELETE FROM chat_citation_projection;
      DELETE FROM chat_attachment_projection;
      DELETE FROM chat_turn_route_projection;
      DELETE FROM chat_attempt_projection;
      DELETE FROM chat_turn_projection;
      DELETE FROM chat_thread_projection;
      DELETE FROM chat_settings_projection;
    `);
  }

  apply(connection: SqliteConnection, event: EventEnvelope): void {
    if (!chatEventNames.has(event.eventName)) return;
    assertEnvelope(event.eventVersion === 1);

    switch (event.eventName) {
      case "chat.settings-updated@1":
        this.#applySettings(connection, event);
        return;
      case "chat.thread-created@1":
        this.#applyThreadCreated(connection, event);
        return;
      case "chat.thread-updated@1":
        this.#applyThreadUpdated(connection, event);
        return;
      case "chat.turn-created@1":
        this.#applyTurnCreated(connection, event);
        return;
      case "chat.attempt-updated@1":
        this.#applyAttemptUpdated(connection, event);
        return;
      case "chat.turn-route-decided@1":
        this.#applyTurnRouteDecided(connection, event);
        return;
      case "chat.attachment-updated@1":
        this.#applyAttachmentUpdated(connection, event);
        return;
      case "chat.citation-recorded@1":
        this.#applyCitationRecorded(connection, event);
        return;
      case "thread.work-updated@1":
        this.#applyWorkUpdated(connection, event);
        return;
      case "thread.follow-up-updated@1":
        this.#applyFollowUpUpdated(connection, event);
        return;
      case "chat.deletion-requested@1":
        this.#applyDeletionRequested(connection, event);
        return;
      case "chat.deleted@1":
        this.#applyDeleted(connection, event);
        return;
    }
  }

  #applySettings(connection: SqliteConnection, event: EventEnvelope): void {
    assertEnvelope(
      event.aggregateType === "chat-settings" && event.aggregateId === CHAT_SETTINGS_AGGREGATE_ID,
    );
    const settings = decodeProjection(() => decodeChatSettingsUpdated(event.payload).settings);
    upsertSettings(connection).run(
      CHAT_SETTINGS_KEY,
      CHAT_PROJECTION_SCHEMA_VERSION,
      JSON.stringify(settings),
      event.aggregateVersion,
    );
  }

  #applyThreadCreated(connection: SqliteConnection, event: EventEnvelope): void {
    assertEnvelope(event.aggregateType === "chat-thread");
    const thread = decodeProjection(() => decodeChatThreadCreated(event.payload).thread);
    assertEnvelope(String(thread.id) === String(event.aggregateId));
    this.#upsertThread(connection, thread, event.aggregateVersion, event.globalSequence);
    upsertSearch(connection).run(
      thread.id,
      CHAT_PROJECTION_SCHEMA_VERSION,
      normalizeSearchText(thread.title),
      thread.updatedAt,
      event.globalSequence,
    );
  }

  #applyThreadUpdated(connection: SqliteConnection, event: EventEnvelope): void {
    assertEnvelope(event.aggregateType === "chat-thread");
    const thread = decodeProjection(() => decodeChatThreadUpdated(event.payload).thread);
    assertEnvelope(
      String(thread.id) === String(event.aggregateId) && thread.version === event.aggregateVersion,
    );
    this.#upsertThread(connection, thread, event.aggregateVersion, event.globalSequence);
    upsertSearch(connection).run(
      thread.id,
      CHAT_PROJECTION_SCHEMA_VERSION,
      normalizeSearchText(thread.title),
      thread.updatedAt,
      event.globalSequence,
    );
  }

  #applyTurnCreated(connection: SqliteConnection, event: EventEnvelope): void {
    assertEnvelope(event.aggregateType === "chat-thread");
    const turn = decodeProjection(() => decodeChatTurnCreated(event.payload).turn);
    assertEnvelope(String(turn.threadId) === String(event.aggregateId));
    upsertTurn(connection).run(
      turn.id,
      turn.threadId,
      turn.sequence,
      CHAT_PROJECTION_SCHEMA_VERSION,
      JSON.stringify(turn),
      event.aggregateVersion,
      turn.createdAt,
      event.globalSequence,
    );
    for (const attempt of turn.attempts) {
      upsertAttempt(connection).run(
        attempt.id,
        turn.id,
        turn.threadId,
        CHAT_PROJECTION_SCHEMA_VERSION,
        JSON.stringify(attempt),
        event.aggregateVersion,
        event.globalSequence,
      );
    }
    indexTranscriptSearchForTurn(connection, turn, event.globalSequence, turn.createdAt);
  }

  #applyAttemptUpdated(connection: SqliteConnection, event: EventEnvelope): void {
    assertEnvelope(event.aggregateType === "chat-thread");
    const attempt = decodeProjection(() => decodeChatAttemptUpdated(event.payload).attempt);
    assertEnvelope(String(attempt.threadId) === String(event.aggregateId));
    upsertAttempt(connection).run(
      attempt.id,
      attempt.turnId,
      attempt.threadId,
      CHAT_PROJECTION_SCHEMA_VERSION,
      JSON.stringify(attempt),
      event.aggregateVersion,
      event.globalSequence,
    );
    const turnRow = connection
      .prepare("SELECT turn_json FROM chat_turn_projection WHERE turn_id = ?")
      .get(attempt.turnId) as { readonly turn_json: string } | undefined;
    if (turnRow === undefined) return;
    const turn = decodeChatTurn(JSON.parse(turnRow.turn_json));
    const hasAttempt = turn.attempts.some((existing) => String(existing.id) === String(attempt.id));
    const attempts = hasAttempt
      ? turn.attempts.map((existing) =>
          String(existing.id) === String(attempt.id) ? attempt : existing,
        )
      : [...turn.attempts, attempt];
    const updatedTurn = { ...turn, attempts };
    upsertTurn(connection).run(
      updatedTurn.id,
      updatedTurn.threadId,
      updatedTurn.sequence,
      CHAT_PROJECTION_SCHEMA_VERSION,
      JSON.stringify(updatedTurn),
      event.aggregateVersion,
      updatedTurn.createdAt,
      event.globalSequence,
    );
    indexTranscriptSearchForTurn(
      connection,
      updatedTurn,
      event.globalSequence,
      attempt.updatedAt,
    );
  }

  #applyTurnRouteDecided(connection: SqliteConnection, event: EventEnvelope): void {
    const decision = decodeProjection(() => decodeChatTurnRouteDecided(event.payload).decision);
    // A waiting decision owns its per-turn aggregate because no parent turn
    // exists.  A selected decision is appended with chat.turn-created in the
    // parent thread aggregate so the executable turn and its immutable route
    // receipt are one transaction.
    assertEnvelope(
      (event.aggregateType === CHAT_TURN_ROUTE_AGGREGATE_TYPE &&
        String(decision.turnId) === String(event.aggregateId)) ||
        (event.aggregateType === "chat-thread" &&
          String(decision.threadId) === String(event.aggregateId)),
    );
    upsertTurnRouteDecision(connection).run(
      decision.turnId,
      decision.threadId,
      CHAT_PROJECTION_SCHEMA_VERSION,
      JSON.stringify(decision),
      event.aggregateVersion,
      decision.decidedAt,
      event.globalSequence,
    );
  }

  #applyAttachmentUpdated(connection: SqliteConnection, event: EventEnvelope): void {
    assertEnvelope(event.aggregateType === "chat-thread");
    const attachment = decodeProjection(
      () => decodeChatAttachmentUpdated(event.payload).attachment,
    );
    assertEnvelope(String(attachment.threadId) === String(event.aggregateId));
    upsertAttachment(connection).run(
      attachment.id,
      attachment.threadId,
      attachment.turnId ?? null,
      CHAT_PROJECTION_SCHEMA_VERSION,
      JSON.stringify(attachment),
      event.aggregateVersion,
      event.globalSequence,
    );
  }

  #applyCitationRecorded(connection: SqliteConnection, event: EventEnvelope): void {
    assertEnvelope(event.aggregateType === "chat-thread");
    const citation = decodeProjection(() => decodeChatCitationRecorded(event.payload).citation);
    assertEnvelope(String(citation.threadId) === String(event.aggregateId));
    upsertCitation(connection).run(
      citation.citationId,
      citation.threadId,
      citation.turnId,
      citation.attemptId,
      CHAT_PROJECTION_SCHEMA_VERSION,
      JSON.stringify(citation),
      event.aggregateVersion,
      event.globalSequence,
    );
  }

  #applyWorkUpdated(connection: SqliteConnection, event: EventEnvelope): void {
    assertEnvelope(event.aggregateType === "thread-work-list");
    const workItem = decodeProjection(() => decodeThreadWorkUpdated(event.payload).workItem);
    assertEnvelope(String(workItem.threadId) === String(event.aggregateId));
    upsertWorkItem(connection).run(
      workItem.threadId,
      workItem.id,
      CHAT_PROJECTION_SCHEMA_VERSION,
      JSON.stringify(workItem),
      event.aggregateVersion,
      event.globalSequence,
    );
  }

  #applyFollowUpUpdated(connection: SqliteConnection, event: EventEnvelope): void {
    assertEnvelope(event.aggregateType === "thread-follow-up");
    const followUp = decodeProjection(() => decodeThreadFollowUpUpdated(event.payload).followUp);
    assertEnvelope(String(followUp.threadId) === String(event.aggregateId));
    upsertFollowUp(connection).run(
      followUp.threadId,
      CHAT_PROJECTION_SCHEMA_VERSION,
      JSON.stringify(followUp),
      followUp.state,
      event.aggregateVersion,
      event.globalSequence,
    );
  }

  #applyDeletionRequested(connection: SqliteConnection, event: EventEnvelope): void {
    assertEnvelope(event.aggregateType === "chat-thread");
    const payload = decodeProjection(() => decodeChatDeletionRequested(event.payload));
    assertEnvelope(String(payload.threadId) === String(event.aggregateId));
    const thread = readRawThread(connection, payload.threadId);
    if (thread === undefined) return;
    const deleting = decodeChatThread({
      ...thread,
      lifecycle: "deleting",
      version: event.aggregateVersion,
      updatedAt: payload.requestedAt,
    });
    this.#upsertThread(connection, deleting, event.aggregateVersion, event.globalSequence);
    upsertPurge(connection).run(
      payload.threadId,
      "pending",
      payload.requestedAt,
      null,
      event.globalSequence,
    );
  }

  #applyDeleted(connection: SqliteConnection, event: EventEnvelope): void {
    assertEnvelope(event.aggregateType === "chat-thread");
    const payload = decodeProjection(() => decodeChatDeleted(event.payload));
    assertEnvelope(String(payload.threadId) === String(event.aggregateId));
    const thread = readRawThread(connection, payload.threadId);
    if (thread !== undefined) {
      const deleted = decodeChatThread({
        ...thread,
        lifecycle: "deleted",
        version: event.aggregateVersion,
        updatedAt: payload.deletedAt,
      });
      this.#upsertThread(connection, deleted, event.aggregateVersion, event.globalSequence);
    }
    purgeThreadContent(connection, payload.threadId);
    upsertPurge(connection).run(
      payload.threadId,
      "completed",
      payload.deletedAt,
      payload.deletedAt,
      event.globalSequence,
    );
  }

  #upsertThread(
    connection: SqliteConnection,
    thread: ChatThread,
    aggregateVersion: number,
    lastSequence: number,
  ): void {
    upsertThread(connection).run(
      thread.id,
      thread.projectId ?? null,
      thread.lifecycle,
      CHAT_PROJECTION_SCHEMA_VERSION,
      JSON.stringify(thread),
      aggregateVersion,
      thread.updatedAt,
      lastSequence,
    );
  }
}

export function writeChatContent(
  connection: SqliteConnection,
  input: {
    readonly contentId: string;
    readonly threadId: string;
    readonly role: ChatContentRole;
    readonly body: string;
    readonly digest: string;
    readonly byteLength: number;
  },
): void {
  connection
    .prepare(`
      INSERT INTO chat_content_store (
        content_id, thread_id, content_role, body_text, digest, byte_length
      ) VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(input.contentId, input.threadId, input.role, input.body, input.digest, input.byteLength);
}

export function purgeThreadContent(connection: SqliteConnection, threadId: string): void {
  connection.prepare("DELETE FROM chat_content_store WHERE thread_id = ?").run(threadId);
  const subject = decodeContextSubjectRef({
    aggregateType: "chat-thread",
    aggregateId: threadId,
  });
  // Compaction summaries are generated from this thread's own messages, so
  // their text is thread content and goes with it.
  purgeContextSubjectContent(connection, subject);
  // So are the parent-thread selection a child was admitted with and the reply
  // it produced about this conversation.
  purgeAgentRunSubjectContent(connection, subject);
  connection.prepare("DELETE FROM chat_attachment_projection WHERE thread_id = ?").run(threadId);
  connection.prepare("DELETE FROM chat_citation_projection WHERE thread_id = ?").run(threadId);
  connection.prepare("DELETE FROM chat_transcript_search_projection WHERE thread_id = ?").run(threadId);
  connection.prepare("DELETE FROM chat_search_projection WHERE thread_id = ?").run(threadId);
  connection.prepare("DELETE FROM thread_work_item_projection WHERE thread_id = ?").run(threadId);
  connection.prepare("DELETE FROM thread_follow_up_projection WHERE thread_id = ?").run(threadId);
  connection.prepare("DELETE FROM chat_attempt_projection WHERE thread_id = ?").run(threadId);
  connection.prepare("DELETE FROM chat_turn_projection WHERE thread_id = ?").run(threadId);
  connection.prepare("DELETE FROM chat_turn_route_projection WHERE thread_id = ?").run(threadId);
}

export function readChatSettings(connection: SqliteConnection): ProjectedChatSettings | undefined {
  const row = connection
    .prepare(`
      SELECT schema_version, settings_json, aggregate_version
      FROM chat_settings_projection
      WHERE projection_key = ?
    `)
    .get(CHAT_SETTINGS_KEY) as
    | {
        readonly schema_version: number;
        readonly settings_json: string;
        readonly aggregate_version: number;
      }
    | undefined;
  if (row === undefined) return undefined;
  assertChatProjectionSchema(row.schema_version);
  return {
    settings: decodeChatSettings(JSON.parse(row.settings_json)),
    aggregateVersion: row.aggregate_version,
  };
}

export function readChatThread(
  connection: SqliteConnection,
  threadId: ChatThreadId,
): ChatThread | undefined {
  return readRawThread(connection, threadId);
}

export function readChatThreads(connection: SqliteConnection): ReadonlyArray<ChatThread> {
  const rows = connection
    .prepare(`
      SELECT schema_version, thread_json
      FROM chat_thread_projection
      WHERE lifecycle != 'deleted'
      ORDER BY updated_at DESC, thread_id ASC
    `)
    .all() as ReadonlyArray<{ readonly schema_version: number; readonly thread_json: string }>;
  return rows.map(({ schema_version, thread_json }) => {
    assertChatProjectionSchema(schema_version);
    return decodeChatThread(JSON.parse(thread_json));
  });
}

/**
 * Read the complete sidebar projection in one bounded-metadata query. The
 * thread view intentionally remains the transcript read; using it here would
 * load every turn, attachment, citation, and work item once per row.
 *
 * `executing` mirrors the Chat service's in-flight check: a queued or streaming
 * attempt means a turn is running. Waiting attempts are not executing — they
 * are awaiting input, which the board treats separately.
 */
export function readChatNavigation(
  connection: SqliteConnection,
): ReadonlyArray<ChatNavigationThread> {
  const rows = connection
    .prepare(`
      WITH activity AS (
        SELECT thread_id, last_sequence FROM chat_thread_projection
        UNION ALL SELECT thread_id, last_sequence FROM chat_turn_projection
        UNION ALL SELECT thread_id, last_sequence FROM chat_attempt_projection
        UNION ALL SELECT thread_id, last_sequence FROM chat_attachment_projection
        UNION ALL SELECT thread_id, last_sequence FROM chat_citation_projection
        UNION ALL SELECT thread_id, last_sequence FROM thread_work_item_projection
        UNION ALL SELECT thread_id, last_sequence FROM thread_follow_up_projection
        UNION ALL SELECT thread_id, last_sequence FROM chat_purge_projection
        UNION ALL SELECT thread_id, last_sequence FROM chat_turn_route_projection
      ), activity_by_thread AS (
        SELECT thread_id, max(last_sequence) AS last_sequence
        FROM activity
        GROUP BY thread_id
      ), executing_threads AS (
        SELECT DISTINCT thread_id
        FROM chat_attempt_projection
        WHERE json_extract(attempt_json, '$.outcome') IN ('queued', 'streaming')
      )
      SELECT thread.schema_version, thread.thread_json,
             activity.last_sequence,
             coalesce(follow_up.state = 'open', 0) AS follow_up_open,
             CASE WHEN executing.thread_id IS NOT NULL THEN 1 ELSE 0 END AS executing
      FROM chat_thread_projection AS thread
      INNER JOIN activity_by_thread AS activity ON activity.thread_id = thread.thread_id
      LEFT JOIN thread_follow_up_projection AS follow_up
        ON follow_up.thread_id = thread.thread_id
      LEFT JOIN executing_threads AS executing
        ON executing.thread_id = thread.thread_id
      WHERE thread.lifecycle = 'active'
      ORDER BY thread.updated_at DESC, thread.thread_id ASC
    `)
    .all() as ReadonlyArray<{
    readonly schema_version: number;
    readonly thread_json: string;
    readonly last_sequence: number;
    readonly follow_up_open: number;
    readonly executing: number;
  }>;
  return rows.map((row) => {
    assertChatProjectionSchema(row.schema_version);
    const thread = decodeChatThread(JSON.parse(row.thread_json));
    return decodeChatNavigationThread({
      id: thread.id,
      ...(thread.projectId === undefined ? {} : { projectId: thread.projectId }),
      title: thread.title,
      providerInstanceId: thread.providerInstanceId,
      updatedAt: thread.updatedAt,
      lastSequence: row.last_sequence,
      followUpOpen: row.follow_up_open === 1,
      executing: row.executing === 1,
    });
  });
}

export function readChatThreadView(
  connection: SqliteConnection,
  threadId: ChatThreadId,
): ChatThreadView | undefined {
  const thread = readRawThread(connection, threadId);
  if (thread === undefined) return undefined;
  const turnRows = connection
    .prepare(`
      SELECT schema_version, turn_json
      FROM chat_turn_projection
      WHERE thread_id = ?
      ORDER BY sequence ASC
    `)
    .all(threadId) as ReadonlyArray<{
    readonly schema_version: number;
    readonly turn_json: string;
  }>;
  const turns = turnRows.map(({ schema_version, turn_json }) => {
    assertChatProjectionSchema(schema_version);
    return decodeChatTurn(JSON.parse(turn_json));
  });
  const attachments = readChatAttachments(connection, threadId);
  const citations = readChatCitations(connection, threadId);
  const workState = readThreadWorkState(connection, threadId);
  const contents = readChatContentBodies(connection, threadId, turns, citations);
  const routeDecisions = readChatTurnRouteDecisions(connection, threadId);
  const lastSequenceRow = connection
    .prepare(`
      SELECT coalesce(max(last_sequence), 0) AS last_sequence
      FROM (
        SELECT last_sequence FROM chat_thread_projection WHERE thread_id = ?
        UNION ALL
        SELECT last_sequence FROM chat_turn_projection WHERE thread_id = ?
        UNION ALL
        SELECT last_sequence FROM chat_attempt_projection WHERE thread_id = ?
        UNION ALL
        SELECT last_sequence FROM chat_turn_route_projection WHERE thread_id = ?
        UNION ALL
        SELECT last_sequence FROM chat_attachment_projection WHERE thread_id = ?
        UNION ALL
        SELECT last_sequence FROM chat_citation_projection WHERE thread_id = ?
        UNION ALL
        SELECT last_sequence FROM thread_work_item_projection WHERE thread_id = ?
        UNION ALL
        SELECT last_sequence FROM thread_follow_up_projection WHERE thread_id = ?
        UNION ALL
        SELECT last_sequence FROM chat_purge_projection WHERE thread_id = ?
      )
    `)
    .get(
      threadId,
      threadId,
      threadId,
      threadId,
      threadId,
      threadId,
      threadId,
      threadId,
      threadId,
    ) as {
    readonly last_sequence: number;
  };
  return decodeChatThreadView({
    thread,
    turns,
    lastSequence: lastSequenceRow.last_sequence,
    contents,
    attachments,
    citations,
    workItems: workState.workList.items,
    workListVersion: workState.workList.version,
    followUpVersion: workState.followUpVersion,
    ...(workState.followUp === undefined ? {} : { followUp: workState.followUp }),
    ...(routeDecisions.length === 0 ? {} : { routeDecisions }),
  });
}

function readChatAttachments(
  connection: SqliteConnection,
  threadId: ChatThreadId,
): ReadonlyArray<ReturnType<typeof decodeChatAttachment>> {
  const rows = connection
    .prepare(`
      SELECT schema_version, attachment_json
      FROM chat_attachment_projection
      WHERE thread_id = ?
      ORDER BY attachment_id ASC
    `)
    .all(threadId) as ReadonlyArray<{
    readonly schema_version: number;
    readonly attachment_json: string;
  }>;
  return rows.map(({ schema_version, attachment_json }) => {
    assertChatProjectionSchema(schema_version);
    return decodeChatAttachment(JSON.parse(attachment_json));
  });
}

function readChatCitations(
  connection: SqliteConnection,
  threadId: ChatThreadId,
): ReadonlyArray<ReturnType<typeof decodeChatCitation>> {
  const rows = connection
    .prepare(`
      SELECT schema_version, citation_json
      FROM chat_citation_projection
      WHERE thread_id = ?
      ORDER BY citation_id ASC
    `)
    .all(threadId) as ReadonlyArray<{
    readonly schema_version: number;
    readonly citation_json: string;
  }>;
  return rows.map(({ schema_version, citation_json }) => {
    assertChatProjectionSchema(schema_version);
    return decodeChatCitation(JSON.parse(citation_json));
  });
}

function readChatContentBodies(
  connection: SqliteConnection,
  threadId: ChatThreadId,
  turns: ReadonlyArray<ReturnType<typeof decodeChatTurn>>,
  citations: ReadonlyArray<ReturnType<typeof decodeChatCitation>>,
): ReadonlyArray<ReturnType<typeof decodeChatContentBody>> {
  const contentIds = new Set<string>();
  for (const turn of turns) {
    contentIds.add(String(turn.userMessageRef.contentId));
    for (const attempt of turn.attempts) {
      for (const responseRef of attempt.responseRefs) {
        contentIds.add(String(responseRef.contentId));
      }
      if (attempt.researchRef !== undefined) {
        contentIds.add(String(attempt.researchRef.contentId));
      }
    }
  }
  for (const citation of citations) {
    if (citation.snippetRef !== undefined) {
      contentIds.add(String(citation.snippetRef.contentId));
    }
  }
  const contents: Array<ReturnType<typeof decodeChatContentBody>> = [];
  for (const contentId of [...contentIds].sort()) {
    const projected = readChatContent(connection, contentId);
    if (projected === undefined || String(projected.threadId) !== String(threadId)) {
      throw new Error("Chat projection content is inconsistent");
    }
    contents.push(
      decodeChatContentBody({
        contentId: projected.contentId,
        role: projected.role,
        body: projected.body,
        digest: projected.digest,
        byteLength: projected.byteLength,
        parts: [...resolveChatMessageParts({ role: projected.role, body: projected.body })],
      }),
    );
  }
  return contents;
}

export function readChatContent(
  connection: SqliteConnection,
  contentId: string,
): ProjectedChatContent | undefined {
  const row = connection
    .prepare(`
      SELECT content_id, thread_id, content_role, body_text, digest, byte_length
      FROM chat_content_store
      WHERE content_id = ?
    `)
    .get(contentId) as
    | {
        readonly content_id: string;
        readonly thread_id: string;
        readonly content_role: ChatContentRole;
        readonly body_text: string;
        readonly digest: string;
        readonly byte_length: number;
      }
    | undefined;
  if (row === undefined) return undefined;
  return {
    contentId: row.content_id,
    threadId: decodeChatThreadId(row.thread_id),
    role: row.content_role,
    body: row.body_text,
    digest: row.digest,
    byteLength: row.byte_length,
  };
}

export function searchChatThreads(
  connection: SqliteConnection,
  query: string,
): ReadonlyArray<ChatThread> {
  const normalized = normalizeSearchText(query);
  if (normalized.length === 0) return [];
  const rows = connection
    .prepare(`
      SELECT thread.schema_version, thread.thread_json
      FROM chat_search_projection AS search
      INNER JOIN chat_thread_projection AS thread
        ON thread.thread_id = search.thread_id
      WHERE search.search_text LIKE '%' || ? || '%'
        AND thread.lifecycle != 'deleted'
      ORDER BY thread.updated_at DESC, thread.thread_id ASC
    `)
    .all(normalized) as ReadonlyArray<{
    readonly schema_version: number;
    readonly thread_json: string;
  }>;
  return rows.map(({ schema_version, thread_json }) => {
    assertChatProjectionSchema(schema_version);
    return decodeChatThread(JSON.parse(thread_json));
  });
}

export interface ChatTranscriptSearchRows {
  readonly hits: ReadonlyArray<ChatTranscriptSearchHit>;
  readonly truncated: boolean;
}

/**
 * Message-body search over per-content projection rows. Returns active and
 * archived threads only; the caller still filters hidden sidecars. Snippets
 * are clipped around the first hit in the stored body text.
 */
export function searchChatTranscript(
  connection: SqliteConnection,
  query: string,
  limit: number = MAX_CHAT_TRANSCRIPT_SEARCH_HITS,
): ChatTranscriptSearchRows {
  const normalized = normalizeSearchText(query);
  if (normalized.length === 0 || limit <= 0) {
    return { hits: [], truncated: false };
  }
  const fetchLimit = limit + 1;
  const rows = connection
    .prepare(`
      SELECT
        search.schema_version AS search_schema_version,
        search.content_id AS content_id,
        search.turn_id AS turn_id,
        search.search_text AS search_text,
        thread.schema_version AS thread_schema_version,
        thread.thread_json AS thread_json,
        content.body_text AS body_text
      FROM chat_transcript_search_projection AS search
      INNER JOIN chat_thread_projection AS thread
        ON thread.thread_id = search.thread_id
      INNER JOIN chat_content_store AS content
        ON content.content_id = search.content_id
      WHERE search.search_text LIKE '%' || ? || '%' ESCAPE '\\'
        AND thread.lifecycle IN ('active', 'archived')
      ORDER BY thread.updated_at DESC, search.turn_id ASC, search.content_id ASC
      LIMIT ?
    `)
    .all(escapeLikePattern(normalized), fetchLimit) as ReadonlyArray<{
    readonly search_schema_version: number;
    readonly content_id: string;
    readonly turn_id: string;
    readonly search_text: string;
    readonly thread_schema_version: number;
    readonly thread_json: string;
    readonly body_text: string;
  }>;

  const truncated = rows.length > limit;
  const hits: ChatTranscriptSearchHit[] = [];
  for (const row of rows.slice(0, limit)) {
    assertChatProjectionSchema(row.search_schema_version);
    assertChatProjectionSchema(row.thread_schema_version);
    const thread = decodeChatThread(JSON.parse(row.thread_json));
    if (thread.lifecycle !== "active" && thread.lifecycle !== "archived") continue;
    const clipped = clipTranscriptSearchSnippet(row.body_text, normalized);
    hits.push({
      threadId: thread.id,
      title: thread.title,
      lifecycle: thread.lifecycle,
      ...(thread.projectId === undefined ? {} : { projectId: thread.projectId }),
      turnId: decodeChatTurnId(row.turn_id),
      snippet: clipped.snippet,
      ...(clipped.matchRanges.length === 0 ? {} : { matchRanges: clipped.matchRanges }),
    });
  }
  return { hits, truncated };
}

export interface ProjectedThreadWorkState {
  readonly workList: ThreadWorkList;
  readonly followUpVersion: AggregateVersion;
  readonly followUp: ThreadFollowUp | undefined;
}

export function readThreadWorkList(
  connection: SqliteConnection,
  threadId: ChatThreadId,
): ThreadWorkList {
  const rows = connection
    .prepare(`
      SELECT schema_version, work_item_json
      FROM thread_work_item_projection
      WHERE thread_id = ?
      ORDER BY json_extract(work_item_json, '$.position') ASC,
               json_extract(work_item_json, '$.id') ASC
    `)
    .all(threadId) as ReadonlyArray<{
    readonly schema_version: number;
    readonly work_item_json: string;
  }>;
  const items = rows.map(({ schema_version, work_item_json }) => {
    assertChatProjectionSchema(schema_version);
    return decodeThreadWorkItem(JSON.parse(work_item_json));
  });
  return {
    threadId,
    version: readAggregateVersion(connection, "thread-work-list", threadId),
    items,
  };
}

export function readThreadFollowUp(
  connection: SqliteConnection,
  threadId: ChatThreadId,
): ThreadFollowUp | undefined {
  const row = connection
    .prepare(`
      SELECT schema_version, follow_up_json
      FROM thread_follow_up_projection
      WHERE thread_id = ?
    `)
    .get(threadId) as
    | { readonly schema_version: number; readonly follow_up_json: string }
    | undefined;
  if (row === undefined) return undefined;
  assertChatProjectionSchema(row.schema_version);
  return decodeThreadFollowUp(JSON.parse(row.follow_up_json));
}

export function readThreadWorkState(
  connection: SqliteConnection,
  threadId: ChatThreadId,
): ProjectedThreadWorkState {
  return {
    workList: readThreadWorkList(connection, threadId),
    followUpVersion: readAggregateVersion(connection, "thread-follow-up", threadId),
    followUp: readThreadFollowUp(connection, threadId),
  };
}

export function hasProcessedFollowUpTrigger(
  connection: SqliteConnection,
  threadId: ChatThreadId,
  sourceEventId: string,
): boolean {
  const row = connection
    .prepare(`
      SELECT 1 AS found
      FROM event_journal
      WHERE aggregate_type = 'thread-follow-up'
        AND aggregate_id = ?
        AND causation_id = ?
      LIMIT 1
    `)
    .get(threadId, sourceEventId) as { readonly found: 1 } | undefined;
  return row !== undefined;
}

export function readChatTurnRouteDecision(
  connection: SqliteConnection,
  turnId: string,
): ChatTurnRouteDecision | undefined {
  const row = connection
    .prepare(`
      SELECT schema_version, decision_json
      FROM chat_turn_route_projection
      WHERE turn_id = ?
    `)
    .get(turnId) as { readonly schema_version: number; readonly decision_json: string } | undefined;
  if (row === undefined) return undefined;
  assertChatProjectionSchema(row.schema_version);
  return decodeChatTurnRouteDecision(JSON.parse(row.decision_json));
}

export function readChatTurnRouteDecisions(
  connection: SqliteConnection,
  threadId: ChatThreadId,
): ReadonlyArray<ChatTurnRouteDecision> {
  const rows = connection
    .prepare(`
      SELECT schema_version, decision_json
      FROM chat_turn_route_projection
      WHERE thread_id = ?
      ORDER BY decided_at ASC, turn_id ASC
    `)
    .all(threadId) as ReadonlyArray<{
    readonly schema_version: number;
    readonly decision_json: string;
  }>;
  return rows.map(({ schema_version, decision_json }) => {
    assertChatProjectionSchema(schema_version);
    return decodeChatTurnRouteDecision(JSON.parse(decision_json));
  });
}

export function readAggregateVersion(
  connection: SqliteConnection,
  aggregateType: string,
  aggregateId: string,
): AggregateVersion {
  const row = connection
    .prepare(`
      SELECT aggregate_version
      FROM aggregate_heads
      WHERE aggregate_type = ? AND aggregate_id = ?
    `)
    .get(aggregateType, aggregateId) as { readonly aggregate_version: number } | undefined;
  return (row?.aggregate_version ?? 0) as AggregateVersion;
}

export function readPendingChatPurges(
  connection: SqliteConnection,
): ReadonlyArray<PendingChatPurge> {
  const rows = connection
    .prepare(`
      SELECT thread_id, requested_at, last_sequence
      FROM chat_purge_projection
      WHERE state = 'pending'
      ORDER BY requested_at ASC, thread_id ASC
    `)
    .all() as ReadonlyArray<{
    readonly thread_id: string;
    readonly requested_at: string;
    readonly last_sequence: number;
  }>;
  return rows.map((row) => ({
    threadId: decodeChatThreadId(row.thread_id),
    requestedAt: row.requested_at,
    lastSequence: row.last_sequence,
  }));
}

function readRawThread(connection: SqliteConnection, threadId: string): ChatThread | undefined {
  const row = connection
    .prepare(`
      SELECT schema_version, thread_json
      FROM chat_thread_projection
      WHERE thread_id = ?
    `)
    .get(threadId) as { readonly schema_version: number; readonly thread_json: string } | undefined;
  if (row === undefined) return undefined;
  assertChatProjectionSchema(row.schema_version);
  return decodeChatThread(JSON.parse(row.thread_json));
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase();
}

/** Escape LIKE metacharacters so a user needle cannot widen into every row. */
function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function indexTranscriptSearchForTurn(
  connection: SqliteConnection,
  turn: ChatTurn,
  lastSequence: number,
  updatedAt: string,
): void {
  const refs: Array<{ contentId: string }> = [
    { contentId: String(turn.userMessageRef.contentId) },
  ];
  for (const attempt of turn.attempts) {
    for (const responseRef of attempt.responseRefs) {
      refs.push({ contentId: String(responseRef.contentId) });
    }
    if (attempt.researchRef !== undefined) {
      refs.push({ contentId: String(attempt.researchRef.contentId) });
    }
  }
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref.contentId)) continue;
    seen.add(ref.contentId);
    upsertTranscriptSearchContent(connection, {
      contentId: ref.contentId,
      turnId: String(turn.id),
      threadId: String(turn.threadId),
      lastSequence,
      updatedAt,
    });
  }
}

function upsertTranscriptSearchContent(
  connection: SqliteConnection,
  input: {
    readonly contentId: string;
    readonly turnId: string;
    readonly threadId: string;
    readonly lastSequence: number;
    readonly updatedAt: string;
  },
): void {
  const content = readChatContent(connection, input.contentId);
  if (content === undefined) return;
  const searchText = normalizeSearchText(content.body);
  if (searchText.length === 0) return;
  upsertTranscriptSearch(connection).run(
    input.contentId,
    input.turnId,
    input.threadId,
    content.role,
    CHAT_PROJECTION_SCHEMA_VERSION,
    searchText,
    input.updatedAt,
    input.lastSequence,
  );
}

/**
 * Clip a body around the first case-insensitive hit so the overlay can show
 * context without shipping the whole message.
 */
export function clipTranscriptSearchSnippet(
  body: string,
  needle: string,
  maxLength: number = MAX_CHAT_TRANSCRIPT_SEARCH_SNIPPET_LENGTH,
): {
  readonly snippet: string;
  readonly matchRanges: ReadonlyArray<{ readonly start: number; readonly end: number }>;
} {
  if (maxLength <= 0) return { snippet: "", matchRanges: [] };
  const haystack = body.toLocaleLowerCase();
  const normalizedNeedle = needle.trim().toLocaleLowerCase();
  if (normalizedNeedle.length === 0) {
    return { snippet: body.slice(0, maxLength), matchRanges: [] };
  }
  const index = haystack.indexOf(normalizedNeedle);
  if (index < 0) {
    return { snippet: body.slice(0, maxLength), matchRanges: [] };
  }
  const matchLength = Math.min(normalizedNeedle.length, maxLength);
  const pad = Math.max(0, Math.floor((maxLength - matchLength) / 2));
  let start = Math.max(0, index - pad);
  let end = Math.min(body.length, start + maxLength);
  if (end - start < maxLength) {
    start = Math.max(0, end - maxLength);
  }
  const snippet = body.slice(start, end);
  const matchStart = index - start;
  if (matchStart < 0 || matchStart >= snippet.length) {
    return { snippet, matchRanges: [] };
  }
  const matchEnd = Math.min(snippet.length, matchStart + matchLength);
  if (matchEnd <= matchStart) return { snippet, matchRanges: [] };
  return { snippet, matchRanges: [{ start: matchStart, end: matchEnd }] };
}

function decodeProjection<T>(decode: () => T): T {
  try {
    return decode();
  } catch {
    throw new Error("Chat projection event payload is inconsistent");
  }
}

function assertEnvelope(condition: boolean): asserts condition {
  if (!condition) throw new Error("Chat projection event envelope is inconsistent");
}

function upsertSettings(connection: SqliteConnection): SqliteStatement {
  return connection.prepare(`
    INSERT INTO chat_settings_projection (
      projection_key, schema_version, settings_json, aggregate_version
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT (projection_key) DO UPDATE SET
      schema_version = excluded.schema_version,
      settings_json = excluded.settings_json,
      aggregate_version = excluded.aggregate_version
    WHERE excluded.aggregate_version >= chat_settings_projection.aggregate_version
  `);
}

function upsertThread(connection: SqliteConnection): SqliteStatement {
  return connection.prepare(`
    INSERT INTO chat_thread_projection (
      thread_id, project_id, lifecycle, schema_version, thread_json,
      aggregate_version, updated_at, last_sequence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (thread_id) DO UPDATE SET
      project_id = excluded.project_id,
      lifecycle = excluded.lifecycle,
      schema_version = excluded.schema_version,
      thread_json = excluded.thread_json,
      aggregate_version = excluded.aggregate_version,
      updated_at = excluded.updated_at,
      last_sequence = excluded.last_sequence
    WHERE excluded.aggregate_version >= chat_thread_projection.aggregate_version
  `);
}

function upsertTurn(connection: SqliteConnection): SqliteStatement {
  return connection.prepare(`
    INSERT INTO chat_turn_projection (
      turn_id, thread_id, sequence, schema_version, turn_json,
      aggregate_version, created_at, last_sequence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (turn_id) DO UPDATE SET
      thread_id = excluded.thread_id,
      sequence = excluded.sequence,
      schema_version = excluded.schema_version,
      turn_json = excluded.turn_json,
      aggregate_version = excluded.aggregate_version,
      created_at = excluded.created_at,
      last_sequence = excluded.last_sequence
    WHERE excluded.aggregate_version >= chat_turn_projection.aggregate_version
  `);
}

function upsertAttempt(connection: SqliteConnection): SqliteStatement {
  return connection.prepare(`
    INSERT INTO chat_attempt_projection (
      attempt_id, turn_id, thread_id, schema_version, attempt_json,
      aggregate_version, last_sequence
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (attempt_id) DO UPDATE SET
      turn_id = excluded.turn_id,
      thread_id = excluded.thread_id,
      schema_version = excluded.schema_version,
      attempt_json = excluded.attempt_json,
      aggregate_version = excluded.aggregate_version,
      last_sequence = excluded.last_sequence
    WHERE excluded.aggregate_version >= chat_attempt_projection.aggregate_version
  `);
}

function upsertAttachment(connection: SqliteConnection): SqliteStatement {
  return connection.prepare(`
    INSERT INTO chat_attachment_projection (
      attachment_id, thread_id, turn_id, schema_version, attachment_json,
      aggregate_version, last_sequence
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (attachment_id) DO UPDATE SET
      thread_id = excluded.thread_id,
      turn_id = excluded.turn_id,
      schema_version = excluded.schema_version,
      attachment_json = excluded.attachment_json,
      aggregate_version = excluded.aggregate_version,
      last_sequence = excluded.last_sequence
    WHERE excluded.aggregate_version >= chat_attachment_projection.aggregate_version
  `);
}

function upsertCitation(connection: SqliteConnection): SqliteStatement {
  return connection.prepare(`
    INSERT INTO chat_citation_projection (
      citation_id, thread_id, turn_id, attempt_id, schema_version, citation_json,
      aggregate_version, last_sequence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (citation_id) DO UPDATE SET
      thread_id = excluded.thread_id,
      turn_id = excluded.turn_id,
      attempt_id = excluded.attempt_id,
      schema_version = excluded.schema_version,
      citation_json = excluded.citation_json,
      aggregate_version = excluded.aggregate_version,
      last_sequence = excluded.last_sequence
    WHERE excluded.aggregate_version >= chat_citation_projection.aggregate_version
  `);
}

function upsertSearch(connection: SqliteConnection): SqliteStatement {
  return connection.prepare(`
    INSERT INTO chat_search_projection (
      thread_id, schema_version, search_text, updated_at, last_sequence
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (thread_id) DO UPDATE SET
      schema_version = excluded.schema_version,
      search_text = excluded.search_text,
      updated_at = excluded.updated_at,
      last_sequence = excluded.last_sequence
    WHERE excluded.last_sequence >= chat_search_projection.last_sequence
  `);
}

function upsertTranscriptSearch(connection: SqliteConnection): SqliteStatement {
  return connection.prepare(`
    INSERT INTO chat_transcript_search_projection (
      content_id, turn_id, thread_id, content_role, schema_version,
      search_text, updated_at, last_sequence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (content_id) DO UPDATE SET
      turn_id = excluded.turn_id,
      thread_id = excluded.thread_id,
      content_role = excluded.content_role,
      schema_version = excluded.schema_version,
      search_text = excluded.search_text,
      updated_at = excluded.updated_at,
      last_sequence = excluded.last_sequence
    WHERE excluded.last_sequence >= chat_transcript_search_projection.last_sequence
  `);
}

function upsertWorkItem(connection: SqliteConnection): SqliteStatement {
  return connection.prepare(`
    INSERT INTO thread_work_item_projection (
      thread_id, item_id, schema_version, work_item_json,
      aggregate_version, last_sequence
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (thread_id, item_id) DO UPDATE SET
      schema_version = excluded.schema_version,
      work_item_json = excluded.work_item_json,
      aggregate_version = excluded.aggregate_version,
      last_sequence = excluded.last_sequence
    WHERE excluded.aggregate_version >= thread_work_item_projection.aggregate_version
  `);
}

function upsertFollowUp(connection: SqliteConnection): SqliteStatement {
  return connection.prepare(`
    INSERT INTO thread_follow_up_projection (
      thread_id, schema_version, follow_up_json, state,
      aggregate_version, last_sequence
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (thread_id) DO UPDATE SET
      schema_version = excluded.schema_version,
      follow_up_json = excluded.follow_up_json,
      state = excluded.state,
      aggregate_version = excluded.aggregate_version,
      last_sequence = excluded.last_sequence
    WHERE excluded.aggregate_version >= thread_follow_up_projection.aggregate_version
  `);
}

function upsertTurnRouteDecision(connection: SqliteConnection): SqliteStatement {
  return connection.prepare(`
    INSERT INTO chat_turn_route_projection (
      turn_id, thread_id, schema_version, decision_json,
      aggregate_version, decided_at, last_sequence
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (turn_id) DO UPDATE SET
      schema_version = excluded.schema_version,
      decision_json = excluded.decision_json,
      aggregate_version = excluded.aggregate_version,
      decided_at = excluded.decided_at,
      last_sequence = excluded.last_sequence
    WHERE excluded.aggregate_version >= chat_turn_route_projection.aggregate_version
  `);
}

function upsertPurge(connection: SqliteConnection): SqliteStatement {
  return connection.prepare(`
    INSERT INTO chat_purge_projection (
      thread_id, state, requested_at, completed_at, last_sequence
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (thread_id) DO UPDATE SET
      state = excluded.state,
      requested_at = chat_purge_projection.requested_at,
      completed_at = excluded.completed_at,
      last_sequence = excluded.last_sequence
    WHERE excluded.last_sequence >= chat_purge_projection.last_sequence
  `);
}
