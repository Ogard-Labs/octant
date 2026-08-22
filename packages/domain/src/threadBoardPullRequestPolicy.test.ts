import { decodeProjectId, UtcTimestamp } from "@octant/contracts";
import { decodeCodeThreadId } from "@octant/contracts/code";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  composeThreadBoardPullRequestSummaries,
  deriveConservativeReadyToMerge,
  deriveThreadBoardPullRequestState,
  matchPullRequestRowsToCodeThread,
} from "./threadBoardPullRequestPolicy";

const projectId = decodeProjectId("10000000-0000-4000-8000-000000000001");
const threadId = decodeCodeThreadId("20000000-0000-4000-8000-000000000001");
const otherThreadId = decodeCodeThreadId("20000000-0000-4000-8000-000000000002");
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

function row(overrides: {
  readonly number?: number;
  readonly draft?: boolean;
  readonly state?: "unknown" | "open" | "merged" | "closed";
  readonly mergeability?: "mergeable" | "conflicting" | "unknown";
  readonly checks?: "unknown" | "pending" | "passing" | "failing";
  readonly review?: "unknown" | "none" | "pending" | "approved" | "changes-requested";
  readonly linkedThreadIds?: ReadonlyArray<string>;
  readonly updatedAt?: string;
}) {
  return {
    projectId,
    projectName: "Code Project",
    repositoryOwner: "octant",
    repositoryName: "octant",
    number: overrides.number ?? 12,
    title: "Board pull request",
    draft: overrides.draft ?? false,
    state: overrides.state ?? "open",
    mergeability: overrides.mergeability ?? "mergeable",
    author: "octocat",
    baseBranch: "main",
    headBranch: "feature/board",
    updatedAt: overrides.updatedAt ?? "2026-08-22T08:00:00Z",
    checks: overrides.checks ?? "passing",
    review: overrides.review ?? "approved",
    linkedThreads: (overrides.linkedThreadIds ?? [String(threadId)]).map((id) => ({
      threadId: decodeCodeThreadId(id),
      title: "Linked thread",
    })),
  };
}

describe("thread board pull-request policy", () => {
  it("derives draft, open, merged, and closed states from the pull-request row", () => {
    expect(deriveThreadBoardPullRequestState({ state: "open", draft: true })).toBe("draft");
    expect(deriveThreadBoardPullRequestState({ state: "open", draft: false })).toBe("open");
    expect(deriveThreadBoardPullRequestState({ state: "merged", draft: false })).toBe("merged");
    expect(deriveThreadBoardPullRequestState({ state: "closed", draft: false })).toBe("closed");
    expect(deriveThreadBoardPullRequestState({ state: "unknown", draft: false })).toBe("unknown");
  });

  it("requires complete fresh evidence before reporting ready to merge", () => {
    expect(
      deriveConservativeReadyToMerge({
        state: "open",
        checks: "passing",
        review: "approved",
        mergeability: "mergeable",
        freshness: "fresh",
      }),
    ).toBe(true);
    expect(
      deriveConservativeReadyToMerge({
        state: "draft",
        checks: "passing",
        review: "approved",
        mergeability: "mergeable",
        freshness: "fresh",
      }),
    ).toBe(false);
    expect(
      deriveConservativeReadyToMerge({
        state: "open",
        checks: "pending",
        review: "approved",
        mergeability: "mergeable",
        freshness: "fresh",
      }),
    ).toBe(false);
    expect(
      deriveConservativeReadyToMerge({
        state: "open",
        checks: "passing",
        review: "approved",
        mergeability: "mergeable",
        freshness: "stale",
      }),
    ).toBe(false);
    expect(
      deriveConservativeReadyToMerge({
        state: "open",
        checks: "passing",
        review: "approved",
        mergeability: "conflicting",
        freshness: "fresh",
      }),
    ).toBe(false);
    expect(
      deriveConservativeReadyToMerge({
        state: "open",
        checks: "passing",
        review: "approved",
        mergeability: "unknown",
        freshness: "fresh",
      }),
    ).toBe(false);
  });

  it("matches project pull-request rows to a Code thread by linked-thread evidence", () => {
    const matches = matchPullRequestRowsToCodeThread({
      threadId: String(threadId),
      rows: [
        row({ number: 12, linkedThreadIds: [String(threadId)] }),
        row({ number: 13, linkedThreadIds: [String(otherThreadId)] }),
      ],
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.row.number).toBe(12);
  });

  it("bounds board summaries and reports hidden overflow", () => {
    const matches = Array.from({ length: 5 }, (_, index) => ({
      row: row({
        number: index + 1,
        updatedAt: `2026-08-22T0${index}:00:00Z`,
      }),
    }));
    const summaries = composeThreadBoardPullRequestSummaries({
      rows: matches.map((match) => match.row),
      snapshotFreshness: {
        status: "fresh",
        lastSuccessfulRefreshAt: decodeTimestamp("2026-08-22T08:00:00.000Z"),
      },
      githubRevoked: false,
      matches,
    });
    expect(summaries.items).toHaveLength(3);
    expect(summaries.hiddenCount).toBe(2);
    expect(summaries.items[0]?.readyToMerge).toBe(true);
  });

  it("preserves a restart-recovered identity as unknown and stale", () => {
    const unknown = row({ state: "unknown", mergeability: "unknown" });
    const summaries = composeThreadBoardPullRequestSummaries({
      rows: [unknown],
      snapshotFreshness: { status: "stale" },
      githubRevoked: false,
      matches: [{ row: unknown }],
    });

    expect(summaries.items[0]).toMatchObject({
      state: "unknown",
      freshness: "stale",
      mergeability: "unknown",
      readyToMerge: false,
    });
  });

  it("drops private pull-request evidence when GitHub is revoked", () => {
    const summaries = composeThreadBoardPullRequestSummaries({
      rows: [row({})],
      snapshotFreshness: { status: "stale", staleReason: "disconnected" },
      githubRevoked: true,
      matches: [{ row: row({}) }],
    });
    expect(summaries).toEqual({ items: [], hiddenCount: 0 });
  });
});
