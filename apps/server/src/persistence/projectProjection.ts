import {
  decodeMemoryEntry,
  decodeMemoryEntryCreated,
  decodeMemoryEntryRetracted,
  decodeMemoryEntrySuperseded,
  decodeMemoryEntryTransferred,
  decodeProject,
  decodeProjectBindingRelinked,
  decodeCodeProjectAccessChanged,
  decodeCodeProjectNewThreadWorkspaceChanged,
  decodeCodeProjectPullRequestBackgroundRefreshChanged,
  decodeProjectCreated,
  decodeProjectId,
  decodeProjectLifecycleChanged,
  decodeProjectMemoryView,
  decodeProjectOrderChanged,
  decodeProjectRenamed,
  type EventEnvelope,
  type MemoryEntry,
  type MemoryEntryId,
  type Project,
  type ProjectId,
  type ProjectLifecycle,
  type ProjectMemoryView,
  type ProjectType,
} from "@octant/contracts";
import { compareProjectOrder } from "@octant/domain";
import type { Projection } from "./projection";
import {
  assertProjectProjectionSchema,
  PROJECT_PROJECTION_SCHEMA_VERSION,
  type ProjectMemoryProjectionRow,
  type ProjectProjectionRow,
} from "./projectPersistenceSchema";
import type { SqliteConnection, SqliteStatement } from "./sqlitePort";

export interface ProjectReadFilter {
  readonly type?: ProjectType;
  readonly lifecycle?: ProjectLifecycle;
}

export class ProjectProjection implements Projection {
  readonly name = "projects";
  readonly dependencies: ReadonlyArray<string> = ["aggregate-heads"];
  #projectUpsertByConnection = new WeakMap<SqliteConnection, SqliteStatement>();
  #memoryUpsertByConnection = new WeakMap<SqliteConnection, SqliteStatement>();
  #memoryVersionByConnection = new WeakMap<SqliteConnection, SqliteStatement>();

  reset(connection: SqliteConnection): void {
    connection.exec(`
      DELETE FROM project_memory_projection;
      DELETE FROM project_projection;
    `);
  }

  apply(connection: SqliteConnection, event: EventEnvelope): void {
    if (isProjectEvent(event.eventName)) {
      assertEnvelope(event.eventVersion === 1 && event.aggregateType === "project");
      const project = decodeProjectPayload(event);
      assertEnvelope(
        String(project.id) === String(event.aggregateId) &&
          project.version === event.aggregateVersion,
      );
      this.#upsertProject(connection, project, event.aggregateVersion);
      return;
    }

    if (isMemoryEvent(event.eventName)) {
      assertEnvelope(event.eventVersion === 1 && event.aggregateType === "project-memory");
      const entries = decodeMemoryPayload(event);
      assertEnvelope(
        entries.every((entry) => String(entry.projectId) === String(event.aggregateId)),
      );
      const currentVersion = this.#memoryAggregateVersion(connection, event.aggregateId);
      if (currentVersion !== undefined && event.aggregateVersion <= currentVersion) return;
      for (const entry of entries) this.#upsertMemory(connection, entry, event.aggregateVersion);
    }
  }

  #memoryAggregateVersion(connection: SqliteConnection, projectId: string): number | undefined {
    let statement = this.#memoryVersionByConnection.get(connection);
    if (statement === undefined) {
      statement = connection.prepare(`
        SELECT max(aggregate_version) AS aggregate_version
        FROM project_memory_projection
        WHERE project_id = ?
      `);
      this.#memoryVersionByConnection.set(connection, statement);
    }
    const row = statement.get(projectId) as { readonly aggregate_version: number | null };
    if (row.aggregate_version === null) return undefined;
    assertEnvelope(Number.isSafeInteger(row.aggregate_version) && row.aggregate_version > 0);
    return row.aggregate_version;
  }

  #upsertProject(connection: SqliteConnection, project: Project, aggregateVersion: number): void {
    let statement = this.#projectUpsertByConnection.get(connection);
    if (statement === undefined) {
      statement = connection.prepare(`
        INSERT INTO project_projection (
          project_id, schema_version, project_type, lifecycle, pinned,
          project_json, aggregate_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (project_id) DO UPDATE SET
          schema_version = excluded.schema_version,
          project_type = excluded.project_type,
          lifecycle = excluded.lifecycle,
          pinned = excluded.pinned,
          project_json = excluded.project_json,
          aggregate_version = excluded.aggregate_version
        WHERE excluded.aggregate_version > project_projection.aggregate_version
      `);
      this.#projectUpsertByConnection.set(connection, statement);
    }
    statement.run(
      project.id,
      PROJECT_PROJECTION_SCHEMA_VERSION,
      project.type,
      project.lifecycle,
      project.pinned ? 1 : 0,
      JSON.stringify(project),
      aggregateVersion,
    );
  }

  #upsertMemory(connection: SqliteConnection, entry: MemoryEntry, aggregateVersion: number): void {
    let statement = this.#memoryUpsertByConnection.get(connection);
    if (statement === undefined) {
      statement = connection.prepare(`
        INSERT INTO project_memory_projection (
          project_id, entry_id, schema_version, status, memory_kind,
          entry_json, aggregate_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (project_id, entry_id) DO UPDATE SET
          schema_version = excluded.schema_version,
          status = excluded.status,
          memory_kind = excluded.memory_kind,
          entry_json = excluded.entry_json,
          aggregate_version = excluded.aggregate_version
        WHERE excluded.aggregate_version > project_memory_projection.aggregate_version
      `);
      this.#memoryUpsertByConnection.set(connection, statement);
    }
    statement.run(
      entry.projectId,
      entry.id,
      PROJECT_PROJECTION_SCHEMA_VERSION,
      entry.status,
      entry.kind,
      JSON.stringify(entry),
      aggregateVersion,
    );
  }
}

const projectDecoders = {
  "project.created@1": (payload: unknown) => decodeProjectCreated(payload).project,
  "project.renamed@1": (payload: unknown) => decodeProjectRenamed(payload).project,
  "project.order-changed@1": (payload: unknown) => decodeProjectOrderChanged(payload).project,
  "project.lifecycle-changed@1": (payload: unknown) =>
    decodeProjectLifecycleChanged(payload).project,
  "project.binding-relinked@1": (payload: unknown) => decodeProjectBindingRelinked(payload).project,
  "project.code-access-changed@1": (payload: unknown) =>
    decodeCodeProjectAccessChanged(payload).project,
  "project.code-new-thread-workspace-changed@1": (payload: unknown) =>
    decodeCodeProjectNewThreadWorkspaceChanged(payload).project,
  "project.code-pull-request-background-refresh-changed@1": (payload: unknown) =>
    decodeCodeProjectPullRequestBackgroundRefreshChanged(payload).project,
} as const;

const memoryDecoders = {
  "memory.entry-created@1": (payload: unknown) => [decodeMemoryEntryCreated(payload).entry],
  "memory.entry-superseded@1": (payload: unknown) => {
    const decoded = decodeMemoryEntrySuperseded(payload);
    return [decoded.previousEntry, decoded.entry];
  },
  "memory.entry-retracted@1": (payload: unknown) => [decodeMemoryEntryRetracted(payload).entry],
  "memory.entry-transferred@1": (payload: unknown) => [decodeMemoryEntryTransferred(payload).entry],
} as const;

function isProjectEvent(eventName: string): eventName is keyof typeof projectDecoders {
  return eventName in projectDecoders;
}

function isMemoryEvent(eventName: string): eventName is keyof typeof memoryDecoders {
  return eventName in memoryDecoders;
}

function decodeProjectPayload(event: EventEnvelope): Project {
  return projectDecoders[event.eventName as keyof typeof projectDecoders](event.payload);
}

function decodeMemoryPayload(event: EventEnvelope): ReadonlyArray<MemoryEntry> {
  return memoryDecoders[event.eventName as keyof typeof memoryDecoders](event.payload);
}

function assertEnvelope(condition: boolean): asserts condition {
  if (!condition) throw new Error("Project projection event envelope is inconsistent");
}

export function readProject(
  connection: SqliteConnection,
  projectId: ProjectId,
): Project | undefined {
  const row = connection
    .prepare(`
      SELECT project_id, schema_version, project_type, lifecycle, pinned,
             project_json, aggregate_version
      FROM project_projection
      WHERE project_id = ?
    `)
    .get(projectId) as ProjectProjectionRow | undefined;
  return row === undefined ? undefined : decodeProjectRow(row);
}

export function readProjects(
  connection: SqliteConnection,
  filter: ProjectReadFilter = {},
): ReadonlyArray<Project> {
  const rows = connection
    .prepare(`
      SELECT project_id, schema_version, project_type, lifecycle, pinned,
             project_json, aggregate_version
      FROM project_projection
      WHERE (? IS NULL OR project_type = ?)
        AND (? IS NULL OR lifecycle = ?)
    `)
    .all(
      filter.type ?? null,
      filter.type ?? null,
      filter.lifecycle ?? null,
      filter.lifecycle ?? null,
    ) as ReadonlyArray<ProjectProjectionRow>;
  return rows.map(decodeProjectRow).sort(compareProjectOrder);
}

export function searchProjects(
  connection: SqliteConnection,
  query: string,
  filter: ProjectReadFilter = {},
): ReadonlyArray<Project> {
  const normalized = query.trim().toLowerCase();
  const projects = readProjects(connection, filter);
  if (normalized.length === 0) return projects;
  return projects.filter((project) =>
    [project.name, project.type, project.type === "chat" ? "" : project.binding.canonicalRoot].some(
      (value) => value.toLowerCase().includes(normalized),
    ),
  );
}

export function readMemoryEntry(
  connection: SqliteConnection,
  projectId: ProjectId,
  entryId: MemoryEntryId,
): MemoryEntry | undefined {
  const row = connection
    .prepare(`
      SELECT project_id, entry_id, schema_version, status, memory_kind,
             entry_json, aggregate_version
      FROM project_memory_projection
      WHERE project_id = ? AND entry_id = ?
    `)
    .get(projectId, entryId) as ProjectMemoryProjectionRow | undefined;
  return row === undefined ? undefined : decodeMemoryRow(row);
}

export function readProjectMemory(
  connection: SqliteConnection,
  projectId: ProjectId,
): ProjectMemoryView {
  const rows = connection
    .prepare(`
      SELECT project_id, entry_id, schema_version, status, memory_kind,
             entry_json, aggregate_version
      FROM project_memory_projection
      WHERE project_id = ?
      ORDER BY entry_id
    `)
    .all(projectId) as ReadonlyArray<ProjectMemoryProjectionRow>;
  const entries = rows.map(decodeMemoryRow);
  return decodeProjectMemoryView({
    projectId: decodeProjectId(projectId),
    active: entries.filter((entry) => entry.status === "active"),
    history: entries.filter((entry) => entry.status !== "active"),
  });
}

function decodeProjectRow(row: ProjectProjectionRow): Project {
  assertProjectProjectionSchema(row.schema_version);
  const project = decodeProject(JSON.parse(row.project_json));
  assertEnvelope(
    project.id === row.project_id &&
      project.type === row.project_type &&
      project.lifecycle === row.lifecycle &&
      project.pinned === (row.pinned === 1) &&
      project.version === row.aggregate_version,
  );
  return project;
}

function decodeMemoryRow(row: ProjectMemoryProjectionRow): MemoryEntry {
  assertProjectProjectionSchema(row.schema_version);
  const entry = decodeMemoryEntry(JSON.parse(row.entry_json));
  assertEnvelope(
    entry.projectId === row.project_id &&
      entry.id === row.entry_id &&
      entry.status === row.status &&
      entry.kind === row.memory_kind,
  );
  return entry;
}
