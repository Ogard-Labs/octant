import {
  decodeChatAttemptResponseAppended,
  decodeChatAttemptToolStepChanged,
  decodeCanvasCreated,
  decodeCanvasVersionAppended,
  decodeChatAttachmentUpdated,
  decodeChatAttemptUpdated,
  decodeChatDeleted,
  decodeChatThreadCreated,
  decodeChatThreadRewound,
  decodeChatThreadUpdated,
  decodeChatTurnCreated,
  decodeCodeOperationEventFrame,
  decodeCodeThreadCreated,
  decodeCodeThreadUpdated,
  decodeWorkThreadRewound,
  decodeWorkTurnAccepted,
  decodeWorkTurnUpdated,
  MAX_CODE_CONVERSATION_ASSISTANT_PARTS,
  type CodeEvidenceReference,
  type EventEnvelope,
  type ThreadToolStep,
} from "@octant/contracts";
import { WorkThreadCreated, WorkThreadUpdated } from "@octant/contracts/work-threads";
import { ParseResult, Schema } from "effect";
import { readActiveChatTurnIds, readChatContent } from "./chatProjection";
import type { Projection } from "./projection";
import type { SqliteConnection, SqliteStatement } from "./sqlitePort";
import { clipSearchSnippet, escapeLikePattern, parseSearchTerms } from "./transcriptSearchText";

export type ThreadSearchMode = "chat" | "work" | "code";
export type ThreadSearchDocumentField = "title" | "prompt" | "reply" | "tool" | "canvas";

/**
 * A tool document keeps at most this much text. Terminal output can run to
 * megabytes, and a trigram index costs a few times the text it holds; the
 * newest output is kept, since that is where a command's error or result is.
 */
export const MAX_THREAD_SEARCH_TOOL_TEXT = 32 * 1024;
/** A prompt or reply document keeps at most this much text, from its start. */
export const MAX_THREAD_SEARCH_MESSAGE_TEXT = 256 * 1024;
/**
 * A terminal keeps at most this many streamed pieces in the index, newest
 * first, so a long-running command's output stays bounded.
 */
export const MAX_THREAD_SEARCH_TERMINAL_PIECES = 64;
/**
 * Each streamed piece starts with this much of the piece before it, so a word
 * or phrase split across two pieces still matches, while every piece writes
 * the same amount however long the reply has grown.
 */
const STREAM_LEAD_IN = 96;

const decodeWorkThreadCreated = Schema.decodeUnknownSync(WorkThreadCreated);
const decodeWorkThreadUpdated = Schema.decodeUnknownSync(WorkThreadUpdated);

interface DocumentIdentity {
  readonly mode: ThreadSearchMode;
  readonly threadId: string;
  /** What a removal names: Chat's turn, Work's request, Code's operation. */
  readonly turnKey: string;
  /** What a hit names to reveal: Chat's turn, Work's turn, Code's operation. */
  readonly anchorId: string;
  readonly field: ThreadSearchDocumentField;
  readonly sequence: number;
}

interface Statements {
  readonly readDocument: SqliteStatement;
  readonly insertDocument: SqliteStatement;
  readonly updateBody: SqliteStatement;
  readonly readPart: SqliteStatement;
  readonly upsertPart: SqliteStatement;
  readonly partsOf: SqliteStatement;
  readonly streamCount: SqliteStatement;
  readonly streamTail: SqliteStatement;
  readonly streamOldest: SqliteStatement;
  readonly deleteDocument: SqliteStatement;
  readonly deleteStream: SqliteStatement;
  readonly deleteThread: SqliteStatement;
  readonly deleteThreadParts: SqliteStatement;
  readonly deleteTurn: SqliteStatement;
  readonly deleteTurnParts: SqliteStatement;
  readonly turnKeysOf: SqliteStatement;
  readonly codeTurnStart: SqliteStatement;
  readonly codeTurnsFrom: SqliteStatement;
}

/**
 * One full-text index over every mode's threads: each thread's title, and for
 * each turn the person's prompt, the reply, and what its tools did.
 *
 * A document is joined from parts. A streamed reply is many parts joined with
 * nothing between them, so a word split across two bursts still matches; a
 * tool document is one part per tool call or terminal, joined by line, and a
 * part that changes (a step's summary, a terminal that redraws) replaces its
 * text. Rebuildable from the journal: Work keeps its text in the events, and
 * Chat and Code name rows in their content stores, which outlive a projection
 * reset.
 *
 * It finds what each thread shows: a turn an edit superseded or a rewind
 * removed leaves the index, and a deleted Chat thread's documents go with it.
 * Who may see which thread is not decided here; the search read passes the
 * threads each mode lists for the caller.
 *
 * Derived: only search reads it, so a failing apply holds this view back
 * instead of rolling back the write that journaled the event.
 */
export class ThreadSearchProjection implements Projection {
  readonly name = "thread-search";
  readonly dependencies: ReadonlyArray<string> = ["aggregate-heads", "chat"];
  readonly derived = true as const;
  #statements = new WeakMap<SqliteConnection, Statements>();

  reset(connection: SqliteConnection): void {
    connection.exec(`
      DELETE FROM thread_search_part;
      DELETE FROM thread_search_document;
    `);
  }

  apply(connection: SqliteConnection, event: EventEnvelope): void {
    if (event.eventVersion !== 1) return;
    try {
      this.#apply(connection, event);
    } catch (error) {
      // An event this view cannot read leaves it unindexed, as the mode's own
      // read skips it, rather than holding back search for every thread.
      if (ParseResult.isParseError(error)) return;
      throw error;
    }
  }

  #apply(connection: SqliteConnection, event: EventEnvelope): void {
    const statements = this.#statementsFor(connection);
    const index = new SearchIndexWriter(connection, statements, event.globalSequence);
    switch (event.eventName) {
      case "chat.thread-created@1":
      case "chat.thread-updated@1": {
        const thread =
          event.eventName === "chat.thread-created@1"
            ? decodeChatThreadCreated(event.payload).thread
            : decodeChatThreadUpdated(event.payload).thread;
        if (thread.lifecycle === "deleted") {
          index.removeThread("chat", String(thread.id));
          return;
        }
        index.setTitle("chat", String(thread.id), thread.title);
        return;
      }
      case "chat.deleted@1":
        index.removeThread("chat", String(decodeChatDeleted(event.payload).threadId));
        return;
      case "chat.turn-created@1": {
        const turn = decodeChatTurnCreated(event.payload).turn;
        const threadId = String(turn.threadId);
        const turnId = String(turn.id);
        const at = { mode: "chat", threadId, turnKey: turnId, anchorId: turnId } as const;
        const prompt = readChatContent(connection, String(turn.userMessageRef.contentId));
        index.putPart({ ...at, field: "prompt" }, "prompt", 0, prompt?.body ?? "");
        for (const attempt of turn.attempts) {
          for (const ref of chatReplyRefs(attempt)) {
            index.addChatReply(at, String(ref.contentId));
          }
          index.putChatToolSteps(at, attempt.toolSteps ?? []);
        }
        if (turn.supersedes !== undefined) index.dropInactiveChatTurns(threadId);
        return;
      }
      case "chat.attempt-updated@1": {
        const attempt = decodeChatAttemptUpdated(event.payload).attempt;
        const threadId = String(attempt.threadId);
        const turnId = String(attempt.turnId);
        const at = { mode: "chat", threadId, turnKey: turnId, anchorId: turnId } as const;
        for (const ref of chatReplyRefs(attempt)) index.addChatReply(at, String(ref.contentId));
        index.putChatToolSteps(at, attempt.toolSteps ?? []);
        return;
      }
      case "chat.attempt-response-appended@1": {
        const appended = decodeChatAttemptResponseAppended(event.payload);
        const turnId = String(appended.turnId);
        index.addChatReply(
          { mode: "chat", threadId: String(appended.threadId), turnKey: turnId, anchorId: turnId },
          String(appended.responseRef.contentId),
        );
        return;
      }
      case "chat.attempt-tool-step@1": {
        const changed = decodeChatAttemptToolStepChanged(event.payload);
        if (changed.toolStep === undefined) return;
        const turnId = String(changed.turnId);
        index.putChatToolSteps(
          { mode: "chat", threadId: String(changed.threadId), turnKey: turnId, anchorId: turnId },
          [changed.toolStep],
        );
        return;
      }
      case "chat.attachment-updated@1": {
        // An attachment is part of the person's message: its file name joins
        // the turn's prompt document, so "the budget spreadsheet" finds the
        // turn that sent budget.pdf. Its bytes live in files outside the
        // journal and are not read here. A purged attachment leaves the index.
        const attachment = decodeChatAttachmentUpdated(event.payload).attachment;
        if (attachment.turnId === undefined) return;
        const turnId = String(attachment.turnId);
        index.putPart(
          {
            mode: "chat",
            threadId: String(attachment.threadId),
            turnKey: turnId,
            anchorId: turnId,
            field: "prompt",
          },
          `attachment:${String(attachment.id)}`,
          1,
          attachment.status === "purged" ? "" : attachment.displayName,
        );
        return;
      }
      case "chat.thread-rewound@1": {
        const rewound = decodeChatThreadRewound(event.payload);
        index.dropInactiveChatTurns(String(rewound.thread.id));
        return;
      }
      case "work.thread-created@1":
      case "work.thread-updated@1": {
        const thread =
          event.eventName === "work.thread-created@1"
            ? decodeWorkThreadCreated(event.payload).thread
            : decodeWorkThreadUpdated(event.payload).thread;
        if (thread.lifecycle === "deleted") {
          index.removeThread("work", String(thread.id));
          return;
        }
        index.setTitle("work", String(thread.id), thread.title);
        return;
      }
      case "work.turn-accepted@1": {
        const accepted = decodeWorkTurnAccepted(event.payload);
        index.putPart(
          {
            mode: "work",
            threadId: String(accepted.threadId),
            turnKey: String(accepted.requestId),
            anchorId: String(accepted.turnId),
            field: "prompt",
          },
          "prompt",
          0,
          accepted.prompt,
        );
        return;
      }
      case "work.turn-updated@1": {
        const updated = decodeWorkTurnUpdated(event.payload);
        const threadId = index.threadOfTurn("work", String(updated.requestId));
        // An update for a turn the index never saw accepted (a rewound or
        // purged one) has no thread to file under.
        if (threadId === undefined) return;
        const at = {
          mode: "work",
          threadId,
          turnKey: String(updated.requestId),
          anchorId: String(updated.turnId),
        } as const;
        // Each update is a whole snapshot of the turn, so it replaces the text.
        const reply =
          updated.response ??
          updated.transcript
            ?.filter((entry) => entry.role === "assistant")
            .map((entry) => entry.text)
            .join("\n");
        if (reply !== undefined) index.putPart({ ...at, field: "reply" }, "reply", 0, reply);
        for (const step of updated.toolSteps ?? []) {
          index.putPart({ ...at, field: "tool" }, `tool:${step.toolCallId}`, 1, toolStepText(step));
        }
        if (updated.wroteFiles !== undefined && updated.wroteFiles.paths.length > 0) {
          index.putPart(
            { ...at, field: "tool" },
            "wrote-files",
            0,
            updated.wroteFiles.paths.join("\n"),
          );
        }
        return;
      }
      case "work.thread-rewound@1": {
        const rewound = decodeWorkThreadRewound(event.payload);
        for (const requestId of rewound.removedRequestIds) {
          index.removeTurn("work", String(rewound.threadId), String(requestId));
        }
        return;
      }
      case "code.thread-created@1":
      case "code.thread-updated@1": {
        const thread =
          event.eventName === "code.thread-created@1"
            ? decodeCodeThreadCreated(event.payload).thread
            : decodeCodeThreadUpdated(event.payload).thread;
        index.setTitle("code", String(thread.id), thread.title);
        return;
      }
      case "canvas.created@1":
      case "canvas.version-appended@1": {
        // Every version carries the whole Canvas, so the newest one replaces
        // its text. A Canvas is filed under the one thread its provenance
        // names, so it is found exactly where that thread may be listed.
        const { canvasId, version } =
          event.eventName === "canvas.created@1"
            ? decodeCanvasCreated(event.payload)
            : decodeCanvasVersionAppended(event.payload);
        const { title, provenance, blocks } = version.definition;
        const key = `canvas:${String(canvasId)}`;
        index.moveCanvas(key, provenance.mode, String(provenance.threadId));
        index.putPart(
          {
            mode: provenance.mode,
            threadId: String(provenance.threadId),
            turnKey: key,
            anchorId: String(canvasId),
            field: "canvas",
          },
          "content",
          0,
          [title, ...canvasBlockText(blocks)].join("\n"),
        );
        return;
      }
      case "code.operation-event-recorded@1":
        applyCodeFrame(connection, statements, index, event);
        return;
      default:
        return;
    }
  }

  #statementsFor(connection: SqliteConnection): Statements {
    const cached = this.#statements.get(connection);
    if (cached !== undefined) return cached;
    const statements: Statements = {
      readDocument: connection.prepare(
        `SELECT body, thread_id FROM thread_search_document WHERE doc_key = ?`,
      ),
      insertDocument: connection.prepare(`
        INSERT INTO thread_search_document (
          doc_key, mode, thread_id, turn_key, anchor_id, field, stream_key, start_sequence, body
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      updateBody: connection.prepare(
        `UPDATE thread_search_document SET body = ? WHERE doc_key = ? AND body != ?`,
      ),
      readPart: connection.prepare(`SELECT body FROM thread_search_part WHERE part_key = ?`),
      upsertPart: connection.prepare(`
        INSERT INTO thread_search_part (part_key, doc_key, thread_id, position, body)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (part_key) DO UPDATE SET body = excluded.body
      `),
      partsOf: connection.prepare(`
        SELECT body FROM thread_search_part
        WHERE doc_key = ?
        ORDER BY position ASC, rowid ASC
      `),
      streamCount: connection.prepare(
        `SELECT count(*) AS pieces FROM thread_search_document WHERE stream_key = ?`,
      ),
      streamTail: connection.prepare(`
        SELECT substr(body, -${STREAM_LEAD_IN}) AS tail FROM thread_search_document
        WHERE stream_key = ?
        ORDER BY start_sequence DESC, doc_id DESC
        LIMIT 1
      `),
      streamOldest: connection.prepare(`
        SELECT doc_key FROM thread_search_document
        WHERE stream_key = ?
        ORDER BY start_sequence ASC, doc_id ASC
        LIMIT 1
      `),
      deleteDocument: connection.prepare(`DELETE FROM thread_search_document WHERE doc_key = ?`),
      deleteStream: connection.prepare(`DELETE FROM thread_search_document WHERE stream_key = ?`),
      deleteThread: connection.prepare(
        `DELETE FROM thread_search_document WHERE mode = ? AND thread_id = ?`,
      ),
      deleteThreadParts: connection.prepare(
        `DELETE FROM thread_search_part WHERE doc_key LIKE ? ESCAPE '\\'`,
      ),
      deleteTurn: connection.prepare(
        `DELETE FROM thread_search_document WHERE mode = ? AND thread_id = ? AND turn_key = ?`,
      ),
      deleteTurnParts: connection.prepare(
        `DELETE FROM thread_search_part WHERE doc_key LIKE ? ESCAPE '\\'`,
      ),
      turnKeysOf: connection.prepare(`
        SELECT DISTINCT turn_key FROM thread_search_document
        WHERE mode = ? AND thread_id = ? AND field NOT IN ('title', 'canvas')
      `),
      codeTurnStart: connection.prepare(`
        SELECT start_sequence FROM thread_search_document
        WHERE mode = 'code' AND thread_id = ? AND turn_key = ? AND field = 'prompt'
      `),
      codeTurnsFrom: connection.prepare(`
        SELECT DISTINCT turn_key FROM thread_search_document
        WHERE mode = 'code' AND thread_id = ? AND field != 'title'
          AND start_sequence >= ? AND start_sequence < ?
      `),
    };
    this.#statements.set(connection, statements);
    return statements;
  }
}

function applyCodeFrame(
  connection: SqliteConnection,
  statements: Statements,
  index: SearchIndexWriter,
  event: EventEnvelope,
): void {
  let frame: ReturnType<typeof decodeCodeOperationEventFrame>;
  try {
    frame = decodeCodeOperationEventFrame(event.payload);
  } catch {
    // The conversation read skips a frame that no longer decodes; search
    // matches what that read shows.
    return;
  }
  if (String(frame.operationId) !== String(event.aggregateId)) return;
  const operationId = String(frame.operationId);
  const at = {
    mode: "code",
    threadId: String(frame.threadId),
    turnKey: operationId,
    anchorId: operationId,
  } as const;
  const kind = frame.event.kind;
  if (kind === "conversation-turn-started") {
    index.putPart(
      { ...at, field: "prompt" },
      "prompt",
      0,
      readCodeEvidence(connection, frame.event.prompt),
    );
    return;
  }
  if (
    kind === "operation-result" &&
    frame.event.result.kind === "thread-rewound" &&
    frame.event.result.scope !== "files"
  ) {
    // As the conversation read does: a rewind removes the turns that started
    // from its first removed turn up to the rewind itself. Turns sent after
    // it are the thread's own again.
    const from = statements.codeTurnStart.get(
      at.threadId,
      String(frame.event.result.fromOperationId),
    ) as { readonly start_sequence: number } | undefined;
    if (from === undefined) return;
    const removed = statements.codeTurnsFrom.all(
      at.threadId,
      from.start_sequence,
      event.globalSequence,
    ) as ReadonlyArray<{ readonly turn_key: string }>;
    for (const row of removed) index.removeTurn("code", at.threadId, row.turn_key);
    return;
  }
  // Text before a turn started (an operation that is not a conversation
  // turn) is not part of any conversation the thread shows.
  if (!index.hasTurn(at)) return;
  if (kind === "provider-content") {
    if (frame.event.channel !== "message") return;
    index.appendStream(
      { ...at, field: "reply" },
      "reply",
      `seq:${event.globalSequence}`,
      readCodeEvidence(connection, frame.event.content),
      { whenFull: "stop", maxPieces: MAX_CODE_CONVERSATION_ASSISTANT_PARTS },
    );
    return;
  }
  if (kind === "terminal-output") {
    const terminal = `terminal:${String(frame.event.terminalId)}`;
    // A redraw replaces what the terminal showed.
    if (frame.event.replace) index.clearStream({ ...at, field: "tool" }, terminal);
    index.appendStream(
      { ...at, field: "tool" },
      terminal,
      `seq:${event.globalSequence}`,
      keepTail(readCodeEvidence(connection, frame.event.content)),
      { whenFull: "drop-oldest", maxPieces: MAX_THREAD_SEARCH_TERMINAL_PIECES },
    );
    return;
  }
  if (kind === "tool-activity") {
    index.putPart(
      { ...at, field: "tool" },
      `tool:${String(frame.event.toolCallId)}`,
      0,
      [frame.event.toolName, frame.event.summary ?? ""].join(" ").trim(),
    );
    return;
  }
}

/** Writes one event's changes; every document change goes through here. */
class SearchIndexWriter {
  readonly #connection: SqliteConnection;
  readonly #statements: Statements;
  readonly #sequence: number;

  constructor(connection: SqliteConnection, statements: Statements, sequence: number) {
    this.#connection = connection;
    this.#statements = statements;
    this.#sequence = sequence;
  }

  setTitle(mode: ThreadSearchMode, threadId: string, title: string): void {
    this.putPart({ mode, threadId, turnKey: "", anchorId: "", field: "title" }, "title", 0, title);
  }

  removeThread(mode: ThreadSearchMode, threadId: string): void {
    this.#statements.deleteThread.run(mode, threadId);
    this.#statements.deleteThreadParts.run(`${escapeLikePattern(`${mode}:${threadId}:`)}%`);
  }

  removeTurn(mode: ThreadSearchMode, threadId: string, turnKey: string): void {
    this.#statements.deleteTurn.run(mode, threadId, turnKey);
    this.#statements.deleteTurnParts.run(
      `${escapeLikePattern(`${mode}:${threadId}:${turnKey}:`)}%`,
    );
  }

  /**
   * A Canvas whose newest version names another thread than the one it was
   * filed under leaves the old thread, so it is never found where it no
   * longer belongs.
   */
  moveCanvas(turnKey: string, mode: ThreadSearchMode, threadId: string): void {
    const rows = this.#connection
      .prepare(
        `SELECT DISTINCT mode, thread_id FROM thread_search_document
         WHERE field = 'canvas' AND turn_key = ?`,
      )
      .all(turnKey) as ReadonlyArray<{
      readonly mode: ThreadSearchMode;
      readonly thread_id: string;
    }>;
    for (const row of rows) {
      if (row.mode !== mode || row.thread_id !== threadId) {
        this.removeTurn(row.mode, row.thread_id, turnKey);
      }
    }
  }

  /** The thread a Work turn was filed under when the index saw it accepted. */
  threadOfTurn(mode: ThreadSearchMode, turnKey: string): string | undefined {
    const row = this.#connection
      .prepare(
        `SELECT thread_id FROM thread_search_document
         WHERE mode = ? AND turn_key = ? AND field = 'prompt' LIMIT 1`,
      )
      .get(mode, turnKey) as { readonly thread_id: string } | undefined;
    return row?.thread_id;
  }

  hasTurn(at: Omit<DocumentIdentity, "field" | "sequence">): boolean {
    return this.#statements.readDocument.get(documentKey({ ...at, field: "prompt" })) !== undefined;
  }

  /**
   * Set one part's text and rejoin its document. A part that already holds
   * the text changes nothing, so a replayed event is a no-op.
   */
  putPart(
    at: Omit<DocumentIdentity, "sequence">,
    part: string,
    position: number,
    text: string,
  ): void {
    const docKey = documentKey(at);
    const partKey = `${docKey}:${part}`;
    const previous = this.#statements.readPart.get(partKey) as
      | { readonly body: string }
      | undefined;
    if (previous !== undefined && previous.body === text) return;
    this.#statements.upsertPart.run(partKey, docKey, at.threadId, position, text);
    this.#writeDocument({ ...at, sequence: this.#sequence }, docKey);
  }

  /**
   * Add one streamed piece as its own document, led in by the end of the
   * piece before it. A piece already added is not added again, so replay and
   * a repeated snapshot index each burst once, and no earlier piece is read
   * back or rewritten as the stream grows.
   */
  appendStream(
    at: Omit<DocumentIdentity, "sequence">,
    stream: string,
    piece: string,
    text: string,
    limits: { readonly whenFull: "stop" | "drop-oldest"; readonly maxPieces: number },
  ): void {
    if (text.length === 0) return;
    const streamKey = `${documentKey(at)}:${stream}`;
    const docKey = `${streamKey}:${piece}`;
    if (this.#statements.readDocument.get(docKey) !== undefined) return;
    const count = this.#statements.streamCount.get(streamKey) as { readonly pieces: number };
    if (count.pieces >= limits.maxPieces) {
      if (limits.whenFull === "stop") return;
      const oldest = this.#statements.streamOldest.get(streamKey) as
        | { readonly doc_key: string }
        | undefined;
      if (oldest !== undefined) this.#statements.deleteDocument.run(oldest.doc_key);
    }
    const previous = this.#statements.streamTail.get(streamKey) as
      | { readonly tail: string }
      | undefined;
    this.#statements.insertDocument.run(
      docKey,
      at.mode,
      at.threadId,
      at.turnKey,
      at.anchorId,
      at.field,
      streamKey,
      this.#sequence,
      (previous?.tail ?? "") + text,
    );
  }

  clearStream(at: Omit<DocumentIdentity, "sequence">, stream: string): void {
    this.#statements.deleteStream.run(`${documentKey(at)}:${stream}`);
  }

  addChatReply(at: Omit<DocumentIdentity, "field" | "sequence">, contentId: string): void {
    const content = readChatContent(this.#connection, contentId);
    // Research notes and snippets are the reply's own text as the thread shows it.
    this.appendStream(
      { ...at, field: "reply" },
      "reply",
      `content:${contentId}`,
      content?.body ?? "",
      {
        whenFull: "stop",
        maxPieces: Number.MAX_SAFE_INTEGER,
      },
    );
  }

  putChatToolSteps(
    at: Omit<DocumentIdentity, "field" | "sequence">,
    steps: ReadonlyArray<ThreadToolStep>,
  ): void {
    for (const step of steps) {
      this.putPart({ ...at, field: "tool" }, `tool:${step.toolCallId}`, 0, toolStepText(step));
    }
  }

  /** Remove the turns an edit superseded or a rewind took out of a Chat thread. */
  dropInactiveChatTurns(threadId: string): void {
    const active = new Set(readActiveChatTurnIds(this.#connection, threadId));
    const indexed = this.#statements.turnKeysOf.all("chat", threadId) as ReadonlyArray<{
      readonly turn_key: string;
    }>;
    for (const row of indexed) {
      if (!active.has(row.turn_key)) this.removeTurn("chat", threadId, row.turn_key);
    }
  }

  #writeDocument(at: DocumentIdentity, docKey: string): void {
    const parts = this.#statements.partsOf.all(docKey) as ReadonlyArray<{
      readonly body: string;
    }>;
    const separator = "\n";
    const body = clampDocument(at.field, parts.map((part) => part.body).join(separator));
    const existing = this.#statements.readDocument.get(docKey);
    if (existing === undefined) {
      this.#statements.insertDocument.run(
        docKey,
        at.mode,
        at.threadId,
        at.turnKey,
        at.anchorId,
        at.field,
        docKey,
        at.sequence,
        body,
      );
      return;
    }
    this.#statements.updateBody.run(body, docKey, body);
  }
}

function documentKey(at: Omit<DocumentIdentity, "sequence">): string {
  return at.field === "title"
    ? `${at.mode}:${at.threadId}:title`
    : `${at.mode}:${at.threadId}:${at.turnKey}:${at.field}`;
}

function clampDocument(field: ThreadSearchDocumentField, body: string): string {
  if (field === "tool") return keepTail(body);
  return body.length > MAX_THREAD_SEARCH_MESSAGE_TEXT
    ? body.slice(0, MAX_THREAD_SEARCH_MESSAGE_TEXT)
    : body;
}

function keepTail(text: string): string {
  return text.length > MAX_THREAD_SEARCH_TOOL_TEXT
    ? text.slice(text.length - MAX_THREAD_SEARCH_TOOL_TEXT)
    : text;
}

/**
 * The words a Canvas shows: the text, titles, labels and table cells of its
 * blocks, read by field name, never an id, URL, colour or number. Bounded,
 * so a very large Canvas keeps its first words.
 */
const CANVAS_TEXT_FIELDS = new Set([
  "text",
  "title",
  "subtitle",
  "label",
  "caption",
  "description",
  "heading",
  "name",
  "columns",
  "rows",
  "cells",
  "items",
  "nodes",
  "edges",
  "events",
  "entries",
  "series",
  "value",
  "summary",
  "detail",
]);

function canvasBlockText(blocks: unknown): ReadonlyArray<string> {
  const words: string[] = [];
  let length = 0;
  const visit = (value: unknown, readable: boolean): void => {
    if (length >= MAX_THREAD_SEARCH_MESSAGE_TEXT) return;
    if (typeof value === "string") {
      if (!readable || value.trim().length === 0) return;
      words.push(value);
      length += value.length + 1;
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, readable);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const [key, child] of Object.entries(value)) {
        // Only named text fields count, at any depth: a URL or colour nested
        // under a table row is never read as words.
        visit(child, CANVAS_TEXT_FIELDS.has(key));
      }
    }
  };
  visit(blocks, false);
  return words;
}

/**
 * The content an attempt's reply shows: its response pieces and, when it ran
 * research, the research notes, as the thread view and Chat's own message
 * search read them.
 */
function chatReplyRefs(attempt: {
  readonly responseRefs: ReadonlyArray<{ readonly contentId: unknown }>;
  readonly researchRef?: { readonly contentId: unknown } | undefined;
}): ReadonlyArray<{ readonly contentId: unknown }> {
  return attempt.researchRef === undefined
    ? attempt.responseRefs
    : [...attempt.responseRefs, attempt.researchRef];
}

function toolStepText(step: ThreadToolStep): string {
  return [step.toolName, step.summary ?? ""].join(" ").trim();
}

/**
 * The evidence text a reference names, or nothing when the row is gone or no
 * longer matches the reference: the conversation read shows no text then.
 */
function readCodeEvidence(connection: SqliteConnection, reference: CodeEvidenceReference): string {
  const row = connection
    .prepare(
      `SELECT body_text, digest, byte_length FROM code_evidence_content_store WHERE content_id = ?`,
    )
    .get(reference.contentId) as
    | { readonly body_text: string; readonly digest: string; readonly byte_length: number }
    | undefined;
  if (row === undefined) return "";
  if (row.digest !== reference.digest || row.byte_length !== reference.byteLength) return "";
  return row.body_text;
}

/** A thread the caller may see, as its mode lists it. */
export interface ThreadSearchVisibleThread {
  readonly mode: ThreadSearchMode;
  readonly threadId: string;
  readonly updatedAt: string;
}

export interface ThreadSearchMatch {
  readonly mode: ThreadSearchMode;
  readonly threadId: string;
  /** Empty for a title match. */
  readonly anchorId: string;
  readonly field: ThreadSearchDocumentField;
  /** On a `canvas` match, the Canvas's own title, which its document opens with. */
  readonly canvasTitle?: string;
  readonly snippet: string;
  readonly matchRanges: ReadonlyArray<{ readonly start: number; readonly end: number }>;
}

export interface ThreadSearchRows {
  readonly matches: ReadonlyArray<ThreadSearchMatch>;
  readonly truncated: boolean;
}

/** The full-text index matches runs of three characters or more; shorter terms are read. */
const TRIGRAM = 3;

/**
 * The caller's turns and titles that hold every term of the query. A turn
 * matches when each term appears somewhere in it (its prompt, any piece of its
 * reply, or what its tools did), and is shown once, by the document that holds
 * the most terms (a prompt before a reply before tool text on a tie). Title
 * matches come first, then message and Canvas matches, then tool matches, each newest
 * thread first and newest turn first within a thread. Listing authority is
 * applied in the query, before the cap, so `truncated` counts only matches
 * the caller may see.
 */
export function searchThreads(
  connection: SqliteConnection,
  query: string,
  visible: ReadonlyArray<ThreadSearchVisibleThread>,
  limit: number,
): ThreadSearchRows {
  const terms = parseSearchTerms(query);
  if (terms.length === 0 || limit <= 0 || visible.length === 0) {
    return { matches: [], truncated: false };
  }
  const parameters: Array<string | number> = [
    JSON.stringify(visible.map((thread) => [thread.mode, thread.threadId, thread.updatedAt])),
  ];
  const termHits = terms.map((term, index) => {
    if ([...term].length >= TRIGRAM) {
      parameters.push(`"${term.replaceAll('"', '""')}"`);
      return `
        SELECT thread_search_fts.rowid AS doc_id, ${index} AS term
        FROM thread_search_fts
        WHERE thread_search_fts MATCH ?`;
    }
    parameters.push(escapeLikePattern(term));
    return `
        SELECT document.doc_id, ${index} AS term
        FROM thread_search_document AS document
        INNER JOIN visible
          ON visible.mode = document.mode AND visible.thread_id = document.thread_id
        WHERE document.body LIKE '%' || ? || '%' ESCAPE '\\'`;
  });
  parameters.push(terms.length, limit + 1);
  const rows = connection
    .prepare(`
      WITH visible(mode, thread_id, updated_at) AS (
        SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]')
        FROM json_each(?)
      ),
      term_hits AS (${termHits.join("\n        UNION ALL")}
      ),
      documents AS (
        SELECT document.doc_id, document.mode, document.thread_id, document.turn_key,
          document.anchor_id, document.field, document.start_sequence, document.body,
          visible.updated_at, count(DISTINCT term_hits.term) AS terms,
          CASE document.field
            WHEN 'title' THEN 0 WHEN 'prompt' THEN 1 WHEN 'reply' THEN 2 WHEN 'canvas' THEN 3
            ELSE 4
          END AS field_rank
        FROM term_hits
        INNER JOIN thread_search_document AS document ON document.doc_id = term_hits.doc_id
        INNER JOIN visible
          ON visible.mode = document.mode AND visible.thread_id = document.thread_id
        GROUP BY document.doc_id
      ),
      turns AS (
        SELECT documents.mode, documents.thread_id, documents.turn_key
        FROM documents
        INNER JOIN term_hits ON term_hits.doc_id = documents.doc_id
        GROUP BY documents.mode, documents.thread_id, documents.turn_key
        HAVING count(DISTINCT term_hits.term) = ?
      ),
      ranked AS (
        SELECT documents.*, row_number() OVER (
          PARTITION BY documents.mode, documents.thread_id, documents.turn_key
          ORDER BY documents.terms DESC, documents.field_rank ASC, documents.start_sequence ASC
        ) AS turn_rank,
        max(documents.start_sequence) OVER (
          PARTITION BY documents.mode, documents.thread_id, documents.turn_key
        ) AS turn_sequence
        FROM documents
        INNER JOIN turns
          ON turns.mode = documents.mode
          AND turns.thread_id = documents.thread_id
          AND turns.turn_key = documents.turn_key
      )
      SELECT mode, thread_id, anchor_id, field, body
      FROM ranked
      WHERE turn_rank = 1
      ORDER BY
        CASE WHEN field_rank = 0 THEN 0 WHEN field_rank < 4 THEN 1 ELSE 2 END,
        updated_at DESC, mode ASC, thread_id ASC, turn_sequence DESC
      LIMIT ?
    `)
    .all(...parameters) as ReadonlyArray<{
    readonly mode: ThreadSearchMode;
    readonly thread_id: string;
    readonly anchor_id: string;
    readonly field: ThreadSearchDocumentField;
    readonly body: string;
  }>;
  return {
    truncated: rows.length > limit,
    matches: rows.slice(0, limit).map((row) => {
      const clipped = clipSearchSnippet(row.body, terms);
      return {
        mode: row.mode,
        threadId: row.thread_id,
        anchorId: row.anchor_id,
        field: row.field,
        ...(row.field === "canvas" ? { canvasTitle: row.body.split("\n", 1)[0] ?? "" } : {}),
        snippet: clipped.snippet,
        matchRanges: clipped.matchRanges,
      };
    }),
  };
}
