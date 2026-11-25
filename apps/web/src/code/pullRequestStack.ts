import type {
  CodeProjectPullRequestDetailObserved,
  CodeProjectPullRequestDetailView,
  CodeProjectPullRequestStackMergeOutcome,
} from "@octant/contracts";
import { ownerMergeUnlockCopy, type OwnerUnlockNotGiven } from "@octant/client-runtime";
import { mergeOutcomeCopy } from "./ProjectPullRequestSupport";

/** "#1", "#1 and #2", "#1, #2 and #3". */
function numberWords(numbers: ReadonlyArray<number>): string {
  const words = numbers.map((number) => `#${String(number)}`);
  const last = words.pop();
  if (last === undefined) return "nothing";
  return words.length === 0 ? last : `${words.join(", ")} and ${last}`;
}

export interface ReviewedStackLayer {
  readonly number: number;
  readonly title: string;
  readonly headSha: string;
}

export type ReviewedStack =
  | {
      readonly status: "ready";
      readonly layers: ReadonlyArray<ReviewedStackLayer>;
      /** The branch the whole stack lands on. */
      readonly destination: string;
    }
  | { readonly status: "blocked"; readonly reason: string };

function layerBlock(view: CodeProjectPullRequestDetailView): string | undefined {
  const { detail } = view;
  if (detail.state !== "observed") return "could not be read";
  if (view.freshness.status !== "fresh" || detail.freshness !== "fresh" || detail.ambiguous) {
    return "has no fresh GitHub observation";
  }
  if (detail.pullRequestState === "draft") return "is a draft";
  if (detail.pullRequestState !== "open") return "is no longer open";
  if (detail.mergeability === "conflicting") return "has merge conflicts";
  if (detail.mergeability !== "mergeable") return "is not known to merge cleanly yet";
  if (detail.headSha === "") return "could not be read";
  return undefined;
}

/**
 * What a stack merge would send, from a reading of every layer made for the
 * confirmation. The cached list said they were one stack; the branches are
 * checked again here, because a layer may have landed or moved since.
 */
export function reviewStack(views: ReadonlyArray<CodeProjectPullRequestDetailView>): ReviewedStack {
  const observed: CodeProjectPullRequestDetailObserved[] = [];
  for (const view of views) {
    const block = layerBlock(view);
    if (block !== undefined || view.detail.state !== "observed") {
      return {
        status: "blocked",
        reason: `#${String(view.query.number)} ${block ?? "could not be read"}.`,
      };
    }
    const below = observed[observed.length - 1];
    if (below !== undefined && view.detail.baseBranch !== below.headBranch) {
      return {
        status: "blocked",
        reason: `#${String(view.query.number)} is no longer based on #${String(below.number)}.`,
      };
    }
    observed.push(view.detail);
  }
  const bottom = observed[0];
  if (bottom === undefined) return { status: "blocked", reason: "The stack could not be read." };
  return {
    status: "ready",
    destination: bottom.baseBranch,
    layers: observed.map(({ number, title, headSha }) => ({ number, title, headSha })),
  };
}

const STACK_REFUSAL: Readonly<
  Record<
    Extract<CodeProjectPullRequestStackMergeOutcome, { readonly status: "refused" }>["reason"],
    string
  >
> = {
  "not-authorized": "this Project is not authorized for that repository",
  "not-confirmed": "the merge was not confirmed",
  empty: "the stack is empty",
  "too-long": "the stack has too many layers",
  duplicate: "a layer is listed twice",
  "not-a-chain": "its layers no longer build on each other",
  unreadable: "a layer is no longer open or could not be read",
  "base-changed": "the stack lands on another branch than the one you confirmed",
  stale: "a layer changed since you confirmed it",
};

/** What landed, and why it stopped where it did. */
export function stackMergeOutcomeCopy(
  outcome: CodeProjectPullRequestStackMergeOutcome | OwnerUnlockNotGiven,
): string {
  switch (outcome.status) {
    case "merged":
      return `Merged ${numberWords(outcome.merged)}. Refreshing the review state.`;
    case "refused":
      return `Nothing merged: ${STACK_REFUSAL[outcome.reason]}.`;
    case "stopped": {
      const at = `#${String(outcome.stoppedAt)}`;
      const landed = outcome.merged.length === 0 ? "" : `Merged ${numberWords(outcome.merged)}. `;
      // Its base is part of what happened: it was changed for this merge and stays.
      const base =
        outcome.retargetedTo === undefined ? "" : ` ${at} is now based on ${outcome.retargetedTo}.`;
      if (outcome.outcome.status === "not-landed") {
        return `${landed}GitHub accepted ${at} but has not landed it yet, as with a merge queue. Merge the rest of the stack once it has.${base}`;
      }
      return `${landed === "" ? "Nothing merged. " : landed}Stopped at ${at}. ${mergeOutcomeCopy(outcome.outcome)}${base}`;
    }
    case "owner-unlock-required":
    case "owner-unlock-not-given":
      return ownerMergeUnlockCopy(outcome);
  }
}
