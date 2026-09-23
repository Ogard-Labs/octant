import type { ProjectSummary } from "@octant/contracts/projects";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProjectsDirectory } from "./ProjectsDirectory";

describe("ProjectsDirectory", () => {
  it("offers to clear the filters when no Project matches the search", async () => {
    const user = userEvent.setup();
    const project = {
      id: "20000000-0000-4000-8000-000000000001",
      name: "Octant",
      lifecycle: "active",
      pinned: true,
      rank: "0/1",
      version: 1,
      createdAt: "2026-07-21T12:00:00.000Z",
      updatedAt: "2026-07-21T12:00:00.000Z",
      type: "code",
      binding: { canonicalRoot: "/opaque/repository" },
      codeAccessPersistence: "current-session",
    } as unknown as ProjectSummary;

    render(<ProjectsDirectory onOpenProject={vi.fn()} projects={[project]} />);
    const directory = screen.getByRole("navigation", { name: "Projects" });

    await user.type(
      within(directory).getByRole("searchbox", { name: "Search Projects" }),
      "missing",
    );
    expect(within(directory).getByRole("status")).toHaveTextContent("No Projects match this view.");
    await user.click(within(directory).getByRole("button", { name: "Clear filters" }));
    expect(within(directory).getByRole("button", { name: /Octant, Code Project/ })).toBeVisible();
  });
});
