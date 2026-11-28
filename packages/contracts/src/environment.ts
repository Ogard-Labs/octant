import { Schema } from "effect";
import { NonEmptyTrimmedString, NonNegativeInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { CodeCheckoutId, CodeThreadId } from "./code";
import { AggregateVersion, UtcTimestamp } from "./events";
import { ProjectId } from "./projects";
import { ThreadWorkingDirectory, ApprovedWorkingFolder } from "./workingDirectory";
export {
  MAX_THREAD_WORKING_DIRECTORY_BYTES,
  ThreadWorkingDirectory,
  decodeThreadWorkingDirectory,
} from "./workingDirectory";

const BaseFields = {
  projectId: ProjectId,
  projectName: NonEmptyTrimmedString,
  observedAt: UtcTimestamp,
  threadId: Schema.optional(CodeThreadId),
  checkoutId: Schema.optional(CodeCheckoutId),
  workingDirectory: Schema.optional(ThreadWorkingDirectory),
  workingFolder: Schema.optional(ApprovedWorkingFolder),
  workingFolderUnavailable: Schema.optional(Schema.Boolean),
  threadVersion: Schema.optional(AggregateVersion),
} as const;

export const GitBranchIdentity = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("named"),
    name: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    kind: Schema.Literal("detached"),
    oid: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  }),
]);
export type GitBranchIdentity = typeof GitBranchIdentity.Type;

export const CodeEnvironmentReady = Schema.Struct({
  ...BaseFields,
  status: Schema.Literal("ready"),
  repositoryRoot: NonEmptyTrimmedString,
  worktreeRoot: NonEmptyTrimmedString,
  branch: GitBranchIdentity,
  changes: Schema.Literals(["clean", "dirty"]),
  /**
   * Lines the working tree adds and removes against its own HEAD. Absent when
   * the host could not count them, which is not the same as none: a reader is
   * told the tree is dirty either way, and only sees totals that were measured.
   */
  insertions: Schema.optional(NonNegativeInt),
  deletions: Schema.optional(NonNegativeInt),
});
export type CodeEnvironmentReady = typeof CodeEnvironmentReady.Type;

const EnvironmentFailureFields = {
  ...BaseFields,
  reason: NonEmptyTrimmedString,
} as const;

export const CodeEnvironmentObservation = Schema.Union([
  CodeEnvironmentReady,
  Schema.Struct({
    ...EnvironmentFailureFields,
    status: Schema.Literal("unavailable"),
  }),
  Schema.Struct({
    ...EnvironmentFailureFields,
    status: Schema.Literal("failed"),
  }),
]);
export type CodeEnvironmentObservation = typeof CodeEnvironmentObservation.Type;

export const decodeCodeEnvironmentObservation = Schema.decodeUnknownSync(
  CodeEnvironmentObservation,
  STRICT_DECODE_OPTIONS,
);
