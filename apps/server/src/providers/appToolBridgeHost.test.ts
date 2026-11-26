import { describe, expect, it } from "vitest";
import { appToolBridgeReachesLaunchOn } from "./appToolBridgeHost";

describe("which hosts' launches reach the app tool bridge", () => {
  it("is every platform Octant ships, Windows included, and no other", () => {
    for (const platform of ["darwin", "linux", "win32"] as const)
      expect(appToolBridgeReachesLaunchOn(platform)).toBe(true);
    for (const platform of ["freebsd", "openbsd", "aix", "sunos"] as const)
      expect(appToolBridgeReachesLaunchOn(platform)).toBe(false);
  });
});
