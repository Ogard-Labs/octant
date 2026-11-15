import { pullRequestStateMark, type PullRequestStateKind } from "./pullRequestState";

/** The state of a pull request as its glyph and word, painted by its state token. */
export function PullRequestStatePill(props: { readonly state: PullRequestStateKind }) {
  const { Icon, label, tone } = pullRequestStateMark(props.state);
  return (
    <span className="pr-state-pill" data-pr-state={tone}>
      <Icon aria-hidden="true" size={14} />
      {label}
    </span>
  );
}
