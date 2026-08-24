import { describe, expect, it, vi } from "vitest";
import { buildQuitConfirmation, evaluateQuitRequest } from "./quitGuard";
import type { LocalHostSnapshot } from "./hostLifecycle";

function snapshot(activeAgentCount: number): LocalHostSnapshot {
  return {
    state: "running",
    ownership: "desktop-owned",
    activeAgentCount,
    attentionRequired: false,
  };
}

describe("desktop quit guard", () => {
  it("refreshes activity before deciding whether quit needs confirmation", async () => {
    let current = snapshot(0);
    const confirm = vi.fn(async () => false);

    await expect(
      evaluateQuitRequest({
        refreshActivity: async () => {
          current = snapshot(2);
        },
        snapshot: () => current,
        confirm,
      }),
    ).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ activeAgentCount: 2 }));
  });

  it("quits without a prompt when the refreshed host is idle", async () => {
    const confirm = vi.fn(async () => false);
    await expect(
      evaluateQuitRequest({
        refreshActivity: async () => undefined,
        snapshot: () => snapshot(0),
        confirm,
      }),
    ).resolves.toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("names the active work and keeps cancellation as the default", () => {
    expect(buildQuitConfirmation(snapshot(2))).toEqual({
      title: "Quit Octant?",
      message: "2 active agent turns will be interrupted.",
      detail: "Fully quitting stops the desktop-owned local host and its running work.",
      buttons: ["Cancel", "Quit and stop work"],
      defaultId: 0,
      cancelId: 0,
    });
  });
});
