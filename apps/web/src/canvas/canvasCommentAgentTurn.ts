import type { CanvasDefinition } from "@octant/contracts/canvas";
import type {
  CanvasComment,
  CanvasCommentAnchor,
  CanvasCommentThread,
} from "@octant/contracts/canvas-board";
import type { CanvasVersionHistoryEntry } from "@octant/contracts/canvas-revision";
import type { CanvasContextSelection } from "@octant/contracts/canvasContext";
import type { OctantMode } from "@octant/contracts/modes";
import {
  decodeMentionableThreadId,
  decodeThreadMessageQueueCommand,
  type ThreadMessageQueueCommand,
  type ThreadMessageQueueResult,
  type ThreadMessageQueueScope,
  type ThreadMessageQueueSnapshot,
} from "@octant/contracts";

/**
 * A comment handed to the agent of the Canvas's owning thread as that thread's
 * next turn. It carries the prompt and the Canvas as context, and nothing
 * about authority: the host runs the turn under the thread's own.
 */
export interface CanvasCommentAgentTurn {
  readonly mode: OctantMode;
  readonly threadId: string;
  readonly prompt: string;
  readonly canvasSelection: CanvasContextSelection;
}

export type CanvasCommentAgentSendResult =
  | { readonly status: "sent" }
  | { readonly status: "refused"; readonly message: string };

/** Where a comment stands with the agent, read off the comment and the version history. */
export type CanvasCommentAgentState =
  | { readonly kind: "unsent" }
  | { readonly kind: "sent" }
  | { readonly kind: "addressed"; readonly sequence: number };

/**
 * A request is addressed by the first agent-authored version after the one
 * it was made against. A person's own drag or task change in between does
 * not answer it, so those versions are passed over.
 */
export function canvasCommentAgentState(
  comment: Pick<CanvasComment, "sentToAgent">,
  history: ReadonlyArray<CanvasVersionHistoryEntry>,
): CanvasCommentAgentState {
  const request = comment.sentToAgent;
  if (request === undefined) return { kind: "unsent" };
  const answered = history
    .filter((entry) => entry.sequence > request.canvasSequence && entry.createdBy.kind === "agent")
    .reduce<number | undefined>(
      (first, entry) => (first === undefined || entry.sequence < first ? entry.sequence : first),
      undefined,
    );
  return answered === undefined ? { kind: "sent" } : { kind: "addressed", sequence: answered };
}

/**
 * The anchor as the prompt names it: ids the agent can match against the
 * blocks it reads, beside the label the person saw.
 */
export function canvasCommentAnchorDescription(
  anchor: CanvasCommentAnchor,
  definition: Pick<CanvasDefinition, "blocks">,
): string {
  const blockId = String(anchor.blockId);
  const block = definition.blocks.find((candidate) => String(candidate.blockId) === blockId);
  const inBlock =
    block === undefined
      ? `block "${blockId}" (no longer on the canvas)`
      : `the ${block.kind} block "${blockId}"`;
  switch (anchor.kind) {
    case "block":
      return inBlock;
    case "node":
      return `node "${String(anchor.nodeId)}" in ${inBlock}`;
    case "edge":
      return `edge "${String(anchor.edgeId)}" in ${inBlock}`;
    case "row":
      return `row "${String(anchor.rowId)}" in ${inBlock}`;
    case "region":
      return `the region at x ${String(anchor.x)}, y ${String(anchor.y)}, ${String(anchor.width)} by ${String(anchor.height)} in ${inBlock}`;
  }
}

/** What the owning thread's agent is asked when a person sends a comment to it. */
export function canvasCommentAgentPrompt(input: {
  readonly definition: Pick<CanvasDefinition, "title" | "blocks">;
  readonly canvasId: string;
  readonly sequence: number;
  readonly thread: CanvasCommentThread;
  readonly anchorLabel: string;
}): string {
  const { comment, replies } = input.thread;
  return [
    `Revise the Canvas "${input.definition.title}" (canvasId ${input.canvasId}, version ${String(input.sequence)}) for a comment.`,
    `Change only ${canvasCommentAnchorDescription(comment.anchor, input.definition)}. Keep every other block identical, including block ids and order.`,
    `Comment on ${input.anchorLabel}: ${comment.body}`,
    ...replies.map((reply) => `Reply: ${reply.body}`),
    "Read the Canvas with the canvas tool first; the read lists this request under requestedChanges.",
  ].join("\n");
}

/**
 * Hands the turn to the owning thread through its message queue, which the
 * host dispatches as the thread's next turn under the thread's own authority.
 * The Canvas rides along as context where that mode's turn can carry one; a
 * Work or Code turn names it in the prompt and the agent reads it with the
 * Canvas tool.
 */
export async function enqueueCanvasCommentTurn(
  client: {
    readonly read: (scope: ThreadMessageQueueScope) => Promise<ThreadMessageQueueSnapshot>;
    readonly execute: (command: ThreadMessageQueueCommand) => Promise<ThreadMessageQueueResult>;
  },
  turn: CanvasCommentAgentTurn,
  uuid: () => string = () => globalThis.crypto.randomUUID(),
): Promise<CanvasCommentAgentSendResult> {
  const scope: ThreadMessageQueueScope = {
    mode: turn.mode,
    threadId: decodeMentionableThreadId(turn.threadId),
  };
  let snapshot: ThreadMessageQueueSnapshot;
  try {
    snapshot = await client.read(scope);
  } catch {
    return { status: "refused", message: "The thread cannot take a message right now." };
  }
  const command = decodeThreadMessageQueueCommand({
    kind: "enqueue",
    scope,
    expectedVersion: snapshot.version,
    requestId: uuid(),
    messageId: uuid(),
    payload:
      turn.mode === "chat"
        ? { mode: "chat", prompt: turn.prompt, canvasSelections: [turn.canvasSelection] }
        : { mode: turn.mode, prompt: turn.prompt },
  });
  let result: ThreadMessageQueueResult;
  try {
    result = await client.execute(command);
  } catch {
    return { status: "refused", message: "The host did not confirm the message." };
  }
  if (result.status === "refused") {
    return {
      status: "refused",
      message: `The host refused the message: ${result.reason.replaceAll("-", " ")}.`,
    };
  }
  if (result.status === "conflict") {
    return { status: "refused", message: "The thread's queue changed. Try again." };
  }
  return { status: "sent" };
}
