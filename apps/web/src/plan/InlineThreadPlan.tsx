import { useThreadPlan } from "./ThreadPlanContext";
import { ThreadTaskViewer, type ThreadTaskChangedFiles } from "./ThreadTaskViewer";

export interface InlineThreadPlanProps {
  /** Server-derived checkout evidence, when the owning surface has it. */
  readonly changedFiles?: ThreadTaskChangedFiles;
}

/**
 * The thread's plan, in the conversation it came out of.
 *
 * It shows only once there is a plan to show: a thread with none is not missing
 * anything. The compact viewer keeps progress beside the work without putting
 * a full plan card between every transcript and composer. Writing and revising
 * stay in the thread's Plan panel.
 */
export function InlineThreadPlan(props: InlineThreadPlanProps = {}) {
  const controller = useThreadPlan();
  const plan = controller?.plan;
  if (controller === undefined || plan == null || plan.status === "withdrawn") return null;
  return (
    <div className="thread-task-viewer__placement">
      <ThreadTaskViewer
        controller={controller}
        {...(props.changedFiles === undefined ? {} : { changedFiles: props.changedFiles })}
      />
      {controller.commandMessage === undefined ? null : (
        <p className="thread-plan__command-error" role="alert">
          {controller.commandMessage}
        </p>
      )}
    </div>
  );
}
