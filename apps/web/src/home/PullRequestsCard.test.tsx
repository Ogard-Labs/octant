import {
  CodeProjectPullRequestView,
  decodeCodeProjectPullRequestView,
  decodeProjectId,
} from "@octant/contracts";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  return render(
    <HomeDashboard
      cards={[createPullRequestsCard(source(overrides))]}
      customization={{ order: [], visibility: [] }}
      onCustomizationChange={vi.fn()}
    />,
  );
}

describe("the Pull requests card", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists a review asked of you under Needs you and one you opened under Your pull requests", async () => {
    const onOpenRow = vi.fn();
    renderCard({ onOpenRow });
    // The sections hold their places while the read is out; the rows replace them.
    const review = await screen.findByRole("button", { name: /Please review/ });
    expect(within(screen.getByRole("region", { name: "Needs you" })).getByText("Running")).toBe(
      within(review).getByText("Running"),
    );
    // Someone else wrote it, so the line names them; the person's own never does.
    expect(review).toHaveTextContent("octant · #4 · other · 3h");
    expect(review).toHaveTextContent("Running");
    const own = within(screen.getByRole("region", { name: "Your pull requests" })).getByRole(
      "button",
      { name: /My change/ },
    );
    expect(own).toHaveTextContent("octant · #9 · 4h");
    expect(own).not.toHaveTextContent("ada");
    expect(within(own).getByRole("img", { name: "Draft" })).toBeInTheDocument();
    await userEvent.click(review);
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
    expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it("says nothing is waiting once a refresh found nothing for you", async () => {
    renderCard({ load: vi.fn(async () => view({ rows: [] })) });
    expect(
      await screen.findByText("Nothing waiting on you. Start a thread above."),
    ).toBeInTheDocument();
  });

  it("says it could not read pull requests when the read fails, not that nothing is waiting", async () => {
    renderCard({
      load: vi.fn(async () => {
        throw new Error("refused");
      }),
    });
    expect(await screen.findByText("Octant could not read pull requests.")).toBeInTheDocument();
    expect(screen.queryByText(/Nothing waiting/)).toBeNull();
  });

  it("says pull requests have not been checked when the snapshot was never refreshed, and offers Pull requests", async () => {
    const onOpenAll = vi.fn();
    renderCard({
      load: vi.fn(async () => view({ rows: [], freshness: { status: "empty" } })),
      onOpenAll,
    });
    expect(await screen.findByText("Pull requests have not been checked yet.")).toBeInTheDocument();
    expect(screen.queryByText(/Nothing waiting/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Open Pull requests" }));
    expect(onOpenAll).toHaveBeenCalledTimes(1);
  });

  it("does not say nothing is waiting while a connected Project was never checked", async () => {
    renderCard({
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
    expect(await screen.findByText("Some Projects have not been checked yet.")).toBeInTheDocument();
    expect(screen.queryByText(/Nothing waiting/)).toBeNull();
    expect(screen.getByRole("button", { name: "Open Pull requests" })).toBeInTheDocument();
  });

  it("says how long ago it last looked when the latest refresh failed", async () => {
    renderCard({
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
      await screen.findByText("Nothing was waiting on you when checked 3h ago."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Nothing waiting/)).toBeNull();
  });

  it("dates the rows it lists when the latest refresh failed", async () => {
    renderCard({
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
    expect(await screen.findByRole("button", { name: /Please review/ })).toBeInTheDocument();
    expect(screen.getByText("Pull requests last checked 3h ago.")).toBeInTheDocument();
  });

  it("ages the last checked line every minute after the card is built", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    renderCard({
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
    expect(await screen.findByText("Pull requests last checked 3h ago.")).toBeInTheDocument();
    // The label appears when the load settles, outside act, so its minute
    // interval is scheduled by an effect that may not have run yet; flush it
    // first, or the hour below passes with nothing listening (seen flaking in
    // CI under load while passing locally).
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 60_000);
    });
    expect(await screen.findByText("Pull requests last checked 4h ago.")).toBeInTheDocument();
  });
});
