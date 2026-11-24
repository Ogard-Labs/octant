import type { ThreadTouchedIssue } from "@octant/contracts";

/** One stable key per issue across both forges. */
export function touchedIssueKey(issue: ThreadTouchedIssue): string {
  return issue.forge === "github"
    ? `github:${issue.owner}/${issue.repository}#${String(issue.number)}`
    : `linear:${issue.identifier}`;
}

/** How the issue is named in a line: `#3` for GitHub, its key for Linear. */
export function touchedIssueReference(issue: ThreadTouchedIssue): string {
  return issue.forge === "github" ? `#${String(issue.number)}` : issue.identifier;
}

/** Where it lives, said beside the reference: the repository, or Linear. */
export function touchedIssuePlace(issue: ThreadTouchedIssue): string {
  return issue.forge === "github" ? issue.repository : "Linear";
}

export { threadTouchedIssueIsFinished as touchedIssueIsFinished } from "@octant/domain/thread-board-pull-request-policy";

/**
 * The issue's own page, or nothing: a GitHub issue's address follows from its
 * identity, and a Linear one only when the call's result gave it, since a
 * Linear address needs the workspace.
 */
export function touchedIssueUrl(issue: ThreadTouchedIssue): string | undefined {
  return issue.forge === "github"
    ? `https://github.com/${issue.owner}/${issue.repository}/issues/${String(issue.number)}`
    : issue.url;
}

/** The whole issue in words, for a line's tooltip and accessible name. */
export function touchedIssueName(issue: ThreadTouchedIssue): string {
  return [
    `${issue.forge === "github" ? "GitHub" : "Linear"} issue ${touchedIssueReference(issue)}`,
    issue.title,
    issue.forge === "github" ? `${issue.owner}/${issue.repository}` : undefined,
    issue.state,
  ]
    .filter((part): part is string => part !== undefined)
    .join(", ");
}
