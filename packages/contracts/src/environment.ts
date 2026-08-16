import { Schema } from "effect";
import { CodeCheckoutId, CodeThreadId } from "./code";
import { AggregateVersion, UtcTimestamp } from "./events";
import { ProjectId } from "./projects";
import { ThreadWorkingDirectory } from "./workingDirectory";
export {
  MAX_THREAD_WORKING_DIRECTORY_BYTES,
  ThreadWorkingDirectory,
  decodeThreadWorkingDirectory,
} from "./workingDirectory";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const BaseFields = {
  projectId: ProjectId,
  projectName: Schema.NonEmptyTrimmedString,
  observedAt: UtcTimestamp,
  threadId: Schema.optional(CodeThreadId),
  checkoutId: Schema.optional(CodeCheckoutId),
  workingDirectory: Schema.optional(ThreadWorkingDirectory),
  threadVersion: Schema.optional(AggregateVersion),
} as const;

export const GitBranchIdentity = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("named"),
    name: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("detached"),
    oid: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{40}$/)),
  }).annotations(strict),
);
export type GitBranchIdentity = typeof GitBranchIdentity.Type;

export const CodeEnvironmentReady = Schema.Struct({
  ...BaseFields,
  status: Schema.Literal("ready"),
  repositoryRoot: Schema.NonEmptyTrimmedString,
  worktreeRoot: Schema.NonEmptyTrimmedString,
  branch: GitBranchIdentity,
  changes: Schema.Literal("clean", "dirty"),
}).annotations(strict);
export type CodeEnvironmentReady = typeof CodeEnvironmentReady.Type;

const EnvironmentFailureFields = {
  ...BaseFields,
  reason: Schema.NonEmptyTrimmedString,
} as const;

export const CodeEnvironmentObservation = Schema.Union(
  CodeEnvironmentReady,
  Schema.Struct({
    ...EnvironmentFailureFields,
    status: Schema.Literal("unavailable"),
  }).annotations(strict),
  Schema.Struct({
    ...EnvironmentFailureFields,
    status: Schema.Literal("failed"),
  }).annotations(strict),
);
export type CodeEnvironmentObservation = typeof CodeEnvironmentObservation.Type;

export const decodeCodeEnvironmentObservation = Schema.decodeUnknownSync(
  CodeEnvironmentObservation,
);
