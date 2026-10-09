import { OctantButton } from "../ui/base/OctantButton";

export interface ChatOnlyVerifyProps {
  /** What the button verifies, for its accessible name: a model, or a whole endpoint. */
  readonly subject: string;
  readonly verifying: boolean;
  readonly disabled: boolean;
  readonly onVerify: () => void;
}

/**
 * "Chat only · Verify tools": the one label every surface uses for a model
 * Octant has not seen call a tool, so the endpoint row, its models, the model
 * pickers and Add endpoint name the state and its way out the same way. The
 * check sends one request, which the service may bill.
 */
export function ChatOnlyVerify(props: ChatOnlyVerifyProps) {
  return (
    <span className="chat-only-verify">
      <span
        className="chat-only-verify__label"
        title="Octant hasn't seen this model call a tool, so it answers without Octant's tools."
      >
        Chat only
      </span>
      <span aria-hidden="true" className="chat-only-verify__separator">
        ·
      </span>
      <OctantButton
        aria-label={`Verify tools for ${props.subject}`}
        disabled={props.disabled}
        onClick={props.onVerify}
        size="sm"
        title="Sends one request, which the service may bill."
        type="button"
        variant="ghost"
      >
        {props.verifying ? "Verifying…" : "Verify tools"}
      </OctantButton>
    </span>
  );
}
