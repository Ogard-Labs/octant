/**
 * Pure policy for mirroring artifacts to files.
 *
 * Where a copy goes, what it is called, whether it may be written, and what
 * happens when someone edits it are all decided here. Nothing in this module
 * touches a filesystem: every fact it reads was measured by the host, and every
 * answer it gives is a decision the host then carries out.
 *
 * The invariant it exists to hold: a file is output. There is exactly one path
 * from a file back into an artifact, and it appends a version rather than
 * replacing one.
 */

import type {
  ArtifactMirrorDestination,
  ArtifactMirrorSettings,
} from "@octant/contracts/artifact-mirror";
import type { OctantMode } from "@octant/contracts/modes";

export type MirrorRefusal =
  | "destination-unavailable"
  | "destination-unauthorized"
  | "project-not-bound"
  | "plan-mode-is-read-only";

export type ReimportRefusal =
  | "stale-version"
  | "file-missing"
  | "file-unreadable"
  | "file-not-a-bundle"
  | "file-unchanged";

/**
 * The destination one Project's artifacts use.
 *
 * A Project's own choice wins over the host-wide one, and the absence of both
 * is `internal-only` rather than an error — writing nothing is a valid, and the
 * default, answer.
 */
export function resolveArtifactDestination(
  settings: Pick<ArtifactMirrorSettings, "fallback" | "overrides">,
  projectId: string,
): ArtifactMirrorDestination {
  const override = settings.overrides.find(
    (candidate) => String(candidate.projectId) === String(projectId),
  );
  return override?.destination ?? settings.fallback;
}

export interface ArtifactBundleNaming {
  readonly canvasId: string;
  readonly title: string;
  readonly mode: OctantMode;
  readonly projectName: string;
}

export interface ArtifactBundlePaths {
  /** Where the files sit, relative to the destination's own root. */
  readonly directory: string;
  /** The structured bundle. This one is the artifact; the rest are for reading. */
  readonly bundle: string;
  /** Rendered companions, in the order they should be written. */
  readonly sidecars: ReadonlyArray<{ readonly path: string; readonly format: "svg" | "md" }>;
}

/**
 * What one artifact's files are called.
 *
 * The name carries the artifact's title so a folder is browsable, and a short
 * piece of its id so two artifacts with the same title do not fight over one
 * file. The id part is what makes the name stable enough to rewrite in place;
 * when a title changes the host writes the new name and removes the old one it
 * recorded, rather than leaving a second copy behind.
 *
 * A global folder is organized by Project, because that is the only grouping a
 * person outside Octant can see. A repository destination is not: the directory
 * the user chose is already the grouping they meant.
 */
export function artifactBundlePaths(
  naming: ArtifactBundleNaming,
  destination: ArtifactMirrorDestination,
): ArtifactBundlePaths | undefined {
  if (destination.kind === "internal-only") return undefined;
  const stem = `${slugify(naming.title, "artifact")}-${shortId(naming.canvasId)}`;
  const directory =
    destination.kind === "global-folder"
      ? slugify(naming.projectName, "project")
      : destination.relativeDirectory;
  return {
    directory,
    bundle: `${directory}/${stem}.octant.json`,
    sidecars: [
      { path: `${directory}/${stem}.md`, format: "md" },
      { path: `${directory}/${stem}.svg`, format: "svg" },
    ],
  };
}

export interface MirrorWriteFacts {
  readonly destination: ArtifactMirrorDestination;
  /** Whether the host could resolve a root to write into. */
  readonly destinationRootResolved: boolean;
  /** Whether the Project binds a repository, for a repository destination. */
  readonly projectBindsRepository: boolean;
  /**
   * Whether writing outside a bound root is approved for this destination.
   * Only a global folder can be outside one; a repository destination is
   * inside the root the Project already bound.
   */
  readonly outsideRootApproved: boolean;
  readonly planMode: boolean;
}

export type MirrorWriteDecision =
  | { readonly decision: "write" }
  | { readonly decision: "skip" }
  | { readonly decision: "refuse"; readonly reason: MirrorRefusal };

/**
 * Whether this revision may be materialized, right now.
 *
 * `internal-only` skips rather than refuses: nothing was asked for, so nothing
 * failed. Everything else names a state the user can fix. Plan mode refuses
 * because a mirror writes files, and read-only is a promise about the disk
 * rather than about the journal.
 */
export function decideMirrorWrite(facts: MirrorWriteFacts): MirrorWriteDecision {
  if (facts.destination.kind === "internal-only") return { decision: "skip" };
  if (facts.planMode) return { decision: "refuse", reason: "plan-mode-is-read-only" };
  if (facts.destination.kind === "project-repository" && !facts.projectBindsRepository) {
    return { decision: "refuse", reason: "project-not-bound" };
  }
  if (!facts.destinationRootResolved) {
    return { decision: "refuse", reason: "destination-unavailable" };
  }
  // A folder the user picked can be anywhere, so it is governed by the standing
  // approval for reaching outside a bound root. A repository destination is
  // already inside a root the Project bound, and needs no second grant.
  if (facts.destination.kind === "global-folder" && !facts.outsideRootApproved) {
    return { decision: "refuse", reason: "destination-unauthorized" };
  }
  return { decision: "write" };
}

export interface ReimportFacts {
  /** The artifact's current version, as the host reads it. */
  readonly currentVersionId: string;
  /** The version the caller believed was current. */
  readonly expectedVersionId: string;
  readonly file:
    | { readonly status: "missing" }
    | { readonly status: "unreadable" }
    | {
        readonly status: "read";
        /** Whether the bytes decode as a bundle of this very artifact. */
        readonly bundleForCanvasId: string | undefined;
        /** Whether the file differs from what the host last wrote there. */
        readonly changed: boolean;
      };
  readonly canvasId: string;
}

export type ReimportDecision =
  | { readonly decision: "append-version" }
  | { readonly decision: "refuse"; readonly reason: ReimportRefusal };

/**
 * Whether an edited file may be taken back in, and as what.
 *
 * There is only ever one answer to "taken in how": a new version. Nothing here
 * can return "overwrite", which is the point — a decision function that cannot
 * express the dangerous outcome cannot be talked into it.
 */
export function decideArtifactReimport(facts: ReimportFacts): ReimportDecision {
  if (facts.currentVersionId !== facts.expectedVersionId) {
    return { decision: "refuse", reason: "stale-version" };
  }
  if (facts.file.status === "missing") return { decision: "refuse", reason: "file-missing" };
  if (facts.file.status === "unreadable") return { decision: "refuse", reason: "file-unreadable" };
  // A bundle naming another artifact is not this artifact's file, however it
  // got there. Importing it would graft one document's content onto another's
  // history.
  if (
    facts.file.bundleForCanvasId === undefined ||
    String(facts.file.bundleForCanvasId) !== String(facts.canvasId)
  ) {
    return { decision: "refuse", reason: "file-not-a-bundle" };
  }
  if (!facts.file.changed) return { decision: "refuse", reason: "file-unchanged" };
  return { decision: "append-version" };
}

/** What the user is told when a mirror write is refused, in the words of the state. */
export function mirrorRefusalText(reason: MirrorRefusal): string {
  switch (reason) {
    case "destination-unavailable":
      return "The folder this Project mirrors to could not be read.";
    case "destination-unauthorized":
      return "Writing to that folder has not been approved.";
    case "project-not-bound":
      return "This Project binds no repository to mirror into.";
    case "plan-mode-is-read-only":
      return "Plan mode does not write files.";
  }
}

/** What the user is told when a re-import is refused. */
export function reimportRefusalText(reason: ReimportRefusal): string {
  switch (reason) {
    case "stale-version":
      return "This artifact changed since you looked. Read it again before importing.";
    case "file-missing":
      return "There is no mirrored file to import.";
    case "file-unreadable":
      return "The mirrored file could not be read.";
    case "file-not-a-bundle":
      return "That file is not this artifact's bundle.";
    case "file-unchanged":
      return "The file matches the current version. There is nothing to import.";
  }
}

/**
 * A filesystem-safe piece of a name.
 *
 * Titles are written by people and by providers, so they contain anything at
 * all. Collapsing to lowercase words joined by hyphens gives a name that is the
 * same on a case-insensitive filesystem and readable on any of them.
 */
function slugify(value: string, fallback: string): string {
  const slug = value
    .normalize("NFKD")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug.length === 0 ? fallback : slug;
}

function shortId(canvasId: string): string {
  const compact = canvasId.replace(/[^a-f0-9]/gi, "").toLocaleLowerCase("en-US");
  return compact.slice(0, 8).padEnd(8, "0");
}
