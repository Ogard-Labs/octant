import { describe, expect, it, vi } from "vitest";
import { RefreshCw } from "../ui/icons";
import { buildOctantCommands, type OctantCommandSources } from "./buildOctantCommands";
import { keybindingActionForCommand } from "./commandKeybinding";
import { filterOctantCommands, type OctantCommand } from "./commandModel";
import { settingsCommandPages } from "../settings/octantSettingsNavigation";

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
      "Show answers only in this thread",
      "Show failures only in this thread",
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

  it("finds a quieter level first for a search for hiding steps", () => {
    const commands = buildOctantCommands(
      sources({
        replyDetail: {
          defaultLevel: "low",
          onSetDefault: vi.fn(),
          thread: { level: "low", override: undefined, onSet: vi.fn() },
        },
      }),
    );
    expect(filterOctantCommands(commands, "hide steps")[0]?.id).toBe("thread:reply-detail:answers");
    expect(
      filterOctantCommands(commands, "hide steps").some((command) =>
        ["thread:reply-detail-cycle", "thread:reply-detail:high"].includes(command.id),
      ),
    ).toBe(false);
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
    ).toEqual([
      "Set the default reply detail to Answers only",
      "Set the default reply detail to Failures only",
      "Set the default reply detail to Medium",
      "Set the default reply detail to High",
    ]);
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

describe("the destination, sidebar and dock commands", () => {
  it("lists pages, Settings pages, the sidebar toggle and dock tools beside threads", () => {
    const onOpen = vi.fn();
    const onOpenDockTool = vi.fn();
    const commands = buildOctantCommands(
      sources({
        destinations: [{ id: "inbox", label: "Inbox", onOpen }],
        settingsPages: [{ sectionId: "appearance", label: "Appearance", onOpen }],
        onToggleSidebar: vi.fn(),
        dockTools: [{ id: "files", label: "Files" }],
        onOpenDockTool,
      }),
    );
    const titles = commands.map((command) => command.title);
    expect(titles).toEqual(
      expect.arrayContaining([
        "Go to Inbox",
        "Settings: Appearance",
        "Show or hide the sidebar",
        "Open Files",
      ]),
    );
    const tool = commands.find((command) => command.id === "dock-tool:files");
    if (tool?.action.kind !== "run") throw new Error("expected a run command");
    tool.action.run();
    expect(onOpenDockTool).toHaveBeenCalledWith({ id: "files", label: "Files" });
    expect(keybindingActionForCommand("workspace:toggle-sidebar")).toBe("toggle-sidebar");
  });

  // Chat, Work, GitHub, Linear, Web search, Device tools and To-dos were
  // Settings pages a person could type into the palette; their settings now
  // sit on another page.
  it("finds a Settings page by the command of a page it took in, typed whole or by name", () => {
    const commands = buildOctantCommands(
      sources({
        settingsPages: settingsCommandPages(() => true).map((page) => ({
          sectionId: page.id,
          label: page.label,
          alsoFoundAs: page.alsoFoundAs,
          onOpen: vi.fn(),
        })),
        onOpenTodos: vi.fn(),
      }),
    );
    const found = (query: string) =>
      filterOctantCommands(commands, query).map((command) => command.title);
    expect(found("settings: github")[0]).toBe("Settings: Integrations");
    expect(found("settings: linear")[0]).toBe("Settings: Integrations");
    expect(found("settings: web search")[0]).toBe("Settings: Integrations");
    expect(found("web search")[0]).toBe("Settings: Integrations");
    expect(found("settings: work")[0]).toBe("Settings: Chat & Work");
    expect(found("settings: chat")[0]).toBe("Settings: Chat & Work");
    expect(found("settings: device tools")[0]).toBe("Settings: Computer use");
    expect(found("settings: to-dos")[0]).toBe("Settings: Data & storage");
    expect(found("github")[0]).toBe("Settings: Integrations");
    expect(found("limits")[0]).toBe("Settings: Limits");
    // The old page's name ranks as a title, so it is not pushed behind every
    // command that merely mentions the word: beside the To-dos page's own
    // command, the Settings page is still among the title matches.
    expect(found("to-dos").slice(0, 2).toSorted()).toEqual([
      "Open To-dos",
      "Settings: Data & storage",
    ]);
  });

  it("offers no Settings page for an integration that is switched off", () => {
    const pages = (...off: ReadonlyArray<string>) =>
      buildOctantCommands(
        sources({
          settingsPages: settingsCommandPages((section) => !off.includes(section)).map((page) => ({
            sectionId: page.id,
            label: page.label,
            alsoFoundAs: page.alsoFoundAs,
            onOpen: vi.fn(),
          })),
        }),
      );
    const found = (commands: ReadonlyArray<OctantCommand>, query: string) =>
      filterOctantCommands(commands, query).map((command) => command.title);
    expect(found(pages("github"), "settings: github")).toEqual([]);
    expect(found(pages("github"), "settings: linear")).toEqual(["Settings: Integrations"]);
    // Web search is the host's own, so Integrations is offered with both off.
    expect(found(pages("github", "linear"), "settings: linear")).toEqual([]);
    expect(found(pages("github", "linear"), "integrations")).toEqual(["Settings: Integrations"]);
  });

  it("offers no dock tool when the host cannot open one", () => {
    const commands = buildOctantCommands(sources({ dockTools: [{ id: "files", label: "Files" }] }));
    expect(commands.some((command) => command.id.startsWith("dock-tool:"))).toBe(false);
  });
});

describe("the focused pane's bar commands", () => {
  it("lists the bar's named commands and runs the exact callbacks its controls close over", () => {
    const onRefresh = vi.fn();
    const onMenuPick = vi.fn();
    const onView = vi.fn();
    const commands = buildOctantCommands(
      sources({
        focusedToolCommands: {
          toolLabel: "Simulator",
          items: [
            {
              kind: "button",
              id: "refresh",
              label: "Refresh device",
              icon: RefreshCw,
              onSelect: onRefresh,
            },
            {
              kind: "menu",
              id: "more",
              label: "Device actions",
              icon: RefreshCw,
              items: [
                { id: "type", label: "Type text" },
                { id: "url", label: "Open URL", disabled: true },
              ],
              onSelect: onMenuPick,
            },
            {
              kind: "choice",
              id: "view",
              label: "Things view",
              options: [
                { id: "a", label: "View A" },
                { id: "b", label: "View B" },
              ],
              value: "a",
              onChange: onView,
            },
            // A state line and a drawn node are not commands.
            { kind: "text", id: "state", text: "Booting" },
            { kind: "node", id: "own", width: 40, node: null },
            {
              kind: "button",
              id: "locked",
              label: "Lock",
              icon: RefreshCw,
              disabled: true,
              onSelect: vi.fn(),
            },
          ],
        },
      }),
    );

    const refresh = commands.find((command) => command.id === "tool-command:refresh");
    if (refresh?.action.kind !== "run") throw new Error("expected a run command");
    refresh.action.run();
    expect(onRefresh).toHaveBeenCalledTimes(1);

    const type = commands.find((command) => command.id === "tool-command:more:type");
    if (type?.action.kind !== "run") throw new Error("expected a run command");
    type.action.run();
    expect(onMenuPick).toHaveBeenCalledWith("type");
    // A disabled menu row reaches nobody.
    expect(commands.some((command) => command.id === "tool-command:more:url")).toBe(false);

    const view = commands.find((command) => command.id === "tool-command:view:b");
    if (view?.action.kind !== "run") throw new Error("expected a run command");
    view.action.run();
    expect(onView).toHaveBeenCalledWith("b");

    // State text, drawn nodes and disabled controls publish nothing.
    expect(commands.some((command) => command.id === "tool-command:state")).toBe(false);
    expect(commands.some((command) => command.id === "tool-command:own")).toBe(false);
    expect(commands.some((command) => command.id === "tool-command:locked")).toBe(false);
    expect(refresh.detail).toBe("Simulator");
    expect(type.detail).toBe("Simulator — Device actions");
  });

  it("offers nothing when the pane in front publishes no bar controls", () => {
    const commands = buildOctantCommands(sources());
    expect(commands.some((command) => command.id.startsWith("tool-command:"))).toBe(false);
  });
});
