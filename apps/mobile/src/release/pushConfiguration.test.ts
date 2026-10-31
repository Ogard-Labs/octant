import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExpoConfig } from "expo/config";
import { compileModsAsync } from "expo/config-plugins";
import { afterEach, describe, expect, it, vi } from "vitest";
import appConfig from "../../app.config";
import withOctantPush, {
  extensionBundleIdentifier,
  extensionEntitlements,
  keychainAccessGroup,
} from "../../plugins/withOctantPush";

const mobileRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const group = "$(AppIdentifierPrefix)app.octant.mobile.notification-keys";

/** The configuration the build resolves, with the push plugin's changes applied. */
async function resolvedPushConfig(enabled: boolean) {
  return compileModsAsync(withOctantPush({ ...appConfig } as ExpoConfig, { enabled }), {
    projectRoot: mobileRoot,
    platforms: ["ios"],
    introspect: true,
  });
}

describe("mobile push notification configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("leaves the App ID's capabilities alone in a build made without the push capability", async () => {
    expect(appConfig.plugins).toContainEqual(["./plugins/withOctantPush", { enabled: false }]);
    const resolved = await resolvedPushConfig(false);
    expect(resolved.ios?.entitlements ?? {}).not.toHaveProperty("keychain-access-groups");
    expect(resolved.ios?.infoPlist ?? {}).not.toHaveProperty("OctantPushEnabled");
    expect(JSON.stringify(resolved.extra)).not.toContain("appExtensions");
  });

  it("turns the plugin on only when the build says it has the push capability", async () => {
    vi.resetModules();
    vi.stubEnv("OCTANT_MOBILE_PUSH", "1");
    const enabled = (await import("../../app.config")).default;
    expect(enabled.plugins).toContainEqual(["./plugins/withOctantPush", { enabled: true }]);
    vi.stubEnv("OCTANT_MOBILE_PUSH", "true");
    vi.resetModules();
    const other = (await import("../../app.config")).default;
    expect(other.plugins).toContainEqual(["./plugins/withOctantPush", { enabled: false }]);
  });

  it("shares one Keychain group between the app and its notification service extension, and tells EAS about the extension", async () => {
    const resolved = await resolvedPushConfig(true);
    expect(resolved.ios?.entitlements).toMatchObject({ "keychain-access-groups": [group] });
    expect(resolved.ios?.infoPlist).toMatchObject({
      OctantKeychainAccessGroup: group,
      OctantPushEnabled: true,
    });
    const extra = resolved.extra as {
      eas: { build: { experimental: { ios: { appExtensions: unknown[] } } } };
    };
    expect(extra.eas.build.experimental.ios.appExtensions).toEqual([
      {
        targetName: "OctantNotificationService",
        bundleIdentifier: "app.octant.mobile.notification-service",
        entitlements: { "keychain-access-groups": [group] },
      },
    ]);
  });

  it("gives the extension the app's Keychain group and nothing else", () => {
    expect(keychainAccessGroup("app.octant.mobile")).toBe(group);
    expect(extensionBundleIdentifier("app.octant.mobile")).toBe(
      "app.octant.mobile.notification-service",
    );
    const entitlements = extensionEntitlements("app.octant.mobile");
    expect(entitlements).toContain(group);
    expect(entitlements.match(/<key>/g)).toHaveLength(1);
  });

  it("refuses to build the extension for an app with no bundle identifier", () => {
    expect(() => withOctantPush({ name: "x", slug: "x" }, { enabled: true })).toThrow(
      "ios.bundleIdentifier",
    );
  });

  it("names a Firebase project file only when the build supplies one, never from the repository", async () => {
    expect(appConfig.android?.googleServicesFile).toBeUndefined();
    vi.resetModules();
    vi.stubEnv("GOOGLE_SERVICES_JSON", "/tmp/eas-file-variable/google-services.json");
    const supplied = (await import("../../app.config")).default;
    expect(supplied.android?.googleServicesFile).toBe(
      "/tmp/eas-file-variable/google-services.json",
    );
    expect(existsSync(join(mobileRoot, "google-services.json"))).toBe(false);
  });
});
