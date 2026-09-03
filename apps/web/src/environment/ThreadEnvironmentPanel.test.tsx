import { decodeEnvironmentCompactIdentity, LOCAL_HOST_ID } from "@octant/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ThreadEnvironmentPanel } from "./ThreadEnvironmentPanel";

const identity = decodeEnvironmentCompactIdentity({
  host: LOCAL_HOST_ID,
  label: "Octant",
  detail: "feature/name",
  status: "available",
});

describe("the thread environment panel", () => {
  it("renders the active pane's Environment inside the dock host with the truthful summary", async () => {
    render(
      <>
        <div data-octant-environment-dock />
        <ThreadEnvironmentPanel
          open
          summary={{ identity, branch: "feature/name", changes: "dirty", runningServerCount: 2 }}
        >
          <p>Checkout facts</p>
        </ThreadEnvironmentPanel>
      </>,
    );
    const region = await screen.findByRole("region", { name: "Environment details" });
    expect(region).toHaveAttribute("data-environment-status", "available");
    expect(screen.getByRole("heading", { name: "Environment" })).toBeVisible();
    expect(screen.getByText("Octant · feature/name · Dirty · 2 servers")).toBeVisible();
    expect(screen.getByText("Checkout facts")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open Environment" })).not.toBeInTheDocument();
  });

  it("renders nothing while closed and nothing for an inactive pane", () => {
    const { rerender } = render(
      <>
        <div data-octant-environment-dock />
        <ThreadEnvironmentPanel open={false} summary={{ identity }}>
          <p>Closed facts</p>
        </ThreadEnvironmentPanel>
      </>,
    );
    expect(screen.queryByRole("region", { name: "Environment details" })).not.toBeInTheDocument();
    rerender(
      <>
        <div data-octant-environment-dock />
        <ThreadEnvironmentPanel active={false} open summary={{ identity }}>
          <p>Previous pane facts</p>
        </ThreadEnvironmentPanel>
      </>,
    );
    expect(screen.queryByText("Previous pane facts")).not.toBeInTheDocument();
  });
});
