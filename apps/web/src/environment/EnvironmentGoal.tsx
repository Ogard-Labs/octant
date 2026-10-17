import type { GoalClient } from "@octant/client-runtime/goal-client";
import { Target } from "lucide-react";
import { GoalCard } from "../goal/GoalCard";
import { goalCriteriaSummary } from "../goal/GoalCriteria";
import { useGoalController } from "../goal/useGoalController";
import { EnvironmentGroup } from "./EnvironmentGroup";

export interface EnvironmentGoalProps {
  readonly client: GoalClient;
  readonly threadId: string;
  /** Changes when the thread settles a turn, which is when criteria move. */
  readonly refreshKey?: string | undefined;
}

/**
 * A Code thread's goal, shown only once one exists. The lead sets the goal and
 * its criteria and records each check's outcome; the thread's person reads the
 * ledger here and revises it elsewhere, so this surface offers no controls.
 * A thread without a goal, or a host that cannot be read, shows nothing rather
 * than an empty row.
 */
export function EnvironmentGoal(props: EnvironmentGoalProps) {
  const controller = useGoalController({
    client: props.client,
    enabled: true,
    refreshKey: props.refreshKey,
    threadId: props.threadId,
  });
  const goal = controller.goal;
  if (goal === null) return null;
  const criteria = goal.criteria ?? [];
  return (
    <EnvironmentGroup
      defaultOpen
      icon={Target}
      summary={criteria.length === 0 ? goal.status : goalCriteriaSummary(criteria)}
      title="Goal"
    >
      <GoalCard goal={goal} readOnly />
    </EnvironmentGroup>
  );
}
