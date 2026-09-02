import { decodeEnvironmentCompactIdentity, LOCAL_HOST_ID } from "@octant/contracts";
import { render, screen } from "@testing-library/react";
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
  it("opens Environment as a dock tab and keeps the truthful summary accessible", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(
      <>
        <div data-octant-environment-action />
        <ThreadEnvironmentPanel
          onOpen={onOpen}
          open={false}
          summary={{ identity, branch: "feature/name", changes: "dirty", runningServerCount: 2 }}
        />
      </>,
    );
    const trigger = await screen.findByRole("button", { name: "Open Environment" });
    expect(trigger).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Octant · feature/name · Dirty · 2 servers")).toHaveClass("sr-only");
    await user.click(trigger);
    expect(onOpen.mock.calls[0]?.[0]).toBeInstanceOf(HTMLElement);
  });

  it("renders the active pane's Environment content inside the dock host", async () => {
    render(
      <>
        <div data-octant-environment-action />
        <div data-octant-environment-dock />
        <ThreadEnvironmentPanel onOpen={vi.fn()} open summary={{ identity }}>
          <p>Checkout facts</p>
        </ThreadEnvironmentPanel>
      </>,
    );
    expect(await screen.findByRole("heading", { name: "Environment" })).toBeVisible();
    expect(screen.getByText("Checkout facts")).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not let an inactive pane fill the shared shortcut or dock tab", () => {
    render(
      <>
        <div data-octant-environment-action />
        <div data-octant-environment-dock />
        <ThreadEnvironmentPanel active={false} onOpen={vi.fn()} open summary={{ identity }}>
          <p>Previous pane facts</p>
        </ThreadEnvironmentPanel>
      </>,
    );
    expect(screen.queryByRole("button", { name: "Open Environment" })).not.toBeInTheDocument();
    expect(screen.queryByText("Previous pane facts")).not.toBeInTheDocument();
  });
});
