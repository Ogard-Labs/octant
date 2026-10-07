import type { CodeClient } from "@octant/client-runtime/code-client";
import {
  WorkRequestClientFailure,
  type WorkRequestClient,
} from "@octant/client-runtime/work-request-client";
import { decodeCodeOperationId } from "@octant/contracts";
import { codeFailure } from "../code/codeControllerState";
import type { ApprovalDecision, ApprovalPendingRequest } from "./needsYouCommands";

export type PendingApprovalOutcome =
  | { readonly status: "answered" }
  | { readonly status: "refused"; readonly message: string };

/**
 * Answer one approval the host listed, through the same command the thread
 * view sends for that mode: `resolve-work-request` for Work and
 * `answer-provider-approval` for Code. The listed handle carries the ids the
 * command needs; the host re-checks the thread, checkout, and request version,
 * so a request that was answered or ended since the read comes back refused
 * instead of being applied twice.
 */
export async function answerPendingApproval(input: {
  readonly request: ApprovalPendingRequest;
  readonly decision: ApprovalDecision;
  readonly workRequestClient: WorkRequestClient;
  readonly codeClient: CodeClient;
}): Promise<PendingApprovalOutcome> {
  const { request, decision } = input;
  try {
    if (request.mode === "work") {
      await input.workRequestClient.execute({
        kind: "resolve-work-request",
        requestId: request.answer.requestId,
        expectedVersion: request.answer.expectedVersion,
        resolution: { kind: "approval", approved: decision === "approved" },
      });
      return { status: "answered" };
    }
    const result = await input.codeClient.executeOperation({
      kind: "answer-provider-approval",
      operationId: decodeCodeOperationId(globalThis.crypto.randomUUID()),
      threadId: request.answer.threadId,
      checkoutId: request.answer.checkoutId,
      approvalId: request.answer.approvalId,
      decision,
    });
    return result.kind === "operation-failed"
      ? { status: "refused", message: result.failure.message }
      : { status: "answered" };
  } catch (error) {
    return {
      status: "refused",
      message:
        request.mode === "work"
          ? error instanceof WorkRequestClientFailure
            ? error.message
            : "The answer could not be delivered."
          : codeFailure(error).message,
    };
  }
}
