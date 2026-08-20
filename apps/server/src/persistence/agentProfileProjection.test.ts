import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeAgentProfileId } from "@octant/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { readAgentProfileBinding } from "./agentProfileProjection";
import { Journal } from "./journal";
import { applyMigrations, MIGRATIONS } from "./migrations";
import { rebuildProjection } from "./projection";
import { createPhase1RuntimeRegistries } from "./runtimeRegistry";
import { openSqlite } from "./sqlitePort";

const directories: Array<string> = [];
const now = "2026-08-20T10:00:00.000Z";
const ids = {
  actor: "83000000-0000-4000-8000-000000000001",
  correlation: "83000000-0000-4000-8000-000000000002",
  profile: "83000000-0000-4000-8000-000000000003",
  project: "83000000-0000-4000-8000-000000000004",
  user: "83000000-0000-4000-8000-000000000005",
} as const;

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("AgentProfileProjection", () => {
  it("keeps the scope a profile was created with when an edit claimed the whole user", () => {
    const { connection, journal, projection } = openStore();
    try {
      appendProfile(journal);

      expect(readAgentProfileBinding(connection, decodeAgentProfileId(ids.profile))?.scope).toEqual(
        { scopeKind: "project", scopeRef: ids.project },
      );

      // A rebuild resets the table and replays from the journal, where the
      // widening edit is the profile's latest event.
      rebuildProjection({ connection, journal, projection, clock: () => now });

      expect(readAgentProfileBinding(connection, decodeAgentProfileId(ids.profile))?.scope).toEqual(
        { scopeKind: "project", scopeRef: ids.project },
      );
    } finally {
      connection.close();
    }
  });
});

function openStore() {
  const directory = mkdtempSync(join(tmpdir(), "octant-agent-profile-projection-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  const projection = runtime.projections.get("agent-profiles");
  if (projection === undefined) throw new Error("Agent profile projection must be registered");
  return {
    connection,
    projection,
    journal: new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    }),
  };
}

function appendProfile(journal: Journal): void {
  const common = {
    eventVersion: 1,
    correlationId: ids.correlation,
    actor: { kind: "local-user", actorId: ids.actor },
    occurredAt: now,
  } as const;
  const profile = {
    id: ids.profile,
    displayName: "Reviewer",
    approvedSkillIds: [],
    toolConstraints: [],
    modelConstraints: [],
    defaultExecutionPolicy: "approval-gated",
    defaultPermissionPersistence: "current-session",
    compatibleModes: ["code"],
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  journal.append({
    aggregate: { aggregateType: "agent-profile", aggregateId: ids.profile },
    expectedVersion: 0,
    events: [
      {
        ...common,
        eventId: "83000000-0000-4000-8000-000000000010",
        eventName: "agent.profile-created@1",
        payload: {
          profile,
          scope: { scopeKind: "project", scopeRef: ids.project },
        },
      },
    ],
  });
  // What the service used to journal: every edit relabelled the profile as
  // reaching the whole user, whatever it was created for.
  journal.append({
    aggregate: { aggregateType: "agent-profile", aggregateId: ids.profile },
    expectedVersion: 1,
    events: [
      {
        ...common,
        eventId: "83000000-0000-4000-8000-000000000011",
        eventName: "agent.profile-updated@1",
        payload: {
          profile: { ...profile, displayName: "Reviewer (edited)", version: 2 },
          scope: { scopeKind: "user", scopeRef: ids.user },
        },
      },
    ],
  });
}
