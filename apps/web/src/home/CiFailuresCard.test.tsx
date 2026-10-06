import { decodeCodeProjectPullRequestView, decodeProjectId } from "@octant/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HomeDashboard } from "./HomeDashboard";
import { createCiFailuresCard, type CiFailuresCardSource } from "./CiFailuresCard";

const projectId = decodeProjectId("10000000-0000-4000-8000-000000000001");
const NOW = Date.parse("2026-08-22T08:00:00.000Z");
const EXCERPT = "Expected 2, received 1";

function view() {
  return decodeCodeProjectPullRequestView({
    version: 1,
    query: { version: 1 },
    projects: [
      {
        kind: "connected",
        projectId,
        projectName: "Octant",
        repositoryOwner: "octant",
        repositoryName: "octant",
      },
    ],
    rows: [
      {
        projectId,
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
            excerpt: EXCERPT,
          },
        ],
      },
    ],
    repositoriesTruncated: false,
    pullRequestsTruncated: false,
    freshness: { status: "fresh", lastSuccessfulRefreshAt: "2026-08-22T08:00:00.000Z" },
    generatedAt: "2026-08-22T08:00:00.000Z",
  });
}

function emptyView() {
  const listed = view();
  return { ...listed, rows: [] };
}

function source(overrides: Partial<CiFailuresCardSource> = {}): CiFailuresCardSource {
  return {
    available: true,
    viewerLogin: "ada",
    currentBranches: [],
    load: vi.fn(async () => view()),
    now: NOW,
    onStartFix: vi.fn(),
    ...overrides,
  };
}

describe("the CI failures card", () => {
  it("shows the check, the repository, and how long ago it failed", async () => {
    render(
      <HomeDashboard
        cards={[createCiFailuresCard(source())]}
        customization={{ order: [], visibility: [] }}
        onCustomizationChange={vi.fn()}
      />,
    );
    const card = await screen.findByRole("region", { name: "CI failures" });
    expect(await within(card).findByText("web tests")).toBeInTheDocument();
    expect(within(card).getByText("octant#12")).toBeInTheDocument();
    expect(within(card).getByText("20m ago")).toBeInTheDocument();
    expect(within(card).queryByText("No failing checks")).toBeNull();
  });

  it("opens a draft with the failing check and a bounded excerpt, and sends nothing", async () => {
    const onStartFix = vi.fn();
    const load = vi.fn(async () => view());
    render(
      <HomeDashboard
        cards={[createCiFailuresCard(source({ load, onStartFix }))]}
        customization={{ order: [], visibility: [] }}
        onCustomizationChange={vi.fn()}
      />,
    );
    const card = await screen.findByRole("region", { name: "CI failures" });
    await userEvent.click(
      await within(card).findByRole("button", { name: "Start a fix for web tests on octant#12" }),
    );
    expect(onStartFix).toHaveBeenCalledTimes(1);
    const draft = onStartFix.mock.calls[0]?.[0];
    expect(draft).toEqual(
      expect.objectContaining({
        projectId,
        branch: "feature/list",
      }),
    );
    expect(draft.prompt).toBe(
      [
        "CI is failing on PR #12: List active pull requests",
        "",
        "Check: web tests",
        "Branch: feature/list",
        "Repository: octant/octant",
        "",
        `Failure:\n${EXCERPT}`,
      ].join("\n"),
    );
    expect(load).toHaveBeenCalledTimes(1);
    expect(onStartFix).toHaveBeenCalledTimes(1);
  });

  it("is absent when the read is not allowed, and reads nothing", async () => {
    const load = vi.fn(async () => view());
    render(
      <HomeDashboard
        cards={[createCiFailuresCard(source({ available: false, load }))]}
        customization={{ order: [], visibility: [] }}
        onCustomizationChange={vi.fn()}
      />,
    );
    expect(screen.queryByRole("region", { name: "CI failures" })).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it("hides when nothing is failing instead of showing an empty line", async () => {
    render(
      <HomeDashboard
        cards={[createCiFailuresCard(source({ load: vi.fn(async () => emptyView()) }))]}
        customization={{ order: [], visibility: [] }}
        onCustomizationChange={vi.fn()}
      />,
    );
    await screen.findByRole("region", { name: "Home cards" });
    await waitFor(() => expect(screen.queryByRole("region", { name: "CI failures" })).toBeNull());
    expect(screen.queryByText("Nothing is failing.")).toBeNull();
    expect(screen.queryByText("No failing checks")).toBeNull();
  });
});
