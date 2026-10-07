import type { CodeProjectPullRequestRow } from "@octant/contracts";
import { decodeProjectId } from "@octant/contracts";
import { decodeCodeCheckoutHead, decodeCodeCheckoutId } from "@octant/contracts/code";
import { describe, expect, it } from "vitest";
import {
  buildCiFailureCard,
  CI_FAILURES_CARD_ROW_LIMIT,
  currentCodeProjectBranches,
} from "./ciFailures";

const projectA = decodeProjectId("10000000-0000-4000-8000-000000000001");
const projectB = decodeProjectId("10000000-0000-4000-8000-000000000002");
const checkoutId = decodeCodeCheckoutId("30000000-0000-4000-8000-000000000001");
const archivedCheckoutId = decodeCodeCheckoutId("30000000-0000-4000-8000-000000000002");

function row(overrides: Partial<CodeProjectPullRequestRow> = {}): CodeProjectPullRequestRow {
  return {
    projectId: projectA,
    projectName: "Octant",
    repositoryOwner: "octant",
    repositoryName: "octant",
    number: 12,
    title: "List active pull requests",
    draft: false,
    state: "open",
    mergeability: "mergeable",
    author: "ada",
    baseBranch: "main",
    headBranch: "feature/list",
    updatedAt: "2026-08-22T07:00:00.000Z",
    checks: "failing",
    review: "pending",
    linkedThreads: [],
    failingChecks: [
      {
        name: "web tests",
        completedAt: "2026-08-22T07:40:00.000Z",
      },
    ],
    ...overrides,
  };
}

describe("rows from recorded failing checks", () => {
  it("lists a failing check on a person's open pull request, with the check, the repository, and when it failed", () => {
    const card = buildCiFailureCard({
      rows: [row()],
      viewerLogin: "ada",
      currentBranches: [],
    });
    expect(card.rows).toEqual([
      expect.objectContaining({
        checkName: "web tests",
        place: "octant#12",
        failedAt: "2026-08-22T07:40:00.000Z",
        branch: "feature/list",
      }),
    ]);
    expect(card.rows[0]?.prompt).toContain("Check: web tests");
    expect(card.rows[0]?.prompt).toContain("Branch: feature/list");
    expect(card.rows[0]?.prompt).toContain("CI is failing on PR #12: List active pull requests");
  });

  it("lists a failing check on a Code Project's current branch even when someone else opened it", () => {
    const card = buildCiFailureCard({
      rows: [row({ author: "other", headBranch: "feature/current" })],
      viewerLogin: "ada",
      currentBranches: [{ projectId: projectA, branch: "feature/current" }],
    });
    expect(card.rows).toEqual([
      expect.objectContaining({
        checkName: "web tests",
        place: "feature/current",
        branch: "feature/current",
      }),
    ]);
  });

  it("leaves out a failing check that is neither the person's pull request nor a current branch", () => {
    const card = buildCiFailureCard({
      rows: [row({ author: "other", headBranch: "feature/elsewhere" })],
      viewerLogin: "ada",
      currentBranches: [{ projectId: projectA, branch: "main" }],
    });
    expect(card.rows).toEqual([]);
  });

  it("leaves out a closed pull request and a passing check", () => {
    const card = buildCiFailureCard({
      rows: [
        row({ state: "closed" }),
        row({ number: 13, checks: "passing", failingChecks: undefined }),
      ],
      viewerLogin: "ada",
      currentBranches: [],
    });
    expect(card.rows).toEqual([]);
  });

  it("keeps the five most recently failed checks and drops the rest", () => {
    const failingChecks = Array.from({ length: CI_FAILURES_CARD_ROW_LIMIT + 2 }, (_, index) => ({
      name: `check ${String(index)}`,
      completedAt: `2026-08-22T0${String(index)}:00:00.000Z`,
    }));
    const card = buildCiFailureCard({
      rows: [row({ failingChecks })],
      viewerLogin: "ada",
      currentBranches: [],
    });
    expect(card.rows).toHaveLength(CI_FAILURES_CARD_ROW_LIMIT);
    expect(card.rows[0]?.checkName).toBe(`check ${String(CI_FAILURES_CARD_ROW_LIMIT + 1)}`);
    expect(card.rows.map((entry) => entry.checkName)).not.toContain("check 0");
  });

  it("does not invent a row when the refresh recorded a failing summary and no check", () => {
    const card = buildCiFailureCard({
      rows: [row({ failingChecks: undefined })],
      viewerLogin: "ada",
      currentBranches: [{ projectId: projectB, branch: "feature/list" }],
    });
    expect(card.rows).toEqual([]);
  });
});

describe("current branches of Code Projects", () => {
  it("keeps the branch of an active thread's available checkout and drops the rest", () => {
    const branches = currentCodeProjectBranches({
      threads: [
        {
          projectId: projectA,
          checkoutId,
          lifecycle: "active",
        },
        {
          projectId: projectB,
          checkoutId: archivedCheckoutId,
          lifecycle: "archived",
        },
      ],
      checkouts: [
        {
          id: checkoutId,
          availability: "available",
          head: decodeCodeCheckoutHead({
            kind: "branch",
            name: "feature/current",
            oid: "a".repeat(40),
          }),
        },
        {
          id: archivedCheckoutId,
          availability: "available",
          head: decodeCodeCheckoutHead({
            kind: "branch",
            name: "feature/old",
            oid: "b".repeat(40),
          }),
        },
      ],
    });
    expect(branches).toEqual([{ projectId: projectA, branch: "feature/current" }]);
  });
});
