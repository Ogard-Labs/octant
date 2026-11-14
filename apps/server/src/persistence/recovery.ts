import { Data } from "effect";
import type { ReplayFailureReason } from "./journalErrors";
import type { Journal, JournalCompatibility } from "./journal";
import {
  type Projection,
  ProjectionQuarantined,
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
  /**
   * Readiness, judged by the authoritative projections alone. A held derived
   * view lags or is quarantined without making the store unready: no command
   * or authority check reads it, so it is listed in `heldDerivedViews`
   * instead, and db:rebuild repairs it.
   */
  readonly state: DatabaseRecoveryState;
  /** Derived views that are quarantined or lagging, present only when any are. */
  readonly heldDerivedViews?: ReadonlyArray<string>;
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
  /**
   * The journal sequence an earlier start of this same build already verified
   * (the startup watermark). Rows at or below it skip the structural walk and
   * SQLite's integrity check; rows above it are always checked, and anything
   * suspicious falls back to the full inspection. Omitted or 0 inspects all.
   */
  readonly verifiedThrough?: number;
}

export interface RebuildInput extends RecoveryInput {
  readonly journal: Journal;
  readonly clock: () => string;
}

export interface RebuildResult {
  readonly rebuilt: ReadonlyArray<string>;
  readonly journalHead: number;
  /** Derived views that still could not apply an event and stay quarantined. */
  readonly held?: ReadonlyArray<string>;
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

interface CheckpointRow {
  readonly projection_name: string;
  readonly last_sequence: number;
}

interface QuarantineCountRow {
  readonly projection_name: string;
  readonly count: number;
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
  const verifiedThrough = input.verifiedThrough ?? 0;
  const verifiedAggregateCount =
    verifiedThrough > 0 ? verifiedTailAggregateCount(input.connection, verifiedThrough) : undefined;
  // A clean start of an already-verified build skips SQLite's integrity check:
  // on a 32,000-row journal it and the full row walk below held startup for
  // 0.9 to 1.7 s on every boot. The first start of every build, a fresh
  // diagnostic, and any start whose unverified tail looks wrong run both.
  const integrityOk =
    verifiedAggregateCount !== undefined ||
    input.connection.pragma("integrity_check", { simple: true }) === "ok";
  const issues: Array<DatabaseVerificationIssue> = [];
  if (!integrityOk) issues.push({ kind: "sqlite-integrity-check" });
  const compatibility = input.compatibility ?? input.journal.inspectCompatibility();
  if (!compatibility.compatible) {
    issues.push({ kind: "journal-incompatible", reason: compatibility.issue.reason });
  }

  const events =
    verifiedAggregateCount !== undefined
      ? []
      : (input.connection
          .prepare(`
      SELECT aggregate_type, aggregate_id, aggregate_version, global_sequence
      FROM event_journal
      ORDER BY aggregate_type, aggregate_id, global_sequence
    `)
          .all() as ReadonlyArray<AggregateEventRow>);
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

  const storedHeads =
    verifiedAggregateCount !== undefined
      ? []
      : (input.connection
          .prepare(`
      SELECT aggregate_type, aggregate_id, aggregate_version, last_sequence
      FROM aggregate_heads
      ORDER BY aggregate_type, aggregate_id
    `)
          .all() as ReadonlyArray<AggregateHeadRow>);
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

  const quarantineRows = input.connection
    .prepare(
      "SELECT projection_name, count(*) AS count FROM event_quarantine GROUP BY projection_name",
    )
    .all() as ReadonlyArray<QuarantineCountRow>;
  const derivedNames = new Set(
    input.projections
      .all()
      .filter((projection) => projection.derived === true)
      .map((projection) => projection.name),
  );
  let quarantineCount = 0;
  let authoritativeQuarantineCount = 0;
  const quarantinedDerived = new Set<string>();
  for (const row of quarantineRows) {
    quarantineCount += row.count;
    if (derivedNames.has(row.projection_name)) quarantinedDerived.add(row.projection_name);
    else authoritativeQuarantineCount += row.count;
  }
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
  const lagging = projections.some(
    (projection) => projection.lag > 0 && !derivedNames.has(projection.name),
  );
  const heldDerivedViews = projections
    .filter(
      (projection) =>
        derivedNames.has(projection.name) &&
        (projection.lag > 0 || quarantinedDerived.has(projection.name)),
    )
    .map((projection) => projection.name);

  return {
    status: {
      migrationVersion,
      journalHead,
      aggregateCount: verifiedAggregateCount ?? journalHeads.size,
      projections,
      quarantineCount,
      integrity: integrityOk ? "ok" : "failed",
      state: classifyState({
        invalid: issues.length > 0,
        quarantineCount: authoritativeQuarantineCount,
        lagging,
      }),
      ...(heldDerivedViews.length === 0 ? {} : { heldDerivedViews }),
      ...(compatibility.compatible ? {} : { recoveryReason: "journal-incompatible" as const }),
    },
    issues,
  };
}

/**
 * Checks the journal rows above an earlier verified watermark the way the full
 * walk checks every row: each aggregate continues without a version gap from
 * its last verified row, and its stored head names its newest row. Every
 * stored head must also name a journal row that exists. Returns the aggregate
 * count when all of that holds, or undefined so the caller runs the full
 * inspection, which classifies whatever is wrong. Rows at or below the
 * watermark were walked by an earlier start of this build, and any rewrite or
 * delete of a journal row clears the watermark.
 */
function verifiedTailAggregateCount(
  connection: SqliteConnection,
  verifiedThrough: number,
): number | undefined {
  const tail = connection
    .prepare(`
      SELECT aggregate_type, aggregate_id, aggregate_version, global_sequence
      FROM event_journal
      WHERE global_sequence > ?
      ORDER BY aggregate_type, aggregate_id, global_sequence
    `)
    .all(verifiedThrough) as ReadonlyArray<AggregateEventRow>;
  const lastVerifiedVersion = connection.prepare(`
    SELECT aggregate_version FROM event_journal
    WHERE aggregate_type = ? AND aggregate_id = ? AND global_sequence <= ?
    ORDER BY global_sequence DESC LIMIT 1
  `);
  const storedHead = connection.prepare(`
    SELECT aggregate_version, last_sequence FROM aggregate_heads
    WHERE aggregate_type = ? AND aggregate_id = ?
  `);
  for (let index = 0; index < tail.length;) {
    const first = tail[index];
    if (first === undefined) break;
    const prior = lastVerifiedVersion.get(
      first.aggregate_type,
      first.aggregate_id,
      verifiedThrough,
    ) as { readonly aggregate_version: number } | undefined;
    let expectedVersion = (prior?.aggregate_version ?? 0) + 1;
    let newest = first;
    for (; index < tail.length; index += 1) {
      const event = tail[index];
      if (
        event === undefined ||
        event.aggregate_type !== first.aggregate_type ||
        event.aggregate_id !== first.aggregate_id
      )
        break;
      if (event.aggregate_version !== expectedVersion) return undefined;
      expectedVersion += 1;
      newest = event;
    }
    const head = storedHead.get(first.aggregate_type, first.aggregate_id) as
      | { readonly aggregate_version: number; readonly last_sequence: number }
      | undefined;
    if (
      head === undefined ||
      head.aggregate_version !== newest.aggregate_version ||
      head.last_sequence !== newest.global_sequence
    )
      return undefined;
  }
  const unanchoredHead = connection
    .prepare(`
      SELECT 1 FROM aggregate_heads AS head
      WHERE NOT EXISTS (
        SELECT 1 FROM event_journal AS event
        WHERE event.aggregate_type = head.aggregate_type
          AND event.aggregate_id = head.aggregate_id
          AND event.global_sequence = head.last_sequence
          AND event.aggregate_version = head.aggregate_version
      )
      LIMIT 1
    `)
    .get();
  if (unanchoredHead !== undefined) return undefined;
  // The tail walk only visits aggregates with rows above the watermark, and
  // the watermark's triggers watch the journal, not aggregate_heads. A head
  // that went missing, or fell back to an older row, for an aggregate whose
  // rows are all verified would otherwise pass. Both reads below use the
  // journal's unique (type, id, version) index and decode no rows.
  const staleHead = connection
    .prepare(`
      SELECT 1 FROM aggregate_heads AS head
      WHERE EXISTS (
        SELECT 1 FROM event_journal AS event
        WHERE event.aggregate_type = head.aggregate_type
          AND event.aggregate_id = head.aggregate_id
          AND event.aggregate_version > head.aggregate_version
      )
      LIMIT 1
    `)
    .get();
  if (staleHead !== undefined) return undefined;
  const headCount = numberValue(
    connection.prepare("SELECT count(*) AS value FROM aggregate_heads").get(),
  );
  // Every head names an existing row of its own aggregate (checked above) and
  // heads are unique per aggregate, so equal counts mean no aggregate lacks one.
  const aggregateCount = numberValue(
    connection
      .prepare(
        "SELECT count(*) AS value FROM (SELECT DISTINCT aggregate_type, aggregate_id FROM event_journal)",
      )
      .get(),
  );
  if (aggregateCount !== headCount) return undefined;
  return headCount;
}

/**
 * Damage a full rebuild from the journal repairs without changing the journal.
 * Every issue here lives in a projection table (aggregate heads are one) or a
 * projection checkpoint. A failed SQLite integrity check, a version gap inside
 * the journal, or a journal row this build cannot decode is journal damage: a
 * rebuild would replay the same rows and cannot fix it, so it stays a refusal.
 */
const PROJECTION_ISSUE_KINDS: ReadonlySet<DatabaseVerificationIssue["kind"]> = new Set([
  "aggregate-head-mismatch",
  "aggregate-head-orphan",
  "checkpoint-ahead",
]);

export function damageIsProjectionOnly(verification: DatabaseVerification): boolean {
  return (
    verification.integrity === "ok" &&
    verification.issues.every((issue) => PROJECTION_ISSUE_KINDS.has(issue.kind))
  );
}

/**
 * Rebuilds the authoritative projections as one unit, then each derived view
 * on its own. A derived view that still cannot apply an event is quarantined
 * again and reported as held, without undoing the authoritative repair: no
 * authoritative projection depends on a derived one.
 */
export function rebuildAll(input: RebuildInput): RebuildResult {
  const ordered = orderByDependencies(input.projections.all());
  const authoritative = ordered.filter((projection) => projection.derived !== true);
  rebuildProjections({
    connection: input.connection,
    journal: input.journal,
    projections: authoritative,
    clock: input.clock,
  });
  const rebuilt = authoritative.map((projection) => projection.name);
  const held: Array<string> = [];
  for (const projection of ordered) {
    if (projection.derived !== true) continue;
    try {
      rebuildProjection({
        connection: input.connection,
        journal: input.journal,
        projection,
        clock: input.clock,
      });
      rebuilt.push(projection.name);
    } catch (error) {
      if (!(error instanceof ProjectionQuarantined)) throw error;
      held.push(projection.name);
    }
  }
  return {
    rebuilt,
    journalHead: input.journal.headSequence(),
    ...(held.length === 0 ? {} : { held }),
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
