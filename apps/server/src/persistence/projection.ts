import {
  ProjectionCheckpoint as ProjectionCheckpointSchema,
  ReplayCursor as ReplayCursorSchema,
  type EventEnvelope,
  type ProjectionCheckpoint,
  type ReplayCursor,
} from "@octant/contracts";
import { classifyCheckpoint } from "@octant/domain";
import { Data, Schema } from "effect";
import {
  classifySqliteFailure,
  isSqliteStorageFailure,
  ReplayEventInvalid,
  type ReplayFailureReason,
  type SqliteFailureKind,
} from "./journalErrors";
import type { Journal, JournalCompatibilityIssue } from "./journal";
import type { SqliteConnection, SqliteStatement } from "./sqlitePort";

export interface Projection {
  readonly name: string;
  readonly dependencies: ReadonlyArray<string>;
  reset(connection: SqliteConnection): void;
  apply(connection: SqliteConnection, event: EventEnvelope): void;
}

export class DuplicateProjectionRegistration extends Data.TaggedError(
  "DuplicateProjectionRegistration",
)<{ readonly projectionName: string }> {}

export class UnknownProjectionDependency extends Data.TaggedError("UnknownProjectionDependency")<{
  readonly projectionName: string;
  readonly dependencyName: string;
}> {}

export class CheckpointAheadOfJournal extends Data.TaggedError("CheckpointAheadOfJournal")<{
  readonly projectionName: string;
  readonly lastSequence: number;
  readonly journalHead: number;
}> {}

export class ProjectionApplicationFailed extends Data.TaggedError("ProjectionApplicationFailed")<{
  readonly projectionName: string;
  readonly eventId: string;
  readonly globalSequence: number;
}> {}

export class ProjectionStorageFailed extends Data.TaggedError("ProjectionStorageFailed")<{
  readonly projectionName: string;
  readonly operation: "catch-up" | "rebuild";
  readonly category: "busy" | "unavailable";
}> {}

export type QuarantineReason = ReplayFailureReason | "projection-application-failed";

interface QuarantinableEvent {
  readonly eventId: string;
  readonly globalSequence: number;
  readonly eventName: string;
  readonly eventVersion: number;
}

class ProjectionApplyFailure {
  constructor(readonly event: QuarantinableEvent) {}
}

export class ProjectionQuarantined extends Data.TaggedError("ProjectionQuarantined")<{
  readonly projectionName: string;
  readonly eventId: string;
  readonly globalSequence: number;
  readonly eventName: string;
  readonly eventVersion: number;
  readonly reason: QuarantineReason;
}> {}

export class ProjectionRegistry {
  readonly #projections = new Map<string, Projection>();

  register(projection: Projection): ProjectionRegistry {
    if (this.#projections.has(projection.name)) {
      throw new DuplicateProjectionRegistration({ projectionName: projection.name });
    }
    for (const dependency of projection.dependencies) {
      if (!this.#projections.has(dependency)) {
        throw new UnknownProjectionDependency({
          projectionName: projection.name,
          dependencyName: dependency,
        });
      }
    }
    this.#projections.set(projection.name, projection);
    return this;
  }

  all(): ReadonlyArray<Projection> {
    return [...this.#projections.values()];
  }

  get(name: string): Projection | undefined {
    return this.#projections.get(name);
  }
}

export function quarantineIncompatibleJournal(input: {
  readonly connection: SqliteConnection;
  readonly projections: ProjectionRegistry;
  readonly issue: JournalCompatibilityIssue;
  readonly clock: () => string;
}): never {
  const affected = input.projections.all();
  const first = affected[0];
  if (first === undefined) {
    throw new Error("journal compatibility requires a registered projection");
  }

  input.connection.transaction(() => {
    for (const projection of affected) {
      recordQuarantine(
        input.connection,
        projection.name,
        input.issue,
        input.issue.reason,
        input.clock(),
      );
    }
  })();

  throw new ProjectionQuarantined({
    projectionName: first.name,
    ...input.issue,
  });
}

interface CheckpointRow {
  readonly last_sequence: number;
  readonly updated_at: string;
}

interface ReplayInput {
  readonly connection: SqliteConnection;
  readonly journal: Journal;
  readonly projection: Projection;
  readonly clock: () => string;
  readonly batchSize?: number;
}

const decodeCheckpoint = Schema.decodeUnknownSync(ProjectionCheckpointSchema);
const decodeReplayCursor = Schema.decodeUnknownSync(ReplayCursorSchema);

export function catchUpProjection(input: ReplayInput): ProjectionCheckpoint {
  try {
    return catchUpProjectionUnsafe(input);
  } catch (error) {
    throwStorageFailure(input.projection.name, "catch-up", error);
  }
}

function catchUpProjectionUnsafe(input: ReplayInput): ProjectionCheckpoint {
  const batchSize = normalizeBatchSize(input.batchSize);
  const statements = checkpointStatements(input.connection);
  const journalHead = input.journal.headSequence();
  let current = readOrInitializeCheckpoint(input, statements);
  assertCheckpointIsValid(current, journalHead);

  while (current.lastSequence < journalHead) {
    let events: ReadonlyArray<EventEnvelope>;
    try {
      events = input.journal
        .replay(replayCursor(current.lastSequence, batchSize))
        .filter((event) => event.globalSequence <= journalHead);
    } catch (error) {
      if (!(error instanceof ReplayEventInvalid)) throw error;
      current = replayValidPrefixOneAtATime(input, statements, current, journalHead);
      try {
        input.journal.replay(replayCursor(current.lastSequence, 1));
      } catch (prefixError) {
        if (prefixError instanceof ReplayEventInvalid) {
          quarantine(input, prefixError, prefixError.reason);
        }
        throw prefixError;
      }
      continue;
    }
    if (events.length === 0) break;
    current = applyBatch(input, statements, events);
  }

  return current;
}

export function rebuildProjection(input: ReplayInput): ProjectionCheckpoint {
  const result = rebuildProjections({ ...input, projections: [input.projection] });
  const rebuilt = result[0];
  if (rebuilt === undefined) throw new Error("projection rebuild result missing");
  return rebuilt;
}

export function rebuildProjections(
  input: Omit<ReplayInput, "projection"> & { readonly projections: ReadonlyArray<Projection> },
): ReadonlyArray<ProjectionCheckpoint> {
  if (input.projections.length === 0) return [];
  let activeProjection = input.projections[0] as Projection;
  try {
    return input.connection.transaction(() =>
      input.projections.map((projection) => {
        activeProjection = projection;
        return rebuildProjectionInTransaction({ ...input, projection });
      }),
    )();
  } catch (error) {
    const activeInput = { ...input, projection: activeProjection };
    if (error instanceof ReplayEventInvalid) {
      quarantine(activeInput, error, error.reason);
    }
    if (error instanceof ProjectionApplyFailure) {
      quarantine(activeInput, error.event, "projection-application-failed");
    }
    throwStorageFailure(activeProjection.name, "rebuild", error);
  }
}

function rebuildProjectionInTransaction(input: ReplayInput): ProjectionCheckpoint {
  const batchSize = normalizeBatchSize(input.batchSize);
  const statements = checkpointStatements(input.connection);
  const journalHead = input.journal.headSequence();

  input.projection.reset(input.connection);
  statements.remove.run(input.projection.name);
  const initialUpdatedAt = input.clock();
  statements.upsert.run(input.projection.name, 0, initialUpdatedAt);
  let lastSequence = 0;
  let updatedAt = initialUpdatedAt;

  while (lastSequence < journalHead) {
    const events = input.journal
      .replay(replayCursor(lastSequence, batchSize))
      .filter((event) => event.globalSequence <= journalHead);
    if (events.length === 0) break;
    for (const event of events) {
      applyProjection(input.connection, input.projection, event);
      lastSequence = event.globalSequence;
      updatedAt = input.clock();
      statements.upsert.run(input.projection.name, lastSequence, updatedAt);
    }
  }

  const rebuilt = checkpoint(input.projection.name, lastSequence, updatedAt);
  if (rebuilt.lastSequence === journalHead) {
    input.connection
      .prepare("DELETE FROM event_quarantine WHERE projection_name = ?")
      .run(input.projection.name);
  }
  return rebuilt;
}

function replayValidPrefixOneAtATime(
  input: ReplayInput,
  statements: CheckpointStatements,
  start: ProjectionCheckpoint,
  journalHead: number,
): ProjectionCheckpoint {
  let current = start;
  while (current.lastSequence < journalHead) {
    let events: ReadonlyArray<EventEnvelope>;
    try {
      events = input.journal.replay(replayCursor(current.lastSequence, 1));
    } catch (error) {
      if (error instanceof ReplayEventInvalid) return current;
      throw error;
    }
    const event = events[0];
    if (event === undefined || event.globalSequence > journalHead) return current;
    current = applyBatch(input, statements, [event]);
  }
  return current;
}

function applyBatch(
  input: ReplayInput,
  statements: CheckpointStatements,
  events: ReadonlyArray<EventEnvelope>,
): ProjectionCheckpoint {
  try {
    return input.connection.transaction(() => {
      let current = checkpoint(
        input.projection.name,
        events[0]?.globalSequence ?? 0,
        input.clock(),
      );
      for (const event of events) {
        applyProjection(input.connection, input.projection, event);
        statements.upsert.run(input.projection.name, event.globalSequence, input.clock());
        current = checkpoint(input.projection.name, event.globalSequence, input.clock());
      }
      return current;
    })();
  } catch (error) {
    if (error instanceof ProjectionApplyFailure) {
      quarantine(input, error.event, "projection-application-failed");
    }
    throw error;
  }
}

interface CheckpointStatements {
  readonly select: SqliteStatement;
  readonly upsert: SqliteStatement;
  readonly remove: SqliteStatement;
}

function checkpointStatements(connection: SqliteConnection): CheckpointStatements {
  return {
    select: connection.prepare(`
      SELECT last_sequence, updated_at
      FROM projection_checkpoints
      WHERE projection_name = ?
    `),
    upsert: connection.prepare(`
      INSERT INTO projection_checkpoints (projection_name, last_sequence, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT (projection_name) DO UPDATE SET
        last_sequence = excluded.last_sequence,
        updated_at = excluded.updated_at
    `),
    remove: connection.prepare("DELETE FROM projection_checkpoints WHERE projection_name = ?"),
  };
}

function readOrInitializeCheckpoint(
  input: ReplayInput,
  statements: CheckpointStatements,
): ProjectionCheckpoint {
  const row = statements.select.get(input.projection.name) as CheckpointRow | undefined;
  if (row !== undefined) {
    return checkpoint(input.projection.name, row.last_sequence, row.updated_at);
  }
  const updatedAt = input.clock();
  input.connection.transaction(() => {
    statements.upsert.run(input.projection.name, 0, updatedAt);
  })();
  return checkpoint(input.projection.name, 0, updatedAt);
}

function checkpoint(
  projectionName: string,
  lastSequence: number,
  updatedAt: string,
): ProjectionCheckpoint {
  return decodeCheckpoint({ projectionName, lastSequence, updatedAt });
}

function replayCursor(afterSequence: number, limit: number): ReplayCursor {
  return decodeReplayCursor({ afterSequence, limit });
}

function assertCheckpointIsValid(value: ProjectionCheckpoint, journalHead: number): void {
  if (classifyCheckpoint(value.lastSequence, journalHead) === "invalid") {
    throw new CheckpointAheadOfJournal({
      projectionName: value.projectionName,
      lastSequence: value.lastSequence,
      journalHead,
    });
  }
}

function quarantine(
  input: ReplayInput,
  event: QuarantinableEvent,
  reason: QuarantineReason,
): never {
  const failure = new ProjectionQuarantined({
    projectionName: input.projection.name,
    eventId: event.eventId,
    globalSequence: event.globalSequence,
    eventName: event.eventName,
    eventVersion: event.eventVersion,
    reason,
  });
  input.connection.transaction(() => {
    recordQuarantine(input.connection, input.projection.name, event, reason, input.clock());
  })();
  throw failure;
}

function recordQuarantine(
  connection: SqliteConnection,
  projectionName: string,
  event: QuarantinableEvent,
  reason: QuarantineReason,
  observedAt: string,
): void {
  connection
    .prepare(`
      INSERT INTO event_quarantine (
        projection_name, global_sequence, event_id, reason, observed_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (projection_name, global_sequence) DO UPDATE SET
        event_id = excluded.event_id,
        reason = excluded.reason,
        observed_at = excluded.observed_at
    `)
    .run(projectionName, event.globalSequence, event.eventId, reason, observedAt);
}

function applyProjection(
  connection: SqliteConnection,
  projection: Projection,
  event: EventEnvelope,
): void {
  try {
    projection.apply(connection, event);
  } catch (error) {
    if (isSqliteStorageFailure(error)) throw error;
    throw new ProjectionApplyFailure(event);
  }
}

function throwStorageFailure(
  projectionName: string,
  operation: "catch-up" | "rebuild",
  error: unknown,
): never {
  const failureKind = classifySqliteFailure(error);
  if (isStorageFailure(failureKind)) {
    throw new ProjectionStorageFailed({
      projectionName,
      operation,
      category: failureKind === "write-race" ? "busy" : "unavailable",
    });
  }
  throw error;
}

function isStorageFailure(
  failureKind: SqliteFailureKind | undefined,
): failureKind is "write-race" | "storage" {
  return failureKind === "write-race" || failureKind === "storage";
}

function normalizeBatchSize(batchSize: number | undefined): number {
  if (batchSize === undefined) return 100;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) return 100;
  return batchSize;
}
