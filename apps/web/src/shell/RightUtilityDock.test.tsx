import { MAX_CONTEXT_SIDEBAR_WIDTH, MIN_CONTEXT_SIDEBAR_WIDTH } from "@octant/contracts/shell";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { RIGHT_UTILITY_DOCK_SURFACES } from "./rightUtilityDockModel";
import { RightUtilityDock, type RightUtilityDockProps } from "./RightUtilityDock";

function dockSurface(
  id: (typeof RIGHT_UTILITY_DOCK_SURFACES)[number]["id"],
): (typeof RIGHT_UTILITY_DOCK_SURFACES)[number] {
  const found = RIGHT_UTILITY_DOCK_SURFACES.find((surface) => surface.id === id);
  if (found === undefined) throw new Error(`Missing ${id} dock surface.`);
  return found;
}

const browser = dockSurface("browser");

function props(overrides: Partial<RightUtilityDockProps> = {}): RightUtilityDockProps {
  return {
    isNarrow: false,
    launchableSurfaces: RIGHT_UTILITY_DOCK_SURFACES.filter(
      (surface) => surface.id === "browser" || surface.id === "terminal",
    ),
    onClose: vi.fn(),
    onCloseTab: vi.fn(),
    onCommitWidth: vi.fn(),
    onOpenTab: vi.fn(),
    onPreviewWidth: vi.fn(),
    onSelectSurface: vi.fn(),
    open: true,
    sideChat: <p>Thread side chat</p>,
    resolution: {
      kind: "surface",
      surface: browser,
    },
    tabs: [browser],
    width: 360,
    ...overrides,
  };
}

describe("RightUtilityDock", () => {
  it("renders one opaque docked landmark with bounded pointer and keyboard resize", () => {
    const handlers = props();
    render(<RightUtilityDock {...handlers} />);

    expect(screen.getByRole("complementary", { name: "Right Utility Dock" })).toBeVisible();
    expect(screen.queryByRole("dialog")).toBeNull();
    const splitter = screen.getByRole("separator", { name: "Resize utility dock" });
    expect(splitter).toHaveAttribute("aria-valuemin", String(MIN_CONTEXT_SIDEBAR_WIDTH));
    expect(splitter).toHaveAttribute("aria-valuemax", String(MAX_CONTEXT_SIDEBAR_WIDTH));
    expect(splitter).toHaveAttribute("aria-valuetext", "360 px");

    fireEvent.keyDown(splitter, { key: "ArrowLeft", shiftKey: true });
    expect(handlers.onPreviewWidth).toHaveBeenCalledWith(392);
    expect(handlers.onCommitWidth).toHaveBeenCalledWith(392);

    Object.assign(splitter, {
      hasPointerCapture: vi.fn(() => true),
      releasePointerCapture: vi.fn(),
      setPointerCapture: vi.fn(),
    });
    fireEvent.pointerDown(splitter, { button: 0, clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(splitter, { clientX: -500, pointerId: 1 });
    fireEvent.pointerUp(splitter, { clientX: -500, pointerId: 1 });
    expect(handlers.onPreviewWidth).toHaveBeenLastCalledWith(MAX_CONTEXT_SIDEBAR_WIDTH);
    expect(handlers.onCommitWidth).toHaveBeenLastCalledWith(MAX_CONTEXT_SIDEBAR_WIDTH);
  });

  it("cancels dock preview on lost capture without changing the committed width", () => {
    const handlers = props();
    render(<RightUtilityDock {...handlers} />);
    const splitter = screen.getByRole("separator", { name: "Resize utility dock" });
    Object.assign(splitter, { setPointerCapture: vi.fn() });

    fireEvent.pointerDown(splitter, { button: 0, clientX: 500, pointerId: 2 });
    fireEvent.pointerMove(splitter, { clientX: 460, pointerId: 2 });
    fireEvent.lostPointerCapture(splitter, { pointerId: 2 });

    expect(handlers.onPreviewWidth).toHaveBeenLastCalledWith(360);
    expect(handlers.onCommitWidth).not.toHaveBeenCalled();
  });

  it("renders one narrow modal without a competing dock landmark and restores the opener", async () => {
    const user = userEvent.setup();
    const opener = createRef<HTMLButtonElement>();
    const onClose = vi.fn();
    const { rerender } = render(
      <>
        <button onClick={() => undefined} ref={opener} type="button">
          Open utility dock
        </button>
        <RightUtilityDock {...props({ isNarrow: true, onClose, restoreFocus: opener })} />
      </>,
    );

    expect(screen.getByRole("dialog", { name: "Browser" })).toHaveAttribute(
      "id",
      "right-utility-dock",
    );
    expect(screen.queryByRole("complementary", { name: "Right Utility Dock" })).toBeNull();
    expect(screen.queryByRole("separator", { name: "Resize utility dock" })).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Close right sidebar" })).toHaveFocus(),
    );

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
    rerender(
      <>
        <button onClick={() => undefined} ref={opener} type="button">
          Open utility dock
        </button>
        <RightUtilityDock
          {...props({
            isNarrow: true,
            onClose,
            open: false,
            resolution: { kind: "closed", reason: "no-surface" },
            restoreFocus: opener,
          })}
        />
      </>,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Open utility dock" })).toHaveFocus(),
    );
  });

  it("keeps the dock open but empties it when the active pane holds no thread", () => {
    const { rerender } = render(<RightUtilityDock {...props({ browser: <p>Live Browser</p> })} />);
    expect(screen.getByText("Live Browser")).toBeVisible();

    rerender(
      <RightUtilityDock
        {...props({
          browser: <p>Live Browser</p>,
          resolution: {
            kind: "unavailable",
            reason: "thread-required",
            surface: browser,
          },
        })}
      />,
    );
    expect(screen.queryByText("Live Browser")).toBeNull();
    expect(screen.getByRole("complementary", { name: "Right Utility Dock" })).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Browser has nothing to describe here" }),
    ).toBeVisible();
  });

  it("tears the dock down entirely only when the sidebar toggle closes", () => {
    const { rerender } = render(<RightUtilityDock {...props({ browser: <p>Live Browser</p> })} />);
    expect(screen.getByText("Live Browser")).toBeVisible();

    rerender(<RightUtilityDock {...props({ open: false })} />);
    expect(screen.queryByText("Live Browser")).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Right Utility Dock" })).toBeNull();
  });
});
