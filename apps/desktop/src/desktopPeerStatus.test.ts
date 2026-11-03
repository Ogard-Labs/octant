import { describe, expect, it, vi } from "vitest";
import { desktopPeerPreflight, ownDesktopPeerStatus } from "./desktopPeerStatus";

describe("the packaged desktop status preflight", () => {
  it("refuses an unknown native receipt rather than treating it as a compatible host", async () => {
    expect(
      await desktopPeerPreflight({ status: async () => ({ kind: "ready", protocol: 99 }) }),
    ).toEqual({
      kind: "refused",
      reason: "invalid-receipt",
    });
  });

  it("preserves the native refusal instead of inventing a compatible host", async () => {
    expect(
      await desktopPeerPreflight({
        status: async () => ({ kind: "refused", reason: "unsigned-build" }),
      }),
    ).toEqual({
      kind: "refused",
      reason: "unsigned-build",
    });
  });

  it("awaits a pending acquisition and releases the endpoint once after quit", async () => {
    let acquired: ((value: unknown) => void) | undefined;
    const close = vi.fn(async () => ({ kind: "closed" }));
    const owner = ownDesktopPeerStatus({
      start: () =>
        new Promise((resolve) => {
          acquired = resolve;
        }),
      close,
    });
    const first = owner.close();
    const second = owner.close();
    expect(close).not.toHaveBeenCalled();
    acquired?.({ kind: "started" });
    expect(await first).toEqual({ kind: "closed" });
    expect(await second).toEqual({ kind: "closed" });
    expect(close).toHaveBeenCalledTimes(1);
  });
});
