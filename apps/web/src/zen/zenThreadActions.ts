import {
  decodeCodeTerminalId,
  type CodeThread,
  type CodeThreadId,
  type CodeTerminalId,
} from "@octant/contracts/code";
import type { ZenSourceContext } from "@octant/contracts/zen";

export interface ZenTerminalPinTarget {
  readonly checkoutId: CodeThread["checkoutId"];
  readonly terminalId: CodeTerminalId;
  readonly threadId: CodeThreadId;
  readonly title: string;
}

/**
 * Resolve the default terminal a Code thread owns. Zen can pin that existing
 * process, but it must not start or restart one from the focus-zone surface.
 */
export function resolveZenTerminalPinTarget(
  sourceContext: ZenSourceContext,
  threads: ReadonlyArray<CodeThread>,
): ZenTerminalPinTarget | undefined {
  if (sourceContext.threadKind !== "code") return undefined;
  const thread = threads.find(
    (candidate) => String(candidate.id) === String(sourceContext.threadId),
  );
  if (thread === undefined || thread.executionPolicy === "plan") return undefined;
  return {
    checkoutId: thread.checkoutId,
    // Code's original terminal uses the thread identity as its terminal
    // identity. The server still verifies that the process exists and belongs
    // to this thread before it writes the Zen card.
    terminalId: decodeCodeTerminalId(String(thread.id)),
    threadId: thread.id,
    title: thread.title,
  };
}
