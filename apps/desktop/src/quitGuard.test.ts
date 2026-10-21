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

  it("quits without a prompt when the host only reports a provider that needs sign-in", async () => {
    const confirm = vi.fn(async () => false);
    await expect(
      evaluateQuitRequest({
        refreshActivity: async () => undefined,
        snapshot: () => ({ ...snapshot(0), state: "attention-required", attentionRequired: true }),
        confirm,
      }),
    ).resolves.toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("asks before quitting when the desktop could not confirm what the host is running", async () => {
    const confirm = vi.fn(async () => true);
    await evaluateQuitRequest({
      refreshActivity: async () => undefined,
      snapshot: () => ({
        ...snapshot(0),
        state: "attention-required",
        attentionRequired: true,
        activityUnconfirmed: true,
      }),
      confirm,
    });
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("keeps a stale session count uncertain when refreshing activity fails", async () => {
    const confirm = vi.fn(async () => false);
    await expect(
      evaluateQuitRequest({
        refreshActivity: async () => {
          throw new Error("Host is unavailable");
        },
        snapshot: () => snapshot(2),
        confirm,
      }),
    ).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ activeAgentCount: 2, activityUnconfirmed: true }),
    );
  });

  it.each([
    [1, "1 provider session is still open."],
    [2, "2 provider sessions are still open."],
  ])("describes %i open sessions without claiming they are running turns", (count, message) => {
    expect(buildQuitConfirmation(snapshot(count))).toEqual({
      title: "Quit Octant?",
      message,
      detail: "Quitting closes these sessions and stops any running work on this local host.",
      buttons: ["Cancel", "Quit and stop work"],
      defaultId: 0,
      cancelId: 0,
    });
  });

  it.each([0, 2])("keeps an unconfirmed count of %i uncertain", (count) => {
    expect(buildQuitConfirmation({ ...snapshot(count), activityUnconfirmed: true })).toMatchObject({
      message: "Active Octant work may be interrupted.",
      detail: "Fully quitting stops the desktop-owned local host and its running work.",
      defaultId: 0,
      cancelId: 0,
    });
  });
});
