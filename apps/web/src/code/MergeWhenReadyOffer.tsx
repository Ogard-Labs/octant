import { useRef, useState } from "react";
import type { CodeClient } from "@octant/client-runtime";
import type { CodeProjectPullRequestSwitchTarget } from "@octant/contracts";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import { pullRequestControlsLoadMessage, switchRefusalCopy } from "./ProjectPullRequestSupport";

export type MergeWhenReadyOfferClient = Pick<
  CodeClient,
  "queryProjectPullRequestDetail" | "setProjectPullRequestMergeWhenReady"
>;

/**
 * The follow-up's offer on a linked issue's open pull request: the person
 * turns on Merge when ready, for the head Octant reads at the moment they
 * confirm. GitHub merges it once its checks pass; nothing here merges.
 */
export function MergeWhenReadyOffer(props: {
  readonly client: MergeWhenReadyOfferClient;
  readonly target: CodeProjectPullRequestSwitchTarget;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [done, setDone] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const turnOn = props.client.setProjectPullRequestMergeWhenReady;
  if (turnOn === undefined) return null;
  const ref = `${props.target.repositoryOwner}/${props.target.repositoryName}#${String(props.target.number)}`;

  async function confirm(): Promise<void> {
    if (busy || turnOn === undefined) return;
    setBusy(true);
    try {
      const view = await props.client.queryProjectPullRequestDetail(props.target);
      const detail = view.detail;
      if (detail.state !== "observed" || detail.headSha === "") {
        setMessage("Refresh the pull request to read its head first.");
        return;
      }
      const outcome = await turnOn({
        kind: "enable",
        target: props.target,
        headSha: detail.headSha,
      });
      if (outcome.status === "applied") {
        setDone(true);
        setMessage(`Merge when ready is on for ${ref}.`);
      } else {
        setMessage(switchRefusalCopy("merge-when-ready", outcome));
      }
    } catch (error) {
      setMessage(
        pullRequestControlsLoadMessage(error) ?? "Octant could not turn on Merge when ready.",
      );
    } finally {
      setBusy(false);
      setOpen(false);
    }
  }

  return (
    <>
      <OctantButton
        aria-label={`Merge ${ref} when ready`}
        disabled={done || busy}
        onClick={() => setOpen(true)}
        size="sm"
        type="button"
        variant="outline"
      >
        Merge when ready…
      </OctantButton>
      {message === undefined ? null : <p role="status">{message}</p>}
      {open ? (
        <OctantDialog
          className="octant-confirmation"
          initialFocus={cancel}
          label={`Merge ${ref} when ready`}
          onClose={() => {
            if (!busy) setOpen(false);
          }}
          open
        >
          <h2 className="octant-confirmation__title">Merge {ref} when ready?</h2>
          <p className="octant-confirmation__description">
            GitHub merges the pull request at its current head once its required checks and reviews
            pass. You can turn it off from the pull request.
          </p>
          <div className="octant-dialog__actions">
            <OctantButton
              disabled={busy}
              onClick={() => setOpen(false)}
              ref={cancel}
              type="button"
              variant="outline"
            >
              Cancel
            </OctantButton>
            <OctantButton
              disabled={busy}
              onClick={() => void confirm()}
              type="button"
              variant="solid"
            >
              Turn on
            </OctantButton>
          </div>
        </OctantDialog>
      ) : null}
    </>
  );
}
