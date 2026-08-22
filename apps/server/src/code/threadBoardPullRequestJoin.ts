import type {
  CodeProjectPullRequestFreshness,
  CodeProjectPullRequestRow,
  CodeThreadId,
  ProjectId,
  ThreadBoardPullRequestSummaries,
  WorkPromotionProposalId,
} from "@octant/contracts";
import {
  composeThreadBoardPullRequestSummaries,
  matchPullRequestRowsToCodeThread,
  matchPullRequestRowsToWorkThread,
} from "@octant/domain/thread-board-pull-request-policy";
import type { WorkPromotionEntry } from "../work/workPromotionProjection";

export interface ThreadBoardPullRequestSnapshot {
  readonly rows: ReadonlyArray<CodeProjectPullRequestRow>;
  readonly freshness: CodeProjectPullRequestFreshness;
  readonly githubRevoked: boolean;
}

export function joinCodeThreadBoardPullRequests(input: {
  readonly threadId: CodeThreadId;
  readonly snapshot: ThreadBoardPullRequestSnapshot;
}): ThreadBoardPullRequestSummaries {
  const matches = matchPullRequestRowsToCodeThread({
    threadId: String(input.threadId),
    rows: input.snapshot.rows,
  });
  return composeThreadBoardPullRequestSummaries({
    rows: input.snapshot.rows,
    snapshotFreshness: input.snapshot.freshness,
    githubRevoked: input.snapshot.githubRevoked,
    matches,
  });
}

export function workBoardCodeThreadEvidence(input: {
  readonly workProjectId: ProjectId;
  readonly promotions: ReadonlyMap<WorkPromotionProposalId, WorkPromotionEntry>;
  readonly codeThreads: ReadonlyArray<{ readonly id: CodeThreadId; readonly projectId: ProjectId }>;
}): {
  readonly promotedCodeThreadIds: ReadonlySet<string>;
  readonly linkedCodeThreadIds: ReadonlySet<string>;
} {
  const promotedCodeThreadIds = new Set<string>();
  const targetCodeProjectIds = new Set<string>();
  for (const entry of input.promotions.values()) {
    if (entry.proposal.status !== "approved") continue;
    if (String(entry.proposal.originProjectId) !== String(input.workProjectId)) continue;
    if (entry.linkedCodeThreadId !== undefined) {
      promotedCodeThreadIds.add(String(entry.linkedCodeThreadId));
    }
    targetCodeProjectIds.add(String(entry.proposal.targetCodeProjectId));
  }
  const linkedCodeThreadIds = new Set<string>();
  for (const thread of input.codeThreads) {
    const threadId = String(thread.id);
    if (promotedCodeThreadIds.has(threadId)) continue;
    if (!targetCodeProjectIds.has(String(thread.projectId))) continue;
    linkedCodeThreadIds.add(threadId);
  }
  return { promotedCodeThreadIds, linkedCodeThreadIds };
}

export function joinWorkThreadBoardPullRequests(input: {
  readonly workProjectId: ProjectId;
  readonly promotions: ReadonlyMap<WorkPromotionProposalId, WorkPromotionEntry>;
  readonly codeThreads: ReadonlyArray<{ readonly id: CodeThreadId; readonly projectId: ProjectId }>;
  readonly snapshot: ThreadBoardPullRequestSnapshot;
}): ThreadBoardPullRequestSummaries {
  const evidence = workBoardCodeThreadEvidence({
    workProjectId: input.workProjectId,
    promotions: input.promotions,
    codeThreads: input.codeThreads,
  });
  const matches = matchPullRequestRowsToWorkThread({
    rows: input.snapshot.rows,
    promotedCodeThreadIds: evidence.promotedCodeThreadIds,
    linkedCodeThreadIds: evidence.linkedCodeThreadIds,
  });
  return composeThreadBoardPullRequestSummaries({
    rows: input.snapshot.rows,
    snapshotFreshness: input.snapshot.freshness,
    githubRevoked: input.snapshot.githubRevoked,
    matches,
  });
}
