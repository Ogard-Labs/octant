import {
  decodeCanvasCreated,
  decodeCanvasId,
  decodeCanvasVersion,
  decodeCanvasVersionAppended,
  decodeCanvasVersionId,
  type CanvasId,
  type CanvasVersion,
  type CanvasVersionId,
  type EventEnvelope,
  type ProjectId,
  type UtcTimestamp,
} from "@octant/contracts";
import type { Projection } from "../persistence/projection";
import type { SqliteConnection } from "../persistence/sqlitePort";
import { CANVAS_CREATED, CANVAS_VERSION_APPENDED } from "./canvasEventStore";

/**
 * Current projected state of a single Canvas. The latest immutable version
 * envelope is preserved alongside the full immutable history and provenance-
 * derived indexes so consumers can list, restore, and compare versions without
 * re-replaying the journal.
 */
export interface CanvasProjectionEntry {
  readonly canvasId: CanvasId;
  readonly currentVersion: CanvasVersion;
  readonly versions: ReadonlyArray<CanvasVersion>;
  readonly versionCount: number;
  readonly updatedAt: UtcTimestamp;
}

export interface CanvasProvenanceKey {
  readonly projectId: ProjectId;
  readonly threadId: string;
  readonly mode: "chat" | "work" | "code";
}

/**
 * Rebuildable in-memory Canvas projection. Replays journaled Canvas lifecycle
 * events into current Canvas state plus Project/thread provenance indexes.
 * Idempotent: duplicate or out-of-order older versions never roll state back.
 * A `reset` followed by replay rebuilds the projection identically from the
 * authoritative journal.
 */
export class CanvasProjection implements Projection {
  readonly name = "canvas";
  readonly dependencies: ReadonlyArray<string> = [];
  readonly #byId = new Map<CanvasId, CanvasProjectionEntry>();
  readonly #byProject = new Map<string, Set<CanvasId>>();
  readonly #byThread = new Map<string, Set<CanvasId>>();

  reset(_connection: SqliteConnection): void {
    this.clear();
  }

  apply(_connection: SqliteConnection, event: EventEnvelope): void {
    if (event.eventVersion !== 1) return;
    if (event.eventName === CANVAS_CREATED) {
      this.applyCreated(decodeCanvasCreated(event.payload));
      return;
    }
    if (event.eventName === CANVAS_VERSION_APPENDED) {
      this.applyVersionAppended(decodeCanvasVersionAppended(event.payload));
    }
  }

  applyCreated(payload: { readonly canvasId: CanvasId; readonly version: CanvasVersion }): void {
    const canvasId = decodeCanvasId(payload.canvasId);
    const version = decodeCanvasVersion(payload.version);
    const existing = this.#byId.get(canvasId);
    if (existing !== undefined && existing.currentVersion.sequence >= version.sequence) {
      return;
    }
    this.#index(canvasId, version, existing, version.createdAt);
  }

  applyVersionAppended(payload: {
    readonly canvasId: CanvasId;
    readonly version: CanvasVersion;
  }): void {
    const canvasId = decodeCanvasId(payload.canvasId);
    const version = decodeCanvasVersion(payload.version);
    const existing = this.#byId.get(canvasId);
    if (existing === undefined) return;
    if (existing.currentVersion.sequence >= version.sequence) return;
    this.#index(canvasId, version, existing, version.createdAt);
  }

  /**
   * Apply a decoded version envelope directly. Used by replay paths that
   * rebuild from a CanvasReplay event batch. Idempotent against stale or
   * duplicate versions.
   */
  applyVersion(canvasId: CanvasId, version: CanvasVersion): void {
    const id = decodeCanvasId(canvasId);
    const existing = this.#byId.get(id);
    if (existing !== undefined && existing.currentVersion.sequence >= version.sequence) {
      return;
    }
    this.#index(id, version, existing, version.createdAt);
  }

  getById(canvasId: CanvasId): CanvasProjectionEntry | undefined {
    return this.#byId.get(decodeCanvasId(canvasId));
  }

  getVersion(canvasId: CanvasId, versionId: CanvasVersionId): CanvasVersion | undefined {
    const entry = this.getById(canvasId);
    if (entry === undefined) return undefined;
    const id = String(decodeCanvasVersionId(versionId));
    return entry.versions.find((version) => String(version.versionId) === id);
  }

  byProject(projectId: ProjectId): ReadonlyArray<CanvasProjectionEntry> {
    const ids = this.#byProject.get(String(projectId));
    if (ids === undefined) return [];
    return this.#entriesFor(ids).sort((left, right) =>
      left.updatedAt < right.updatedAt ? -1 : left.updatedAt > right.updatedAt ? 1 : 0,
    );
  }

  byThread(key: CanvasProvenanceKey): ReadonlyArray<CanvasProjectionEntry> {
    const ids = this.#byThread.get(threadKey(key));
    if (ids === undefined) return [];
    return this.#entriesFor(ids).sort((left, right) =>
      left.updatedAt < right.updatedAt ? -1 : left.updatedAt > right.updatedAt ? 1 : 0,
    );
  }

  snapshot(): ReadonlyMap<CanvasId, CanvasProjectionEntry> {
    return new Map(this.#byId);
  }

  clear(): void {
    this.#byId.clear();
    this.#byProject.clear();
    this.#byThread.clear();
  }

  #index(
    canvasId: CanvasId,
    version: CanvasVersion,
    existing: CanvasProjectionEntry | undefined,
    updatedAt: UtcTimestamp,
  ): void {
    const versions = mergeVersions(existing?.versions ?? [], version);
    this.#byId.set(canvasId, {
      canvasId,
      currentVersion: version,
      versions,
      versionCount: versions.length,
      updatedAt,
    });
    const projectId = String(version.definition.provenance.projectId);
    const projectSet = this.#byProject.get(projectId) ?? new Set<CanvasId>();
    projectSet.add(canvasId);
    this.#byProject.set(projectId, projectSet);
    const tk = threadKey(toProvenanceKey(version));
    const threadSet = this.#byThread.get(tk) ?? new Set<CanvasId>();
    threadSet.add(canvasId);
    this.#byThread.set(tk, threadSet);
  }

  #entriesFor(ids: Set<CanvasId>): CanvasProjectionEntry[] {
    const entries: CanvasProjectionEntry[] = [];
    for (const id of ids) {
      const entry = this.#byId.get(id);
      if (entry !== undefined) entries.push(entry);
    }
    return entries;
  }
}

function mergeVersions(
  existing: ReadonlyArray<CanvasVersion>,
  version: CanvasVersion,
): ReadonlyArray<CanvasVersion> {
  const bySequence = new Map<number, CanvasVersion>();
  for (const candidate of existing) bySequence.set(candidate.sequence, candidate);
  bySequence.set(version.sequence, version);
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
}

function toProvenanceKey(version: CanvasVersion): CanvasProvenanceKey {
  const provenance = version.definition.provenance;
  return {
    projectId: provenance.projectId,
    threadId: String(provenance.threadId),
    mode: provenance.mode,
  };
}

function threadKey(key: CanvasProvenanceKey): string {
  return `${key.mode}:${String(key.projectId)}:${key.threadId}`;
}
