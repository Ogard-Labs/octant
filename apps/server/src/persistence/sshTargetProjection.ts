import { Schema } from "effect";
import type { EventEnvelope } from "@octant/contracts/events";
import { SshRemoteProject, SshRemoteWorktree } from "@octant/contracts/ssh-remote-project";
import { SshRuntimeBinary, SshTarget } from "@octant/contracts/ssh-target";
import {
  SSH_REMOTE_PROJECT_AGGREGATE,
  SSH_REMOTE_PROJECT_EVENT_NAMES,
  SSH_REMOTE_TERMINAL_AGGREGATE,
  SSH_REMOTE_TERMINAL_EVENT_NAMES,
  SSH_REMOTE_WORKTREE_AGGREGATE,
  SSH_REMOTE_WORKTREE_EVENT_NAMES,
  SSH_TARGET_AGGREGATE,
  SSH_TARGET_EVENT_NAMES,
  SshTargetAttested,
  decodeSshRemoteProjectBound,
  decodeSshRemoteTerminalEnded,
  decodeSshRemoteTerminalStarted,
  decodeSshRemoteWorktreeCreated,
  decodeSshRemoteWorktreeRemoved,
  decodeSshTargetAttested,
  decodeSshTargetRegistered,
  decodeSshTargetRemoved,
  decodeSshTargetRepinned,
  decodeSshTargetRuntimeBinarySet,
} from "@octant/contracts/ssh-target-events";
import type { Projection } from "./projection";
import type { SqliteConnection } from "./sqlitePort";

export const SSH_TARGET_PROJECTION = "ssh-targets";

/**
 * SSH targets and the Code Projects bound to their folders, rebuilt from the
 * journal. Canonical: docs/design/remote-ssh-environments.md § Data placement
 * and lifecycle.
 *
 * A removed target's row is deleted, so nothing can connect to it again; the
 * Projects bound to it keep their rows, and their reads refuse
 * `target-removed`. Each target keeps the last attestation this host
 * journaled for it, which explains a refusal after the connection is gone; it
 * never admits anything, because admission needs the live connection's own.
 */
export class SshTargetProjection implements Projection {
  readonly name = SSH_TARGET_PROJECTION;
  readonly dependencies: ReadonlyArray<string> = ["aggregate-heads"];

  reset(connection: SqliteConnection): void {
    connection.exec(`
      DELETE FROM ssh_target_projection;
      DELETE FROM ssh_target_runtime_binary_projection;
      DELETE FROM ssh_remote_project_projection;
      DELETE FROM ssh_remote_worktree_projection;
      DELETE FROM ssh_remote_terminal_projection;
    `);
  }

  apply(connection: SqliteConnection, event: EventEnvelope): void {
    if (event.eventVersion !== 1) return;
    if (event.aggregateType === SSH_TARGET_AGGREGATE) applyTargetEvent(connection, event);
    else if (event.aggregateType === SSH_REMOTE_PROJECT_AGGREGATE) {
      applyRemoteProjectEvent(connection, event);
    } else if (event.aggregateType === SSH_REMOTE_WORKTREE_AGGREGATE) {
      applyWorktreeEvent(connection, event);
    } else if (event.aggregateType === SSH_REMOTE_TERMINAL_AGGREGATE) {
      applyTerminalEvent(connection, event);
    }
  }
}

/**
 * A removed worktree's row is deleted: the journal keeps its history, and
 * nothing can open a terminal in it or read it again.
 */
function applyWorktreeEvent(connection: SqliteConnection, event: EventEnvelope): void {
  const aggregateId = String(event.aggregateId);
  if (event.eventName === SSH_REMOTE_WORKTREE_EVENT_NAMES.created) {
    const { worktree } = decodeSshRemoteWorktreeCreated(event.payload);
    assertAggregate(String(worktree.id), aggregateId);
    connection
      .prepare(
        `INSERT INTO ssh_remote_worktree_projection (
          worktree_id, project_id, worktree_json, aggregate_version, last_sequence
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (worktree_id) DO NOTHING`,
      )
      .run(
        aggregateId,
        String(worktree.projectId),
        JSON.stringify(Schema.encodeSync(SshRemoteWorktree)(worktree)),
        event.aggregateVersion,
        event.globalSequence,
      );
    return;
  }
  if (event.eventName === SSH_REMOTE_WORKTREE_EVENT_NAMES.removed) {
    const { worktreeId } = decodeSshRemoteWorktreeRemoved(event.payload);
    assertAggregate(String(worktreeId), aggregateId);
    connection
      .prepare("DELETE FROM ssh_remote_worktree_projection WHERE worktree_id = ?")
      .run(aggregateId);
  }
}

/** Which remote terminals the journal still records as running, for restart. */
function applyTerminalEvent(connection: SqliteConnection, event: EventEnvelope): void {
  const aggregateId = String(event.aggregateId);
  if (event.eventName === SSH_REMOTE_TERMINAL_EVENT_NAMES.started) {
    const started = decodeSshRemoteTerminalStarted(event.payload);
    assertAggregate(String(started.terminalId), aggregateId);
    connection
      .prepare(
        `INSERT INTO ssh_remote_terminal_projection (
          terminal_id, project_id, state, aggregate_version, last_sequence
        ) VALUES (?, ?, 'running', ?, ?)
        ON CONFLICT (terminal_id) DO NOTHING`,
      )
      .run(aggregateId, String(started.projectId), event.aggregateVersion, event.globalSequence);
    return;
  }
  if (event.eventName === SSH_REMOTE_TERMINAL_EVENT_NAMES.ended) {
    const ended = decodeSshRemoteTerminalEnded(event.payload);
    assertAggregate(String(ended.terminalId), aggregateId);
    connection
      .prepare(
        `UPDATE ssh_remote_terminal_projection
         SET state = 'ended', aggregate_version = ?, last_sequence = ?
         WHERE terminal_id = ? AND aggregate_version < ?`,
      )
      .run(event.aggregateVersion, event.globalSequence, aggregateId, event.aggregateVersion);
  }
}

function applyTargetEvent(connection: SqliteConnection, event: EventEnvelope): void {
  const aggregateId = String(event.aggregateId);
  switch (event.eventName) {
    case SSH_TARGET_EVENT_NAMES.registered: {
      const { target } = decodeSshTargetRegistered(event.payload);
      assertAggregate(String(target.id), aggregateId);
      connection
        .prepare(
          `INSERT INTO ssh_target_projection (
            target_id, target_json, registered_at, attestation_json, attested_at,
            aggregate_version, last_sequence
          ) VALUES (?, ?, ?, NULL, NULL, ?, ?)
          ON CONFLICT (target_id) DO UPDATE SET
            target_json = excluded.target_json,
            registered_at = excluded.registered_at,
            aggregate_version = excluded.aggregate_version,
            last_sequence = excluded.last_sequence
          WHERE excluded.aggregate_version > ssh_target_projection.aggregate_version`,
        )
        .run(
          aggregateId,
          JSON.stringify(Schema.encodeSync(SshTarget)(target)),
          String(event.occurredAt),
          event.aggregateVersion,
          event.globalSequence,
        );
      return;
    }
    case SSH_TARGET_EVENT_NAMES.repinned: {
      const { targetId, hostKey } = decodeSshTargetRepinned(event.payload);
      assertAggregate(String(targetId), aggregateId);
      const current = readTargetRow(connection, aggregateId);
      if (current === undefined) return;
      const target: SshTarget = { ...decodeTargetJson(current.target_json), hostKey };
      updateTarget(connection, event, "target_json = ?", [
        JSON.stringify(Schema.encodeSync(SshTarget)(target)),
      ]);
      return;
    }
    case SSH_TARGET_EVENT_NAMES.attested: {
      const attested = decodeSshTargetAttested(event.payload);
      assertAggregate(String(attested.targetId), aggregateId);
      updateTarget(connection, event, "attestation_json = ?, attested_at = ?", [
        JSON.stringify(Schema.encodeSync(SshTargetAttested)(attested)),
        String(event.occurredAt),
      ]);
      return;
    }
    case SSH_TARGET_EVENT_NAMES.removed: {
      const { targetId } = decodeSshTargetRemoved(event.payload);
      assertAggregate(String(targetId), aggregateId);
      connection.prepare("DELETE FROM ssh_target_projection WHERE target_id = ?").run(aggregateId);
      // A runtime path is the target's; a target registered again later starts without one.
      connection
        .prepare("DELETE FROM ssh_target_runtime_binary_projection WHERE target_id = ?")
        .run(aggregateId);
      return;
    }
    case SSH_TARGET_EVENT_NAMES.runtimeBinarySet: {
      const set = decodeSshTargetRuntimeBinarySet(event.payload);
      assertAggregate(String(set.targetId), aggregateId);
      if (readTargetRow(connection, aggregateId) === undefined) return;
      connection
        .prepare(
          `INSERT INTO ssh_target_runtime_binary_projection (
            target_id, provider_instance_id, path, aggregate_version, last_sequence
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (target_id, provider_instance_id) DO UPDATE SET
            path = excluded.path,
            aggregate_version = excluded.aggregate_version,
            last_sequence = excluded.last_sequence
          WHERE excluded.aggregate_version > ssh_target_runtime_binary_projection.aggregate_version`,
        )
        .run(
          aggregateId,
          String(set.providerInstanceId),
          set.path,
          event.aggregateVersion,
          event.globalSequence,
        );
      return;
    }
  }
}

function applyRemoteProjectEvent(connection: SqliteConnection, event: EventEnvelope): void {
  if (event.eventName !== SSH_REMOTE_PROJECT_EVENT_NAMES.bound) return;
  const { project } = decodeSshRemoteProjectBound(event.payload);
  assertAggregate(String(project.id), String(event.aggregateId));
  connection
    .prepare(
      `INSERT INTO ssh_remote_project_projection (
        project_id, target_id, project_json, aggregate_version, last_sequence
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (project_id) DO UPDATE SET
        target_id = excluded.target_id,
        project_json = excluded.project_json,
        aggregate_version = excluded.aggregate_version,
        last_sequence = excluded.last_sequence
      WHERE excluded.aggregate_version > ssh_remote_project_projection.aggregate_version`,
    )
    .run(
      String(project.id),
      String(project.targetId),
      JSON.stringify(Schema.encodeSync(SshRemoteProject)(project)),
      event.aggregateVersion,
      event.globalSequence,
    );
}

function assertAggregate(payloadId: string, aggregateId: string): void {
  if (payloadId !== aggregateId) throw new Error("SSH target event does not match its aggregate.");
}

function updateTarget(
  connection: SqliteConnection,
  event: EventEnvelope,
  assignments: string,
  values: ReadonlyArray<string>,
): void {
  connection
    .prepare(
      `UPDATE ssh_target_projection SET ${assignments}, aggregate_version = ?, last_sequence = ?
       WHERE target_id = ? AND aggregate_version < ?`,
    )
    .run(
      ...values,
      event.aggregateVersion,
      event.globalSequence,
      String(event.aggregateId),
      event.aggregateVersion,
    );
}

interface TargetRow {
  readonly target_id: string;
  readonly target_json: string;
  readonly registered_at: string;
  readonly attestation_json: string | null;
  readonly attested_at: string | null;
}

interface RemoteProjectRow {
  readonly project_json: string;
}

const decodeTarget = Schema.decodeUnknownSync(SshTarget);
const decodeAttested = Schema.decodeUnknownSync(SshTargetAttested);
const decodeRemoteProject = Schema.decodeUnknownSync(SshRemoteProject);

function decodeTargetJson(json: string): SshTarget {
  return decodeTarget(JSON.parse(json));
}

function readTargetRow(connection: SqliteConnection, targetId: string): TargetRow | undefined {
  return connection
    .prepare(
      `SELECT target_id, target_json, registered_at, attestation_json, attested_at
       FROM ssh_target_projection WHERE target_id = ?`,
    )
    .get(targetId) as TargetRow | undefined;
}

/** A registered target with when it was registered and its last journaled attestation. */
export interface SshTargetRecord {
  readonly target: SshTarget;
  readonly registeredAt: string;
  readonly lastAttestation?: { readonly attestedAt: string; readonly attested: SshTargetAttested };
}

function recordFromRow(row: TargetRow): SshTargetRecord {
  return {
    target: decodeTargetJson(row.target_json),
    registeredAt: row.registered_at,
    ...(row.attestation_json === null || row.attested_at === null
      ? {}
      : {
          lastAttestation: {
            attestedAt: row.attested_at,
            attested: decodeAttested(JSON.parse(row.attestation_json)),
          },
        }),
  };
}

export function readSshTargets(connection: SqliteConnection): ReadonlyArray<SshTargetRecord> {
  const rows = connection
    .prepare(
      `SELECT target_id, target_json, registered_at, attestation_json, attested_at
       FROM ssh_target_projection ORDER BY registered_at, target_id`,
    )
    .all() as ReadonlyArray<TargetRow>;
  return rows.map(recordFromRow);
}

export function readSshTarget(
  connection: SqliteConnection,
  targetId: string,
): SshTargetRecord | undefined {
  const row = readTargetRow(connection, targetId);
  return row === undefined ? undefined : recordFromRow(row);
}

const decodeRuntimeBinary = Schema.decodeUnknownSync(SshRuntimeBinary);

/** The runtime paths the person set on a target, one per provider instance, oldest first. */
export function readSshTargetRuntimeBinaries(
  connection: SqliteConnection,
  targetId: string,
): ReadonlyArray<SshRuntimeBinary> {
  const rows = connection
    .prepare(
      `SELECT provider_instance_id, path FROM ssh_target_runtime_binary_projection
       WHERE target_id = ? ORDER BY last_sequence`,
    )
    .all(targetId) as ReadonlyArray<{
    readonly provider_instance_id: string;
    readonly path: string;
  }>;
  return rows.map((row) =>
    decodeRuntimeBinary({ providerInstanceId: row.provider_instance_id, path: row.path }),
  );
}

export function readSshRemoteProjects(
  connection: SqliteConnection,
): ReadonlyArray<SshRemoteProject> {
  const rows = connection
    .prepare("SELECT project_json FROM ssh_remote_project_projection ORDER BY last_sequence")
    .all() as ReadonlyArray<RemoteProjectRow>;
  return rows.map((row) => decodeRemoteProject(JSON.parse(row.project_json)));
}

export function readSshRemoteProject(
  connection: SqliteConnection,
  projectId: string,
): SshRemoteProject | undefined {
  const row = connection
    .prepare("SELECT project_json FROM ssh_remote_project_projection WHERE project_id = ?")
    .get(projectId) as RemoteProjectRow | undefined;
  return row === undefined ? undefined : decodeRemoteProject(JSON.parse(row.project_json));
}

const decodeWorktree = Schema.decodeUnknownSync(SshRemoteWorktree);

/** The managed worktrees still present for a Project, oldest first; every Project's when none is named. */
export function readSshRemoteWorktrees(
  connection: SqliteConnection,
  projectId?: string,
): ReadonlyArray<SshRemoteWorktree> {
  const rows = (
    projectId === undefined
      ? connection
          .prepare(
            "SELECT worktree_json FROM ssh_remote_worktree_projection ORDER BY last_sequence",
          )
          .all()
      : connection
          .prepare(
            `SELECT worktree_json FROM ssh_remote_worktree_projection
             WHERE project_id = ? ORDER BY last_sequence`,
          )
          .all(projectId)
  ) as ReadonlyArray<{ readonly worktree_json: string }>;
  return rows.map((row) => decodeWorktree(JSON.parse(row.worktree_json)));
}

export function readSshRemoteWorktree(
  connection: SqliteConnection,
  worktreeId: string,
): SshRemoteWorktree | undefined {
  const row = connection
    .prepare("SELECT worktree_json FROM ssh_remote_worktree_projection WHERE worktree_id = ?")
    .get(worktreeId) as { readonly worktree_json: string } | undefined;
  return row === undefined ? undefined : decodeWorktree(JSON.parse(row.worktree_json));
}

/** Remote terminals the journal records as running: after a restart, none of them is. */
export function readRunningSshRemoteTerminals(
  connection: SqliteConnection,
): ReadonlyArray<{ readonly terminalId: string; readonly version: number }> {
  const rows = connection
    .prepare(
      `SELECT terminal_id, aggregate_version FROM ssh_remote_terminal_projection
       WHERE state = 'running' ORDER BY last_sequence`,
    )
    .all() as ReadonlyArray<{ readonly terminal_id: string; readonly aggregate_version: number }>;
  return rows.map((row) => ({ terminalId: row.terminal_id, version: row.aggregate_version }));
}
