import {
  decodeCodeThreadId,
  decodeWindowId,
  type CodeThread,
  type ProviderExecutionPolicy,
} from "@octant/contracts";
import type { CodeOperationRuntime } from "./codeOperationRuntime";
import type { CodeSessionAuthorityStore } from "./codeSessionAuthorityStore";

/**
 * A Code thread's access posture as its running turn may use it: the window's
 * session grant, clamped to the posture the turn holds. A turn narrowed to Plan
 * on a thread stored wider reads Plan here, so everything that asks (the offered
 * tools, a command's network, the call-time authority) agrees with the turn.
 *
 * A posture that cannot be read fails closed to Plan. The stored posture is not
 * the safe answer, because the turn may be narrower than it.
 */
export function codeTurnExecutionPolicyReader(input: {
  readonly readCodeThread: (
    threadId: ReturnType<typeof decodeCodeThreadId>,
  ) => CodeThread | undefined;
  readonly codeSessionAuthority: Pick<CodeSessionAuthorityStore, "effectiveThread">;
  readonly codeOperationRuntime:
    | Pick<CodeOperationRuntime, "threadWithActiveTurnPosture">
    | undefined;
}): (threadId: string, windowId?: string) => ProviderExecutionPolicy | undefined {
  return (threadId, windowId) => {
    try {
      const stored = input.readCodeThread(decodeCodeThreadId(threadId));
      if (stored === undefined) return undefined;
      const session =
        windowId === undefined
          ? stored
          : input.codeSessionAuthority.effectiveThread(decodeWindowId(windowId), stored);
      return (input.codeOperationRuntime?.threadWithActiveTurnPosture?.(session) ?? session)
        .executionPolicy;
    } catch {
      return "plan";
    }
  };
}
