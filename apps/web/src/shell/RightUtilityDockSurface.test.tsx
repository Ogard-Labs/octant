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
    const CodeEnvironment = vi.fn(() => <p>Repository environment</p>);
    const { rerender } = render(
      <RightUtilityDockSurface
        availableSurfaces={RIGHT_UTILITY_DOCK_SURFACES}
        codeEnvironment={<CodeEnvironment />}
        context={<p>Live context inspector</p>}
        navigator={<p>Host Navigator</p>}
        onClose={vi.fn()}
        onSelectSurface={vi.fn()}
        projectMemory={<ProjectMemory />}
        resolution={{ kind: "closed", reason: "project-stale" }}
      />,
    );

    expect(ProjectMemory).not.toHaveBeenCalled();
    expect(CodeEnvironment).not.toHaveBeenCalled();
    expect(screen.queryByText(/Private Project memory|Repository environment/)).toBeNull();

    rerender(
      <RightUtilityDockSurface
        availableSurfaces={RIGHT_UTILITY_DOCK_SURFACES}
        codeEnvironment={<CodeEnvironment />}
        context={<p>Live context inspector</p>}
        navigator={<p>Host Navigator</p>}
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
    expect(CodeEnvironment).not.toHaveBeenCalled();
  });

  it("exposes only validated real surface choices and surface-scoped actions", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onRefreshEnvironment = vi.fn();
    const onSelectSurface = vi.fn();
    render(
      <RightUtilityDockSurface
        availableSurfaces={RIGHT_UTILITY_DOCK_SURFACES}
        codeEnvironment={<p>Repository environment</p>}
        context={<p>Live context inspector</p>}
        navigator={<p>Host Navigator</p>}
        onClose={onClose}
        onRefreshEnvironment={onRefreshEnvironment}
        onSelectSurface={onSelectSurface}
        projectMemory={<p>Private Project memory</p>}
        resolution={{
          kind: "surface",
          projectId,
          surface: RIGHT_UTILITY_DOCK_SURFACES[2],
        }}
      />,
    );

    expect(screen.getByRole("heading", { name: "Code environment" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Code environment" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Project memory" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Context" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Browser|Terminal|Files|Review/ })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Project memory" }));
    expect(onSelectSurface).toHaveBeenCalledWith("project-memory");
    await user.click(screen.getByRole("button", { name: "Refresh Code environment" }));
    expect(onRefreshEnvironment).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Close Code environment" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("renders the live Context surface without falling back to another dock panel", () => {
    render(
      <RightUtilityDockSurface
        availableSurfaces={RIGHT_UTILITY_DOCK_SURFACES}
        codeEnvironment={<p>Repository environment</p>}
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
    expect(screen.queryByText("Repository environment")).toBeNull();
    expect(screen.queryByText("Private Project memory")).toBeNull();
  });
});
