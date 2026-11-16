import { useMemo } from "react";
import type { ThreadUtilityDockContentProps } from "../shell/dockModuleContext";
import { unavailable } from "./moduleState";
import { AgentRunHierarchy } from "../agents/AgentRunHierarchy";
import { NativeHarnessEgressCard } from "../harness/NativeHarnessEgressCard";
import { NativeHarnessSessionCard } from "../harness/NativeHarnessSessionCard";
import { decodeAgentRunParentThreadId } from "@octant/contracts/agent-run";

type Props = Pick<
  ThreadUtilityDockContentProps,
  | "agentRunClient"
  | "agentRunSettingsClient"
  | "coordinatorWorkers"
  | "nativeHarnessClient"
  | "onAgentViewRequestHandled"
  | "onOpenCoordinatorWorker"
  | "requestedAgentView"
  | "onReviewAgentChanges"
  | "providerController"
  | "subject"
>;

export default function AgentsModule(props: Props) {
  const instances = props.providerController?.instances;
  const providers = useMemo(
    () =>
      instances === undefined
        ? undefined
        : new Map(
            instances.map((instance) => [
              String(instance.id),
              { driverKind: instance.driverKind, displayName: instance.displayName },
            ]),
          ),
    [instances],
  );
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
      {props.nativeHarnessClient === undefined || props.subject.mode !== "code" ? null : (
        <NativeHarnessEgressCard
          client={props.nativeHarnessClient}
          threadId={props.subject.threadId}
        />
      )}
      <AgentRunHierarchy
        client={props.agentRunClient}
        parentThreadId={decodeAgentRunParentThreadId(props.subject.threadId)}
        {...(props.subject.mode !== "code" || props.onReviewAgentChanges === undefined
          ? {}
          : { onReviewChanges: props.onReviewAgentChanges })}
        {...(props.requestedAgentView === undefined
          ? {}
          : { requestedView: props.requestedAgentView })}
        {...(props.onAgentViewRequestHandled === undefined
          ? {}
          : { onRequestedViewHandled: props.onAgentViewRequestHandled })}
        {...(providers === undefined ? {} : { providers })}
        {...(props.coordinatorWorkers === undefined ? {} : { workers: props.coordinatorWorkers })}
        {...(props.onOpenCoordinatorWorker === undefined
          ? {}
          : { onOpenWorker: props.onOpenCoordinatorWorker })}
        {...(props.agentRunSettingsClient === undefined
          ? {}
          : { settingsClient: props.agentRunSettingsClient })}
      />
    </>
  );
}
