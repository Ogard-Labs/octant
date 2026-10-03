import type { ThreadUtilityDockContentProps } from "../shell/dockModuleContext";
import { unavailable } from "./moduleState";
import { AgentRunHierarchy } from "../agents/AgentRunHierarchy";
import { NativeHarnessSessionCard } from "../harness/NativeHarnessSessionCard";
import { decodeAgentRunParentThreadId } from "@octant/contracts/agent-run";

type Props = Pick<
  ThreadUtilityDockContentProps,
  | "agentRunClient"
  | "agentRunSettingsClient"
  | "nativeHarnessClient"
  | "onAgentViewRequestHandled"
  | "requestedAgentView"
  | "subject"
>;

export default function AgentsModule(props: Props) {
  if (props.agentRunClient === undefined) {
    return unavailable("Agents", "This thread has no AgentRun service available.");
  }
  return (
    <>
      {props.nativeHarnessClient === undefined ? null : (
        <NativeHarnessSessionCard
          client={props.nativeHarnessClient}
          threadId={props.subject.threadId}
        />
      )}
      <AgentRunHierarchy
        client={props.agentRunClient}
        parentThreadId={decodeAgentRunParentThreadId(props.subject.threadId)}
        {...(props.requestedAgentView === undefined
          ? {}
          : { requestedView: props.requestedAgentView })}
        {...(props.onAgentViewRequestHandled === undefined
          ? {}
          : { onRequestedViewHandled: props.onAgentViewRequestHandled })}
        {...(props.agentRunSettingsClient === undefined
          ? {}
          : { settingsClient: props.agentRunSettingsClient })}
      />
    </>
  );
}
