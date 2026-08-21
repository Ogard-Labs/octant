import { useThreadPlan } from "./ThreadPlanContext";
import { ThreadTaskViewer } from "./ThreadTaskViewer";

/**
 * The thread's plan, in the conversation it came out of.
 *
 * It shows only once there is a plan to show: a thread with none is not missing
 * anything. The compact viewer keeps progress beside the work without putting
 * a full plan card between every transcript and composer. Writing and revising
 * stay in the thread's Plan panel.
 */
export function InlineThreadPlan() {
  const controller = useThreadPlan();
  const plan = controller?.plan;
  if (controller === undefined || plan == null || plan.status === "withdrawn") return null;
  return (
    <div className="code-thread-workspace__plan">
      <ThreadTaskViewer controller={controller} />
      {controller.commandMessage === undefined ? null : (
        <p className="thread-plan__command-error" role="alert">
          {controller.commandMessage}
        </p>
      )}
    </div>
  );
}
