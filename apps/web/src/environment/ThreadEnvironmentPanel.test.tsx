import { decodeEnvironmentCompactIdentity } from "@octant/contracts";
import { LOCAL_HOST_ID } from "@octant/contracts";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ThreadEnvironmentPanel } from "./ThreadEnvironmentPanel";

const identity = decodeEnvironmentCompactIdentity({
  host: LOCAL_HOST_ID,
  label: "Octant",
  detail: "feature/name",
  status: "available",
});

describe("the thread environment summary", () => {
  it("shows a compact truthful summary without opening a persistent panel", () => {
    render(
      <ThreadEnvironmentPanel
        onOpenChange={vi.fn()}
        open={false}
        summary={{
          identity,
          branch: "feature/name",
          changes: "dirty",
          workingLocation: "packages/app",
          runningServerCount: 2,
        }}
      />,
    );
    expect(
      screen.getByRole("button", {
        name: "Show environment for Octant. feature/name · Dirty · packages/app · 2 servers",
      }),
    ).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens the disclosure from the summary and closes it on Escape", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <ThreadEnvironmentPanel onOpenChange={onOpenChange} open={false} summary={{ identity }}>
        <p>Checkout facts</p>
      </ThreadEnvironmentPanel>,
    );
    await user.click(screen.getByRole("button", { name: /Show environment for Octant/ }));
    expect(onOpenChange).toHaveBeenLastCalledWith(true);

    rerender(
      <ThreadEnvironmentPanel onOpenChange={onOpenChange} open summary={{ identity }}>
        <p>Checkout facts</p>
      </ThreadEnvironmentPanel>,
    );
    expect(screen.getByRole("dialog", { name: "Environment for Octant" })).toBeVisible();
    expect(screen.getByText("Checkout facts")).toBeVisible();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("closes on an outside pointer and when the pane is no longer active", () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <div>
        <button type="button">Outside</button>
        <ThreadEnvironmentPanel onOpenChange={onOpenChange} open summary={{ identity }}>
          <p>Checkout facts</p>
        </ThreadEnvironmentPanel>
      </div>,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);

    rerender(
      <ThreadEnvironmentPanel
        active={false}
        onOpenChange={onOpenChange}
        open
        summary={{ identity }}
      >
        <p>Checkout facts</p>
      </ThreadEnvironmentPanel>,
    );
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("keeps the compact summary visible at a narrow viewport without a persistent wall", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 360 });
    render(
      <ThreadEnvironmentPanel
        onOpenChange={vi.fn()}
        open={false}
        summary={{
          identity,
          branch: "feature/name",
          changes: "dirty",
          workingLocation: "packages/app",
          runningServerCount: 1,
        }}
      />,
    );
    expect(
      screen.getByRole("button", {
        name: "Show environment for Octant. feature/name · Dirty · packages/app · 1 server",
      }),
    ).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not persist open state through a presentation callback", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <ThreadEnvironmentPanel onOpenChange={onOpenChange} open={false} summary={{ identity }} />,
    );
    await user.click(screen.getByRole("button", { name: /Show environment for Octant/ }));
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });
});
