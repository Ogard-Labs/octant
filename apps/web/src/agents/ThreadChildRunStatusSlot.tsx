import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import { decodeAgentRunParentThreadId } from "@octant/contracts/agent-run";
import { ChildRunStatusChrome } from "./ChildRunStatusChrome";
import { useChildRunStatus } from "./useChildRunStatus";

/**
 * Compact child-run status for one parent thread.
 *
 * A separate component so the hook is never called conditionally from the
 * branching workspace renderer, and so a thread with no children renders
 * nothing at all rather than empty chrome.
 */
export function ThreadChildRunStatusSlot(props: {
  readonly client?: AgentRunClient;
  readonly threadId: string;
}) {
  const childRuns = useChildRunStatus({
    ...(props.client === undefined ? {} : { client: props.client }),
    parentThreadId: decodeAgentRunParentThreadId(props.threadId),
  });
  // Two different silences, both correct: the host has not answered for this
  // thread yet, or it answered that this thread has no children. Neither one
  // may show the thread the user just switched away from.
  if (childRuns.status !== "ready" || childRuns.entries.length === 0) return null;
  return (
    <ChildRunStatusChrome
      entries={childRuns.entries}
      summary={childRuns.summary}
      onStopChildren={childRuns.stopAll}
      onCancelRun={({ runId }) => void childRuns.cancelRun(runId)}
      onAcknowledge={(input) => void childRuns.acknowledge(input)}
      busy={childRuns.busy}
      reconnecting={childRuns.reconnecting}
      {...(childRuns.errorMessage === undefined ? {} : { errorMessage: childRuns.errorMessage })}
    />
  );
}
