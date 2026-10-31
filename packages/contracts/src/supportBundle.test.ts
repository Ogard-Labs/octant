import { describe, expect, it } from "vitest";
import {
  decodeSupportBundleExportRequest,
  decodeSupportBundleExported,
  decodeSupportBundleOutcome,
} from "./supportBundle";

const receipt = {
  bundleId: "00000000-0000-4000-8000-000000000001",
  exportedAt: "2026-10-31T10:00:00.000Z",
  destinationCategory: "downloads",
  sections: ["versions", "system"],
  fileCount: 3,
  byteCount: 1200,
};

describe("support bundle contract", () => {
  it("names where a bundle went by category and refuses a path", () => {
    expect(decodeSupportBundleExportRequest({ destinationCategory: "desktop" })).toEqual({
      destinationCategory: "desktop",
    });
    expect(() =>
      decodeSupportBundleExportRequest({
        destinationCategory: "desktop",
        path: "/Users/ada/Desktop",
      }),
    ).toThrow();
    expect(() =>
      decodeSupportBundleExportRequest({ destinationCategory: "/Users/ada/Desktop" }),
    ).toThrow();
  });

  it("keeps the journal payload to the receipt", () => {
    expect(decodeSupportBundleExported({ receipt })).toEqual({ receipt });
    expect(() => decodeSupportBundleExported({ receipt, files: [] })).toThrow();
  });

  it("refuses a file path that climbs out of the bundle", () => {
    const outcome = (path: string) =>
      decodeSupportBundleOutcome({
        kind: "exported",
        files: [{ path, contents: "{}" }],
        receipt,
      });
    expect(outcome("versions.json").kind).toBe("exported");
    expect(() => outcome("../versions.json")).toThrow();
    expect(() => outcome("/etc/passwd")).toThrow();
  });
});
