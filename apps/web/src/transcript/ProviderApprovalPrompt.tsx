import { OctantApprovalCard } from "../ui/base/OctantApprovalCard";
import { OctantButton } from "../ui/base/OctantButton";

export interface ProviderApprovalPromptProps {
  readonly summary: string;
  readonly onAnswer: (decision: "approved" | "denied") => void;
}

export function ProviderApprovalPrompt(props: ProviderApprovalPromptProps) {
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
