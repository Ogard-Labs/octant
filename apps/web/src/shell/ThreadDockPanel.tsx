import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import type { AgentRunSettingsClient } from "@octant/client-runtime/agent-run-settings-client";
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
  readonly agentRunSettingsClient?: AgentRunSettingsClient;
}

/**
 * The dock's panel for the thread in the active pane: the surfaces you work
 * *with* on a thread, as opposed to the live status of its environment.
 *
 * Each group mounts its body only while open, so a panel opened for its Files
 * does not also start the agent-run and publish reads. Agents is here rather
 * than in the thread header because what it offers is a creation console —
 * provider instance, model, authority, execution policy — and a configuration
 * form stacked above a transcript is what made the thread window unreadable.
 * The parent's compact live child status stays in the thread header, which is
 * where it belongs.
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
            // This thread is the parent authority the host verifies before it
            // admits a child, so creation belongs here rather than on a surface
            // that would have to invent one.
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
