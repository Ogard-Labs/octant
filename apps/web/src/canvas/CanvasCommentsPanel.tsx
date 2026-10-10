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
import {
  canvasTableRowCells,
  canvasTableRowId,
  decodeCanvasNodeId,
  type CanvasActor,
  type CanvasDefinition,
  type CanvasId,
} from "@octant/contracts/canvas";
import { decodeUtcTimestamp } from "@octant/contracts/events";
import { useCallback, useEffect, useMemo, useState } from "react";
import { canvasBlockLabel } from "./CanvasDocument";
import { canvasTableRowLabel } from "./blocks/TableBlock";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { OctantAlert } from "../ui/base/OctantAlert";

export interface CanvasCommentsPanelProps {
  readonly canvasId: CanvasId;
  readonly definition: CanvasDefinition;
  /**
   * The person sending these comments. The host replaces it with its own
   * person and stamps the device, so the field cannot make a comment an agent's.
   */
  readonly author: CanvasActor;
  readonly load: (canvasId: CanvasId) => Promise<CanvasCommentsOutcome>;
  readonly send: (command: CanvasCommentCommand) => Promise<CanvasCommentCommandResult>;
  /**
   * The block a reader opened comments from. The list narrows to that block's
   * threads and a new comment lands on it until the reader shows them all.
   */
  readonly focusedBlockId?: string;
  /**
   * The table row, inside the focused block, a reader opened comments from.
   * The list narrows to that row's threads and a new comment lands on it.
   */
  readonly focusedRowId?: string;
  readonly onShowAllBlocks?: () => void;
  /** Every journaled thread, reported whenever the host's list is reloaded. */
  readonly onThreadsChange?: (threads: ReadonlyArray<CanvasCommentThread>) => void;
}

type CommentFilter = "open" | "resolved" | "all";

const FILTERS: ReadonlyArray<{ readonly id: CommentFilter; readonly label: string }> = [
  { id: "open", label: "Open" },
  { id: "resolved", label: "Resolved" },
  { id: "all", label: "All" },
];

interface AnchorChoice {
  readonly id: string;
  readonly label: string;
  readonly anchor: CanvasCommentAnchor;
}

function anchorChoices(definition: CanvasDefinition): ReadonlyArray<AnchorChoice> {
  const choices: AnchorChoice[] = [];
  for (const block of definition.blocks) {
    const blockLabel = canvasBlockLabel(block);
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
    if (block.kind === "sequence") {
      for (const participant of block.participants) {
        choices.push({
          id: `node:${String(block.blockId)}:${String(participant.participantId)}`,
          label: `Sequence · ${participant.label}`,
          anchor: { kind: "node", blockId: block.blockId, nodeId: participant.participantId },
        });
      }
      for (const message of block.messages) {
        choices.push({
          id: `edge:${String(block.blockId)}:${String(message.messageId)}`,
          label: `Sequence · ${message.label}`,
          anchor: { kind: "edge", blockId: block.blockId, edgeId: message.messageId },
        });
      }
    }
    if (block.kind === "state") {
      for (const state of block.states) {
        choices.push({
          id: `node:${String(block.blockId)}:${String(state.stateId)}`,
          label: `State · ${state.label}`,
          anchor: { kind: "node", blockId: block.blockId, nodeId: state.stateId },
        });
      }
      for (const transition of block.transitions) {
        choices.push({
          id: `edge:${String(block.blockId)}:${String(transition.transitionId)}`,
          label: `State · ${transition.label}`,
          anchor: { kind: "edge", blockId: block.blockId, edgeId: transition.transitionId },
        });
      }
    }
    if (block.kind === "er") {
      for (const entity of block.entities) {
        choices.push({
          id: `node:${String(block.blockId)}:${String(entity.entityId)}`,
          label: `Entity · ${entity.label}`,
          anchor: { kind: "node", blockId: block.blockId, nodeId: entity.entityId },
        });
      }
      for (const relationship of block.relationships) {
        choices.push({
          id: `edge:${String(block.blockId)}:${String(relationship.relationshipId)}`,
          label: `Relationship · ${relationship.sourceCardinality} to ${relationship.targetCardinality}`,
          anchor: {
            kind: "edge",
            blockId: block.blockId,
            edgeId: relationship.relationshipId,
          },
        });
      }
    }
    if (block.kind === "swimlane") {
      for (const step of block.steps) {
        choices.push({
          id: `node:${String(block.blockId)}:${String(step.stepId)}`,
          label: `Step · ${step.label}`,
          anchor: { kind: "node", blockId: block.blockId, nodeId: step.stepId },
        });
      }
      for (const connection of block.connections) {
        choices.push({
          id: `edge:${String(block.blockId)}:${String(connection.connectionId)}`,
          label: `Connection · ${connection.label ?? "step"}`,
          anchor: { kind: "edge", blockId: block.blockId, edgeId: connection.connectionId },
        });
      }
    }
    if (block.kind === "table") {
      // Only a row that names itself can take a comment: an index would move
      // the comment to another row when the reader sorts or the agent revises.
      for (const row of block.rows) {
        const rowId = canvasTableRowId(row);
        if (rowId === undefined) continue;
        choices.push({
          id: `row:${String(block.blockId)}:${String(rowId)}`,
          label: `Row · ${canvasTableRowLabel(block, canvasTableRowCells(row))}`,
          anchor: { kind: "row", blockId: block.blockId, rowId },
        });
      }
    }
    if (block.kind === "comparison-matrix") {
      // A cell has no anchor of its own in the board contract, so a comment on
      // one sits on its option's column or its criterion's row.
      for (const option of block.options) {
        choices.push({
          id: `node:${String(block.blockId)}:${String(option.optionId)}`,
          label: `Option · ${option.label}`,
          anchor: { kind: "node", blockId: block.blockId, nodeId: option.optionId },
        });
      }
      for (const criterion of block.criteria) {
        choices.push({
          id: `node:${String(block.blockId)}:${String(criterion.criterionId)}`,
          label: `Criterion · ${criterion.label}`,
          anchor: { kind: "node", blockId: block.blockId, nodeId: criterion.criterionId },
        });
      }
    }
    if (block.kind === "mockup") {
      // A numbered callout is a place a reader replies: its comment anchors to
      // the node the callout is pinned to.
      const labels = new Map(block.nodes.map((node) => [String(node.nodeId), node.label]));
      (block.annotations ?? []).forEach((annotation, index) => {
        const nodeId = String(annotation.nodeId);
        choices.push({
          id: `node:${String(block.blockId)}:${nodeId}`,
          label: `Callout ${String(index + 1)} · ${labels.get(nodeId) ?? nodeId}`,
          anchor: { kind: "node", blockId: block.blockId, nodeId: decodeCanvasNodeId(nodeId) },
        });
      });
    }
    if (block.kind === "mindmap") {
      for (const node of block.nodes) {
        choices.push({
          id: `node:${String(block.blockId)}:${String(node.nodeId)}`,
          label: `Topic · ${node.label}`,
          anchor: { kind: "node", blockId: block.blockId, nodeId: node.nodeId },
        });
      }
    }
  }
  return choices;
}

function anchorLabel(anchor: CanvasCommentAnchor, choices: ReadonlyArray<AnchorChoice>): string {
  const match = choices.find((choice) => sameAnchor(choice.anchor, anchor));
  // A comment whose anchor left the document is shown, not dropped: the
  // conversation outlives the block it was about.
  return match?.label ?? OUTDATED_ANCHOR_LABEL;
}

function sameAnchor(left: CanvasCommentAnchor, right: CanvasCommentAnchor): boolean {
  if (left.kind !== right.kind) return false;
  if (String(left.blockId) !== String(right.blockId)) return false;
  if (left.kind === "node" && right.kind === "node") {
    return String(left.nodeId) === String(right.nodeId);
  }
  if (left.kind === "edge" && right.kind === "edge") {
    return String(left.edgeId) === String(right.edgeId);
  }
  if (left.kind === "row" && right.kind === "row") {
    return String(left.rowId) === String(right.rowId);
  }
  return left.kind === "block" || left.kind === "region";
}

const OUTDATED_ANCHOR_LABEL = "No longer on the canvas";

function authorLabel(item: Pick<CanvasCommentThread["comment"], "author" | "origin">): string {
  const who = item.author.kind === "agent" ? "Agent" : "You";
  switch (item.origin?.kind) {
    case "remote-device":
      return `${who} · paired device`;
    case "replica":
      // Written on another of this person's computers and taken in by sync.
      return `${who} · ${item.origin.computerName}`;
    default:
      return who;
  }
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
  const [filter, setFilter] = useState<CommentFilter>("open");
  const focusedChoiceId =
    props.focusedBlockId === undefined
      ? undefined
      : props.focusedRowId === undefined
        ? `block:${props.focusedBlockId}`
        : `row:${props.focusedBlockId}:${props.focusedRowId}`;
  useEffect(() => {
    if (focusedChoiceId !== undefined) setAnchorId(focusedChoiceId);
  }, [focusedChoiceId]);
  // A reader focused on a row or block that a later version removed has
  // nothing to add a comment to. Falling back to the first anchor would land
  // the comment on an unrelated block, hidden by the focused filter, so the
  // composer is withheld until the reader shows all comments or picks again.
  const focusLeftCanvas =
    focusedChoiceId !== undefined &&
    anchorId === focusedChoiceId &&
    !choices.some((choice) => choice.id === focusedChoiceId);
  const selectedAnchor = focusLeftCanvas
    ? undefined
    : (choices.find((choice) => choice.id === anchorId) ?? choices[0]);
  const { onThreadsChange } = props;

  const reload = useCallback(async () => {
    try {
      const next = await props.load(props.canvasId);
      setOutcome(next);
      onThreadsChange?.(next.kind === "ready" ? next.threads : []);
    } catch {
      setOutcome({
        kind: "unavailable",
        canvasId: props.canvasId,
        reason: "Comments could not be loaded from the host.",
      });
    }
  }, [props.canvasId, props.load, onThreadsChange]);

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
        <p className="canvas-comments__note">{outcome.reason}</p>
      </section>
    );
  }

  const focusedLabel = choices.find((choice) => choice.id === focusedChoiceId)?.label;
  const visible = outcome.threads.filter((thread) => {
    const resolved = thread.comment.resolvedAt !== undefined;
    if (filter === "open" && resolved) return false;
    if (filter === "resolved" && !resolved) return false;
    const anchor = thread.comment.anchor;
    if (props.focusedBlockId === undefined) return true;
    if (String(anchor.blockId) !== props.focusedBlockId) return false;
    return (
      props.focusedRowId === undefined ||
      (anchor.kind === "row" && String(anchor.rowId) === props.focusedRowId)
    );
  });

  return (
    <section aria-label="Canvas comments" className="canvas-comments">
      <div aria-label="Show comments" className="canvas-comments__filters" role="group">
        {FILTERS.map((option) => (
          <OctantButton
            aria-pressed={filter === option.id}
            key={option.id}
            onClick={() => setFilter(option.id)}
            size="sm"
            type="button"
            variant={filter === option.id ? "secondary" : "ghost"}
          >
            {option.label}
          </OctantButton>
        ))}
      </div>
      {props.focusedBlockId === undefined ? null : (
        <p className="canvas-comments__scope">
          <span>On {focusedLabel ?? OUTDATED_ANCHOR_LABEL}</span>
          {props.onShowAllBlocks === undefined ? null : (
            <OctantButton onClick={props.onShowAllBlocks} size="sm" type="button" variant="ghost">
              Show all
            </OctantButton>
          )}
        </p>
      )}
      {outcome.threads.length === 0 ? (
        <p className="canvas-comments__note">No comments yet.</p>
      ) : visible.length === 0 ? (
        <p className="canvas-comments__note">
          {filter === "resolved" ? "No resolved comments." : "No open comments."}
        </p>
      ) : (
        <ul aria-label="Comment threads" className="canvas-comments__list">
          {visible.map((thread) => {
            const commentId = String(thread.comment.commentId);
            const resolved = thread.comment.resolvedAt !== undefined;
            const onLabel = anchorLabel(thread.comment.anchor, choices);
            return (
              <li
                className="canvas-comments__thread"
                data-outdated={onLabel === OUTDATED_ANCHOR_LABEL ? "true" : "false"}
                data-resolved={resolved ? "true" : "false"}
                key={commentId}
              >
                <p className="canvas-comments__meta">
                  <span>{onLabel}</span>
                  <span>{authorLabel(thread.comment)}</span>
                  {resolved ? <span>Resolved</span> : null}
                </p>
                <p className="canvas-comments__body">{thread.comment.body}</p>
                {thread.replies.map((reply) => (
                  <p className="canvas-comments__reply" key={String(reply.replyId)}>
                    <span className="canvas-comments__meta">{authorLabel(reply)}</span>
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
        <OctantAlert className="canvas-comments__note" tone="warning">
          {message}
        </OctantAlert>
      )}
    </section>
  );
}
