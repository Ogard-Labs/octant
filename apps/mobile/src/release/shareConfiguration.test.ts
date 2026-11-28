import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExpoConfig } from "expo/config";
import { compileModsAsync } from "expo/config-plugins";
import { describe, expect, it } from "vitest";
import appConfig from "../../app.config";
import withOctantShare, {
  SHARE_APP_GROUP_INFO_KEY,
  SHARE_EXTENSION_TARGET,
  SHARE_RECEIVER_ACTIVITY,
  shareAppGroup,
  shareExtensionBundleIdentifier,
  shareExtensionEntitlements,
} from "../../plugins/withOctantShare";

const mobileRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const expectedGroup = "group.app.octant.mobile.share";

async function resolvedShareConfig() {
  return compileModsAsync(withOctantShare({ ...appConfig } as ExpoConfig), {
    projectRoot: mobileRoot,
    platforms: ["ios", "android"],
    introspect: true,
  });
}

describe("mobile share extension and Android share target configuration", () => {
  it("registers the share config plugin in app.config.ts", () => {
    expect(appConfig.plugins).toContain("./plugins/withOctantShare");
  });

  it("adds a dedicated share App Group to the iOS app and EAS appExtensions without any Keychain group", async () => {
    const resolved = await resolvedShareConfig();
    expect(resolved.ios?.entitlements).toMatchObject({
      "com.apple.security.application-groups": [expectedGroup],
    });
    expect(resolved.ios?.entitlements ?? {}).not.toHaveProperty("keychain-access-groups");
    expect(resolved.ios?.infoPlist).toMatchObject({
      [SHARE_APP_GROUP_INFO_KEY]: expectedGroup,
    });

    const extra = resolved.extra as {
      eas: {
        build: { experimental: { ios: { appExtensions: ReadonlyArray<Record<string, unknown>> } } };
      };
    };
    expect(extra.eas.build.experimental.ios.appExtensions).toEqual([
      {
        targetName: SHARE_EXTENSION_TARGET,
        bundleIdentifier: "app.octant.mobile.share",
        entitlements: {
          "com.apple.security.application-groups": [expectedGroup],
        },
      },
    ]);
  });

  it("gives the iOS share extension only the share App Group entitlement and no Keychain access group", () => {
    expect(shareAppGroup("app.octant.mobile")).toBe(expectedGroup);
    expect(shareExtensionBundleIdentifier("app.octant.mobile")).toBe("app.octant.mobile.share");
    const entitlements = shareExtensionEntitlements("app.octant.mobile");
    expect(entitlements).toContain("com.apple.security.application-groups");
    expect(entitlements).toContain(expectedGroup);
    expect(entitlements).not.toContain("keychain-access-groups");
    expect(entitlements.match(/<key>/g)).toHaveLength(1);
  });

  it("refuses to build the share extension when ios.bundleIdentifier is absent", () => {
    expect(() => withOctantShare({ name: "x", slug: "x" })).toThrow("ios.bundleIdentifier");
  });

  it("registers the Android SEND and SEND_MULTIPLE receiver activity without adding permissions", async () => {
    const resolved = await resolvedShareConfig();
    const internal = (resolved as { readonly _internal?: { readonly modResults?: unknown } })
      ._internal;
    const modResults = internal?.modResults as
      | {
          readonly android?: {
            readonly manifest?: {
              readonly manifest?: {
                readonly application?: ReadonlyArray<{
                  readonly activity?: ReadonlyArray<{
                    readonly $?: Record<string, string>;
                    readonly "intent-filter"?: ReadonlyArray<{
                      readonly action?: ReadonlyArray<{ readonly $?: Record<string, string> }>;
                      readonly category?: ReadonlyArray<{ readonly $?: Record<string, string> }>;
                      readonly data?: ReadonlyArray<{ readonly $?: Record<string, string> }>;
                    }>;
                  }>;
                }>;
              };
            };
          };
        }
      | undefined;

    const activities = modResults?.android?.manifest?.manifest?.application?.[0]?.activity ?? [];
    const receiver = activities.find(
      (activity) => activity.$?.["android:name"] === SHARE_RECEIVER_ACTIVITY,
    );
    expect(receiver).toBeDefined();
    expect(receiver?.$?.["android:exported"]).toBe("true");
    expect(receiver?.$?.["android:permission"]).toBeUndefined();

    const actions = (receiver?.["intent-filter"] ?? []).flatMap((filter) =>
      (filter.action ?? []).map((action) => action.$?.["android:name"]),
    );
    expect(actions).toEqual(["android.intent.action.SEND", "android.intent.action.SEND_MULTIPLE"]);

    const moduleManifest = readFileSync(
      join(mobileRoot, "modules", "octant-share", "android", "src", "main", "AndroidManifest.xml"),
      "utf8",
    );
    expect(moduleManifest).not.toContain("uses-permission");
  });

  it("the extension stages shared items without reading any credential, session, host list, or network API", () => {
    const stripComments = (code: string): string =>
      code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const iosExtensionSource = readFileSync(
      join(mobileRoot, "modules", "octant-share", "share-extension", "ShareViewController.swift"),
      "utf8",
    );
    const iosExtensionPlist = readFileSync(
      join(mobileRoot, "modules", "octant-share", "share-extension", "Info.plist"),
      "utf8",
    );
    const androidReceiverSource = readFileSync(
      join(
        mobileRoot,
        "modules",
        "octant-share",
        "android",
        "src",
        "main",
        "java",
        "sh",
        "octant",
        "share",
        "ShareReceiverActivity.kt",
      ),
      "utf8",
    );

    const forbiddenPatterns: ReadonlyArray<RegExp> = [
      /\bSecItem\w*/i,
      /\bkeychain/i,
      /\bimport\s+Security\b/,
      /\bimport\s+Network\b/,
      /\bimport\s+CFNetwork\b/,
      /\bURLSession\b/,
      /\bNSURLSession\b/,
      /\bNWConnection\b/,
      /\bHttpURLConnection\b/,
      /\bOkHttp\b/,
      /\bjava\.net\.URL\b/,
      /\bopenConnection\b/,
      /\bKeyStore\b/,
      /\bEncryptedSharedPreferences\b/,
      /\bdeviceKey/i,
      /\bhostRegistry/i,
      /\bsessionCookie/i,
      /x-octant-device-proof/i,
      /\bauthenticatedFetch\b/,
      /\bUIApplication\.shared\b/,
      /\bopenURL\b/,
      /\bnextResponder\b/,
    ];

    for (const source of [
      stripComments(iosExtensionSource),
      iosExtensionPlist,
      stripComments(androidReceiverSource),
    ]) {
      for (const pattern of forbiddenPatterns) {
        expect(source).not.toMatch(pattern);
      }
    }

    // iOS saves and directs the person to open Octant; it never opens the app via responder chain.
    expect(iosExtensionSource).toContain("Saved. Open Octant to send.");
    expect(iosExtensionSource).toContain("completeFileProtectionUntilFirstUserAuthentication");
    expect(iosExtensionSource).toContain("isExcludedFromBackup = true");
    expect(iosExtensionPlist).toContain("com.apple.share-services");
    expect(iosExtensionPlist).toContain("__APP_GROUP__");

    // Android hands off strictly via bare `octant://share` scoped to this package.
    expect(androidReceiverSource).toContain('Uri.parse("octant://share")');
    expect(androidReceiverSource).toContain("setPackage(packageName)");
  });
});
