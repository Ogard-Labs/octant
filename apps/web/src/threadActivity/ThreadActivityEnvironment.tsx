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
  // One row in the rail's rhythm: what it is on the left, what it is doing on
  // the right. It had been a section label over a full-width button that sat
  // greyed out for every thread with no session, which read as broken.
  return (
    <section aria-label="Computer use" className="environment-row environment-activity">
      <PictureInPicture2 aria-hidden="true" className="environment-row__icon" size={14} />
      <h3 className="environment-row__title">Computer use</h3>
      {preview.available ? (
        <OctantButton
          aria-expanded={!preview.hidden}
          aria-label={`${action} Picture in Picture`}
          className="environment-row__action"
          onClick={() => preview.setHidden(!preview.hidden)}
          size="sm"
          type="button"
          variant="ghost"
        >
          {action} preview
        </OctantButton>
      ) : (
        <span className="environment-row__detail">No active session</span>
      )}
    </section>
  );
}
