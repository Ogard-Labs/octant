import type { ProviderExecutionPolicy } from "@octant/contracts";
import { EXECUTION_POLICY_LABEL } from "../shell/shellCommandWiring";
import { OctantApprovalCard } from "../ui/base/OctantApprovalCard";
import { OctantButton } from "../ui/base/OctantButton";
import "./provider-level-change.css";

export interface ProviderApprovalPromptProps {
  readonly summary: string;
  readonly onAnswer: (decision: "approved" | "denied") => void;
  /**
   * The agent asks to change the thread's level instead of to run a tool:
   * the level it would move to from the next turn, and the plan it asks the
   * person to approve when it asks to leave Plan.
   */
  readonly levelChange?: { readonly to: ProviderExecutionPolicy; readonly plan?: string };
}

export function ProviderApprovalPrompt(props: ProviderApprovalPromptProps) {
  if (props.levelChange !== undefined) {
    return (
      <LevelChangePrompt
        levelChange={props.levelChange}
        onAnswer={props.onAnswer}
        summary={props.summary}
      />
    );
  }
  return (
    <OctantApprovalCard
      actions={
        <>
          <OctantButton onClick={() => props.onAnswer("approved")} size="sm" type="button">
            Approve
          </OctantButton>
          <OctantButton
            onClick={() => props.onAnswer("denied")}
            size="sm"
            type="button"
            variant="ghost"
          >
            Deny
          </OctantButton>
        </>
      }
      label="Provider approval"
      summary={props.summary}
    />
  );
}

/**
 * The agent's own ask to plan first, or to leave Plan with a plan. Approving
 * ends the turn that asked; the thread's next turn runs at the new level.
 */
function LevelChangePrompt(props: {
  readonly summary: string;
  readonly onAnswer: (decision: "approved" | "denied") => void;
  readonly levelChange: { readonly to: ProviderExecutionPolicy; readonly plan?: string };
}) {
  const entering = props.levelChange.to === "plan";
  const level = EXECUTION_POLICY_LABEL[props.levelChange.to];
  return (
    <OctantApprovalCard
      actions={
        <>
          <OctantButton onClick={() => props.onAnswer("approved")} size="sm" type="button">
            {entering ? "Switch to Plan" : `Approve plan · ${level}`}
          </OctantButton>
          <OctantButton
            onClick={() => props.onAnswer("denied")}
            size="sm"
            type="button"
            variant="ghost"
          >
            {entering ? "Keep working" : "Keep planning"}
          </OctantButton>
        </>
      }
      className="provider-level-change"
      context={
        props.levelChange.plan === undefined ? undefined : (
          <pre aria-label="Proposed plan" className="provider-level-change__plan" tabIndex={0}>
            {props.levelChange.plan}
          </pre>
        )
      }
      detail={
        entering
          ? "This turn ends; the next one runs in Plan, read-only."
          : `This turn ends; the next one runs at ${level}.`
      }
      label={entering ? "Plan first" : "Approve the plan"}
      summary={props.summary}
    />
  );
}
