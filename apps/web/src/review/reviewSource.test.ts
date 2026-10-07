import { describe, expect, it, vi } from "vitest";
import type { CodeBoardCard } from "@octant/contracts";
import { codeReviewFacts, createReviewSource, type ReviewSourceClients } from "./reviewSource";
import type { ReviewEntry } from "./reviewModel";

const codeEntry: ReviewEntry = {
  mode: "code",
  threadId: "00000000-0000-4000-8000-000000000001",
  title: "Fix the clip",
  projectName: "Octant",
};
const checkoutId = "40000000-0000-4000-8000-000000000001";

function card(overrides: Record<string, unknown> = {}): CodeBoardCard {
  return {
    threadId: codeEntry.threadId,
    checkoutId,
    checks: { freshness: "fresh", state: "failing" },
    lastMeaningfulActivityAt: "2026-10-06T10:00:00.000Z",
    changedFiles: {
      kind: "observed",
      freshness: "fresh",
      changedPathCount: 3,
      stagedCount: 0,
      committedAhead: 2,
      workingTreeClean: false,
      insertions: 12,
      deletions: 4,
    },
    worktree: {
      kind: "available",
      checkoutId,
      path: "/work/octant",
      head: { kind: "branch", name: "feature/clip", oid: "a".repeat(40) },
    },
    linkedPullRequest: {
      kind: "linked",
      freshness: "fresh",
      number: 9,
      url: "https://github.com/octocat/octant/pull/9",
      baseRepository: "octocat/octant",
      baseBranch: "main",
      headBranch: "feature/clip",
      state: "open",
      matchesDeliveryBranch: true,
    },
    ...overrides,
  } as never;
}

describe("review facts", () => {
  it("reads what changed, whether it worked, and where it is headed from the Code board card", () => {
    expect(codeReviewFacts(card())).toEqual({
      check: "failing",
      checkoutId,
      finishedAt: "2026-10-06T10:00:00.000Z",
      changes: { files: 3, insertions: 12, deletions: 4 },
      commits: 2,
      branch: "feature/clip",
      base: "main",
    });
  });

  it("says nothing about a fact the host did not report", () => {
    const facts = codeReviewFacts(
      card({
        checks: { freshness: "stale", state: "unknown" },
        lastMeaningfulActivityAt: null,
        changedFiles: { kind: "unavailable" },
        worktree: { kind: "unavailable", checkoutId },
        linkedPullRequest: { kind: "none", freshness: "fresh" },
      }),
    );

    expect(facts).toEqual({ check: "none", checkoutId });
  });
});

describe("review source", () => {
  function clients(overrides: Partial<ReviewSourceClients> = {}): ReviewSourceClients {
    return {
      code: { queryBoard: vi.fn(async () => ({ cards: [card()] })) } as never,
      work: { queryBoard: vi.fn(async () => ({ cards: [] }) as never) },
      chat: { thread: vi.fn() },
      ...overrides,
    };
  }

  it("reads one board per mode and only for the modes that have a finished thread", async () => {
    const wired = clients();
    const facts = await createReviewSource(wired).loadFacts(
      [codeEntry],
      new AbortController().signal,
    );

    expect(facts.get(`code:${codeEntry.threadId}`)?.check).toBe("failing");
    expect(wired.code.queryBoard).toHaveBeenCalledOnce();
    expect(wired.work.queryBoard).not.toHaveBeenCalled();
  });

  it("dates a Code thread by when its last turn ended, not by the board's activity time", async () => {
    const wired = clients({
      code: {
        // The board's time moves whenever anything touches the thread, including
        // this page reading its diff.
        queryBoard: vi.fn(async () => ({ cards: [card()] })),
        conversation: vi.fn(async () => ({
          turns: [{ updatedAt: "2026-10-06T07:00:00.000Z" }],
          hasMore: false,
          nextCursor: 1,
        })),
      } as never,
    });
    const source = createReviewSource(wired);
    const signal = new AbortController().signal;

    const first = await source.loadFacts([codeEntry], signal);
    const again = await source.loadFacts([codeEntry], signal);

    expect(first.get(`code:${codeEntry.threadId}`)?.finishedAt).toBe("2026-10-06T07:00:00.000Z");
    expect(again.get(`code:${codeEntry.threadId}`)?.finishedAt).toBe("2026-10-06T07:00:00.000Z");
    // A finished thread's turn time does not change, so it is read once.
    expect(wired.code.conversation).toHaveBeenCalledOnce();
  });

  it("keeps the other mode's facts when one board cannot be read", async () => {
    const workEntry: ReviewEntry = { ...codeEntry, mode: "work", threadId: "work-thread" };
    const facts = await createReviewSource(
      clients({
        work: {
          queryBoard: vi.fn(async () => {
            throw new Error("down");
          }),
        },
      }),
    ).loadFacts([codeEntry, workEntry], new AbortController().signal);

    expect(facts.has(`code:${codeEntry.threadId}`)).toBe(true);
    expect(facts.has("work:work-thread")).toBe(false);
  });

  it("reads a Work thread's last reply and the files it wrote", async () => {
    const workEntry: ReviewEntry = {
      ...codeEntry,
      mode: "work",
      threadId: "00000000-0000-4000-8000-000000000002",
    };
    const reply = await createReviewSource(
      clients({
        workTurns: {
          transcript: vi.fn(async () => ({
            turns: [
              { status: "completed", response: "older" },
              {
                status: "completed",
                response: "Wrote the summary.",
                wroteFiles: { paths: ["notes/summary.md"], truncated: false },
              },
            ],
          })) as never,
        },
      }),
    ).loadReply(workEntry, new AbortController().signal);

    expect(reply).toEqual({
      text: "Wrote the summary.",
      outcome: "completed",
      wrotePaths: ["notes/summary.md"],
    });
  });

  it("does not claim a diff for a thread with no checkout", async () => {
    const source = createReviewSource(clients());
    const chatEntry: ReviewEntry = { ...codeEntry, mode: "chat" };

    expect(await source.loadDiff?.(chatEntry, undefined, new AbortController().signal)).toBe(
      undefined,
    );
  });
});
