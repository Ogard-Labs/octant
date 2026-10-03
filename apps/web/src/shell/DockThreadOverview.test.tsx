import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DockThreadOverview } from "./DockThreadOverview";
import { runningNowThreads } from "./dockThreadOverviewModel";
import { RIGHT_UTILITY_DOCK_SURFACES } from "./rightUtilityDockModel";
import { RightUtilityDockSurface } from "./RightUtilityDockSurface";

describe("the thread dock overview", () => {
  it("shows what is running, what this thread is, and its changes, and routes both actions", async () => {
    const user = userEvent.setup();
    const onOpenRunning = vi.fn();
    const onOpenReview = vi.fn();
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
          model: "Opus",
          access: "Ask for approvals",
          context: { label: "74k of 200k", percent: 37 },
        }}
        onOpenRunning={onOpenRunning}
        running={[running]}
      />,
    );

    const runningNow = screen.getByRole("region", { name: "Thread overview" });
    const sections = within(runningNow).getAllByRole("heading", { level: 2 });
    expect(sections.map((heading) => heading.textContent)).toEqual(["Running now", "This thread"]);

    const row = screen.getByRole("button", { name: /Fix the flaky sync test/ });
    expect(within(row).getByText("Atlas")).toBeVisible();
    expect(within(row).getByText("4m ago")).toBeVisible();
    await user.click(row);
    expect(onOpenRunning).toHaveBeenCalledWith(running);

    const facts = within(screen.getByRole("region", { name: "Thread overview" }));
    // The card names the Project, then the branch, and where it runs.
    expect(facts.getByText("Octant")).toBeVisible();
    expect(facts.getByText("feature/dock-overview")).toBeVisible();
    expect(facts.getByText("Worktree")).toBeVisible();
    expect(facts.getByText("This Mac")).toBeVisible();
    expect(facts.getByText("Opus")).toBeVisible();
    expect(facts.getByText("Ask for approvals")).toBeVisible();
    expect(facts.getByText("37%")).toBeVisible();
    expect(facts.getByText("74k of 200k")).toBeVisible();
    expect(facts.getByRole("meter", { name: "Context used" })).toHaveAttribute(
      "aria-valuenow",
      "37",
    );
    expect(facts.getByText("3 files")).toBeVisible();
    expect(facts.getByText("+120")).toBeVisible();
    expect(facts.getByText("−8")).toBeVisible();

    // The Changes box is the way into Review, and still announces what it shows.
    const review = screen.getByRole("button", { name: "Open review" });
    expect(review).toHaveAccessibleDescription("+120 −8");
    await user.click(review);
    expect(onOpenReview).toHaveBeenCalledOnce();
  });

  it("leaves out every section and row the window has no facts for", () => {
    render(
      <DockThreadOverview
        facts={{ project: "Octant", model: "Opus" }}
        onOpenRunning={vi.fn()}
        running={[]}
      />,
    );

    expect(screen.getByText("This thread")).toBeVisible();
    expect(screen.queryByText("Running now")).toBeNull();
    expect(screen.queryByText("Changes")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open review" })).toBeNull();
    for (const missing of ["Checkout", "Access", "Context"]) {
      expect(screen.queryByText(missing)).toBeNull();
    }
    expect(screen.queryByRole("meter")).toBeNull();
  });

  it("draws nothing for a thread the window knows nothing about", () => {
    const { container } = render(
      <DockThreadOverview facts={{}} onOpenRunning={vi.fn()} running={[]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("sits above the tool launcher so every tool stays one click away", async () => {
    const user = userEvent.setup();
    const onOpenTab = vi.fn();
    const terminal = RIGHT_UTILITY_DOCK_SURFACES.find((surface) => surface.id === "terminal");
    if (terminal === undefined) throw new Error("Missing terminal dock surface.");
    render(
      <RightUtilityDockSurface
        launchableSurfaces={[terminal]}
        onCloseTab={vi.fn()}
        onOpenTab={onOpenTab}
        onSelectSurface={vi.fn()}
        overview={
          <DockThreadOverview facts={{ project: "Octant" }} onOpenRunning={vi.fn()} running={[]} />
        }
        resolution={{ kind: "closed", reason: "no-surface" }}
        tabs={[]}
      />,
    );

    const overview = screen.getByRole("region", { name: "Thread overview" });
    const tools = screen.getByRole("heading", { name: "Tools" });
    expect(overview.compareDocumentPosition(tools) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Terminal" }));
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
