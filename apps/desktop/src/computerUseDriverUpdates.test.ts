import { describe, expect, it, vi } from "vitest";
import { createComputerUseDriverUpdates } from "./computerUseDriverUpdates";

function fixture() {
  let busy = true;
  const activate = vi.fn(async () => true);
  const stage = vi.fn(async () => ({
    version: "0.25.0",
    path: "/private/driver/0.25.0/cua-driver",
  }));
  const check = vi.fn(async () => ({
    version: "0.25.0",
    url: "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.25.0/cua-driver-rs-0.25.0-darwin-universal-binary.tar.gz",
    sha256: "a".repeat(64),
  }));
  const scheduled: Array<() => void> = [];
  const updates = createComputerUseDriverUpdates({
    currentVersion: "0.24.0",
    check,
    stage,
    activate,
    isBusy: () => busy,
    schedule: (_delay, callback) => {
      scheduled.push(callback);
      return () => {};
    },
  });
  return {
    updates,
    activate,
    stage,
    check,
    scheduled,
    idle: () => {
      busy = false;
    },
  };
}

describe("Computer use driver updates", () => {
  it("stages an automatic update and waits for every computer-use session to finish", async () => {
    const f = fixture();
    f.updates.configure({ enabled: true, automaticUpdates: true });
    expect(f.scheduled).toHaveLength(1);
    await f.updates.check();
    expect(f.stage).toHaveBeenCalledOnce();
    expect(f.activate).not.toHaveBeenCalled();
    expect(f.updates.state().status).toBe("staged");
    f.idle();
    await f.updates.applyWhenIdle();
    expect(f.activate).toHaveBeenCalledOnce();
    expect(f.updates.state()).toMatchObject({ status: "current", currentVersion: "0.25.0" });
  });

  it("keeps the current driver when verification or replacement startup fails", async () => {
    const f = fixture();
    f.idle();
    f.stage.mockRejectedValueOnce(new Error("signature refused"));
    await f.updates.check();
    expect(f.activate).not.toHaveBeenCalled();
    expect(f.updates.state()).toMatchObject({ status: "failed", currentVersion: "0.24.0" });
    f.activate.mockResolvedValueOnce(false);
    await f.updates.check();
    expect(f.updates.state()).toMatchObject({ status: "failed", currentVersion: "0.24.0" });
  });

  it("does not check or activate automatically after the plugin is disabled", async () => {
    const f = fixture();
    f.updates.configure({ enabled: true, automaticUpdates: true });
    f.updates.configure({ enabled: false, automaticUpdates: true });
    f.scheduled[0]?.();
    expect(f.check).not.toHaveBeenCalled();
    await f.updates.applyWhenIdle();
    expect(f.activate).not.toHaveBeenCalled();
  });

  it("clears an interrupted update check when automatic updates are disabled", async () => {
    const f = fixture();
    let finish: (() => void) | undefined;
    f.check.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { version: "0.25.0", url: "https://example.invalid/unused", sha256: "a".repeat(64) };
    });
    f.updates.configure({ enabled: true, automaticUpdates: true });
    const pending = f.updates.check();
    expect(f.updates.state().status).toBe("checking");
    f.updates.configure({ enabled: true, automaticUpdates: false });
    finish?.();
    await pending;
    expect(f.updates.state()).toEqual({ status: "idle", currentVersion: "0.24.0" });
    expect(f.stage).not.toHaveBeenCalled();
  });
});
