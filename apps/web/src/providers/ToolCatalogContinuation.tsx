import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";

export const TOOL_CATALOG_CONTINUATION_COPY =
  "Send this draft with the updated tools in a fresh session. Recent conversation carries over as text, with any omissions shown. Hidden reasoning and tool activity stay in the saved session. The full task history is preserved. Failed tool calls are not replayed.";

/** A fresh session is a person's choice; the ordinary Send keeps refusing the stale catalogue. */
export function ToolCatalogContinuation(props: {
  readonly disabled: boolean;
  readonly onContinue: () => void;
}) {
  return (
    <OctantAlert tone="warning">
      <p>{TOOL_CATALOG_CONTINUATION_COPY}</p>
      <OctantButton disabled={props.disabled} onClick={props.onContinue}>
        Continue with updated tools
      </OctantButton>
    </OctantAlert>
  );
}
