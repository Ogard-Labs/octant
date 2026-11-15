import {
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  type IconComponent,
} from "../ui/icons";

export type PullRequestStateKind = "open" | "draft" | "merged" | "closed" | "unknown";

/** One state's glyph, words and colour role, shared by every surface that names a pull request. */
export interface PullRequestStateMark {
  readonly label: string;
  /** Names the `--oct-pr-*` token the `data-pr-state` rule paints with. */
  readonly tone: PullRequestStateKind;
  readonly Icon: IconComponent;
}

const MARKS: Readonly<Record<PullRequestStateKind, PullRequestStateMark>> = {
  open: { label: "Open", tone: "open", Icon: GitPullRequest },
  draft: { label: "Draft", tone: "draft", Icon: GitPullRequestDraft },
  merged: { label: "Merged", tone: "merged", Icon: GitMerge },
  closed: { label: "Closed", tone: "closed", Icon: GitPullRequestClosed },
  unknown: { label: "Pull request", tone: "unknown", Icon: GitPullRequest },
};

export function pullRequestStateMark(state: PullRequestStateKind): PullRequestStateMark {
  return MARKS[state];
}

/** A list row reports `draft` beside an `open` state; a draft only exists while open. */
export function pullRequestRowStateMark(row: {
  readonly state: PullRequestStateKind;
  readonly draft: boolean;
}): PullRequestStateMark {
  return MARKS[row.state === "open" && row.draft ? "draft" : row.state];
}
