/**
 * Tags a person puts on a Canvas to find it again.
 *
 * A tag is the person's own filing fact, not part of the document: it never
 * enters a Canvas version, so tagging changes no history, bumps no `updatedAt`,
 * and marks no outside content. Like comments, tags are journaled facts of
 * their own aggregate beside the document; unlike comments they are
 * host-local — a share, an export, a mirrored file, and artifact sync all
 * leave them here.
 */

import { Schema } from "effect";
import { PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { CanvasId } from "./canvasIdentity";
import { UtcTimestamp } from "./events";

export const CANVAS_TAG_MAX_CHARS = 40;
export const CANVAS_MAX_TAGS_PER_CANVAS = 12;

/**
 * A tag is an exact label: two tags that differ only in case are two tags, and
 * the library's roster shows both. Nothing here normalizes what a person
 * typed, because a roster that silently merged two labels would look like a
 * tag that went missing.
 */
export const CanvasTagName = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(CANVAS_TAG_MAX_CHARS),
);
export type CanvasTagName = typeof CanvasTagName.Type;

// ── Commands ─────────────────────────────────────────────────────────────────

export const CanvasTagAddCommand = Schema.Struct({
  kind: Schema.Literal("canvas-tag-add"),
  canvasId: CanvasId,
  tag: CanvasTagName,
  issuedAt: UtcTimestamp,
});
export type CanvasTagAddCommand = typeof CanvasTagAddCommand.Type;

export const CanvasTagRemoveCommand = Schema.Struct({
  kind: Schema.Literal("canvas-tag-remove"),
  canvasId: CanvasId,
  tag: CanvasTagName,
  issuedAt: UtcTimestamp,
});
export type CanvasTagRemoveCommand = typeof CanvasTagRemoveCommand.Type;

export const CanvasTagCommand = Schema.Union([CanvasTagAddCommand, CanvasTagRemoveCommand]);
export type CanvasTagCommand = typeof CanvasTagCommand.Type;

// ── Events ──────────────────────────────────────────────────────────────────

export const CanvasTagAdded = Schema.Struct({
  canvasId: CanvasId,
  tag: CanvasTagName,
  addedAt: UtcTimestamp,
  sequence: PositiveInt,
});
export type CanvasTagAdded = typeof CanvasTagAdded.Type;

export const CanvasTagRemoved = Schema.Struct({
  canvasId: CanvasId,
  tag: CanvasTagName,
  removedAt: UtcTimestamp,
  sequence: PositiveInt,
});
export type CanvasTagRemoved = typeof CanvasTagRemoved.Type;

export const CANVAS_TAG_ADDED = "canvas.tag-added@1";
export const CANVAS_TAG_REMOVED = "canvas.tag-removed@1";

export const CanvasTagEvent = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("added"), event: CanvasTagAdded }),
  Schema.Struct({ kind: Schema.Literal("removed"), event: CanvasTagRemoved }),
]);
export type CanvasTagEvent = typeof CanvasTagEvent.Type;

// ── Command results ──────────────────────────────────────────────────────────

export const CanvasTagDenialCode = Schema.Literals([
  "malformed-request",
  "stale-version",
  "unauthorized",
  "unavailable",
  "oversized-payload",
  "duplicate-tag",
  "unknown-tag",
  "tag-budget-exceeded",
]);
export type CanvasTagDenialCode = typeof CanvasTagDenialCode.Type;

export const CanvasTagCommandResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("accepted"),
    canvasId: CanvasId,
    sequence: PositiveInt,
    tags: Schema.Array(CanvasTagName).check(Schema.isMaxLength(CANVAS_MAX_TAGS_PER_CANVAS)),
  }),
  Schema.Struct({
    kind: Schema.Literal("denied"),
    denialCode: CanvasTagDenialCode,
    message: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1_024)),
  }),
]);
export type CanvasTagCommandResult = typeof CanvasTagCommandResult.Type;

// ── Decoders ──────────────────────────────────────────────────────────────────

export const decodeCanvasTagCommand = Schema.decodeUnknownResult(
  CanvasTagCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasTagAdded = Schema.decodeUnknownSync(CanvasTagAdded, STRICT_DECODE_OPTIONS);
export const decodeCanvasTagRemoved = Schema.decodeUnknownSync(
  CanvasTagRemoved,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasTagEvent = Schema.decodeUnknownSync(CanvasTagEvent, STRICT_DECODE_OPTIONS);
export const decodeCanvasTagCommandResult = Schema.decodeUnknownSync(
  CanvasTagCommandResult,
  STRICT_DECODE_OPTIONS,
);
