import { pullRequestStateMark, type PullRequestStateKind } from "./pullRequestState";

/**
 * A pull request's state. In a list it is a mark in the state's colour; at the
 * head of a request's own page it is `solid`, the filled badge a person knows
 * from the host, so the state is the first thing read.
 */
export function PullRequestStatePill(props: {
  readonly state: PullRequestStateKind;
  readonly solid?: boolean;
}) {
  const { Icon, label, tone } = pullRequestStateMark(props.state);
  return (
    <span
      className="pr-state-pill"
      data-pr-solid={props.solid === true ? "true" : undefined}
      data-pr-state={tone}
    >
      <Icon aria-hidden="true" size={14} />
      {label}
    </span>
  );
}
