import { describe, expect, it } from "vitest";
import { resolveReportedHostVersion } from "./reportedHostVersion";

describe("resolveReportedHostVersion", () => {
  it("reports the artifact version a packaged host was given", () => {
    expect(
      resolveReportedHostVersion({
        OCTANT_ARTIFACT_VERSION: "0.1.1",
        npm_package_version: "9.9.9",
      }),
    ).toBe("0.1.1");
  });

  it("reports 0.0.0-dev when a development run sets neither version", () => {
    expect(resolveReportedHostVersion({})).toBe("0.0.0-dev");
    expect(
      resolveReportedHostVersion({
        OCTANT_ARTIFACT_VERSION: "  ",
        npm_package_version: "",
      }),
    ).toBe("0.0.0-dev");
  });

  it("uses the development script's package version when no artifact version is set", () => {
    expect(resolveReportedHostVersion({ npm_package_version: " 1.4.2 " })).toBe("1.4.2");
  });

  it("ignores a version too long to store on the owner receipt", () => {
    expect(
      resolveReportedHostVersion({
        OCTANT_ARTIFACT_VERSION: "1".repeat(65),
        npm_package_version: "1.4.2",
      }),
    ).toBe("1.4.2");
  });
});
