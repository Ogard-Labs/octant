import { Schema } from "effect";
import {
  decodeAgentRunRequested,
  decodeAgentRunStatusChanged,
  decodeChatAttemptUpdated,
  decodeChatThreadCreated,
  decodeChatThreadUpdated,
  decodeCodeOperationEventFrame,
  decodeCodeThreadCreated,
  decodeCodeThreadUpdated,
  decodeWorkTurnUpdated,
  WorkThreadCreated,
  WorkThreadUpdated,
  type ActivityFinish,
  type ActivityKind,
  type ActivityRunSource,
  type OctantMode,
  type UtcTimestamp,
} from "@octant/contracts";
import {
  CODE_HOME_DELIVERY_OBSERVED,
  decodeActivityDeliveryObserved,
} from "@octant/contracts/code-home-activity";
import type { EventEnvelope } from "@octant/contracts";
import type { Projection } from "./projection";
import type { SqliteConnection } from "./sqlitePort";

const decodeWorkThreadCreated = Schema.decodeUnknownSync(WorkThreadCreated);
const decodeWorkThreadUpdated = Schema.decodeUnknownSync(WorkThreadUpdated);

// The only Code streaming frames the history reads; anything else is skipped
// before its payload is decoded, which keeps every streamed token frame out
// of schema work.
const CODE_HISTORY_FRAME_KINDS = new Set([
  "conversation-turn-started",
  "conversation-turn-stop-requested",
  "operation-state",
  "operation-result",
]);

function codeOperationFrameKind(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const inner = (payload as { readonly event?: unknown }).event;
  if (typeof inner !== "object" || inner === null) return undefined;
  const kind = (inner as { readonly kind?: unknown }).kind;
  return typeof kind === "string" ? kind : undefined;
}

/**
 * The oldest fact a card recorded, for coverage gates: a card that first
 * recorded after a comparison window ended has no coverage to compare.
 */
export function activityCoverageFrom(
  connection: SqliteConnection,
  kind: Exclude<ActivityKind, "releases-published">,
): string | null {
  const row = connection
    .prepare("SELECT MIN(occurred_at) AS earliest FROM code_home_activity_fact WHERE kind = ?")
    .get(kind) as { readonly earliest: string | null } | undefined;
  return row?.earliest ?? null;
}

/**
 * A derived projection whose apply once failed is held by `event_quarantine`:
 * it skips every later append, so its rows silently lag the journal. A read
 * must report that as unavailable rather than present stale facts as a true
 * total.
 */
export function activityHistoryHeld(connection: SqliteConnection): boolean {
  const row = connection
    .prepare("SELECT 1 FROM event_quarantine WHERE projection_name = 'activity-history' LIMIT 1")
    .get();
  return row !== undefined;
}

export interface ActivityFact {
  readonly identity: string;
  readonly occurredAt: string;
  readonly threadId: string;
  readonly projectId: string | null;
  readonly metadataJson: string;
}

/**
 * Stateless read of normalized activity facts: every fact inside `[from, until)`,
 * newest first with a stable tiebreak. A null `from` means unbounded below.
 * Authorization and paging are layered on by the window's own read path; this
 * is the whole journal's normalized facts and must not be exposed directly.
 */
export function readActivityFacts(
  connection: SqliteConnection,
  input: {
    readonly kind: Exclude<ActivityKind, "releases-published">;
    readonly from: UtcTimestamp | null;
    readonly until: UtcTimestamp;
  },
): ReadonlyArray<ActivityFact> {
  const rows = connection
    .prepare(
      `SELECT identity, occurred_at, thread_id, project_id, metadata_json
       FROM code_home_activity_fact
       WHERE kind = ?
         AND (? IS NULL OR occurred_at >= ?)
         AND occurred_at < ?
       ORDER BY occurred_at DESC, identity ASC, thread_id ASC`,
    )
    .all(input.kind, input.from, input.from, input.until) as ReadonlyArray<{
    readonly identity: string;
    readonly occurred_at: string;
    readonly thread_id: string;
    readonly project_id: string | null;
    readonly metadata_json: string;
  }>;
  return rows.map((row) => ({
    identity: row.identity,
    occurredAt: row.occurred_at,
    threadId: row.thread_id,
    projectId: row.project_id,
    metadataJson: row.metadata_json,
  }));
}

interface RunRow {
  readonly source: ActivityRunSource;
  readonly run_id: string;
  readonly execution: string;
  readonly thread_id: string | null;
  readonly project_id: string | null;
  readonly mode: OctantMode | null;
  readonly terminal_finish: ActivityFinish | null;
  readonly terminal_at: string | null;
  readonly stop_requested: number;
}

const canonical = (timestamp: string): string => new Date(timestamp).toISOString();

const RUN_FINISHES: Readonly<Record<string, ActivityFinish | undefined>> = {
  completed: "successful",
  cancelled: "canceled",
  failed: "failed",
  interrupted: "failed",
};

/**
 * Normalized Code Home activity history from the server-local journal: one
 * durable row per confirmed delivery witness and per settled run. Derived
 * only — nothing authoritative reads it, so a failed apply quarantines this
 * projection rather than rolling the append back.
 */
export class ActivityHistoryProjection implements Projection {
  readonly name = "activity-history";
  readonly dependencies: ReadonlyArray<string> = ["aggregate-heads"];
  readonly derived = true;
  readonly aggregateTypes: ReadonlyArray<string> = [
    "chat-thread",
    "code-thread",
    "work-thread",
    "code-operation",
    "agent-run",
    "code-home-activity",
  ];

  reset(connection: SqliteConnection): void {
    connection.exec(`
      DELETE FROM code_home_activity_fact;
      DELETE FROM code_home_activity_run;
      DELETE FROM code_home_activity_thread;
    `);
  }

  apply(connection: SqliteConnection, event: EventEnvelope): void {
    switch (event.eventName) {
      case CODE_HOME_DELIVERY_OBSERVED:
        this.#deliveryObserved(connection, decodeActivityDeliveryObserved(event.payload));
        return;
      case "chat.thread-created@1": {
        const thread = decodeChatThreadCreated(event.payload).thread;
        this.#threadSeen(connection, "chat", thread.id, thread.projectId ?? null);
        return;
      }
      case "chat.thread-updated@1": {
        const thread = decodeChatThreadUpdated(event.payload).thread;
        this.#threadSeen(connection, "chat", thread.id, thread.projectId ?? null);
        return;
      }
      case "code.thread-created@1": {
        const thread = decodeCodeThreadCreated(event.payload).thread;
        this.#threadSeen(connection, "code", thread.id, thread.projectId);
        return;
      }
      case "code.thread-updated@1": {
        const thread = decodeCodeThreadUpdated(event.payload).thread;
        this.#threadSeen(connection, "code", thread.id, thread.projectId);
        return;
      }
      case "work.thread-created@1": {
        const thread = decodeWorkThreadCreated(event.payload).thread;
        this.#threadSeen(connection, "work", thread.id, thread.projectId);
        return;
      }
      case "work.thread-updated@1": {
        const thread = decodeWorkThreadUpdated(event.payload).thread;
        this.#threadSeen(connection, "work", thread.id, thread.projectId);
        return;
      }
      case "code.operation-event-recorded@1": {
        const kind = codeOperationFrameKind(event.payload);
        if (kind === undefined || !CODE_HISTORY_FRAME_KINDS.has(kind)) return;
        this.#codeOperation(connection, decodeCodeOperationEventFrame(event.payload));
        return;
      }
      case "chat.attempt-updated@1":
        this.#chatAttempt(connection, decodeChatAttemptUpdated(event.payload).attempt);
        return;
      case "work.turn-updated@1":
        this.#workTurn(connection, decodeWorkTurnUpdated(event.payload));
        return;
      case "agent.run-requested@1":
        this.#agentRunRequested(connection, decodeAgentRunRequested(event.payload).run);
        return;
      case "agent.run-status-changed@1":
        this.#agentRunStatus(
          connection,
          decodeAgentRunStatusChanged(event.payload),
          event.occurredAt,
        );
        return;
      default:
        return;
    }
  }

  #threadSeen(
    connection: SqliteConnection,
    mode: OctantMode,
    threadId: string,
    projectId: string | null,
  ): void {
    connection
      .prepare(
        `INSERT INTO code_home_activity_thread (mode, thread_id, project_id)
         VALUES (?, ?, ?)
         ON CONFLICT (mode, thread_id) DO UPDATE SET project_id = excluded.project_id`,
      )
      .run(mode, threadId, projectId);
  }

  #threadProject(
    connection: SqliteConnection,
    mode: OctantMode,
    threadId: string,
  ): string | null | undefined {
    const row = connection
      .prepare("SELECT project_id FROM code_home_activity_thread WHERE mode = ? AND thread_id = ?")
      .get(mode, threadId) as { readonly project_id: string | null } | undefined;
    return row?.project_id;
  }

  #deliveryObserved(
    connection: SqliteConnection,
    observation: ReturnType<typeof decodeActivityDeliveryObserved>,
  ): void {
    const identity = `${observation.repositoryOwner.toLowerCase()}/${observation.repositoryName.toLowerCase()}#${observation.number}`;
    const metadata =
      observation.kind === "prs-merged"
        ? {
            repositoryOwner: observation.repositoryOwner,
            repositoryName: observation.repositoryName,
            number: observation.number,
            ...(observation.title === undefined ? {} : { title: observation.title }),
            mergedBy: observation.mergedBy,
          }
        : {
            repositoryOwner: observation.repositoryOwner,
            repositoryName: observation.repositoryName,
            number: observation.number,
            ...(observation.title === undefined ? {} : { title: observation.title }),
            closingPullRequest: observation.closingPullRequest,
          };
    this.#insertFact(connection, {
      kind: observation.kind,
      identity,
      occurredAt: canonical(observation.occurredAt),
      threadId: observation.threadId,
      projectId: observation.projectId,
      metadata,
    });
  }

  #codeOperation(
    connection: SqliteConnection,
    frame: ReturnType<typeof decodeCodeOperationEventFrame>,
  ): void {
    const runId = frame.operationId;
    if (frame.event.kind === "conversation-turn-started") {
      const state = this.#run(connection, "code", runId);
      if (state !== undefined && state.terminal_finish !== null)
        this.#deleteTerminalFact(connection, state);
      this.#saveRun(connection, {
        source: "code",
        run_id: runId,
        execution: String(frame.cursor),
        thread_id: frame.threadId,
        project_id: this.#threadProject(connection, "code", frame.threadId) ?? null,
        mode: "code",
        terminal_finish: null,
        terminal_at: null,
        stop_requested: 0,
      });
      return;
    }
    if (frame.event.kind === "conversation-turn-stop-requested") {
      const stopped = this.#run(connection, "code", runId);
      if (stopped !== undefined && stopped.stop_requested !== 1)
        this.#saveRun(connection, { ...stopped, stop_requested: 1 });
      return;
    }
    const state = this.#run(connection, "code", runId);
    if (state === undefined) return; // Not a journaled conversation turn.
    let outcome: "running" | "waiting" | "completed" | "interrupted" | "failed" | undefined;
    if (frame.event.kind === "operation-state") {
      outcome = frame.event.state;
    } else if (frame.event.kind === "operation-result") {
      if (frame.event.result.kind === "provider-turn-state") {
        outcome = frame.event.result.state;
      } else if (frame.event.result.kind === "operation-failed") {
        outcome = "failed";
      }
    }
    if (outcome === undefined) return;
    if (outcome === "running" || outcome === "waiting") {
      if (state.terminal_finish !== null) this.#clearTerminal(connection, state);
      return;
    }
    if (state.terminal_finish !== null) return;
    // Only a journeled `conversation-turn-stop-requested` makes `interrupted`
    // the person's cancellation; an unsolicited one (restart, runtime loss)
    // stays a failure, and the marker never softens a completed turn.
    const finish: ActivityFinish =
      outcome === "completed"
        ? "successful"
        : outcome === "interrupted" && state.stop_requested === 1
          ? "canceled"
          : "failed";
    this.#recordTerminal(connection, state, finish, canonical(frame.occurredAt));
  }

  #chatAttempt(
    connection: SqliteConnection,
    attempt: ReturnType<typeof decodeChatAttemptUpdated>["attempt"],
  ): void {
    const finish = RUN_FINISHES[attempt.outcome];
    this.#settleRun(connection, {
      source: "chat",
      runId: attempt.turnId,
      execution: attempt.id,
      threadId: attempt.threadId,
      projectId: this.#threadProject(connection, "chat", attempt.threadId) ?? null,
      mode: "chat",
      occurredAt: attempt.updatedAt,
      finish,
    });
  }

  #workTurn(connection: SqliteConnection, update: ReturnType<typeof decodeWorkTurnUpdated>): void {
    if (update.carried === true) return;
    const finish = RUN_FINISHES[update.status];
    this.#settleRun(connection, {
      source: "work",
      runId: update.turnId,
      execution: update.requestId,
      threadId: update.threadId,
      projectId: this.#threadProject(connection, "work", update.threadId) ?? null,
      mode: "work",
      occurredAt: update.updatedAt,
      finish,
    });
  }

  #agentRunRequested(
    connection: SqliteConnection,
    run: ReturnType<typeof decodeAgentRunRequested>["run"],
  ): void {
    const workspaceProject =
      "projectId" in run.workspaceReceipt ? run.workspaceReceipt.projectId : undefined;
    const projectId =
      run.routingReceipt.projectId ??
      workspaceProject ??
      this.#threadProject(connection, run.routingReceipt.mode, run.parentThreadId) ??
      null;
    this.#saveRun(connection, {
      source: "agent-run",
      run_id: run.id,
      execution: String(run.generation ?? 1),
      thread_id: run.parentThreadId,
      project_id: projectId,
      mode: run.routingReceipt.mode,
      terminal_finish: null,
      terminal_at: null,
      stop_requested: 0,
    });
  }

  #agentRunStatus(
    connection: SqliteConnection,
    changed: ReturnType<typeof decodeAgentRunStatusChanged>,
    occurredAt: string,
  ): void {
    const finish = RUN_FINISHES[changed.toStatus];
    this.#settleRun(connection, {
      source: "agent-run",
      runId: changed.runId,
      execution: String(changed.generation ?? 1),
      occurredAt,
      finish,
    });
  }

  /**
   * Settles one journaled run status: a new execution (fresh attempt,
   * generation, or request) or a nonterminal restatement after a terminal
   * clears the old finish on an actual rerun, and the first explicit terminal
   * of an execution records the one fact. Restated terminals never move the
   * recorded finish time.
   */
  #settleRun(
    connection: SqliteConnection,
    input: {
      readonly source: ActivityRunSource;
      readonly runId: string;
      readonly execution: string;
      readonly threadId?: string;
      readonly projectId?: string | null;
      readonly mode?: OctantMode;
      readonly occurredAt: string;
      readonly finish: ActivityFinish | undefined;
    },
  ): void {
    let state = this.#run(connection, input.source, input.runId);
    if (state !== undefined && state.execution !== input.execution) {
      this.#deleteTerminalFact(connection, state);
      this.#saveRun(connection, {
        ...state,
        execution: input.execution,
        terminal_finish: null,
        terminal_at: null,
        stop_requested: 0,
      });
      state = this.#run(connection, input.source, input.runId);
    }
    const merged: RunRow = {
      source: input.source,
      run_id: input.runId,
      execution: input.execution,
      thread_id: input.threadId ?? state?.thread_id ?? null,
      project_id: input.projectId === undefined ? (state?.project_id ?? null) : input.projectId,
      mode: input.mode ?? state?.mode ?? null,
      terminal_finish: state?.terminal_finish ?? null,
      terminal_at: state?.terminal_at ?? null,
      stop_requested: state?.stop_requested ?? 0,
    };
    this.#saveRun(connection, merged);
    if (input.finish === undefined) {
      if (merged.terminal_finish !== null) this.#clearTerminal(connection, merged);
      return;
    }
    if (merged.terminal_finish !== null) return;
    this.#recordTerminal(connection, merged, input.finish, canonical(input.occurredAt));
  }

  #run(connection: SqliteConnection, source: ActivityRunSource, runId: string): RunRow | undefined {
    return connection
      .prepare("SELECT * FROM code_home_activity_run WHERE source = ? AND run_id = ?")
      .get(source, runId) as RunRow | undefined;
  }

  #saveRun(connection: SqliteConnection, row: RunRow): void {
    connection
      .prepare(
        `INSERT INTO code_home_activity_run
           (source, run_id, execution, thread_id, project_id, mode, terminal_finish, terminal_at, stop_requested)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (source, run_id) DO UPDATE SET
           execution = excluded.execution,
           thread_id = excluded.thread_id,
           project_id = excluded.project_id,
           mode = excluded.mode,
           terminal_finish = excluded.terminal_finish,
           terminal_at = excluded.terminal_at,
           stop_requested = excluded.stop_requested`,
      )
      .run(
        row.source,
        row.run_id,
        row.execution,
        row.thread_id,
        row.project_id,
        row.mode,
        row.terminal_finish,
        row.terminal_at,
        row.stop_requested,
      );
  }

  #recordTerminal(
    connection: SqliteConnection,
    state: RunRow,
    finish: ActivityFinish,
    occurredAt: string,
  ): void {
    if (state.thread_id === null) return;
    this.#insertFact(connection, {
      kind: "runs",
      identity: `${state.source}:${state.run_id}`,
      occurredAt,
      threadId: state.thread_id,
      projectId: state.project_id,
      metadata: {
        source: state.source,
        runId: state.run_id,
        finish,
        mode: state.mode ?? state.source,
      },
    });
    this.#saveRun(connection, { ...state, terminal_finish: finish, terminal_at: occurredAt });
  }

  #clearTerminal(connection: SqliteConnection, state: RunRow): void {
    this.#deleteTerminalFact(connection, state);
    this.#saveRun(connection, { ...state, terminal_finish: null, terminal_at: null });
  }

  #deleteTerminalFact(connection: SqliteConnection, state: RunRow): void {
    if (state.terminal_at === null || state.thread_id === null) return;
    connection
      .prepare(
        `DELETE FROM code_home_activity_fact
         WHERE kind = 'runs' AND identity = ? AND occurred_at = ? AND thread_id = ?`,
      )
      .run(`${state.source}:${state.run_id}`, state.terminal_at, state.thread_id);
  }

  #insertFact(
    connection: SqliteConnection,
    fact: {
      readonly kind: ActivityKind;
      readonly identity: string;
      readonly occurredAt: string;
      readonly threadId: string;
      readonly projectId: string | null;
      readonly metadata: unknown;
    },
  ): void {
    connection
      .prepare(
        `INSERT OR IGNORE INTO code_home_activity_fact
           (kind, identity, occurred_at, thread_id, project_id, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fact.kind,
        fact.identity,
        fact.occurredAt,
        fact.threadId,
        fact.projectId,
        JSON.stringify(fact.metadata),
      );
  }
}
