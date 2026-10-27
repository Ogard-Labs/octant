import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostPlatformContext } from "../platform";
import { ComputerUseSettingsView } from "./ComputerUseSettingsView";

const status = {
  supported: true,
  enabled: true,
  automaticUpdates: true,
  permissions: { accessibility: false, screenRecording: false },
  driver: "stopped",
  version: "0.24.0",
  activeSessions: 0,
  update: "current",
};

describe("Computer use Settings", () => {
  it("shows permission setup and persists the automatic-update choice", async () => {
    const requestComputerUsePermissions = vi.fn(async () => ({
      ...status,
      permissions: { accessibility: true, screenRecording: true },
    }));
    const onSettingsChange = vi.fn();
    render(
      <ComputerUseSettingsView
        settings={{ enabled: true, automaticUpdates: true }}
        onSettingsChange={onSettingsChange}
        bridge={{ getComputerUseStatus: async () => status, requestComputerUsePermissions }}
      />,
    );
    expect(await screen.findByText("CuaDriver 0.24.0")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Set up permissions" }));
    await waitFor(() => expect(requestComputerUsePermissions).toHaveBeenCalledOnce());
    expect(await screen.findAllByText("Allowed")).toHaveLength(2);
    fireEvent.click(screen.getByRole("switch", { name: "Automatically update Computer use" }));
    expect(onSettingsChange).toHaveBeenCalledWith({
      computerUse: { enabled: true, automaticUpdates: false },
    });
  });

  it("keeps the page available with an honest explanation outside the desktop app", async () => {
    render(
      <ComputerUseSettingsView
        settings={{ enabled: true, automaticUpdates: true }}
        onSettingsChange={() => {}}
        bridge={{}}
      />,
    );
    expect(await screen.findByText(/requires the Octant desktop app/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Set up permissions" })).toBeDisabled();
  });
});

// Each host is seen from a window on the other platform, so copy that read the
// window's platform instead of the host's would name the wrong computer.
const HOSTS = [
  { hostPlatform: "linux", window: "MacIntel", computer: "this computer", elsewhere: /this Mac/ },
  {
    hostPlatform: "darwin",
    window: "Linux x86_64",
    computer: "this Mac",
    elsewhere: /this computer/,
  },
] as const;

describe.each(HOSTS)("Computer use Settings on a $hostPlatform host", (host) => {
  beforeEach(() => {
    Object.defineProperty(window.navigator, "platform", { value: host.window, configurable: true });
  });
  afterEach(() => Reflect.deleteProperty(window.navigator, "platform"));

  it("names the host's computer whose applications a task may ask for, and keeps the macOS permission copy", async () => {
    render(
      <HostPlatformContext.Provider value={host.hostPlatform}>
        <ComputerUseSettingsView
          settings={{ enabled: true, automaticUpdates: true }}
          onSettingsChange={() => {}}
          bridge={{}}
        />
      </HostPlatformContext.Provider>,
    );

    expect(
      screen.getByText(`Allow tasks to request access to applications on ${host.computer}.`),
    ).toBeVisible();
    // Computer use runs only on macOS, so its permission section keeps naming macOS.
    expect(screen.getByText("macOS permissions")).toBeVisible();
    expect(await screen.findByText(/requires the Octant desktop app/)).toBeVisible();
  });
});
