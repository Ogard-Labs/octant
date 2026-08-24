import type { ThreadGoal } from "@octant/contracts";
import { OctantButton } from "../ui/base/OctantButton";

export interface GoalCardProps {
  readonly goal: ThreadGoal;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onComplete: () => void;
  readonly onRevise: () => void;
}

export function GoalCard(props: GoalCardProps) {
  const { goal } = props;
  return (
    <section aria-label="Thread goal" className="octant-goal-card" data-status={goal.status}>
      <header>
        <h2>Goal</h2>
        <p data-testid="goal-status">{goal.status}</p>
      </header>
      <p data-testid="goal-objective">{goal.objective}</p>
      <div role="group" aria-label="Goal actions">
        {(goal.status === "active" || goal.status === "budget-limited") && (
          <OctantButton type="button" onClick={props.onPause} size="sm" variant="outline">
            Pause
          </OctantButton>
        )}
        {(goal.status === "paused" || goal.status === "budget-limited") && (
          <OctantButton type="button" onClick={props.onResume} size="sm" variant="outline">
            Resume
          </OctantButton>
        )}
        {goal.status !== "complete" && (
          <>
            <OctantButton type="button" onClick={props.onRevise} size="sm" variant="ghost">
              Revise
            </OctantButton>
            <OctantButton type="button" onClick={props.onComplete} size="sm">
              Complete
            </OctantButton>
          </>
        )}
      </div>
    </section>
  );
}
