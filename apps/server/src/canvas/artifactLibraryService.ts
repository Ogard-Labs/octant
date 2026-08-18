import {
  MAX_ARTIFACT_LIBRARY_ENTRIES,
  decodeArtifactLibraryListing,
  type ArtifactLibraryEntry,
  type ArtifactLibraryListing,
  type ArtifactLibraryQuery,
} from "@octant/contracts/artifact-library";
import type { CanvasId, ProjectId, UtcTimestamp } from "@octant/contracts";
import { artifactKindForBlocks, selectArtifactLibraryEntries } from "@octant/domain";
import type { ClientPrincipal } from "../clientPrincipal";
import type { CanvasProjection } from "./canvasProjection";
import { renderArtifactThumbnail } from "./artifactRender";

/**
 * One Project as the library needs it: enough to name it and to decide whether
 * this caller may see what was made in it.
 */
export interface ArtifactLibraryProjectRecord {
  readonly id: ProjectId;
  readonly name: string;
  readonly type: "chat" | "work" | "code";
  readonly lifecycle: "active" | "archived";
}

export interface ArtifactLibraryServiceDependencies {
  readonly projection: Pick<CanvasProjection, "snapshot">;
  /** Every Project this host holds, as the Project service knows them. */
  readonly projects: () => ReadonlyArray<ArtifactLibraryProjectRecord>;
  /** The artifacts a share is live for right now. */
  readonly liveShares: () => ReadonlySet<string>;
  readonly clock: () => UtcTimestamp;
}

/**
 * The host-wide artifact library.
 *
 * This is the one read in Octant that deliberately crosses per-window Project
 * scoping: a person's artifacts are theirs, and a library that showed only the
 * Project a window happens to be looking at would not be a library. The scope
 * is the *host's*, not the window's, and the server decides it — a renderer
 * never assembles this list from Project reads it made itself.
 *
 * A paired device is clamped rather than admitted to that wider scope. It sees
 * artifacts and nothing about where they live on disk, and it never sees a
 * Project the remote catalog would not let it read.
 */
export class ArtifactLibraryService {
  readonly #dependencies: ArtifactLibraryServiceDependencies;

  constructor(dependencies: ArtifactLibraryServiceDependencies) {
    this.#dependencies = dependencies;
  }

  list(query: ArtifactLibraryQuery, principal: ClientPrincipal): ArtifactLibraryListing {
    const projects = new Map(
      this.#dependencies
        .projects()
        .filter((project) => this.#maySee(project, principal))
        .map((project) => [String(project.id), project]),
    );
    const shared = this.#dependencies.liveShares();

    const snapshot = this.#dependencies.projection.snapshot();
    const all: ArtifactLibraryEntry[] = [];
    for (const entry of snapshot.values()) {
      const definition = entry.currentVersion.definition;
      const project = projects.get(String(definition.provenance.projectId));
      // An artifact whose Project this caller may not see is absent, not
      // greyed out: the library must not disclose that it exists.
      if (project === undefined) continue;
      all.push({
        canvasId: entry.canvasId as CanvasId,
        projectId: definition.provenance.projectId,
        projectName: project.name,
        mode: definition.provenance.mode,
        kind: artifactKindForBlocks(definition.blocks),
        title: definition.title,
        versionCount: entry.versionCount,
        currentVersionId: entry.currentVersion.versionId,
        currentSequence: entry.currentVersion.sequence,
        updatedAt: entry.updatedAt,
        shared: shared.has(String(entry.canvasId)),
      });
    }

    const matched = selectArtifactLibraryEntries(all, query);
    const page = matched.slice(0, MAX_ARTIFACT_LIBRARY_ENTRIES).map((entry) => {
      const version = snapshot.get(entry.canvasId)?.currentVersion;
      const markup = version === undefined ? "" : renderArtifactThumbnail(version.definition);
      // A preview that could not be drawn is simply absent; the card falls back
      // to naming the artifact's kind rather than showing a broken picture.
      return markup === "" ? entry : { ...entry, preview: { format: "svg" as const, markup } };
    });

    const counts = new Map<string, number>();
    for (const entry of all) {
      counts.set(String(entry.projectId), (counts.get(String(entry.projectId)) ?? 0) + 1);
    }

    return decodeArtifactLibraryListing({
      kind: "artifact-library-listing",
      entries: page,
      projects: [...projects.values()]
        .map((project) => ({
          projectId: project.id,
          name: project.name,
          mode: project.type,
          artifactCount: counts.get(String(project.id)) ?? 0,
        }))
        .sort((left, right) => left.name.localeCompare(right.name, "en-US")),
      matchCount: matched.length,
      truncated: page.length < matched.length,
      generatedAt: this.#dependencies.clock(),
    });
  }

  /**
   * Whether this caller may see what was made in this Project.
   *
   * An archived Project keeps its artifacts readable — archiving a Project has
   * never deleted its work, and a library that hid them would be the first
   * place it looked like it had. A paired device is held to the modes the
   * remote catalog admits: it may read a Project overview, so it may see the
   * artifacts of a Project, and nothing here widens that.
   */
  #maySee(project: ArtifactLibraryProjectRecord, principal: ClientPrincipal): boolean {
    if (principal.kind === "local-window") return true;
    // A remote device reads; it never reaches a Project that is not active,
    // because an archived Project's bindings are not being maintained and a
    // companion cannot act on what it finds there.
    return project.lifecycle === "active";
  }
}
