import { describe, expect, it } from "vitest";
import {
  decideScreenshotPrivacyMode,
  evaluateDeviceIntegrityHeuristic,
  isScreenshotSafeSurfaceCopy,
  MOBILE_REMOTE_CONTROL_THREAT_MODEL_ID,
  presentStaleHostSecurity,
  scrubScreenshotSafeCopy,
} from "./mobileHardeningPolicy";

describe("mobileHardeningPolicy", () => {
  it("keeps the threat model id stable", () => {
    expect(MOBILE_REMOTE_CONTROL_THREAT_MODEL_ID).toBe("mobile-remote-control-v1");
  });

  it("fails soft on suspicious integrity — never blocks mutations from policy alone", () => {
    const presentation = evaluateDeviceIntegrityHeuristic("suspicious");
    expect(presentation.severity).toBe("soft-warn");
    expect(presentation.blocksMutations).toBe(false);
    expect(presentation.message).toMatch(/jailbroken|rooted/i);
  });

  it("reports unavailable integrity without alarming", () => {
    expect(evaluateDeviceIntegrityHeuristic("unknown")).toMatchObject({
      severity: "none",
      blocksMutations: false,
    });
  });

  it("decides screenshot privacy modes", () => {
    expect(decideScreenshotPrivacyMode("hide-in-recents")).toMatchObject({
      preferNativeCaptureBlock: true,
      blurInAppSwitcher: true,
    });
    expect(decideScreenshotPrivacyMode("standard").preferNativeCaptureBlock).toBe(false);
  });

  it("presents stale and ready host security honestly", () => {
    expect(presentStaleHostSecurity("ready").allowProductMutations).toBe(true);
    expect(presentStaleHostSecurity("stale")).toMatchObject({
      allowProductMutations: false,
    });
    expect(presentStaleHostSecurity("unavailable").allowProductMutations).toBe(false);
  });

  it("scrubs secrets and paths from screenshot-safe copy", () => {
    expect(scrubScreenshotSafeCopy("token sk-abc123 leaked")).toBe(
      "Details available on the host.",
    );
    expect(scrubScreenshotSafeCopy("see /Users/example/secret/repo")).toBe(
      "Details available on the host.",
    );
    expect(isScreenshotSafeSurfaceCopy("Thread completed")).toBe(true);
    expect(isScreenshotSafeSurfaceCopy("password=hunter2")).toBe(false);
  });
});
