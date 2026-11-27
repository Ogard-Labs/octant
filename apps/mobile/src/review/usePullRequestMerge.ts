import { useMemo, useState } from "react";
import {
  loadMobilePullRequestMergeState,
  mergeMobilePullRequest,
  setMobileMergeWhenReady,
  type MobilePullRequestMergeState,
  type MobilePullRequestTarget,
  type MobileRemoteTransport,
} from "@octant/client-runtime";
import { mergeOutcomeCopy, mergeWhenReadyOutcomeCopy } from "./pullRequestMergePresentation";
import { createExpoPhoneUnlockKey } from "../hosts/expoOwnerUnlockPorts";
import { phoneOwnerMergeUnlock } from "../hosts/ownerFlow";
import { mobilePinnedListenerTransport } from "../runtime/mobilePinnedListenerTransport";
import { useMobileSession } from "../session/MobileSessionContext";

export type PullRequestMergeStep =
  | { readonly kind: "reading" }
  | {
      readonly kind: "confirm";
      readonly mode: "merge" | "when-ready";
      readonly state: MobilePullRequestMergeState;
    }
  | { readonly kind: "sending" }
  | undefined;

/**
 * The phone's merge and Merge when ready, wherever a pull request is shown:
 * it re-reads the pull request first, so the head the person confirms is one
 * the host has just seen, and the confirm sends that head and nothing older.
 */
export function usePullRequestMerge(input: {
  readonly transport: MobileRemoteTransport | undefined;
  readonly target: MobilePullRequestTarget | undefined;
  readonly onMerged?: () => void;
  /** The computer turned Merge when ready on or off, as it now says. */
  readonly onMergeWhenReady?: (on: boolean) => void;
}) {
  const { deviceKeyStore, guestHubStore } = useMobileSession();
  // A host may ask a paired phone's merge for an owner unlock first; this phone
  // gives it only if it is an owner of that host, asking the person once.
  const ownerUnlock = useMemo(() => {
    const unlockKey = createExpoPhoneUnlockKey();
    return unlockKey === undefined
      ? undefined
      : phoneOwnerMergeUnlock({
          guestHubStore,
          deviceKeyStore,
          transport: mobilePinnedListenerTransport,
          unlockKey,
        });
  }, [deviceKeyStore, guestHubStore]);
  const [step, setStep] = useState<PullRequestMergeStep>();
  const [notice, setNotice] = useState<string | undefined>();
  const { transport, target, onMerged, onMergeWhenReady } = input;

  async function begin(mode: "merge" | "when-ready"): Promise<void> {
    if (transport === undefined || target === undefined) return;
    setNotice(undefined);
    setStep({ kind: "reading" });
    try {
      const state = await loadMobilePullRequestMergeState(transport, target);
      if (!state.mergeable) {
        setStep(undefined);
        setNotice("Not ready to merge here: the pull request must be open, fresh, and mergeable.");
        return;
      }
      setStep({ kind: "confirm", mode, state });
    } catch {
      setStep(undefined);
      setNotice("Could not read the pull request from the host. Try again.");
    }
  }

  async function confirm(): Promise<void> {
    if (transport === undefined || target === undefined || step?.kind !== "confirm") return;
    const { mode, state } = step;
    setStep({ kind: "sending" });
    try {
      if (mode === "merge") {
        const outcome = await mergeMobilePullRequest(
          transport,
          { ...target, method: "squash", headSha: state.headSha },
          ownerUnlock,
        );
        setNotice(mergeOutcomeCopy(outcome));
        if (outcome.status === "merged") onMerged?.();
      } else {
        const outcome = await setMobileMergeWhenReady(
          transport,
          { ...target, enabled: true, method: "squash", headSha: state.headSha },
          ownerUnlock,
        );
        setNotice(mergeWhenReadyOutcomeCopy(outcome));
        if (outcome.status === "applied")
          onMergeWhenReady?.(outcome.view.mergeWhenReady.status === "on");
      }
    } catch {
      setNotice("The host did not answer. Nothing was confirmed; check the pull request.");
    } finally {
      setStep(undefined);
    }
  }

  async function turnOffMergeWhenReady(): Promise<void> {
    if (transport === undefined || target === undefined) return;
    setStep({ kind: "sending" });
    try {
      const outcome = await setMobileMergeWhenReady(transport, { ...target, enabled: false });
      setNotice(mergeWhenReadyOutcomeCopy(outcome));
      if (outcome.status === "applied")
        onMergeWhenReady?.(outcome.view.mergeWhenReady.status === "on");
    } catch {
      setNotice("The host did not answer. Merge when ready may still be on.");
    } finally {
      setStep(undefined);
    }
  }

  return {
    step,
    notice,
    begin,
    confirm,
    cancel: () => setStep(undefined),
    turnOffMergeWhenReady,
  };
}
