import {
  AGENT_ACCESS_EVENT_NAMES,
  AgentDirectKeyRotatedV1,
  AgentGrantChangedV1,
  AgentGrantCreatedV1,
  AgentGrantRevokedV1,
  AgentKeyEnrolledV1,
  AgentKeyRemovedV1,
  AgentThreadStartedV1,
  decodeAgentGrant,
  type AgentGrant,
  type AgentGrantMode,
  type AgentThreadAttribution,
  type EventEnvelope,
} from "@octant/contracts";
import { Schema } from "effect";
import type { Projection } from "./projection";
import type { SqliteConnection } from "./sqlitePort";

const decodeCreated = Schema.decodeUnknownSync(AgentGrantCreatedV1);
const decodeChanged = Schema.decodeUnknownSync(AgentGrantChangedV1);
const decodeEnrolled = Schema.decodeUnknownSync(AgentKeyEnrolledV1);
const decodeRemoved = Schema.decodeUnknownSync(AgentKeyRemovedV1);
const decodeRotated = Schema.decodeUnknownSync(AgentDirectKeyRotatedV1);
const decodeRevoked = Schema.decodeUnknownSync(AgentGrantRevokedV1);
const decodeThreadStarted = Schema.decodeUnknownSync(AgentThreadStartedV1);

/**
 * Agent grants as the journal records them, one whole row per grant, and the
 * threads each agent started. Each event rewrites the grant row from its prior
 * state, so replay lands on the same rows however often it runs. Bearer key
 * hashes are not here: they live in `agent_access_credential_store`.
 */
export class AgentAccessProjection implements Projection {
  readonly name = "agent-access";
  readonly dependencies: ReadonlyArray<string> = ["aggregate-heads"];

  reset(connection: SqliteConnection): void {
    connection.exec(
      `DELETE FROM agent_access_grant_projection; DELETE FROM agent_access_thread_projection;`,
    );
  }

  apply(connection: SqliteConnection, event: EventEnvelope): void {
    if (event.eventVersion !== 1) return;
    const name = String(event.eventName);
    if (name === AGENT_ACCESS_EVENT_NAMES.grantCreated) {
      const created = decodeCreated(event.payload);
      write(connection, event, {
        grantId: created.grantId,
        scopeId: created.scopeId,
        name: created.name,
        scope: created.scope,
        state: "active",
        generation: 1,
        keys: [],
        createdAt: created.createdAt,
        expiresAt: created.expiresAt,
      });
      return;
    }
    if (name === AGENT_ACCESS_EVENT_NAMES.threadStarted) {
      const started = decodeThreadStarted(event.payload);
      connection
        .prepare(
          `INSERT OR REPLACE INTO agent_access_thread_projection
             (thread_id, grant_id, mode, project_id, started_at, last_sequence)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          started.threadId,
          String(started.grantId),
          started.mode,
          started.projectId === undefined ? null : String(started.projectId),
          started.startedAt,
          event.globalSequence,
        );
      bumpVersion(connection, event, String(started.grantId));
      return;
    }
    const prior = readAgentGrant(connection, String(event.aggregateId));
    if (prior === undefined) return;
    if (name === AGENT_ACCESS_EVENT_NAMES.grantChanged) {
      const changed = decodeChanged(event.payload);
      write(connection, event, {
        ...prior,
        name: changed.name,
        scope: changed.scope,
        generation: changed.generation,
      });
    } else if (name === AGENT_ACCESS_EVENT_NAMES.keyEnrolled) {
      const enrolled = decodeEnrolled(event.payload);
      write(connection, event, {
        ...prior,
        keys: [
          ...prior.keys.filter((key) => key.fingerprint !== enrolled.key.fingerprint),
          enrolled.key,
        ],
      });
    } else if (name === AGENT_ACCESS_EVENT_NAMES.keyRemoved) {
      const removed = decodeRemoved(event.payload);
      write(connection, event, {
        ...prior,
        keys: prior.keys.filter((key) => key.fingerprint !== removed.fingerprint),
        generation: removed.generation,
      });
    } else if (name === AGENT_ACCESS_EVENT_NAMES.directKeyRotated) {
      const rotated = decodeRotated(event.payload);
      write(connection, event, { ...prior, generation: rotated.generation });
    } else if (name === AGENT_ACCESS_EVENT_NAMES.grantRevoked) {
      const revoked = decodeRevoked(event.payload);
      write(connection, event, {
        ...prior,
        state: "revoked",
        generation: revoked.generation,
        revokedAt: revoked.revokedAt,
      });
    }
  }
}

function write(connection: SqliteConnection, event: EventEnvelope, grant: AgentGrant): void {
  const decoded = decodeAgentGrant(grant);
  connection
    .prepare(
      `INSERT OR REPLACE INTO agent_access_grant_projection
         (grant_id, scope_id, state, grant_json, aggregate_version, last_sequence)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      String(decoded.grantId),
      String(decoded.scopeId),
      decoded.state,
      JSON.stringify(decoded),
      Number(event.aggregateVersion),
      event.globalSequence,
    );
}

function bumpVersion(connection: SqliteConnection, event: EventEnvelope, grantId: string): void {
  connection
    .prepare(
      `UPDATE agent_access_grant_projection SET aggregate_version = ?, last_sequence = ?
       WHERE grant_id = ?`,
    )
    .run(Number(event.aggregateVersion), event.globalSequence, grantId);
}

export interface AgentGrantRecord {
  readonly grant: AgentGrant;
  /** The grant aggregate's version, for the next append's expected version. */
  readonly version: number;
}

export function readAgentGrant(
  connection: SqliteConnection,
  grantId: string,
): AgentGrant | undefined {
  return readAgentGrantRecord(connection, grantId)?.grant;
}

export function readAgentGrantRecord(
  connection: SqliteConnection,
  grantId: string,
): AgentGrantRecord | undefined {
  const row = connection
    .prepare(
      `SELECT grant_json, aggregate_version FROM agent_access_grant_projection WHERE grant_id = ?`,
    )
    .get(grantId) as
    | { readonly grant_json: string; readonly aggregate_version: number }
    | undefined;
  return row === undefined
    ? undefined
    : { grant: decodeAgentGrant(JSON.parse(row.grant_json)), version: row.aggregate_version };
}

/** Every grant, newest first. */
export function readAgentGrants(connection: SqliteConnection): ReadonlyArray<AgentGrant> {
  const rows = connection
    .prepare(`SELECT grant_json FROM agent_access_grant_projection ORDER BY last_sequence DESC`)
    .all() as ReadonlyArray<{ readonly grant_json: string }>;
  return rows.map((row) => decodeAgentGrant(JSON.parse(row.grant_json)));
}

export interface AgentThreadRecord {
  readonly threadId: string;
  readonly grantId: string;
  readonly mode: AgentGrantMode;
  readonly projectId?: string;
  readonly startedAt: string;
}

/** The agent grant that started a thread, if any. */
export function readAgentThread(
  connection: SqliteConnection,
  threadId: string,
): AgentThreadRecord | undefined {
  const row = connection
    .prepare(
      `SELECT thread_id, grant_id, mode, project_id, started_at
       FROM agent_access_thread_projection WHERE thread_id = ?`,
    )
    .get(threadId) as ThreadRow | undefined;
  return row === undefined ? undefined : threadRecord(row);
}

/** The threads one grant started, newest first. */
export function readAgentThreads(
  connection: SqliteConnection,
  grantId: string,
): ReadonlyArray<AgentThreadRecord> {
  const rows = connection
    .prepare(
      `SELECT thread_id, grant_id, mode, project_id, started_at
       FROM agent_access_thread_projection WHERE grant_id = ? ORDER BY last_sequence DESC`,
    )
    .all(grantId) as ReadonlyArray<ThreadRow>;
  return rows.map(threadRecord);
}

interface ThreadRow {
  readonly thread_id: string;
  readonly grant_id: string;
  readonly mode: AgentGrantMode;
  readonly project_id: string | null;
  readonly started_at: string;
}

function threadRecord(row: ThreadRow): AgentThreadRecord {
  return {
    threadId: row.thread_id,
    grantId: row.grant_id,
    mode: row.mode,
    ...(row.project_id === null ? {} : { projectId: row.project_id }),
    startedAt: row.started_at,
  };
}

/**
 * Every thread an outside agent started, named by its grant as the grant reads
 * now, so a rename shows on its threads and a revoked grant's threads keep
 * their name.
 */
export function readAgentThreadAttributions(
  connection: SqliteConnection,
): ReadonlyArray<AgentThreadAttribution> {
  const rows = connection
    .prepare(
      `SELECT t.thread_id, t.grant_id, t.mode, g.grant_json
       FROM agent_access_thread_projection t
       JOIN agent_access_grant_projection g ON g.grant_id = t.grant_id
       ORDER BY t.last_sequence DESC`,
    )
    .all() as ReadonlyArray<{
    readonly thread_id: string;
    readonly grant_id: string;
    readonly mode: AgentGrantMode;
    readonly grant_json: string;
  }>;
  return rows.map((row) => {
    const grant = decodeAgentGrant(JSON.parse(row.grant_json));
    return {
      threadId: row.thread_id,
      grantId: grant.grantId,
      agentName: grant.name,
      mode: row.mode,
    };
  });
}

/** The name of the agent that started a thread, if one did. */
export function readAgentThreadName(
  connection: SqliteConnection,
  threadId: string,
): string | undefined {
  const thread = readAgentThread(connection, threadId);
  return thread === undefined ? undefined : readAgentGrant(connection, thread.grantId)?.name;
}
