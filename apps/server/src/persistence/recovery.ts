import { Data } from "effect";
import type { ReplayFailureReason } from "./journalErrors";
import type { Journal, JournalCompatibility } from "./journal";
import {
  type Projection,
  ProjectionRegistry,
  rebuildProjection,
  rebuildProjections,
} from "./projection";
import type { SqliteConnection } from "./sqlitePort";

export type DatabaseRecoveryState = "current" | "lagging" | "invalid" | "quarantined";

export interface DatabaseStatus {
  readonly migrationVersion: number;
  readonly journalHead: number;
  readonly aggregateCount: number;
  readonly projections: ReadonlyArray<{
    readonly name: string;
    readonly lastSequence: number;
    readonly lag: number;
  }>;
  readonly quarantineCount: number;
  readonly integrity: "ok" | "failed";
  readonly state: DatabaseRecoveryState;
  readonly recoveryReason?: "journal-incompatible";
}

export type DatabaseVerificationIssue =
  | {
      readonly kind: "sqlite-integrity-check";
    }
  | {
      readonly kind: "aggregate-version-gap";
      readonly aggregateType: string;
      readonly expectedVersion: number;
      readonly actualVersion: number;
    }
  | {
      readonly kind: "aggregate-head-mismatch";
      readonly aggregateType: string;
      readonly journalVersion: number;
      readonly headVersion: number | null;
      readonly journalSequence: number;
      readonly headSequence: number | null;
    }
  | {
      readonly kind: "aggregate-head-orphan";
      readonly aggregateType: string;
    }
  | {
      readonly kind: "checkpoint-ahead";
      readonly projectionName: string;
      readonly lastSequence: number;
      readonly journalHead: number;
    }
  | {
      readonly kind: "journal-incompatible";
      readonly reason: ReplayFailureReason;
    };

export interface DatabaseVerification {
  readonly valid: boolean;
  readonly state: DatabaseRecoveryState;
  readonly integrity: "ok" | "failed";
  readonly issues: ReadonlyArray<DatabaseVerificationIssue>;
}

export interface RecoveryInput {
  readonly connection: SqliteConnection;
  readonly journal: Journal;
  readonly compatibility?: JournalCompatibility;
  readonly projections: ProjectionRegistry;
}

export interface RebuildInput extends RecoveryInput {
  readonly journal: Journal;
  readonly clock: () => string;
}

export interface RebuildResult {
  readonly rebuilt: ReadonlyArray<string>;
  readonly journalHead: number;
}

export class UnknownProjection extends Data.TaggedError("UnknownProjection")<{
  readonly projectionName: string;
}> {}

export class IsolatedProjectionRebuildRejected extends Data.TaggedError(
  "IsolatedProjectionRebuildRejected",
)<{
  readonly projectionName: string;
  readonly dependentProjectionName: string;
}> {}

interface CountRow {
  readonly count: number;
}

interface CheckpointRow {
  readonly projection_name: string;
  readonly last_sequence: number;
}

interface AggregateEventRow {
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly aggregate_version: number;
  readonly global_sequence: number;
}

interface AggregateHeadRow {
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly aggregate_version: number;
  readonly last_sequence: number;
}

export function databaseStatus(input: RecoveryInput): DatabaseStatus {
  return inspectDatabase(input).status;
}

export function verifyDatabase(input: RecoveryInput): DatabaseVerification {
  const inspection = inspectDatabase(input);
  return {
    valid: inspection.issues.length === 0 && inspection.status.quarantineCount === 0,
    state: inspection.status.state,
    integrity: inspection.status.integrity,
    issues: inspection.issues,
  };
}

function inspectDatabase(input: RecoveryInput): {
  readonly status: DatabaseStatus;
  readonly issues: ReadonlyArray<DatabaseVerificationIssue>;
} {
  const migrationVersion = numberValue(
    input.connection
      .prepare("SELECT coalesce(max(version), 0) AS value FROM schema_migrations")
      .get(),
  );
  const journalHead = numberValue(
    input.connection
      .prepare("SELECT coalesce(max(global_sequence), 0) AS value FROM event_journal")
      .get(),
  );
  const integrityOk = input.connection.pragma("integrity_check", { simple: true }) === "ok";
  const issues: Array<DatabaseVerificationIssue> = [];
  if (!integrityOk) issues.push({ kind: "sqlite-integrity-check" });
  const compatibility = input.compatibility ?? input.journal.inspectCompatibility();
  if (!compatibility.compatible) {
    issues.push({ kind: "journal-incompatible", reason: compatibility.issue.reason });
  }

  const events = input.connection
    .prepare(`
      SELECT aggregate_type, aggregate_id, aggregate_version, global_sequence
      FROM event_journal
      ORDER BY aggregate_type, aggregate_id, global_sequence
    `)
    .all() as ReadonlyArray<AggregateEventRow>;
  const journalHeads = new Map<
    string,
    {
      readonly aggregateType: string;
      readonly aggregateId: string;
      readonly aggregateVersion: number;
      readonly globalSequence: number;
    }
  >();
  let previousAggregateKey: string | undefined;
  let expectedVersion = 1;
  for (const event of events) {
    const aggregateKey = aggregateKeyFor(event.aggregate_type, event.aggregate_id);
    if (aggregateKey !== previousAggregateKey) expectedVersion = 1;
    if (event.aggregate_version !== expectedVersion) {
      issues.push({
        kind: "aggregate-version-gap",
        aggregateType: event.aggregate_type,
        expectedVersion,
        actualVersion: event.aggregate_version,
      });
    }
    expectedVersion = event.aggregate_version + 1;
    previousAggregateKey = aggregateKey;

    const currentHead = journalHeads.get(aggregateKey);
    if (currentHead === undefined || event.aggregate_version > currentHead.aggregateVersion) {
      journalHeads.set(aggregateKey, {
        aggregateType: event.aggregate_type,
        aggregateId: event.aggregate_id,
        aggregateVersion: event.aggregate_version,
        globalSequence: event.global_sequence,
      });
    }
  }

  const storedHeads = input.connection
    .prepare(`
      SELECT aggregate_type, aggregate_id, aggregate_version, last_sequence
      FROM aggregate_heads
      ORDER BY aggregate_type, aggregate_id
    `)
    .all() as ReadonlyArray<AggregateHeadRow>;
  const storedHeadsByKey = new Map(
    storedHeads.map((head) => [aggregateKeyFor(head.aggregate_type, head.aggregate_id), head]),
  );
  for (const [aggregateKey, journalHead] of journalHeads) {
    const storedHead = storedHeadsByKey.get(aggregateKey);
    if (
      storedHead === undefined ||
      storedHead.aggregate_version !== journalHead.aggregateVersion ||
      storedHead.last_sequence !== journalHead.globalSequence
    ) {
      issues.push({
        kind: "aggregate-head-mismatch",
        aggregateType: journalHead.aggregateType,
        journalVersion: journalHead.aggregateVersion,
        headVersion: storedHead?.aggregate_version ?? null,
        journalSequence: journalHead.globalSequence,
        headSequence: storedHead?.last_sequence ?? null,
      });
    }
    storedHeadsByKey.delete(aggregateKey);
  }
  for (const orphan of storedHeadsByKey.values()) {
    issues.push({ kind: "aggregate-head-orphan", aggregateType: orphan.aggregate_type });
  }

  const quarantineCount = count(
    input.connection.prepare("SELECT count(*) AS count FROM event_quarantine").get(),
  );
  const checkpoints = input.connection
    .prepare("SELECT projection_name, last_sequence FROM projection_checkpoints")
    .all() as ReadonlyArray<CheckpointRow>;
  const checkpointsByName = new Map(
    checkpoints.map((checkpoint) => [checkpoint.projection_name, checkpoint.last_sequence]),
  );
  const projections = input.projections.all().map((projection) => {
    const lastSequence = checkpointsByName.get(projection.name) ?? 0;
    return {
      name: projection.name,
      lastSequence,
      lag: Math.max(journalHead - lastSequence, 0),
    };
  });
  for (const checkpoint of checkpoints) {
    if (checkpoint.last_sequence > journalHead) {
      issues.push({
        kind: "checkpoint-ahead",
        projectionName: checkpoint.projection_name,
        lastSequence: checkpoint.last_sequence,
        journalHead,
      });
    }
  }
  const lagging = projections.some((projection) => projection.lag > 0);

  return {
    status: {
      migrationVersion,
      journalHead,
      aggregateCount: journalHeads.size,
      projections,
      quarantineCount,
      integrity: integrityOk ? "ok" : "failed",
      state: classifyState({ invalid: issues.length > 0, quarantineCount, lagging }),
      ...(compatibility.compatible ? {} : { recoveryReason: "journal-incompatible" as const }),
    },
    issues,
  };
}

export function rebuildAll(input: RebuildInput): RebuildResult {
  const ordered = orderByDependencies(input.projections.all());
  rebuildProjections({
    connection: input.connection,
    journal: input.journal,
    projections: ordered,
    clock: input.clock,
  });
  return {
    rebuilt: ordered.map((projection) => projection.name),
    journalHead: input.journal.headSequence(),
  };
}

export function rebuildProjectionByName(
  input: RebuildInput & { readonly projectionName: string },
): RebuildResult {
  const projection = input.projections.get(input.projectionName);
  if (projection === undefined) {
    throw new UnknownProjection({ projectionName: input.projectionName });
  }
  const dependent = input.projections
    .all()
    .find((candidate) => candidate.dependencies.includes(projection.name));
  if (dependent !== undefined) {
    throw new IsolatedProjectionRebuildRejected({
      projectionName: projection.name,
      dependentProjectionName: dependent.name,
    });
  }
  rebuildProjection({
    connection: input.connection,
    journal: input.journal,
    projection,
    clock: input.clock,
  });
  return { rebuilt: [projection.name], journalHead: input.journal.headSequence() };
}

function orderByDependencies(projections: ReadonlyArray<Projection>): ReadonlyArray<Projection> {
  const byName = new Map(projections.map((projection) => [projection.name, projection]));
  const visited = new Set<string>();
  const ordered: Array<Projection> = [];

  function visit(projection: Projection): void {
    if (visited.has(projection.name)) return;
    for (const dependencyName of projection.dependencies) {
      const dependency = byName.get(dependencyName);
      if (dependency !== undefined) visit(dependency);
    }
    visited.add(projection.name);
    ordered.push(projection);
  }
  for (const projection of projections) visit(projection);
  return ordered;
}

function count(row: unknown): number {
  return (row as CountRow).count;
}

function numberValue(row: unknown): number {
  return (row as { readonly value: number }).value;
}

function aggregateKeyFor(aggregateType: string, aggregateId: string): string {
  return JSON.stringify([aggregateType, aggregateId]);
}

function classifyState(input: {
  readonly invalid: boolean;
  readonly quarantineCount: number;
  readonly lagging: boolean;
}): DatabaseRecoveryState {
  if (input.invalid) return "invalid";
  if (input.quarantineCount > 0) return "quarantined";
  if (input.lagging) return "lagging";
  return "current";
}
