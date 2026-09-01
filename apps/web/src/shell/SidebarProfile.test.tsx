import { render, screen, waitFor } from "@testing-library/react";
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

    const row = screen.getByRole("button", { name: "Account menu, Set your name" });
    expect(row).toHaveClass("sidebar-item");
    expect(container.querySelector(".sidebar-foot")).toContainElement(row);

    await user.click(row);
    await user.click(await screen.findByRole("menuitem", { name: "Settings" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(onOpenSettings.mock.calls[0]?.[0]).toBeUndefined();
  });

  it("names the identity button after the account menu and the person, with the label visible", () => {
    render(
      <SidebarProfile
        onOpenNavigator={vi.fn()}
        onOpenSettings={vi.fn()}
        profile={{ ...profile, displayName: "Henrik" }}
      />,
    );

    const row = screen.getByRole("button", { name: "Account menu, Henrik" });
    const label = row.querySelector(".sidebar-label");
    expect(label).toHaveTextContent("Henrik");
    expect(label).not.toHaveAttribute("aria-hidden");
  });

  it("centers the menu above the row instead of anchoring it to the content edge", async () => {
    const user = userEvent.setup();
    render(<SidebarProfile onOpenNavigator={vi.fn()} onOpenSettings={vi.fn()} profile={profile} />);

    await user.click(screen.getByRole("button", { name: "Account menu, Set your name" }));
    const menu = await screen.findByRole("menu");
    expect(menu).toHaveAttribute("data-side", "top");
    expect(menu).toHaveAttribute("data-align", "center");
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

    await user.click(screen.getByRole("button", { name: "Account menu, Henrik" }));
    await user.click(await screen.findByRole("menuitem", { name: "Usage" }));
    expect(onOpenSettings).toHaveBeenCalledWith({ section: "usage" });

    await user.click(screen.getByRole("button", { name: "Account menu, Henrik" }));
    await user.click(await screen.findByRole("menuitem", { name: "Navigator" }));
    expect(onOpenNavigator).toHaveBeenCalledOnce();
    expect(onOpenSettings).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Account menu, Henrik" }));
    await user.click(await screen.findByRole("menuitem", { name: "Zen mode" }));
    expect(onOpenZen).toHaveBeenCalledOnce();
  });

  it("opens the global Archive destination from the Octant group", async () => {
    const user = userEvent.setup();
    const onOpenArchive = vi.fn();
    render(
      <SidebarProfile
        onOpenArchive={onOpenArchive}
        onOpenNavigator={vi.fn()}
        onOpenSettings={vi.fn()}
        profile={{ ...profile, displayName: "Henrik" }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Account menu, Henrik" }));
    await user.click(await screen.findByRole("menuitem", { name: "Archive" }));
    expect(onOpenArchive).toHaveBeenCalledOnce();
  });

  it("groups secondary workspace destinations in the app menu", async () => {
    const user = userEvent.setup();
    const agents = vi.fn();
    const automations = vi.fn();
    const artifacts = vi.fn();
    const plugins = vi.fn();
    render(
      <SidebarProfile
        onOpenNavigator={vi.fn()}
        onOpenSettings={vi.fn()}
        profile={{ ...profile, displayName: "Henrik" }}
        secondaryActions={[
          { id: "agents", label: "Agents", onSelect: agents },
          { id: "automations", label: "Automations", onSelect: automations },
          { id: "artifact-library", label: "Artifacts", onSelect: artifacts },
          { id: "plugins", label: "Plugins", onSelect: plugins },
        ]}
      />,
    );

    expect(screen.queryByRole("menuitem", { name: "Agents" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Account menu, Henrik" }));
    expect(await screen.findByRole("group", { name: "Workspace" })).toBeVisible();
    for (const label of ["Agents", "Automations", "Artifacts", "Plugins"]) {
      expect(screen.getByRole("menuitem", { name: label })).toBeVisible();
    }
    await user.click(screen.getByRole("menuitem", { name: "Agents" }));
    expect(agents).toHaveBeenCalledOnce();
  });

  it("omits Navigator until the host has a model for it", async () => {
    const user = userEvent.setup();
    render(<SidebarProfile onOpenNavigator={vi.fn()} onOpenSettings={vi.fn()} profile={profile} />);

    await user.click(screen.getByRole("button", { name: "Account menu, Set your name" }));
    await screen.findByRole("menuitem", { name: "Settings" });
    expect(screen.queryByRole("menuitem", { name: "Navigator" })).not.toBeInTheDocument();
  });

  it("offers no Zen row on a window that cannot enter Zen", async () => {
    const user = userEvent.setup();
    render(<SidebarProfile onOpenNavigator={vi.fn()} onOpenSettings={vi.fn()} profile={profile} />);

    await user.click(screen.getByRole("button", { name: "Account menu, Set your name" }));
    await screen.findByRole("menuitem", { name: "Settings" });
    expect(screen.queryByRole("menuitem", { name: "Zen mode" })).not.toBeInTheDocument();
  });

  it("closes on Escape and returns focus to the row it opened from", async () => {
    const user = userEvent.setup();
    render(<SidebarProfile onOpenNavigator={vi.fn()} onOpenSettings={vi.fn()} profile={profile} />);

    const row = screen.getByRole("button", { name: "Account menu, Set your name" });
    row.focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("menuitem", { name: "Settings" });
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Settings" })).toHaveFocus());

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menuitem", { name: "Settings" })).not.toBeInTheDocument();
    expect(row).toHaveFocus();
  });
});
