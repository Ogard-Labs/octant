import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";
import { OctantCommandProvider } from "./CommandRegistry";
import type { OctantCommand } from "./commandModel";

function harness(commands: ReadonlyArray<OctantCommand>) {
  return render(
    <OctantCommandProvider commands={commands}>
      <button type="button">Opener</button>
      <CommandPalette />
    </OctantCommandProvider>,
  );
}

const openChat = vi.fn();
const openSettings = vi.fn();

function hostCommands(): ReadonlyArray<OctantCommand> {
  return [
    {
      id: "mode:chat",
      title: "Switch to Chat",
      group: "Modes",
      action: { kind: "run", run: openChat },
    },
    {
      id: "settings:open",
      title: "Open Settings",
      group: "Settings",
      action: { kind: "run", run: openSettings },
    },
    {
      id: "skill:writing",
      title: "Writing review",
      group: "Skills",
      action: { kind: "address", reference: "$writing" },
    },
  ];
}

/**
 * The chord is platform-dependent, so every test says which platform it means
 * instead of inheriting whatever the test environment happens to report.
 */
function setPlatform(platform: string): void {
  Object.defineProperty(window.navigator, "platform", { value: platform, configurable: true });
}

/**
 * Press the chord and hand back the search field once focus has actually landed
 * in it. The dialog moves focus on a later animation frame, so a test that types
 * as soon as the chord returns can land its keystrokes on `<body>` instead —
 * the query stays empty, the arrow key never reaches the palette, and the row
 * the assertion reads is whichever one happened to start active.
 */
async function openPalette(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.keyboard("{Meta>}k{/Meta}");
  const search = await screen.findByRole("combobox", { name: "Search commands" });
  await waitFor(() => expect(search).toHaveFocus());
  return search;
}

describe("CommandPalette", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPlatform("MacIntel");
  });
  afterEach(() => Reflect.deleteProperty(window.navigator, "platform"));

  it("opens on Cmd+K, searches and runs by keyboard alone, then restores focus", async () => {
    const user = userEvent.setup();
    harness(hostCommands());
    const opener = screen.getByRole("button", { name: "Opener" });
    opener.focus();

    const search = await openPalette(user);

    // An `address` command has no draft to write into here, so the palette must
    // not offer it at all rather than offering a row that would do nothing.
    expect(screen.queryByRole("option", { name: /Writing review/ })).not.toBeInTheDocument();

    await user.keyboard("open");
    const option = screen.getByRole("option", { name: /Open Settings/ });
    expect(option).toHaveAttribute("aria-selected", "true");
    expect(search).toHaveAttribute("aria-activedescendant", option.id);
    expect(screen.getByRole("status")).toHaveTextContent("1 matching command.");

    await user.keyboard("{Enter}");

    expect(openSettings).toHaveBeenCalledOnce();
    expect(screen.queryByRole("combobox", { name: "Search commands" })).not.toBeInTheDocument();
    // Focus goes back on a later frame too, for the same reason it arrived on one.
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("moves the active option with the arrow keys and dismisses with Escape", async () => {
    const user = userEvent.setup();
    harness(hostCommands());
    await openPalette(user);
    await user.keyboard("{ArrowDown}");

    expect(screen.getByRole("option", { name: /Open Settings/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("option", { name: /Switch to Chat/ })).toHaveAttribute(
      "aria-selected",
      "false",
    );

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("combobox", { name: "Search commands" })).not.toBeInTheDocument();
    expect(openChat).not.toHaveBeenCalled();
  });

  it("leaves Ctrl+K to macOS text editing and opens on Ctrl+K everywhere else", async () => {
    const user = userEvent.setup();
    harness(hostCommands());

    // `Ctrl+K` deletes to the end of the line on macOS. The palette must not
    // consume it, and — because the handler cancels what it consumes — must not
    // cancel it either, or every text field in the app loses the command.
    const onApple = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: "k",
    });
    act(() => window.dispatchEvent(onApple));

    expect(screen.queryByRole("combobox", { name: "Search commands" })).not.toBeInTheDocument();
    expect(onApple.defaultPrevented).toBe(false);

    setPlatform("Win32");
    await user.keyboard("{Control>}k{/Control}");

    expect(screen.getByRole("combobox", { name: "Search commands" })).toBeVisible();
  });

  it("answers the user's own chord instead of the default once one is bound", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      "octant.keybindings.v1",
      JSON.stringify({ "command-palette": "Mod+Alt+J" }),
    );
    try {
      harness(hostCommands());

      // The default is no longer the palette's chord, so it must fall through.
      await user.keyboard("{Meta>}k{/Meta}");
      expect(screen.queryByRole("combobox", { name: "Search commands" })).not.toBeInTheDocument();

      await user.keyboard("{Meta>}{Alt>}j{/Alt}{/Meta}");
      expect(screen.getByRole("combobox", { name: "Search commands" })).toBeVisible();
    } finally {
      window.localStorage.removeItem("octant.keybindings.v1");
    }
  });

  it("runs the row it marks active when grouping reorders the ranked results", async () => {
    const user = userEvent.setup();
    const openChatProject = vi.fn();
    const openTeamChatProject = vi.fn();
    const openChatLog = vi.fn();
    const searchChatThreads = vi.fn();
    // Ranked order interleaves the groups: the Project titled "Chat" wins on a
    // title prefix, the two thread rows match on a word start, and the second
    // Project ties with them but was built later. Grouping then lifts that
    // second Project above both thread rows.
    harness([
      {
        id: "project:chat",
        title: "Chat",
        group: "Projects",
        action: { kind: "run", run: openChatProject },
      },
      {
        id: "thread:log",
        title: "Open chat log",
        group: "Threads",
        action: { kind: "run", run: openChatLog },
      },
      {
        id: "thread:search",
        title: "Search chat threads",
        group: "Threads",
        action: { kind: "run", run: searchChatThreads },
      },
      {
        id: "project:team",
        title: "Team chat",
        group: "Projects",
        action: { kind: "run", run: openTeamChatProject },
      },
    ]);

    await openPalette(user);
    await user.keyboard("chat");
    await user.keyboard("{ArrowDown}");

    expect(screen.getByRole("option", { name: /Team chat/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await user.keyboard("{Enter}");

    // The row the palette drew as active is the command it ran.
    expect(openTeamChatProject).toHaveBeenCalledOnce();
    expect(openChatLog).not.toHaveBeenCalled();

    await openPalette(user);
    await user.keyboard("chat");
    await user.hover(screen.getByRole("option", { name: /Open chat log/ }));

    expect(screen.getByRole("option", { name: /Open chat log/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await user.keyboard("{Enter}");

    expect(openChatLog).toHaveBeenCalledOnce();
    expect(searchChatThreads).not.toHaveBeenCalled();
  });

  it("stays inert when this host offers no runnable command", async () => {
    const user = userEvent.setup();
    harness([
      {
        id: "skill:writing",
        title: "Writing review",
        group: "Skills",
        action: { kind: "address", reference: "$writing" },
      },
    ]);

    await user.keyboard("{Meta>}k{/Meta}");

    expect(screen.queryByRole("combobox", { name: "Search commands" })).not.toBeInTheDocument();
  });
});
