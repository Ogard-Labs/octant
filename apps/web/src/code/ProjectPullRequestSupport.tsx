import { ownerMergeUnlockCopy, type OwnerUnlockNotGiven } from "@octant/client-runtime";
import {
  CODE_PROJECT_PULL_REQUEST_AUTO_FIX_MAX_ATTEMPTS,
  type CodeProjectPullRequestDetailObserved,
  type CodeProjectPullRequestFreshness,
  type CodeProjectPullRequestLinkedThread,
  type CodeProjectPullRequestMergeMethod,
  type CodeProjectPullRequestMergeOutcome,
  type CodeProjectPullRequestSwitchOutcome,
  type CodeProjectPullRequestSwitchesView,
  type CodeThreadId,
} from "@octant/contracts";
import { useState } from "react";
import { type OctantBadgeProps } from "../ui/base/OctantBadge";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantSwitch } from "../ui/base/OctantSwitch";

/** What the dock's review and the page's reading pane both say about a pull request. */

export const PR_STATE_LABELS: Record<
  CodeProjectPullRequestDetailObserved["pullRequestState"],
  string
> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
};

export const PR_STATE_VARIANTS: Record<
  CodeProjectPullRequestDetailObserved["pullRequestState"],
  NonNullable<OctantBadgeProps["variant"]>
> = {
  open: "secondary",
  draft: "outline",
  merged: "success",
  closed: "destructive",
};

export const CHECK_STATE_LABELS: Record<
  CodeProjectPullRequestDetailObserved["checks"][number]["state"],
  string
> = {
  success: "Passing",
  failure: "Failing",
  pending: "Pending",
  neutral: "Neutral",
  unknown: "Unknown",
};

export const CHECK_STATE_VARIANTS: Record<
  CodeProjectPullRequestDetailObserved["checks"][number]["state"],
  NonNullable<OctantBadgeProps["variant"]>
> = {
  success: "success",
  failure: "destructive",
  pending: "warning",
  neutral: "secondary",
  unknown: "secondary",
};

export function PullRequestSwitches(props: {
  /** The page's status column: captions as text in a tooltip, not a paragraph under each. */
  readonly compact?: boolean;
  readonly detail: CodeProjectPullRequestDetailObserved;
  readonly linkedThreads: ReadonlyArray<CodeProjectPullRequestLinkedThread>;
  readonly mergeMethod: CodeProjectPullRequestMergeMethod;
  readonly switches: CodeProjectPullRequestSwitchesView;
  readonly onMergeWhenReady?: (
    enabled: boolean,
    method: CodeProjectPullRequestMergeMethod,
    headSha: string,
  ) => Promise<CodeProjectPullRequestSwitchOutcome | OwnerUnlockNotGiven>;
  readonly onAutoFix?: (
    enabled: boolean,
    threadId: CodeThreadId,
  ) => Promise<CodeProjectPullRequestSwitchOutcome | OwnerUnlockNotGiven>;
}) {
  const { detail, switches } = props;
  const [pending, setPending] = useState<"merge-when-ready" | "auto-fix">();
  const [confirmingMergeWhenReady, setConfirmingMergeWhenReady] = useState(false);
  const [refusal, setRefusal] = useState<{
    readonly switch: "merge-when-ready" | "auto-fix";
    readonly outcome: Exclude<
      CodeProjectPullRequestSwitchOutcome | OwnerUnlockNotGiven,
      { status: "applied" }
    >;
  }>();
  const autoFixThread =
    switches.autoFix.status === "off"
      ? props.linkedThreads[0]
      : props.linkedThreads.find(
          (thread) =>
            switches.autoFix.status !== "off" &&
            String(thread.threadId) === String(switches.autoFix.threadId),
        );
  const open = detail.pullRequestState === "open" || detail.pullRequestState === "draft";
  const mergeWhenReadyOn = switches.mergeWhenReady.status === "on";
  const autoFixOn = switches.autoFix.status === "on";
  const mergeWhenReadyBlocked =
    props.onMergeWhenReady === undefined
      ? "This host cannot change Merge when ready."
      : !open && !mergeWhenReadyOn
        ? "Only an open pull request can merge when ready."
        : detail.headSha === "" && !mergeWhenReadyOn
          ? "Refresh the detail to read the pull request's head first."
          : undefined;
  const autoFixBlocked =
    props.onAutoFix === undefined
      ? "This host cannot change Auto-fix."
      : autoFixThread === undefined
        ? "Link a Code thread to this pull request to use Auto-fix."
        : !open && !autoFixOn
          ? "Only an open pull request can be fixed automatically."
          : undefined;

  async function change(
    which: "merge-when-ready" | "auto-fix",
    run: () => Promise<CodeProjectPullRequestSwitchOutcome | OwnerUnlockNotGiven>,
  ): Promise<void> {
    setPending(which);
    setRefusal(undefined);
    try {
      const outcome = await run();
      if (outcome.status !== "applied") setRefusal({ switch: which, outcome });
    } catch {
      setRefusal({ switch: which, outcome: { status: "unavailable", reason: "unavailable" } });
    } finally {
      setPending(undefined);
    }
  }

  return (
    <section
      aria-label="Automatic actions"
      className="code-pr-review__section code-pr-review__switches"
      data-compact={props.compact === true ? "true" : undefined}
    >
      <header className="code-pr-review__section-header">
        {props.compact === true ? (
          <h2 className="oct-nav-group">Automatic actions</h2>
        ) : (
          <h2>Automatic actions</h2>
        )}
      </header>
      <div className="code-pr-review__switch">
        <div
          className="code-pr-review__switch-text"
          title={mergeWhenReadyCopy(switches.mergeWhenReady)}
        >
          <strong id="code-pr-review-merge-when-ready">Merge when ready</strong>
          <p id="code-pr-review-merge-when-ready-status" role="status">
            {mergeWhenReadyCopy(switches.mergeWhenReady)}
          </p>
        </div>
        <OctantSwitch
          checked={mergeWhenReadyOn}
          describedBy="code-pr-review-merge-when-ready-status"
          disabled={mergeWhenReadyBlocked !== undefined || pending !== undefined}
          {...(mergeWhenReadyBlocked === undefined
            ? {}
            : { disabledReason: mergeWhenReadyBlocked })}
          label="Merge when ready"
          onCheckedChange={(checked) => {
            const run = props.onMergeWhenReady;
            if (run === undefined) return;
            // Turning it on hands the merge to GitHub, so it asks first, as a
            // merge does; turning it off is immediate.
            if (checked) {
              setConfirmingMergeWhenReady(true);
              return;
            }
            void change("merge-when-ready", () => run(false, props.mergeMethod, detail.headSha));
          }}
        />
      </div>
      {confirmingMergeWhenReady ? (
        <div
          aria-label="Confirm Merge when ready"
          className="code-pr-review__merge-confirmation"
          role="region"
          onKeyDown={(event) => {
            if (event.key === "Escape" && pending === undefined) {
              event.preventDefault();
              event.stopPropagation();
              setConfirmingMergeWhenReady(false);
            }
          }}
        >
          <strong>Merge pull request #{detail.number} when ready?</strong>
          <p>
            GitHub merges the head you reviewed ({detail.headSha.slice(0, 7)}) once its required
            checks and reviews pass, using {MERGE_METHOD_COPY[props.mergeMethod]}. A new push turns
            it off.
          </p>
          <div className="code-pr-review__actions">
            <OctantButton
              autoFocus
              disabled={pending !== undefined}
              onClick={() => setConfirmingMergeWhenReady(false)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Cancel
            </OctantButton>
            <OctantButton
              disabled={pending !== undefined}
              onClick={() => {
                const run = props.onMergeWhenReady;
                if (run === undefined) return;
                setConfirmingMergeWhenReady(false);
                void change("merge-when-ready", () => run(true, props.mergeMethod, detail.headSha));
              }}
              size="sm"
              type="button"
              variant="secondary"
            >
              Confirm Merge when ready
            </OctantButton>
          </div>
        </div>
      ) : null}
      <div className="code-pr-review__switch">
        <div
          className="code-pr-review__switch-text"
          title={autoFixCopy(switches.autoFix, autoFixThread?.title)}
        >
          <strong>Auto-fix</strong>
          <p id="code-pr-review-auto-fix-status" role="status">
            {autoFixCopy(switches.autoFix, autoFixThread?.title)}
          </p>
        </div>
        <OctantSwitch
          checked={autoFixOn}
          describedBy="code-pr-review-auto-fix-status"
          disabled={autoFixBlocked !== undefined || pending !== undefined}
          {...(autoFixBlocked === undefined ? {} : { disabledReason: autoFixBlocked })}
          label="Auto-fix"
          onCheckedChange={(checked) => {
            const run = props.onAutoFix;
            if (run === undefined || autoFixThread === undefined) return;
            void change("auto-fix", () => run(checked, autoFixThread.threadId));
          }}
        />
      </div>
      {refusal === undefined ? null : (
        /* ui-boundary-exception: compact-status */
        <p
          className="code-pr-review__merge-result code-pr-review__merge-result--refused"
          role="alert"
        >
          {switchRefusalCopy(refusal.switch, refusal.outcome)}
        </p>
      )}
    </section>
  );
}

export const MERGE_METHOD_COPY: Record<CodeProjectPullRequestMergeMethod, string> = {
  merge: "a merge commit",
  squash: "squash and merge",
  rebase: "rebase and merge",
};

export function mergeWhenReadyCopy(
  state: CodeProjectPullRequestSwitchesView["mergeWhenReady"],
): string {
  if (state.status === "off") {
    return "Off. Turn on to let GitHub merge this pull request once its required checks and reviews pass.";
  }
  if (state.status === "merged") return "GitHub merged this pull request.";
  if (state.status === "turned-off-by-forge") {
    return "GitHub turned auto-merge off. Turn it on again if you still want it.";
  }
  const waits = state.waitingOn.map((wait) =>
    wait === "checks" ? "checks" : wait === "reviews" ? "reviews" : "a merge conflict",
  );
  return waits.length === 0
    ? "On. GitHub merges once required checks and reviews pass."
    : `On. Waiting on ${waits.join(" and ")}.`;
}

export function autoFixCopy(
  state: CodeProjectPullRequestSwitchesView["autoFix"],
  threadTitle: string | undefined,
): string {
  const thread = threadTitle === undefined ? "the linked thread" : `“${threadTitle}”`;
  if (state.status === "off") {
    return `Off. Turn on to let ${thread} fix failed checks, review comments, and merge conflicts, up to ${CODE_PROJECT_PULL_REQUEST_AUTO_FIX_MAX_ATTEMPTS} tries each.`;
  }
  if (state.status === "stopped") {
    if (state.reason === "attempt-limit") {
      return `Stopped after ${CODE_PROJECT_PULL_REQUEST_AUTO_FIX_MAX_ATTEMPTS} tries on the same failure. Look at the thread, then turn it on again.`;
    }
    if (state.reason === "merged") return "Stopped: the pull request merged.";
    if (state.reason === "closed") return "Stopped: the pull request was closed.";
    if (state.reason === "authority-lost") {
      return "Stopped: this Project is no longer connected to the pull request's repository.";
    }
    return "Stopped: the thread is archived or no longer available.";
  }
  if (state.pausedFor === "person-typing") return "On. Waiting while you type in the thread.";
  if (state.pausedFor === "turn-active") {
    return "On. Waiting for the thread's current turn to finish.";
  }
  if (state.lastWake !== undefined) {
    const result =
      state.lastWake.result === "started"
        ? "woke the thread"
        : state.lastWake.result === "unmarked"
          ? "could not mark the thread as reading outside content, so it sent nothing"
          : "tried to wake the thread, which refused the turn";
    return `On. Last ${result} ${formatUpdatedAt(state.lastWake.at)} (try ${state.lastWake.attempt} of ${CODE_PROJECT_PULL_REQUEST_AUTO_FIX_MAX_ATTEMPTS}).`;
  }
  return `On. Watching for failed checks, review comments, and merge conflicts for ${thread}.`;
}

export function switchRefusalCopy(
  which: "merge-when-ready" | "auto-fix",
  outcome: Exclude<
    CodeProjectPullRequestSwitchOutcome | OwnerUnlockNotGiven,
    { status: "applied" }
  >,
): string {
  const name = which === "merge-when-ready" ? "Merge when ready" : "Auto-fix";
  if (outcome.status === "owner-unlock-required" || outcome.status === "owner-unlock-not-given") {
    return `${name} did not change. ${ownerMergeUnlockCopy(outcome).replace(" Nothing merged.", "")}`;
  }
  if (outcome.status === "unsupported") {
    return "Merge when ready is unsupported: this repository does not allow auto-merge. Turn it on in the repository's GitHub settings, or merge by hand.";
  }
  if (outcome.status === "unavailable") {
    const reason =
      outcome.reason === "unauthenticated"
        ? "GitHub authentication is unavailable"
        : outcome.reason === "disconnected"
          ? "GitHub could not be reached"
          : "the GitHub command is unavailable";
    return `${name} did not change: ${reason}.`;
  }
  const reason =
    outcome.reason === "not-authorized"
      ? "only a local Octant window with access to this Project can change it"
      : outcome.reason === "not-open"
        ? "the pull request is no longer open"
        : outcome.reason === "stale"
          ? "the pull request changed since this review; refresh and try again"
          : outcome.reason === "thread-not-linked"
            ? "the thread is not linked to this pull request or is not available"
            : outcome.reason === "method-not-allowed"
              ? "the repository does not allow the selected merge method"
              : "GitHub rejected the change";
  return `${name} did not change: ${reason}.`;
}

export function StaleTag(props: { readonly section: string }) {
  return (
    <span className="code-pr-review__stale" role="note">
      Stale · {props.section} could not be refreshed from GitHub
    </span>
  );
}

export function freshnessCopy(freshness: CodeProjectPullRequestFreshness): string {
  if (freshness.status === "empty") {
    return "No GitHub detail yet. Select a pull request to load it.";
  }
  if (freshness.status === "fresh") {
    return freshness.lastSuccessfulRefreshAt === undefined
      ? "Detail is fresh."
      : `Last successful refresh ${formatUpdatedAt(freshness.lastSuccessfulRefreshAt)}.`;
  }
  const reason =
    freshness.staleReason === "rate-limited"
      ? "GitHub rate-limited the last detail refresh"
      : freshness.staleReason === "timeout"
        ? "The last detail refresh timed out"
        : freshness.staleReason === "malformed"
          ? "The last detail refresh returned unreadable output"
          : freshness.staleReason === "disconnected"
            ? "GitHub was disconnected on the last detail refresh"
            : "The last detail refresh failed";
  const last =
    freshness.lastSuccessfulRefreshAt === undefined
      ? ""
      : ` Last success ${formatUpdatedAt(freshness.lastSuccessfulRefreshAt)}.`;
  const retry =
    freshness.retryAfter === undefined
      ? ""
      : ` Retry after ${formatUpdatedAt(freshness.retryAfter)}.`;
  return `${reason}.${last}${retry}`;
}

export function formatUpdatedAt(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : value;
}

export function safeGithubUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export function mergeOutcomeCopy(
  outcome: CodeProjectPullRequestMergeOutcome | OwnerUnlockNotGiven,
): string {
  if (outcome.status === "merged") {
    return `Merged pull request #${outcome.number}. Refreshing its review state.`;
  }
  if (outcome.status === "owner-unlock-required" || outcome.status === "owner-unlock-not-given") {
    return ownerMergeUnlockCopy(outcome);
  }
  if (outcome.status === "unavailable") {
    const reason =
      outcome.reason === "unauthenticated"
        ? "GitHub authentication is unavailable"
        : outcome.reason === "disconnected"
          ? "GitHub could not be reached"
          : "the GitHub merge command is unavailable";
    return `Merge unavailable: ${reason}.`;
  }
  const reason =
    outcome.reason === "not-authorized"
      ? "this Project is not authorized for that repository"
      : outcome.reason === "not-open"
        ? "the pull request is no longer open"
        : outcome.reason === "not-mergeable"
          ? "GitHub reports that it is not mergeable"
          : outcome.reason === "stale"
            ? "the pull request changed since this review"
            : outcome.reason === "conflict"
              ? "GitHub reported a merge conflict"
              : outcome.reason === "not-confirmed"
                ? "the merge was not confirmed"
                : outcome.reason === "checks-not-passing"
                  ? "the required checks have not all passed"
                  : outcome.reason === "checks-unknown"
                    ? "the required checks could not be read"
                    : "GitHub rejected the merge";
  return `Merge refused: ${reason}.`;
}

export function isMergeMethod(value: string): value is CodeProjectPullRequestMergeMethod {
  return value === "merge" || value === "squash" || value === "rebase";
}
