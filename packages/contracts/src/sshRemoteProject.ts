/**
 * Code Projects bound to a folder on an SSH target, and the reads this host
 * makes of that folder through the target's executor. Canonical:
 * docs/design/remote-ssh-environments.md.
 *
 * A remote-bound Project lives in this host's journal like any Project; its
 * folder is the remote root on the target. Every read is admitted by the
 * admission policy before any frame reaches the executor, and every path a
 * read names is relative to the remote root, so no remote path the person did
 * not bind can be asked for.
 */

import { Schema } from "effect";
import { CodeRelativePath } from "./code";
import { UtcTimestamp } from "./events";
import { ProjectId } from "./projects";
import {
  SshAdmissionDecision,
  SshRemotePath,
  SshTargetId,
  holdsNoControlCharacter,
} from "./sshTarget";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/** The most entries one directory listing carries; the rest is reported as truncated. */
export const SSH_REMOTE_MAX_LISTING_ENTRIES = 1_000;
/** The largest file a read returns; a longer one is refused as too large. */
export const SSH_REMOTE_MAX_FILE_BYTES = 256 * 1_024;
/** The most diff text a read returns; the rest is reported as truncated. */
export const SSH_REMOTE_MAX_DIFF_BYTES = 256 * 1_024;
/** The most status entries a read returns; the rest is reported as truncated. */
export const SSH_REMOTE_MAX_STATUS_ENTRIES = 2_000;

const ProjectName = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256));

/**
 * A Code Project whose folder is `remoteRoot` on one SSH target. The root is
 * the canonical path the target's executor resolved when the Project was
 * bound, and the binding never changes kind or target.
 */
export const SshRemoteProject = Schema.Struct({
  id: ProjectId,
  name: ProjectName,
  targetId: SshTargetId,
  remoteRoot: SshRemotePath,
  boundAt: UtcTimestamp,
}).annotations(strict);
export type SshRemoteProject = typeof SshRemoteProject.Type;

export const SshRemoteProjectList = Schema.Struct({
  projects: Schema.Array(SshRemoteProject),
}).annotations(strict);
export type SshRemoteProjectList = typeof SshRemoteProjectList.Type;

/** Binds a new Code Project to `remoteRoot` on a registered target. Local only. */
export const SshRemoteProjectBindRequest = Schema.Struct({
  targetId: SshTargetId,
  remoteRoot: SshRemotePath,
  name: ProjectName,
}).annotations(strict);
export type SshRemoteProjectBindRequest = typeof SshRemoteProjectBindRequest.Type;

export const SshRemoteDirectoryRequest = Schema.Struct({
  projectId: ProjectId,
  /** Absent lists the remote root itself. */
  directory: Schema.optional(CodeRelativePath),
}).annotations(strict);
export type SshRemoteDirectoryRequest = typeof SshRemoteDirectoryRequest.Type;

export const SshRemoteFileRequest = Schema.Struct({
  projectId: ProjectId,
  path: CodeRelativePath,
}).annotations(strict);
export type SshRemoteFileRequest = typeof SshRemoteFileRequest.Type;

export const SshRemoteGitStatusRequest = Schema.Struct({
  projectId: ProjectId,
}).annotations(strict);
export type SshRemoteGitStatusRequest = typeof SshRemoteGitStatusRequest.Type;

export const SshRemoteGitDiffRequest = Schema.Struct({
  projectId: ProjectId,
  /** Absent diffs the whole checkout. */
  path: Schema.optional(CodeRelativePath),
}).annotations(strict);
export type SshRemoteGitDiffRequest = typeof SshRemoteGitDiffRequest.Type;

/** One entry of a listed directory, relative to the remote root. */
export const SshRemoteDirectoryEntry = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("directory"),
    path: CodeRelativePath,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("file"),
    path: CodeRelativePath,
    byteLength: Schema.Int.pipe(Schema.nonNegative()),
  }).annotations(strict),
);
export type SshRemoteDirectoryEntry = typeof SshRemoteDirectoryEntry.Type;

/** One directory's entries. `truncated` says the listing is not the whole directory. */
export const SshRemoteDirectoryListing = Schema.Struct({
  entries: Schema.Array(SshRemoteDirectoryEntry).pipe(
    Schema.maxItems(SSH_REMOTE_MAX_LISTING_ENTRIES),
  ),
  truncated: Schema.Boolean,
}).annotations(strict);
export type SshRemoteDirectoryListing = typeof SshRemoteDirectoryListing.Type;

/** A file's bytes, base64-encoded so any content fits a frame within its bound. */
export const SshRemoteFileContent = Schema.Struct({
  path: CodeRelativePath,
  byteLength: Schema.Int.pipe(Schema.between(0, SSH_REMOTE_MAX_FILE_BYTES)),
  contentBase64: Schema.String.pipe(
    Schema.maxLength(Math.ceil(SSH_REMOTE_MAX_FILE_BYTES / 3) * 4),
    Schema.pattern(/^[A-Za-z0-9+/]*={0,2}$/u),
  ),
}).annotations(strict);
export type SshRemoteFileContent = typeof SshRemoteFileContent.Type;

const GitObjectId = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u));
const GitBranchName = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(1_024),
  Schema.filter(holdsNoControlCharacter),
);
/** A path as Git reports it: relative to the checkout, never a host path. */
const GitReportedPath = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(4_096),
  Schema.filter((value) => !value.startsWith("/") && !value.includes("\u0000")),
);
/** One porcelain status column, as `git status` prints it. */
const GitStatusCode = Schema.String.pipe(Schema.pattern(/^[ MTADRCU?!]$/u));

export const SshRemoteGitHead = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("branch"),
    name: GitBranchName,
    oid: GitObjectId,
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("detached"), oid: GitObjectId }).annotations(strict),
  /** A branch with no commits yet. */
  Schema.Struct({ kind: Schema.Literal("unborn"), name: GitBranchName }).annotations(strict),
);
export type SshRemoteGitHead = typeof SshRemoteGitHead.Type;

export const SshRemoteGitStatusEntry = Schema.Struct({
  path: GitReportedPath,
  originalPath: Schema.optional(GitReportedPath),
  index: GitStatusCode,
  worktree: GitStatusCode,
}).annotations(strict);
export type SshRemoteGitStatusEntry = typeof SshRemoteGitStatusEntry.Type;

export const SshRemoteGitStatus = Schema.Struct({
  head: SshRemoteGitHead,
  entries: Schema.Array(SshRemoteGitStatusEntry).pipe(
    Schema.maxItems(SSH_REMOTE_MAX_STATUS_ENTRIES),
  ),
  truncated: Schema.Boolean,
}).annotations(strict);
export type SshRemoteGitStatus = typeof SshRemoteGitStatus.Type;

export const SshRemoteGitDiff = Schema.Struct({
  text: Schema.String,
  byteLength: Schema.Int.pipe(Schema.between(0, SSH_REMOTE_MAX_DIFF_BYTES)),
  truncated: Schema.Boolean,
}).annotations(strict);
export type SshRemoteGitDiff = typeof SshRemoteGitDiff.Type;

/**
 * Why the executor answered a read without its result. It decides these on
 * the target, where the files are: a path that resolves outside the remote
 * root, through a symbolic link or otherwise, is `outside-root`.
 */
export const SshRemoteReadRefusalReason = Schema.Literal(
  /** The remote root is missing or is not a directory. */
  "root-unavailable",
  /** The remote root now resolves somewhere other than where it was bound. */
  "root-moved",
  /** `/`, or a folder holding or inside the remote user's `~/.ssh` or the executor's own runtime. */
  "root-not-confinable",
  "outside-root",
  "not-found",
  "not-a-directory",
  "not-a-file",
  "too-large",
  "not-a-repository",
  "git-unavailable",
  "read-failed",
);
export type SshRemoteReadRefusalReason = typeof SshRemoteReadRefusalReason.Type;

/** Why a bind or a read on a remote-bound Project did nothing. */
export const SshRemoteProjectRefusal = Schema.Union(
  /** The admission policy refused before any frame reached the executor. */
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: Schema.Literal("not-admitted"),
    decision: SshAdmissionDecision.pipe(Schema.filter((decision) => decision.status === "refused")),
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: Schema.Union(
      SshRemoteReadRefusalReason,
      Schema.Literal(
        "unknown-project",
        /** The session ended, the executor did not answer in time, or it answered out of turn. */
        "executor-unavailable",
      ),
    ),
  }).annotations(strict),
);
export type SshRemoteProjectRefusal = typeof SshRemoteProjectRefusal.Type;
