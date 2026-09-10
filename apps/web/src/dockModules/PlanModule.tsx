import type { ThreadUtilityDockContentProps } from "../shell/dockModuleContext";
import { ThreadPlanProvider } from "../plan/ThreadPlanContext";
import { ThreadPlanPanel } from "../plan/ThreadPlanPanel";

type Props = Pick<ThreadUtilityDockContentProps, "planClient" | "subject">;

export default function PlanModule(props: Props) {
  return (
    <ThreadPlanProvider
      {...(props.planClient === undefined ? {} : { client: props.planClient })}
      threadId={props.subject.threadId}
    >
      <ThreadPlanPanel artifactOnly />
    </ThreadPlanProvider>
  );
}
