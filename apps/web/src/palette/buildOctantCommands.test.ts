import { describe, expect, it, vi } from "vitest";
import { buildOctantCommands, type OctantCommandSources } from "./buildOctantCommands";

function sources(overrides: Partial<OctantCommandSources> = {}): OctantCommandSources {
  return {
    activeMode: "code",
    modes: ["chat", "work", "code"],
    onSelectMode: vi.fn(),
    onNewThread: vi.fn(),
    onOpenSearch: vi.fn(),
    onOpenSettings: vi.fn(),
    threads: [],
    onOpenThread: vi.fn(),
    projects: [],
    onOpenProject: vi.fn(),
    profiles: [],
    onSelectProfile: vi.fn(),
    skills: [],
    appleProjects: [],
    onOpenAppleProject: vi.fn(),
    ...overrides,
  };
}

describe("the Apple workbench command", () => {
  it("opens the workbench on the exact project the host listed", () => {
    const onOpenAppleProject = vi.fn();
    const project = { projectPath: "App/Octant.xcodeproj", name: "Octant.xcodeproj" };

    const command = buildOctantCommands(
      sources({ appleProjects: [project], onOpenAppleProject }),
    ).find((candidate) => candidate.title === "Open Apple workbench for Octant.xcodeproj");

    expect(command).toBeDefined();
    expect(command?.group).toBe("Workspace");
    if (command?.action.kind !== "run") throw new Error("expected a run command");
    command.action.run();
    expect(onOpenAppleProject).toHaveBeenCalledWith(project);
  });

  it("offers nothing when the checkout holds no Apple project", () => {
    expect(buildOctantCommands(sources()).some((command) => command.id.startsWith("apple:"))).toBe(
      false,
    );
  });
});
