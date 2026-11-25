import { decodeWorkspaceTab, type WorkspaceLayoutNode } from "@octant/contracts";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { XtermTerminalAdapter, type XtermAdapterRuntime } from "../code/XtermTerminalAdapter";
import {
  createTerminalCycle,
  listThreadTerminals,
  terminalSlotKey,
  type TerminalPlace,
} from "./terminalCycle";
import { TerminalShellContext, TerminalSlot, type TerminalShellFacts } from "./terminalSlot";

const THREAD = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000b2";

let ids = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;

function pane(name: string, threadId: string, kind: "code-terminal" | "code-overview") {
  return {
    kind: "pane",
    nodeId: uuid(),
    paneId: name,
    surface: decodeWorkspaceTab({ kind, id: uuid(), mode: "code", threadId, title: name }),
  } as unknown as WorkspaceLayoutNode;
}

function split(first: WorkspaceLayoutNode, second: WorkspaceLayoutNode): WorkspaceLayoutNode {
  return {
    kind: "split",
    nodeId: uuid() as never,
    orientation: "vertical",
    ratio: 0.5 as never,
    first,
    second,
  };
}

const keys = (places: ReadonlyArray<TerminalPlace>) =>
  places.map((place) => `${place.threadId === THREAD ? "" : "other "}${place.label}`);

describe("the terminals open for a thread", () => {
  const layout = split(
    split(pane("chat", THREAD, "code-overview"), pane("left", THREAD, "code-terminal")),
    pane("foreign", OTHER, "code-terminal"),
  );
  const dock = {
    threadId: THREAD,
    tabs: [
      { id: "environment", surface: "environment" },
      { id: "terminal", surface: "terminal" },
      { id: "terminal:2", surface: "terminal" },
    ],
    minimised: [],
  };

  it("lists panes in layout order, then the bottom panel, then the dock's sessions", () => {
    expect(keys(listThreadTerminals({ layout, dock, bottomThreadId: THREAD }))).toEqual([
      "pane left",
      "other pane foreign",
      "bottom panel",
      "dock terminal:2",
    ]);
    expect(keys(listThreadTerminals({ layout, dock }))).toEqual([
      "pane left",
      "other pane foreign",
      "dock terminal",
      "dock terminal:2",
    ]);
  });

  it("leaves out the dock's sessions that are standing as a card", () => {
    expect(keys(listThreadTerminals({ dock: { ...dock, minimised: ["terminal"] } }))).toEqual([
      "dock terminal:2",
    ]);
  });

  it("lists nothing for a closed dock and panel", () => {
    expect(listThreadTerminals({})).toEqual([]);
  });
});

/**
 * Panes of a split and a dock whose Terminal tool shows one session at a time,
 * as the shell mounts them, over the facts the shell hands its terminals.
 */
function Workbench(props: {
  readonly layout: WorkspaceLayoutNode;
  readonly dockSessions: ReadonlyArray<string>;
  readonly onShow?: () => void;
}) {
  const [shown, setShown] = useState(props.dockSessions[0]);
  const tabs = props.dockSessions.map((id) => ({ id, surface: "terminal" }));
  const shell = useRef<TerminalShellFacts>(undefined);
  shell.current = {
    layout: props.layout,
    narrow: false,
    dock: { threadId: THREAD, open: true, tabs, minimised: [] },
    bottom: { open: false, tabs: [], shown: undefined },
    activatePane: () => props.onShow?.(),
    selectDockTab: (tabId) => {
      props.onShow?.();
      setShown(tabId);
    },
    openBottomTool: () => props.onShow?.(),
  };
  const places = listThreadTerminals({
    layout: props.layout,
    dock: { threadId: THREAD, tabs, minimised: [] },
  });
  return (
    <TerminalShellContext.Provider value={shell}>
      <textarea aria-label="Composer" />
      {places.map((place) =>
        place.kind === "dock" && place.tabId !== shown ? null : (
          <TerminalSlot key={terminalSlotKey(place)} slot={terminalSlotKey(place)}>
            <XtermTerminalAdapter
              ariaLabel={place.label}
              interactive
              loadRuntime={runtimes}
              onData={() => undefined}
              onResize={() => undefined}
              output=""
            />
          </TerminalSlot>
        ),
      )}
    </TerminalShellContext.Provider>
  );
}

const interceptors = new WeakMap<Element, (event: KeyboardEvent) => boolean>();
/** Stands in for the engine: a caret of its own inside the terminal's element. */
const runtime: XtermAdapterRuntime = {
  mount: (element, options) => {
    const caret = document.createElement("textarea");
    caret.setAttribute("aria-label", `${element.getAttribute("aria-label")} caret`);
    element.append(caret);
    if (options.interceptKey !== undefined) interceptors.set(element, options.interceptKey);
    return {
      dispose: () => caret.remove(),
      focus: () => caret.focus(),
      setInteractive: () => undefined,
      setOutput: () => undefined,
    };
  },
};
const runtimes = vi.fn(async () => runtime);

// The engine loads on first use.
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
const caret = (name: string) => screen.getByRole("textbox", { name: `${name} caret` });

async function press(direction: "ArrowDown" | "ArrowUp"): Promise<void> {
  const terminal = document.activeElement?.closest("section");
  const intercept =
    terminal === null || terminal === undefined ? undefined : interceptors.get(terminal);
  if (intercept === undefined) throw new Error("no terminal holds the keyboard");
  act(() => {
    intercept(
      new KeyboardEvent("keydown", {
        key: direction,
        ctrlKey: true,
        shiftKey: true,
        cancelable: true,
      }),
    );
  });
  await settle();
}

const twoPanes = () =>
  split(
    split(pane("left", THREAD, "code-terminal"), pane("foreign", OTHER, "code-terminal")),
    pane("right", THREAD, "code-terminal"),
  );

describe("cycling between open terminals", () => {
  it("walks this thread's terminals in order, wraps, and leaves the caret in each", async () => {
    render(<Workbench dockSessions={["a", "b"]} layout={twoPanes()} />);
    await settle();
    act(() => caret("pane left").focus());

    await press("ArrowDown");
    expect(caret("pane right")).toHaveFocus();
    await press("ArrowDown");
    expect(caret("dock a")).toHaveFocus();
    // A session behind the shown one comes to the front and takes the caret.
    await press("ArrowDown");
    expect(caret("dock b")).toHaveFocus();
    await press("ArrowDown");
    expect(caret("pane left")).toHaveFocus();
    await press("ArrowUp");
    expect(caret("dock b")).toHaveFocus();
    await press("ArrowUp");
    expect(caret("dock a")).toHaveFocus();
  });

  it("does nothing with one terminal", async () => {
    const onShow = vi.fn();
    const layout = split(
      pane("only", THREAD, "code-terminal"),
      pane("foreign", OTHER, "code-terminal"),
    );
    render(<Workbench dockSessions={[]} layout={layout} onShow={onShow} />);
    await settle();
    act(() => caret("pane only").focus());

    await press("ArrowDown");
    await press("ArrowUp");

    expect(caret("pane only")).toHaveFocus();
    expect(onShow).not.toHaveBeenCalled();
  });

  it("never takes the caret back once the person has gone somewhere else", async () => {
    const cycle = createTerminalCycle(() => ({
      places: listThreadTerminals({
        dock: {
          threadId: THREAD,
          tabs: [
            { id: "a", surface: "terminal" },
            { id: "b", surface: "terminal" },
          ],
          minimised: [],
        },
      }),
      show: () => undefined,
    }));
    const composer = document.createElement("textarea");
    document.body.append(composer);
    try {
      cycle.cycle("dock:a", "next");
      composer.focus();
      const focus = vi.fn();
      cycle.register("dock:b", focus);
      expect(focus).not.toHaveBeenCalled();

      composer.blur();
      cycle.cycle("dock:a", "next");
      fireEvent.pointerDown(composer);
      const later = vi.fn();
      cycle.register("dock:b", later)();
      cycle.register("dock:b", later);
      // The first registration above delivered nothing after the pointer press.
      expect(later).not.toHaveBeenCalled();
    } finally {
      composer.remove();
    }
  });

  it("gives up when the dock turns to another thread before the session attaches", () => {
    let threadId = THREAD;
    const cycle = createTerminalCycle(() => ({
      places: listThreadTerminals({
        dock: {
          threadId,
          tabs: [
            { id: "terminal", surface: "terminal" },
            { id: "terminal:2", surface: "terminal" },
          ],
          minimised: [],
        },
      }),
      show: () => undefined,
    }));
    cycle.cycle("dock:terminal", "next");
    threadId = OTHER;
    const focus = vi.fn();

    cycle.register("dock:terminal:2", focus);

    expect(focus).not.toHaveBeenCalled();
  });

  it("skips a pane whose terminal is not running, so the caret always has somewhere to land", () => {
    const places = listThreadTerminals({
      layout: split(
        split(pane("a", THREAD, "code-terminal"), pane("stopped", THREAD, "code-terminal")),
        pane("c", THREAD, "code-terminal"),
      ),
    });
    const show = vi.fn();
    const cycle = createTerminalCycle(() => ({ places, show }));
    const [first, , third] = places.map(terminalSlotKey);
    const focus = vi.fn();
    cycle.register(first ?? "", () => undefined);
    cycle.register(third ?? "", focus);

    cycle.cycle(first ?? "", "next");

    expect(focus).toHaveBeenCalledOnce();
    expect(show).toHaveBeenCalledWith(places[2]);
  });
});
