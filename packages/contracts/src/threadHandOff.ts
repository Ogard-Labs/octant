/**
 * Server-authoritative hand-off of one thread.
 *
 * A hand-off is a document the thread's own provider writes from the host's
 * export cut — objective, workspace and context, what was done, what is left,
 * decisions and risks, how to continue — kept as a Canvas of that thread so it
 * travels with the thread's evidence. The renderer never assembles it.
 */

import { Schema } from "effect";
import { NonEmptyTrimmedString, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { OctantMode } from "./modes";
import { ProjectId } from "./projects";
import { ThreadExportId } from "./threadExport";

export const ThreadHandOffRequest = Schema.Struct({
  mode: OctantMode,
  threadId: ThreadExportId,
});
export type ThreadHandOffRequest = typeof ThreadHandOffRequest.Type;

/**
 * Why a hand-off did not happen. `not-found` and `unauthorized` mirror the
 * export cut the hand-off starts from; the rest name what the person can
 * change: wait for the turn, fix the provider, file the thread in a Project.
 */
export const ThreadHandOffRefusalReason = Schema.Literals([
  "not-found",
  "unauthorized",
  "turn-running",
  "provider-unavailable",
  "project-required",
  "empty-thread",
  "document-not-produced",
  "document-refused",
]);
export type ThreadHandOffRefusalReason = typeof ThreadHandOffRefusalReason.Type;

export const ThreadHandOffOutcome = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("handed-off"),
    canvasId: NonEmptyTrimmedString,
    versionId: NonEmptyTrimmedString,
    projectId: ProjectId,
    title: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: ThreadHandOffRefusalReason,
    message: Schema.optional(Schema.String.check(Schema.isMaxLength(400))),
  }),
]);
export type ThreadHandOffOutcome = typeof ThreadHandOffOutcome.Type;

export const decodeThreadHandOffRequest = Schema.decodeUnknownSync(
  ThreadHandOffRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeThreadHandOffOutcome = Schema.decodeUnknownSync(
  ThreadHandOffOutcome,
  STRICT_DECODE_OPTIONS,
);
