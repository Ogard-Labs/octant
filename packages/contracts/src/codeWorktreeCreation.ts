import { Schema } from "effect";
import { NonNegativeInt } from "./schemaPrimitives";
import { CodeFailure, CodeManagedThreadCreated } from "./code";

/** Live progress for the window that requested managed thread creation. */
export const CodeWorktreeCreationProgress = Schema.Union([
  Schema.Struct({ phase: Schema.Literal("source") }),
  Schema.Struct({
    phase: Schema.Literal("checkout"),
    sourceMs: NonNegativeInt,
  }),
  Schema.Struct({
    phase: Schema.Literal("ready"),
    checkoutMs: NonNegativeInt,
  }),
]);
export type CodeWorktreeCreationProgress = typeof CodeWorktreeCreationProgress.Type;

export const CodeWorktreeCreationFrame = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("progress"),
    progress: CodeWorktreeCreationProgress,
  }),
  Schema.Struct({
    kind: Schema.Literal("result"),
    result: CodeManagedThreadCreated,
  }),
  Schema.Struct({
    kind: Schema.Literal("failure"),
    failure: CodeFailure,
  }),
]);
