import { describe, expect, it } from "vitest";
import {
  decideScreenshotPrivacyMode,
  evaluateDeviceIntegrityHeuristic,
  presentStaleHostSecurity,
} from "@octant/domain";
import { createUnavailableDeviceIntegrityPort } from "./deviceIntegrityPort";
import { createUnavailableScreenshotPrivacyPort } from "./screenshotPrivacyPort";

describe("mobile hardening ports", () => {
  it("integrity stub reports unknown and maps to non-blocking presentation", async () => {
    const port = createUnavailableDeviceIntegrityPort();
    const signal = await port.probe();
    expect(signal).toBe("unknown");
    expect(evaluateDeviceIntegrityHeuristic(signal).blocksMutations).toBe(false);
  });

  it("screenshot privacy stub stores preference and reports native apply unavailable", async () => {
    const port = createUnavailableScreenshotPrivacyPort("standard");
    await port.setMode("hide-in-recents");
    expect(await port.getMode()).toBe("hide-in-recents");
    expect(await port.apply("hide-in-recents")).toBe("unavailable");
    expect(decideScreenshotPrivacyMode("hide-in-recents").preferNativeCaptureBlock).toBe(true);
  });

  it("stale host presentation blocks mutations while ready allows them", () => {
    expect(presentStaleHostSecurity("stale").allowProductMutations).toBe(false);
    expect(presentStaleHostSecurity("ready").allowProductMutations).toBe(true);
  });
});
