import { PlanCard } from "./PlanCard";
import { useThreadPlan } from "./ThreadPlanContext";

/**
 * The thread's plan, in the conversation it came out of.
 *
 * It shows only once there is a plan to show: a thread with none is not missing
 * anything, and an empty card between the transcript and the composer would
 * say otherwise. Writing and revising stay in the thread's plan panel; this is
 * the copy a reader approves and works through while reading the thread.
 */
export function InlineThreadPlan() {
  const controller = useThreadPlan();
  const plan = controller?.plan;
  if (controller === undefined || plan == null || plan.status === "withdrawn") return null;
  return (
    <div className="code-thread-workspace__plan">
      <PlanCard
        busy={controller.pending}
        onApprove={() => void controller.approve()}
        onSetStepStatus={(stepId, status) => void controller.setStepStatus(stepId, status)}
        plan={plan}
      />
      {controller.commandMessage === undefined ? null : (
        <p className="thread-plan__command-error" role="alert">
          {controller.commandMessage}
        </p>
      )}
    </div>
  );
}
