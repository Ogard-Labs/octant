import type {
  CodeProjectPullRequestMergeOutcome,
  CodeProjectPullRequestSwitchOutcome,
} from "@octant/contracts";

/** The words under the confirm buttons, naming the head the person is about to confirm. */
export function mergeConfirmationCopy(
  mode: "merge" | "when-ready",
  number: number,
  headSha: string,
): string {
  const head = headSha.slice(0, 7);
  return mode === "merge"
    ? `Merge #${number} now? This merges the head you just reviewed (${head}) with squash. Octant refuses if it changed or if the required checks have not all passed.`
    : `Merge #${number} when ready? GitHub merges the head you just reviewed (${head}) with squash once its required checks and reviews pass. A new push turns it off.`;
}

export function mergeOutcomeCopy(outcome: CodeProjectPullRequestMergeOutcome): string {
  if (outcome.status === "merged") return `Merged #${outcome.number}.`;
  if (outcome.status === "unavailable") {
    return outcome.reason === "unauthenticated"
      ? "Merge unavailable: GitHub sign-in is missing on the host."
      : outcome.reason === "disconnected"
        ? "Merge unavailable: the host could not reach GitHub."
        : "Merge unavailable: the host cannot run the GitHub command.";
  }
  const reason: Record<typeof outcome.reason, string> = {
    "not-authorized": "this Project is not connected to that repository",
    "not-open": "the pull request is no longer open",
    "not-mergeable": "GitHub says it is not mergeable",
    stale: "the pull request changed since you reviewed it",
    conflict: "GitHub reported a merge conflict",
    failed: "GitHub rejected the merge",
    "not-confirmed": "the merge was not confirmed",
    "checks-not-passing": "the required checks have not all passed",
    "checks-unknown": "the required checks could not be read",
  };
  return `Merge refused: ${reason[outcome.reason]}.`;
}

export function mergeWhenReadyOutcomeCopy(outcome: CodeProjectPullRequestSwitchOutcome): string {
  if (outcome.status === "applied") {
    return outcome.view.mergeWhenReady.status === "on"
      ? "Merge when ready is on. GitHub merges once the required checks and reviews pass."
      : "Merge when ready is off.";
  }
  if (outcome.status === "unsupported") {
    return "This repository does not allow auto-merge. Turn it on in the repository's GitHub settings, or merge by hand.";
  }
  if (outcome.status === "unavailable") {
    return outcome.reason === "unauthenticated"
      ? "Merge when ready did not change: GitHub sign-in is missing on the host."
      : outcome.reason === "disconnected"
        ? "Merge when ready did not change: the host could not reach GitHub."
        : "Merge when ready did not change: the host cannot run the GitHub command.";
  }
  const reason: Record<typeof outcome.reason, string> = {
    "not-authorized": "it was not confirmed, or this Project is not connected to that repository",
    "not-open": "the pull request is no longer open",
    stale: "the pull request changed since you reviewed it",
    "thread-not-linked": "the thread is not linked to this pull request",
    "method-not-allowed": "the repository does not allow squash merges",
    failed: "GitHub rejected the change",
  };
  return `Merge when ready did not change: ${reason[outcome.reason]}.`;
}
