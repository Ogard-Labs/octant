import { randomUUID } from "node:crypto";
import {
  decodeThreadCheckpointCommandResult,
  decodeThreadCheckpointList,
  type OctantMode,
  type ThreadCheckpoint,
  type ThreadCheckpointRefusalReason,
} from "@octant/contracts";
import { refusalMessage, type HostRefusal } from "./agentHost";
import type { AgentThreadSnapshot, AgentThreadTurn } from "./agentThread";
import type { OpenedLocalControlSession } from "./localControl";

/**
 * Forks and checkpoints from the terminal, through the same host commands the
 * app sends. The host decides what a fork starts from and refuses what it
 * cannot do exactly; nothing here touches the thread it forks.
 */

export type AgentBranchResult =
  | HostRefusal
  | { readonly kind: "created"; readonly threadId: string; readonly mode: OctantMode };

/** The newest turn that finished: the point a fork or checkpoint is taken at. */
export function latestFinishedTurn(snapshot: AgentThreadSnapshot): AgentThreadTurn | undefined {
  return [...snapshot.turns].reverse().find((turn) => turn.outcome === "completed");
}

/**
 * Forks the thread at its newest finished reply into a new thread of the same
 * mode. A Code fork gets its own worktree and branch with the files as they
 * stood then; a Chat fork carries the conversation through that reply.
 */
export async function forkAgentThread(
  session: OpenedLocalControlSession,
  snapshot: AgentThreadSnapshot,
): Promise<AgentBranchResult> {
  const turn = latestFinishedTurn(snapshot);
  if (turn === undefined)
    return { kind: "refused", message: "There is no finished reply to fork from yet." };
  const title = `${snapshot.title} (fork)`;
  const threadId = randomUUID();
  if (snapshot.mode === "code") {
    const response = await session.send({
      path: "/api/code/commands",
      method: "POST",
      body: {
        kind: "fork-code-thread",
        threadId,
        sourceThreadId: snapshot.id,
        throughOperationId: turn.id,
        title,
      },
    });
    return response.status === 200
      ? { kind: "created", threadId, mode: "code" }
      : { kind: "refused", message: refusalMessage(response, "The thread could not be forked.") };
  }
  if (snapshot.mode === "chat") {
    const response = await session.send({
      path: "/api/chat/commands",
      method: "POST",
      body: {
        kind: "branch-chat-thread",
        threadId: snapshot.id,
        expectedVersion: snapshot.version,
        turnId: turn.id,
        title,
        branchThreadId: threadId,
      },
    });
    return response.status === 200
      ? { kind: "created", threadId, mode: "chat" }
      : { kind: "refused", message: refusalMessage(response, "The thread could not be forked.") };
  }
  return { kind: "refused", message: "Work threads cannot be forked yet." };
}

/** Marks the newest finished reply as a checkpoint the thread can be restored from. */
export async function markAgentCheckpoint(
  session: OpenedLocalControlSession,
  snapshot: AgentThreadSnapshot,
  label: string,
): Promise<HostRefusal | { readonly kind: "marked"; readonly checkpoint: ThreadCheckpoint }> {
  const turn = latestFinishedTurn(snapshot);
  if (turn === undefined)
    return { kind: "refused", message: "There is no finished reply to mark yet." };
  if (snapshot.mode === "work")
    return { kind: "refused", message: "Work threads have no checkpoints yet." };
  const response = await session.send({
    path: "/api/checkpoints/commands",
    method: "POST",
    body: {
      kind: "mark-thread-checkpoint",
      anchor:
        snapshot.mode === "code"
          ? { mode: "code", threadId: snapshot.id, operationId: turn.id }
          : { mode: "chat", threadId: snapshot.id, turnId: turn.id },
      label,
    },
  });
  if (response.status !== 200) {
    return { kind: "refused", message: refusalMessage(response, "The checkpoint was not marked.") };
  }
  const result = decodeThreadCheckpointCommandResult(response.body);
  if (result.kind === "checkpoint-marked") return { kind: "marked", checkpoint: result.checkpoint };
  return {
    kind: "refused",
    message:
      result.kind === "checkpoint-refused"
        ? CHECKPOINT_REFUSALS[result.reason]
        : "The checkpoint was not marked.",
  };
}

/** The thread's checkpoints that can still be restored, oldest first. */
export async function listAgentCheckpoints(
  session: OpenedLocalControlSession,
  threadId: string,
): Promise<
  HostRefusal | { readonly kind: "listed"; readonly checkpoints: ReadonlyArray<ThreadCheckpoint> }
> {
  const response = await session.send({
    path: `/api/checkpoints?threadId=${encodeURIComponent(threadId)}`,
    method: "GET",
  });
  if (response.status !== 200) {
    return { kind: "refused", message: refusalMessage(response, "Checkpoints could not be read.") };
  }
  return {
    kind: "listed",
    checkpoints: decodeThreadCheckpointList(response.body).checkpoints.filter(
      (checkpoint) => checkpoint.lifecycle === "marked",
    ),
  };
}

/**
 * Restores a checkpoint the only way the host does: as a new thread from that
 * point. The thread it was marked in is never rewound.
 */
export async function restoreAgentCheckpoint(
  session: OpenedLocalControlSession,
  checkpoint: ThreadCheckpoint,
  title: string,
): Promise<AgentBranchResult> {
  const response = await session.send({
    path: "/api/checkpoints/commands",
    method: "POST",
    body: {
      kind: "restore-from-thread-checkpoint",
      checkpointId: checkpoint.id,
      expectedVersion: checkpoint.version,
      title,
    },
  });
  if (response.status !== 200) {
    return {
      kind: "refused",
      message: refusalMessage(response, "The checkpoint was not restored."),
    };
  }
  const result = decodeThreadCheckpointCommandResult(response.body);
  if (result.kind === "checkpoint-restored") {
    return {
      kind: "created",
      threadId: String(result.restore.threadId),
      mode: result.restore.mode,
    };
  }
  return {
    kind: "refused",
    message:
      result.kind === "checkpoint-refused"
        ? CHECKPOINT_REFUSALS[result.reason]
        : "The checkpoint was not restored.",
  };
}

const CHECKPOINT_REFUSALS: Readonly<Record<ThreadCheckpointRefusalReason, string>> = {
  "thread-unavailable": "That thread is no longer available.",
  "anchor-unavailable": "That reply is no longer in the thread.",
  "revision-unavailable":
    "Octant did not record the files at that reply, so it cannot be a checkpoint.",
  "checkpoint-forgotten": "That checkpoint was forgotten.",
  "project-unavailable": "The thread's Project is no longer available.",
  "restore-unavailable": "Restoring checkpoints is unavailable on this host.",
  "restore-refused": "The host refused to restore that checkpoint.",
};
