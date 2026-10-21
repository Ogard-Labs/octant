import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { decodeProjectId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { DockThreadOverview } from "./DockThreadOverview";
import { runningNowThreads } from "./dockThreadOverviewModel";
import { RIGHT_UTILITY_DOCK_SURFACES } from "./rightUtilityDockModel";
import { RightUtilityDockSurface } from "./RightUtilityDockSurface";

describe("the thread dock overview", () => {
  it("stacks a card per fact group and routes each card's action", async () => {
    const user = userEvent.setup();
    const onOpenRunning = vi.fn();
    const onOpenReview = vi.fn();
    const onOpenEnvironment = vi.fn();
    const running = {
      mode: "code" as const,
      threadId: "thread-b",
      title: "Fix the flaky sync test",
      projectName: "Atlas",
      age: "4m ago",
    };
    render(
      <DockThreadOverview
        changes={{ files: 3, insertions: 120, deletions: 8, onOpenReview }}
        facts={{
          project: "Octant",
          checkout: { branch: "feature/dock-overview", worktree: true },
          host: "This Mac",
          context: { label: "74k of 200k", percent: 37 },
        }}
        modeLabel="Code"
        onOpenEnvironment={onOpenEnvironment}
        onOpenRunning={onOpenRunning}
        pullRequest={{
          identity: {
            projectId: decodeProjectId("10000000-0000-4000-8000-000000000001"),
            repositoryOwner: "octant",
            repositoryName: "octant",
            number: 1524,
          },
          title: "Add an MCP server by hand",
          state: "open",
          checks: "passing",
          review: "pending",
          mergeability: "mergeable",
          freshness: "fresh",
          readyToMerge: false,
        }}
        running={[running]}
        servers={[{ id: "l-1", label: "vite", port: 5377, listening: true }]}
      />,
    );

    const overview = screen.getByRole("region", { name: "Thread overview" });
    expect(
      within(overview)
        .getAllByRole("region")
        .map((card) => card.getAttribute("aria-label")),
    ).toEqual(["Environment", "Local servers", "Context", "Changes", "Running now"]);

    const environment = within(screen.getByRole("region", { name: "Environment" }));
    expect(environment.getByText("Code")).toBeVisible();
    expect(environment.getByText("This Mac")).toBeVisible();
    expect(environment.getByText("Octant")).toBeVisible();
    expect(environment.getByText("feature/dock-overview")).toBeVisible();
    expect(environment.getByText("Worktree")).toBeVisible();
    await user.click(environment.getByRole("button", { name: "Open Environment" }));
    expect(onOpenEnvironment).toHaveBeenCalledOnce();

    const servers = within(screen.getByRole("region", { name: "Local servers" }));
    expect(servers.getByText("vite")).toBeVisible();
    expect(servers.getByText(":5377")).toBeVisible();

    const context = within(screen.getByRole("region", { name: "Context" }));
    expect(context.getByText("37%")).toBeVisible();
    expect(context.getByText("74k of 200k")).toBeVisible();
    expect(context.getByRole("meter", { name: "Context used" })).toHaveAttribute(
      "aria-valuenow",
      "37",
    );

    const changes = within(screen.getByRole("region", { name: "Changes" }));
    expect(changes.getByText("3 files")).toBeVisible();
    expect(changes.getByText("#1524 Add an MCP server by hand")).toBeVisible();
    expect(changes.getByText("Checks pass")).toBeVisible();
    await user.click(changes.getByRole("button", { name: "Open review" }));
    expect(onOpenReview).toHaveBeenCalledOnce();

    const row = screen.getByRole("button", { name: /Fix the flaky sync test/ });
    expect(within(row).getByText("Atlas")).toBeVisible();
    expect(within(row).getByText("4m ago")).toBeVisible();
    await user.click(row);
    expect(onOpenRunning).toHaveBeenCalledWith(running);
  });

  it("leaves out every card the window has no facts for", () => {
    render(
      <DockThreadOverview
        facts={{ project: "Octant" }}
        modeLabel="Work"
        onOpenRunning={vi.fn()}
        running={[]}
      />,
    );

    expect(screen.getByRole("region", { name: "Environment" })).toBeVisible();
    for (const missing of ["Local servers", "Context", "Changes", "Running now"]) {
      expect(screen.queryByRole("region", { name: missing })).toBeNull();
    }
    expect(screen.queryByRole("meter")).toBeNull();
  });

  it("draws nothing for a thread the window knows nothing about", () => {
    const { container } = render(
      <DockThreadOverview facts={{}} modeLabel="Code" onOpenRunning={vi.fn()} running={[]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("leaves the tools to the title band, with every other one under Add tool", async () => {
    const user = userEvent.setup();
    const onOpenTab = vi.fn();
    const surface = (id: string) => {
      const found = RIGHT_UTILITY_DOCK_SURFACES.find((candidate) => candidate.id === id);
      if (found === undefined) throw new Error(`Missing ${id} dock surface.`);
      return found;
    };
    render(
      <RightUtilityDockSurface
        launchableSurfaces={[surface("terminal"), surface("tests")]}
        onCloseTab={vi.fn()}
        onOpenTab={onOpenTab}
        onSelectSurface={vi.fn()}
        overview={
          <DockThreadOverview
            facts={{ project: "Octant" }}
            modeLabel="Code"
            onOpenRunning={vi.fn()}
            running={[]}
          />
        }
        resolution={{ kind: "closed", reason: "no-surface" }}
        tabs={[]}
      />,
    );

    expect(screen.getByRole("region", { name: "Thread overview" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Tools" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Open Terminal" }));
    expect(onOpenTab).toHaveBeenCalledWith("terminal");
  });
});

describe("the running-now list", () => {
  const row = (
    threadId: string,
    activity: "working" | "idle",
    updatedAt: string,
    projectId?: string,
  ) => ({
    threadId,
    title: `Thread ${threadId}`,
    activity,
    updatedAt,
    ...(projectId === undefined ? {} : { projectId }),
  });

  it("lists other working threads from every mode, newest first, and never the one on screen", () => {
    const now = Date.parse("2026-10-01T12:00:00Z");
    const running = runningNowThreads({
      rows: {
        chat: [row("chat-1", "working", "2026-10-01T11:58:00Z")],
        work: [row("work-1", "working", "2026-10-01T11:00:00Z", "p-1"), row("work-2", "idle", "")],
        code: [
          row("code-active", "working", "2026-10-01T11:59:00Z", "p-1"),
          row("code-2", "working", "2026-10-01T11:59:30Z", "p-2"),
        ],
      },
      active: { mode: "code", threadId: "code-active" },
      projectNames: new Map([["p-1", "Atlas"]]),
      now,
    });

    expect(running.map((thread) => `${thread.mode}:${thread.threadId}`)).toEqual([
      "code:code-2",
      "chat:chat-1",
      "work:work-1",
    ]);
    expect(running[2]).toMatchObject({ projectName: "Atlas", age: "1h ago" });
    // A Project the window cannot name is left unnamed, not guessed.
    expect(running[0]).not.toHaveProperty("projectName");
  });
});
