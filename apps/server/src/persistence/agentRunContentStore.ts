import {
  decodeAgentRunAdmittedContext,
  decodeAgentRunResultText,
  decodeContextSubjectRef,
  type AgentRun,
  type AgentRunAdmittedContext,
  type AgentRunContextSnapshotId,
  type AgentRunId,
  type ContextSubjectRef,
} from "@octant/contracts";
import type { SqliteConnection } from "./sqlitePort";

/**
 * Text an AgentRun derived from the thread it was created under, owned by that
 * thread.
 *
 * Two pieces qualify: the parent-thread selection a child was admitted with,
 * and the reply the child produced about it. Both are the parent thread's
 * content, so neither may live in the journal — a permanent thread deletion has
 * to destroy them, and the journal keeps only non-content identity, provenance,
 * and tombstones.
 *
 * This is a store rather than a projection: no event carries the text, so a
 * rebuild must not clear what no replay can restore, and a subject purge must
 * be able to remove it for good.
 */
export interface AgentRunContentStoreRow {
  /**
   * The admission's `contextSnapshotId` or the completion's result reference —
   * the same stable identity the journaled event records, so a reader resolves
   * text against the very record the event names.
   */
  readonly content_id: string;
  readonly run_id: string;
  readonly subject_type: string;
  readonly subject_id: string;
  readonly content_kind: string;
  readonly body_text: string;
  readonly created_at: string;
}

const ADMITTED_CONTEXT_KIND = "admitted-context";
const RESULT_KIND = "result";

/**
 * The thread that owns an AgentRun's derived text.
 *
 * Every run in a hierarchy records the same `parentThreadId` — admission
 * refuses a nested child whose parent run belongs to another thread — so one
 * subject covers a whole child tree. The aggregate type comes from the run's
 * own immutable mode, because that thread is a Chat, Work, or Code thread
 * depending on where the child was created: keying this store on a bare thread
 * id would leave every non-Chat subject silently unreachable by its own purge.
 */
export function agentRunContentSubject(run: AgentRun): ContextSubjectRef {
  const aggregateType =
    run.routingReceipt.mode === "chat"
      ? "chat-thread"
      : run.routingReceipt.mode === "code"
        ? "code-thread"
        : "work-thread";
  return decodeContextSubjectRef({
    aggregateType,
    aggregateId: String(run.parentThreadId),
  });
}

function write(
  connection: SqliteConnection,
  input: {
    readonly contentId: string;
    readonly runId: string;
    readonly subject: ContextSubjectRef;
    readonly contentKind: string;
    readonly bodyText: string;
    readonly createdAt: string;
  },
): void {
  connection
    .prepare(`
      INSERT INTO agent_run_content_store (
        content_id, run_id, subject_type, subject_id, content_kind, body_text, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      input.contentId,
      input.runId,
      input.subject.aggregateType,
      input.subject.aggregateId,
      input.contentKind,
      input.bodyText,
      input.createdAt,
    );
}

function read(
  connection: SqliteConnection,
  contentId: string,
  runId: string,
  contentKind: string,
): string | undefined {
  const row = connection
    .prepare(
      "SELECT * FROM agent_run_content_store WHERE content_id = ? AND run_id = ? AND content_kind = ?",
    )
    .get(contentId, runId, contentKind) as AgentRunContentStoreRow | undefined;
  return row?.body_text;
}

/**
 * Records the parent-thread selection a child was admitted with, under the
 * admission's own snapshot id. Callers write it in the same transaction as the
 * `agent.run-requested@1` event, so the selection and the receipt that names it
 * commit together or not at all.
 *
 * The blocks are decoded here because this is the boundary they cross: an
 * over-limit selection is refused before anything is stored, which rolls the
 * whole admission back.
 */
export function writeAgentRunAdmittedContext(
  connection: SqliteConnection,
  input: {
    readonly run: AgentRun;
    readonly blocks: AgentRunAdmittedContext;
    readonly createdAt: string;
  },
): void {
  write(connection, {
    contentId: String(input.run.routingReceipt.contextSnapshotId),
    runId: String(input.run.id),
    subject: agentRunContentSubject(input.run),
    contentKind: ADMITTED_CONTEXT_KIND,
    bodyText: JSON.stringify(decodeAgentRunAdmittedContext(input.blocks)),
    createdAt: input.createdAt,
  });
}

/**
 * Returns the selection admitted under a snapshot id, or `undefined` once the
 * parent thread's content has been purged.
 *
 * The lookup binds both the snapshot id and the run, so a snapshot id another
 * run recorded resolves to nothing: the record that holds the blocks is keyed
 * by the very id execution verifies against, and by the run it authorized.
 */
export function readAgentRunAdmittedContext(
  connection: SqliteConnection,
  input: {
    readonly runId: AgentRunId;
    readonly contextSnapshotId: AgentRunContextSnapshotId;
  },
): AgentRunAdmittedContext | undefined {
  const bodyText = read(
    connection,
    String(input.contextSnapshotId),
    String(input.runId),
    ADMITTED_CONTEXT_KIND,
  );
  if (bodyText === undefined) return undefined;
  return decodeAgentRunAdmittedContext(JSON.parse(bodyText));
}

/**
 * Records a completed child's reply under the completion's own result
 * reference, in the same transaction as `agent.run-status-changed@1`, so a
 * journal that records Completed always has the reply that completion claims.
 */
export function writeAgentRunResultText(
  connection: SqliteConnection,
  input: {
    readonly run: AgentRun;
    readonly reference: string;
    readonly text: string;
    readonly createdAt: string;
  },
): void {
  write(connection, {
    contentId: input.reference,
    runId: String(input.run.id),
    subject: agentRunContentSubject(input.run),
    contentKind: RESULT_KIND,
    bodyText: decodeAgentRunResultText(input.text),
    createdAt: input.createdAt,
  });
}

/**
 * Returns a completed child's reply, or `undefined` once the parent thread's
 * content has been purged. A reader that holds the result identity but gets no
 * text is told the reply is gone rather than handed an empty one.
 */
export function readAgentRunResultText(
  connection: SqliteConnection,
  input: { readonly runId: AgentRunId; readonly reference: string },
): string | undefined {
  return read(connection, input.reference, String(input.runId), RESULT_KIND);
}

/** Removes every AgentRun text a subject's own conversation produced. */
export function purgeAgentRunSubjectContent(
  connection: SqliteConnection,
  subject: ContextSubjectRef,
): void {
  connection
    .prepare("DELETE FROM agent_run_content_store WHERE subject_type = ? AND subject_id = ?")
    .run(subject.aggregateType, subject.aggregateId);
}
