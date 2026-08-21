import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import type { PlanClient } from "@octant/client-runtime/plan-client";
import type { ShipClient } from "@octant/client-runtime/ship-client";
import { decodeAgentRunParentThreadId } from "@octant/contracts/agent-run";
import type { CodeCheckoutId, CodeRelativePath, CodeThreadId } from "@octant/contracts";
import { AgentRunHierarchy } from "../agents/AgentRunHierarchy";
import { CodeFileExplorerPanel } from "../code/CodeFileExplorerPanel";
import { EnvironmentGroup } from "../environment/EnvironmentGroup";
import { ThreadPlanProvider } from "../plan/ThreadPlanContext";
import { ThreadPlanPanel } from "../plan/ThreadPlanPanel";
import { ShipPanel } from "../ship/ShipPanel";

export interface ThreadDockPanelProps {
  readonly threadId: CodeThreadId;
  readonly checkoutId?: CodeCheckoutId | undefined;
  readonly onOpenFile: (relativePath: CodeRelativePath) => void;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  readonly planClient?: PlanClient;
  readonly shipClient?: ShipClient;
  readonly agentRunClient?: AgentRunClient;
}

/**
 * The dock's panel for the thread in the active pane: the surfaces you work
 * *with* on a thread, as opposed to the live status of its environment.
 *
 * Each group mounts its body only while open, so a panel opened for its Files
 * does not also start the agent-run and publish reads. Agents is here for the
 * authoritative hierarchy and result controls. Code child creation stays
 * absent until this surface can supply the verified isolated worktree the host
 * requires; a Chat-scoped fallback would misrepresent the parent and its
 * authority. The parent's compact live child status stays in the thread header.
 */
export function ThreadDockPanel(props: ThreadDockPanelProps) {
  return (
    <div className="thread-dock-panel">
      {/* Files leads open: the panel is this dock's whole content, and four
          collapsed rows give a reader nothing to land on. */}
      <EnvironmentGroup defaultOpen title="Files">
        <CodeFileExplorerPanel
          threadId={props.threadId}
          {...(props.checkoutId === undefined ? {} : { checkoutId: props.checkoutId })}
          {...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl })}
          {...(props.windowCapability === undefined
            ? {}
            : { windowCapability: props.windowCapability })}
          onOpenFile={(entry) => props.onOpenFile(entry.path)}
        />
      </EnvironmentGroup>
      <EnvironmentGroup title="Plan">
        {/* The transcript's inline plan reads its own controller inside the
            pane, so this panel brings one of its own. Both refresh from the
            host and every revision is version-checked there, so the two
            readings cannot commit over each other. */}
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
