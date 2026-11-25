import type { CodeClient } from "@octant/client-runtime/code-client";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";
import {
  client,
  codeShellBootstrap,
  codes,
  projectWindowCapability,
  projects,
  providers,
  windowId,
} from "./App.test-fixtures";

type Intercept = (event: KeyboardEvent) => boolean;
const engine = vi.hoisted(() => ({
  interceptors: new WeakMap<Element, (event: KeyboardEvent) => boolean>(),
}));

// The terminal engine draws on a canvas, so a caret of its own stands in for
// it. Everything above the engine is the shell's own.
vi.mock("./code/xtermRuntime", () => ({
  mount: (element: HTMLElement, options: { readonly interceptKey?: Intercept }) => {
    const caret = document.createElement("textarea");
    caret.setAttribute("aria-label", "Terminal caret");
    element.append(caret);
    if (options.interceptKey !== undefined) {
      engine.interceptors.set(element, options.interceptKey);
    }
    return {
      dispose: () => caret.remove(),
      focus: () => caret.focus(),
      setInteractive: () => undefined,
      setOutput: () => undefined,
    };
  },
}));

/**
 * Cycling terminals rendered through the whole shell: the dock keeps one
 * Terminal session on screen, so moving to another means bringing it forward
 * and waiting for it to attach before the caret can go there.
 */
describe("cycling terminals from the keyboard in the shell", () => {
  function runningShells(): CodeClient {
    return {
      ...codes(),
      executeOperation: vi.fn(async (command) =>
        command.kind === "start-terminal" || command.kind === "attach-terminal"
          ? ({
              kind: "terminal-state",
              operationId: command.operationId,
              terminalId: command.terminalId,
              state: "running",
            } as never)
          : ({ kind: "operation-accepted", operationId: command.operationId } as never),
      ),
    } as CodeClient;
  }

  const shownTerminal = (): HTMLElement =>
    within(screen.getByRole("complementary", { name: "Right Utility Dock" })).getByRole("region", {
      name: "Repository terminal",
    });

  const sessionTab = (name: string): HTMLElement =>
    within(screen.getByRole("tablist", { name: "Terminal sessions" })).getByRole("tab", {
      name,
    });

  function press(key: "ArrowDown" | "ArrowUp"): void {
    const terminal = document.activeElement?.closest("section");
    const intercept = terminal == null ? undefined : engine.interceptors.get(terminal);
    if (intercept === undefined) throw new Error("No terminal holds the keyboard");
    act(() => {
      intercept(
        new KeyboardEvent("keydown", { key, ctrlKey: true, shiftKey: true, cancelable: true }),
      );
    });
  }

  async function caretInShownSession(name: string): Promise<void> {
    await waitFor(() => {
      expect(sessionTab(name)).toHaveAttribute("aria-selected", "true");
      expect(
        within(shownTerminal()).getByRole("textbox", { name: "Terminal caret" }),
      ).toHaveFocus();
    });
  }

  it("brings the next session forward with the caret in it, and wraps back", async () => {
    window.localStorage.clear();
    const user = userEvent.setup();
    render(
      <App
        codeClient={runningShells()}
        isNarrow={false}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={client(codeShellBootstrap())}
      />,
    );
    const [toolRow] = await screen.findAllByRole("toolbar", { name: "Tools" });
    await user.click(within(toolRow!).getByRole("button", { name: "Terminal" }));
    // The terminal pane and its engine are loaded on first use.
    await waitFor(() => expect(shownTerminal()).toBeVisible(), { timeout: 5_000 });
    act(() => within(shownTerminal()).getByRole("textbox", { name: "Terminal caret" }).focus());

    // One terminal: the chord changes nothing.
    press("ArrowDown");
    expect(within(shownTerminal()).getByRole("textbox", { name: "Terminal caret" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "New terminal" }));
    await waitFor(() =>
      expect(
        within(screen.getByRole("tablist", { name: "Terminal sessions" })).getAllByRole("tab"),
      ).toHaveLength(2),
    );
    const [first, second] = within(screen.getByRole("tablist", { name: "Terminal sessions" }))
      .getAllByRole("tab")
      .map((tab) => tab.textContent ?? "");
    await waitFor(() => expect(shownTerminal()).toBeVisible());
    act(() => within(shownTerminal()).getByRole("textbox", { name: "Terminal caret" }).focus());

    press("ArrowDown");
    await caretInShownSession(first!);
    press("ArrowDown");
    await caretInShownSession(second!);
    press("ArrowUp");
    await caretInShownSession(first!);
  });
});
