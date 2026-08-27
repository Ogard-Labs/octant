import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { ZenAssistantSnapshot, ZenElementPayload, ZenSpace } from "@octant/contracts/zen";
import {
  DEFAULT_ZEN_APPEARANCE,
  DEFAULT_ZEN_VIEWPORT,
  type ZenElementId,
  type ZenSpaceId,
} from "@octant/contracts/zen";
import type { AggregateVersion } from "@octant/contracts/events";
import { decodeWindowId } from "@octant/contracts/shell";
import type { NavigatorAssistantController } from "../navigator/useNavigatorAssistant";
import { ZenSurface } from "./ZenSurface";

const windowId = decodeWindowId("00000000-0000-4000-8000-000000000911");
const spaceId = "00000000-0000-4000-8000-000000000912" as ZenSpaceId;
const elementId = "00000000-0000-4000-8000-000000000913" as ZenElementId;

/** Zen's own assistant facts for a surface whose provider supports Zen actions. */
const ASSISTANT_SNAPSHOT: ZenAssistantSnapshot = {
  status: "ready",
  binding: {
    threadId: "00000000-0000-4000-8000-000000000914" as never,
    providerId: "00000000-0000-4000-8000-000000000915",
    modelId: "model-local",
  },
  provider: {
    providerInstanceId: "00000000-0000-4000-8000-000000000915" as never,
    providerLabel: "Local provider",
    modelId: "model-local" as never,
    modelLabel: "Local model",
    readiness: "ready",
    toolCapability: "supported",
  },
  transcript: [],
  manualControls: ["threads", "widgets", "add", "placement", "appearance"],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeSpace(elements: ZenElementPayload[] = []): ZenSpace {
  return {
    spaceId,
    windowId,
    version: 1 as AggregateVersion,
    elements,
    viewport: DEFAULT_ZEN_VIEWPORT,
    appearance: DEFAULT_ZEN_APPEARANCE,
    active: false,
    barCollapsed: false,
    assistant: null,
    research: null,
    createdAt: "2026-07-26T12:00:00.000Z" as ZenSpace["createdAt"],
    updatedAt: "2026-07-26T12:00:00.000Z" as ZenSpace["updatedAt"],
  };
}

describe("ZenSurface", () => {
  it("keeps the docked research browser out of the transformed canvas", () => {
    // The docked page is a native view the host places by absolute window
    // bounds. Inside the canvas it would be positioned by however far the
    // canvas last panned and zoomed, so the dock is a sibling of the canvas,
    // not a card on it.
    const base = makeSpace();
    const space = {
      ...base,
      research: {
        sourceContext: {
          hostId: "local",
          mode: "work" as const,
          projectId: null,
          threadKind: "work" as const,
          threadId: "10000000-0000-4000-8000-000000000001",
        },
        width: 480,
        collapsed: false,
      },
    } as ZenSpace;

    const { container } = render(
      <ZenSurface
        barCollapsed={false}
        onExit={() => undefined}
        onExpandBar={() => undefined}
        onHideBar={() => undefined}
        onUpdateElement={() => undefined}
        onUpdateViewport={() => undefined}
        renderResearchDock={() => <aside data-testid="research-dock" />}
        space={space}
      />,
    );

    const docked = container.querySelector("[data-testid='research-dock']");
    expect(docked).not.toBeNull();
    expect(docked?.closest(".zen-surface__canvas")).toBeNull();
  });

  it("renders a capability-fetched object URL and retains a safe fallback for unavailable media", () => {
    const base = makeSpace();
    const space = {
      ...base,
      appearance: {
        ...base.appearance,
        background: {
          kind: "image" as const,
          assetId: "00000000-0000-4000-8000-000000000914" as never,
          overlay: 40,
          fill: "cover" as const,
        },
      },
    };
    const { rerender } = render(
      <ZenSurface
        backgroundImageUrl="blob:octant-safe-background"
        backgroundStatus="ready"
        barCollapsed={false}
        onExit={() => undefined}
        onExpandBar={() => undefined}
        onHideBar={() => undefined}
        onUpdateElement={() => undefined}
        onUpdateViewport={() => undefined}
        space={space}
      />,
    );
    expect(screen.getByRole("application", { name: "Zen workspace" })).toHaveStyle({
      backgroundImage: 'url("blob:octant-safe-background")',
    });

    rerender(
      <ZenSurface
        backgroundStatus="unavailable"
        barCollapsed={false}
        onExit={() => undefined}
        onExpandBar={() => undefined}
        onHideBar={() => undefined}
        onUpdateElement={() => undefined}
        onUpdateViewport={() => undefined}
        space={space}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(/safe default/i);
    const surface = screen.getByRole("application", { name: "Zen workspace" });
    // The safe default is the theme's own workspace ground with the system
    // dot grid, not a colour of Zen's own — and never the unreadable image.
    expect(surface).toHaveStyle({ backgroundColor: "var(--oct-bg)" });
    expect(surface.querySelector(".zen-ground")).not.toBeNull();
  });

  it("renders a first-party built-in still with overlay and fill", () => {
    const space = {
      ...makeSpace(),
      appearance: {
        ...DEFAULT_ZEN_APPEARANCE,
        background: {
          kind: "builtin" as const,
          presetId: "nordic-fjord-aurora" as const,
          overlay: 40,
          fill: "contain" as const,
        },
      },
    };
    render(
      <ZenSurface
        barCollapsed={false}
        onExit={() => undefined}
        onExpandBar={() => undefined}
        onHideBar={() => undefined}
        onUpdateElement={() => undefined}
        onUpdateViewport={() => undefined}
        space={space}
      />,
    );
    const surface = screen.getByRole("application", { name: "Zen workspace" });
    expect(surface).toHaveStyle({
      backgroundImage: 'url("/zen-backgrounds/nordic-fjord-aurora.jpg")',
      backgroundSize: "contain",
    });
    expect(surface.querySelector(".zen-surface__overlay")).not.toBeNull();
  });

  it("lets the appearance panel choose a built-in, a custom gradient, and a local image", async () => {
    const user = userEvent.setup();
    const onUpdateAppearance = vi.fn();
    const onUploadBackground = vi.fn();
    render(
      <ZenSurface
        barCollapsed={false}
        onExit={() => undefined}
        onExpandBar={() => undefined}
        onHideBar={() => undefined}
        onUpdateAppearance={onUpdateAppearance}
        onUploadBackground={onUploadBackground}
        onUpdateElement={() => undefined}
        onUpdateViewport={() => undefined}
        space={makeSpace()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    fireEvent.click(screen.getByRole("button", { name: "Nordic fjord" }));
    expect(onUpdateAppearance).toHaveBeenCalledWith({
      dimming: 0,
      elementOpacity: 1,
      background: {
        kind: "builtin",
        presetId: "nordic-fjord-aurora",
        overlay: 35,
        fill: "cover",
      },
    });
    fireEvent.change(screen.getByLabelText("Gradient start"), { target: { value: "#112233" } });
    fireEvent.change(screen.getByLabelText("Gradient end"), { target: { value: "#445566" } });
    await user.click(screen.getByRole("combobox", { name: "Gradient style" }));
    await user.click(await screen.findByRole("option", { name: "Radial" }));
    await user.click(screen.getByRole("button", { name: "Apply custom gradient" }));
    expect(onUpdateAppearance).toHaveBeenLastCalledWith({
      dimming: 0,
      elementOpacity: 1,
      background: {
        kind: "gradient",
        style: "radial",
        from: "#112233",
        to: "#445566",
        angle: 180,
      },
    });
    const file = new File([new Uint8Array([1, 2, 3])], "custom.gif", { type: "image/gif" });
    fireEvent.change(screen.getByLabelText("Upload local Zen background"), {
      target: { files: [file] },
    });
    expect(onUploadBackground).toHaveBeenCalledWith(file);
    expect(screen.getByLabelText("Upload local Zen background")).toHaveAttribute(
      "accept",
      "image/png,image/jpeg,image/webp,image/gif",
    );
  });

  it("keeps the appearance dialog and preset labels inside a narrow Zen surface", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles/zen.css"), "utf8");
    expect(styles).toMatch(
      /\.zen-surface__manual-panel\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*calc\(100% - 32px\);/s,
    );
    expect(styles).toMatch(
      /\.zen-appearance__preset-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/s,
    );
    expect(styles).toMatch(
      /\.zen-appearance__preset-grid > \[data-slot="button"\]\s*\{[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s,
    );

    render(
      <ZenSurface
        barCollapsed={false}
        onExit={() => undefined}
        onExpandBar={() => undefined}
        onHideBar={() => undefined}
        onUpdateAppearance={() => undefined}
        onUpdateElement={() => undefined}
        onUpdateViewport={() => undefined}
        space={makeSpace()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    const dialog = screen.getByRole("dialog", { name: "Zen appearance" });
    expect(dialog.querySelector(".zen-appearance__preset-grid")).not.toBeNull();
    expect(
      dialog.querySelectorAll('.zen-appearance__preset-grid > [data-slot="button"]').length,
    ).toBeGreaterThan(0);
  });

  it("forces readable opaque elements when transparency is reduced", () => {
    const base = makeSpace([
      {
        elementId,
        kind: "notes",
        widgetVersion: 0 as AggregateVersion,
        content: "Readable",
        geometry: { x: 40, y: 40, width: 360, height: 220 },
        zIndex: 1,
        minimized: false,
        locked: false,
      },
    ]);
    const space = {
      ...base,
      appearance: { ...base.appearance, reducedTransparency: true, elementOpacity: 0.2 },
    };
    render(
      <ZenSurface
        barCollapsed={false}
        onExit={() => undefined}
        onExpandBar={() => undefined}
        onHideBar={() => undefined}
        onUpdateElement={() => undefined}
        onUpdateViewport={() => undefined}
        space={space}
      />,
    );
    expect(screen.getByRole("group", { name: "Notes" })).toHaveStyle({ opacity: "1" });
  });

  it("labels a Reference as external content and offers an explicit safe fallback", () => {
    render(
      <ZenSurface
        barCollapsed={false}
        onExit={() => undefined}
        onExpandBar={() => undefined}
        onHideBar={() => undefined}
        onUpdateElement={() => undefined}
        onUpdateViewport={() => undefined}
        space={makeSpace([
          {
            elementId,
            kind: "reference",
            url: "https://example.com/release-notes" as never,
            label: "Release notes",
            geometry: { x: 40, y: 40, width: 360, height: 220 },
            zIndex: 1,
            minimized: false,
            locked: false,
          },
        ])}
      />,
    );

    expect(screen.getByText("External content")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Release notes externally" })).toHaveAttribute(
      "href",
      "https://example.com/release-notes",
    );
    expect(screen.queryByText("reference element")).not.toBeInTheDocument();
  });

  it("renders an accessible timer and dispatches lifecycle intent without client clock state", () => {
    const onTimerAction = vi.fn();
    const timer: ZenElementPayload = {
      elementId,
      kind: "timer",
      durationMs: 25 * 60 * 1000,
      remainingMs: 25 * 60 * 1000,
      status: "idle",
      startedAt: null,
      deadlineAt: null,
      clockSessionId: null,
      monotonicStartedMs: null,
      geometry: { x: 40, y: 40, width: 360, height: 220 },
      zIndex: 1,
      minimized: false,
      locked: false,
      title: "Focus timer",
    };

    render(
      <ZenSurface
        barCollapsed={false}
        onExit={() => undefined}
        onExpandBar={() => undefined}
        onHideBar={() => undefined}
        onTimerAction={onTimerAction}
        onUpdateElement={() => undefined}
        onUpdateViewport={() => undefined}
        space={makeSpace([timer])}
      />,
    );

    expect(screen.getByRole("timer", { name: "25 minutes remaining" })).toHaveTextContent("25:00");
    expect(screen.getByText("Ready")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start timer" }));
    expect(onTimerAction).toHaveBeenCalledWith(elementId, "start");
  });

  it("adds a bounded Timer from the manual Widgets panel", () => {
    const onAddTimer = vi.fn();
    render(
      <ZenSurface
        barCollapsed={false}
        onAddTimer={onAddTimer}
        onExit={() => undefined}
        onExpandBar={() => undefined}
        onHideBar={() => undefined}
        onUpdateElement={() => undefined}
        onUpdateViewport={() => undefined}
        space={makeSpace()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Widgets" }));
    expect(screen.getByRole("dialog", { name: "Zen additions" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("spinbutton", { name: "Timer duration in minutes" }), {
      target: { value: "40" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add timer" }));
    expect(onAddTimer).toHaveBeenCalledWith(40 * 60 * 1000);
  });

  it("adds a terminal or browser for the focused thread without leaving Zen", () => {
    const sourceContext = {
      hostId: "local-host",
      mode: "code" as const,
      projectId: null,
      threadKind: "code" as const,
      threadId: "00000000-0000-4000-8000-000000000914",
    } as never;
    const onAddTerminal = vi.fn();
    const onAddBrowser = vi.fn();
    render(
      <ZenSurface
        barCollapsed={false}
        onAddBrowser={onAddBrowser}
        onAddTerminal={onAddTerminal}
        onExit={() => undefined}
        onExpandBar={() => undefined}
        onHideBar={() => undefined}
        onUpdateElement={() => undefined}
        onUpdateViewport={() => undefined}
        space={makeSpace([
          {
            elementId,
            kind: "thread",
            sourceContext,
            geometry: { x: 40, y: 40, width: 360, height: 220 },
            zIndex: 1,
            minimized: false,
            locked: false,
          },
        ])}
      />,
    );

    fireEvent.focus(screen.getByRole("group", { name: "Thread" }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("button", { name: "Add terminal" }));
    expect(onAddTerminal).toHaveBeenCalledWith(sourceContext);

    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("button", { name: "Add browser" }));
    expect(onAddBrowser).toHaveBeenCalledWith(sourceContext);
  });

  it("keeps the terminal action disabled when Code says the thread cannot add one", () => {
    const sourceContext = {
      hostId: "local-host",
      mode: "code" as const,
      projectId: null,
      threadKind: "code" as const,
      threadId: "00000000-0000-4000-8000-000000000914",
    } as never;
    render(
      <ZenSurface
        barCollapsed={false}
        canAddTerminal={() => false}
        onAddTerminal={vi.fn()}
        onExit={() => undefined}
        onExpandBar={() => undefined}
        onHideBar={() => undefined}
        onUpdateElement={() => undefined}
        onUpdateViewport={() => undefined}
        space={makeSpace([
          {
            elementId,
            kind: "thread",
            sourceContext,
            geometry: { x: 40, y: 40, width: 360, height: 220 },
            zIndex: 1,
            minimized: false,
            locked: false,
          },
        ])}
      />,
    );

    fireEvent.focus(screen.getByRole("group", { name: "Thread" }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(screen.getByRole("button", { name: "Add terminal" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(/cannot add a terminal/i);
  });

  it("labels a pinned terminal separately from the thread that owns it", () => {
    const terminal = {
      elementId,
      kind: "terminal" as const,
      sourceContext: {
        hostId: "local-host",
        mode: "code" as const,
        projectId: null,
        threadKind: "code" as const,
        threadId: "00000000-0000-4000-8000-000000000914",
      },
      checkoutId: "00000000-0000-4000-8000-000000000915",
      terminalId: "00000000-0000-4000-8000-000000000916",
      geometry: { x: 40, y: 40, width: 360, height: 220 },
      zIndex: 1,
      minimized: false,
      locked: false,
      title: "HEI",
    } as never;

    render(
      <ZenSurface
        barCollapsed={false}
        onExit={() => undefined}
        onExpandBar={() => undefined}
        onHideBar={() => undefined}
        onUpdateElement={() => undefined}
        onUpdateViewport={() => undefined}
        renderTerminal={() => <div role="region" aria-label="Terminal pane" />}
        space={makeSpace([terminal])}
      />,
    );

    expect(screen.getByRole("group", { name: "Terminal · HEI" })).toBeInTheDocument();
  });

  it("announces explicit completion without implying task or thread completion", () => {
    render(
      <ZenSurface
        barCollapsed={false}
        onExit={() => undefined}
        onExpandBar={() => undefined}
        onHideBar={() => undefined}
        onTimerAction={() => undefined}
        onUpdateElement={() => undefined}
        onUpdateViewport={() => undefined}
        space={makeSpace([
          {
            elementId,
            kind: "timer",
            durationMs: 5 * 60 * 1000,
            remainingMs: 0,
            status: "completed",
            startedAt: null,
            deadlineAt: null,
            clockSessionId: null,
            monotonicStartedMs: null,
            geometry: { x: 40, y: 40, width: 360, height: 220 },
            zIndex: 1,
            minimized: false,
            locked: false,
          },
        ])}
      />,
    );

    expect(screen.getByRole("status", { name: "Timer status" })).toHaveTextContent(
      "Timer complete",
    );
    expect(
      screen.queryByText(/thread complete|task complete|goal complete/i),
    ).not.toBeInTheDocument();
  });

  it("autosaves Notes with honest saving and saved state", async () => {
    vi.useFakeTimers();
    const onSaveNotes = vi.fn(async () => undefined);
    const space = makeSpace([
      {
        elementId,
        kind: "notes",
        widgetVersion: 0 as AggregateVersion,
        content: "Draft",
        geometry: { x: 40, y: 40, width: 320, height: 220 },
        zIndex: 1,
        minimized: false,
        locked: false,
        title: "Release notes",
      },
    ]);

    render(
      <ZenSurface
        barCollapsed={false}
        onExit={() => undefined}
        onExpandBar={() => undefined}
        onHideBar={() => undefined}
        onSaveNotes={onSaveNotes}
        onUpdateElement={() => undefined}
        onUpdateViewport={() => undefined}
        space={space}
      />,
    );

    const editor = screen.getByRole("textbox", { name: "Release notes content" });
    fireEvent.change(editor, { target: { value: "Durable draft" } });
    expect(screen.getByRole("status", { name: "Release notes save status" })).toHaveTextContent(
      "Saving",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
      await Promise.resolve();
    });
    expect(onSaveNotes).toHaveBeenCalledWith(elementId, "Durable draft", 0);
    expect(screen.getByRole("status", { name: "Release notes save status" })).toHaveTextContent(
      "Saved",
    );
    vi.useRealTimers();
  });

  it("keeps failed Notes drafts visible with an actionable error state", async () => {
    vi.useFakeTimers();
    const space = makeSpace([
      {
        elementId,
        kind: "notes",
        widgetVersion: 2 as AggregateVersion,
        content: "Server copy",
        geometry: { x: 40, y: 40, width: 320, height: 220 },
        zIndex: 1,
        minimized: false,
        locked: false,
      },
    ]);

    render(
      <ZenSurface
        barCollapsed={false}
        onExit={() => undefined}
        onExpandBar={() => undefined}
        onHideBar={() => undefined}
        onSaveNotes={async () => {
          throw new Error("stale-version");
        }}
        onUpdateElement={() => undefined}
        onUpdateViewport={() => undefined}
        space={space}
      />,
    );

    const editor = screen.getByRole("textbox", { name: "Notes content" });
    fireEvent.change(editor, { target: { value: "Unsaved local draft" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
      await Promise.resolve();
    });
    expect(editor).toHaveValue("Unsaved local draft");
    expect(screen.getByRole("alert")).toHaveTextContent(/save failed/i);
    vi.useRealTimers();
  });

  it("operates Checklist items by stable identity and restores keyboard focus", async () => {
    const firstId = "00000000-0000-4000-8000-000000000914" as never;
    const secondId = "00000000-0000-4000-8000-000000000915" as never;
    const onSetChecklistItemCompleted = vi.fn(async () => undefined);
    const onReorderChecklistItem = vi.fn(async () => undefined);
    const space = makeSpace([
      {
        elementId,
        kind: "checklist",
        widgetVersion: 4 as AggregateVersion,
        items: [
          { itemId: firstId, text: "Run tests", done: false },
          { itemId: secondId, text: "Review diff", done: false },
        ],
        geometry: { x: 40, y: 40, width: 360, height: 260 },
        zIndex: 1,
        minimized: false,
        locked: false,
        title: "Release checklist",
      },
    ]);

    render(
      <ZenSurface
        barCollapsed={false}
        onExit={() => undefined}
        onExpandBar={() => undefined}
        onHideBar={() => undefined}
        onReorderChecklistItem={onReorderChecklistItem}
        onSetChecklistItemCompleted={onSetChecklistItemCompleted}
        onUpdateElement={() => undefined}
        onUpdateViewport={() => undefined}
        space={space}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "Run tests" }));
    expect(onSetChecklistItemCompleted).toHaveBeenCalledWith(elementId, firstId, true, 4);

    const moveUp = screen.getByRole("button", { name: "Move Review diff up" });
    moveUp.focus();
    fireEvent.click(moveUp);
    expect(onReorderChecklistItem).toHaveBeenCalledWith(elementId, secondId, firstId, 4);
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: "Review diff" })).toHaveFocus(),
    );
  });

  it("offers Notes, Checklist, and Timer from the integrated widget picker", () => {
    const onCreateWidget = vi.fn();
    render(
      <ZenSurface
        barCollapsed={false}
        onCreateWidget={onCreateWidget}
        onExit={() => undefined}
        onExpandBar={() => undefined}
        onHideBar={() => undefined}
        onUpdateElement={() => undefined}
        onUpdateViewport={() => undefined}
        space={makeSpace()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Widgets" }));
    expect(screen.getByRole("button", { name: "Add Notes" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Checklist" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add timer" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add Notes" }));
    expect(onCreateWidget).toHaveBeenCalledWith("notes");
  });

  it("renders elements and moves the focused element with arrow keys", () => {
    const onUpdateElement = vi.fn();
    const space = makeSpace([
      {
        elementId,
        kind: "notes",
        widgetVersion: 0 as AggregateVersion,
        content: "Focus note",
        geometry: { x: 40, y: 40, width: 240, height: 160 },
        zIndex: 1,
        minimized: false,
        locked: false,
        title: "Focus note",
      },
    ]);

    render(
      <ZenSurface
        barCollapsed={false}
        onExit={() => undefined}
        onHideBar={() => undefined}
        onUpdateElement={onUpdateElement}
        onUpdateViewport={() => undefined}
        onExpandBar={() => undefined}
        space={space}
      />,
    );

    const card = screen.getByRole("group", { name: "Focus note" });
    card.focus();
    fireEvent.keyDown(card, { key: "ArrowRight" });
    expect(onUpdateElement).toHaveBeenCalledWith(
      expect.objectContaining({
        elementId,
        geometry: expect.objectContaining({ x: 56 }),
      }),
    );
  });

  it("moves and resizes elements with pointer gestures and exposes removal", () => {
    const onUpdateElement = vi.fn();
    const onRemoveElement = vi.fn();
    const space = makeSpace([
      {
        elementId,
        kind: "notes",
        widgetVersion: 0 as AggregateVersion,
        content: "Move me",
        geometry: { x: 40, y: 40, width: 240, height: 160 },
        zIndex: 1,
        minimized: false,
        locked: false,
        title: "Move me",
      },
    ]);

    render(
      <ZenSurface
        barCollapsed={false}
        onExit={() => undefined}
        onHideBar={() => undefined}
        onRemoveElement={onRemoveElement}
        onUpdateElement={onUpdateElement}
        onUpdateViewport={() => undefined}
        onExpandBar={() => undefined}
        space={space}
      />,
    );

    const card = screen.getByRole("group", { name: "Move me" });
    const header = card.querySelector<HTMLElement>(".zen-el-head");
    if (header === null) throw new Error("Zen element header was not rendered.");
    fireEvent.pointerDown(header, { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(card, { clientX: 140, clientY: 130 });
    fireEvent.pointerUp(card, { clientX: 140, clientY: 130 });

    expect(onUpdateElement).toHaveBeenCalledWith(
      expect.objectContaining({
        elementId,
        geometry: expect.objectContaining({ x: 80, y: 70 }),
      }),
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Resize Move me" }), {
      clientX: 280,
      clientY: 200,
    });
    fireEvent.pointerMove(card, { clientX: 320, clientY: 220 });
    fireEvent.pointerUp(card, { clientX: 320, clientY: 220 });
    expect(onUpdateElement).toHaveBeenCalledWith(
      expect.objectContaining({
        elementId,
        geometry: expect.objectContaining({ width: 280, height: 180 }),
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove Move me" }));
    expect(onRemoveElement).toHaveBeenCalledWith(elementId);
  });

  it("keeps the resized geometry visible until the host mutation settles", async () => {
    let settle!: () => void;
    const pending = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const onUpdateElement = vi.fn(() => pending);
    const space = makeSpace([
      {
        elementId,
        kind: "notes",
        widgetVersion: 0 as AggregateVersion,
        content: "Resize without snapping",
        geometry: { x: 40, y: 40, width: 240, height: 160 },
        zIndex: 1,
        minimized: false,
        locked: false,
        title: "Resize without snapping",
      },
    ]);

    render(
      <ZenSurface
        barCollapsed={false}
        onExit={() => undefined}
        onHideBar={() => undefined}
        onUpdateElement={onUpdateElement}
        onUpdateViewport={() => undefined}
        onExpandBar={() => undefined}
        space={space}
      />,
    );

    const card = screen.getByRole("group", { name: "Resize without snapping" });
    fireEvent.pointerDown(screen.getByRole("button", { name: "Resize Resize without snapping" }), {
      clientX: 280,
      clientY: 200,
    });
    fireEvent.pointerMove(card, { clientX: 320, clientY: 220 });
    fireEvent.pointerUp(card, { clientX: 320, clientY: 220 });

    expect(card).toHaveStyle({ width: "280px", height: "180px" });
    await act(async () => settle());
    expect(card).toHaveStyle({ width: "240px", height: "160px" });
  });

  it("reverts the previewed geometry when the host settles without accepting the change", async () => {
    const space = makeSpace([
      {
        elementId,
        kind: "notes",
        widgetVersion: 0 as AggregateVersion,
        content: "Refused resize",
        geometry: { x: 40, y: 40, width: 240, height: 160 },
        zIndex: 1,
        minimized: false,
        locked: false,
        title: "Refused resize",
      },
    ]);

    render(
      <ZenSurface
        barCollapsed={false}
        onExit={() => undefined}
        onHideBar={() => undefined}
        onRemoveElement={() => undefined}
        onUpdateElement={() => Promise.resolve(undefined)}
        onUpdateViewport={() => undefined}
        onExpandBar={() => undefined}
        space={space}
      />,
    );

    const card = screen.getByRole("group", { name: "Refused resize" });
    fireEvent.pointerDown(screen.getByRole("button", { name: "Resize Refused resize" }), {
      clientX: 280,
      clientY: 200,
    });
    fireEvent.pointerMove(card, { clientX: 320, clientY: 220 });
    fireEvent.pointerUp(card, { clientX: 320, clientY: 220 });

    expect(card).toHaveStyle({ width: "280px", height: "180px" });
    await act(async () => Promise.resolve());
    expect(card).toHaveStyle({ width: "240px", height: "160px" });
  });

  it("resizes a focused element with Alt plus arrow keys and can minimize it", () => {
    const onUpdateElement = vi.fn();
    const space = makeSpace([
      {
        elementId,
        kind: "notes",
        widgetVersion: 0 as AggregateVersion,
        content: "Resize me",
        geometry: { x: 40, y: 40, width: 240, height: 160 },
        zIndex: 1,
        minimized: false,
        locked: false,
        title: "Resize me",
      },
    ]);

    render(
      <ZenSurface
        barCollapsed={false}
        onExit={() => undefined}
        onHideBar={() => undefined}
        onRemoveElement={() => undefined}
        onUpdateElement={onUpdateElement}
        onUpdateViewport={() => undefined}
        onExpandBar={() => undefined}
        space={space}
      />,
    );

    const card = screen.getByRole("group", { name: "Resize me" });
    card.focus();
    fireEvent.keyDown(card, { key: "ArrowRight", altKey: true });
    expect(onUpdateElement).toHaveBeenCalledWith(
      expect.objectContaining({
        geometry: expect.objectContaining({ width: 256 }),
      }),
    );

    onUpdateElement.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Minimize Resize me" }));
    expect(onUpdateElement).toHaveBeenLastCalledWith(
      expect.objectContaining({ elementId, minimized: true }),
    );
  });

  it("keeps minimized elements recoverable in the spatial surface", () => {
    const space = makeSpace([
      {
        elementId,
        kind: "notes",
        widgetVersion: 0 as AggregateVersion,
        content: "Minimized note",
        geometry: { x: 40, y: 40, width: 240, height: 160 },
        zIndex: 1,
        minimized: true,
        locked: false,
        title: "Minimized note",
      },
    ]);

    render(
      <ZenSurface
        barCollapsed={false}
        onExit={() => undefined}
        onHideBar={() => undefined}
        onRemoveElement={() => undefined}
        onUpdateElement={() => undefined}
        onUpdateViewport={() => undefined}
        onExpandBar={() => undefined}
        space={space}
      />,
    );

    const card = screen.getByRole("group", { name: "Minimized note" });
    expect(card).toBeInTheDocument();
    // The frame states minimisation for the stylesheet: only the title bar
    // stays, so the element remains findable where the user put it.
    expect(card).toHaveAttribute("data-minimized", "true");
    expect(screen.getByRole("button", { name: "Restore Minimized note" })).toBeInTheDocument();
  });

  it("states a locked element's lock on its frame and refuses to drag it", () => {
    const onUpdateElement = vi.fn();
    const space = makeSpace([
      {
        elementId,
        kind: "notes",
        widgetVersion: 0 as AggregateVersion,
        content: "Locked note",
        geometry: { x: 40, y: 40, width: 240, height: 160 },
        zIndex: 1,
        minimized: false,
        locked: true,
        title: "Locked note",
      },
    ]);

    render(
      <ZenSurface
        barCollapsed={false}
        onExit={() => undefined}
        onHideBar={() => undefined}
        onRemoveElement={() => undefined}
        onUpdateElement={onUpdateElement}
        onUpdateViewport={() => undefined}
        onExpandBar={() => undefined}
        space={space}
      />,
    );

    const card = screen.getByRole("group", { name: "Locked note" });
    // Locked is stated, not implied: the frame carries the state the
    // stylesheet renders as a dashed border with no grip.
    expect(card).toHaveAttribute("data-locked", "true");
    const header = card.querySelector<HTMLElement>(".zen-el-head");
    if (header === null) throw new Error("Zen element header was not rendered.");
    fireEvent.pointerDown(header, { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(card, { clientX: 140, clientY: 130 });
    fireEvent.pointerUp(card, { clientX: 140, clientY: 130 });
    expect(onUpdateElement).not.toHaveBeenCalled();
  });

  it("surfaces the recipe a turn proposed, because the proposal is Zen's, not the conversation's", async () => {
    const proposed: ZenAssistantSnapshot = {
      ...ASSISTANT_SNAPSHOT,
      recipePreview: {
        previewId: "00000000-0000-4000-8000-000000000916" as never,
        recipe: {
          recipeId: "00000000-0000-4000-8000-000000000917" as never,
          name: "Release focus",
          primitives: ["checklist"],
          fields: [],
        },
        providerInstanceId: ASSISTANT_SNAPSHOT.provider!.providerInstanceId,
        modelId: ASSISTANT_SNAPSHOT.provider!.modelId,
        expectedVersion: 1 as AggregateVersion,
        createdAt: "2026-07-29T12:00:00.000Z" as never,
        expiresAt: "2026-07-29T12:10:00.000Z" as never,
      },
    };

    const onConfirmRecipePreview = vi.fn();
    function Harness() {
      // The host answers the turn on its own conversation and, having been
      // asked for a widget, holds a recipe preview for this window's Zen space.
      const [assistant, setAssistant] = useState<ZenAssistantSnapshot>(ASSISTANT_SNAPSHOT);
      const navigatorAssistant: NavigatorAssistantController = {
        state: {
          kind: "ready",
          snapshot: {
            status: "ready",
            settingsTarget: { section: "navigator-assistant", setting: "default-model" },
            threadId: null,
            transcript: [],
            defaultProvider: {
              providerInstanceId: "00000000-0000-4000-8000-000000000918",
              modelId: "navigator-model",
            },
            imageInput: "supported",
            visionReviewer: null,
          } as never,
        },
        busy: false,
        send: async () => {},
        refresh: async () => {},
      };
      return (
        <ZenSurface
          assistant={assistant}
          assistantOpen
          barCollapsed={false}
          navigatorAssistant={navigatorAssistant}
          onAssistantTurn={() => setAssistant(proposed)}
          onConfirmRecipePreview={onConfirmRecipePreview}
          onExit={() => undefined}
          onExpandBar={() => undefined}
          onHideBar={() => undefined}
          onRemoveElement={() => undefined}
          onUpdateElement={() => undefined}
          onUpdateViewport={() => undefined}
          space={makeSpace()}
        />
      );
    }
    render(<Harness />);

    expect(screen.queryByRole("region", { name: "Recipe preview" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Message Navigator"), {
      target: { value: "Give me a release checklist widget" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send to Navigator" }));

    expect(await screen.findByText(/nothing has been saved or placed/i)).toBeVisible();
    // Still a proposal: it reaches the space only through the confirm command.
    fireEvent.click(screen.getByRole("button", { name: "Place recipe" }));
    expect(onConfirmRecipePreview).toHaveBeenCalledWith("place");
  });

  it("announces typed reconciliation messages without hiding the exit controls", () => {
    render(
      <ZenSurface
        barCollapsed={false}
        message="Zen changed elsewhere; refreshed the current space."
        onExit={() => undefined}
        onHideBar={() => undefined}
        onRemoveElement={() => undefined}
        onUpdateElement={() => undefined}
        onUpdateViewport={() => undefined}
        onExpandBar={() => undefined}
        space={makeSpace()}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(/changed elsewhere/);
    expect(screen.getByRole("button", { name: "Exit Zen" })).toBeInTheDocument();
  });

  it("zooms to fit from the surface controls", () => {
    const onUpdateViewport = vi.fn();
    const space = makeSpace([
      {
        elementId,
        kind: "notes",
        widgetVersion: 0 as AggregateVersion,
        content: "Wide",
        geometry: { x: 0, y: 0, width: 800, height: 400 },
        zIndex: 1,
        minimized: false,
        locked: false,
        title: "Wide",
      },
    ]);

    render(
      <ZenSurface
        barCollapsed={false}
        onExit={() => undefined}
        onHideBar={() => undefined}
        onUpdateElement={() => undefined}
        onUpdateViewport={onUpdateViewport}
        onExpandBar={() => undefined}
        space={space}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Zoom to Fit" }));
    expect(onUpdateViewport).toHaveBeenCalledWith(
      expect.objectContaining({ scale: expect.any(Number) }),
    );
  });

  it("exits from the background with Escape when no dialog owns focus", () => {
    const onExit = vi.fn();
    render(
      <ZenSurface
        barCollapsed={false}
        onExit={onExit}
        onHideBar={() => undefined}
        onUpdateElement={() => undefined}
        onUpdateViewport={() => undefined}
        onExpandBar={() => undefined}
        space={makeSpace()}
      />,
    );

    const surface = screen.getByRole("application", { name: "Zen workspace" });
    surface.focus();
    fireEvent.keyDown(surface, { key: "Escape" });
    expect(onExit).toHaveBeenCalledOnce();
  });

  it("applies system accessibility fallbacks to Zen presentation", () => {
    const timerId = "00000000-0000-4000-8000-000000000920" as unknown as ZenElementId;

    function createMediaQueryList(query: string, matches: boolean) {
      return {
        matches,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      } as unknown as MediaQueryList;
    }

    const matchMedia = vi.fn().mockImplementation((query: string) => {
      switch (query) {
        case "(prefers-reduced-motion: reduce)":
        case "(prefers-reduced-transparency: reduce)":
        case "(prefers-contrast: more)":
          return createMediaQueryList(query, true);
        default:
          return createMediaQueryList(query, false);
      }
    });
    vi.stubGlobal("matchMedia", matchMedia);

    const space = makeSpace([
      {
        elementId,
        kind: "notes",
        widgetVersion: 0 as AggregateVersion,
        content: "Accessible draft",
        geometry: { x: 40, y: 40, width: 320, height: 220 },
        zIndex: 1,
        minimized: false,
        locked: false,
      },
      {
        elementId: timerId,
        kind: "timer",
        durationMs: 60_000,
        remainingMs: 60_000,
        status: "idle",
        startedAt: null,
        deadlineAt: null,
        clockSessionId: null,
        monotonicStartedMs: null,
        geometry: { x: 400, y: 40, width: 320, height: 220 },
        zIndex: 2,
        minimized: false,
        locked: false,
      },
    ]);

    const spaceWithTransparentElements = {
      ...space,
      appearance: {
        ...space.appearance,
        reducedTransparency: false,
        increasedContrast: false,
        reducedMotion: false,
        elementOpacity: 0.2,
      },
    };

    render(
      <ZenSurface
        barCollapsed={false}
        onExit={() => undefined}
        onExpandBar={() => undefined}
        onHideBar={() => undefined}
        onUpdateElement={() => undefined}
        onUpdateViewport={() => undefined}
        space={spaceWithTransparentElements}
      />,
    );

    expect(screen.getByRole("group", { name: "Notes" })).toHaveStyle({ opacity: "1" });
    expect(screen.getByRole("group", { name: "Timer" }).querySelector(".zen-timer")).toHaveClass(
      "zen-timer--reduced-motion",
    );
    expect(matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
    expect(matchMedia).toHaveBeenCalledWith("(prefers-reduced-transparency: reduce)");
    expect(matchMedia).toHaveBeenCalledWith("(prefers-contrast: more)");
  });
});

describe("ZenSurface live thread cards", () => {
  const sourceContext = (threadId: string, kind: "chat" | "work" | "code" = "chat") =>
    ({
      hostId: "local-host",
      mode: kind,
      projectId: null,
      threadKind: kind,
      threadId,
    }) as never;

  function threadElement(
    suffix: number,
    kind: "chat" | "work" | "code" = "chat",
  ): Extract<ZenElementPayload, { readonly kind: "thread" }> {
    return {
      elementId: `00000000-0000-4000-8000-00000000092${suffix}` as ZenElementId,
      kind: "thread",
      sourceContext: sourceContext(`00000000-0000-4000-8000-00000000093${suffix}`, kind),
      geometry: { x: 40, y: 40, width: 360, height: 220 },
      zIndex: suffix,
      minimized: false,
      locked: false,
    };
  }

  function catalogEntry(element: ZenElementPayload) {
    if (element.kind !== "thread") throw new Error("not a thread element");
    return {
      catalogRef: `${element.sourceContext.mode}:${element.sourceContext.threadId}`,
      hostId: "local-host",
      hostLabel: "This Mac",
      mode: element.sourceContext.mode,
      projectId: null,
      projectLabel: "Unfiled",
      threadId: element.sourceContext.threadId,
      title: `Thread ${element.zIndex}`,
      status: "active",
      recentActivityAt: "2026-07-28T12:00:00.000Z",
      providerInstanceId: "00000000-0000-4000-8000-000000000003",
      modelId: "model-local",
      sourceContext: element.sourceContext,
    } as never;
  }

  it("keeps a live thread's resize grip above its composer", () => {
    const element = threadElement(1, "code");
    render(
      <ZenSurface
        barCollapsed={false}
        onExit={() => undefined}
        onExpandBar={() => undefined}
        onHideBar={() => undefined}
        onUpdateElement={() => undefined}
        onUpdateViewport={() => undefined}
        renderLiveThread={({ entry }) => ({
          status: "streaming",
          surface: (
            <div className="code-thread-workspace__composer" style={{ zIndex: 2 }}>
              {entry.title}
            </div>
          ),
        })}
        space={makeSpace([element])}
        threadEntries={[catalogEntry(element)]}
      />,
    );

    expect(screen.getByRole("button", { name: "Resize Thread 1" })).toHaveStyle({ zIndex: "3" });
  });

  it("streams each card's own thread and holds the rest at the live-card budget", () => {
    const elements = [1, 2, 3, 4].map((suffix) => threadElement(suffix));
    render(
      <ZenSurface
        barCollapsed={false}
        onExit={() => undefined}
        onExpandBar={() => undefined}
        onHideBar={() => undefined}
        onUpdateElement={() => undefined}
        onUpdateViewport={() => undefined}
        renderLiveThread={({ activity, entry }) =>
          activity.activity === "frozen"
            ? { status: "paused", reason: activity.reason }
            : { status: "streaming", surface: <p>{`Live ${entry.title}`}</p> }
        }
        space={makeSpace(elements)}
        threadEntries={elements.map(catalogEntry)}
      />,
    );

    expect(screen.getByText("Live Thread 4")).toBeInTheDocument();
    expect(screen.getByText("Live Thread 3")).toBeInTheDocument();
    expect(screen.getByText("Live Thread 2")).toBeInTheDocument();
    expect(screen.queryByText("Live Thread 1")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/Paused while other cards are streaming/i);
  });

  it("keeps a card on its metadata reading when the window hosts no live surface for it", () => {
    const element = threadElement(1);
    render(
      <ZenSurface
        barCollapsed={false}
        onExit={() => undefined}
        onExpandBar={() => undefined}
        onHideBar={() => undefined}
        onUpdateElement={() => undefined}
        onUpdateViewport={() => undefined}
        renderLiveThread={() => undefined}
        space={makeSpace([element])}
        threadEntries={[catalogEntry(element)]}
      />,
    );

    expect(screen.getByRole("group", { name: "Thread 1" })).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Continue Thread 1/i })).not.toBeInTheDocument();
  });

  it("targets the thread whose live composer receives focus", () => {
    const first = threadElement(1, "work");
    const second = threadElement(2, "work");
    const onAddBrowser = vi.fn();
    render(
      <ZenSurface
        barCollapsed={false}
        onAddBrowser={onAddBrowser}
        onExit={() => undefined}
        onExpandBar={() => undefined}
        onHideBar={() => undefined}
        onUpdateElement={() => undefined}
        onUpdateViewport={() => undefined}
        renderLiveThread={({ entry }) => ({
          status: "streaming",
          surface: <input aria-label={`Composer ${entry.title}`} />,
        })}
        space={makeSpace([first, second])}
        threadEntries={[catalogEntry(first), catalogEntry(second)]}
      />,
    );

    fireEvent.focus(screen.getByRole("textbox", { name: "Composer Thread 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("button", { name: "Add browser" }));

    expect(onAddBrowser).toHaveBeenCalledWith(second.sourceContext);
  });

  it("streams the cards of the space in front, and drops them on the way to another", () => {
    const inFront = threadElement(1);
    const elsewhere = threadElement(2);
    const surface = (element: ReturnType<typeof threadElement>) => (
      <ZenSurface
        barCollapsed={false}
        onExit={() => undefined}
        onExpandBar={() => undefined}
        onHideBar={() => undefined}
        onUpdateElement={() => undefined}
        onUpdateViewport={() => undefined}
        renderLiveThread={({ activity, entry }) =>
          activity.activity === "frozen"
            ? { status: "paused", reason: activity.reason }
            : { status: "streaming", surface: <p>{`Live ${entry.title}`}</p> }
        }
        space={{
          ...makeSpace([element]),
          spaceId: `00000000-0000-4000-8000-00000000091${element.zIndex}` as ZenSpaceId,
        }}
        threadEntries={[catalogEntry(inFront), catalogEntry(elsewhere)]}
      />
    );
    const view = render(surface(inFront));

    expect(screen.getByText("Live Thread 1")).toBeInTheDocument();

    // Switching space replaces the surface with the space now in front. A card
    // pinned to the space left behind stops streaming because it is no longer
    // on screen at all, not because anything told it to stop.
    view.rerender(surface(elsewhere));

    expect(screen.queryByText("Live Thread 1")).not.toBeInTheDocument();
    expect(screen.getByText("Live Thread 2")).toBeInTheDocument();
  });
});
