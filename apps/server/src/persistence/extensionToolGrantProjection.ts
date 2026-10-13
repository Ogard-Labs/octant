import { createHash } from "node:crypto";
import type { EventEnvelope } from "@octant/contracts/events";
import {
  EXTENSION_TOOL_GRANT_AGGREGATE,
  EXTENSION_TOOL_GRANT_EVENT_NAMES,
  decodeExtensionToolGrantRecorded,
  decodeExtensionToolGrantRevoked,
  type ExtensionToolGrantRevocationReason,
} from "@octant/contracts/extension-events";
import { decodeExtensionToolGrant, type ExtensionToolGrant } from "@octant/contracts/extension-rpc";
import type { Projection } from "./projection";
import type { SqliteConnection } from "./sqlitePort";

export const EXTENSION_TOOL_GRANT_PROJECTION = "extension-tool-grants";

/** One MCP tool in one Project: what a grant is for, whatever version it binds. */
export interface ExtensionToolGrantSubject {
  readonly projectId: string;
  readonly extensionId: string;
  readonly packageId: string;
  readonly componentId: string;
  readonly mcpToolName: string;
}

export interface ProjectedExtensionToolGrant extends ExtensionToolGrant {
  readonly revocationReason: ExtensionToolGrantRevocationReason | undefined;
  /** The journal sequence of the event that last moved this row. */
  readonly lastSequence: number;
}

interface GrantRow {
  readonly grant_id: string;
  readonly project_id: string;
  readonly extension_id: string;
  readonly package_id: string;
  readonly component_id: string;
  readonly mcp_tool_name: string;
  readonly package_version: string;
  readonly package_digest: string;
  readonly definition_digest: string;
  readonly revocation_reason: ExtensionToolGrantRevocationReason | null;
  readonly granted_at: string;
  readonly last_sequence: number;
}

/**
 * The same tool in the same Project always has the same grant id, so a second
 * answer replaces the first row instead of standing beside it, and replaying
 * the journal twice cannot grow the table.
 */
export function extensionToolGrantId(subject: ExtensionToolGrantSubject): string {
  const identity = JSON.stringify([
    subject.projectId,
    subject.extensionId,
    subject.packageId,
    subject.componentId,
    subject.mcpToolName,
  ]);
  return `sha256:${createHash("sha256").update(identity).digest("hex")}`;
}

/**
 * Rebuildable rows for `extension.tool-grant-recorded@1` and
 * `extension.tool-grant-revoked@1`. A row moves only on a higher aggregate
 * version, so an event applied twice changes nothing. A revoked row stays as
 * a row: the next call reads why it must ask, and only a new answer from a
 * person replaces it.
 */
export class ExtensionToolGrantProjection implements Projection {
  readonly name = EXTENSION_TOOL_GRANT_PROJECTION;
  readonly dependencies: ReadonlyArray<string> = ["aggregate-heads"];

  reset(connection: SqliteConnection): void {
    connection.exec("DELETE FROM extension_tool_grant_projection;");
  }

  apply(connection: SqliteConnection, event: EventEnvelope): void {
    if (event.eventVersion !== 1 || event.aggregateType !== EXTENSION_TOOL_GRANT_AGGREGATE) return;
    if (event.eventName === EXTENSION_TOOL_GRANT_EVENT_NAMES.recorded) {
      const grant = decodeExtensionToolGrantRecorded(event.payload);
      if (
        String(grant.projectId) !== String(event.aggregateId) ||
        grant.grantId !== extensionToolGrantId(grant)
      ) {
        throw new Error("Extension tool grant does not match its Project and tool.");
      }
      connection
        .prepare(
          `INSERT INTO extension_tool_grant_projection (
            grant_id, project_id, extension_id, package_id, component_id, mcp_tool_name,
            package_version, package_digest, definition_digest, revocation_reason, granted_at,
            aggregate_version, last_sequence
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
          ON CONFLICT (grant_id) DO UPDATE SET
            package_version = excluded.package_version,
            package_digest = excluded.package_digest,
            definition_digest = excluded.definition_digest,
            revocation_reason = NULL,
            granted_at = excluded.granted_at,
            aggregate_version = excluded.aggregate_version,
            last_sequence = excluded.last_sequence
          WHERE excluded.aggregate_version > extension_tool_grant_projection.aggregate_version`,
        )
        .run(
          grant.grantId,
          String(grant.projectId),
          String(grant.extensionId),
          String(grant.packageId),
          String(grant.componentId),
          grant.mcpToolName,
          grant.version,
          grant.digest,
          grant.definitionDigest,
          event.occurredAt,
          event.aggregateVersion,
          event.globalSequence,
        );
      return;
    }
    if (event.eventName === EXTENSION_TOOL_GRANT_EVENT_NAMES.revoked) {
      const revoked = decodeExtensionToolGrantRevoked(event.payload);
      if (String(revoked.projectId) !== String(event.aggregateId)) {
        throw new Error("Extension tool grant revocation does not match its Project.");
      }
      connection
        .prepare(
          `UPDATE extension_tool_grant_projection
           SET revocation_reason = ?, aggregate_version = ?, last_sequence = ?
           WHERE grant_id = ? AND project_id = ? AND aggregate_version < ?`,
        )
        .run(
          revoked.reason,
          event.aggregateVersion,
          event.globalSequence,
          revoked.grantId,
          String(revoked.projectId),
          event.aggregateVersion,
        );
    }
  }
}

const GRANT_COLUMNS = `grant_id, project_id, extension_id, package_id, component_id,
  mcp_tool_name, package_version, package_digest, definition_digest, revocation_reason,
  granted_at, last_sequence`;

/** The stored grant for a tool, revoked or not, or `undefined` when none was ever recorded. */
export function readExtensionToolGrant(
  connection: SqliteConnection,
  grantId: string,
): ProjectedExtensionToolGrant | undefined {
  const row = connection
    .prepare(`SELECT ${GRANT_COLUMNS} FROM extension_tool_grant_projection WHERE grant_id = ?`)
    .get(grantId) as GrantRow | undefined;
  return row === undefined ? undefined : projectGrant(row);
}

/** Grants a call could still use, optionally only those of one extension. */
export function readActiveExtensionToolGrants(
  connection: SqliteConnection,
  extensionId?: string,
): ReadonlyArray<ProjectedExtensionToolGrant> {
  const rows = (
    extensionId === undefined
      ? connection
          .prepare(
            `SELECT ${GRANT_COLUMNS} FROM extension_tool_grant_projection
             WHERE revocation_reason IS NULL ORDER BY project_id, granted_at, grant_id`,
          )
          .all()
      : connection
          .prepare(
            `SELECT ${GRANT_COLUMNS} FROM extension_tool_grant_projection
             WHERE revocation_reason IS NULL AND extension_id = ?
             ORDER BY project_id, granted_at, grant_id`,
          )
          .all(extensionId)
  ) as ReadonlyArray<GrantRow>;
  return rows.map(projectGrant);
}

function projectGrant(row: GrantRow): ProjectedExtensionToolGrant {
  return {
    ...decodeExtensionToolGrant({
      grantId: row.grant_id,
      projectId: row.project_id,
      extensionId: row.extension_id,
      packageId: row.package_id,
      componentId: row.component_id,
      mcpToolName: row.mcp_tool_name,
      version: row.package_version,
      digest: row.package_digest,
      definitionDigest: row.definition_digest,
      grantedAt: row.granted_at,
    }),
    revocationReason: row.revocation_reason ?? undefined,
    lastSequence: row.last_sequence,
  };
}
