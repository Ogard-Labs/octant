import type { ProjectSummary } from "@octant/contracts/projects";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ChatThreadNavigationItem } from "../shell/navigationModel";
import {
  ProjectThreadsProvider,
  ProjectThreadsSection,
  type ProjectThreadsAccess,
} from "./ProjectThreadsSection";

const projectId = "77777777-7777-4777-8777-777777777777";

const project = {
  id: projectId,
  type: "work",
  name: "Strategy Docs",
  lifecycle: "active",
} as unknown as ProjectSummary;

const threads: ReadonlyArray<ChatThreadNavigationItem> = [
  {
    threadId: "10000000-0000-4000-8000-000000000001",
    title: "Older brief",
    projectId,
    updatedAt: "2026-08-01T09:00:00.000Z",
  },
  {
    threadId: "10000000-0000-4000-8000-000000000002",
    title: "Newest brief",
    projectId,
    updatedAt: "2026-08-14T09:00:00.000Z",
  },
  {
    threadId: "10000000-0000-4000-8000-000000000003",
    title: "Someone else's thread",
    projectId: "88888888-8888-4888-8888-888888888888",
    updatedAt: "2026-08-15T09:00:00.000Z",
  },
];

function renderSection(access: Partial<ProjectThreadsAccess> = {}) {
  const value: ProjectThreadsAccess = {
    onSelectThread: vi.fn(),
    status: "ready",
    threads,
    ...access,
  };
  render(
    <ProjectThreadsProvider value={value}>
      <ProjectThreadsSection project={project} />
    </ProjectThreadsProvider>,
  );
  return value;
}

describe("ProjectThreadsSection", () => {
  it("lists only this Project's threads, most recently updated first", () => {
    renderSection();

    const rows = screen
      .getAllByRole("button")
      .map((button) => button.textContent ?? "")
      .filter((text) => text.includes("brief") || text.includes("thread"));
    expect(rows[0]).toContain("Newest brief");
    expect(rows[1]).toContain("Older brief");
    expect(screen.queryByRole("button", { name: /Someone else's thread/ })).not.toBeInTheDocument();
  });

  it("opens a thread through the same handler the sidebar uses", async () => {
    const user = userEvent.setup();
    const access = renderSection();

    await user.click(screen.getByRole("button", { name: /Newest brief/ }));

    expect(access.onSelectThread).toHaveBeenCalledWith("10000000-0000-4000-8000-000000000002");
  });

  it("says it is still loading rather than reading as an empty Project", () => {
    renderSection({ status: "loading", threads: [] });

    expect(screen.getByRole("status")).toHaveTextContent("Loading threads…");
    expect(screen.queryByText(/No threads in this Project yet/)).not.toBeInTheDocument();
  });

  it("surfaces the host's own words and a retry when threads are unavailable", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    renderSection({
      status: "unavailable",
      threads: [],
      errorMessage: "Work is disconnected.",
      onRetry,
    });

    expect(screen.getByText("Work is disconnected.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /Retry threads/ }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("says the Project is empty only when the host actually answered", () => {
    renderSection({ status: "ready", threads: [] });

    expect(screen.getByText(/No threads in this Project yet/)).toBeVisible();
  });

  it("renders nothing at all on a surface that never published thread navigation", () => {
    render(<ProjectThreadsSection project={project} />);

    expect(
      screen.queryByRole("region", { name: /Threads and recent activity/ }),
    ).not.toBeInTheDocument();
  });
});
