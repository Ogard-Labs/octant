import { decodeProjectId } from "@octant/contracts/projects";
import type { ProjectSummary } from "@octant/contracts/projects";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { OctantHostBridge } from "../shell/hostBridge";
import {
  bindingReceipt,
  credentialHostOperations,
  deferred,
  projectBootstrap,
  projectId,
  projectWindowCapability,
  styles,
} from "../App.test-fixtures";
import { ProjectMemoryInspectorProvider } from "./ProjectMemoryInspector";
import { ProjectOverview } from "./ProjectOverview";

describe("ProjectOverview renderer flows", () => {
  function hostBridge(selectProjectRoot: OctantHostBridge["selectProjectRoot"]): OctantHostBridge {
    return {
      ...credentialHostOperations(),
      close: vi.fn(),
      maximizeOrRestore: vi.fn(),
      minimize: vi.fn(),
      projectWindowCapability,
      resetBounds: vi.fn(),
      selectProjectRoot,
      setSidebarMaterialPreference: vi.fn(),
      subscribeResolvedMaterial: vi.fn(() => () => undefined),
    };
  }

  function codeProject(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
    return { ...projectBootstrap().active[0]!, ...overrides } as ProjectSummary;
  }

  it("shows an unavailable archived binding honestly without mutation actions", () => {
    render(
      <ProjectMemoryInspectorProvider onOpen={vi.fn()}>
        <ProjectOverview
          availability={projectBootstrap().availability[0]!}
          hostBridge={hostBridge(vi.fn())}
          onArchive={vi.fn()}
          onRelink={vi.fn()}
          onRename={vi.fn()}
          project={codeProject({ lifecycle: "archived" })}
        />
      </ProjectMemoryInspectorProvider>,
    );

    expect(screen.getByText(/Archived Project · read-only/i)).toBeVisible();
    expect(screen.getByText("Repository moved.")).toBeVisible();
    expect(screen.queryByText("Available")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review Project memory" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Choose new root" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive Project" })).not.toBeInTheDocument();
  });

  it("uses compact flat workspace controls without dashboard cards or capability claims", () => {
    const project = codeProject();
    if (project.type !== "code") throw new Error("Expected a Code Project.");
    render(
      <ProjectMemoryInspectorProvider onOpen={vi.fn()}>
        <ProjectOverview
          availability={projectBootstrap().availability[0]!}
          hostBridge={hostBridge(vi.fn())}
          onArchive={vi.fn()}
          onRelink={vi.fn()}
          onRename={vi.fn()}
          project={project}
        />
      </ProjectMemoryInspectorProvider>,
    );

    const overview = document.querySelector<HTMLElement>(".project-overview");
    expect(overview).not.toBeNull();
    expect(overview?.querySelector(".project-overview__toolbar")).toBeInTheDocument();
    expect(overview?.querySelector(".project-overview__context")).toBeInTheDocument();
    expect(overview?.querySelector(".project-overview__actions")).toBeInTheDocument();
    expect(overview?.querySelector(".project-binding")).not.toBeInTheDocument();
    expect(overview?.querySelector('[class*="project-memory-summary"]')).not.toBeInTheDocument();
    expect(overview?.querySelector(".project-empty-state")).not.toBeInTheDocument();
    expect(styles).not.toContain(".project-memory-summary");
    expect(styles).not.toMatch(/\.project-(?:binding|memory-summary|empty-state)(?:\W|$)/);

    expect(within(overview!).getByText("Code Project")).toBeVisible();
    expect(within(overview!).getByText(project.binding.canonicalRoot)).toBeVisible();
    expect(within(overview!).getByText("Relink required")).toBeVisible();
    expect(within(overview!).getByText("Repository moved.")).toBeVisible();
    expect(within(overview!).getByRole("button", { name: "Choose new root" })).toBeVisible();
    expect(within(overview!).getByRole("button", { name: "Review Project memory" })).toBeVisible();
    expect(within(overview!).getByRole("button", { name: "Archive Project" })).toBeVisible();
    for (const heading of within(overview!).getAllByRole("heading")) {
      expect(Number(heading.tagName.slice(1))).toBeLessThanOrEqual(2);
    }
    expect(overview).not.toHaveTextContent(/\b(?:threads?|runtimes?)\b/i);
  });

  it("keeps Project rename in a compact labeled control on submit and blur", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn(async () => true);
    render(
      <ProjectOverview
        onArchive={vi.fn()}
        onRelink={vi.fn()}
        onRename={onRename}
        project={codeProject()}
      />,
    );

    const name = screen.getByRole("textbox", { name: "Project name" });
    expect(name).toHaveClass("project-overview__name");
    await user.clear(name);
    await user.type(name, "Compact repository{Enter}");
    expect(onRename).toHaveBeenLastCalledWith(projectId, "Compact repository");

    await user.clear(name);
    await user.type(name, "Blurred repository");
    await user.tab();
    expect(onRename).toHaveBeenLastCalledWith(projectId, "Blurred repository");
    expect(onRename).toHaveBeenCalledTimes(2);
  });

  it("does not relink after cancellation and keeps the Project ID", async () => {
    const user = userEvent.setup();
    const onRelink = vi.fn();
    render(
      <ProjectOverview
        availability={projectBootstrap().availability[0]!}
        hostBridge={hostBridge(vi.fn(async () => ({ kind: "cancelled" as const })))}
        onArchive={vi.fn()}
        onRelink={onRelink}
        onRename={vi.fn()}
        project={codeProject()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Choose new root" }));
    expect(onRelink).not.toHaveBeenCalled();
    expect(screen.getByText("Relink cancelled.")).toBeVisible();
    expect(screen.getByLabelText("Project name")).toHaveAttribute(
      "id",
      `project-name-${projectId}`,
    );
  });

  it("redacts relink picker errors and issues no command", async () => {
    const user = userEvent.setup();
    const onRelink = vi.fn();
    render(
      <ProjectOverview
        availability={projectBootstrap().availability[0]!}
        hostBridge={hostBridge(
          vi.fn(async () => {
            throw new Error("/private/new-root bridge-secret");
          }),
        )}
        onArchive={vi.fn()}
        onRelink={onRelink}
        onRename={vi.fn()}
        project={codeProject()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Choose new root" }));
    expect(screen.getByText("Project root could not be relinked.")).toBeVisible();
    expect(document.body).not.toHaveTextContent("/private/new-root");
    expect(document.body).not.toHaveTextContent("bridge-secret");
    expect(onRelink).not.toHaveBeenCalled();
  });

  it("abandons a pending relink picker when the active Project changes", async () => {
    const user = userEvent.setup();
    const selection = deferred<{
      readonly kind: "selected";
      readonly receiptId: string;
      readonly displayName: string;
    }>();
    const bridge = hostBridge(vi.fn(() => selection.promise));
    const onRelink = vi.fn(async () => true);
    const props = {
      availability: projectBootstrap().availability[0]!,
      hostBridge: bridge,
      onArchive: vi.fn(),
      onRelink,
      onRename: vi.fn(),
    };
    const view = render(<ProjectOverview {...props} project={codeProject()} />);

    await user.click(screen.getByRole("button", { name: "Choose new root" }));
    view.rerender(
      <ProjectOverview
        {...props}
        project={codeProject({
          id: decodeProjectId("00000000-0000-4000-8000-000000000898"),
          name: "Different Project",
        })}
      />,
    );
    await act(async () =>
      selection.resolve({ kind: "selected", receiptId: bindingReceipt, displayName: "Documents" }),
    );

    expect(onRelink).not.toHaveBeenCalled();
    expect(screen.queryByText("Project root relinked.")).not.toBeInTheDocument();
    expect(screen.queryByText("Relink cancelled.")).not.toBeInTheDocument();
  });

  it("lets a dispatched relink finish but suppresses abandoned Project status", async () => {
    const user = userEvent.setup();
    const command = deferred<boolean>();
    const onRelink = vi.fn(() => command.promise);
    const props = {
      availability: projectBootstrap().availability[0]!,
      hostBridge: hostBridge(
        vi.fn(async () => ({
          kind: "selected" as const,
          receiptId: bindingReceipt,
          displayName: "Documents",
        })),
      ),
      onArchive: vi.fn(),
      onRelink,
      onRename: vi.fn(),
    };
    const view = render(<ProjectOverview {...props} project={codeProject()} />);

    await user.click(screen.getByRole("button", { name: "Choose new root" }));
    expect(onRelink).toHaveBeenCalledWith(projectId, bindingReceipt);
    view.rerender(
      <ProjectOverview
        {...props}
        project={codeProject({
          id: decodeProjectId("00000000-0000-4000-8000-000000000897"),
          name: "Different Project",
        })}
      />,
    );
    await act(async () => command.resolve(true));

    expect(onRelink).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Project root relinked.")).not.toBeInTheDocument();
    expect(screen.queryByText("Relink cancelled.")).not.toBeInTheDocument();
  });
});
