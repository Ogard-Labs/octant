import { CirclePause } from "lucide-react";

import { OctantButton } from "../ui/base/OctantButton";

export interface ProviderApprovalPromptProps {
  readonly summary: string;
  readonly onAnswer: (decision: "approved" | "denied") => void;
}

export function ProviderApprovalPrompt(props: ProviderApprovalPromptProps) {
  return (
    <div aria-label="Provider approval" className="approval-row approval-row--request" role="group">
      <CirclePause aria-hidden="true" size={14} strokeWidth={1.8} />
      <span className="approval-row__text">{props.summary}</span>
      <div className="approval-row__actions">
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
      </div>
    </div>
  );
}
