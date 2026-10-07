import { decodeChatThreadId, type ChatThread } from "@octant/contracts";

import { agentResultDeliveryReceipt } from "../agentRun/agentResultDeliveryBatch";
import type { AgentResultDeliveryModePort } from "../agentRun/agentResultDeliveryService";
import { ChatServiceError, type ChatService } from "./chatService";

/**
 * How a finished child's result reaches a Chat parent: one host-composed turn,
 * admitted through the ordinary Chat command path.
 *
 * The delivery names the parent at the version Chat checks against, the
 * thread aggregate's head, which every turn advances. The projected thread
 * row keeps the version of the last thread update instead, so once the parent
 * had taken a turn a delivery addressed with it was refused as "Chat thread
 * changed" and journaled as a failed delivery. A refusal that only says the
 * parent is busy or moved on is waited out, as Work does; the parent's next
 * commit or the retry cadence tries again.
 */
export function createChatAgentResultDeliveryPort(input: {
  readonly readThread: (threadId: ReturnType<typeof decodeChatThreadId>) => ChatThread | undefined;
  readonly chat: Pick<ChatService, "read" | "execute">;
}): AgentResultDeliveryModePort {
  return {
    inspect: async (run) =>
      input.readThread(decodeChatThreadId(String(run.parentThreadId))) === undefined
        ? { kind: "invalid", detail: "The parent Chat thread is gone." }
        : { kind: "ready" },
    dispatch: async (runs) => {
      const run = runs[0];
      if (run === undefined) return { kind: "refused", detail: "No child results were supplied." };
      const delivery = {
        kind: "agent-result" as const,
        runId: run.id,
        runIds: runs.map((child) => child.id),
        runGenerations: runs.map((child) => ({
          runId: child.id,
          generation: child.generation ?? 1,
        })),
      };
      const threadId = decodeChatThreadId(String(run.parentThreadId));
      if (input.readThread(threadId) === undefined) {
        return { kind: "refused", detail: "The parent Chat thread is gone." };
      }
      try {
        const thread = input.chat.read(threadId).thread;
        const result = await input.chat.execute({
          kind: "deliver-chat-agent-result",
          threadId: thread.id,
          expectedVersion: thread.version,
          runId: delivery.runId,
          runIds: delivery.runIds,
          runGenerations: delivery.runGenerations,
        });
        return agentResultDeliveryReceipt(
          delivery,
          result.kind === "turn-created" ? result.turn.delivery : undefined,
        );
      } catch (error) {
        if (
          error instanceof ChatServiceError &&
          (error.failure.category === "waiting" || error.failure.category === "stale")
        ) {
          return { kind: "deferred", detail: "The parent Chat thread is mid-turn." };
        }
        return {
          kind: "refused",
          detail: error instanceof Error ? error.message : "The delivery could not be admitted.",
        };
      }
    },
  };
}
