import { describe, expect, it, vi } from "vitest";
import { buildOctantCommands, type OctantCommandSources } from "./buildOctantCommands";
import { keybindingActionForCommand } from "./commandKeybinding";
import type { OctantCommand } from "./commandModel";

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
    skills: [],
    pluginServers: [],
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

describe("the Reply detail commands", () => {
  function run(commands: ReadonlyArray<OctantCommand>, id: string): void {
    const command = commands.find((candidate) => candidate.id === id);
    if (command?.action.kind !== "run") throw new Error(`expected a run command ${id}`);
    command.action.run();
  }

  it("acts on the thread in front: cycles, sets a level, and returns it to the default", () => {
    const onSet = vi.fn();
    const commands = buildOctantCommands(
      sources({
        replyDetail: {
          defaultLevel: "low",
          onSetDefault: vi.fn(),
          thread: { level: "medium", override: "medium", onSet },
        },
      }),
    );
    expect(
      commands
        .filter((command) => command.id.startsWith("thread:reply-detail"))
        .map((command) => command.title),
    ).toEqual([
      "Change reply detail in this thread",
      "Show low reply detail in this thread",
      "Show high reply detail in this thread",
      "Use the default reply detail in this thread",
    ]);
    expect(keybindingActionForCommand("thread:reply-detail-cycle")).toBe("reply-detail-cycle");

    run(commands, "thread:reply-detail-cycle");
    expect(onSet).toHaveBeenLastCalledWith("high");
    run(commands, "thread:reply-detail:low");
    expect(onSet).toHaveBeenLastCalledWith("low");
    run(commands, "thread:reply-detail:default");
    expect(onSet).toHaveBeenLastCalledWith(undefined);
  });

  it("still changes the default, and offers no thread commands when no thread is in front", () => {
    const onSetDefault = vi.fn();
    const commands = buildOctantCommands(
      sources({ replyDetail: { defaultLevel: "low", onSetDefault } }),
    );
    expect(commands.some((command) => command.id.startsWith("thread:reply-detail"))).toBe(false);
    expect(
      commands
        .filter((command) => command.id.startsWith("settings:reply-detail:"))
        .map((command) => command.title),
    ).toEqual(["Set the default reply detail to Medium", "Set the default reply detail to High"]);
    run(commands, "settings:reply-detail:high");
    expect(onSetDefault).toHaveBeenCalledWith("high");
  });

  it("offers none while the window has no settings to change", () => {
    expect(
      buildOctantCommands(sources()).some((command) => command.id.includes("reply-detail")),
    ).toBe(false);
  });
});

describe("the Zen command", () => {
  it("toggles Zen through the same callback the identity menu uses", () => {
    const onOpenZen = vi.fn();
    const command = buildOctantCommands(sources({ onOpenZen })).find(
      (candidate) => candidate.id === "workspace:zen-mode",
    );

    expect(command?.title).toBe("Toggle Zen mode");
    expect(command?.group).toBe("Workspace");
    if (command?.action.kind !== "run") throw new Error("expected a run command");
    command.action.run();
    expect(onOpenZen).toHaveBeenCalledOnce();
  });

  it("offers nothing when this window cannot enter Zen", () => {
    expect(
      buildOctantCommands(sources()).some((command) => command.id === "workspace:zen-mode"),
    ).toBe(false);
  });
});

describe("plugin MCP server commands", () => {
  it("writes the exact plugin component reference into the composer", () => {
    const command = buildOctantCommands(
      sources({
        pluginServers: [
          { reference: "@notes-plugin/mcp-notes", displayName: "notes", pluginName: "Notes" },
        ],
      }),
    ).find((candidate) => candidate.group === "Plugins");

    expect(command).toMatchObject({
      title: "notes",
      detail: "MCP server · Notes",
      action: { kind: "address", reference: "@notes-plugin/mcp-notes" },
    });
  });
});

describe("Project action commands", () => {
  const dev = { actionId: "a1", name: "Dev", command: "bun run dev", projectName: "Octant" };

  it("runs the action the person saved, from the palette", () => {
    const onRunProjectAction = vi.fn();
    const command = buildOctantCommands(
      sources({ projectActions: [dev], onRunProjectAction }),
    ).find((candidate) => candidate.group === "Actions");

    expect(command).toMatchObject({ title: "Dev", detail: "Octant · bun run dev" });
    if (command?.action.kind !== "run") throw new Error("Expected a run action.");
    command.action.run();
    expect(onRunProjectAction).toHaveBeenCalledWith(dev);
  });

  it("offers none where the window has no way to run one", () => {
    expect(
      buildOctantCommands(sources({ projectActions: [dev] })).some(
        (candidate) => candidate.group === "Actions",
      ),
    ).toBe(false);
  });
});

describe("the jump to the next waiting thread command", () => {
  it("runs the jump and shows the chord in effect", () => {
    const onJumpToNextWaiting = vi.fn();
    const command = buildOctantCommands(sources({ onJumpToNextWaiting })).find(
      (candidate) => candidate.id === "thread:next-waiting",
    );

    expect(command?.title).toBe("Jump to the next thread that needs you");
    if (command?.action.kind !== "run") throw new Error("expected a run command");
    command.action.run();
    expect(onJumpToNextWaiting).toHaveBeenCalledTimes(1);
    expect(keybindingActionForCommand("thread:next-waiting")).toBe("next-waiting-thread");
  });

  it("is absent when no thread waits", () => {
    expect(buildOctantCommands(sources()).some((c) => c.id === "thread:next-waiting")).toBe(false);
  });
});
