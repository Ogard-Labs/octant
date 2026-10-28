import { OctantApprovalCard } from "../ui/base/OctantApprovalCard";
import { OctantButton } from "../ui/base/OctantButton";

export type ProviderApprovalPromptProps =
  | {
      readonly summary: string;
      readonly onAnswer: (decision: "approved" | "denied") => void;
    }
  | {
      readonly summary: string;
      /**
       * The host takes an answer only from a window on its own computer and
       * this is not one, so the card says where to answer instead of offering
       * controls whose answer the host would refuse.
       */
      readonly answeredAtHost: true;
    };

const ANSWERED_AT_HOST_NOTE = "Answer this on the computer running Octant.";

export function ProviderApprovalPrompt(props: ProviderApprovalPromptProps) {
  if ("answeredAtHost" in props) {
    return (
      <OctantApprovalCard
        detail={ANSWERED_AT_HOST_NOTE}
        label="Provider approval"
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
