import type { ProjectSummary } from "@octant/contracts/projects";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProjectIconContext, createProjectIconSource } from "./ProjectIcon";
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
    expect(within(directory).getByRole("status")).toHaveTextContent("No Projects match this view");
    await user.click(within(directory).getByRole("button", { name: "Clear filters" }));
    expect(within(directory).getByRole("button", { name: /Octant, Code Project/ })).toBeVisible();
  });

  it("leaves the page through the same Back to workspace control as the other destinations", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    render(<ProjectsDirectory onBack={onBack} onOpenProject={vi.fn()} projects={[]} />);

    await user.click(screen.getByRole("button", { name: "Back to workspace" }));
    expect(onBack).toHaveBeenCalledOnce();
  });
});

describe("ProjectsDirectory icons", () => {
  const withIcon = {
    id: "20000000-0000-4000-8000-000000000002",
    name: "Harbor",
    lifecycle: "active",
    pinned: false,
    rank: "0/2",
    version: 1,
    createdAt: "2026-07-21T12:00:00.000Z",
    updatedAt: "2026-07-21T12:00:00.000Z",
    type: "code",
    binding: { canonicalRoot: "/opaque/harbor" },
    codeAccessPersistence: "current-session",
  } as unknown as ProjectSummary;
  const without = {
    ...withIcon,
    id: "20000000-0000-4000-8000-000000000003",
    name: "Plain",
  } as unknown as ProjectSummary;

  it("shows a Project's own icon when the host has one and the folder glyph when it does not", async () => {
    URL.createObjectURL = vi.fn(() => "blob:harbor-icon");
    const fetcher = vi.fn(async (input: URL | RequestInfo) => {
      const hasIcon = String(input).includes(String(withIcon.id));
      return {
        ok: hasIcon,
        blob: async () => new Blob(["<svg/>"], { type: "image/svg+xml" }),
      };
    }) as unknown as typeof fetch;
    const source = createProjectIconSource({
      serverUrl: "http://127.0.0.1:1/",
      windowCapability: "capability",
      fetcher,
    });

    const { container } = render(
      <ProjectIconContext.Provider value={source}>
        <ProjectsDirectory onOpenProject={vi.fn()} projects={[withIcon, without]} />
      </ProjectIconContext.Provider>,
    );

    await waitFor(() => expect(container.querySelectorAll("img.project-icon")).toHaveLength(1));
    expect(container.querySelector("img.project-icon")).toHaveAttribute("src", "blob:harbor-icon");
    expect(container.querySelectorAll("svg.lucide-folder")).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
