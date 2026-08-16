import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  ALLOWED_BROKER_ENTITLEMENTS,
  ALLOWED_GATE_ENTITLEMENTS,
  WORK_CONFINEMENT_SIGNING_ORDER,
  workConfinementArchitectureArgs,
  workConfinementBundlePaths,
  workConfinementSigningOrder,
  entitlementKeys,
  exactPeerRequirement,
  foreignClientInfoPlist,
  validateWorkConfinementEntitlements,
  validateWorkConfinementInfoPlists,
} from "./package-work-confinement-gate";

describe("Work confinement feasibility packaging", () => {
  it("assembles the exact disposable app, XPC service, and foreign client layout", () => {
    expect(workConfinementBundlePaths("/tmp/proof")).toEqual({
      appBundle: "/tmp/proof/Octant Work Confinement Gate.app",
      appExecutable:
        "/tmp/proof/Octant Work Confinement Gate.app/Contents/MacOS/OctantWorkConfinementGate",
      brokerBundle:
        "/tmp/proof/Octant Work Confinement Gate.app/Contents/XPCServices/OctantWorkConfinementBroker.xpc",
      brokerExecutable:
        "/tmp/proof/Octant Work Confinement Gate.app/Contents/XPCServices/OctantWorkConfinementBroker.xpc/Contents/MacOS/OctantWorkConfinementBroker",
      foreignBundle:
        "/tmp/proof/Octant Work Confinement Gate.app/Contents/XPCServices/OctantWorkConfinementForeignClient.xpc",
      foreignClient:
        "/tmp/proof/Octant Work Confinement Gate.app/Contents/XPCServices/OctantWorkConfinementForeignClient.xpc/Contents/MacOS/OctantWorkConfinementForeignClient",
    });
  });

  it("signs child executables before the containing host app", () => {
    expect(WORK_CONFINEMENT_SIGNING_ORDER).toEqual(["foreignBundle", "brokerBundle", "appBundle"]);
    expect(workConfinementSigningOrder("/tmp/Octant Work Confinement Gate.app")).toEqual([
      "/tmp/Octant Work Confinement Gate.app/Contents/XPCServices/OctantWorkConfinementForeignClient.xpc",
      "/tmp/Octant Work Confinement Gate.app/Contents/XPCServices/OctantWorkConfinementBroker.xpc",
      "/tmp/Octant Work Confinement Gate.app",
    ]);
  });

  it("generates the foreign probe as a second private XPC service", () => {
    expect(foreignClientInfoPlist()).toEqual({
      CFBundleExecutable: "OctantWorkConfinementForeignClient",
      CFBundleIdentifier: "app.octant.desktop.work-confinement-gate.foreign-client",
      CFBundleInfoDictionaryVersion: "6.0",
      CFBundleName: "Octant Work Confinement Foreign Client",
      CFBundlePackageType: "XPC!",
      CFBundleShortVersionString: "0.0.0",
      CFBundleVersion: "1",
      LSMinimumSystemVersion: "14.0",
      XPCService: { ServiceType: "Application" },
    });
  });

  it("passes the input before lipo's architecture verification command", () => {
    expect(workConfinementArchitectureArgs("/tmp/proof/executable")).toEqual([
      "lipo",
      "/tmp/proof/executable",
      "-verify_arch",
      "arm64",
    ]);
  });

  it("builds a strict identifier and lowercase cdhash requirement", () => {
    expect(exactPeerRequirement("app.octant.desktop.peer", "A1B2c3")).toBe(
      'identifier "app.octant.desktop.peer" and cdhash H"a1b2c3"',
    );
    expect(() => exactPeerRequirement("app.octant.desktop.peer", "not-a-hash")).toThrow(
      "invalid cdhash",
    );
  });

  it("allows only the sandbox and narrowly required file entitlements", () => {
    expect(ALLOWED_GATE_ENTITLEMENTS).toEqual([
      "com.apple.security.app-sandbox",
      "com.apple.security.files.user-selected.read-write",
    ]);
    expect(ALLOWED_BROKER_ENTITLEMENTS).toEqual([
      "com.apple.security.app-sandbox",
      "com.apple.security.files.user-selected.read-write",
      "com.apple.security.files.bookmarks.app-scope",
    ]);

    expect(() =>
      validateWorkConfinementEntitlements(
        {
          "com.apple.security.app-sandbox": true,
          "com.apple.security.files.user-selected.read-write": true,
        },
        ALLOWED_GATE_ENTITLEMENTS,
      ),
    ).not.toThrow();
    expect(() =>
      validateWorkConfinementEntitlements(
        {
          "com.apple.security.app-sandbox": true,
          "com.apple.security.network.client": true,
        },
        ALLOWED_GATE_ENTITLEMENTS,
      ),
    ).toThrow("forbidden entitlement com.apple.security.network.client");
  });

  it("reads the exact source entitlement keys", async () => {
    const sourceRoot = resolve(import.meta.dirname, "../apps/desktop/native/work-confinement-gate");
    await expect(
      entitlementKeys(resolve(sourceRoot, "OctantWorkConfinementGate.entitlements")),
    ).resolves.toEqual([
      "com.apple.security.app-sandbox",
      "com.apple.security.files.user-selected.read-write",
    ]);
    await expect(
      entitlementKeys(resolve(sourceRoot, "OctantWorkConfinementBroker.entitlements")),
    ).resolves.toEqual([
      "com.apple.security.app-sandbox",
      "com.apple.security.files.user-selected.read-write",
      "com.apple.security.files.bookmarks.app-scope",
    ]);
  });

  it("requires exact executable names, identities, UI-agent behavior, and macOS 14", () => {
    expect(() =>
      validateWorkConfinementInfoPlists(
        {
          CFBundleExecutable: "OctantWorkConfinementGate",
          CFBundleIdentifier: "app.octant.desktop.work-confinement-gate",
          CFBundlePackageType: "APPL",
          LSMinimumSystemVersion: "14.0",
          LSUIElement: true,
        },
        {
          CFBundleExecutable: "OctantWorkConfinementBroker",
          CFBundleIdentifier: "app.octant.desktop.work-confinement-gate.broker",
          CFBundlePackageType: "XPC!",
          LSMinimumSystemVersion: "14.0",
          XPCService: { ServiceType: "Application" },
        },
      ),
    ).not.toThrow();

    expect(() =>
      validateWorkConfinementInfoPlists(
        {
          CFBundleExecutable: "wrong",
          CFBundleIdentifier: "app.octant.desktop.work-confinement-gate",
          CFBundlePackageType: "APPL",
          LSMinimumSystemVersion: "14.0",
          LSUIElement: true,
        },
        {
          CFBundleExecutable: "OctantWorkConfinementBroker",
          CFBundleIdentifier: "app.octant.desktop.work-confinement-gate.broker",
          CFBundlePackageType: "XPC!",
          LSMinimumSystemVersion: "14.0",
          XPCService: { ServiceType: "Application" },
        },
      ),
    ).toThrow("invalid host Info.plist");
  });
});
