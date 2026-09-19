import type { ThreadBoardPullRequestSummaries } from "@octant/contracts";
import { Folder, GitBranch, GitPullRequest } from "lucide-react";
import type { ReactNode } from "react";
import { ProviderGlyph } from "../providers/ProviderGlyph";
import type { ThreadCheckoutChip, ThreadProviderIdentity } from "../shell/navigationModel";

type ThreadRowPullRequest = ThreadBoardPullRequestSummaries["items"][number];

/**
 * What a sidebar thread row shows, in the one shape the Project tree and the
 * Activity feed share.
 *
 * The two views grew their rows apart: the tree led with the provider mark and
 * centred its content, the feed had no mark, started its text 6px from the
 * fill's edge, and stacked the Project and the branch on separate lines.
 * Measured side by side the sidebar had seven left edges. One shape keeps the
 * mark in the icon column every navigation row uses, the title in the text
 * column, the facts on one line beneath it, and the status alone at the end.
 *
 * Which facts appear is still each view's own property choice: a caller passes
 * only what its view currently shows, and an absent fact leaves no gap.
 */
export function SidebarThreadRowContent(props: {
  readonly title: string;
  readonly provider?: ThreadProviderIdentity;
  readonly projectName?: string;
  readonly pullRequest?: ThreadRowPullRequest;
  readonly checkout?: ThreadCheckoutChip;
  /** The short age, or the time a snoozed thread returns. */
  readonly age?: { readonly label: string; readonly title?: string };
  readonly status?: ReactNode;
}) {
  const hasFacts =
    props.projectName !== undefined ||
    props.pullRequest !== undefined ||
    props.checkout !== undefined;
  const age =
    props.age === undefined ? null : (
      <span className="sidebar-navigation__thread-age" title={props.age.title}>
        {props.age.label}
      </span>
    );
  return (
    <>
      {props.provider === undefined ? null : (
        <span className="sidebar-navigation__thread-provider" title={props.provider.displayName}>
          <ProviderGlyph
            displayName={props.provider.displayName}
            driverKind={props.provider.driverKind}
            size={14}
          />
        </span>
      )}
      <span className="sidebar-navigation__thread-copy">
        <span className="sidebar-navigation__thread-title">{props.title}</span>
        {hasFacts ? (
          <span className="sidebar-navigation__thread-facts">
            {props.projectName === undefined ? null : (
              <span className="sidebar-navigation__thread-project">
                <Folder aria-hidden="true" size={12} strokeWidth={1.8} />
                <span className="sidebar-navigation__thread-project-label">
                  {props.projectName}
                </span>
              </span>
            )}
            {props.pullRequest === undefined ? null : (
              <span
                aria-label={`Pull request #${String(props.pullRequest.identity.number)} · ${props.pullRequest.state}`}
                className="sidebar-navigation__thread-pr sidebar-navigation__thread-pr-mark"
                data-state={props.pullRequest.state}
                role="img"
                title={`Pull request #${String(props.pullRequest.identity.number)} · ${props.pullRequest.state}`}
              >
                <GitPullRequest aria-hidden="true" size={12} strokeWidth={1.8} />#
                {String(props.pullRequest.identity.number)}
              </span>
            )}
            {props.checkout === undefined ? null : (
              <span className="sidebar-navigation__thread-checkout" title={props.checkout.label}>
                <GitBranch aria-hidden="true" size={12} strokeWidth={1.8} />
                <span className="sidebar-navigation__thread-checkout-label">
                  {props.checkout.label}
                </span>
              </span>
            )}
            {age}
          </span>
        ) : null}
      </span>
      {/* With no facts there is no second line to carry the age, so it keeps
          its place before the status rather than opening a line of its own. */}
      {hasFacts ? null : age}
      {props.status}
    </>
  );
}
