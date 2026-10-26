import { Schema } from "effect";
import type { EventEnvelope } from "@octant/contracts/events";
import { SshRemoteProject } from "@octant/contracts/ssh-remote-project";
import { SshTarget } from "@octant/contracts/ssh-target";
import {
  SSH_REMOTE_PROJECT_AGGREGATE,
  SSH_REMOTE_PROJECT_EVENT_NAMES,
  SSH_TARGET_AGGREGATE,
  SSH_TARGET_EVENT_NAMES,
  SshTargetAttested,
  decodeSshRemoteProjectBound,
  decodeSshTargetAttested,
  decodeSshTargetRegistered,
  decodeSshTargetRemoved,
  decodeSshTargetRepinned,
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
      DELETE FROM ssh_remote_project_projection;
    `);
  }

  apply(connection: SqliteConnection, event: EventEnvelope): void {
    if (event.eventVersion !== 1) return;
    if (event.aggregateType === SSH_TARGET_AGGREGATE) applyTargetEvent(connection, event);
    else if (event.aggregateType === SSH_REMOTE_PROJECT_AGGREGATE) {
      applyRemoteProjectEvent(connection, event);
    }
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
