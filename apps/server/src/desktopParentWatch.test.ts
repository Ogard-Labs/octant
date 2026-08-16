import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { watchDesktopParent } from "./desktopParentWatch";

describe("watchDesktopParent", () => {
  it("does not consume stdin outside a desktop-managed server", () => {
    const input = new PassThrough();
    const resume = vi.spyOn(input, "resume");
    const onDisconnect = vi.fn();

    const cleanup = watchDesktopParent({ enabled: false, input, onDisconnect });

    expect(resume).not.toHaveBeenCalled();
    expect(input.listenerCount("end")).toBe(0);
    expect(input.listenerCount("close")).toBe(0);
    cleanup();
  });

  it("reports a closed parent pipe exactly once and releases its listeners", async () => {
    const input = new PassThrough();
    const onDisconnect = vi.fn();

    const cleanup = watchDesktopParent({ enabled: true, input, onDisconnect });
    input.end();

    await vi.waitFor(() => expect(onDisconnect).toHaveBeenCalledOnce());
    input.destroy();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onDisconnect).toHaveBeenCalledOnce();
    expect(input.listenerCount("end")).toBe(0);
    expect(input.listenerCount("close")).toBe(0);
    cleanup();
  });
});
