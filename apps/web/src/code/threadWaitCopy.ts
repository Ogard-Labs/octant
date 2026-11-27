import type { CodeThreadPullRequestWait } from "@octant/contracts/code-project-pull-request-switches";

const DOING = {
  watch: "Watching",
  babysit: "Babysitting",
  "auto-fix": "Auto-fixing",
} as const satisfies Record<CodeThreadPullRequestWait["kind"], string>;

export function waitKey(wait: CodeThreadPullRequestWait): string {
  const { repositoryOwner, repositoryName, number } = wait.target;
  return `${wait.kind}:${repositoryOwner}/${repositoryName}#${String(number)}`;
}

export function waitLabel(wait: CodeThreadPullRequestWait): string {
  return `${DOING[wait.kind]} pull request #${String(wait.target.number)}`;
}

export function waitRepository(wait: CodeThreadPullRequestWait): string {
  return `${wait.target.repositoryOwner}/${wait.target.repositoryName}`;
}

const endTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    // A watch may run past a week, so a weekday alone could name the wrong day.
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/** Why a paused wait reads nothing, or how the person resumes it. */
function pausedBecause(wait: CodeThreadPullRequestWait): string {
  if (wait.pausedBy === "github-disconnected") return "GitHub is disconnected";
  // Babysitting finds a window again by itself, so there is nothing to open.
  if (wait.pausedBy === "unreachable" || wait.kind === "babysit")
    return "Octant can’t reach this pull request";
  return "Open the pull request to resume";
}

/** The second line of a wait's entry: where it is, and what bounds or holds it. */
export function waitDetail(wait: CodeThreadPullRequestWait): string {
  const parts = [waitRepository(wait)];
  if (wait.paused) parts.push(pausedBecause(wait));
  if (wait.wakes !== undefined && wait.wakeLimit !== undefined) {
    parts.push(`${String(wait.wakes)} of ${String(wait.wakeLimit)} wakes used`);
  }
  if (wait.endsAt !== undefined) parts.push(`Ends ${endTime(wait.endsAt)}`);
  return parts.join(" · ");
}
