import type { CodeClient, PullRequestReviewClient } from "@octant/client-runtime";
import {
  DockProjectPullRequestReviewTool,
  type DockProjectPullRequestReviewToolProps,
} from "../shell/DockProjectPullRequestReviewTool";
import {
  mergeProjectPullRequestFor,
  projectPullRequestReviewActions,
} from "./projectPullRequestReviewWiring";

export interface HostPullRequestReviewProps extends Pick<
  DockProjectPullRequestReviewToolProps,
  "layout" | "onMerge" | "onOpenChat" | "onOpenLinkedThread" | "onUnlinkFromThread" | "query"
> {
  readonly codeClient: CodeClient;
  readonly onSendLineNotes: NonNullable<DockProjectPullRequestReviewToolProps["onSendLineNotes"]>;
  readonly pullRequestReviewClient: PullRequestReviewClient | undefined;
}

/**
 * The pull request review over the host's own routes, for the Review dock and
 * for a pull request open as a tab of a thread. The routes are bound here, in
 * the part that loads with the review, rather than by the containers that the
 * window starts with. Without `onMerge`, Merge is bound to this pull request.
 */
export function HostPullRequestReview(props: HostPullRequestReviewProps) {
  const { codeClient, onMerge, onSendLineNotes, pullRequestReviewClient, query, ...view } = props;
  return (
    <DockProjectPullRequestReviewTool
      {...view}
      {...projectPullRequestReviewActions({ codeClient, onSendLineNotes, pullRequestReviewClient })}
      load={(next) => codeClient.queryProjectPullRequestDetail(next)}
      onMerge={onMerge ?? mergeProjectPullRequestFor(codeClient, query)}
      query={query}
      refresh={(command) => codeClient.refreshProjectPullRequestDetail(command)}
    />
  );
}
