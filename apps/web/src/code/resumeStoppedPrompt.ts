import type { ProviderExecutionPolicy } from "@octant/contracts";
import type { CodeController } from "./useCodeController";
import type { CodeConversationMessage } from "./codeControllerState";

/**
 * The prompt a usage-limit stop can send again, or undefined when there is
 * none to send: the message is not in the loaded conversation, or its
 * evidence could not be read and its text is only a stand-in.
 */
export function stoppedPromptOf(
  conversation: ReadonlyArray<CodeConversationMessage>,
  operationId: string | undefined,
): string | undefined {
  if (operationId === undefined) return undefined;
  const message = conversation.find(
    (candidate) => candidate.role === "user" && String(candidate.operationId) === operationId,
  );
  if (message === undefined || message.promptUnavailable === true) return undefined;
  return message.text.trim().length === 0 ? undefined : message.text;
}

/**
 * Resume now: sends the stopped turn's prompt again as the person's next
 * turn. It is composed outside the composer, so the person's unsent draft is
 * neither cleared when the host accepts it nor overwritten when it refuses.
 */
export function resumeStoppedPromptNow(
  controller: Pick<CodeController, "sendFollowUp">,
  prompt: string,
  executionPolicy?: ProviderExecutionPolicy,
): Promise<boolean> {
  return controller.sendFollowUp(
    prompt,
    [],
    [],
    [],
    executionPolicy,
    undefined,
    undefined,
    undefined,
    [],
    undefined,
    [],
    false,
    undefined,
    { onAccepted: () => undefined },
  );
}
