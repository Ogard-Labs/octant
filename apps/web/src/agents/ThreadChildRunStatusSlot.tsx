import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import { decodeAgentRunParentThreadId } from "@octant/contracts/agent-run";
import { ChildRunStatusChrome } from "./ChildRunStatusChrome";
import { useChildRunStatus } from "./useChildRunStatus";

/**
 * Compact child-run status for one parent thread.
 *
 * A separate component so the hook is never called conditionally from the
 * branching workspace renderer. The status chrome appears only when the
 * thread has child runs; child creation belongs to the Agents tool.
 */
export function ThreadChildRunStatusSlot(props: {
  readonly client?: AgentRunClient;
  readonly enabled?: boolean;
  readonly threadId: string;
  readonly onAddAgent?: () => void;
}) {
  const childRuns = useChildRunStatus({
    ...(props.client === undefined ? {} : { client: props.client }),
    ...(props.enabled === undefined ? {} : { enabled: props.enabled }),
    parentThreadId: decodeAgentRunParentThreadId(props.threadId),
  });
  if (childRuns.status !== "ready") return null;
  if (childRuns.entries.length === 0) return null;
  return (
    <ChildRunStatusChrome
      entries={childRuns.entries}
      summary={childRuns.summary}
      onStopChildren={childRuns.stopAll}
      onCancelRun={({ runId }) => void childRuns.cancelRun(runId)}
      onAcknowledge={(input) => void childRuns.acknowledge(input)}
      {...(props.onAddAgent === undefined ? {} : { onAddAgent: props.onAddAgent })}
      busy={childRuns.busy}
      reconnecting={childRuns.reconnecting}
      {...(childRuns.errorMessage === undefined ? {} : { errorMessage: childRuns.errorMessage })}
    />
  );
}
