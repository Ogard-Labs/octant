import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
