import {
  IMAGE_JOB_QUEUED,
  IMAGE_JOB_STATUS_CHANGED,
  decodeImageJob,
  decodeImageJobId,
  decodeImageJobQueued,
  decodeImageJobStatusChanged,
  decodeImageGenerationScopeId,
  type EventEnvelope,
  type ImageArtifactId,
  type ImageGenerationScopeId,
  type ImageJob,
  type ImageJobId,
  type ImageJobStatus,
} from "@octant/contracts";
import { isImageJobTerminalStatus } from "@octant/domain";
import type { Projection } from "../persistence/projection";
import type { SqliteConnection } from "../persistence/sqlitePort";

/**
 * Rebuildable in-memory image-job projection. Restart hydration is journal
 * catch-up: a job still `running` after replay is the host's signal to fail it
 * honestly rather than invoke the provider again.
 */
export class ImageJobProjection implements Projection {
  readonly name = "image-jobs";
  readonly dependencies: ReadonlyArray<string> = [];
  readonly #byId = new Map<string, ImageJob>();

  reset(_connection: SqliteConnection): void {
    this.#byId.clear();
  }

  apply(_connection: SqliteConnection, event: EventEnvelope): void {
    if (event.eventVersion !== 1) return;
    if (event.eventName === IMAGE_JOB_QUEUED) {
      this.applyQueued(decodeImageJobQueued(event.payload).job);
      return;
    }
    if (event.eventName === IMAGE_JOB_STATUS_CHANGED) {
      const payload = decodeImageJobStatusChanged(event.payload);
      this.applyStatusChanged({
        jobId: payload.jobId,
        fromStatus: payload.fromStatus,
        toStatus: payload.toStatus,
        version: payload.version,
        updatedAt: payload.updatedAt,
        ...(payload.recoveryReason === undefined ? {} : { recoveryReason: payload.recoveryReason }),
        ...(payload.safetyRefusal === undefined ? {} : { safetyRefusal: payload.safetyRefusal }),
        ...(payload.failure === undefined ? {} : { failure: payload.failure }),
        ...(payload.artifacts === undefined ? {} : { artifacts: payload.artifacts }),
      });
    }
  }

  applyQueued(jobInput: ImageJob): void {
    const job = decodeImageJob(jobInput);
    const existing = this.#byId.get(String(job.id));
    if (existing !== undefined && existing.version >= job.version) return;
    this.#byId.set(String(job.id), job);
  }

  applyStatusChanged(input: {
    readonly jobId: ImageJobId;
    readonly fromStatus: ImageJobStatus;
    readonly toStatus: ImageJobStatus;
    readonly version: ImageJob["version"];
    readonly updatedAt: ImageJob["updatedAt"];
    readonly recoveryReason?: string;
    readonly safetyRefusal?: string;
    readonly failure?: ImageJob["failure"];
    readonly artifacts?: ImageJob["artifacts"];
  }): void {
    const jobId = decodeImageJobId(input.jobId);
    const existing = this.#byId.get(String(jobId));
    if (existing === undefined) return;
    if (existing.version >= input.version) return;
    const {
      safetyRefusal: _safetyRefusal,
      failure: _failure,
      artifacts: _artifacts,
      parentArtifactRef,
      ...rest
    } = existing;
    this.#byId.set(
      String(jobId),
      decodeImageJob({
        ...rest,
        ...(parentArtifactRef === undefined ? {} : { parentArtifactRef }),
        status: input.toStatus,
        version: input.version,
        updatedAt: input.updatedAt,
        artifacts: input.artifacts ?? [],
        ...(input.safetyRefusal === undefined ? {} : { safetyRefusal: input.safetyRefusal }),
        ...(input.failure === undefined ? {} : { failure: input.failure }),
      }),
    );
  }

  getById(jobId: ImageJobId): ImageJob | undefined {
    return this.#byId.get(String(decodeImageJobId(jobId)));
  }

  list(): ReadonlyArray<ImageJob> {
    return [...this.#byId.values()].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
  }

  listByScope(scopeId: ImageGenerationScopeId): ReadonlyArray<ImageJob> {
    const scope = String(decodeImageGenerationScopeId(scopeId));
    return this.list().filter((job) => String(job.scopeId) === scope);
  }

  listRunning(): ReadonlyArray<ImageJob> {
    return this.list().filter((job) => job.status === "running");
  }

  isFinalizedAttachmentReferenced(
    scopeId: ImageGenerationScopeId,
    attachmentId: ImageArtifactId,
  ): boolean {
    const scope = String(scopeId);
    const attachment = String(attachmentId);
    for (const job of this.#byId.values()) {
      if (String(job.scopeId) !== scope) continue;
      if (job.artifacts.some((artifact) => String(artifact.attachmentId) === attachment)) {
        return true;
      }
    }
    return false;
  }

  referencedAttachmentIds(): ReadonlyArray<{
    readonly scopeId: ImageGenerationScopeId;
    readonly attachmentId: ImageArtifactId;
  }> {
    const refs: Array<{
      readonly scopeId: ImageGenerationScopeId;
      readonly attachmentId: ImageArtifactId;
    }> = [];
    for (const job of this.#byId.values()) {
      if (isImageJobTerminalStatus(job.status) && job.status !== "completed") continue;
      for (const artifact of job.artifacts) {
        refs.push({ scopeId: job.scopeId, attachmentId: artifact.attachmentId });
      }
    }
    return refs;
  }
}
