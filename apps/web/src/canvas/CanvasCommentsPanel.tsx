import {
  CANVAS_COMMENT_BODY_MAX_CHARS,
  decodeCanvasCommentId,
  decodeCanvasCommentReplyId,
  type CanvasCommentAnchor,
  type CanvasCommentCommand,
  type CanvasCommentCommandResult,
  type CanvasCommentThread,
  type CanvasCommentsOutcome,
} from "@octant/contracts/canvas-board";
import type { CanvasActor, CanvasDefinition, CanvasId } from "@octant/contracts/canvas";
import { decodeUtcTimestamp } from "@octant/contracts/events";
import { useCallback, useEffect, useMemo, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantTextarea } from "../ui/base/OctantTextarea";

export interface CanvasCommentsPanelProps {
  readonly canvasId: CanvasId;
  readonly definition: CanvasDefinition;
  /** The local user every comment is authored as; the host stamps the device. */
  readonly author: CanvasActor;
  readonly load: (canvasId: CanvasId) => Promise<CanvasCommentsOutcome>;
  readonly send: (command: CanvasCommentCommand) => Promise<CanvasCommentCommandResult>;
}

interface AnchorChoice {
  readonly id: string;
  readonly label: string;
  readonly anchor: CanvasCommentAnchor;
}

function anchorChoices(definition: CanvasDefinition): ReadonlyArray<AnchorChoice> {
  const choices: AnchorChoice[] = [];
  for (const block of definition.blocks) {
    const blockLabel =
      block.kind === "heading" ? block.text : block.kind === "diagram" ? "Board" : block.kind;
    choices.push({
      id: `block:${String(block.blockId)}`,
      label: blockLabel,
      anchor: { kind: "block", blockId: block.blockId },
    });
    if (block.kind === "diagram") {
      for (const node of block.nodes) {
        choices.push({
          id: `node:${String(block.blockId)}:${String(node.nodeId)}`,
          label: `Board · ${node.label}`,
          anchor: { kind: "node", blockId: block.blockId, nodeId: node.nodeId },
        });
      }
    }
  }
  return choices;
}

function anchorLabel(anchor: CanvasCommentAnchor, choices: ReadonlyArray<AnchorChoice>): string {
  const match = choices.find((choice) => {
    if (choice.anchor.kind !== anchor.kind) return false;
    if (anchor.kind === "node" && choice.anchor.kind === "node") {
      return String(choice.anchor.nodeId) === String(anchor.nodeId);
    }
    return String(choice.anchor.blockId) === String(anchor.blockId);
  });
  // A comment whose anchor left the document is shown, not dropped: the
  // conversation outlives the block it was about.
  return match?.label ?? "No longer on the canvas";
}

function authorLabel(thread: CanvasCommentThread["comment"]): string {
  const who = thread.author.kind === "agent" ? "Agent" : "You";
  return thread.origin?.kind === "remote-device" ? `${who} · paired device` : who;
}

/**
 * The conversation on a Canvas. Comments are journaled by the host and read
 * back at a sequence; every command names the sequence it saw, so a comment
 * that lands after someone else's is refused and the list reloads rather
 * than two people each believing they went first.
 */
export function CanvasCommentsPanel(props: CanvasCommentsPanelProps) {
  const [outcome, setOutcome] = useState<CanvasCommentsOutcome>();
  const [body, setBody] = useState("");
  const [replyBodies, setReplyBodies] = useState<ReadonlyMap<string, string>>(new Map());
  const [message, setMessage] = useState<string>();
  const [working, setWorking] = useState(false);
  const choices = useMemo(() => anchorChoices(props.definition), [props.definition]);
  const [anchorId, setAnchorId] = useState<string>();
  const selectedAnchor = choices.find((choice) => choice.id === anchorId) ?? choices[0];

  const reload = useCallback(async () => {
    try {
      setOutcome(await props.load(props.canvasId));
    } catch {
      setOutcome({
        kind: "unavailable",
        canvasId: props.canvasId,
        reason: "Comments could not be loaded from the host.",
      });
    }
  }, [props.canvasId, props.load]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const dispatch = async (
    build: (expectedSequence: number) => CanvasCommentCommand,
    after: () => void,
  ) => {
    if (outcome?.kind !== "ready") return;
    setWorking(true);
    setMessage(undefined);
    try {
      const result = await props.send(build(outcome.sequence));
      if (result.kind === "accepted") {
        after();
      } else if (result.denialCode === "stale-version") {
        setMessage("Comments changed on the host and were reloaded. Try again.");
      } else {
        setMessage(result.message);
      }
    } catch {
      setMessage("The comment could not reach the host.");
    } finally {
      setWorking(false);
      await reload();
    }
  };

  const now = () => decodeUtcTimestamp(new Date().toISOString());

  if (outcome === undefined) return null;
  if (outcome.kind === "unauthorized") return null;
  if (outcome.kind === "unavailable") {
    return (
      <section aria-label="Canvas comments" className="canvas-comments">
        <h3 className="canvas-comments__title">Comments</h3>
        <p className="canvas-comments__note">{outcome.reason}</p>
      </section>
    );
  }

  return (
    <section aria-label="Canvas comments" className="canvas-comments">
      <h3 className="canvas-comments__title">Comments</h3>
      {outcome.threads.length === 0 ? (
        <p className="canvas-comments__note">No comments yet.</p>
      ) : (
        <ul aria-label="Comment threads" className="canvas-comments__list">
          {outcome.threads.map((thread) => {
            const commentId = String(thread.comment.commentId);
            const resolved = thread.comment.resolvedAt !== undefined;
            return (
              <li
                className="canvas-comments__thread"
                data-resolved={resolved ? "true" : "false"}
                key={commentId}
              >
                <p className="canvas-comments__meta">
                  <span>{anchorLabel(thread.comment.anchor, choices)}</span>
                  <span>{authorLabel(thread.comment)}</span>
                  {resolved ? <span>Resolved</span> : null}
                </p>
                <p className="canvas-comments__body">{thread.comment.body}</p>
                {thread.replies.map((reply) => (
                  <p className="canvas-comments__reply" key={String(reply.replyId)}>
                    <span className="canvas-comments__meta">
                      {reply.author.kind === "agent" ? "Agent" : "You"}
                    </span>
                    {reply.body}
                  </p>
                ))}
                <div className="canvas-comments__actions">
                  <OctantTextarea
                    aria-label={`Reply to comment on ${anchorLabel(thread.comment.anchor, choices)}`}
                    disabled={working}
                    maxLength={CANVAS_COMMENT_BODY_MAX_CHARS}
                    onChange={(event) =>
                      setReplyBodies((current) =>
                        new Map(current).set(commentId, event.target.value),
                      )
                    }
                    rows={1}
                    value={replyBodies.get(commentId) ?? ""}
                  />
                  <OctantButton
                    disabled={working || (replyBodies.get(commentId) ?? "").trim() === ""}
                    onClick={() =>
                      void dispatch(
                        (expectedSequence) => ({
                          kind: "canvas-comment-reply",
                          canvasId: props.canvasId,
                          commentId: thread.comment.commentId,
                          replyId: decodeCanvasCommentReplyId(globalThis.crypto.randomUUID()),
                          author: props.author,
                          body: (replyBodies.get(commentId) ?? "").trim(),
                          expectedSequence,
                          issuedAt: now(),
                        }),
                        () =>
                          setReplyBodies((current) => {
                            const next = new Map(current);
                            next.delete(commentId);
                            return next;
                          }),
                      )
                    }
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    Reply
                  </OctantButton>
                  {resolved ? null : (
                    <OctantButton
                      disabled={working}
                      onClick={() =>
                        void dispatch(
                          (expectedSequence) => ({
                            kind: "canvas-comment-resolve",
                            canvasId: props.canvasId,
                            commentId: thread.comment.commentId,
                            resolvedBy: props.author,
                            expectedSequence,
                            issuedAt: now(),
                          }),
                          () => undefined,
                        )
                      }
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      Resolve
                    </OctantButton>
                  )}
                  <OctantButton
                    disabled={working}
                    onClick={() =>
                      void dispatch(
                        (expectedSequence) => ({
                          kind: "canvas-comment-delete",
                          canvasId: props.canvasId,
                          commentId: thread.comment.commentId,
                          deletedBy: props.author,
                          expectedSequence,
                          issuedAt: now(),
                        }),
                        () => undefined,
                      )
                    }
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Delete
                  </OctantButton>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {selectedAnchor === undefined ? null : (
        <form
          className="canvas-comments__compose"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = body.trim();
            if (trimmed === "") return;
            void dispatch(
              (expectedSequence) => ({
                kind: "canvas-comment-add",
                canvasId: props.canvasId,
                commentId: decodeCanvasCommentId(globalThis.crypto.randomUUID()),
                anchor: selectedAnchor.anchor,
                author: props.author,
                body: trimmed,
                expectedSequence,
                issuedAt: now(),
              }),
              () => setBody(""),
            );
          }}
        >
          <label className="canvas-comments__field">
            <span>On</span>
            <OctantSelectField
              aria-label="Comment anchor"
              disabled={working}
              onValueChange={setAnchorId}
              options={choices.map((choice) => ({ id: choice.id, label: choice.label }))}
              value={selectedAnchor.id}
            />
          </label>
          <OctantTextarea
            aria-label="New comment"
            disabled={working}
            maxLength={CANVAS_COMMENT_BODY_MAX_CHARS}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Add a comment…"
            rows={2}
            value={body}
          />
          <OctantButton
            disabled={working || body.trim() === ""}
            size="sm"
            type="submit"
            variant="secondary"
          >
            Comment
          </OctantButton>
        </form>
      )}
      {message === undefined ? null : (
        <p className="canvas-comments__note" role="alert">
          {message}
        </p>
      )}
    </section>
  );
}
