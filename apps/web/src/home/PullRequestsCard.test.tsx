import {
  CodeProjectPullRequestView,
  decodeCodeProjectPullRequestView,
  decodeProjectId,
} from "@octant/contracts";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HomeDashboard } from "./HomeDashboard";
import { createPullRequestsCard, type PullRequestsCardSource } from "./PullRequestsCard";

const projectId = decodeProjectId("10000000-0000-4000-8000-000000000001");
const otherProjectId = decodeProjectId("10000000-0000-4000-8000-000000000002");
const NOW = Date.parse("2026-08-22T11:00:00.000Z");

function view(
  overrides: Partial<typeof CodeProjectPullRequestView.Encoded> = {},
): CodeProjectPullRequestView {
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
    ...overrides,
  });
}

function source(overrides: Partial<PullRequestsCardSource> = {}): PullRequestsCardSource {
  return {
    available: true,
    viewerLogin: "ada",
    load: vi.fn(async () => view()),
    now: NOW,
    onOpenRow: vi.fn(),
    onOpenAll: vi.fn(),
    ...overrides,
  };
}

function renderCard(overrides: Partial<PullRequestsCardSource> = {}) {
  render(
    <HomeDashboard
      cards={[createPullRequestsCard(source(overrides))]}
      customization={{ order: [], visibility: [] }}
      onCustomizationChange={vi.fn()}
    />,
  );
  return screen.findByRole("region", { name: "Pull requests" });
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

  it("says nothing is waiting once a refresh found nothing for you", async () => {
    const card = await renderCard({
      load: vi.fn(async () => view({ rows: [] })),
    });
    expect(await within(card).findByText("Nothing is waiting on you.")).toBeInTheDocument();
  });

  it("says it could not read pull requests when the read fails, not that nothing is waiting", async () => {
    const card = await renderCard({
      load: vi.fn(async () => {
        throw new Error("refused");
      }),
    });
    expect(
      await within(card).findByText("Octant could not read pull requests."),
    ).toBeInTheDocument();
    expect(within(card).queryByText("Nothing is waiting on you.")).toBeNull();
  });

  it("says pull requests have not been checked when the snapshot was never refreshed, and offers Pull requests", async () => {
    const onOpenAll = vi.fn();
    const card = await renderCard({
      load: vi.fn(async () => view({ rows: [], freshness: { status: "empty" } })),
      onOpenAll,
    });
    expect(
      await within(card).findByText("Pull requests have not been checked yet."),
    ).toBeInTheDocument();
    expect(within(card).queryByText("Nothing is waiting on you.")).toBeNull();
    await userEvent.click(within(card).getByRole("button", { name: "Open Pull requests" }));
    expect(onOpenAll).toHaveBeenCalledTimes(1);
  });

  it("does not say nothing is waiting while a connected Project was never checked", async () => {
    const card = await renderCard({
      load: vi.fn(async () =>
        view({
          projects: [
            {
              kind: "connected",
              projectId,
              projectName: "Octant",
              repositoryOwner: "octant",
              repositoryName: "octant",
            },
            {
              kind: "connected",
              projectId: otherProjectId,
              projectName: "Docs",
              repositoryOwner: "octant",
              repositoryName: "docs",
            },
          ],
          rows: [],
          projectFreshness: [
            {
              projectId,
              freshness: { status: "empty", lastSuccessfulRefreshAt: "2026-08-22T08:00:00.000Z" },
            },
            { projectId: otherProjectId, freshness: { status: "empty" } },
          ],
        }),
      ),
    });
    expect(
      await within(card).findByText("Some Projects have not been checked yet."),
    ).toBeInTheDocument();
    expect(within(card).queryByText("Nothing is waiting on you.")).toBeNull();
    expect(within(card).getByRole("button", { name: "Open Pull requests" })).toBeInTheDocument();
  });

  it("says how long ago it last looked when the latest refresh failed", async () => {
    const card = await renderCard({
      load: vi.fn(async () =>
        view({
          rows: [],
          freshness: {
            status: "stale",
            staleReason: "rate-limited",
            lastSuccessfulRefreshAt: "2026-08-22T08:00:00.000Z",
          },
        }),
      ),
    });
    expect(
      await within(card).findByText("Nothing was waiting on you when checked 3h ago."),
    ).toBeInTheDocument();
    expect(within(card).queryByText("Nothing is waiting on you.")).toBeNull();
  });

  it("dates the rows it lists when the latest refresh failed", async () => {
    const card = await renderCard({
      load: vi.fn(async () =>
        view({
          freshness: {
            status: "stale",
            staleReason: "timeout",
            lastSuccessfulRefreshAt: "2026-08-22T08:00:00.000Z",
          },
        }),
      ),
    });
    expect(await within(card).findByRole("button", { name: /Please review/ })).toBeInTheDocument();
    expect(within(card).getByText("Last checked 3h ago.")).toBeInTheDocument();
  });
});
