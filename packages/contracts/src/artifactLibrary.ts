/**
 * The host-wide artifact library.
 *
 * The per-Project canvas inventory answers "what did this Project make". The
 * library answers "what have I made", across every Project and mode on this
 * host. It is a read of the same journal-derived projection the inventory reads
 * — nothing here is a second source of truth, and nothing here depends on
 * whether an artifact was ever mirrored to a file.
 */

import { Schema } from "effect";
import { GuidString, NonNegativeInt, PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { CanvasId, CanvasVersionId } from "./canvas";
import { CANVAS_MAX_TAGS_PER_CANVAS, CanvasTagName } from "./canvasTags";
import { UtcTimestamp } from "./events";
import { OctantMode } from "./modes";
import { ProjectId } from "./projects";
import { ThreadPublishedSnapshot } from "./threadToolSteps";

export const MAX_ARTIFACT_LIBRARY_ENTRIES = 120;
export const MAX_ARTIFACT_PREVIEW_CHARACTERS = 4_096;

/**
 * What an artifact mostly is, derived from the blocks it carries.
 *
 * A Canvas has no declared type — it is a document of blocks — so this is a
 * reading of its content rather than a field someone set. It exists to make the
 * gallery filterable; nothing decides authority by it.
 */
export const ArtifactKind = Schema.Literals([
  "document",
  "diagram",
  "chart",
  "table",
  "code",
  "mixed",
]);
export type ArtifactKind = typeof ArtifactKind.Type;

/** The shapes and text the host's artifact renderer draws, and nothing else. */
const PREVIEW_ELEMENTS: ReadonlySet<string> = new Set([
  "svg",
  "g",
  "rect",
  "circle",
  "line",
  "path",
  "polygon",
  "polyline",
  "text",
]);

/** Presentation attributes only: none of these can name a URL or run script. */
const PREVIEW_ATTRIBUTES: ReadonlySet<string> = new Set([
  "xmlns",
  "viewBox",
  "role",
  "class",
  "transform",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "width",
  "height",
  "d",
  "points",
  "fill",
  "fill-opacity",
  "opacity",
  "stroke",
  "stroke-width",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "text-anchor",
  "dominant-baseline",
]);

const PREVIEW_TAG = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[a-zA-Z][a-zA-Z0-9:-]*="[^"<>]*")*)\s*\/?>/y;
const PREVIEW_ATTRIBUTE = /([a-zA-Z][a-zA-Z0-9:-]*)="([^"]*)"/g;

/**
 * Whether markup is an SVG the renderer could have drawn: allow-listed elements
 * and attributes, double-quoted values with no `url(`, and every `<` opening one
 * of those tags. Cards insert the markup as HTML, so a deny-list (the earlier
 * `<script` check) still let event-handler attributes, `javascript:` links,
 * `foreignObject`, and external references through.
 */
function isInertSvg(markup: string): boolean {
  if (!markup.startsWith("<svg")) return false;
  let index = 0;
  while ((index = markup.indexOf("<", index)) !== -1) {
    PREVIEW_TAG.lastIndex = index;
    const tag = PREVIEW_TAG.exec(markup);
    if (tag === null || !PREVIEW_ELEMENTS.has(tag[1] ?? "")) return false;
    for (const [, name = "", value = ""] of (tag[2] ?? "").matchAll(PREVIEW_ATTRIBUTE)) {
      const allowed = PREVIEW_ATTRIBUTES.has(name) || /^data-[a-z-]+$/.test(name);
      if (!allowed || /url\s*\(/i.test(value)) return false;
    }
    index = PREVIEW_TAG.lastIndex;
  }
  return true;
}

/**
 * A drawn preview of an artifact, rendered by the host.
 *
 * The markup is a self-contained SVG fragment with no external references, so a
 * card can draw it without fetching anything and without running script. The
 * contract enforces that shape rather than trusting every producer to keep it.
 */
export const ArtifactPreview = Schema.Struct({
  format: Schema.Literal("svg"),
  markup: Schema.String.check(
    Schema.isMaxLength(MAX_ARTIFACT_PREVIEW_CHARACTERS),
    Schema.makeFilter(isInertSvg),
  ),
});
export type ArtifactPreview = typeof ArtifactPreview.Type;

/** A computer's name, as it names itself in this person's replica. */
const ComputerName = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128));

/**
 * Where an artifact stands across this person's computers.
 *
 * `two-versions`: two computers revised the same version, or this computer's
 * version and another's both stand; neither wins until the person keeps one
 * or merges them. `deleted`: a deletion on another computer is all that is
 * left of it, and it can be restored.
 */
export const ArtifactSyncStatus = Schema.Literals(["current", "two-versions", "deleted"]);
export type ArtifactSyncStatus = typeof ArtifactSyncStatus.Type;

export const ArtifactLibraryEntry = Schema.Struct({
  canvasId: CanvasId,
  /**
   * The Project the Canvas was made in. Absent on a Canvas a Chat thread owns
   * outside every Project: such an entry is the person's alone to see, names
   * no Project, and opens in a Chat tab as the Canvas routes judge it.
   */
  projectId: Schema.optional(ProjectId),
  /** The Project's own name, so a card names a Project rather than an id. */
  projectName: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256))),
  mode: OctantMode,
  kind: ArtifactKind,
  title: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  versionCount: PositiveInt,
  currentVersionId: CanvasVersionId,
  currentSequence: PositiveInt,
  updatedAt: UtcTimestamp,
  /** Whether a share of this artifact is live right now. */
  shared: Schema.Boolean,
  /** The person's own tags on this Canvas, absent when it carries none. */
  tags: Schema.optional(
    Schema.Array(CanvasTagName).check(Schema.isMaxLength(CANVAS_MAX_TAGS_PER_CANVAS)),
  ),
  preview: Schema.optional(ArtifactPreview),
  /**
   * The computer that wrote the version shown. Present once this computer
   * belongs to a replica, or when the version came from another computer.
   */
  writtenOn: Schema.optional(ComputerName),
  /** Present only when sync has something to resolve; absent means current. */
  syncStatus: Schema.optional(ArtifactSyncStatus),
  /** The computer whose deletion is all that is left, when `syncStatus` is `deleted`. */
  deletedOn: Schema.optional(ComputerName),
});
export type ArtifactLibraryEntry = typeof ArtifactLibraryEntry.Type;

/**
 * An artifact another of this person's computers made, read from the replica
 * store and not bound to a thread here yet. It names the Project it was
 * filed under there and the computer that wrote its latest version, because
 * neither is a Project or a computer this host can open.
 */
export const ArtifactLibrarySyncedEntry = Schema.Struct({
  canvasId: CanvasId,
  /** The Project name on the computer that filed it. */
  projectName: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  /** The computer that wrote the head shown, as that computer names itself. */
  computerName: ComputerName,
  mode: OctantMode,
  kind: ArtifactKind,
  title: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  versionCount: PositiveInt,
  /**
   * How many heads its history has. Two computers that revised the same
   * version leave two; the person picks one or merges them.
   */
  headCount: PositiveInt,
  status: ArtifactSyncStatus,
  /** The computer whose deletion is all that is left, when `status` is `deleted`. */
  deletedOn: Schema.optional(ComputerName),
  updatedAt: UtcTimestamp,
  preview: Schema.optional(ArtifactPreview),
});
export type ArtifactLibrarySyncedEntry = typeof ArtifactLibrarySyncedEntry.Type;

/** Where a library entry came from: a Canvas document, or a page Claude published. */
export const ArtifactLibrarySource = Schema.Literals(["canvas", "claude"]);
export type ArtifactLibrarySource = typeof ArtifactLibrarySource.Type;

/** The kind a Claude page reads as when its publish named no Claude artifact type. */
export const CLAUDE_PLAIN_PAGE_TYPE = "Page";

const ClaudeArtifactType = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(64));
const ClaudeAccountId = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128));

/**
 * A page a Work or Code thread published to claude.ai through Claude's
 * `Artifact` tool, read from that thread's journal alone: Octant never
 * fetches claude.ai, so only pages published from Octant are listed. One
 * entry per page address; each later publish to the same address is a
 * version of it, and the entry shows the newest.
 */
export const ArtifactLibraryClaudeEntry = Schema.Struct({
  url: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2048)),
  title: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  /** The Claude artifact type its newest publish named; `Page` for a plain page. */
  artifactType: ClaudeArtifactType,
  /** The Claude account that published the newest version, when journaled. */
  account: Schema.optional(ClaudeAccountId),
  /** The account's display name, when the host still holds the account. */
  accountName: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256))),
  projectId: ProjectId,
  projectName: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  mode: Schema.Literals(["work", "code"]),
  threadId: GuidString,
  threadTitle: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256))),
  /** The tool call that published the newest version, which names its snapshot. */
  toolCallId: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2048)),
  versionCount: PositiveInt,
  publishedAt: UtcTimestamp,
  /** Present when the newest publish named a local file Octant kept a copy of. */
  snapshot: Schema.optional(Schema.Literals(["html", "markdown"])),
});
export type ArtifactLibraryClaudeEntry = typeof ArtifactLibraryClaudeEntry.Type;

/** One Claude account the library's Claude pages came from, for its filter. */
export const ArtifactLibraryClaudeAccount = Schema.Struct({
  account: ClaudeAccountId,
  name: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256))),
  pageCount: NonNegativeInt,
});
export type ArtifactLibraryClaudeAccount = typeof ArtifactLibraryClaudeAccount.Type;

/** One Project, as the library's filter offers it. */
export const ArtifactLibraryProject = Schema.Struct({
  projectId: ProjectId,
  name: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  mode: OctantMode,
  artifactCount: NonNegativeInt,
});
export type ArtifactLibraryProject = typeof ArtifactLibraryProject.Type;

/** One tag the library's artifacts carry, with how many artifacts carry it. */
export const ArtifactLibraryTag = Schema.Struct({
  name: CanvasTagName,
  artifactCount: NonNegativeInt,
});
export type ArtifactLibraryTag = typeof ArtifactLibraryTag.Type;

export const ArtifactLibraryTab = Schema.Literals(["all", "by-project", "by-tag", "shared"]);
export type ArtifactLibraryTab = typeof ArtifactLibraryTab.Type;

/**
 * What the caller asked the library for.
 *
 * The host applies every field itself. A renderer that filtered locally would
 * be filtering a list the host had already decided it may see, which is a
 * different and weaker thing.
 */
export const ArtifactLibraryQuery = Schema.Struct({
  tab: ArtifactLibraryTab,
  query: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256))),
  projectId: Schema.optional(ProjectId),
  mode: Schema.optional(OctantMode),
  kind: Schema.optional(ArtifactKind),
  /** One tag, matched exactly: the folder view of the person's own filing. */
  tag: Schema.optional(CanvasTagName),
  /** Canvas documents or Claude pages only; absent lists both. */
  source: Schema.optional(ArtifactLibrarySource),
  /** One Claude artifact type, matched exactly; only Claude pages match it. */
  claudeType: Schema.optional(ClaudeArtifactType),
  /** One Claude account; only Claude pages it published match it. */
  account: Schema.optional(ClaudeAccountId),
});
export type ArtifactLibraryQuery = typeof ArtifactLibraryQuery.Type;

export const ArtifactLibraryListing = Schema.Struct({
  kind: Schema.Literal("artifact-library-listing"),
  entries: Schema.Array(ArtifactLibraryEntry).check(
    Schema.makeFilter(
      (entries) =>
        entries.length <= MAX_ARTIFACT_LIBRARY_ENTRIES &&
        new Set(entries.map((entry) => String(entry.canvasId))).size === entries.length,
    ),
  ),
  /** Every Project the caller may see artifacts from, whether or not filtered. */
  projects: Schema.Array(ArtifactLibraryProject).check(
    Schema.makeFilter(
      (projects) =>
        new Set(projects.map((project) => String(project.projectId))).size === projects.length,
    ),
  ),
  /** Every tag this caller's artifacts carry, whether or not filtered. */
  tags: Schema.optional(
    Schema.Array(ArtifactLibraryTag).check(
      Schema.makeFilter((tags) => new Set(tags.map((tag) => tag.name)).size === tags.length),
    ),
  ),
  /**
   * Artifacts synced from this person's other computers and not bound here.
   * Only a window on this host sees them; a paired device does not.
   */
  synced: Schema.optional(
    Schema.Array(ArtifactLibrarySyncedEntry).check(
      Schema.isMaxLength(MAX_ARTIFACT_LIBRARY_ENTRIES),
    ),
  ),
  /**
   * Pages this caller's threads published to claude.ai, newest first, under
   * the same Project scoping as the entries. Absent when none match.
   */
  claude: Schema.optional(
    Schema.Array(ArtifactLibraryClaudeEntry).check(
      Schema.isMaxLength(MAX_ARTIFACT_LIBRARY_ENTRIES),
    ),
  ),
  /** How many Claude pages matched before the page ceiling. */
  claudeMatchCount: Schema.optional(NonNegativeInt),
  /** Every Claude account and artifact type this caller's Claude pages carry, whether or not filtered. */
  claudeAccounts: Schema.optional(Schema.Array(ArtifactLibraryClaudeAccount)),
  claudeTypes: Schema.optional(Schema.Array(ClaudeArtifactType)),
  /** How many artifacts matched before the page ceiling, so a cut list says so. */
  matchCount: NonNegativeInt,
  truncated: Schema.Boolean,
  generatedAt: UtcTimestamp,
})
  .check(
    Schema.makeFilter(
      (listing) => listing.truncated === listing.entries.length < listing.matchCount,
    ),
  )
  .check(Schema.makeFilter((listing) => listing.entries.length <= listing.matchCount));
export type ArtifactLibraryListing = typeof ArtifactLibraryListing.Type;

// ── Synced artifacts: provenance, two versions, and deletions ──────────────

/** One version in an artifact's synced history, with the computer that wrote it. */
export const ArtifactSyncedVersion = Schema.Struct({
  versionId: CanvasVersionId,
  title: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  computerName: ComputerName,
  /** Written on this computer rather than read in from another one. */
  thisComputer: Schema.Boolean,
  createdAt: UtcTimestamp,
  /** One of the versions the person chooses between, or the one standing. */
  candidate: Schema.Boolean,
  /** Drawn only for a candidate, so two can be compared side by side. */
  preview: Schema.optional(ArtifactPreview),
});
export type ArtifactSyncedVersion = typeof ArtifactSyncedVersion.Type;

/** A thread here that an artifact can be opened in without widening anything. */
export const ArtifactSyncedThread = Schema.Struct({
  threadId: GuidString,
  mode: OctantMode,
  projectId: ProjectId,
  projectName: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  title: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
});
export type ArtifactSyncedThread = typeof ArtifactSyncedThread.Type;

export const MAX_ARTIFACT_SYNCED_VERSIONS = 200;
export const MAX_ARTIFACT_SYNCED_THREADS = 50;

/** Everything the library's sync view shows for one artifact. */
export const MAX_ARTIFACT_BACKFILL_VERSIONS = 24;
export const ArtifactPublicationPreview = Schema.Struct({
  destination: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2048)),
  instanceId: Schema.NullOr(GuidString),
  previewToken: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  available: Schema.Boolean,
  versions: Schema.Array(
    Schema.Struct({
      versionId: CanvasVersionId,
      sequence: PositiveInt,
      byteLength: NonNegativeInt,
      status: Schema.Literals(["eligible", "excluded", "queued", "published"]),
      reason: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
    }),
  ).check(Schema.isMaxLength(200)),
  truncated: Schema.Boolean,
  deletionPending: Schema.Boolean,
  deletionAvailable: Schema.Boolean,
  deletionConflict: Schema.Boolean,
  backfill: Schema.optional(
    Schema.Struct({
      id: GuidString,
      state: Schema.Literals(["running", "stopped", "finished"]),
      done: NonNegativeInt,
      total: NonNegativeInt,
      restoreAvailable: Schema.optional(Schema.Boolean),
      message: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
    }),
  ),
});
export type ArtifactPublicationPreview = typeof ArtifactPublicationPreview.Type;

export const ArtifactSyncedDetail = Schema.Struct({
  kind: Schema.Literal("artifact-synced-detail"),
  canvasId: CanvasId,
  title: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  /** The Project it is filed under: here when it is open here, else where it came from. */
  projectName: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  mode: OctantMode,
  status: ArtifactSyncStatus,
  deletedOn: Schema.optional(ComputerName),
  /** Whether it is open in a thread on this computer. */
  openHere: Schema.Boolean,
  publication: Schema.optional(ArtifactPublicationPreview),
  /** Newest first. */
  versions: Schema.Array(ArtifactSyncedVersion).check(
    Schema.isMaxLength(MAX_ARTIFACT_SYNCED_VERSIONS),
  ),
  /**
   * Threads it may be opened in here. Empty when it is already open here or
   * when no thread on this computer is compatible.
   */
  threads: Schema.Array(ArtifactSyncedThread).check(
    Schema.isMaxLength(MAX_ARTIFACT_SYNCED_THREADS),
  ),
});
export type ArtifactSyncedDetail = typeof ArtifactSyncedDetail.Type;

/**
 * What a person can do with a synced artifact. Open binds it to a thread
 * here. Keep publishes a version that resolves two into the one chosen.
 * Merge opens a new version made from both through the revise path, so it
 * needs a thread when the artifact is not open here yet. Restore publishes a
 * version that supersedes a deletion.
 */
export const ArtifactSyncedCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("backfill"),
    canvasId: CanvasId,
    backfillId: GuidString,
    previewToken: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    versionIds: Schema.Array(CanvasVersionId).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(MAX_ARTIFACT_BACKFILL_VERSIONS),
    ),
    confirmed: Schema.Literal(true),
  }),
  Schema.Struct({
    kind: Schema.Literals(["pause-backfill", "resume-backfill"]),
    canvasId: CanvasId,
    backfillId: GuidString,
  }),
  Schema.Struct({
    kind: Schema.Literal("delete-synced"),
    canvasId: CanvasId,
    previewToken: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    confirmed: Schema.Literal(true),
  }),
  Schema.Struct({ kind: Schema.Literal("detail"), canvasId: CanvasId }),
  Schema.Struct({
    kind: Schema.Literal("open"),
    canvasId: CanvasId,
    threadId: GuidString,
  }),
  Schema.Struct({
    kind: Schema.Literal("keep"),
    canvasId: CanvasId,
    versionId: CanvasVersionId,
  }),
  Schema.Struct({
    kind: Schema.Literal("merge"),
    canvasId: CanvasId,
    threadId: Schema.optional(GuidString),
  }),
  Schema.Struct({ kind: Schema.Literal("restore"), canvasId: CanvasId }),
]);
export type ArtifactSyncedCommand = typeof ArtifactSyncedCommand.Type;

export const ArtifactSyncedRefusalReason = Schema.Literals([
  "stale-preview",
  "not-found",
  "no-compatible-thread",
  "incompatible-thread",
  "already-open-here",
  "thread-required",
  "not-two-versions",
  "unknown-version",
  "not-deleted",
  "sync-off",
  "refused",
]);
export type ArtifactSyncedRefusalReason = typeof ArtifactSyncedRefusalReason.Type;

export const ArtifactSyncedResult = Schema.Union([
  ArtifactSyncedDetail,
  Schema.Struct({
    kind: Schema.Literal("artifact-synced-opened"),
    /** The artifact as the library now lists it, open in the chosen thread. */
    entry: ArtifactLibraryEntry,
    /**
     * Blocks a merge left out: one that names a source the version it was
     * merged into does not list, or one past the block ceiling.
     */
    omittedBlocks: Schema.optional(PositiveInt),
  }),
  Schema.Struct({
    kind: Schema.Literal("artifact-synced-published"),
    canvasId: CanvasId,
    versionId: CanvasVersionId,
    /** False while the store cannot be reached: the version waits here and goes out later. */
    published: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("artifact-synced-refused"),
    reason: ArtifactSyncedRefusalReason,
    message: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  }),
]);
export type ArtifactSyncedResult = typeof ArtifactSyncedResult.Type;

export const decodeArtifactSyncedCommand = Schema.decodeUnknownSync(
  ArtifactSyncedCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeArtifactSyncedResult = Schema.decodeUnknownSync(
  ArtifactSyncedResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeArtifactLibraryQuery = Schema.decodeUnknownSync(
  ArtifactLibraryQuery,
  STRICT_DECODE_OPTIONS,
);
export const decodeArtifactLibraryEntry = Schema.decodeUnknownSync(
  ArtifactLibraryEntry,
  STRICT_DECODE_OPTIONS,
);
export const decodeArtifactLibraryListing = Schema.decodeUnknownSync(
  ArtifactLibraryListing,
  STRICT_DECODE_OPTIONS,
);

/** Asks for the copy Octant kept of a Claude page's published file. */
export const ArtifactLibraryClaudeSnapshotRequest = Schema.Struct({
  mode: Schema.Literals(["work", "code"]),
  threadId: GuidString,
  toolCallId: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(255)),
});
export type ArtifactLibraryClaudeSnapshotRequest = typeof ArtifactLibraryClaudeSnapshotRequest.Type;
export const decodeArtifactLibraryClaudeSnapshotRequest = Schema.decodeUnknownSync(
  ArtifactLibraryClaudeSnapshotRequest,
  STRICT_DECODE_OPTIONS,
);

/**
 * Copies a Claude page's kept HTML snapshot into a new Canvas in the
 * publishing thread's Project. The host reads the snapshot itself, under that
 * thread's read check, so nothing the request carries becomes the page; the
 * title is the one the person confirmed, never the page's own.
 */
export const ArtifactLibraryClaudeCopyRequest = Schema.Struct({
  mode: Schema.Literals(["work", "code"]),
  threadId: GuidString,
  toolCallId: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(255)),
  title: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256))),
});
export type ArtifactLibraryClaudeCopyRequest = typeof ArtifactLibraryClaudeCopyRequest.Type;
export const decodeArtifactLibraryClaudeCopyRequest = Schema.decodeUnknownSync(
  ArtifactLibraryClaudeCopyRequest,
  STRICT_DECODE_OPTIONS,
);

/** The kept copy, or why there is none this caller may read. */
export const ArtifactLibraryClaudeSnapshotResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("claude-snapshot"),
    snapshot: ThreadPublishedSnapshot,
  }),
  Schema.Struct({ kind: Schema.Literal("unavailable") }),
]);
export type ArtifactLibraryClaudeSnapshotResult = typeof ArtifactLibraryClaudeSnapshotResult.Type;
export const decodeArtifactLibraryClaudeSnapshotResult = Schema.decodeUnknownSync(
  ArtifactLibraryClaudeSnapshotResult,
  STRICT_DECODE_OPTIONS,
);
