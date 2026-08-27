import { Schema } from "effect";
import {
  CanvasActor,
  CanvasBlockId,
  CanvasEdgeId,
  CanvasId,
  CanvasNodeId,
  CANVAS_SCHEMA_VERSION,
  CanvasSchemaVersion,
  CanvasVersionId,
} from "./canvasIdentity";
import { UtcTimestamp } from "./events";

export { CANVAS_SCHEMA_VERSION };

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));
const boundedNonEmptyText = (maxLength: number) =>
  Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(maxLength));

export const CANVAS_COMMENT_BODY_MAX_CHARS = 4_096;
export const CANVAS_COMMENT_REPLY_BODY_MAX_CHARS = 4_096;
export const CANVAS_MAX_COMMENTS_PER_CANVAS = 1_024;
export const CANVAS_MAX_REPLIES_PER_COMMENT = 128;

export const CanvasCommentId = brandedUuid("CanvasCommentId");
export type CanvasCommentId = typeof CanvasCommentId.Type;
export const CanvasCommentReplyId = brandedUuid("CanvasCommentReplyId");
export type CanvasCommentReplyId = typeof CanvasCommentReplyId.Type;

// ── Anchors ──────────────────────────────────────────────────────────────────
//
// Comments are anchored to a specific thing inside a Canvas diagram or block so
// a renderer can place them, but they are never stored inside the block itself.
// A region anchor reserves space for freeform-area comments once the board
// defines a stable coordinate space; until then a region anchor is surfaced
// unanchored rather than dropped.

export const CanvasCommentBlockAnchor = Schema.Struct({
  kind: Schema.Literal("block"),
  blockId: CanvasBlockId,
}).annotations(strict);
export type CanvasCommentBlockAnchor = typeof CanvasCommentBlockAnchor.Type;

export const CanvasCommentNodeAnchor = Schema.Struct({
  kind: Schema.Literal("node"),
  blockId: CanvasBlockId,
  nodeId: CanvasNodeId,
}).annotations(strict);
export type CanvasCommentNodeAnchor = typeof CanvasCommentNodeAnchor.Type;

export const CanvasCommentEdgeAnchor = Schema.Struct({
  kind: Schema.Literal("edge"),
  blockId: CanvasBlockId,
  edgeId: CanvasEdgeId,
}).annotations(strict);
export type CanvasCommentEdgeAnchor = typeof CanvasCommentEdgeAnchor.Type;

const FiniteNumber = Schema.Number.pipe(
  Schema.filter(Number.isFinite, { message: () => "Canvas board numbers must be finite." }),
);
const NonNegativeFiniteNumber = FiniteNumber.pipe(Schema.nonNegative());

export const CanvasCommentRegionAnchor = Schema.Struct({
  kind: Schema.Literal("region"),
  blockId: CanvasBlockId,
  regionId: brandedUuid("CanvasCommentRegionId"),
  x: FiniteNumber,
  y: FiniteNumber,
  width: NonNegativeFiniteNumber,
  height: NonNegativeFiniteNumber,
}).annotations(strict);
export type CanvasCommentRegionAnchor = typeof CanvasCommentRegionAnchor.Type;

export const CanvasCommentAnchor = Schema.Union(
  CanvasCommentBlockAnchor,
  CanvasCommentNodeAnchor,
  CanvasCommentEdgeAnchor,
  CanvasCommentRegionAnchor,
);
export type CanvasCommentAnchor = typeof CanvasCommentAnchor.Type;

// ── Comment entities ───────────────────────────────────────────────────────

export const CanvasComment = Schema.Struct({
  commentId: CanvasCommentId,
  anchor: CanvasCommentAnchor,
  author: CanvasActor,
  body: boundedNonEmptyText(CANVAS_COMMENT_BODY_MAX_CHARS),
  createdAt: UtcTimestamp,
  resolvedAt: Schema.optional(UtcTimestamp),
  resolvedBy: Schema.optional(CanvasActor),
}).annotations(strict);
export type CanvasComment = typeof CanvasComment.Type;

export const CanvasCommentReply = Schema.Struct({
  replyId: CanvasCommentReplyId,
  commentId: CanvasCommentId,
  author: CanvasActor,
  body: boundedNonEmptyText(CANVAS_COMMENT_REPLY_BODY_MAX_CHARS),
  createdAt: UtcTimestamp,
}).annotations(strict);
export type CanvasCommentReply = typeof CanvasCommentReply.Type;

// ── Comment commands ─────────────────────────────────────────────────────────

export const CanvasCommentAddCommand = Schema.Struct({
  kind: Schema.Literal("canvas-comment-add"),
  canvasId: CanvasId,
  commentId: CanvasCommentId,
  anchor: CanvasCommentAnchor,
  author: CanvasActor,
  body: boundedNonEmptyText(CANVAS_COMMENT_BODY_MAX_CHARS),
  expectedSequence: Schema.Int.pipe(Schema.nonNegative()),
  issuedAt: UtcTimestamp,
}).annotations(strict);
export type CanvasCommentAddCommand = typeof CanvasCommentAddCommand.Type;

export const CanvasCommentReplyCommand = Schema.Struct({
  kind: Schema.Literal("canvas-comment-reply"),
  canvasId: CanvasId,
  commentId: CanvasCommentId,
  replyId: CanvasCommentReplyId,
  author: CanvasActor,
  body: boundedNonEmptyText(CANVAS_COMMENT_REPLY_BODY_MAX_CHARS),
  expectedSequence: Schema.Int.pipe(Schema.nonNegative()),
  issuedAt: UtcTimestamp,
}).annotations(strict);
export type CanvasCommentReplyCommand = typeof CanvasCommentReplyCommand.Type;

export const CanvasCommentResolveCommand = Schema.Struct({
  kind: Schema.Literal("canvas-comment-resolve"),
  canvasId: CanvasId,
  commentId: CanvasCommentId,
  resolvedBy: CanvasActor,
  expectedSequence: Schema.Int.pipe(Schema.nonNegative()),
  issuedAt: UtcTimestamp,
}).annotations(strict);
export type CanvasCommentResolveCommand = typeof CanvasCommentResolveCommand.Type;

export const CanvasCommentDeleteCommand = Schema.Struct({
  kind: Schema.Literal("canvas-comment-delete"),
  canvasId: CanvasId,
  commentId: CanvasCommentId,
  deletedBy: CanvasActor,
  expectedSequence: Schema.Int.pipe(Schema.nonNegative()),
  issuedAt: UtcTimestamp,
}).annotations(strict);
export type CanvasCommentDeleteCommand = typeof CanvasCommentDeleteCommand.Type;

export const CanvasCommentCommand = Schema.Union(
  CanvasCommentAddCommand,
  CanvasCommentReplyCommand,
  CanvasCommentResolveCommand,
  CanvasCommentDeleteCommand,
);
export type CanvasCommentCommand = typeof CanvasCommentCommand.Type;

// ── Comment events ───────────────────────────────────────────────────────────

export const CanvasCommentAdded = Schema.Struct({
  canvasId: CanvasId,
  comment: CanvasComment,
  sequence: Schema.Int.pipe(Schema.positive()),
}).annotations(strict);
export type CanvasCommentAdded = typeof CanvasCommentAdded.Type;

export const CanvasCommentReplied = Schema.Struct({
  canvasId: CanvasId,
  reply: CanvasCommentReply,
  sequence: Schema.Int.pipe(Schema.positive()),
}).annotations(strict);
export type CanvasCommentReplied = typeof CanvasCommentReplied.Type;

export const CanvasCommentResolved = Schema.Struct({
  canvasId: CanvasId,
  commentId: CanvasCommentId,
  resolvedBy: CanvasActor,
  resolvedAt: UtcTimestamp,
  sequence: Schema.Int.pipe(Schema.positive()),
}).annotations(strict);
export type CanvasCommentResolved = typeof CanvasCommentResolved.Type;

export const CanvasCommentDeleted = Schema.Struct({
  canvasId: CanvasId,
  commentId: CanvasCommentId,
  deletedBy: CanvasActor,
  deletedAt: UtcTimestamp,
  sequence: Schema.Int.pipe(Schema.positive()),
}).annotations(strict);
export type CanvasCommentDeleted = typeof CanvasCommentDeleted.Type;

export const CANVAS_COMMENT_ADDED = "canvas.comment-added@1";
export const CANVAS_COMMENT_REPLIED = "canvas.comment-replied@1";
export const CANVAS_COMMENT_RESOLVED = "canvas.comment-resolved@1";
export const CANVAS_COMMENT_DELETED = "canvas.comment-deleted@1";

// ── Layout revision ────────────────────────────────────────────────────────────
//
// A layout revision is an immutable Canvas version whose diagram nodes carry
// new x/y positions. The command carries only the deltas; the domain policy
// applies them to the current version, validates the result, and emits a new
// CanvasVersion through the existing canvas.version-appended@1 envelope.

export const CanvasDiagramNodePosition = Schema.Struct({
  nodeId: CanvasNodeId,
  x: FiniteNumber,
  y: FiniteNumber,
}).annotations(strict);
export type CanvasDiagramNodePosition = typeof CanvasDiagramNodePosition.Type;

export const CanvasDiagramLayoutReviseCommand = Schema.Struct({
  kind: Schema.Literal("canvas-diagram-layout-revise"),
  canvasId: CanvasId,
  versionId: CanvasVersionId,
  blockId: CanvasBlockId,
  positions: Schema.Array(CanvasDiagramNodePosition).pipe(Schema.minItems(1), Schema.maxItems(512)),
  actor: CanvasActor,
  expectedSequence: Schema.Int.pipe(Schema.positive()),
  schemaVersion: CanvasSchemaVersion,
  issuedAt: UtcTimestamp,
}).annotations(strict);
export type CanvasDiagramLayoutReviseCommand = typeof CanvasDiagramLayoutReviseCommand.Type;

export const CanvasDiagramLayoutRevised = Schema.Struct({
  canvasId: CanvasId,
  versionId: CanvasVersionId,
  blockId: CanvasBlockId,
  positions: Schema.Array(CanvasDiagramNodePosition).pipe(Schema.minItems(1), Schema.maxItems(512)),
  actor: CanvasActor,
  sequence: Schema.Int.pipe(Schema.positive()),
  revisedAt: UtcTimestamp,
}).annotations(strict);
export type CanvasDiagramLayoutRevised = typeof CanvasDiagramLayoutRevised.Type;

export const CANVAS_DIAGRAM_LAYOUT_REVISED = "canvas.diagram-layout-revised@1";

// ── Decoders ─────────────────────────────────────────────────────────────────

export const decodeCanvasCommentId = Schema.decodeUnknownSync(CanvasCommentId);
export const decodeCanvasCommentReplyId = Schema.decodeUnknownSync(CanvasCommentReplyId);
export const decodeCanvasCommentAnchor = Schema.decodeUnknownSync(CanvasCommentAnchor);
export const decodeCanvasComment = Schema.decodeUnknownSync(CanvasComment);
export const decodeCanvasCommentReply = Schema.decodeUnknownSync(CanvasCommentReply);
export const decodeCanvasCommentAddCommand = Schema.decodeUnknownSync(CanvasCommentAddCommand);
export const decodeCanvasCommentReplyCommand = Schema.decodeUnknownSync(CanvasCommentReplyCommand);
export const decodeCanvasCommentResolveCommand = Schema.decodeUnknownSync(
  CanvasCommentResolveCommand,
);
export const decodeCanvasCommentDeleteCommand = Schema.decodeUnknownSync(
  CanvasCommentDeleteCommand,
);
export const decodeCanvasCommentCommand = Schema.decodeUnknownEither(CanvasCommentCommand);
export const decodeCanvasCommentAdded = Schema.decodeUnknownSync(CanvasCommentAdded);
export const decodeCanvasCommentReplied = Schema.decodeUnknownSync(CanvasCommentReplied);
export const decodeCanvasCommentResolved = Schema.decodeUnknownSync(CanvasCommentResolved);
export const decodeCanvasCommentDeleted = Schema.decodeUnknownSync(CanvasCommentDeleted);
export const decodeCanvasDiagramNodePosition = Schema.decodeUnknownSync(CanvasDiagramNodePosition);
export const decodeCanvasDiagramLayoutReviseCommand = Schema.decodeUnknownSync(
  CanvasDiagramLayoutReviseCommand,
);
export const decodeCanvasDiagramLayoutRevised = Schema.decodeUnknownSync(
  CanvasDiagramLayoutRevised,
);
