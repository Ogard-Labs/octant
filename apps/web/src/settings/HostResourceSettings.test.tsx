import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_HOST_RESOURCE_POLICY, decodeAgentRunPolicySettings } from "@octant/contracts";
import { HostResourceSettings } from "./HostResourceSettings";

describe("computer resource settings", () => {
  it("shows the host budget and saves a pause without changing helper permissions", async () => {
    const settings = decodeAgentRunPolicySettings({
      creationPosture: "off",
      version: 2,
      updatedAt: "2026-11-12T12:00:00.000Z",
    });
    const update = vi.fn(async (input) =>
      decodeAgentRunPolicySettings({
        ...settings,
        resourcePolicy: input.resourcePolicy,
        version: 3,
      }),
    );
    const view = render(
      <HostResourceSettings
        client={{
          current: async () => settings,
          update,
          resources: async () => ({
            policy: DEFAULT_HOST_RESOURCE_POLICY,
            cores: 8,
            cpuPercent: 20,
            totalMemoryBytes: 16 * 2 ** 30,
            availableMemoryBytes: 8 * 2 ** 30,
            commands: 2,
            workers: 2,
            agents: 2,
            activeCommands: 1,
            queuedCommands: 1,
            reason: "ready",
          }),
        }}
      />,
    );
    expect(await screen.findByText(/8 cores/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pause new work" }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          creationPosture: "off",
          expectedVersion: 2,
          resourcePolicy: expect.objectContaining({ mode: "paused" }),
        }),
      ),
    );
    expect(await screen.findByRole("button", { name: "Resume automatic limits" })).toBeTruthy();
    view.unmount();
  });
  it("makes a failed load retryable instead of presenting unsaved defaults", async () => {
    const current = vi.fn().mockRejectedValue(new Error("offline"));
    render(<HostResourceSettings client={{ current, update: vi.fn() }} />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(current).toHaveBeenCalledTimes(2));
  });
});
