import { describe, expect, it } from "vitest";
import {
  CANVAS_SCHEMA_VERSION,
  decodeCanvasComment,
  decodeCanvasCommentAdded,
  decodeCanvasCommentAddCommand,
  decodeCanvasCommentAnchor,
  decodeCanvasCommentCommand,
  decodeCanvasCommentDeleted,
  decodeCanvasCommentReplied,
  decodeCanvasCommentReply,
  decodeCanvasCommentReplyCommand,
  decodeCanvasCommentResolved,
  decodeCanvasDiagramLayoutReviseCommand,
  decodeCanvasDiagramLayoutRevised,
  decodeCanvasDiagramNodePosition,
} from "./canvasBoard";

const ids = {
  canvas: "11111111-1111-4111-8111-111111111111",
  comment: "22222222-2222-4222-8222-222222222222",
  reply: "33333333-3333-4333-8333-333333333333",
  region: "44444444-4444-4444-8444-444444444444",
  version: "55555555-5555-4555-8555-555555555555",
  actor: "66666666-6666-4666-8666-666666666666",
} as const;

const actor = { kind: "local-user" as const, actorId: ids.actor };

const anchor = {
  kind: "region" as const,
  blockId: "diagram-block",
  regionId: ids.region,
  x: 10,
  y: 20,
  width: 100,
  height: 80,
} as const;

describe("Canvas board comment contracts", () => {
  it("decodes a comment anchored to a region", () => {
    const comment = decodeCanvasComment({
      commentId: ids.comment,
      anchor,
      author: actor,
      body: "This edge feels wrong.",
      createdAt: "2026-08-01T21:00:00.000Z",
    });
    expect(comment.anchor.kind).toBe("region");
    expect(comment.body).toBe("This edge feels wrong.");
  });

  it("decodes comment anchors for block, node, and edge", () => {
    expect(
      decodeCanvasCommentAnchor({
        kind: "block",
        blockId: "heading-block",
      }).kind,
    ).toBe("block");
    expect(
      decodeCanvasCommentAnchor({
        kind: "node",
        blockId: "diagram-block",
        nodeId: "server",
      }).kind,
    ).toBe("node");
    expect(
      decodeCanvasCommentAnchor({
        kind: "edge",
        blockId: "diagram-block",
        edgeId: "client-server",
      }).kind,
    ).toBe("edge");
  });

  it("decodes add, reply, resolve, and delete commands", () => {
    const add = decodeCanvasCommentCommand({
      kind: "canvas-comment-add",
      canvasId: ids.canvas,
      commentId: ids.comment,
      anchor: { kind: "block", blockId: "heading-block" },
      author: actor,
      body: "Add command",
      expectedSequence: 5,
      issuedAt: "2026-08-01T21:00:00.000Z",
    });
    expect(add.kind).toBe("canvas-comment-add");

    const reply = decodeCanvasCommentCommand({
      kind: "canvas-comment-reply",
      canvasId: ids.canvas,
      commentId: ids.comment,
      replyId: ids.reply,
      author: actor,
      body: "Reply command",
      expectedSequence: 6,
      issuedAt: "2026-08-01T21:00:00.000Z",
    });
    expect(reply.kind).toBe("canvas-comment-reply");

    const resolve = decodeCanvasCommentCommand({
      kind: "canvas-comment-resolve",
      canvasId: ids.canvas,
      commentId: ids.comment,
      resolvedBy: actor,
      expectedSequence: 7,
      issuedAt: "2026-08-01T21:00:00.000Z",
    });
    expect(resolve.kind).toBe("canvas-comment-resolve");

    const deleteCommand = decodeCanvasCommentCommand({
      kind: "canvas-comment-delete",
      canvasId: ids.canvas,
      commentId: ids.comment,
      deletedBy: actor,
      expectedSequence: 8,
      issuedAt: "2026-08-01T21:00:00.000Z",
    });
    expect(deleteCommand.kind).toBe("canvas-comment-delete");
  });

  it("decodes comment events", () => {
    const comment = decodeCanvasComment({
      commentId: ids.comment,
      anchor: { kind: "block", blockId: "heading-block" },
      author: actor,
      body: "A comment",
      createdAt: "2026-08-01T21:00:00.000Z",
    });
    decodeCanvasCommentAdded({
      canvasId: ids.canvas,
      comment,
      sequence: 1,
    });

    const reply = decodeCanvasCommentReply({
      replyId: ids.reply,
      commentId: ids.comment,
      author: actor,
      body: "A reply",
      createdAt: "2026-08-01T21:00:00.000Z",
    });
    decodeCanvasCommentReplied({
      canvasId: ids.canvas,
      reply,
      sequence: 2,
    });

    decodeCanvasCommentResolved({
      canvasId: ids.canvas,
      commentId: ids.comment,
      resolvedBy: actor,
      resolvedAt: "2026-08-01T21:00:01.000Z",
      sequence: 3,
    });

    decodeCanvasCommentDeleted({
      canvasId: ids.canvas,
      commentId: ids.comment,
      deletedBy: actor,
      deletedAt: "2026-08-01T21:00:02.000Z",
      sequence: 4,
    });
  });

  it("rejects a comment body that is empty or too long", () => {
    expect(() =>
      decodeCanvasComment({
        commentId: ids.comment,
        anchor,
        author: actor,
        body: "",
        createdAt: "2026-08-01T21:00:00.000Z",
      }),
    ).toThrow();
    expect(() =>
      decodeCanvasComment({
        commentId: ids.comment,
        anchor,
        author: actor,
        body: "x".repeat(4097),
        createdAt: "2026-08-01T21:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects an unknown comment command kind", () => {
    expect(() =>
      decodeCanvasCommentCommand({
        kind: "canvas-comment-edit",
        canvasId: ids.canvas,
        commentId: ids.comment,
        author: actor,
        body: "edit",
        expectedSequence: 1,
        issuedAt: "2026-08-01T21:00:00.000Z",
      }),
    ).toThrow();
  });
});

describe("Canvas board diagram layout revision contracts", () => {
  it("decodes a layout revise command", () => {
    const command = decodeCanvasDiagramLayoutReviseCommand({
      kind: "canvas-diagram-layout-revise",
      canvasId: ids.canvas,
      versionId: ids.version,
      blockId: "diagram-block",
      positions: [
        { nodeId: "client", x: 100, y: 200 },
        { nodeId: "server", x: 300, y: 200 },
      ],
      actor,
      expectedSequence: 3,
      schemaVersion: CANVAS_SCHEMA_VERSION,
      issuedAt: "2026-08-01T21:00:00.000Z",
    });
    expect(command.positions).toHaveLength(2);
    expect(command.actor.kind).toBe("local-user");
  });

  it("decodes a layout revised event", () => {
    decodeCanvasDiagramLayoutRevised({
      canvasId: ids.canvas,
      versionId: ids.version,
      blockId: "diagram-block",
      positions: [{ nodeId: "client", x: 100, y: 200 }],
      actor,
      sequence: 4,
      revisedAt: "2026-08-01T21:00:00.000Z",
    });
  });

  it("rejects non-finite positions", () => {
    expect(() => decodeCanvasDiagramNodePosition({ nodeId: "client", x: NaN, y: 200 })).toThrow();
    expect(() =>
      decodeCanvasDiagramNodePosition({ nodeId: "client", x: 100, y: Infinity }),
    ).toThrow();
  });

  it("rejects a layout revise command without the current schema version", () => {
    expect(() =>
      decodeCanvasDiagramLayoutReviseCommand({
        kind: "canvas-diagram-layout-revise",
        canvasId: ids.canvas,
        versionId: ids.version,
        blockId: "diagram-block",
        positions: [{ nodeId: "client", x: 100, y: 200 }],
        actor,
        expectedSequence: 3,
        schemaVersion: 3,
        issuedAt: "2026-08-01T21:00:00.000Z",
      }),
    ).toThrow();
  });
});
