import {
  decodeCodeCheckoutHead,
  type CodeCheckoutHead,
  type CodeCheckoutIdentity,
  type CodeThread,
  type CodeThreadId,
} from "@octant/contracts";
import {
  CodeThreadMetadataService,
  MAX_CODE_THREAD_KNOWN_PULL_REQUESTS,
  pullRequestIdentitiesFromHistory,
  type CodeGitWorktreeObservation,
  type CodeGithubMetadataObservation,
  type CodeThreadOperationHistorySource,
} from "../code/codeThreadMetadataService";
import type {
  GhPullRequestSwitchObservation,
  GhPullRequestSwitchRequest,
} from "../code/ghPullRequestSwitchPort";
import type { GitBranchComparisonResult, GitObservationResult } from "../code/gitObservationPort";
import { splitRepositoryName, type PullRequestLinkReader } from "../code/pullRequestLinkService";

/**
 * Live read-only evidence sources used to decide whether a Code thread named
 * in a coordinator's host-checked done-when condition is objectively Done.
 * Kept separate from the board's cached-only metadata projection so local-only
 * board reads never incur live Git or GitHub calls while done-when checks can
 * recognize committed local work and fresh pull request delivery states.
 */
export interface CoordinatorThreadDoneEvidencePorts {
  readonly readThread: (threadId: CodeThreadId) => CodeThread | undefined;
  readonly readCheckout: (checkoutId: CodeThread["checkoutId"]) => CodeCheckoutIdentity | undefined;
  readonly projectExists: (projectId: CodeThread["projectId"]) => boolean;
  readonly resolveCheckoutRoot: (
    thread: CodeThread,
    checkout: CodeCheckoutIdentity,
    signal: AbortSignal,
  ) => Promise<string | undefined>;
  readonly git: {
    readonly observe: (root: string, signal: AbortSignal) => Promise<GitObservationResult>;
    readonly compareBranch: (
      input: {
        readonly checkoutRoot: string;
        readonly baseRef: string;
        readonly headRef: string;
      },
      signal: AbortSignal,
    ) => Promise<GitBranchComparisonResult>;
  };
  readonly history: CodeThreadOperationHistorySource;
  readonly pullRequestLinks: Pick<
    PullRequestLinkReader,
    "listForThread" | "resolveLink" | "areSameRepository"
  >;
  readonly observePullRequest?: (
    request: GhPullRequestSwitchRequest,
    signal: AbortSignal,
  ) => Promise<GhPullRequestSwitchObservation>;
  readonly createSignal: () => AbortSignal;
}

function toCheckoutHead(
  head: Extract<GitObservationResult, { readonly status: "ready" }>["head"],
): CodeCheckoutHead {
  try {
    if (head.kind === "branch") {
      return decodeCodeCheckoutHead({ kind: "branch", name: head.name, oid: head.oid });
    }
    if (head.kind === "detached") {
      return decodeCodeCheckoutHead({ kind: "detached", oid: head.oid });
    }
  } catch {
    return { kind: "none" };
  }
  return { kind: "none" };
}

/**
 * Evaluates whether a Code thread is currently Done: either the person marked
 * it Done (`markedDoneAt`), or fresh read-only evidence objectively satisfies
 * its confirmed delivery target through the shared delivery-target policy.
 */
export function createCoordinatorThreadDoneEvaluator(
  ports: CoordinatorThreadDoneEvidencePorts,
): (thread: CodeThread) => Promise<boolean> {
  const metadata = new CodeThreadMetadataService({
    git: {
      observe: async ({
        threadId,
        checkoutId,
        deliveryTarget,
      }): Promise<CodeGitWorktreeObservation> => {
        if (deliveryTarget.outcomeKind !== "local-implementation") {
          return { status: "unavailable" };
        }
        const thread = ports.readThread(threadId);
        const checkout = ports.readCheckout(checkoutId);
        if (thread === undefined || checkout === undefined || checkout.kind === "remote-root") {
          return { status: "unavailable" };
        }
        const signal = ports.createSignal();
        const checkoutRoot = await ports
          .resolveCheckoutRoot(thread, checkout, signal)
          .catch(() => undefined);
        if (checkoutRoot === undefined) return { status: "unavailable" };
        const observed = await ports.git
          .observe(checkoutRoot, signal)
          .catch(() => ({ status: "unavailable" as const }));
        if (observed.status !== "ready") return { status: "unavailable" };
        let committedAhead = 0;
        if (observed.head.kind !== "unborn") {
          const comparison = await ports.git
            .compareBranch(
              {
                checkoutRoot,
                baseRef: deliveryTarget.proposedBaseBranch,
                headRef: observed.head.kind === "branch" ? observed.head.name : observed.head.oid,
              },
              signal,
            )
            .catch(() => ({ status: "unavailable" as const }));
          if (comparison.status !== "ready") return { status: "unavailable" };
          committedAhead = comparison.ahead;
        }
        return {
          status: "observed",
          path: checkoutRoot,
          head: toCheckoutHead(observed.head),
          ...(checkout.kind === "managed-worktree"
            ? { receiptId: checkout.ownershipReceiptId }
            : {}),
          changedPathCount: observed.changedPaths.length,
          stagedCount: observed.stagedSummary.length,
          committedAhead,
          workingTreeClean: observed.statusEntries.length === 0,
          insertions: observed.insertions,
          deletions: observed.deletions,
        };
      },
    },
    github: {
      observe: async ({ threadId, deliveryTarget }): Promise<CodeGithubMetadataObservation> => {
        if (
          deliveryTarget.outcomeKind !== "opened-pr" &&
          deliveryTarget.outcomeKind !== "merged-pr"
        ) {
          return { status: "unavailable" };
        }
        if (ports.observePullRequest === undefined) return { status: "unavailable" };
        const thread = ports.readThread(threadId);
        const targetRepo = splitRepositoryName(deliveryTarget.proposedBaseRepository);
        const candidates: Array<{
          readonly owner: string;
          readonly name: string;
          readonly number: number;
          readonly url?: string;
        }> = [];
        const seen = new Set<string>();
        const pushCandidate = (candidate: {
          readonly owner: string;
          readonly name: string;
          readonly number: number;
          readonly url?: string;
        }) => {
          const key = `${candidate.owner.toLowerCase()}/${candidate.name.toLowerCase()}#${String(candidate.number)}`;
          if (seen.has(key) || candidates.length >= MAX_CODE_THREAD_KNOWN_PULL_REQUESTS) return;
          seen.add(key);
          candidates.push(candidate);
        };
        // `listForThread` returns links in registry insertion order; sort newest
        // first so a replacement PR opened after a closed PR is checked first.
        const activeLinks = ports.pullRequestLinks
          .listForThread(threadId)
          .filter(
            (link) =>
              link.status === "active" &&
              (thread === undefined || String(link.projectId) === String(thread.projectId)),
          )
          .toSorted(
            (left, right) =>
              right.createdOrder - left.createdOrder || right.linkedAt.localeCompare(left.linkedAt),
          );
        for (const link of activeLinks) {
          pushCandidate({
            owner: link.repositoryOwner,
            name: link.repositoryName,
            number: link.number,
            ...(link.url === undefined ? {} : { url: link.url }),
          });
        }
        // Only fall back to bare historical PR numbers when the thread has no
        // active links carrying full repository identity.
        if (candidates.length === 0 && targetRepo !== undefined) {
          const history = await ports.history.read(threadId);
          for (const historical of pullRequestIdentitiesFromHistory(history)) {
            pushCandidate({
              owner: targetRepo.owner,
              name: targetRepo.name,
              number: historical.number,
            });
          }
        }
        if (candidates.length === 0) {
          return {
            status: "observed",
            freshness: "fresh",
            pullRequest: null,
            checks: "unknown",
            review: "unknown",
          };
        }
        type ObservedPullRequestCandidate = NonNullable<
          Extract<CodeGithubMetadataObservation, { readonly status: "observed" }>["pullRequest"]
        >;
        const stateRank = (state: ObservedPullRequestCandidate["state"]): number =>
          state === "merged" ? 3 : state === "open" ? 2 : 1;
        const matchesDelivery = (pr: ObservedPullRequestCandidate): boolean => {
          const prRepo = splitRepositoryName(pr.baseRepository);
          const sameRepo =
            pr.baseRepository === deliveryTarget.proposedBaseRepository ||
            (thread !== undefined &&
              prRepo !== undefined &&
              targetRepo !== undefined &&
              ports.pullRequestLinks.areSameRepository(thread.projectId, prRepo, targetRepo));
          return (
            sameRepo &&
            pr.baseBranch === deliveryTarget.proposedBaseBranch &&
            pr.headBranch === deliveryTarget.branchIntent
          );
        };
        const satisfiesTarget = (pr: ObservedPullRequestCandidate): boolean => {
          if (!matchesDelivery(pr)) return false;
          return deliveryTarget.outcomeKind === "merged-pr"
            ? pr.state === "merged"
            : pr.state === "merged" || pr.state === "open";
        };
        let best:
          | { readonly pr: ObservedPullRequestCandidate; readonly matches: boolean }
          | undefined;
        let sawUnavailable = false;
        for (const candidate of candidates) {
          const observed = await ports
            .observePullRequest(
              { owner: candidate.owner, name: candidate.name, number: candidate.number },
              ports.createSignal(),
            )
            .catch(() => ({ status: "unavailable" as const }));
          if (observed.status !== "observed") {
            sawUnavailable = true;
            continue;
          }
          const baseRepository = observed.baseRepository ?? `${candidate.owner}/${candidate.name}`;
          const pr: ObservedPullRequestCandidate = {
            number: candidate.number,
            url:
              candidate.url ??
              `https://github.com/${baseRepository}/pull/${String(candidate.number)}`,
            baseRepository,
            baseBranch: observed.baseBranch,
            headBranch: observed.headBranch,
            state: observed.state,
          };
          if (satisfiesTarget(pr)) {
            return {
              status: "observed",
              freshness: "fresh",
              pullRequest: pr,
              checks: "unknown",
              review: "unknown",
            };
          }
          const matches = matchesDelivery(pr);
          if (
            best === undefined ||
            (matches && !best.matches) ||
            (matches === best.matches && stateRank(pr.state) > stateRank(best.pr.state))
          ) {
            best = { pr, matches };
          }
        }
        if (sawUnavailable) return { status: "unavailable" };
        return {
          status: "observed",
          freshness: "fresh",
          pullRequest: best?.pr ?? null,
          checks: "unknown",
          review: "unknown",
        };
      },
    },
    history: ports.history,
    pullRequestLinks: ports.pullRequestLinks,
  });

  return async (thread) => {
    if (thread.markedDoneAt !== undefined) return true;
    if (thread.lifecycle === "archived") return false;
    const projected = await metadata.project([
      {
        thread,
        projectProjectionPresent: ports.projectExists(thread.projectId),
      },
    ]);
    return projected.threads[0]?.deliverySatisfaction === "done";
  };
}
