import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import appConfig from "../../app.config";

interface EasConfig {
  readonly cli?: {
    readonly appVersionSource?: string;
    readonly requireCommit?: boolean;
    readonly version?: string;
  };
  readonly build?: {
    readonly production?: {
      readonly autoIncrement?: boolean;
      readonly distribution?: string;
    };
  };
  readonly submit?: {
    readonly production?: {
      readonly ios?: {
        readonly ascAppId?: string;
      };
    };
  };
}

const mobileRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const easConfig = JSON.parse(readFileSync(join(mobileRoot, "eas.json"), "utf8")) as EasConfig;

describe("mobile TestFlight release configuration", () => {
  it("links the shipped app identity to the maintainer-owned stores", () => {
    expect(appConfig.owner).toBe("henrikogard");
    expect(appConfig.slug).toBe("octant-mobile");
    expect(appConfig.ios?.bundleIdentifier).toBe("app.octant.mobile");
    expect(appConfig.extra?.eas).toEqual({
      projectId: "348816ec-d222-4e6a-bc5c-1c2c89e4bff6",
    });
    expect(easConfig.submit?.production?.ios?.ascAppId).toBe("6813937035");
  });

  it("keeps production builds store-signed, monotonically versioned, and commit-bound", () => {
    expect(easConfig.cli).toMatchObject({
      appVersionSource: "remote",
      requireCommit: true,
    });
    expect(easConfig.build?.production).toMatchObject({
      autoIncrement: true,
      distribution: "store",
    });
  });

  it("declares export compliance and uses an opaque App Store icon", () => {
    expect(appConfig.ios?.config?.usesNonExemptEncryption).toBe(false);
    expect(appConfig.ios?.icon).toBe("./assets/icon-ios.png");

    const icon = readFileSync(join(mobileRoot, "assets", "icon-ios.png"));
    expect(icon.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(icon.readUInt32BE(16)).toBe(1024);
    expect(icon.readUInt32BE(20)).toBe(1024);
    expect([4, 6]).not.toContain(icon[25]);
    expect(icon.includes(Buffer.from("tRNS", "ascii"))).toBe(false);
  });
});
