import type { ThreadGoal } from "@octant/contracts";

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
          <button type="button" onClick={props.onPause}>
            Pause
          </button>
        )}
        {(goal.status === "paused" || goal.status === "budget-limited") && (
          <button type="button" onClick={props.onResume}>
            Resume
          </button>
        )}
        {goal.status !== "complete" && (
          <>
            <button type="button" onClick={props.onRevise}>
              Revise
            </button>
            <button type="button" onClick={props.onComplete}>
              Complete
            </button>
          </>
        )}
      </div>
    </section>
  );
}
