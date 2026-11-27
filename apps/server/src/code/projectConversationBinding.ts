import {
  decodeCodeProjectConversationBound,
  type ProjectId,
  type CodeThreadId,
} from "@octant/contracts";
import type { Journal } from "../persistence/journal";

export function projectConversationId(
  journal: Pick<Journal, "replayAggregate">,
  projectId: ProjectId,
): CodeThreadId | undefined {
  const event = journal.replayAggregate({
    aggregateType: "code-project-conversation",
    aggregateId: projectId,
    afterVersion: 0,
    limit: 1,
  })[0];
  if (event?.eventName !== "code.project-conversation-bound@1") return undefined;
  const binding = decodeCodeProjectConversationBound(event.payload);
  if (binding.projectId !== projectId)
    throw new Error("The conversation binding names a different Project.");
  return binding.threadId;
}
