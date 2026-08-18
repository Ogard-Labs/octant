import {
  decodeChatThreadId,
  decodeCodeCommand,
  decodeCodeOperationEventFrame,
  decodeCodeThreadId,
  type CodeCommand,
  type CodeCommandResult,
  type ChatThread,
  type ChatThreadId,
  type ChatThreadView,
  type ChatTurnId,
  type CodeOperationId,
  type CodeThread,
  type CodeThreadId,
  type EventEnvelope,
  type Project,
  type ProjectId,
} from "@octant/contracts";
import type { WindowId } from "@octant/contracts/shell";
import {
  chatTurnsThrough,
  defaultDeliveryBranchIntent,
  type CheckpointChatThreadFacts,
  type CheckpointCodeThreadFacts,
} from "@octant/domain";
import type { ThreadCheckpointChatPort, ThreadCheckpointCodePort } from "./threadCheckpointService";

export interface CheckpointChatPortDeps {
  readonly readChatThread: (threadId: ChatThreadId) => ChatThread | undefined;
  readonly readChatThreadView: (threadId: ChatThreadId) => ChatThreadView | undefined;
  readonly readProject: (projectId: ProjectId) => Project | undefined;
  readonly execute: (command: unknown) => Promise<unknown>;
}

/**
 * Chat's side of a checkpoint: the marked turn, and the branch that takes the
 * conversation up again from it.
 *
 * Restoring is the existing branch command, unchanged. Chat already knows how
 * to carry a conversation through one turn into a second thread without
 * touching the first, so a checkpoint restore adds a reason to call it rather
 * than a second way to do it.
 */
export function createCheckpointChatPort(deps: CheckpointChatPortDeps): ThreadCheckpointChatPort {
  return {
    facts: (threadId: ChatThreadId, turnId: ChatTurnId): CheckpointChatThreadFacts | undefined => {
      const thread = deps.readChatThread(threadId);
      if (thread === undefined) return undefined;
      const view = deps.readChatThreadView(threadId);
      const project =
        thread.projectId === undefined ? undefined : deps.readProject(thread.projectId);
      return {
        mode: "chat",
        threadId: String(thread.id),
        lifecycle: thread.lifecycle,
        // A revised turn is still journaled but is no longer part of the
        // conversation, and branching from it would show an exchange the user
        // has already replaced.
        carriesAnchor: view !== undefined && chatTurnsThrough(view.turns, turnId) !== undefined,
        ...(thread.projectId === undefined
          ? {}
          : {
              projectId: String(thread.projectId),
              projectAvailable: project?.lifecycle === "active",
            }),
      };
    },
    branch: async (input) => {
      const thread = deps.readChatThread(input.threadId);
      if (thread === undefined) return { status: "refused", reason: "thread-unavailable" };
      const result = await deps
        .execute({
          kind: "branch-chat-thread",
          threadId: input.threadId,
          expectedVersion: thread.version,
          turnId: input.turnId,
          title: input.title,
        })
        .catch(() => undefined);
      return isThreadCreated(result)
        ? { status: "created", threadId: decodeChatThreadId(result.thread.id) }
        : { status: "refused", reason: "restore-refused" };
    },
  };
}

export interface CheckpointCodePortDeps {
  readonly readCodeThread: (threadId: CodeThreadId) => CodeThread | undefined;
  readonly readProject: (projectId: ProjectId) => Project | undefined;
  /** The first journaled frame of one Code operation, which starts its turn. */
  readonly readOperationStart: (operationId: CodeOperationId) => EventEnvelope | undefined;
  readonly execute: (
    authenticatedWindowId: WindowId,
    command: CodeCommand,
  ) => Promise<CodeCommandResult> | CodeCommandResult;
  readonly uuid: () => string;
  readonly clock: () => string;
}

/**
 * Code's side of a checkpoint: the revision a marked turn ran on, and the new
 * thread that starts from it on its own managed worktree.
 *
 * The revision comes from the checkout snapshot Code already records before
 * every turn, so a checkpoint reads history rather than capturing anything new.
 * The restored thread starts approval-gated whatever the source thread holds —
 * a new thread has no approval receipt of its own — and takes a fresh delivery
 * branch so returning to a point never competes for the branch the original
 * work is still delivering on.
 */
export function createCheckpointCodePort(deps: CheckpointCodePortDeps): ThreadCheckpointCodePort {
  return {
    facts: (
      threadId: CodeThreadId,
      operationId: CodeOperationId,
    ): CheckpointCodeThreadFacts | undefined => {
      const thread = deps.readCodeThread(threadId);
      if (thread === undefined) return undefined;
      const project = deps.readProject(thread.projectId);
      const envelope = deps.readOperationStart(operationId);
      let carriesAnchor = false;
      let revision: string | undefined;
      if (envelope !== undefined) {
        try {
          const frame = decodeCodeOperationEventFrame(envelope.payload);
          carriesAnchor = String(frame.threadId) === String(threadId);
          if (carriesAnchor && frame.event.kind === "conversation-turn-started") {
            revision = frame.event.checkpoint?.head;
          }
        } catch {
          carriesAnchor = false;
        }
      }
      return {
        mode: "code",
        threadId: String(thread.id),
        lifecycle: thread.lifecycle,
        carriesAnchor,
        ...(revision === undefined ? {} : { revision }),
        projectId: String(thread.projectId),
        projectAvailable: project?.lifecycle === "active",
      };
    },
    restore: async (input) => {
      const source = deps.readCodeThread(input.sourceThreadId);
      if (source === undefined) return { status: "refused", reason: "thread-unavailable" };
      const threadId = decodeCodeThreadId(deps.uuid());
      const confirmedAt = deps.clock();
      // A pending outcome proposal belongs to the thread it was raised on; the
      // new thread starts with the confirmed outcome and no open proposal.
      const { proposedOutcome: _pending, ...deliveryTarget } = source.deliveryTarget;
      let command: CodeCommand;
      try {
        command = decodeCodeCommand({
          kind: "create-managed-code-thread",
          threadId,
          projectId: source.projectId,
          bindingRevisionId: source.bindingRevisionId,
          title: input.title,
          providerInstanceId: source.providerInstanceId,
          modelId: source.modelId,
          executionPolicy: "approval-gated",
          permissionPersistence: "current-session",
          deliveryTarget: {
            ...deliveryTarget,
            branchIntent: defaultDeliveryBranchIntent(
              deliveryTarget.branchIntent,
              String(threadId).replace(/-/g, "").slice(0, 12),
            ),
            // The user asked for this thread now, and it delivers the same kind
            // of outcome the thread it came from was confirmed for. Nothing here
            // raises that outcome; only the branch it lands on is new.
            confirmedAt,
          },
          sourceBranch: deliveryTarget.branchIntent,
          startFromOrigin: false,
          sourceRevision: input.revision,
          forkedFrom: {
            threadId: input.sourceThreadId,
            throughOperationId: input.operationId,
          },
        });
      } catch {
        return { status: "refused", reason: "restore-refused" };
      }
      const result = await Promise.resolve(
        deps.execute(input.authenticatedWindowId, command),
      ).catch(() => undefined);
      return result?.kind === "managed-thread-created"
        ? { status: "created", threadId }
        : { status: "refused", reason: "restore-refused" };
    },
  };
}

function isThreadCreated(
  result: unknown,
): result is { readonly kind: "thread-created"; readonly thread: { readonly id: string } } {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { readonly kind?: unknown }).kind === "thread-created"
  );
}
