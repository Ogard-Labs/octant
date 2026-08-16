import { describe, expect, it, vi } from "vitest";
import { disconnectLiveMobileSession } from "./mobileSessionLifecycle";

describe("live mobile session lifecycle", () => {
  it("disconnects the dedicated bridge and every host bridge during vault teardown", () => {
    const bridge = { disconnect: vi.fn() };
    const hub = { disconnectAll: vi.fn() };

    disconnectLiveMobileSession({ bridge, hub });

    expect(bridge.disconnect).toHaveBeenCalledOnce();
    expect(hub.disconnectAll).toHaveBeenCalledOnce();
  });
});
