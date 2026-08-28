import { describe, expect, it } from "vitest";
import { createRemoteDraftRegistry } from "./remoteDraftRegistry";
import { localHostDisplayName } from "./localHostDisplayName";
import {
  mapBridgeStateToHostHealth,
  buildRemoteHostObservation,
  canExecuteRemoteProductMutation,
} from "./remoteShellHealth";

describe("remoteShellHealth", () => {
  it("maps bridge states to host health", () => {
    expect(mapBridgeStateToHostHealth({ kind: "ready", hostId: "h", displayName: "Mac" })).toBe(
      "healthy",
    );
    expect(mapBridgeStateToHostHealth({ kind: "stale", hostId: "h", displayName: "Mac" })).toBe(
      "stale",
    );
    expect(mapBridgeStateToHostHealth({ kind: "unavailable", reason: "x" })).toBe("unavailable");
  });

  it("builds host observation from bridge state", () => {
    const hosts = buildRemoteHostObservation({
      state: { kind: "ready", hostId: "11111111-1111-4111-8111-111111111111", displayName: "Mac" },
    });
    expect(hosts[0]?.health).toBe("healthy");
    expect(hosts[0]?.displayName).toBe("Mac");
  });

  it("does not label a nameless remote host as this computer", () => {
    const hosts = buildRemoteHostObservation({
      state: {
        kind: "unavailable",
        reason: "Remote host is unavailable.",
        hostId: "11111111-1111-4111-8111-111111111111",
      },
    });
    expect(hosts[0]?.displayName).toBe("Remote host");
    expect(hosts[0]?.displayName).not.toBe(localHostDisplayName());
  });

  it("gates mutations to ready sessions only", () => {
    expect(
      canExecuteRemoteProductMutation({ kind: "ready", hostId: "h", displayName: "Mac" }),
    ).toBe(true);
    expect(
      canExecuteRemoteProductMutation({ kind: "stale", hostId: "h", displayName: "Mac" }),
    ).toBe(false);
  });
});

describe("remoteDraftRegistry", () => {
  it("preserves drafts until explicit clear", () => {
    const registry = createRemoteDraftRegistry();
    registry.write("draft-one");
    expect(registry.read()).toBe("draft-one");
    registry.clear();
    expect(registry.read()).toBe("");
  });
});
