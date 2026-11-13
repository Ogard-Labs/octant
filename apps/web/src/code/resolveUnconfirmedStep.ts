import type { CodeClient } from "@octant/client-runtime/code-client";
import {
  decodeCodeOperationId,
  type CodeBoardCard,
  type CodeUnconfirmedStepOutcome,
} from "@octant/contracts";
import type { CodeRuntimeWorkId } from "@octant/contracts/code";
import type { UnconfirmedStepResolution } from "./CodeThreadBoard";

/**
 * Send the person's word on an unconfirmed pull request update or merge. A
 * refusal or an unreachable host is a value the card shows, never a throw.
 */
export async function resolveUnconfirmedStep(
  client: Pick<CodeClient, "executeOperation">,
  card: Pick<CodeBoardCard, "threadId" | "checkoutId">,
  workId: CodeRuntimeWorkId,
  outcome: CodeUnconfirmedStepOutcome,
): Promise<UnconfirmedStepResolution> {
  try {
    const result = await client.executeOperation({
      kind: "resolve-unconfirmed-step",
      operationId: decodeCodeOperationId(globalThis.crypto.randomUUID()),
      threadId: card.threadId,
      checkoutId: card.checkoutId,
      workId,
      outcome,
    });
    return result.kind === "operation-failed"
      ? { status: "refused", message: result.failure.message }
      : { status: "resolved" };
  } catch {
    return { status: "refused", message: "Octant could not reach the host. Try again." };
  }
}
