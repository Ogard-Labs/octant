import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import type { AgentRunSettingsClient } from "@octant/client-runtime/agent-run-settings-client";
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
  readonly agentRunSettingsClient?: AgentRunSettingsClient;
}

/**
 * The dock's secondary Code-thread tools. Plan, Publish, and Agents remain
 * grouped here because they were never workspace-launcher entries and must
 * keep their existing production route.
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
            allowCreation
            client={props.agentRunClient}
            parentThreadId={decodeAgentRunParentThreadId(String(props.threadId))}
            {...(props.agentRunSettingsClient === undefined
              ? {}
              : { settingsClient: props.agentRunSettingsClient })}
          />
        </EnvironmentGroup>
      )}
    </div>
  );
}
