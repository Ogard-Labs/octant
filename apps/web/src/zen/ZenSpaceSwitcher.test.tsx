import {
  MAX_ZEN_SPACES_PER_WINDOW,
  decodeWindowId,
  decodeZenSpaceId,
  type AggregateVersion,
  type ZenFocusZone,
} from "@octant/contracts";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ZenSpaceSwitcher } from "./ZenSpaceSwitcher";

const windowId = decodeWindowId("00000000-0000-4000-8000-000000000911");
const focus = decodeZenSpaceId("00000000-0000-4000-8000-000000000912");
const review = decodeZenSpaceId("00000000-0000-4000-8000-000000000913");

function zone(overrides: Partial<ZenFocusZone> = {}): ZenFocusZone {
  return {
    windowId,
    version: 2 as AggregateVersion,
    spaces: [
      { spaceId: focus, name: "Focus", position: 0 },
      { spaceId: review, name: "Review", position: 1 },
    ],
    activeSpaceId: focus,
    createdAt: "2026-08-14T09:00:00.000Z" as ZenFocusZone["createdAt"],
    updatedAt: "2026-08-14T09:00:00.000Z" as ZenFocusZone["updatedAt"],
    ...overrides,
  };
}

describe("ZenSpaceSwitcher", () => {
  it("marks the space in front and shows another when it is chosen", () => {
    const onShowSpace = vi.fn();
    render(<ZenSpaceSwitcher onShowSpace={onShowSpace} zone={zone()} />);

    expect(screen.getByRole("tab", { name: "Focus" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Review" })).toHaveAttribute("aria-selected", "false");
    fireEvent.click(screen.getByRole("tab", { name: "Review" }));
    expect(onShowSpace).toHaveBeenCalledWith(review);
  });

  it("steps to the next space with the arrow keys, wrapping at the end", () => {
    const onShowSpace = vi.fn();
    render(<ZenSpaceSwitcher onShowSpace={onShowSpace} zone={zone({ activeSpaceId: review })} />);

    fireEvent.keyDown(screen.getByRole("tablist", { name: "Focus spaces" }), {
      key: "ArrowRight",
    });

    expect(onShowSpace).toHaveBeenCalledWith(focus);
  });

  it("renames a space in place and leaves the name alone when the rename is abandoned", () => {
    const onRenameSpace = vi.fn();
    render(<ZenSpaceSwitcher onRenameSpace={onRenameSpace} zone={zone()} />);

    fireEvent.doubleClick(screen.getByRole("tab", { name: "Review" }));
    const field = screen.getByLabelText("Rename Review");
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onRenameSpace).not.toHaveBeenCalled();

    fireEvent.doubleClick(screen.getByRole("tab", { name: "Review" }));
    const reopened = screen.getByLabelText("Rename Review");
    fireEvent.change(reopened, { target: { value: "Release" } });
    fireEvent.keyDown(reopened, { key: "Enter" });
    expect(onRenameSpace).toHaveBeenCalledWith(review, "Release");
  });

  it("keeps a window's last space, offering no way to remove it", () => {
    render(
      <ZenSpaceSwitcher
        onRemoveSpace={() => undefined}
        zone={zone({ spaces: [{ spaceId: focus, name: "Focus", position: 0 }] })}
      />,
    );

    expect(screen.queryByRole("button", { name: "Remove Focus" })).not.toBeInTheDocument();
  });

  it("stops offering to add a space once the window holds as many as it may", () => {
    const spaces = Array.from({ length: MAX_ZEN_SPACES_PER_WINDOW }, (_unused, position) => ({
      spaceId: decodeZenSpaceId(
        `00000000-0000-4000-8000-0000000009${String(20 + position).padStart(2, "0")}`,
      ),
      name: `Space ${String(position + 1)}`,
      position,
    }));
    const first = spaces[0];
    if (first === undefined) throw new Error("A focus zone always holds a space.");
    render(<ZenSpaceSwitcher zone={zone({ spaces, activeSpaceId: first.spaceId })} />);

    expect(screen.getByRole("button", { name: "Add a space" })).toBeDisabled();
  });
});
