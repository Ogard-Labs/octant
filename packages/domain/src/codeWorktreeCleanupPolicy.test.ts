import { describe, expect, it } from "vitest";
import {
  MERGED_CLEANUP_GRACE_MS,
  cleanedUpWorktreeSentence,
  worktreeReclaimTrigger,
} from "./codeWorktreeCleanupPolicy";

const now = Date.parse("2026-11-25T12:00:00.000Z");
const daysAgo = (days: number) => now - days * 86_400_000;

describe("worktreeReclaimTrigger", () => {
  it("never qualifies a worktree on a default install", () => {
    expect(worktreeReclaimTrigger({ choices: undefined, lastActivityAt: daysAgo(900), now })).toBe(
      undefined,
    );
    expect(worktreeReclaimTrigger({ choices: {}, lastActivityAt: daysAgo(900), now })).toBe(
      undefined,
    );
  });

  it("qualifies a worktree once the chosen days of inactivity have passed, and not a day sooner", () => {
    const choices = { inactivityDays: 14 };
    expect(worktreeReclaimTrigger({ choices, lastActivityAt: daysAgo(13.9), now })).toBe(undefined);
    expect(worktreeReclaimTrigger({ choices, lastActivityAt: daysAgo(14), now })).toBe(
      "inactivity",
    );
  });

  it("qualifies a merged worktree only after the grace period, so a new thread keeps its folder", () => {
    const choices = { whenMerged: true };
    expect(
      worktreeReclaimTrigger({ choices, lastActivityAt: now - MERGED_CLEANUP_GRACE_MS + 1, now }),
    ).toBe(undefined);
    expect(
      worktreeReclaimTrigger({ choices, lastActivityAt: now - MERGED_CLEANUP_GRACE_MS, now }),
    ).toBe("delivered");
  });

  it("prefers inactivity when both apply, and ignores an unusable day count or a clock that ran backwards", () => {
    expect(
      worktreeReclaimTrigger({
        choices: { whenMerged: true, inactivityDays: 7 },
        lastActivityAt: daysAgo(30),
        now,
      }),
    ).toBe("inactivity");
    for (const inactivityDays of [0, -3, 1.5, Number.NaN]) {
      expect(
        worktreeReclaimTrigger({ choices: { inactivityDays }, lastActivityAt: daysAgo(900), now }),
      ).toBe(undefined);
    }
    expect(
      worktreeReclaimTrigger({
        choices: { inactivityDays: 1 },
        lastActivityAt: now + 86_400_000,
        now,
      }),
    ).toBe(undefined);
  });
});

describe("what a thread says while its worktree is gone", () => {
  it("names the cleanup, says the branch and thread are kept, and says no turn runs until it is restored", () => {
    for (const standing of ["cleaned-up", "cleaning-up", "restoring"] as const) {
      expect(cleanedUpWorktreeSentence(standing), standing).toMatch(/no new turn until/);
    }
    expect(cleanedUpWorktreeSentence("cleaned-up")).toContain("branch and the thread are kept");
  });
});
