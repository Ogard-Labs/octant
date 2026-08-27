import { describe, expect, it } from "vitest";
import {
  CANVAS_SCHEMA_VERSION,
  decodeCanvasVersion,
  type CanvasVersion,
} from "@octant/contracts/canvas";
import {
  CANVAS_COMMENT_BODY_MAX_CHARS,
  CANVAS_MAX_COMMENTS_PER_CANVAS,
  CANVAS_MAX_REPLIES_PER_COMMENT,
  type CanvasCommentReply,
} from "@octant/contracts/canvas-board";
import {
  admitCanvasCommentCommand,
  admitCanvasDiagramLayoutRevision,
  type CanvasCommentState,
} from "./canvasBoardPolicy";

const ids = {
  canvas: "11111111-1111-4111-8111-111111111111" as never,
  version: "22222222-2222-4222-8222-222222222222" as never,
  nextVersion: "33333333-3333-4333-8333-333333333333" as never,
  project: "44444444-4444-4444-8444-444444444444" as never,
  thread: "55555555-5555-4555-8555-555555555555" as never,
  provider: "66666666-6666-4666-8666-666666666666" as never,
  actor: "77777777-7777-4777-8777-777777777777" as never,
  comment: "88888888-8888-4888-8888-888888888888" as never,
  reply: "99999999-9999-4999-8999-999999999999" as never,
} as const;

const actor = { kind: "local-user" as const, actorId: ids.actor };
const agent = { kind: "agent" as const, actorId: ids.actor };
const system = { kind: "system" as const, actorId: ids.actor };
const now = "2026-08-01T21:00:00.000Z" as never;

const provenance = {
  mode: "chat" as const,
  hostId: "local",
  projectId: ids.project,
  threadId: ids.thread,
  actor,
  providerInstanceId: ids.provider,
  modelId: "octant-test-model",
  createdAt: now,
};

function comment(commentId: string | never = ids.comment): CanvasCommentState["comments"][number] {
  return {
    commentId: commentId as never,
    anchor: { kind: "block" as const, blockId: "heading-block" as never },
    author: actor,
    body: "First",
    createdAt: now,
  };
}

function diagramVersion(overrides: { nodes?: unknown[] } = {}): CanvasVersion {
  return decodeCanvasVersion({
    schemaVersion: CANVAS_SCHEMA_VERSION,
    canvasId: ids.canvas,
    versionId: ids.version,
    sequence: 1,
    definition: {
      schemaVersion: CANVAS_SCHEMA_VERSION,
      title: "Diagram",
      provenance,
      sourceManifest: [],
      blocks: [
        {
          blockId: "diagram-block" as never,
          schemaVersion: CANVAS_SCHEMA_VERSION,
          kind: "diagram" as const,
          nodes: overrides.nodes ?? [
            { nodeId: "client" as never, label: "Client" },
            { nodeId: "server" as never, label: "Server" },
          ],
          edges: [
            {
              edgeId: "client-server" as never,
              source: "client" as never,
              target: "server" as never,
            },
          ],
        },
      ],
    },
    createdBy: actor,
    createdAt: now,
  });
}

describe("Canvas comment policy", () => {
  const emptyState: CanvasCommentState = {
    comments: [],
    replies: [],
    sequence: 0,
  };

  it("admits a user-authored comment add and increments the board sequence", () => {
    const result = admitCanvasCommentCommand(
      {
        kind: "canvas-comment-add",
        canvasId: ids.canvas,
        commentId: ids.comment,
        anchor: { kind: "block", blockId: "heading-block" as never },
        author: actor,
        body: "Looks good.",
        expectedSequence: 0,
        issuedAt: now,
      },
      emptyState,
    );
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") throw new Error("expected accepted");
    expect("comment" in result.event).toBe(true);
    expect(result.event.sequence).toBe(1);
  });

  it("admits an agent-authored comment", () => {
    const result = admitCanvasCommentCommand(
      {
        kind: "canvas-comment-add",
        canvasId: ids.canvas,
        commentId: ids.comment,
        anchor: { kind: "block", blockId: "heading-block" as never },
        author: agent,
        body: "Agent note.",
        expectedSequence: 0,
        issuedAt: now,
      },
      emptyState,
    );
    expect(result.kind).toBe("accepted");
  });

  it("rejects a system-authored comment as unauthorized", () => {
    const result = admitCanvasCommentCommand(
      {
        kind: "canvas-comment-add",
        canvasId: ids.canvas,
        commentId: ids.comment,
        anchor: { kind: "block", blockId: "heading-block" as never },
        author: system,
        body: "System note.",
        expectedSequence: 0,
        issuedAt: now,
      },
      emptyState,
    );
    expect(result).toMatchObject({ kind: "rejected", code: "unauthorized" });
  });

  it("rejects a stale comment command", () => {
    const result = admitCanvasCommentCommand(
      {
        kind: "canvas-comment-add",
        canvasId: ids.canvas,
        commentId: ids.comment,
        anchor: { kind: "block", blockId: "heading-block" as never },
        author: actor,
        body: "Looks good.",
        expectedSequence: 5,
        issuedAt: now,
      },
      emptyState,
    );
    expect(result).toMatchObject({ kind: "rejected", code: "stale-version" });
  });

  it("rejects an oversized comment body as a malformed request", () => {
    const result = admitCanvasCommentCommand(
      {
        kind: "canvas-comment-add",
        canvasId: ids.canvas,
        commentId: ids.comment,
        anchor: { kind: "block", blockId: "heading-block" as never },
        author: actor,
        body: "x".repeat(CANVAS_COMMENT_BODY_MAX_CHARS + 1),
        expectedSequence: 0,
        issuedAt: now,
      },
      emptyState,
    );
    expect(result).toMatchObject({ kind: "rejected", code: "malformed-request" });
  });

  it("rejects a duplicate comment id", () => {
    const state: CanvasCommentState = {
      comments: [comment()],
      replies: [],
      sequence: 1,
    };
    const result = admitCanvasCommentCommand(
      {
        kind: "canvas-comment-add",
        canvasId: ids.canvas,
        commentId: ids.comment,
        anchor: { kind: "block", blockId: "heading-block" as never },
        author: actor,
        body: "Duplicate",
        expectedSequence: 1,
        issuedAt: "2026-08-01T21:00:01.000Z" as never,
      },
      state,
    );
    expect(result).toMatchObject({ kind: "rejected", code: "duplicate-comment" });
  });

  it("admits a reply to an existing comment", () => {
    const state: CanvasCommentState = {
      comments: [comment()],
      replies: [],
      sequence: 1,
    };
    const result = admitCanvasCommentCommand(
      {
        kind: "canvas-comment-reply",
        canvasId: ids.canvas,
        commentId: ids.comment,
        replyId: ids.reply,
        author: actor,
        body: "Agreed.",
        expectedSequence: 1,
        issuedAt: "2026-08-01T21:00:01.000Z" as never,
      },
      state,
    );
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") throw new Error("expected accepted");
    expect("reply" in result.event).toBe(true);
  });

  it("rejects a reply to a missing comment", () => {
    const result = admitCanvasCommentCommand(
      {
        kind: "canvas-comment-reply",
        canvasId: ids.canvas,
        commentId: ids.comment,
        replyId: ids.reply,
        author: actor,
        body: "Orphan reply.",
        expectedSequence: 0,
        issuedAt: now,
      },
      emptyState,
    );
    expect(result).toMatchObject({ kind: "rejected", code: "unknown-reply-target" });
  });

  it("rejects replies past the per-comment budget", () => {
    const replies: CanvasCommentReply[] = Array.from(
      { length: CANVAS_MAX_REPLIES_PER_COMMENT },
      (_, index) => ({
        replyId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` as never,
        commentId: ids.comment,
        author: actor,
        body: "reply",
        createdAt: now,
      }),
    );
    const state: CanvasCommentState = {
      comments: [comment()],
      replies,
      sequence: replies.length,
    };
    const result = admitCanvasCommentCommand(
      {
        kind: "canvas-comment-reply",
        canvasId: ids.canvas,
        commentId: ids.comment,
        replyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as never,
        author: actor,
        body: "One too many.",
        expectedSequence: state.sequence,
        issuedAt: "2026-08-01T21:00:01.000Z" as never,
      },
      state,
    );
    expect(result).toMatchObject({ kind: "rejected", code: "reply-budget-exceeded" });
  });

  it("admits resolving and deleting an existing comment", () => {
    const state: CanvasCommentState = {
      comments: [comment()],
      replies: [],
      sequence: 1,
    };
    const resolved = admitCanvasCommentCommand(
      {
        kind: "canvas-comment-resolve",
        canvasId: ids.canvas,
        commentId: ids.comment,
        resolvedBy: actor,
        expectedSequence: 1,
        issuedAt: "2026-08-01T21:00:01.000Z" as never,
      },
      state,
    );
    expect(resolved.kind).toBe("accepted");

    const deleted = admitCanvasCommentCommand(
      {
        kind: "canvas-comment-delete",
        canvasId: ids.canvas,
        commentId: ids.comment,
        deletedBy: actor,
        expectedSequence: 1,
        issuedAt: "2026-08-01T21:00:01.000Z" as never,
      },
      state,
    );
    expect(deleted.kind).toBe("accepted");
  });

  it("rejects resolving or deleting a comment that does not exist", () => {
    const resolve = admitCanvasCommentCommand(
      {
        kind: "canvas-comment-resolve",
        canvasId: ids.canvas,
        commentId: ids.comment,
        resolvedBy: actor,
        expectedSequence: 0,
        issuedAt: now,
      },
      emptyState,
    );
    expect(resolve).toMatchObject({ kind: "rejected", code: "unknown-comment" });

    const deleteCommand = admitCanvasCommentCommand(
      {
        kind: "canvas-comment-delete",
        canvasId: ids.canvas,
        commentId: ids.comment,
        deletedBy: actor,
        expectedSequence: 0,
        issuedAt: now,
      },
      emptyState,
    );
    expect(deleteCommand).toMatchObject({ kind: "rejected", code: "unknown-comment" });
  });

  it("rejects comments past the canvas-wide budget", () => {
    const comments = Array.from({ length: CANVAS_MAX_COMMENTS_PER_CANVAS }, (_, index) => ({
      commentId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` as never,
      anchor: { kind: "block" as const, blockId: "heading-block" as never },
      author: actor,
      body: "comment",
      createdAt: now,
    }));
    const state: CanvasCommentState = {
      comments,
      replies: [],
      sequence: comments.length,
    };
    const result = admitCanvasCommentCommand(
      {
        kind: "canvas-comment-add",
        canvasId: ids.canvas,
        commentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as never,
        anchor: { kind: "block", blockId: "heading-block" as never },
        author: actor,
        body: "One too many.",
        expectedSequence: state.sequence,
        issuedAt: "2026-08-01T21:00:01.000Z" as never,
      },
      state,
    );
    expect(result).toMatchObject({ kind: "rejected", code: "comment-budget-exceeded" });
  });
});

describe("Canvas diagram layout revision policy", () => {
  it("applies node positions and produces a new immutable version", () => {
    const current = diagramVersion();
    const result = admitCanvasDiagramLayoutRevision(
      {
        kind: "canvas-diagram-layout-revise",
        canvasId: ids.canvas,
        versionId: ids.nextVersion,
        blockId: "diagram-block" as never,
        positions: [
          { nodeId: "client" as never, x: 400, y: 500 },
          { nodeId: "server" as never, x: 600, y: 500 },
        ],
        actor,
        expectedSequence: 1,
        schemaVersion: CANVAS_SCHEMA_VERSION,
        issuedAt: now,
      },
      current,
      ids.nextVersion,
      "2026-08-01T21:00:01.000Z" as never,
    );
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") throw new Error("expected accepted");
    expect(result.next.sequence).toBe(2);
    expect(result.next.definition.blocks[0]?.kind).toBe("diagram");
    if (result.next.definition.blocks[0]?.kind !== "diagram") throw new Error("expected diagram");
    expect(result.next.definition.blocks[0].layout).toBe("manual");
    const client = result.next.definition.blocks[0].nodes.find((node) => node.nodeId === "client");
    expect(client?.x).toBe(400);
    expect(client?.y).toBe(500);
    expect(client?.positioned).toBe(true);
  });

  it("rejects a stale expected sequence", () => {
    const current = diagramVersion();
    const result = admitCanvasDiagramLayoutRevision(
      {
        kind: "canvas-diagram-layout-revise",
        canvasId: ids.canvas,
        versionId: ids.nextVersion,
        blockId: "diagram-block" as never,
        positions: [{ nodeId: "client" as never, x: 400, y: 500 }],
        actor,
        expectedSequence: 5,
        schemaVersion: CANVAS_SCHEMA_VERSION,
        issuedAt: now,
      },
      current,
      ids.nextVersion,
      "2026-08-01T21:00:01.000Z" as never,
    );
    expect(result).toMatchObject({ kind: "rejected", code: "stale-version" });
  });

  it("rejects positioning an unknown node", () => {
    const current = diagramVersion();
    const result = admitCanvasDiagramLayoutRevision(
      {
        kind: "canvas-diagram-layout-revise",
        canvasId: ids.canvas,
        versionId: ids.nextVersion,
        blockId: "diagram-block" as never,
        positions: [{ nodeId: "missing" as never, x: 400, y: 500 }],
        actor,
        expectedSequence: 1,
        schemaVersion: CANVAS_SCHEMA_VERSION,
        issuedAt: now,
      },
      current,
      ids.nextVersion,
      "2026-08-01T21:00:01.000Z" as never,
    );
    expect(result).toMatchObject({ kind: "rejected", code: "unknown-node" });
  });

  it("rejects targeting a non-diagram block", () => {
    const current = decodeCanvasVersion({
      schemaVersion: CANVAS_SCHEMA_VERSION,
      canvasId: ids.canvas,
      versionId: ids.version,
      sequence: 1,
      definition: {
        schemaVersion: CANVAS_SCHEMA_VERSION,
        title: "No diagram",
        provenance,
        sourceManifest: [],
        blocks: [
          {
            blockId: "heading-block" as never,
            schemaVersion: CANVAS_SCHEMA_VERSION,
            kind: "heading" as const,
            level: 1,
            text: "Title",
          },
        ],
      },
      createdBy: actor,
      createdAt: now,
    });
    const result = admitCanvasDiagramLayoutRevision(
      {
        kind: "canvas-diagram-layout-revise",
        canvasId: ids.canvas,
        versionId: ids.nextVersion,
        blockId: "heading-block" as never,
        positions: [{ nodeId: "client" as never, x: 400, y: 500 }],
        actor,
        expectedSequence: 1,
        schemaVersion: CANVAS_SCHEMA_VERSION,
        issuedAt: now,
      },
      current,
      ids.nextVersion,
      "2026-08-01T21:00:01.000Z" as never,
    );
    expect(result).toMatchObject({ kind: "rejected", code: "not-a-diagram" });
  });

  it("rejects a system-authored layout revision", () => {
    const current = diagramVersion();
    const result = admitCanvasDiagramLayoutRevision(
      {
        kind: "canvas-diagram-layout-revise",
        canvasId: ids.canvas,
        versionId: ids.nextVersion,
        blockId: "diagram-block" as never,
        positions: [{ nodeId: "client" as never, x: 400, y: 500 }],
        actor: system,
        expectedSequence: 1,
        schemaVersion: CANVAS_SCHEMA_VERSION,
        issuedAt: now,
      },
      current,
      ids.nextVersion,
      "2026-08-01T21:00:01.000Z" as never,
    );
    expect(result).toMatchObject({ kind: "rejected", code: "unauthorized" });
  });
});
