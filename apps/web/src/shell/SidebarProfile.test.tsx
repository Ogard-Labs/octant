import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { defaultShellSettings } from "@octant/domain/shell-policy";
import { SidebarProfile } from "./SidebarProfile";

const profile = defaultShellSettings().userProfile;

describe("SidebarProfile", () => {
  it("says a name is not set yet and still opens the place it is set", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    const { container } = render(
      <SidebarProfile
        onOpenNavigator={vi.fn()}
        onOpenSettings={onOpenSettings}
        profile={profile}
      />,
    );

    const row = screen.getByRole("button", { name: "Set your name" });
    expect(row).toHaveClass("sidebar-item");
    expect(container.querySelector(".sidebar-foot")).toContainElement(row);

    await user.click(row);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(onOpenSettings.mock.calls[0]?.[0]).toBeUndefined();
  });

  it("shows the name the person gave and leads to the settings that are theirs", async () => {
    const user = userEvent.setup();
    const onOpenNavigator = vi.fn();
    const onOpenSettings = vi.fn();
    const onOpenZen = vi.fn();
    render(
      <SidebarProfile
        navigatorAvailable
        onOpenNavigator={onOpenNavigator}
        onOpenSettings={onOpenSettings}
        onOpenZen={onOpenZen}
        profile={{ ...profile, displayName: "Henrik" }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Henrik" }));
    await user.click(screen.getByRole("button", { name: "Usage" }));
    expect(onOpenSettings).toHaveBeenCalledWith({ section: "usage" });

    await user.click(screen.getByRole("button", { name: "Henrik" }));
    await user.click(screen.getByRole("button", { name: "Navigator" }));
    expect(onOpenNavigator).toHaveBeenCalledOnce();
    expect(onOpenSettings).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Henrik" }));
    await user.click(screen.getByRole("button", { name: "Zen mode" }));
    expect(onOpenZen).toHaveBeenCalledOnce();
  });

  it("omits Navigator until the host has a model for it", async () => {
    const user = userEvent.setup();
    render(<SidebarProfile onOpenNavigator={vi.fn()} onOpenSettings={vi.fn()} profile={profile} />);

    await user.click(screen.getByRole("button", { name: "Set your name" }));
    expect(screen.queryByRole("button", { name: "Navigator" })).not.toBeInTheDocument();
  });

  it("offers no Zen row on a window that cannot enter Zen", async () => {
    const user = userEvent.setup();
    render(<SidebarProfile onOpenNavigator={vi.fn()} onOpenSettings={vi.fn()} profile={profile} />);

    await user.click(screen.getByRole("button", { name: "Set your name" }));
    expect(screen.queryByRole("button", { name: "Zen mode" })).not.toBeInTheDocument();
  });

  it("exposes secondary destinations from the keyboard-accessible app menu", async () => {
    const user = userEvent.setup();
    const onSelectDestination = vi.fn();
    render(
      <SidebarProfile
        destinations={[
          { id: "agents", label: "Agents" },
          { id: "automations", label: "Automations" },
          { id: "artifact-library", label: "Artifacts" },
          { id: "plugins", label: "Plugins" },
        ]}
        navigatorAvailable
        onOpenNavigator={vi.fn()}
        onOpenSettings={vi.fn()}
        onSelectDestination={onSelectDestination}
        profile={profile}
      />,
    );

    expect(screen.queryByRole("button", { name: "Agents" })).not.toBeInTheDocument();
    const row = screen.getByRole("button", { name: "Set your name" });
    await user.click(row);
    expect(screen.getByRole("button", { name: "Agents" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Plugins" }));
    expect(onSelectDestination).toHaveBeenCalledWith("plugins");
    expect(screen.queryByRole("button", { name: "Plugins" })).not.toBeInTheDocument();

    await user.click(row);
    expect(screen.getByRole("button", { name: "Agents" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Automations" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Artifacts" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Navigator" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Settings" })).toBeVisible();
  });

  it("omits unavailable secondary destinations rather than showing them disabled", async () => {
    const user = userEvent.setup();
    render(
      <SidebarProfile
        destinations={[{ id: "plugins", label: "Plugins" }]}
        onOpenNavigator={vi.fn()}
        onOpenSettings={vi.fn()}
        onSelectDestination={vi.fn()}
        profile={profile}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Set your name" }));
    expect(screen.getByRole("button", { name: "Plugins" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Agents" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Automations" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Artifacts" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Navigator" })).not.toBeInTheDocument();
  });

  it("closes on Escape and returns focus to the row it opened from", async () => {
    const user = userEvent.setup();
    render(<SidebarProfile onOpenNavigator={vi.fn()} onOpenSettings={vi.fn()} profile={profile} />);

    const row = screen.getByRole("button", { name: "Set your name" });
    await user.click(row);
    expect(screen.getByRole("button", { name: "Settings" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();
    expect(row).toHaveFocus();
  });
});
