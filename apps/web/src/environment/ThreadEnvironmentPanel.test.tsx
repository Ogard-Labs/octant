import { decodeEnvironmentCompactIdentity } from "@octant/contracts";
import { LOCAL_HOST_ID } from "@octant/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OctantButton } from "../ui/base/OctantButton";
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
    const summary = screen.getByRole("button", { name: "Toggle environment" });
    expect(summary).toBeVisible();
    expect(summary).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.getByText("Octant · feature/name · Dirty · packages/app · 2 servers"),
    ).toHaveClass("sr-only");
    expect(summary).not.toHaveTextContent(
      /Octant|feature\/name|packages\/app|2 servers|available/i,
    );
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
    await user.click(screen.getByRole("button", { name: "Toggle environment" }));
    expect(onOpenChange).toHaveBeenLastCalledWith(true);

    rerender(
      <ThreadEnvironmentPanel onOpenChange={onOpenChange} open summary={{ identity }}>
        <p>Checkout facts</p>
      </ThreadEnvironmentPanel>,
    );
    // A prop-driven open (unlike a click-driven one) doesn't yield to the
    // animation frame that settles the popup's enter transition, so wait for
    // it before asserting on the now-open panel.
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Environment" })).toBeVisible());
    expect(screen.getByRole("heading", { name: "Environment" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Toggle environment" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText("Checkout facts")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Close environment" }));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);

    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("closes on an outside pointer and when the pane is no longer active", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <div>
        <OctantButton type="button">Outside</OctantButton>
        <ThreadEnvironmentPanel onOpenChange={onOpenChange} open summary={{ identity }}>
          <p>Checkout facts</p>
        </ThreadEnvironmentPanel>
      </div>,
    );
    await user.click(screen.getByRole("button", { name: "Outside" }));
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
    expect(screen.getByRole("button", { name: "Toggle environment" })).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not persist open state through a presentation callback", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <ThreadEnvironmentPanel onOpenChange={onOpenChange} open={false} summary={{ identity }} />,
    );
    await user.click(screen.getByRole("button", { name: "Toggle environment" }));
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });
});
