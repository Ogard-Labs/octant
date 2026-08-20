import {
  decodeAgentProfile,
  decodeAgentProfileScope,
  decodeAgentProfileCreated,
  decodeAgentProfileRemoved,
  decodeAgentProfileUpdated,
  type AgentProfile,
  type AgentProfileId,
  type AgentProfileScope,
  type EventEnvelope,
  type ProfileScopeKind,
} from "@octant/contracts";
import type { Projection } from "./projection";
import {
  assertAgentProfileProjectionSchema,
  AGENT_PROFILE_PROJECTION_SCHEMA_VERSION,
  type AgentProfileProjectionRow,
} from "./agentProfilePersistenceSchema";
import type { SqliteConnection, SqliteStatement } from "./sqlitePort";

const profileDecoders = {
  "agent.profile-created@1": (payload: unknown) => decodeAgentProfileCreated(payload),
  "agent.profile-updated@1": (payload: unknown) => decodeAgentProfileUpdated(payload),
} as const;

function isProfileSnapshotEvent(eventName: string): eventName is keyof typeof profileDecoders {
  return eventName in profileDecoders;
}

export class AgentProfileProjection implements Projection {
  readonly name = "agent-profiles";
  readonly dependencies: ReadonlyArray<string> = ["aggregate-heads"];
  #upsertByConnection = new WeakMap<SqliteConnection, SqliteStatement>();
  #removeByConnection = new WeakMap<SqliteConnection, SqliteStatement>();
  #aggregateHeadByConnection = new WeakMap<SqliteConnection, SqliteStatement>();

  reset(connection: SqliteConnection): void {
    connection.exec(`DELETE FROM agent_profile_projection;`);
  }

  apply(connection: SqliteConnection, event: EventEnvelope): void {
    if (isProfileSnapshotEvent(event.eventName)) {
      assertEnvelope(event.eventVersion === 1 && event.aggregateType === "agent-profile");
      const decoded = profileDecoders[event.eventName as keyof typeof profileDecoders](
        event.payload,
      );
      const profile = decoded.profile;
      const scope = decoded.scope;
      assertEnvelope(
        String(profile.id) === String(event.aggregateId) &&
          profile.version === event.aggregateVersion,
      );
      if (this.#isStale(connection, event)) return;
      this.#upsertProfile(connection, profile, scope, event.aggregateVersion);
      return;
    }

    if (event.eventName === "agent.profile-removed@1") {
      assertEnvelope(event.eventVersion === 1 && event.aggregateType === "agent-profile");
      const removed = decodeAgentProfileRemoved(event.payload);
      assertEnvelope(
        String(removed.profileId) === String(event.aggregateId) &&
          removed.version === event.aggregateVersion,
      );
      if (this.#isStale(connection, event)) return;
      this.#removeProfile(connection, removed.profileId, removed.version);
    }
  }

  #isStale(connection: SqliteConnection, event: EventEnvelope): boolean {
    let statement = this.#aggregateHeadByConnection.get(connection);
    if (statement === undefined) {
      statement = connection.prepare(`
        SELECT aggregate_version
        FROM aggregate_heads
        WHERE aggregate_type = ? AND aggregate_id = ?
      `);
      this.#aggregateHeadByConnection.set(connection, statement);
    }
    const row = statement.get(event.aggregateType, event.aggregateId) as
      | { readonly aggregate_version: number }
      | undefined;
    return row !== undefined && event.aggregateVersion < row.aggregate_version;
  }

  #upsertProfile(
    connection: SqliteConnection,
    profile: AgentProfile,
    scope: AgentProfileScope,
    aggregateVersion: number,
  ): void {
    let statement = this.#upsertByConnection.get(connection);
    if (statement === undefined) {
      statement = connection.prepare(`
        INSERT INTO agent_profile_projection (
          profile_id, schema_version, scope_kind, scope_ref,
          profile_json, aggregate_version
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (profile_id) DO UPDATE SET
          schema_version = excluded.schema_version,
          scope_kind = excluded.scope_kind,
          scope_ref = excluded.scope_ref,
          profile_json = excluded.profile_json,
          aggregate_version = excluded.aggregate_version
        WHERE excluded.aggregate_version > agent_profile_projection.aggregate_version
      `);
      this.#upsertByConnection.set(connection, statement);
    }
    statement.run(
      profile.id,
      AGENT_PROFILE_PROJECTION_SCHEMA_VERSION,
      scope.scopeKind,
      scope.scopeRef,
      JSON.stringify(profile),
      aggregateVersion,
    );
  }

  #removeProfile(
    connection: SqliteConnection,
    profileId: AgentProfileId,
    aggregateVersion: number,
  ): void {
    let statement = this.#removeByConnection.get(connection);
    if (statement === undefined) {
      statement = connection.prepare(`
        DELETE FROM agent_profile_projection
        WHERE profile_id = ? AND aggregate_version < ?
      `);
      this.#removeByConnection.set(connection, statement);
    }
    statement.run(profileId, aggregateVersion);
  }
}

function assertEnvelope(condition: boolean): asserts condition {
  if (!condition) throw new Error("Agent profile projection event envelope is inconsistent");
}

export function readAgentProfile(
  connection: SqliteConnection,
  profileId: AgentProfileId,
): AgentProfile | undefined {
  const row = connection
    .prepare(`
      SELECT profile_id, schema_version, scope_kind, scope_ref,
             profile_json, aggregate_version
      FROM agent_profile_projection
      WHERE profile_id = ?
    `)
    .get(profileId) as AgentProfileProjectionRow | undefined;
  return row === undefined ? undefined : decodeProfileRow(row);
}

/**
 * The profile together with the scope that owns it. A caller deciding whether a
 * profile may start a given thread needs both: the identifier alone says
 * nothing about which Project, mode, or thread the profile was written for.
 */
export function readAgentProfileBinding(
  connection: SqliteConnection,
  profileId: AgentProfileId,
): { readonly profile: AgentProfile; readonly scope: AgentProfileScope } | undefined {
  const row = connection
    .prepare(`
      SELECT profile_id, schema_version, scope_kind, scope_ref,
             profile_json, aggregate_version
      FROM agent_profile_projection
      WHERE profile_id = ?
    `)
    .get(profileId) as AgentProfileProjectionRow | undefined;
  if (row === undefined) return undefined;
  return {
    profile: decodeProfileRow(row),
    scope: decodeAgentProfileScope({ scopeKind: row.scope_kind, scopeRef: row.scope_ref }),
  };
}

export function readAgentProfiles(connection: SqliteConnection): ReadonlyArray<AgentProfile> {
  const rows = connection
    .prepare(`
      SELECT profile_id, schema_version, scope_kind, scope_ref,
             profile_json, aggregate_version
      FROM agent_profile_projection
      ORDER BY profile_id
    `)
    .all() as ReadonlyArray<AgentProfileProjectionRow>;
  return rows.map(decodeProfileRow);
}

export function readProfilesForScope(
  connection: SqliteConnection,
  scopeKind: ProfileScopeKind,
  scopeRef: string,
): ReadonlyArray<AgentProfile> {
  const rows = connection
    .prepare(`
      SELECT profile_id, schema_version, scope_kind, scope_ref,
             profile_json, aggregate_version
      FROM agent_profile_projection
      WHERE scope_kind = ? AND scope_ref = ?
      ORDER BY profile_id
    `)
    .all(scopeKind, scopeRef) as ReadonlyArray<AgentProfileProjectionRow>;
  return rows.map(decodeProfileRow);
}

function decodeProfileRow(row: AgentProfileProjectionRow): AgentProfile {
  assertAgentProfileProjectionSchema(row.schema_version);
  const profile = decodeAgentProfile(JSON.parse(row.profile_json));
  assertEnvelope(
    String(profile.id) === row.profile_id && profile.version === row.aggregate_version,
  );
  return profile;
}
