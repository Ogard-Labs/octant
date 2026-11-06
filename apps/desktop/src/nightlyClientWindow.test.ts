import { describe, expect, it, vi } from "vitest";
import { openNightlyClientWindow } from "./nightlyClientWindow";
import type { NativeDesktopWindows } from "./desktopPeerWindows";

const bootstrap = {
  kind: "registered",
  protocol: 1,
  windowId: "00000000-0000-4000-8000-000000000596",
  generation: 1,
  hostOrigin: "http://127.0.0.1:13773",
  hostInstance: "00000000-0000-4000-8000-000000000597",
  capability: "A".repeat(43),
  rendererIdentity: "A".repeat(43),
  leaseMs: 15_000,
};
function fixture() {
  let elapsed = 0;
  let destroyed = false;
  let onClosed = () => {};
  const timers: Array<{
    readonly delay: number;
    readonly callback: () => void;
    cancelled: boolean;
  }> = [];
  const native: NativeDesktopWindows = {
    listenWindows: async () => ({ kind: "started" }),
    replyWindow: () => false,
    stopWindows: async () => ({ kind: "closed" }),
    openWindow: vi.fn(async () => bootstrap),
    renewWindow: vi.fn(async () => ({ kind: "renewed", leaseMs: 15_000 })),
    revokeWindow: vi.fn(async () => ({ kind: "revoked" })),
  };
  const load = vi.fn(async () => {});
  const show = vi.fn();
  const lost = vi.fn();
  const destroy = vi.fn(() => {
    destroyed = true;
    onClosed();
  });
  const createWindow = vi.fn(() => ({
    load,
    show,
    destroy,
    isDestroyed: () => destroyed,
    onClosed: (listener: () => void) => {
      onClosed = listener;
    },
  }));
  const open = (signal?: AbortSignal) =>
    openNightlyClientWindow({
      native,
      onLeaseLost: lost,
      ...(signal === undefined ? {} : { signal }),
      createWindow,
      elapsedNow: () => elapsed,
      schedule: (delay, callback) => {
        const timer = { delay, callback, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
    });
  return {
    native,
    open,
    createWindow,
    destroy,
    load,
    show,
    lost,
    timers,
    advance: (value: number) => {
      elapsed = value;
    },
  };
}

describe("ordinary Nightly client window", () => {
  it("reports failed revocation when cancellation refuses a late native registration", async () => {
    const f = fixture();
    const controller = new AbortController();
    vi.mocked(f.native.revokeWindow).mockResolvedValueOnce({ kind: "refused" });
    controller.abort();
    expect(await f.open(controller.signal)).toEqual({
      kind: "refused",
      reason: "native-unavailable",
      cleanupFailed: true,
    });
    expect(f.createWindow).not.toHaveBeenCalled();
  });
  it("cancels a pending renderer load without showing its late completion", async () => {
    const f = fixture();
    const controller = new AbortController();
    let loaded = () => {};
    f.load.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          loaded = resolve;
        }),
    );
    const pending = f.open(controller.signal);
    await vi.waitFor(() => expect(f.load).toHaveBeenCalledOnce());
    controller.abort();
    expect(await pending).toEqual({ kind: "refused", reason: "deadline-exceeded" });
    loaded();
    expect(f.show).not.toHaveBeenCalled();
    expect(f.destroy).toHaveBeenCalledOnce();
    expect(f.native.revokeWindow).toHaveBeenCalledOnce();
    expect(f.lost).not.toHaveBeenCalled();
  });
  it("announces lost authority before destroying an opened renderer, but never on person close", async () => {
    const f = fixture();
    await f.open();
    f.destroy.mockImplementationOnce(() => {
      expect(f.lost).toHaveBeenCalledOnce();
    });
    f.advance(15_000);
    f.timers.find((timer) => timer.delay === 15_000)?.callback();
    expect(f.lost).toHaveBeenCalledOnce();
    const ordinary = fixture();
    const client = await ordinary.open();
    if (client.kind === "opened") await client.close();
    expect(ordinary.lost).not.toHaveBeenCalled();
  });
  it("loads its renderer using the host-issued bootstrap and releases one lease on repeated close", async () => {
    const f = fixture();
    const opened = await f.open();
    expect(opened.kind).toBe("opened");
    if (opened.kind !== "opened") throw new Error("Fixture window refused");
    expect(f.createWindow).toHaveBeenCalledWith(bootstrap);
    expect(f.load).toHaveBeenCalledOnce();
    const first = opened.close();
    const second = opened.close();
    expect(second).toBe(first);
    expect(await first).toEqual({ kind: "closed" });
    expect(f.destroy).toHaveBeenCalledOnce();
    expect(f.native.revokeWindow).toHaveBeenCalledOnce();
    expect(f.timers.every((timer) => timer.cancelled)).toBe(true);
  });

  it("destroys an expired window even while its initial renderer load is pending", async () => {
    const f = fixture();
    let finishLoad = () => {};
    f.load.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishLoad = resolve;
        }),
    );
    const pending = f.open();
    try {
      await vi.waitFor(() => expect(f.load).toHaveBeenCalledOnce());
      f.advance(15_000);
      f.timers.find((timer) => timer.delay === 15_000)?.callback();
      expect(f.destroy).toHaveBeenCalledOnce();
      finishLoad();
      expect(await pending).toEqual({ kind: "refused", reason: "deadline-exceeded" });
      expect(f.show).not.toHaveBeenCalled();
      expect(f.lost).not.toHaveBeenCalled();
      expect(f.native.revokeWindow).toHaveBeenCalledOnce();
    } finally {
      finishLoad();
    }
  });

  it("does not construct a window from a missing or mismatched native bootstrap", async () => {
    const f = fixture();
    vi.mocked(f.native.openWindow).mockResolvedValueOnce({ ...bootstrap, generation: 2 });
    expect(await f.open()).toEqual({ kind: "refused", reason: "invalid-receipt" });
    expect(f.createWindow).not.toHaveBeenCalled();
    expect(f.native.revokeWindow).toHaveBeenCalledOnce();
  });
});
