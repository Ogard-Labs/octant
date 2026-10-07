import { decodeCodeProjectPullRequestView, decodeProjectId } from "@octant/contracts";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HomeDashboard } from "./HomeDashboard";
import { createPullRequestsCard, type PullRequestsCardSource } from "./PullRequestsCard";

const projectId = decodeProjectId("10000000-0000-4000-8000-000000000001");

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
        number: 4,
        title: "Please review",
        draft: false,
        state: "open",
        mergeability: "mergeable",
        author: "other",
        baseBranch: "main",
        headBranch: "feature/review",
        updatedAt: "2026-08-22T08:00:00.000Z",
        checks: "pending",
        review: "pending",
        reviewRequestedFrom: ["ada"],
        linkedThreads: [],
      },
      {
        projectId,
        projectName: "Octant",
        repositoryOwner: "octant",
        repositoryName: "octant",
        number: 9,
        title: "My change",
        draft: true,
        state: "open",
        mergeability: "unknown",
        author: "ada",
        baseBranch: "main",
        headBranch: "feature/mine",
        updatedAt: "2026-08-22T07:00:00.000Z",
        checks: "unknown",
        review: "none",
        linkedThreads: [],
      },
    ],
    repositoriesTruncated: false,
    pullRequestsTruncated: false,
    freshness: { status: "fresh", lastSuccessfulRefreshAt: "2026-08-22T08:00:00.000Z" },
    generatedAt: "2026-08-22T08:00:00.000Z",
  });
}

function source(overrides: Partial<PullRequestsCardSource> = {}): PullRequestsCardSource {
  return {
    available: true,
    viewerLogin: "ada",
    load: vi.fn(async () => view()),
    onOpenRow: vi.fn(),
    onOpenAll: vi.fn(),
    ...overrides,
  };
}

describe("the Pull requests card", () => {
  it("lists a review asked of you and one you opened, in words", async () => {
    const onOpenRow = vi.fn();
    render(
      <HomeDashboard
        cards={[createPullRequestsCard(source({ onOpenRow }))]}
        customization={{ order: [], visibility: [] }}
        onCustomizationChange={vi.fn()}
      />,
    );
    const card = await screen.findByRole("region", { name: "Pull requests" });
    expect(
      await within(card).findByRole("heading", { name: "Waiting on your review" }),
    ).toBeInTheDocument();
    expect(within(card).getByRole("heading", { name: "Yours" })).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: /Please review/ })).toHaveTextContent(
      "running",
    );
    expect(within(card).getByRole("button", { name: /Please review/ })).toHaveTextContent(
      "in review",
    );
    expect(within(card).getByRole("button", { name: /My change/ })).toHaveTextContent("draft");
    expect(within(card).getByRole("button", { name: /My change/ })).toHaveTextContent("none");
    await userEvent.click(within(card).getByRole("button", { name: /Please review/ }));
    expect(onOpenRow).toHaveBeenCalledWith(
      expect.objectContaining({ number: 4, reference: "octant#4" }),
    );
  });

  it("is absent when the read is not allowed, and reads nothing", async () => {
    const load = vi.fn(async () => view());
    render(
      <HomeDashboard
        cards={[createPullRequestsCard(source({ available: false, load }))]}
        customization={{ order: [], visibility: [] }}
        onCustomizationChange={vi.fn()}
      />,
    );
    expect(screen.queryByRole("region", { name: "Pull requests" })).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });
});
