import type { CodeClient } from "@octant/client-runtime/code-client";
import type { CodeCheckoutId, CodeThreadId } from "@octant/contracts/code";
import type { CodeOperationResult } from "@octant/contracts/code-operations";
import type { CodeDiffProjection } from "./CodeDiffPane";

type RunReviewed = Extract<CodeOperationResult, { readonly kind: "run-reviewed" }>;

export const MAX_DIFF_BYTES = 1024 * 1024;

export interface CodeDiffScope {
  readonly checkoutId: CodeCheckoutId;
  readonly threadId: CodeThreadId;
}

/**
 * What a thread changed: the checkout's local changes and, when the checkout
 * is clean, the branch diff a finished run produced.
 *
 * The Review dock tool and the Review page read the same two operations, so
 * they cannot disagree about what "the changes" are. A refusal or an
 * unreachable host is a value the caller shows, never a thrown error.
 */
export async function observeCodeThreadDiff(
  client: Pick<CodeClient, "executeOperation">,
  nextUuid: () => string,
  scope: CodeDiffScope,
): Promise<CodeDiffProjection> {
  try {
    const checkout = await client.executeOperation({
      kind: "observe-git",
      operationId: nextUuid() as never,
      gitOperationId: nextUuid() as never,
      maxDiffBytes: MAX_DIFF_BYTES,
      ...scope,
    });
    if (checkout.kind === "operation-failed") {
      return { state: "unavailable", message: checkout.failure.message };
    }
    if (checkout.kind !== "git-observed") {
      return {
        state: "unavailable",
        message: "Git observation returned no authoritative checkout state.",
      };
    }
    if (checkout.changedPaths.length > 0) {
      return { state: "available", observation: checkout, ...scope };
    }
    const run = await readRunReview(client, nextUuid, scope);
    if (run !== undefined && run.outcome.changedPaths.length > 0) {
      return { state: "run", run, ...scope };
    }
    return { state: "available", observation: checkout, ...scope };
  } catch {
    return {
      state: "unavailable",
      message: "Git observation is unavailable. Reconnect and retry.",
    };
  }
}

async function readRunReview(
  client: Pick<CodeClient, "executeOperation">,
  nextUuid: () => string,
  scope: CodeDiffScope,
): Promise<RunReviewed | undefined> {
  try {
    const result = await client.executeOperation({
      kind: "review-run",
      operationId: nextUuid() as never,
      gitOperationId: nextUuid() as never,
      maxDiffBytes: MAX_DIFF_BYTES,
      ...scope,
    });
    return result.kind === "run-reviewed" ? result : undefined;
  } catch {
    return undefined;
  }
}
