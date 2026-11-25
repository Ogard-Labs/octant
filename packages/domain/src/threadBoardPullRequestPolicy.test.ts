import { decodeProjectId, UtcTimestamp } from "@octant/contracts";
import { decodeCodeThreadId } from "@octant/contracts/code";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  composeThreadBoardPullRequestSummaries,
  composeThreadNavigationPullRequestSummaries,
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
  readonly baseBranch?: string;
  readonly headBranch?: string;
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
    baseBranch: overrides.baseBranch ?? "main",
    headBranch: overrides.headBranch ?? "feature/board",
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

  it("lists up to fifty of a thread's pull requests, in flight first, then merged, then closed", () => {
    const states = ["closed", "merged", "open", "merged", "open"] as const;
    const matches = Array.from({ length: 52 }, (_, index) => ({
      row: row({
        number: index + 1,
        state: states[index % states.length] ?? "open",
        draft: index === 4,
        updatedAt: new Date(Date.UTC(2026, 7, 22, 0, index)).toISOString(),
      }),
    }));
    const summaries = composeThreadNavigationPullRequestSummaries({
      rows: matches.map((match) => match.row),
      snapshotFreshness: {
        status: "fresh",
        lastSuccessfulRefreshAt: decodeTimestamp("2026-08-22T08:00:00.000Z"),
      },
      githubRevoked: false,
      matches,
    });
    expect(summaries.items).toHaveLength(50);
    expect(summaries.hiddenCount).toBe(2);
    const order = summaries.items.map((summary) => summary.state);
    const firstMerged = order.indexOf("merged");
    const firstClosed = order.indexOf("closed");
    expect(
      order.slice(0, firstMerged).every((state) => state === "open" || state === "draft"),
    ).toBe(true);
    expect(order.slice(firstMerged, firstClosed).every((state) => state === "merged")).toBe(true);
    expect(order.slice(firstClosed).every((state) => state === "closed")).toBe(true);
    // Within a group the most recently updated comes first.
    expect(summaries.items[0]?.identity.number).toBe(50);
    expect(summaries.items[1]?.identity.number).toBe(48);
  });

  it("keeps a stack together, bottom first, where its newest layer stands, with true positions", () => {
    const layer = (number: number, headBranch: string, baseBranch: string, hour: number) =>
      row({ number, headBranch, baseBranch, updatedAt: `2026-08-22T0${String(hour)}:00:00Z` });
    const bottom = layer(21, "a", "main", 1);
    const middle = layer(22, "b", "a", 2);
    const top = layer(23, "c", "b", 6);
    const newer = layer(30, "x", "main", 7);
    const older = layer(31, "y", "main", 3);
    const rows = [older, top, bottom, newer, middle];
    const compose = (matched: ReadonlyArray<(typeof rows)[number]>) =>
      composeThreadNavigationPullRequestSummaries({
        rows,
        snapshotFreshness: {
          status: "fresh",
          lastSuccessfulRefreshAt: decodeTimestamp("2026-08-22T08:00:00.000Z"),
        },
        githubRevoked: false,
        matches: matched.map((match) => ({ row: match })),
      }).items.map((summary) => [summary.identity.number, summary.stack]);

    expect(compose(rows)).toEqual([
      [30, undefined],
      [21, { position: 1, size: 3 }],
      [22, { position: 2, size: 3, parent: 21 }],
      [23, { position: 3, size: 3, parent: 22 }],
      [31, undefined],
    ]);
    // A thread that worked on part of the stack still says where its layers stand.
    expect(compose([top, middle])).toEqual([
      [22, { position: 2, size: 3, parent: 21 }],
      [23, { position: 3, size: 3, parent: 22 }],
    ]);
  });

  it("leaves a board card's order and facts as they were when its pull requests are a stack", () => {
    const bottom = row({ number: 21, headBranch: "a", updatedAt: "2026-08-22T01:00:00Z" });
    const top = row({
      number: 22,
      headBranch: "b",
      baseBranch: "a",
      updatedAt: "2026-08-22T02:00:00Z",
    });
    const summaries = composeThreadBoardPullRequestSummaries({
      rows: [bottom, top],
      snapshotFreshness: { status: "stale" },
      githubRevoked: false,
      matches: [{ row: bottom }, { row: top }],
    });
    expect(summaries.items.map((summary) => [summary.identity.number, summary.stack])).toEqual([
      [22, undefined],
      [21, undefined],
    ]);
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

  it("reports a snapshot that cannot reach GitHub as unavailable rather than stale", () => {
    const known = row({ state: "unknown", mergeability: "unknown" });
    const summaries = composeThreadBoardPullRequestSummaries({
      rows: [known],
      snapshotFreshness: { status: "stale", staleReason: "disconnected" },
      githubRevoked: false,
      matches: [{ row: known }],
    });

    expect(summaries.items[0]).toMatchObject({
      freshness: "unavailable",
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

  it("carries line counts, check counts and merging through unchanged, and leaves absent facts absent", () => {
    const summaries = composeThreadBoardPullRequestSummaries({
      rows: [row({})],
      snapshotFreshness: {
        status: "fresh",
        lastSuccessfulRefreshAt: decodeTimestamp("2026-08-22T09:00:00.000Z"),
      },
      githubRevoked: false,
      matches: [
        {
          row: {
            ...row({ number: 1 }),
            additions: 12,
            deletions: 0,
            checkCounts: { passed: 2, total: 5 },
            merging: "queued" as const,
          },
        },
        { row: row({ number: 2, updatedAt: "2026-08-22T07:00:00Z" }) },
      ],
    });
    expect(summaries.items[0]).toMatchObject({
      additions: 12,
      deletions: 0,
      checkCounts: { passed: 2, total: 5 },
      merging: "queued",
    });
    const absent = summaries.items[1] ?? {};
    for (const key of ["additions", "deletions", "checkCounts", "merging"]) {
      expect(key in absent).toBe(false);
    }
  });
});
