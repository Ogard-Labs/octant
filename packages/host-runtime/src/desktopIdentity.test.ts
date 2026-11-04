import { describe, expect, it } from "vitest";
import {
  desktopIdentity,
  desktopIdentityForPackage,
  desktopWindowStorageDirectory,
  resolveDesktopPackageFlavor,
} from "./desktopIdentity";

describe("desktop application identity", () => {
  it("keeps Nightly's storage and host authority separate while stable preserves its existing paths", () => {
    const stable = desktopIdentity("stable");
    const nightly = desktopIdentity("nightly");
    expect(stable.mayStartHost).toBe(true);
    expect(nightly.mayStartHost).toBe(false);
    expect(desktopWindowStorageDirectory(stable, "/data/Octant", "/config")).toBe("/data/Octant");
    expect(desktopWindowStorageDirectory(nightly, "/data/Octant", "/config")).toBe(
      "/config/Octant Nightly",
    );
    expect(nightly).toMatchObject({
      productName: "Octant Nightly",
      bundleId: "app.octant.desktop.nightly",
      scheme: "octant-nightly",
      commandName: "octant-nightly",
      rings: ["preview", "candidate"],
    });
  });

  it("reads a package's identity instead of accepting the launch environment as its identity", () => {
    expect(
      desktopIdentityForPackage({
        octantDesktopFlavor: "nightly",
        version: "0.1.0-preview.20261103.1",
      }),
    ).toBe(desktopIdentity("nightly"));
    expect(desktopIdentityForPackage({ octantDesktopFlavor: "stable", version: "0.1.0" })).toBe(
      desktopIdentity("stable"),
    );
    expect(() =>
      desktopIdentityForPackage({ octantDesktopFlavor: "unknown", version: "0.1.0" }),
    ).toThrow();
    expect(() =>
      desktopIdentityForPackage({ octantDesktopFlavor: "nightly", version: "0.1.0" }),
    ).toThrow();
  });

  it.each([
    [{}, "0.1.0-preview.20261103.1"],
    [{ OCTANT_PACKAGE_FLAVOR: "nightly" }, "0.1.0"],
    [{ OCTANT_PACKAGE_FLAVOR: "nightly" }, "0.1.0-preview"],
    [{ OCTANT_PACKAGE_FLAVOR: "nightly" }, "0.1.0-other.20261103.1"],
  ])("refuses packaging a version under the wrong application identity", (environment, version) => {
    expect(() => resolveDesktopPackageFlavor(environment, version)).toThrow();
  });
});
