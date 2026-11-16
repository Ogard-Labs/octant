import { createContext, useContext } from "react";
import { PictureInPicture2 } from "../ui/icons";
import { EnvironmentTile } from "../environment/EnvironmentGroup";
import { useReportRunning } from "../environment/environmentSections";
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
  // A live computer-use session is what the Running section counts; with no
  // preview host there can be none.
  useReportRunning(preview?.available === true ? 1 : 0);
  // No session, nothing to say: the Running section's summary reads "Nothing
  // running" and a row of "None" added a line to every thread without one.
  if (preview === null || !preview.available) return null;
  const action = preview.hidden ? "Show" : "Hide";
  // One row in the rail's rhythm: what it is on the left, what it is doing on
  // the right. It had been a section label over a full-width button that sat
  // greyed out for every thread with no session, which read as broken.
  return (
    <section aria-label="Computer use" className="environment-row environment-activity">
      <EnvironmentTile icon={PictureInPicture2} />
      <h3 className="environment-row__title">Computer use</h3>
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
    </section>
  );
}
