import {
  MAX_WORK_FILE_LISTING_DEPTH,
  MAX_WORK_FILE_LISTING_ENTRIES,
  decodeWorkFileListing,
  type WorkFileListing,
  type WorkFileListingArtifact,
  type WorkFileListingEntry,
  type WorkFileListingResult,
  type WorkThreadId,
} from "@octant/contracts";
import type { PreviewHostId } from "@octant/contracts/previews";
import type { ProjectId } from "@octant/contracts/projects";
import { canonicalizeWorkRelativePath, WorkConfinementRejected } from "@octant/domain";
import type { WorkArtifactEntry } from "./workArtifactProjection";
import type { WorkFilesystemPort } from "./workFilesystemPort";
import type { WorkFilePreviewTarget } from "./workFilePreviewRefs";
import {
  compareWorkPathNames,
  joinWorkPath,
  readContainedWorkDirectoryNames,
  resolveContainedWorkPath,
} from "./workPathConfinement";

/**
 * A Work folder is a person's documents directory, so the entries the platform
 * hides are the entries a person expects to be hidden. Skipping them is what
 * keeps `.DS_Store` and editor state out of a panel that exists to show the
 * work, and it is a display decision only: nothing here changes what Work may
 * read or write.
 */
function isHiddenName(name: string): boolean {
  return name.startsWith(".");
}

export interface WorkFileListingRequest {
  readonly threadId: WorkThreadId;
  readonly projectId: ProjectId;
  /** Canonical host path of the folder this thread's Project is bound to. */
  readonly rootPath: string;
  /** Subdirectory to list, relative to the bound folder. Absent lists the root. */
  readonly directory?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface WorkFileListingServiceOptions {
  readonly filesystem: WorkFilesystemPort;
  /**
   * Current artifacts for a Project, which is how a listed file learns it was
   * written by Work rather than merely found in the folder.
   */
  readonly artifactsForProject: (projectId: ProjectId) => ReadonlyArray<WorkArtifactEntry>;
  /**
   * Paths the Project's own turns observed changing in the bound folder. A
   * provider writes with its own tools and never calls the mutation service, so
   * without this most real output would list as a file the folder happened to
   * hold. These carry no artifact facts: watching sees a path change, never a
   * format or a version.
   */
  readonly pathsWrittenByTurns?: (projectId: ProjectId) => ReadonlyArray<string>;
  /**
   * Mints the path-free token a listed file is opened by. Absent on a host that
   * serves no preview, which lists files without making them openable.
   */
  readonly previewRefs?: {
    readonly hostId: PreviewHostId;
    mint(projectId: ProjectId, relativePath: string): WorkFilePreviewTarget;
  };
  readonly clock?: () => string;
  readonly maxEntries?: number;
  readonly maxDepth?: number;
}

interface PendingDirectory {
  readonly absolute: string;
  readonly relative: string;
  readonly depth: number;
}

/**
 * Bounded, read-only listing of the folder bound to a Work thread's Project.
 *
 * Every path this service touches runs the shared Work confinement sequence,
 * and every directory is enumerated through a handle whose identity must match
 * the object confinement resolved, so a symlink planted inside the folder can
 * never make the panel enumerate the rest of the host. Names come out of that
 * enumeration and are then re-resolved individually, which is what keeps an
 * entry from a directory swapped in mid-walk out of the result.
 *
 * The result never carries a host absolute path. Entries are relative to the
 * bound folder, which is the only location identity the renderer is entitled
 * to.
 *
 * Files Work wrote are ordered ahead of the rest of the folder, because the
 * question the panel answers first is "what did this produce". Within each
 * group the order is the walk's own stable name order, so a listing is
 * reproducible.
 */
export class WorkFileListingService {
  readonly #filesystem: WorkFilesystemPort;
  readonly #artifactsForProject: (projectId: ProjectId) => ReadonlyArray<WorkArtifactEntry>;
  readonly #pathsWrittenByTurns: ((projectId: ProjectId) => ReadonlyArray<string>) | undefined;
  readonly #previewRefs: WorkFileListingServiceOptions["previewRefs"];
  readonly #clock: () => string;
  readonly #maxEntries: number;
  readonly #maxDepth: number;

  constructor(options: WorkFileListingServiceOptions) {
    this.#filesystem = options.filesystem;
    this.#artifactsForProject = options.artifactsForProject;
    this.#pathsWrittenByTurns = options.pathsWrittenByTurns;
    this.#previewRefs = options.previewRefs;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#maxEntries = options.maxEntries ?? MAX_WORK_FILE_LISTING_ENTRIES;
    this.#maxDepth = options.maxDepth ?? MAX_WORK_FILE_LISTING_DEPTH;
  }

  async list(request: WorkFileListingRequest): Promise<WorkFileListingResult> {
    let relativeDirectory: string | undefined;
    if (request.directory !== undefined && request.directory !== "" && request.directory !== ".") {
      try {
        relativeDirectory = canonicalizeWorkRelativePath(request.directory);
      } catch (error) {
        if (error instanceof WorkConfinementRejected) {
          return failed("invalid", "That folder is not inside this Project's folder.");
        }
        throw error;
      }
    }

    const canonicalRoot = await this.#canonicalRoot(request.rootPath);
    if (canonicalRoot === undefined) {
      return failed("unavailable", "This Project's folder could not be read.");
    }

    const startAbsolute =
      relativeDirectory === undefined
        ? canonicalRoot
        : joinWorkPath(canonicalRoot, relativeDirectory);
    const start = await resolveContainedWorkPath(this.#filesystem, canonicalRoot, startAbsolute);
    if (start === undefined || !start.stat.isDirectory) {
      return failed("not-found", "That folder is not inside this Project's folder.");
    }

    const artifacts = this.#artifactIndex(request.projectId);
    const writtenByTurns = new Set(this.#pathsWrittenByTurns?.(request.projectId) ?? []);
    const entries: WorkFileListingEntry[] = [];
    const queue: PendingDirectory[] = [
      { absolute: start.canonical, relative: relativeDirectory ?? "", depth: 0 },
    ];
    let truncated = false;

    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      if (request.signal?.aborted === true)
        return failed("unavailable", "The listing was stopped.");
      if (entries.length >= this.#maxEntries) {
        truncated = true;
        break;
      }

      const identity = await resolveContainedWorkPath(
        this.#filesystem,
        canonicalRoot,
        current.absolute,
      );
      if (identity === undefined || !identity.stat.isDirectory) continue;

      // One more than the remaining budget, so a directory that overflows is
      // reported as truncated rather than silently cut at the boundary.
      const remaining = this.#maxEntries - entries.length;
      const names = await readContainedWorkDirectoryNames(
        this.#filesystem,
        identity.canonical,
        identity.stat,
        remaining + 1,
      );
      if (names === undefined) continue;
      if (names.length > remaining) truncated = true;

      for (const name of names.slice(0, remaining)) {
        if (isHiddenName(name)) continue;
        const childAbsolute = joinWorkPath(identity.canonical, name);
        const childRelative = current.relative === "" ? name : `${current.relative}/${name}`;
        const child = await resolveContainedWorkPath(
          this.#filesystem,
          canonicalRoot,
          childAbsolute,
        );
        if (child === undefined) continue;

        if (child.stat.isDirectory) {
          entries.push({ kind: "directory", path: childRelative });
          if (current.depth + 1 < this.#maxDepth) {
            queue.push({
              absolute: child.canonical,
              relative: childRelative,
              depth: current.depth + 1,
            });
          } else {
            truncated = true;
          }
          continue;
        }
        if (!child.stat.isFile) continue;

        const artifact = artifacts.get(childRelative);
        const authored = artifact !== undefined || writtenByTurns.has(childRelative);
        const preview = this.#previewRefs?.mint(request.projectId, childRelative);
        entries.push({
          kind: "file",
          path: childRelative,
          byteLength: child.stat.size,
          origin: authored ? "authored" : "untouched",
          ...(artifact === undefined ? {} : { artifact }),
          ...(preview === undefined ? {} : { preview }),
        });
      }
    }

    const listing: WorkFileListing = decodeWorkFileListing({
      kind: "work-file-listing",
      threadId: request.threadId,
      projectId: request.projectId,
      ...(relativeDirectory === undefined ? {} : { directory: relativeDirectory }),
      entries: orderWorkFirst(entries),
      ...(this.#previewRefs === undefined ? {} : { previewHostId: this.#previewRefs.hostId }),
      truncated,
      observedAt: this.#clock(),
    });
    return { status: "listed", listing };
  }

  async #canonicalRoot(rootPath: string): Promise<string | undefined> {
    try {
      const canonical = await this.#filesystem.realpath(rootPath);
      const stat = await this.#filesystem.stat(canonical);
      return stat.isDirectory ? canonical : undefined;
    } catch {
      return undefined;
    }
  }

  #artifactIndex(projectId: ProjectId): ReadonlyMap<string, WorkFileListingArtifact> {
    const index = new Map<string, WorkFileListingArtifact>();
    for (const artifact of this.#artifactsForProject(projectId)) {
      // A deleted artifact's path may since have been taken by an unrelated
      // file, so claiming Work wrote it would be a guess.
      if (artifact.deleted) continue;
      index.set(artifact.relativePath, {
        artifactId: artifact.artifactId,
        format: artifact.format,
        sequence: artifact.sequence,
      });
    }
    return index;
  }
}

/**
 * Files Work wrote, then everything else, each in the walk's stable name order.
 * Directories keep their place among the untouched entries: a folder is where
 * the rest of the work lives, not itself an output.
 */
function orderWorkFirst(
  entries: ReadonlyArray<WorkFileListingEntry>,
): ReadonlyArray<WorkFileListingEntry> {
  const authored = entries.filter((entry) => entry.kind === "file" && entry.origin === "authored");
  const rest = entries.filter((entry) => entry.kind !== "file" || entry.origin !== "authored");
  return [
    ...[...authored].sort((left, right) => compareWorkPathNames(left.path, right.path)),
    ...rest,
  ];
}

function failed(
  category: "invalid" | "unauthorized" | "unavailable" | "not-found",
  message: string,
): WorkFileListingResult {
  return { status: "failed", failure: { category, message } };
}
