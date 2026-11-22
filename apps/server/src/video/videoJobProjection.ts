import {
  VIDEO_JOB_AGGREGATE_TYPE,
  VIDEO_JOB_PROVIDER_COPY_CHANGED,
  VIDEO_JOB_QUEUED,
  VIDEO_JOB_STATUS_CHANGED,
  decodeVideoJobProviderCopyChanged,
  decodeVideoJobQueued,
  decodeVideoJobStatusChanged,
  type EventEnvelope,
  type ImageGenerationScopeId,
  type VideoJob,
  type VideoJobId,
  type VideoJobProviderCopyChanged,
  type VideoJobStatusChanged,
} from "@octant/contracts";
import type { Projection } from "../persistence/projection";
import type { SqliteConnection } from "../persistence/sqlitePort";

/**
 * Rebuildable in-memory video-job projection. Restart hydration is journal
 * catch-up: a job still `queued` or `running` after replay, and a provider
 * copy still `held`, is what restart recovery acts on.
 */
export class VideoJobProjection implements Projection {
  readonly name = "video-jobs";
  readonly dependencies: ReadonlyArray<string> = [];
  // Jobs live only in this map, so every host start replays them all, as for
  // image jobs: resuming from a checkpoint would hide the jobs recovery owns.
  readonly holdsStateInMemory = true as const;
  readonly aggregateTypes: ReadonlyArray<string> = [VIDEO_JOB_AGGREGATE_TYPE];
  readonly #byId = new Map<string, VideoJob>();

  reset(_connection: SqliteConnection): void {
    this.#byId.clear();
  }

  apply(_connection: SqliteConnection, event: EventEnvelope): void {
    if (event.eventVersion !== 1) return;
    switch (event.eventName) {
      case VIDEO_JOB_QUEUED:
        this.applyQueued(decodeVideoJobQueued(event.payload).job);
        return;
      case VIDEO_JOB_STATUS_CHANGED:
        this.applyStatusChanged(decodeVideoJobStatusChanged(event.payload));
        return;
      case VIDEO_JOB_PROVIDER_COPY_CHANGED:
        this.applyProviderCopyChanged(decodeVideoJobProviderCopyChanged(event.payload));
        return;
      default:
        return;
    }
  }

  applyQueued(job: VideoJob): void {
    this.#byId.set(String(job.id), job);
  }

  applyStatusChanged(change: VideoJobStatusChanged): void {
    const current = this.#byId.get(String(change.jobId));
    if (current === undefined || current.status !== change.fromStatus) return;
    this.#byId.set(String(change.jobId), {
      ...current,
      status: change.toStatus,
      version: change.version,
      updatedAt: change.updatedAt,
      ...(change.remoteId === undefined ? {} : { remoteId: change.remoteId }),
      ...(change.startedAt === undefined ? {} : { startedAt: change.startedAt }),
      ...(change.clip === undefined ? {} : { clip: change.clip }),
      ...(change.safetyRefusal === undefined ? {} : { safetyRefusal: change.safetyRefusal }),
      ...(change.failure === undefined ? {} : { failure: change.failure }),
      ...(change.providerCopy === undefined ? {} : { providerCopy: change.providerCopy }),
      ...(change.settledCostUsdMicros === undefined
        ? {}
        : { settledCostUsdMicros: change.settledCostUsdMicros }),
    });
  }

  applyProviderCopyChanged(change: VideoJobProviderCopyChanged): void {
    const current = this.#byId.get(String(change.jobId));
    if (current === undefined) return;
    this.#byId.set(String(change.jobId), {
      ...current,
      providerCopy: change.providerCopy,
      version: change.version,
      updatedAt: change.updatedAt,
    });
  }

  getById(id: VideoJobId): VideoJob | undefined {
    return this.#byId.get(String(id));
  }

  listByScope(scopeId: ImageGenerationScopeId): ReadonlyArray<VideoJob> {
    return [...this.#byId.values()]
      .filter((job) => String(job.scopeId) === String(scopeId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Jobs that have not reached a terminal state. */
  listUnfinished(): ReadonlyArray<VideoJob> {
    return [...this.#byId.values()].filter(
      (job) => job.status === "queued" || job.status === "running",
    );
  }

  /** Finished jobs whose provider copy the host still owes a removal. */
  listOwedRemovals(): ReadonlyArray<VideoJob> {
    return [...this.#byId.values()].filter(
      (job) =>
        job.providerCopy === "held" &&
        job.remoteId !== undefined &&
        job.status !== "queued" &&
        job.status !== "running",
    );
  }

  countQueued(): number {
    let queued = 0;
    for (const job of this.#byId.values()) if (job.status === "queued") queued += 1;
    return queued;
  }
}
