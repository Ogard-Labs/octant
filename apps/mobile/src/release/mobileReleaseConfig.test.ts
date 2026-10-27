import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    readonly "android-internal"?: {
      readonly autoIncrement?: boolean;
      readonly credentialsSource?: string;
      readonly distribution?: string;
      readonly environment?: string;
      readonly android?: { readonly buildType?: string };
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

  it("names both camera uses wherever the camera reason is written, and asks for no location", () => {
    const pluginOptions = (name: string): Record<string, unknown> => {
      const entry = appConfig.plugins?.find(
        (plugin) => Array.isArray(plugin) && plugin[0] === name,
      );
      return Array.isArray(entry) ? (entry[1] as Record<string, unknown>) : {};
    };
    for (const plugin of ["expo-image-picker", "expo-camera"]) {
      const reason = String(pluginOptions(plugin).cameraPermission);
      expect(reason).toContain("pairing QR code");
      expect(reason).toContain("photo you attach to a thread");
    }
    expect(String(pluginOptions("expo-image-picker").photosPermission)).toContain(
      "attach a photo you choose to a thread",
    );
    const { blockedPermissions: _blocked, ...android } = appConfig.android ?? {};
    expect(JSON.stringify({ ...appConfig, android })).not.toMatch(/NSLocation|LOCATION/);
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

const androidWorkflow = readFileSync(
  join(mobileRoot, "..", "..", ".github", "workflows", "mobile-android-internal.yml"),
  "utf8",
);

async function appConfigForProfile(profile: string) {
  vi.resetModules();
  vi.stubEnv("EAS_BUILD_PROFILE", profile);
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("OCTANT_MOBILE_MOCK_SCENARIO", "full");
  return (await import("../../app.config")).default;
}

describe("mobile Android internal release configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds a signed APK for internal distribution from EAS-held credentials only", () => {
    expect(easConfig.build?.["android-internal"]).toEqual({
      autoIncrement: true,
      credentialsSource: "remote",
      distribution: "internal",
      environment: "production",
      android: { buildType: "apk" },
    });
    expect(appConfig.android?.package).toBe("app.octant.mobile");
  });

  it("carries no mock scenario into a release profile, whatever the environment says", async () => {
    expect((await appConfigForProfile("android-internal")).extra).not.toHaveProperty(
      "mobileMockScenario",
    );
    expect((await appConfigForProfile("production")).extra).not.toHaveProperty(
      "mobileMockScenario",
    );
    expect((await appConfigForProfile("a-profile-added-later")).extra).not.toHaveProperty(
      "mobileMockScenario",
    );
    expect((await appConfigForProfile("development")).extra).toHaveProperty(
      "mobileMockScenario",
      "full",
    );
  });

  it("keeps app data out of Android backups and blocks overlay and location permissions", () => {
    expect(appConfig.android?.allowBackup).toBe(false);
    expect(appConfig.android?.blockedPermissions).toEqual(
      expect.arrayContaining([
        "android.permission.SYSTEM_ALERT_WINDOW",
        "android.permission.ACCESS_FINE_LOCATION",
        "android.permission.ACCESS_COARSE_LOCATION",
        "android.permission.ACCESS_BACKGROUND_LOCATION",
        "android.permission.ACCESS_MEDIA_LOCATION",
      ]),
    );
  });

  it("dispatches by hand only, builds only from main, and reads the Expo token from its protected environment", () => {
    expect(androidWorkflow).toMatch(/^on:\n {2}workflow_dispatch:\n\n/m);
    expect(androidWorkflow).not.toMatch(/pull_request|push:|schedule:|workflow_run/);
    expect(androidWorkflow).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(androidWorkflow).toContain("if: github.ref == 'refs/heads/main'");
    expect(androidWorkflow).toContain("environment: mobile-android-internal");
    expect([...androidWorkflow.matchAll(/secrets\.([A-Z_]+)/g)].map((match) => match[1])).toEqual([
      "EXPO_TOKEN",
    ]);
    expect(androidWorkflow).toContain(
      "eas build --platform android --profile android-internal --non-interactive --wait --freeze-credentials --json",
    );
  });

  it("publishes no artifact and no install link in the repository's public logs", () => {
    expect(androidWorkflow).not.toMatch(/upload-artifact|actions\/cache/);
    expect(androidWorkflow).toMatch(
      />"\$RUNNER_TEMP\/eas-build\.json" 2>"\$RUNNER_TEMP\/eas-build\.log"/,
    );
    expect(androidWorkflow).toContain("-e 's#https?://[^[:space:]]+#<link withheld>#g'");
    expect(androidWorkflow).toContain("{12}#<id withheld>#g'");
    expect(androidWorkflow.match(/eas-build\.json/g)).toHaveLength(1);
  });
});
