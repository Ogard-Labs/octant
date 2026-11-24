import { Schema } from "effect";
import { CodeFailure, CodeManagedThreadCreated } from "./code";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/** Live progress for the window that requested managed thread creation. */
export const CodeWorktreeCreationProgress = Schema.Union(
  Schema.Struct({ phase: Schema.Literal("source") }).annotations(strict),
  Schema.Struct({
    phase: Schema.Literal("checkout"),
    sourceMs: Schema.NonNegativeInt,
  }).annotations(strict),
  Schema.Struct({
    phase: Schema.Literal("ready"),
    checkoutMs: Schema.NonNegativeInt,
  }).annotations(strict),
);
export type CodeWorktreeCreationProgress = typeof CodeWorktreeCreationProgress.Type;

export const CodeWorktreeCreationFrame = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("progress"),
    progress: CodeWorktreeCreationProgress,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("result"),
    result: CodeManagedThreadCreated,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("failure"),
    failure: CodeFailure,
  }).annotations(strict),
);
