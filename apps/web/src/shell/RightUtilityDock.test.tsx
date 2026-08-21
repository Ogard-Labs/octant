import { MAX_CONTEXT_SIDEBAR_WIDTH, MIN_CONTEXT_SIDEBAR_WIDTH } from "@octant/contracts/shell";
import { decodeProjectId } from "@octant/contracts/projects";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { RIGHT_UTILITY_DOCK_SURFACES } from "./rightUtilityDockModel";
import { RightUtilityDock, type RightUtilityDockProps } from "./RightUtilityDock";

const projectId = decodeProjectId("10000000-0000-4000-8000-000000000001");

function props(overrides: Partial<RightUtilityDockProps> = {}): RightUtilityDockProps {
  return {
    availableSurfaces: RIGHT_UTILITY_DOCK_SURFACES,
    context: <p>Live context inspector</p>,
    isNarrow: false,
    navigator: <p>Host Navigator</p>,
    onClose: vi.fn(),
    onCommitWidth: vi.fn(),
    onPreviewWidth: vi.fn(),
    onSelectSurface: vi.fn(),
    projectMemory: <p>Private Project memory</p>,
    thread: <p>Thread surfaces</p>,
    resolution: {
      kind: "surface",
      projectId,
      surface: RIGHT_UTILITY_DOCK_SURFACES[1],
    },
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
        <button ref={opener} type="button">
          Open utility dock
        </button>
        <RightUtilityDock {...props({ isNarrow: true, onClose, restoreFocus: opener })} />
      </>,
    );

    expect(screen.getByRole("dialog", { name: "Project memory" })).toHaveAttribute(
      "id",
      "right-utility-dock",
    );
    expect(screen.queryByRole("complementary", { name: "Right Utility Dock" })).toBeNull();
    expect(screen.queryByRole("separator", { name: "Resize utility dock" })).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Close Project memory" })).toHaveFocus(),
    );

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
    rerender(
      <>
        <button ref={opener} type="button">
          Open utility dock
        </button>
        <RightUtilityDock
          {...props({
            isNarrow: true,
            onClose,
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

  it("keeps the dock open but empties it when the Project identity goes stale", () => {
    const { rerender } = render(<RightUtilityDock {...props()} />);
    expect(screen.getByText("Private Project memory")).toBeVisible();

    rerender(
      <RightUtilityDock
        {...props({
          resolution: {
            kind: "unavailable",
            reason: "project-stale",
            surface: RIGHT_UTILITY_DOCK_SURFACES[1],
          },
        })}
      />,
    );
    expect(screen.queryByText("Private Project memory")).toBeNull();
    expect(screen.getByRole("complementary", { name: "Right Utility Dock" })).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Project memory has nothing to describe here" }),
    ).toBeVisible();
  });

  it("tears the dock down entirely when the resolution is closed", () => {
    const { rerender } = render(<RightUtilityDock {...props()} />);
    expect(screen.getByText("Private Project memory")).toBeVisible();

    rerender(
      <RightUtilityDock {...props({ resolution: { kind: "closed", reason: "disconnected" } })} />,
    );
    expect(screen.queryByText("Private Project memory")).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Right Utility Dock" })).toBeNull();
  });
});
