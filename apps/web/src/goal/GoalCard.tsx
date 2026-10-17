import type { ThreadGoal } from "@octant/contracts";
import { OctantButton } from "../ui/base/OctantButton";
import { GoalCriteria } from "./GoalCriteria";

export interface GoalCardActions {
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onComplete: () => void;
  readonly onRevise: () => void;
}

export type GoalCardProps = { readonly goal: ThreadGoal } & (
  | GoalCardActions
  /** The goal and its ledger without the controls that change it. */
  | { readonly readOnly: true }
);

export function GoalCard(props: GoalCardProps) {
  const { goal } = props;
  return (
    <section aria-label="Thread goal" className="octant-goal-card" data-status={goal.status}>
      <header>
        <h2>Goal</h2>
        <p data-testid="goal-status">{goal.status}</p>
      </header>
      <p data-testid="goal-objective">{goal.objective}</p>
      <GoalCriteria criteria={goal.criteria ?? []} />
      {"readOnly" in props ? null : <GoalCardControls {...props} />}
    </section>
  );
}

function GoalCardControls(props: { readonly goal: ThreadGoal } & GoalCardActions) {
  const { goal } = props;
  return (
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
  );
}
