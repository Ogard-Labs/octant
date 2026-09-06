import { decodeEnvironmentCompactIdentity, LOCAL_HOST_ID } from "@octant/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
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

  it("moves into a dock host that mounts after the panel opened", async () => {
    const { rerender } = render(
      <ThreadEnvironmentPanel open summary={{ identity }}>
        <p>Checkout facts</p>
      </ThreadEnvironmentPanel>,
    );
    // Without a host the panel renders in place, which is the inline fallback.
    expect(screen.getByRole("region", { name: "Environment details" })).toBeVisible();

    rerender(
      <>
        <div data-octant-environment-dock data-testid="dock-host" />
        <ThreadEnvironmentPanel open summary={{ identity }}>
          <p>Checkout facts</p>
        </ThreadEnvironmentPanel>
      </>,
    );
    await waitFor(() =>
      expect(
        within(screen.getByTestId("dock-host")).getByRole("region", {
          name: "Environment details",
        }),
      ).toBeVisible(),
    );

    // The dock re-keys its tool body; the panel follows the new host instead
    // of staying in the detached one, where it rendered to no one.
    rerender(
      <>
        <div data-octant-environment-dock data-testid="dock-host-2" key="second" />
        <ThreadEnvironmentPanel open summary={{ identity }}>
          <p>Checkout facts</p>
        </ThreadEnvironmentPanel>
      </>,
    );
    await waitFor(() =>
      expect(
        within(screen.getByTestId("dock-host-2")).getByRole("region", {
          name: "Environment details",
        }),
      ).toBeVisible(),
    );
  });

  it("does not repeat a Project that is named after its folder", () => {
    const sameName = decodeEnvironmentCompactIdentity({
      host: LOCAL_HOST_ID,
      label: "octant",
      detail: "octant",
      status: "available",
    });
    render(
      <ThreadEnvironmentPanel open summary={{ identity: sameName, changes: "clean" }}>
        <p>Checkout facts</p>
      </ThreadEnvironmentPanel>,
    );
    expect(screen.getByText("octant · Clean")).toBeVisible();
    expect(screen.queryByText("octant · octant · Clean")).not.toBeInTheDocument();
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
