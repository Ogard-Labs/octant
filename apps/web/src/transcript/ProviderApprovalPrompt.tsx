import type { ProviderExecutionPolicy } from "@octant/contracts";
import { EXECUTION_POLICY_LABEL } from "../shell/shellCommandWiring";
import { OctantApprovalCard } from "../ui/base/OctantApprovalCard";
import { OctantButton } from "../ui/base/OctantButton";
import "./provider-level-change.css";

export interface ProviderApprovalPromptProps {
  /** The question the agent asks, as the host worded it. */
  readonly summary: string;
  /** Why the thread asks, from its mode, on one quiet line under the question. */
  readonly reason?: string;
  /** The call the ask gates (a command's line, a checkout-relative path), shown in a well. */
  readonly command?: string;
  readonly onAnswer: (decision: "approved" | "denied") => void;
  /**
   * Present when the ask may be answered for the whole Project as well as for
   * this once: the card offers "Allow once" and "Remember for this Project".
   */
  readonly onRememberForProject?: () => void;
  /**
   * The agent asks to change the thread's level instead of to run a tool:
   * the level it would move to from the next turn, and the plan it asks the
   * person to approve when it asks to leave Plan.
   */
  readonly levelChange?: LevelChange;
}

interface LevelChange {
  readonly to: ProviderExecutionPolicy;
  readonly plan?: string;
  /** The level's name in the thread's own picker words; absent names the posture. */
  readonly toLabel?: string;
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
            {props.onRememberForProject === undefined ? "Approve" : "Allow once"}
          </OctantButton>
          {props.onRememberForProject === undefined ? null : (
            <OctantButton
              onClick={props.onRememberForProject}
              size="sm"
              type="button"
              variant="secondary"
            >
              Remember for this Project
            </OctantButton>
          )}
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
      context={
        props.command === undefined ? undefined : (
          // A group carries the name: a name on the code element itself is
          // not one assistive technology has to read.
          <div aria-label="The call it asks about" className="approval-row__well" role="group">
            <code>{props.command}</code>
          </div>
        )
      }
      {...(props.reason === undefined ? {} : { detail: props.reason })}
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
  readonly levelChange: LevelChange;
}) {
  const entering = props.levelChange.to === "plan";
  const level = props.levelChange.toLabel ?? EXECUTION_POLICY_LABEL[props.levelChange.to];
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
