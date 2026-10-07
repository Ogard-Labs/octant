import type { CodeProjectPullRequestRow, GithubAuthenticationSnapshot } from "@octant/contracts";
import { decodeCodeProjectPullRequestView, decodeProjectId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  buildPullRequestCard,
  PULL_REQUEST_CARD_ROW_LIMIT,
  pullRequestCardAvailable,
  pullRequestCardCapability,
  pullRequestCiState,
  pullRequestReviewState,
  sharePullRequestRead,
} from "./pullRequests";

const projectA = decodeProjectId("10000000-0000-4000-8000-000000000001");
const projectB = decodeProjectId("10000000-0000-4000-8000-000000000002");

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
    author: "octocat",
    baseBranch: "development",
    headBranch: "feature/list",
    updatedAt: "2026-08-22T07:00:00.000Z",
    checks: "passing",
    review: "approved",
    linkedThreads: [],
    ...overrides,
  };
}

const readySnapshot: GithubAuthenticationSnapshot = {
  state: "ready",
  account: { login: "ada", gitProtocol: "https", scopes: [] },
  capabilities: [
    { kind: "repository-catalogue", available: true },
    { kind: "issues-read", available: true },
    { kind: "pull-requests-read", available: true },
    { kind: "projects-read", available: true },
  ],
};

describe("pull request card grouping", () => {
  it("puts a review asked of the person ahead of one they authored, and leaves the rest out", () => {
    const card = buildPullRequestCard({
      viewerLogin: "Ada",
      rows: [
        row({ number: 1, author: "ada", title: "Mine", updatedAt: "2026-08-22T06:00:00.000Z" }),
        row({
          number: 2,
          author: "other",
          title: "Please review",
          reviewRequestedFrom: ["ADA"],
          updatedAt: "2026-08-22T05:00:00.000Z",
        }),
        row({ number: 3, author: "other", title: "Someone else" }),
        row({
          number: 4,
          author: "ada",
          title: "Both",
          reviewRequestedFrom: ["ada"],
          updatedAt: "2026-08-22T08:00:00.000Z",
        }),
        row({ number: 5, author: "ada", state: "merged", title: "Already merged" }),
      ],
    });

    expect(card.waiting.map((entry) => entry.title)).toEqual(["Both", "Please review"]);
    expect(card.yours.map((entry) => entry.title)).toEqual(["Mine"]);
    expect(card.total).toBe(3);
    expect(card.shown.map((entry) => entry.number)).toEqual([4, 2, 1]);
  });

  it("names checks and review in words, with a draft ahead of a decision", () => {
    expect(pullRequestCiState("passing")).toBe("passed");
    expect(pullRequestCiState("failing")).toBe("failed");
    expect(pullRequestCiState("pending")).toBe("running");
    expect(pullRequestCiState("unknown")).toBe("none");
    expect(pullRequestReviewState(row({ review: "approved" }))).toBe("approved");
    expect(pullRequestReviewState(row({ review: "changes-requested" }))).toBe("changes requested");
    expect(pullRequestReviewState(row({ review: "pending" }))).toBe("in review");
    expect(pullRequestReviewState(row({ review: "none" }))).toBe("in review");
    expect(pullRequestReviewState(row({ draft: true, review: "approved" }))).toBe("draft");

    const card = buildPullRequestCard({
      viewerLogin: "ada",
      rows: [
        row({
          author: "ada",
          checks: "failing",
          review: "changes-requested",
          repositoryName: "docs",
          number: 9,
        }),
      ],
    });
    expect(card.yours[0]).toMatchObject({
      reference: "docs#9",
      ci: "failed",
      review: "changes requested",
    });
  });

  it("shows at most six rows and counts the rest", () => {
    const rows = Array.from({ length: 8 }, (_, index) =>
      row({
        number: index + 1,
        author: index < 5 ? "other" : "ada",
        title: `Request ${String(index + 1)}`,
        updatedAt: `2026-08-22T0${String(index)}:00:00.000Z`,
        ...(index < 5 ? { reviewRequestedFrom: ["ada"] } : {}),
      }),
    );
    const card = buildPullRequestCard({ viewerLogin: "ada", rows });
    expect(card.shown).toHaveLength(PULL_REQUEST_CARD_ROW_LIMIT);
    expect(card.waiting).toHaveLength(5);
    expect(card.yours).toHaveLength(1);
    expect(card.hidden).toBe(2);
    expect(card.total).toBe(8);
  });
});

describe("pull request card capability", () => {
  it("hides the card without a connection, with insecure storage, or outside Code", () => {
    expect(pullRequestCardCapability(undefined).readable).toBe(false);
    expect(pullRequestCardCapability({ state: "unauthorized", capabilities: [] }).readable).toBe(
      false,
    );
    expect(
      pullRequestCardCapability({ state: "insecure-storage", capabilities: [] }).readable,
    ).toBe(false);
    expect(
      pullRequestCardCapability({
        state: "ready",
        account: { login: "ada", gitProtocol: "https", scopes: [] },
        capabilities: [{ kind: "pull-requests-read", available: false }],
      }).readable,
    ).toBe(false);

    const capability = pullRequestCardCapability(readySnapshot);
    expect(capability).toEqual({ readable: true, login: "ada" });
    expect(pullRequestCardAvailable({ mode: "code", pluginEffective: true, capability })).toBe(
      true,
    );
    expect(pullRequestCardAvailable({ mode: "work", pluginEffective: true, capability })).toBe(
      false,
    );
    expect(pullRequestCardAvailable({ mode: "code", pluginEffective: false, capability })).toBe(
      false,
    );
  });

  it("keeps a row's project so a click can open that project's pull request", () => {
    const card = buildPullRequestCard({
      viewerLogin: "ada",
      rows: [row({ projectId: projectB, author: "ada", repositoryName: "notes", number: 3 })],
    });
    expect(card.yours[0]).toMatchObject({
      projectId: projectB,
      repositoryName: "notes",
      number: 3,
    });
  });
});

describe("the start screen's pull-request read", () => {
  const view = decodeCodeProjectPullRequestView({
    version: 1,
    query: { version: 1 },
    projects: [],
    rows: [],
    repositoriesTruncated: false,
    pullRequestsTruncated: false,
    freshness: { status: "empty" },
    generatedAt: "2026-08-22T08:00:00.000Z",
  });

  it("asks the host once for cards that mount together, and again after that read settles", async () => {
    const read = vi.fn(async () => view);
    const load = sharePullRequestRead(read);
    const [first, second] = await Promise.all([load({ version: 1 }), load({ version: 1 })]);
    expect(first).toBe(view);
    expect(second).toBe(view);
    expect(read).toHaveBeenCalledTimes(1);

    await load({ version: 1 });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("reads again after a refused read instead of repeating the refusal", async () => {
    const read = vi
      .fn<() => Promise<typeof view>>()
      .mockRejectedValueOnce(new Error("refused"))
      .mockResolvedValueOnce(view);
    const load = sharePullRequestRead(read);
    await expect(load({ version: 1 })).rejects.toThrow("refused");
    await expect(load({ version: 1 })).resolves.toBe(view);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
