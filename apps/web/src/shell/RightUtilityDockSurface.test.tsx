import { decodeProjectId } from "@octant/contracts/projects";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RIGHT_UTILITY_DOCK_SURFACES } from "./rightUtilityDockModel";
import { RightUtilityDockSurface } from "./RightUtilityDockSurface";

const projectId = decodeProjectId("10000000-0000-4000-8000-000000000001");

describe("RightUtilityDockSurface", () => {
  it("renders no stale content until the pure model returns a validated surface", () => {
    const ProjectMemory = vi.fn(() => <p>Private Project memory</p>);
    const HostNavigator = vi.fn(() => <p>Host Navigator</p>);
    const { rerender } = render(
      <RightUtilityDockSurface
        availableSurfaces={RIGHT_UTILITY_DOCK_SURFACES}
        context={<p>Live context inspector</p>}
        navigator={<HostNavigator />}
        onClose={vi.fn()}
        onSelectSurface={vi.fn()}
        projectMemory={<ProjectMemory />}
        resolution={{ kind: "closed", reason: "project-stale" }}
      />,
    );

    expect(ProjectMemory).not.toHaveBeenCalled();
    expect(HostNavigator).not.toHaveBeenCalled();
    expect(screen.queryByText(/Private Project memory|Host Navigator/)).toBeNull();

    rerender(
      <RightUtilityDockSurface
        availableSurfaces={RIGHT_UTILITY_DOCK_SURFACES}
        context={<p>Live context inspector</p>}
        navigator={<HostNavigator />}
        onClose={vi.fn()}
        onSelectSurface={vi.fn()}
        projectMemory={<ProjectMemory />}
        resolution={{
          kind: "surface",
          projectId,
          surface: RIGHT_UTILITY_DOCK_SURFACES[1],
        }}
      />,
    );

    expect(screen.getByText("Private Project memory")).toBeVisible();
    expect(HostNavigator).not.toHaveBeenCalled();
  });

  it("exposes only validated real surface choices and surface-scoped actions", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSelectSurface = vi.fn();
    render(
      <RightUtilityDockSurface
        availableSurfaces={RIGHT_UTILITY_DOCK_SURFACES}
        context={<p>Live context inspector</p>}
        navigator={<p>Host Navigator</p>}
        onClose={onClose}
        onSelectSurface={onSelectSurface}
        projectMemory={<p>Private Project memory</p>}
        resolution={{ kind: "surface", surface: RIGHT_UTILITY_DOCK_SURFACES[2] }}
      />,
    );

    expect(screen.getByRole("heading", { name: "Navigator" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Navigator" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Project memory" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Context" })).toBeVisible();
    // The thread owns its own environment and plan, so the dock offers neither.
    expect(
      screen.queryByRole("button", { name: /Code environment|Plan|Browser|Terminal|Files|Review/ }),
    ).toBeNull();

    await user.click(screen.getByRole("button", { name: "Project memory" }));
    expect(onSelectSurface).toHaveBeenCalledWith("project-memory");
    await user.click(screen.getByRole("button", { name: "Close Navigator" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("renders the live Context surface without falling back to another dock panel", () => {
    render(
      <RightUtilityDockSurface
        availableSurfaces={RIGHT_UTILITY_DOCK_SURFACES}
        context={<p>Live context inspector</p>}
        navigator={<p>Host Navigator</p>}
        onClose={vi.fn()}
        onSelectSurface={vi.fn()}
        projectMemory={<p>Private Project memory</p>}
        resolution={{
          kind: "surface",
          projectId,
          surface: RIGHT_UTILITY_DOCK_SURFACES[0],
        }}
      />,
    );

    expect(screen.getByText("Live context inspector")).toBeVisible();
    expect(screen.queryByText("Host Navigator")).toBeNull();
    expect(screen.queryByText("Private Project memory")).toBeNull();
  });
});
