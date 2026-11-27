import type { CodeProjectPullRequestRow, PullRequestBabysitStatus } from "@octant/contracts";
import { MOBILE_COPY } from "../copy";

/** One pull request as the phone lists it: the row a computer sent, and which computer. */
export interface MobilePullRequest {
  readonly hostId: string;
  readonly row: CodeProjectPullRequestRow;
}

export type MobilePullRequestGroupId = "needs-you" | "in-progress" | "ready" | "done";

export const MOBILE_PULL_REQUEST_GROUPS: ReadonlyArray<{
  readonly id: MobilePullRequestGroupId;
  readonly label: string;
}> = [
  { id: "needs-you", label: MOBILE_COPY.pullRequestsNeedYou },
  { id: "ready", label: MOBILE_COPY.pullRequestsReady },
  { id: "in-progress", label: MOBILE_COPY.pullRequestsInProgress },
  { id: "done", label: MOBILE_COPY.pullRequestsDone },
];

export function pullRequestKey(pullRequest: MobilePullRequest): string {
  const { row } = pullRequest;
  return `${pullRequest.hostId}:${row.projectId}:${row.repositoryOwner}/${row.repositoryName}#${row.number}`;
}

// A watch that stopped and waits on the person, rather than one still at work.
const BABYSIT_STOPPED_FOR_PERSON: ReadonlySet<PullRequestBabysitStatus> = new Set([
  "needs-help",
  "attempt-limit",
  "feedback-limit",
  "thread-unavailable",
  "authority-lost",
]);

/** A babysit that is still watching: one that stopped is history, not a badge. */
export function babysitting(row: CodeProjectPullRequestRow): boolean {
  return row.babysit !== undefined && row.babysit.stoppedAt === undefined;
}

/**
 * Where a pull request sits in the list. Needs you is what only a person can
 * move on: failing checks, requested changes, a conflict, or a babysit that
 * gave up. Ready is open, passing, free of conflicts and not waiting on a
 * review; one already on its way in stays In progress.
 */
export function pullRequestGroup(row: CodeProjectPullRequestRow): MobilePullRequestGroupId {
  if (row.state === "merged" || row.state === "closed") return "done";
  if (row.draft) return "in-progress";
  if (
    row.checks === "failing" ||
    row.review === "changes-requested" ||
    row.mergeability === "conflicting" ||
    (row.babysit !== undefined && BABYSIT_STOPPED_FOR_PERSON.has(row.babysit.status))
  ) {
    return "needs-you";
  }
  if (
    row.merging === undefined &&
    row.state === "open" &&
    row.checks === "passing" &&
    row.mergeability === "mergeable" &&
    (row.review === "approved" || row.review === "none")
  ) {
    return "ready";
  }
  return "in-progress";
}

/** The groups that hold a pull request, in list order, each newest first. */
export function groupPullRequests(pullRequests: ReadonlyArray<MobilePullRequest>): ReadonlyArray<{
  readonly id: MobilePullRequestGroupId;
  readonly label: string;
  readonly pullRequests: ReadonlyArray<MobilePullRequest>;
}> {
  return MOBILE_PULL_REQUEST_GROUPS.flatMap((group) => {
    // A copy sorted in place: Hermes has no `toSorted`.
    const held = pullRequests
      .filter((entry) => pullRequestGroup(entry.row) === group.id)
      .sort((a, b) => b.row.updatedAt.localeCompare(a.row.updatedAt));
    return held.length === 0 ? [] : [{ ...group, pullRequests: held }];
  });
}

export type PullRequestTone = "success" | "danger" | "warning" | "merged" | "neutral";

export function pullRequestStateChip(row: CodeProjectPullRequestRow): {
  readonly label: string;
  readonly tone: PullRequestTone;
} {
  if (row.state === "merged") return { label: MOBILE_COPY.pullRequestMerged, tone: "merged" };
  if (row.state === "closed") return { label: MOBILE_COPY.pullRequestClosed, tone: "danger" };
  if (row.draft) return { label: MOBILE_COPY.pullRequestDraft, tone: "neutral" };
  return { label: MOBILE_COPY.pullRequestOpen, tone: "success" };
}

export function pullRequestChecks(row: CodeProjectPullRequestRow): {
  readonly label: string;
  readonly tone: PullRequestTone;
} {
  const counted =
    row.checkCounts === undefined
      ? undefined
      : MOBILE_COPY.pullRequestChecksCount(row.checkCounts.passed, row.checkCounts.total);
  switch (row.checks) {
    case "passing":
      return { label: counted ?? MOBILE_COPY.pullRequestChecksPassing, tone: "success" };
    case "failing":
      return { label: counted ?? MOBILE_COPY.pullRequestChecksFailing, tone: "danger" };
    case "pending":
      return { label: counted ?? MOBILE_COPY.pullRequestChecksPending, tone: "warning" };
    case "unknown":
      return { label: MOBILE_COPY.pullRequestChecksUnknown, tone: "neutral" };
  }
}

export function pullRequestReview(row: CodeProjectPullRequestRow): {
  readonly label: string;
  readonly tone: PullRequestTone;
} {
  switch (row.review) {
    case "approved":
      return { label: MOBILE_COPY.pullRequestReviewApproved, tone: "success" };
    case "changes-requested":
      return { label: MOBILE_COPY.pullRequestReviewChanges, tone: "danger" };
    case "pending":
      return { label: MOBILE_COPY.pullRequestReviewPending, tone: "warning" };
    case "none":
      return { label: MOBILE_COPY.pullRequestReviewNone, tone: "neutral" };
    case "unknown":
      return { label: MOBILE_COPY.pullRequestReviewUnknown, tone: "neutral" };
  }
}

export function pullRequestMergeability(row: CodeProjectPullRequestRow): {
  readonly label: string;
  readonly tone: PullRequestTone;
} {
  switch (row.mergeability) {
    case "mergeable":
      return { label: MOBILE_COPY.pullRequestMergeable, tone: "success" };
    case "conflicting":
      return { label: MOBILE_COPY.pullRequestConflicting, tone: "danger" };
    case "unknown":
      return { label: MOBILE_COPY.pullRequestMergeabilityUnknown, tone: "neutral" };
  }
}

/** Badges for a pull request on its way in, or watched by a babysit. */
export function pullRequestBadges(row: CodeProjectPullRequestRow): ReadonlyArray<string> {
  return [
    ...(row.merging === "queued" ? [MOBILE_COPY.pullRequestQueued] : []),
    ...(row.merging === "auto-merge" ? [MOBILE_COPY.pullRequestAutoMerge] : []),
    ...(babysitting(row) ? [MOBILE_COPY.pullRequestBabysitting] : []),
  ];
}

const BABYSIT_STATUS: Readonly<Record<PullRequestBabysitStatus, string>> = {
  checking: "Checking",
  connection: "Waiting for GitHub",
  draft: "Waiting while it is a draft",
  approval: "Waiting for approval",
  label: "Waiting for its label",
  checks: "Waiting for checks",
  "repair-check": "Fixing a failing check",
  "repair-review": "Answering review comments",
  "outside-review": "Waiting on an outside review",
  "repair-branch": "Updating the branch",
  repository: "Waiting on repository rules",
  ready: "Ready to merge",
  "attempt-limit": "Stopped: too many fix attempts",
  "feedback-limit": "Stopped: too many review rounds",
  "needs-help": "Stopped: needs your help",
  "thread-unavailable": "Stopped: its thread is unavailable",
  "authority-lost": "Stopped: it lost access",
};

/** What the babysit says now, or Off when nothing watches the pull request. */
export function babysitStatusLabel(row: CodeProjectPullRequestRow): string {
  if (row.babysit === undefined) return MOBILE_COPY.pullRequestBabysitOff;
  return row.babysit.blockerDetail ?? BABYSIT_STATUS[row.babysit.status];
}

/**
 * Whether Merge when ready is on, for its off switch. What the person turned
 * it to here wins. Otherwise either source says on: the computer's switch read
 * knows only what Octant turned on, and auto-merge turned on in GitHub itself
 * shows only on the row.
 */
export function pullRequestMergeWhenReadyOn(input: {
  readonly turnedHere: boolean | undefined;
  readonly switchRead: boolean;
  readonly row: Pick<CodeProjectPullRequestRow, "merging">;
}): boolean {
  return input.turnedHere ?? (input.switchRead || input.row.merging === "auto-merge");
}
