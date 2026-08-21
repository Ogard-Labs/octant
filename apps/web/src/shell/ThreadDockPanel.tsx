import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import type { PlanClient } from "@octant/client-runtime/plan-client";
import type { ShipClient } from "@octant/client-runtime/ship-client";
import { decodeAgentRunParentThreadId } from "@octant/contracts/agent-run";
import type { CodeThreadId } from "@octant/contracts";
import { AgentRunHierarchy } from "../agents/AgentRunHierarchy";
import { EnvironmentGroup } from "../environment/EnvironmentGroup";
import { ThreadPlanProvider } from "../plan/ThreadPlanContext";
import { ThreadPlanPanel } from "../plan/ThreadPlanPanel";
import { ShipPanel } from "../ship/ShipPanel";

export interface ThreadDockPanelProps {
  readonly threadId: CodeThreadId;
  readonly planClient?: PlanClient;
  readonly shipClient?: ShipClient;
  readonly agentRunClient?: AgentRunClient;
}

/**
 * The dock's secondary Code-thread tools. Plan, Publish, and Agents remain
 * grouped here because they were never workspace-launcher entries and must
 * keep their existing production route. Code child creation stays absent until
 * this surface can supply the verified isolated worktree the host requires; a
 * Chat-scoped fallback would misrepresent the parent and its authority.
 */
export function ThreadDockPanel(props: ThreadDockPanelProps) {
  return (
    <div className="thread-dock-panel">
      <EnvironmentGroup defaultOpen title="Plan">
        <ThreadPlanProvider
          {...(props.planClient === undefined ? {} : { client: props.planClient })}
          threadId={String(props.threadId)}
        >
          <ThreadPlanPanel />
        </ThreadPlanProvider>
      </EnvironmentGroup>
      {props.shipClient === undefined ? null : (
        <EnvironmentGroup title="Publish">
          <ShipPanel client={props.shipClient} threadId={String(props.threadId)} />
        </EnvironmentGroup>
      )}
      {props.agentRunClient === undefined ? null : (
        <EnvironmentGroup title="Agents">
          <AgentRunHierarchy
            client={props.agentRunClient}
            parentThreadId={decodeAgentRunParentThreadId(String(props.threadId))}
          />
        </EnvironmentGroup>
      )}
    </div>
  );
}
