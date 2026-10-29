import { useId } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import type { AppleUploadState } from "./useAppleUpload";

export interface AppleUploadProps {
  readonly state: AppleUploadState;
  readonly ready: boolean;
  /** The project an upload archives; absent until the workbench has found one. */
  readonly projectPath?: string;
  readonly team: string;
  readonly onTeamChange?: (team: string) => void;
  readonly onUpload?: () => void;
}

/**
 * The workbench's **Upload to App Store Connect…** for a person at the Mac.
 * Pressing it reads the exact build first; the desktop app then asks the
 * person to confirm that build, and only their answer uploads it.
 */
export function AppleUpload(props: AppleUploadProps) {
  const headingId = useId();
  const teamId = useId();
  const { state } = props;
  return (
    <section aria-labelledby={headingId} className="apple-workbench__section apple-upload">
      <h2 id={headingId}>App Store Connect</h2>
      <p>
        Upload this thread's app with the App Store Connect key saved on this Mac. You confirm the
        exact version and build first. Submitting for App Review and releasing are separate steps
        below.
      </p>
      <div className="apple-devices__team">
        <label htmlFor={teamId}>Team ID</label>
        <OctantInput
          autoComplete="off"
          id={teamId}
          onChange={(event) => props.onTeamChange?.(event.target.value.trim().toUpperCase())}
          spellCheck={false}
          value={props.team}
        />
      </div>
      {props.projectPath === undefined ? (
        <p>Octant has not found an Xcode project in this checkout to upload.</p>
      ) : null}
      <div className="apple-workbench__actions">
        <OctantButton disabled={!props.ready} onClick={props.onUpload} type="button">
          Upload to App Store Connect…
        </OctantButton>
      </div>
      <p aria-live="polite" role="status">
        {statusSentence(state)}
      </p>
      {state.kind === "stopped" ? (
        <OctantAlert className="apple-workbench__action-message" tone="warning">
          {state.message}
        </OctantAlert>
      ) : null}
    </section>
  );
}

function statusSentence(state: AppleUploadState): string {
  switch (state.kind) {
    case "reading":
      return "Reading the version, build, and signing this upload would use…";
    case "confirming":
      return `Confirm uploading ${state.build.bundleIdentifier} ${state.build.version} (${state.build.buildNumber}) in the dialog.`;
    case "uploading":
      return `Archiving, signing, and uploading ${state.build.version} (${state.build.buildNumber}). This can take a while.`;
    case "uploaded":
      return `Uploaded ${state.build.bundleIdentifier} ${state.build.version} (${state.build.buildNumber}). App Store Connect delivery ${state.deliveryId}.`;
    default:
      return "";
  }
}
