import { createContext, useContext } from "react";
import { PictureInPicture2 } from "lucide-react";
import { OctantButton } from "../ui/base/OctantButton";

export interface ThreadActivityPreviewState {
  readonly available: boolean;
  readonly hidden: boolean;
  readonly setHidden: (hidden: boolean) => void;
}

export const ThreadActivityPreviewContext = createContext<ThreadActivityPreviewState | null>(null);

/** Presentation only: the preview keeps ownership of its sessions and approvals. */
export function ThreadActivityEnvironment() {
  const preview = useContext(ThreadActivityPreviewContext);
  if (preview === null) return null;
  const action = preview.hidden ? "Show" : "Hide";
  return (
    <section aria-label="Computer use" className="environment-activity">
      <h3 className="environment-section-label">Computer use</h3>
      <OctantButton
        aria-label={`${action} Picture in Picture`}
        aria-expanded={preview.available && !preview.hidden}
        className="environment-quick-action"
        disabled={!preview.available}
        onClick={() => preview.setHidden(!preview.hidden)}
        type="button"
        variant="ghost"
      >
        <PictureInPicture2 aria-hidden="true" size={16} />
        <span>Picture in Picture</span>
        <span className="environment-quick-action__detail">
          {preview.available ? action : "No active session"}
        </span>
      </OctantButton>
    </section>
  );
}
