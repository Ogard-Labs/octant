import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import { decodeAgentRunParentThreadId } from "@octant/contracts/agent-run";
import { ChildRunStatusChrome } from "./ChildRunStatusChrome";
import { useChildRunStatus } from "./useChildRunStatus";
import { OctantButton } from "../ui/base/OctantButton";

/**
 * Compact child-run status for one parent thread.
 *
 * A separate component so the hook is never called conditionally from the
 * branching workspace renderer. An empty hierarchy still offers Add agent so
 * the Agents dock tool can be invoked without appearing on the launcher first.
 */
export function ThreadChildRunStatusSlot(props: {
  readonly client?: AgentRunClient;
  readonly threadId: string;
  readonly onAddAgent?: () => void;
}) {
  const childRuns = useChildRunStatus({
    ...(props.client === undefined ? {} : { client: props.client }),
    parentThreadId: decodeAgentRunParentThreadId(props.threadId),
  });
  if (childRuns.status !== "ready") return null;
  if (childRuns.entries.length === 0) {
    if (props.onAddAgent === undefined) return null;
    return (
      <div className="child-run-status child-run-status--empty">
        <OctantButton onClick={props.onAddAgent} size="sm" type="button" variant="ghost">
          Add agent
        </OctantButton>
      </div>
    );
  }
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
