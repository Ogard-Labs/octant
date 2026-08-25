import type { ThreadPlan, ThreadPlanStepId, ThreadPlanStepStatus } from "@octant/contracts";
import { CheckCircle2, Circle, CircleDot, CircleSlash } from "lucide-react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCard } from "../ui/base/OctantCard";

export interface PlanCardProps {
  readonly plan: ThreadPlan;
  readonly busy?: boolean;
  /**
   * The approval gesture. Absent when this surface may only read the plan;
   * the card then shows the plan and offers nothing, rather than a control the
   * host would refuse.
   */
  readonly onApprove?: () => void;
  readonly onWithdraw?: () => void;
  readonly onSetStepStatus?: (stepId: ThreadPlanStepId, status: ThreadPlanStepStatus) => void;
}

const STATUS_WORDS: Record<ThreadPlan["status"], string> = {
  proposed: "Proposed · not approved",
  approved: "Approved",
  withdrawn: "Withdrawn",
};

const STEP_WORDS: Record<ThreadPlanStepStatus, string> = {
  pending: "Not started",
  "in-progress": "In progress",
  done: "Done",
  dropped: "Dropped",
};

/**
 * One thread's plan, as its steps.
 *
 * Status is spelled out beside an icon rather than carried by colour, and a
 * proposed plan says so: until it is approved its steps are a proposal, not
 * work, and the host refuses to move them.
 */
export function PlanCard(props: PlanCardProps) {
  const { plan } = props;
  const approved = plan.status === "approved";
  const done = plan.steps.filter((step) => step.status === "done").length;
  const counted = plan.steps.filter((step) => step.status !== "dropped").length;
  return (
    <OctantCard aria-label={`Plan: ${plan.title}`} className="gap-2 p-3" data-status={plan.status}>
      <header className="plan-card__header">
        <strong>{plan.title}</strong>
        <span className="plan-card__status">{STATUS_WORDS[plan.status]}</span>
        {!approved ? null : (
          <span className="plan-card__progress">{`${String(done)} of ${String(counted)} done`}</span>
        )}
      </header>
      <ol className="plan-card__steps">
        {plan.steps.map((step) => (
          <li className="plan-card__step" data-step-status={step.status} key={step.stepId}>
            <span className="plan-card__step-mark">
              <StepIcon status={step.status} />
            </span>
            <span className="plan-card__step-body">
              <span className="plan-card__step-title">{step.title}</span>
              {step.rationale === undefined ? null : (
                <span className="plan-card__step-rationale">{step.rationale}</span>
              )}
              <span className="plan-card__step-state">{STEP_WORDS[step.status]}</span>
            </span>
            {!approved || props.onSetStepStatus === undefined ? null : (
              <StepActions
                busy={props.busy === true}
                onSetStepStatus={props.onSetStepStatus}
                step={step}
              />
            )}
          </li>
        ))}
      </ol>
      {props.onApprove === undefined && props.onWithdraw === undefined ? null : (
        <footer className="plan-card__actions">
          {plan.status !== "proposed" || props.onApprove === undefined ? null : (
            <OctantButton
              disabled={props.busy === true}
              onClick={props.onApprove}
              type="button"
              variant="default"
            >
              Approve plan
            </OctantButton>
          )}
          {plan.status === "withdrawn" || props.onWithdraw === undefined ? null : (
            <OctantButton
              disabled={props.busy === true}
              onClick={props.onWithdraw}
              type="button"
              variant="ghost"
            >
              Withdraw
            </OctantButton>
          )}
        </footer>
      )}
    </OctantCard>
  );
}

function StepActions(props: {
  readonly busy: boolean;
  readonly onSetStepStatus: (stepId: ThreadPlanStepId, status: ThreadPlanStepStatus) => void;
  readonly step: ThreadPlan["steps"][number];
}) {
  const { step } = props;
  return (
    <span className="plan-card__step-actions">
      {step.status === "pending" ? (
        <OctantButton
          aria-label={`Start ${step.title}`}
          disabled={props.busy}
          onClick={() => props.onSetStepStatus(step.stepId, "in-progress")}
          size="sm"
          type="button"
          variant="ghost"
        >
          Start
        </OctantButton>
      ) : null}
      {step.status === "in-progress" ? (
        <OctantButton
          aria-label={`Finish ${step.title}`}
          disabled={props.busy}
          onClick={() => props.onSetStepStatus(step.stepId, "done")}
          size="sm"
          type="button"
          variant="ghost"
        >
          Finish
        </OctantButton>
      ) : null}
      {step.status === "done" || step.status === "dropped" ? (
        <OctantButton
          aria-label={`Reopen ${step.title}`}
          disabled={props.busy}
          onClick={() => props.onSetStepStatus(step.stepId, "pending")}
          size="sm"
          type="button"
          variant="ghost"
        >
          Reopen
        </OctantButton>
      ) : (
        <OctantButton
          aria-label={`Drop ${step.title}`}
          disabled={props.busy}
          onClick={() => props.onSetStepStatus(step.stepId, "dropped")}
          size="sm"
          type="button"
          variant="ghost"
        >
          Drop
        </OctantButton>
      )}
    </span>
  );
}

function StepIcon(props: { readonly status: ThreadPlanStepStatus }) {
  const size = 14;
  const strokeWidth = 1.8;
  switch (props.status) {
    case "done":
      return <CheckCircle2 aria-hidden="true" size={size} strokeWidth={strokeWidth} />;
    case "in-progress":
      return <CircleDot aria-hidden="true" size={size} strokeWidth={strokeWidth} />;
    case "dropped":
      return <CircleSlash aria-hidden="true" size={size} strokeWidth={strokeWidth} />;
    case "pending":
      return <Circle aria-hidden="true" size={size} strokeWidth={strokeWidth} />;
  }
}
