import { Schema } from "effect";
import { UtcTimestamp } from "./events";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const HostPath = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4096));
const CommitHash = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{40,64}$/));

/**
 * A Git worktree on this computer that Octant did not make: one row in
 * Settings › Code › Worktrees on this computer. `delivered` says its commit is
 * on a remote-tracking branch or another local branch, and is absent when Git
 * could not tell. A size is a bounded walk; `sizeComplete` is false when the
 * real size is larger.
 */
export const HostWorktree = Schema.Struct({
  path: HostPath,
  branch: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255))),
  detached: Schema.Boolean,
  locked: Schema.Boolean,
  missing: Schema.Boolean,
  delivered: Schema.optional(Schema.Boolean),
  lastActivityAt: Schema.optional(UtcTimestamp),
  sizeBytes: Schema.optional(Schema.NonNegativeInt),
  sizeComplete: Schema.optional(Schema.Boolean),
}).annotations(strict);
export type HostWorktree = typeof HostWorktree.Type;

export const HostWorktreeRepository = Schema.Struct({
  path: HostPath,
  worktrees: Schema.Array(HostWorktree).pipe(Schema.maxItems(1_000)),
}).annotations(strict);
export type HostWorktreeRepository = typeof HostWorktreeRepository.Type;

export const HostWorktreeScan = Schema.Struct({
  kind: Schema.Literal("host-worktrees"),
  /** Absent until this host has scanned once since it started. */
  scannedAt: Schema.optional(UtcTimestamp),
  /** False when the walk stopped at its bound before reading the whole home folder. */
  complete: Schema.Boolean,
  repositories: Schema.Array(HostWorktreeRepository).pipe(Schema.maxItems(2_000)),
  problems: Schema.Array(Schema.String.pipe(Schema.maxLength(600))).pipe(Schema.maxItems(200)),
}).annotations(strict);
export type HostWorktreeScan = typeof HostWorktreeScan.Type;

/**
 * Removing carries `confirmed: true`, and repeats the unpushed commits and
 * recent use the host asked about; the host works both out again and asks
 * once more when anything changed.
 */
export const RemoveHostWorktreeRequest = Schema.Struct({
  repositoryPath: HostPath,
  worktreePath: HostPath,
  confirmed: Schema.Literal(true),
  confirmedCommits: Schema.optional(Schema.Array(CommitHash).pipe(Schema.maxItems(200))),
  confirmedRecentActivity: Schema.optional(Schema.Boolean),
}).annotations(strict);
export type RemoveHostWorktreeRequest = typeof RemoveHostWorktreeRequest.Type;

export const HostWorktreeRefusalReason = Schema.Literal(
  "malformed",
  "unauthorized",
  "not-found",
  "main-worktree",
  "bare",
  "locked",
  "owned-by-octant",
  "linked-elsewhere",
  "broken-link",
  "runs-filters",
  "unreadable",
  "dirty",
  "detached-commits",
  "git-refused",
);
export type HostWorktreeRefusalReason = typeof HostWorktreeRefusalReason.Type;

export const UnpushedCommit = Schema.Struct({
  hash: CommitHash,
  subject: Schema.String.pipe(Schema.maxLength(200)),
}).annotations(strict);
export type UnpushedCommit = typeof UnpushedCommit.Type;

export const RemoveHostWorktreeResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("host-worktree-removed", "host-worktree-forgotten"),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("host-worktree-needs-confirmation"),
    reason: Schema.Literal("unpushed-commits", "recently-active"),
    /** Every counted commit; the window shows the first few and confirms them all. */
    commits: Schema.optional(Schema.Array(UnpushedCommit).pipe(Schema.maxItems(200))),
    commitCount: Schema.optional(Schema.NonNegativeInt),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("host-worktree-refused"),
    reason: HostWorktreeRefusalReason,
    message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(600)),
  }).annotations(strict),
);
export type RemoveHostWorktreeResult = typeof RemoveHostWorktreeResult.Type;

/** A build folder in Xcode's DerivedData that nothing will use again, or nothing has for 30 days. */
export const XcodeBuildData = Schema.Struct({
  name: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
  workspacePath: Schema.optional(HostPath),
  lastAccessedAt: Schema.optional(UtcTimestamp),
  state: Schema.Literal("orphaned", "unused"),
  sizeBytes: Schema.optional(Schema.NonNegativeInt),
  sizeComplete: Schema.optional(Schema.Boolean),
}).annotations(strict);
export type XcodeBuildData = typeof XcodeBuildData.Type;

export const XcodeBuildDataList = Schema.Struct({
  kind: Schema.Literal("xcode-build-data"),
  /** False where this host has no Xcode DerivedData folder, as on Linux and Windows. */
  available: Schema.Boolean,
  entries: Schema.Array(XcodeBuildData).pipe(Schema.maxItems(2_000)),
}).annotations(strict);
export type XcodeBuildDataList = typeof XcodeBuildDataList.Type;

export const RemoveXcodeBuildDataRequest = Schema.Struct({
  names: Schema.Array(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255))).pipe(
    Schema.minItems(1),
    Schema.maxItems(2_000),
  ),
  confirmed: Schema.Literal(true),
}).annotations(strict);
export type RemoveXcodeBuildDataRequest = typeof RemoveXcodeBuildDataRequest.Type;

export const RemoveXcodeBuildDataResult = Schema.Struct({
  kind: Schema.Literal("xcode-build-data-removed"),
  removed: Schema.Array(Schema.String.pipe(Schema.maxLength(255))).pipe(Schema.maxItems(2_000)),
  /** Folders read again and found in use, or gone, so left alone. */
  kept: Schema.Array(Schema.String.pipe(Schema.maxLength(255))).pipe(Schema.maxItems(2_000)),
}).annotations(strict);
export type RemoveXcodeBuildDataResult = typeof RemoveXcodeBuildDataResult.Type;

export const decodeRemoveHostWorktreeRequest = Schema.decodeUnknownSync(RemoveHostWorktreeRequest);
export const decodeRemoveXcodeBuildDataRequest = Schema.decodeUnknownSync(
  RemoveXcodeBuildDataRequest,
);
