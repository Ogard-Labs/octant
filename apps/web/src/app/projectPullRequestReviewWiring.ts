import type {
  CodeClient,
  OwnerUnlockNotGiven,
  PullRequestReviewClient,
} from "@octant/client-runtime";
import type {
  CodeProjectPullRequestMergeMethod,
  CodeProjectPullRequestMergeOutcome,
  CodePullRequestLineNotesSource,
  CodeThreadId,
  ThreadBoardPullRequestIdentity,
} from "@octant/contracts";
import type { CodeLineNotesSendResult } from "../code/CodeLineNotes";

/**
 * The host's optional pull-request review methods, bound so a review view
 * keeps each as a prop only where the host offers it. Shared by the Review
 * dock and a pull request opened in a thread, so both offer the same switches,
 * actions and line notes.
 */
export function projectPullRequestReviewActions(input: {
  readonly codeClient: CodeClient;
  readonly onSendLineNotes: (
    threadId: CodeThreadId,
    message: string,
    source: CodePullRequestLineNotesSource,
  ) => Promise<CodeLineNotesSendResult>;
  readonly pullRequestReviewClient: PullRequestReviewClient | undefined;
}) {
  const { codeClient } = input;
  return {
    ...(codeClient.queryProjectPullRequestSwitches === undefined
      ? {}
      : { loadSwitches: codeClient.queryProjectPullRequestSwitches.bind(codeClient) }),
    ...(codeClient.readProjectPullRequestActionContext === undefined ||
    codeClient.actOnProjectPullRequest === undefined
      ? {}
      : {
          loadActionContext: codeClient.readProjectPullRequestActionContext.bind(codeClient),
          act: codeClient.actOnProjectPullRequest.bind(codeClient),
        }),
    ...(codeClient.setProjectPullRequestMergeWhenReady === undefined
      ? {}
      : { setMergeWhenReady: codeClient.setProjectPullRequestMergeWhenReady.bind(codeClient) }),
    ...(codeClient.setProjectPullRequestAutoFix === undefined
      ? {}
      : { setAutoFix: codeClient.setProjectPullRequestAutoFix.bind(codeClient) }),
    onSendLineNotes: input.onSendLineNotes,
    ...(input.pullRequestReviewClient === undefined
      ? {}
      : { pullRequestReviewClient: input.pullRequestReviewClient }),
  };
}

/**
 * Merge for one pull request, bound to its identity. The Review dock merges
 * the pull request it has selected; a pull request open in a thread must merge
 * that one, whatever the dock shows.
 */
export function mergeProjectPullRequestFor(
  codeClient: CodeClient,
  identity: ThreadBoardPullRequestIdentity,
): (
  method: CodeProjectPullRequestMergeMethod,
  headSha: string,
) => Promise<CodeProjectPullRequestMergeOutcome | OwnerUnlockNotGiven> {
  return (method, headSha) => {
    const merge = codeClient.mergeProjectPullRequest;
    if (merge === undefined || headSha === "") {
      return Promise.resolve({ status: "unavailable", reason: "unavailable" });
    }
    // The Confirm merge click is the person's confirmation of this head and of
    // the required checks; the host verifies both before it merges.
    return merge.call(codeClient, { ...identity, method, headSha, confirmed: true });
  };
}
