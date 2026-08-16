import { canonicalizeWorkRelativePath } from "@octant/domain";
import type {
  WorkArtifactId,
  WorkArtifactFormat,
  WorkExportHandoffKind,
  WorkArtifactMutationFrame,
} from "@octant/contracts/work-artifacts";
import type { ProjectId } from "@octant/contracts/projects";
import type { PreviewSourceVersion } from "@octant/contracts/previews";

export interface WorkArtifactEntry {
  readonly artifactId: WorkArtifactId;
  readonly projectId: ProjectId;
  readonly format: WorkArtifactFormat;
  readonly artifactRef: string;
  readonly displayName: string;
  readonly relativePath: string;
  readonly sequence: number;
  readonly currentSourceVersion: PreviewSourceVersion;
  readonly deleted: boolean;
  readonly lastMutation: "created" | "revised" | "exported";
}

export interface WorkArtifactExportEntry {
  readonly exportId: string;
  readonly artifactId: WorkArtifactId;
  readonly projectId: ProjectId;
  readonly displayName: string;
  readonly exportFormat: WorkArtifactFormat;
  readonly handoffKind: WorkExportHandoffKind;
  readonly occurredAt: string;
  readonly sequence: number;
}

const MAX_RECORDED_EXPORTS_PER_PROJECT = 64;

/**
 * Rebuildable in-memory Work artifact projection. The mutation service
 * replays journaled `WorkArtifactMutationFrame` events into this projection
 * to reconstruct artifact identity, current version sequence, current source
 * version (for stale detection), confined relative path, and deletion state.
 * The projection is idempotent: replaying the same frame sequence produces
 * identical state, so reconnect or restart rebuilds artifact state from the
 * authoritative event journal without a separate store.
 */
export class WorkArtifactProjection {
  readonly #entries = new Map<WorkArtifactId, WorkArtifactEntry>();
  readonly #exports = new Map<string, WorkArtifactExportEntry>();

  apply(frame: WorkArtifactMutationFrame): void {
    switch (frame.outcome.kind) {
      case "created": {
        const artifact = frame.outcome.artifact;
        this.#entries.set(artifact.artifactId, {
          artifactId: artifact.artifactId,
          projectId: artifact.projectId,
          format: artifact.format,
          artifactRef: artifact.artifactRef,
          displayName: artifact.displayName,
          relativePath: relativePathFor(artifact.displayName),
          sequence: frame.outcome.version.sequence,
          currentSourceVersion: frame.outcome.version.sourceVersion,
          deleted: false,
          lastMutation: "created",
        });
        return;
      }
      case "revised": {
        const artifact = frame.outcome.artifact;
        const previous = this.#entries.get(artifact.artifactId);
        this.#entries.set(artifact.artifactId, {
          artifactId: artifact.artifactId,
          projectId: artifact.projectId,
          format: artifact.format,
          artifactRef: artifact.artifactRef,
          displayName: artifact.displayName,
          relativePath: relativePathFor(artifact.displayName),
          sequence: frame.outcome.version.sequence,
          currentSourceVersion: frame.outcome.version.sourceVersion,
          deleted: false,
          lastMutation: "revised",
        });
        void previous;
        return;
      }
      case "exported": {
        const handoff = frame.outcome.handoff;
        const previous = this.#entries.get(handoff.artifactId);
        if (previous === undefined) return;
        this.#recordExport({
          exportId: `${String(handoff.artifactId)}:export:${frame.sequence}`,
          artifactId: handoff.artifactId,
          projectId: frame.projectId,
          displayName:
            handoff.handoffKind === "in-app-version"
              ? handoff.previewTarget.displayName
              : previous.displayName,
          exportFormat: handoff.exportFormat,
          handoffKind: handoff.handoffKind,
          occurredAt: handoff.producedAt,
          sequence: frame.sequence,
        });
        if (frame.outcome.handoff.handoffKind === "in-app-version") {
          const produced = frame.outcome.handoff.producedVersion;
          const previewTarget = frame.outcome.handoff.previewTarget;
          this.#entries.set(produced.artifactId, {
            ...previous,
            format: produced.format,
            artifactRef: previewTarget.opaqueRef,
            displayName: previewTarget.displayName,
            relativePath: relativePathFor(previewTarget.displayName),
            sequence: produced.sequence,
            currentSourceVersion: produced.sourceVersion,
            lastMutation: "exported",
          });
          return;
        }
        // External-application handoff: the export overwrote the same confined
        // relative path and is handed to the native host rather than minted as
        // a parallel in-app version. The per-artifact sequence must still
        // advance in lockstep with the journal aggregate so the next mutation's
        // optimistic concurrency check (the service's expectedArtifactVersion
        // and the event store's expectedSequence) stays consistent after
        // replay; the opaque ref, confined path, and display name are unchanged
        // because no parallel path was created.
        this.#entries.set(handoff.artifactId, {
          ...previous,
          sequence: frame.sequence,
          lastMutation: "exported",
        });
        return;
      }
      case "deleted": {
        const previous = this.#entries.get(frame.outcome.artifactId);
        if (previous === undefined) return;
        this.#entries.set(frame.outcome.artifactId, {
          ...previous,
          sequence: frame.outcome.lastVersion.sequence,
          deleted: true,
        });
        return;
      }
    }
  }

  lookup(artifactId: WorkArtifactId): WorkArtifactEntry | undefined {
    return this.#entries.get(artifactId);
  }

  snapshot(): ReadonlyMap<WorkArtifactId, WorkArtifactEntry> {
    return new Map(this.#entries);
  }

  snapshotExports(projectId?: ProjectId): ReadonlyArray<WorkArtifactExportEntry> {
    return [...this.#exports.values()]
      .filter((entry) => projectId === undefined || entry.projectId === projectId)
      .sort(
        (left, right) =>
          right.occurredAt.localeCompare(left.occurredAt) ||
          right.sequence - left.sequence ||
          right.exportId.localeCompare(left.exportId),
      );
  }

  #recordExport(entry: WorkArtifactExportEntry): void {
    this.#exports.set(entry.exportId, entry);
    const projectExports = this.snapshotExports(entry.projectId);
    if (projectExports.length <= MAX_RECORDED_EXPORTS_PER_PROJECT) return;
    const oldest = projectExports.at(-1);
    if (oldest !== undefined) this.#exports.delete(oldest.exportId);
  }
}

function relativePathFor(displayName: string): string {
  return canonicalizeWorkRelativePath(displayName);
}
