import type { TrackerMention } from "@octant/contracts";
import { CircleDot, GitPullRequest, SquareKanban } from "../ui/icons";

export const TRACKER_MENTION_KIND_LABEL: Readonly<Record<TrackerMention["kind"], string>> = {
  "pull-request": "Pull request",
  "github-issue": "GitHub issue",
  "linear-issue": "Linear issue",
};

export function TrackerMentionIcon(props: { readonly kind: TrackerMention["kind"] }) {
  const Icon =
    props.kind === "pull-request"
      ? GitPullRequest
      : props.kind === "linear-issue"
        ? SquareKanban
        : CircleDot;
  return <Icon aria-hidden="true" size={12} />;
}

const GITHUB_STATES: Readonly<Record<string, string>> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
};

/** A GitHub state as a word; a Linear workflow state already is its own. */
export function trackerMentionStateText(state: string): string {
  return GITHUB_STATES[state] ?? state;
}

/** `owner/name` on GitHub, the team's key on Linear: what the URL or id alone can say. */
export function trackerMentionContainer(mention: TrackerMention): string {
  if (mention.source === "linear") return mention.id.slice(0, mention.id.lastIndexOf("-"));
  return new URL(mention.url).pathname.split("/").slice(1, 3).join("/");
}
