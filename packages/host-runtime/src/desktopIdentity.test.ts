import { describe, expect, it } from "vitest";
import {
  decodeDesktopDataChoice,
  desktopDataDirectoriesOverlap,
  desktopIdentity,
  desktopIdentityForPackage,
  desktopWindowStorageDirectory,
  encodeDesktopDataChoice,
  resolveDesktopHostRole,
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
      rings: ["preview"],
      defaultRing: "preview",
    });
    expect(stable).toMatchObject({ rings: ["stable", "candidate"], defaultRing: "stable" });
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
    expect(
      desktopIdentityForPackage({
        octantDesktopFlavor: "stable",
        version: "0.1.0-candidate.20261105.2",
      }),
    ).toBe(desktopIdentity("stable"));
    expect(() =>
      desktopIdentityForPackage({ octantDesktopFlavor: "unknown", version: "0.1.0" }),
    ).toThrow();
    expect(() =>
      desktopIdentityForPackage({ octantDesktopFlavor: "nightly", version: "0.1.0" }),
    ).toThrow();
  });

  it.each([
    [{}, "0.1.0-preview.20261103.1"],
    [{ OCTANT_PACKAGE_FLAVOR: "stable" }, "0.1.0-preview.20261103.1"],
    [{ OCTANT_PACKAGE_FLAVOR: "nightly" }, "0.1.0"],
    [{ OCTANT_PACKAGE_FLAVOR: "nightly" }, "0.1.0-candidate.20261105.1"],
    [{}, "0.1.0-candidate"],
    [{ OCTANT_PACKAGE_FLAVOR: "nightly" }, "0.1.0-preview"],
    [{ OCTANT_PACKAGE_FLAVOR: "nightly" }, "0.1.0-other.20261103.1"],
  ])("refuses packaging a version under the wrong application identity", (environment, version) => {
    expect(() => resolveDesktopPackageFlavor(environment, version)).toThrow();
  });

  it.each([
    [{}, "0.1.0", "stable"],
    [{}, "0.1.0-candidate.20261105.1", "stable"],
    [{ OCTANT_PACKAGE_FLAVOR: "nightly" }, "0.1.0-preview.20261105.1", "nightly"],
  ])(
    "packages stable and candidate as Octant and preview as Nightly",
    (environment, version, flavor) => {
      expect(resolveDesktopPackageFlavor(environment, version)).toBe(flavor);
    },
  );

  describe("Nightly's Data choice", () => {
    const mac = { platform: "darwin" as const, home: "/Users/test", env: {} };

    it("keeps Octant the owner of its own host whatever a stored choice says", () => {
      expect(resolveDesktopHostRole(desktopIdentity("stable"), "test-data", mac)).toEqual({
        kind: "octant-host",
      });
      expect(resolveDesktopHostRole(desktopIdentity("stable"), "octant", mac)).toEqual({
        kind: "octant-host",
      });
    });

    it("connects Nightly to Octant's host unless separate test data was chosen", () => {
      expect(resolveDesktopHostRole(desktopIdentity("nightly"), "octant", mac)).toEqual({
        kind: "octant-client",
      });
    });

    it("gives Nightly's test host its own folder, port and Keychain services", () => {
      expect(resolveDesktopHostRole(desktopIdentity("nightly"), "test-data", mac)).toEqual({
        kind: "test-host",
        dataDirectory: "/Users/test/Library/Application Support/Octant Nightly/Test Data",
        serverPort: 13_774,
        keychainServiceFamily: "octant-nightly-test-data",
      });
      expect(
        resolveDesktopHostRole(desktopIdentity("nightly"), "test-data", {
          platform: "linux",
          home: "/home/test",
          env: {},
        }),
      ).toMatchObject({ dataDirectory: "/home/test/.local/share/octant-nightly/test-data" });
      expect(
        resolveDesktopHostRole(desktopIdentity("nightly"), "test-data", {
          platform: "linux",
          home: "/home/test",
          env: { XDG_DATA_HOME: "/data/xdg" },
        }),
      ).toMatchObject({ dataDirectory: "/data/xdg/octant-nightly/test-data" });
    });

    it.each([
      undefined,
      "",
      "not json",
      "[]",
      "null",
      '{"data":"octant"}',
      '{"data":"Test-Data"}',
      '{"data":"test-data","dataDirectory":"/Users/test/Library/Application Support/Octant"}',
      '{"data":true}',
    ])("reads a missing, malformed or unexpected choice %j as Octant's data", (raw) => {
      expect(decodeDesktopDataChoice(raw)).toBe("octant");
    });

    it("reads back the choice it stores", () => {
      expect(decodeDesktopDataChoice(encodeDesktopDataChoice("test-data"))).toBe("test-data");
      expect(decodeDesktopDataChoice(encodeDesktopDataChoice("octant"))).toBe("octant");
    });

    it("finds an overlap only by whole path segments", () => {
      const octant = "/Users/test/Library/Application Support/Octant";
      expect(desktopDataDirectoriesOverlap(octant, octant)).toBe(true);
      expect(desktopDataDirectoriesOverlap(`${octant}/Test Data`, octant)).toBe(true);
      expect(desktopDataDirectoriesOverlap(octant, `${octant}/Test Data`)).toBe(true);
      expect(desktopDataDirectoriesOverlap(`${octant}/../Octant/x`, octant)).toBe(true);
      expect(
        desktopDataDirectoriesOverlap(
          "/Users/test/Library/Application Support/Octant Nightly/Test Data",
          octant,
        ),
      ).toBe(false);
    });
  });
});
