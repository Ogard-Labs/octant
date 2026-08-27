import {
  CANVAS_MAX_DIAGRAM_NODES,
  CanvasDiagramBlock,
  CanvasVersion,
  decodeCanvasVersion,
  type CanvasBlock,
} from "@octant/contracts/canvas";
import {
  CANVAS_COMMENT_BODY_MAX_CHARS,
  CANVAS_MAX_COMMENTS_PER_CANVAS,
  CANVAS_MAX_REPLIES_PER_COMMENT,
  CanvasComment,
  CanvasCommentAdded,
  CanvasCommentCommand,
  CanvasCommentDeleted,
  CanvasCommentReplied,
  CanvasCommentReply,
  CanvasCommentReplyCommand,
  CanvasCommentResolved,
  CanvasDiagramLayoutReviseCommand,
  CanvasDiagramNodePosition,
  decodeCanvasComment,
  decodeCanvasCommentCommand,
  decodeCanvasCommentReply,
  decodeCanvasDiagramLayoutReviseCommand,
} from "@octant/contracts/canvas-board";
import { decodeCanvasVersionId } from "@octant/contracts/canvas";
import type { UtcTimestamp } from "@octant/contracts/events";
import { validateCanvasDefinition } from "./canvasPolicy";

export type CanvasBoardRejectionCode =
  | "malformed-request"
  | "stale-version"
  | "unauthorized"
  | "oversized-payload"
  | "comment-budget-exceeded"
  | "unknown-comment"
  | "duplicate-comment"
  | "reply-budget-exceeded"
  | "unknown-reply-target"
  | "not-a-diagram"
  | "unknown-node"
  | "missing-position";

export interface CanvasBoardRejected {
  readonly kind: "rejected";
  readonly code: CanvasBoardRejectionCode;
  readonly message: string;
}

function reject(code: CanvasBoardRejectionCode, message: string): CanvasBoardRejected {
  return { kind: "rejected", code, message };
}

function isUserOrAgent(actor: { readonly kind: string }): boolean {
  return actor.kind === "local-user" || actor.kind === "agent";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// ── Comments ───────────────────────────────────────────────────────────────────

export interface CanvasCommentState {
  readonly comments: ReadonlyArray<CanvasComment>;
  readonly replies: ReadonlyArray<CanvasCommentReply>;
  readonly sequence: number;
}

export type CanvasCommentAdmitResult =
  | { readonly kind: "accepted"; readonly event: CanvasCommentAdded }
  | { readonly kind: "accepted"; readonly event: CanvasCommentReplied }
  | { readonly kind: "accepted"; readonly event: CanvasCommentResolved }
  | { readonly kind: "accepted"; readonly event: CanvasCommentDeleted }
  | CanvasBoardRejected;

function findComment(
  comments: ReadonlyArray<CanvasComment>,
  commentId: string,
): CanvasComment | undefined {
  return comments.find((comment) => String(comment.commentId) === commentId);
}

function countReplies(replies: ReadonlyArray<CanvasCommentReply>, commentId: string): number {
  return replies.filter((reply) => String(reply.commentId) === commentId).length;
}

/**
 * Admit a Canvas comment command against the current board state.
 *
 * The result is a value, not an exception, so callers must handle refused,
 * stale, or oversized inputs before journaling any event. Authority checks
 * (host, project, thread) happen upstream on the server; this pure policy
 * validates shape, sequence, budgets, and referential integrity.
 */
export function admitCanvasCommentCommand(
  input: unknown,
  state: CanvasCommentState,
): CanvasCommentAdmitResult {
  let command: CanvasCommentCommand;
  try {
    command = decodeCanvasCommentCommand(input);
  } catch {
    return reject("malformed-request", "Canvas comment command is malformed.");
  }

  if (command.expectedSequence !== state.sequence) {
    return reject("stale-version", "Canvas comment command targets a stale board sequence.");
  }

  switch (command.kind) {
    case "canvas-comment-add": {
      if (!isUserOrAgent(command.author)) {
        return reject("unauthorized", "Canvas comments must be authored by a user or agent.");
      }
      if (command.body.length > CANVAS_COMMENT_BODY_MAX_CHARS) {
        return reject("oversized-payload", "Canvas comment body exceeds the allowed length.");
      }
      if (state.comments.length >= CANVAS_MAX_COMMENTS_PER_CANVAS) {
        return reject(
          "comment-budget-exceeded",
          `Canvas cannot hold more than ${CANVAS_MAX_COMMENTS_PER_CANVAS} comments.`,
        );
      }
      if (findComment(state.comments, String(command.commentId)) !== undefined) {
        return reject("duplicate-comment", "Canvas comment id already exists.");
      }
      let comment: CanvasComment;
      try {
        comment = decodeCanvasComment({
          commentId: command.commentId,
          anchor: command.anchor,
          author: command.author,
          body: command.body,
          createdAt: command.issuedAt,
        });
      } catch {
        return reject("malformed-request", "Canvas comment entity is malformed.");
      }
      const event: CanvasCommentAdded = {
        canvasId: command.canvasId,
        comment,
        sequence: state.sequence + 1,
      };
      return { kind: "accepted", event };
    }
    case "canvas-comment-reply": {
      if (!isUserOrAgent(command.author)) {
        return reject(
          "unauthorized",
          "Canvas comment replies must be authored by a user or agent.",
        );
      }
      if (command.body.length > CANVAS_COMMENT_BODY_MAX_CHARS) {
        return reject("oversized-payload", "Canvas comment reply body exceeds the allowed length.");
      }
      const parent = findComment(state.comments, String(command.commentId));
      if (parent === undefined) {
        return reject(
          "unknown-reply-target",
          "Canvas reply targets a comment that does not exist.",
        );
      }
      if (
        countReplies(state.replies, String(command.commentId)) >= CANVAS_MAX_REPLIES_PER_COMMENT
      ) {
        return reject(
          "reply-budget-exceeded",
          `Canvas comment cannot hold more than ${CANVAS_MAX_REPLIES_PER_COMMENT} replies.`,
        );
      }
      let reply: CanvasCommentReply;
      try {
        reply = decodeCanvasCommentReply({
          replyId: command.replyId,
          commentId: command.commentId,
          author: command.author,
          body: command.body,
          createdAt: command.issuedAt,
        });
      } catch {
        return reject("malformed-request", "Canvas comment reply entity is malformed.");
      }
      const event: CanvasCommentReplied = {
        canvasId: command.canvasId,
        reply,
        sequence: state.sequence + 1,
      };
      return { kind: "accepted", event };
    }
    case "canvas-comment-resolve": {
      const target = findComment(state.comments, String(command.commentId));
      if (target === undefined) {
        return reject("unknown-comment", "Canvas comment to resolve does not exist.");
      }
      if (!isUserOrAgent(command.resolvedBy)) {
        return reject(
          "unauthorized",
          "Canvas comment resolution must be performed by a user or agent.",
        );
      }
      const event: CanvasCommentResolved = {
        canvasId: command.canvasId,
        commentId: command.commentId,
        resolvedBy: command.resolvedBy,
        resolvedAt: command.issuedAt,
        sequence: state.sequence + 1,
      };
      return { kind: "accepted", event };
    }
    case "canvas-comment-delete": {
      const target = findComment(state.comments, String(command.commentId));
      if (target === undefined) {
        return reject("unknown-comment", "Canvas comment to delete does not exist.");
      }
      if (!isUserOrAgent(command.deletedBy)) {
        return reject(
          "unauthorized",
          "Canvas comment deletion must be performed by a user or agent.",
        );
      }
      const event: CanvasCommentDeleted = {
        canvasId: command.canvasId,
        commentId: command.commentId,
        deletedBy: command.deletedBy,
        deletedAt: command.issuedAt,
        sequence: state.sequence + 1,
      };
      return { kind: "accepted", event };
    }
  }
}

// ── Diagram layout revision ──────────────────────────────────────────────────

export interface CanvasDiagramLayoutRevisionResult {
  readonly kind: "accepted";
  readonly next: CanvasVersion;
}

export type CanvasDiagramLayoutRevisionAdmitResult =
  | CanvasDiagramLayoutRevisionResult
  | CanvasBoardRejected;

function isDiagramBlock(block: CanvasBlock): block is CanvasDiagramBlock {
  return block.kind === "diagram";
}

function applyNodePositions(
  block: CanvasDiagramBlock,
  positions: ReadonlyArray<CanvasDiagramNodePosition>,
): CanvasDiagramBlock {
  const positionMap = new Map(positions.map((position) => [String(position.nodeId), position]));
  const updatedNodes = block.nodes.map((node) => {
    const position = positionMap.get(String(node.nodeId));
    if (position === undefined) return node;
    return {
      ...node,
      x: position.x,
      y: position.y,
      positioned: true as const,
    };
  });
  return {
    ...block,
    layout: "manual" as const,
    nodes: updatedNodes,
  };
}

function replaceBlock(
  blocks: ReadonlyArray<CanvasBlock>,
  blockId: string,
  replacement: CanvasBlock,
): ReadonlyArray<CanvasBlock> {
  return blocks.map((block) => (String(block.blockId) === blockId ? replacement : block));
}

/**
 * Apply an immutable diagram layout revision to a Canvas version.
 *
 * The command carries only the requested node positions. The policy verifies
 * that the actor is a user or agent, the target block is a diagram, every
 * positioned node exists, and the resulting definition still passes the Canvas
 * budget and cross-reference policy. The next version keeps the same version
 * identity rules as any other version append.
 */
export function admitCanvasDiagramLayoutRevision(
  input: unknown,
  current: CanvasVersion,
  nextVersionId: unknown,
  now: UtcTimestamp,
): CanvasDiagramLayoutRevisionAdmitResult {
  let command: CanvasDiagramLayoutReviseCommand;
  try {
    command = decodeCanvasDiagramLayoutReviseCommand(input);
  } catch {
    return reject("malformed-request", "Canvas diagram layout revision command is malformed.");
  }

  if (!isUserOrAgent(command.actor)) {
    return reject("unauthorized", "Canvas layout revision must be authored by a user or agent.");
  }

  if (command.expectedSequence !== current.sequence) {
    return reject(
      "stale-version",
      "Canvas diagram layout revision targets a stale Canvas sequence.",
    );
  }

  let decodedNextVersionId: string;
  try {
    decodedNextVersionId = String(decodeCanvasVersionId(nextVersionId));
  } catch {
    return reject("malformed-request", "Canvas diagram layout revision version id is invalid.");
  }

  const block = current.definition.blocks.find(
    (candidate) => String(candidate.blockId) === String(command.blockId),
  );
  if (block === undefined || !isDiagramBlock(block)) {
    return reject("not-a-diagram", "Canvas layout revision target is not a diagram block.");
  }

  const nodeIds = new Set(block.nodes.map((node) => String(node.nodeId)));
  if (command.positions.length > CANVAS_MAX_DIAGRAM_NODES) {
    return reject(
      "oversized-payload",
      `Canvas diagram layout revision positions exceed the node budget of ${CANVAS_MAX_DIAGRAM_NODES}.`,
    );
  }
  for (const position of command.positions) {
    if (!nodeIds.has(String(position.nodeId))) {
      return reject("unknown-node", "Canvas diagram layout revision positions an unknown node.");
    }
  }

  const revisedBlock = applyNodePositions(block, command.positions);
  const revisedDefinition = {
    ...current.definition,
    blocks: replaceBlock(current.definition.blocks, String(command.blockId), revisedBlock),
  };

  let validatedDefinition: typeof current.definition;
  try {
    validatedDefinition = validateCanvasDefinition(revisedDefinition);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Canvas definition validation failed.";
    return reject("oversized-payload", message);
  }

  const next: CanvasVersion = {
    schemaVersion: current.schemaVersion,
    canvasId: current.canvasId,
    versionId: decodedNextVersionId as typeof current.versionId,
    sequence: current.sequence + 1,
    definition: validatedDefinition,
    createdBy: command.actor,
    createdAt: now,
  };

  try {
    decodeCanvasVersion(next);
  } catch {
    return reject(
      "malformed-request",
      "Canvas diagram layout revision produced an invalid version.",
    );
  }

  return { kind: "accepted", next };
}
