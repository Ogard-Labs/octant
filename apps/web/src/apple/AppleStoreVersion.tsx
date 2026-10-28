import { useId } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import type { AppleStoreVersionState } from "./useAppleStoreVersion";

export interface AppleStoreVersionProps {
  readonly state: AppleStoreVersionState;
  /** The project whose version is read; absent until the workbench has found one. */
  readonly projectPath?: string;
  readonly onCheck?: () => void;
  readonly onCarryOut?: () => void;
}

/**
 * The workbench's **Submit for App Review…** and **Release…** for a person at
 * the Mac. Octant first reads what App Store Connect holds for the project's
 * version and offers only the step that version is ready for; the desktop
 * app then asks the person to confirm exactly that version.
 */
export function AppleStoreVersion(props: AppleStoreVersionProps) {
  const headingId = useId();
  const { state } = props;
  const busy = state.kind === "reading" || state.kind === "confirming" || state.kind === "sending";
  const ready = state.kind === "read" ? state.prepared.ready : "neither";
  return (
    <section aria-labelledby={headingId} className="apple-workbench__section apple-upload">
      <h2 id={headingId}>App Review and release</h2>
      <p>
        Submit this version for App Review, or release it once it is approved, with what App Store
        Connect already holds for it. You confirm the exact version first.
      </p>
      <div className="apple-workbench__actions">
        <OctantButton
          disabled={props.projectPath === undefined || busy}
          onClick={props.onCheck}
          type="button"
          variant="secondary"
        >
          Check App Store Connect
        </OctantButton>
        {ready === "submit-for-review" ? (
          <OctantButton disabled={busy} onClick={props.onCarryOut} type="button">
            Submit for App Review…
          </OctantButton>
        ) : null}
        {ready === "release-version" ? (
          <OctantButton disabled={busy} onClick={props.onCarryOut} type="button">
            Release…
          </OctantButton>
        ) : null}
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

function statusSentence(state: AppleStoreVersionState): string {
  switch (state.kind) {
    case "reading":
      return "Reading this version from App Store Connect…";
    case "read": {
      const { storeVersion, ready, state: held } = state.prepared;
      const named = `${storeVersion.bundleIdentifier} ${storeVersion.version} (${storeVersion.buildNumber})`;
      if (ready === "submit-for-review") return `${named} is ready to submit for App Review.`;
      if (ready === "release-version")
        return `${named} is approved and waiting for you to release it.`;
      return `App Store Connect reports ${named} as ${held}; there is nothing to submit or release now.`;
    }
    case "confirming":
      return `Confirm ${state.step === "submit-for-review" ? "submitting" : "releasing"} ${state.version.bundleIdentifier} ${state.version.version} in the dialog.`;
    case "sending":
      return state.step === "submit-for-review"
        ? `Submitting ${state.version.version} (${state.version.buildNumber}) for App Review…`
        : `Releasing ${state.version.version} (${state.version.buildNumber})…`;
    case "done":
      return state.step === "submit-for-review"
        ? `Submitted ${state.version.bundleIdentifier} ${state.version.version} (${state.version.buildNumber}) for App Review.`
        : `Released ${state.version.bundleIdentifier} ${state.version.version} (${state.version.buildNumber}) to the App Store.`;
    default:
      return "";
  }
}
