// Native project changes for sharing text, links, images, and files into
// Octant from other apps on iOS and Android.
//
// On iOS this adds a dedicated App Group (`group.<bundleId>.share`) shared
// between the main app and the `OctantShareExtension` share extension target,
// and registers the extension in EAS `appExtensions`. The target name stays
// distinct from the `OctantShare` CocoaPods module so Xcode does not shadow
// `OctantShareModule` when compiling `ExpoModulesProvider.swift`. The extension
// receives ONLY the App Group entitlement — no Keychain group, no device keys,
// no sessions, no host list, and no network code.
//
// On Android this registers `sh.octant.share.ShareReceiverActivity` with
// `SEND` and `SEND_MULTIPLE` intent filters and no extra permissions.

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  withAndroidManifest,
  withEntitlementsPlist,
  withInfoPlist,
  withXcodeProject,
  type ConfigPlugin,
} from "expo/config-plugins";

export const SHARE_EXTENSION_TARGET = "OctantShareExtension";
export const SHARE_APP_GROUP_INFO_KEY = "OctantShareAppGroup";
export const SHARE_RECEIVER_ACTIVITY = "sh.octant.share.ShareReceiverActivity";
const EXTENSION_BUNDLE_SUFFIX = "share";
const IOS_DEPLOYMENT_TARGET = "16.4";

const EXTENSION_SOURCES = ["share-extension/ShareViewController.swift"] as const;

function bundleIdentifierOf(config: { ios?: { bundleIdentifier?: string | undefined } }): string {
  const bundleIdentifier = config.ios?.bundleIdentifier;
  if (bundleIdentifier === undefined || bundleIdentifier.length === 0) {
    throw new Error("Sharing into Octant needs ios.bundleIdentifier to be set.");
  }
  return bundleIdentifier;
}

/** Dedicated App Group for share staging alone (`group.app.octant.mobile.share`). */
export function shareAppGroup(bundleIdentifier: string): string {
  return `group.${bundleIdentifier}.${EXTENSION_BUNDLE_SUFFIX}`;
}

export function shareExtensionBundleIdentifier(bundleIdentifier: string): string {
  return `${bundleIdentifier}.${EXTENSION_BUNDLE_SUFFIX}`;
}

/**
 * The share extension's entitlements file: the dedicated share App Group and
 * nothing else (explicitly no Keychain access group).
 */
export function shareExtensionEntitlements(bundleIdentifier: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>com.apple.security.application-groups</key>
	<array>
		<string>${shareAppGroup(bundleIdentifier)}</string>
	</array>
</dict>
</plist>
`;
}

const withShareEntitlements: ConfigPlugin = (config) => {
  const bundleIdentifier = bundleIdentifierOf(config);
  const group = shareAppGroup(bundleIdentifier);
  config = withEntitlementsPlist(config, (mod) => {
    const groups = new Set<string>(
      Array.isArray(mod.modResults["com.apple.security.application-groups"])
        ? (mod.modResults["com.apple.security.application-groups"] as string[])
        : [],
    );
    groups.add(group);
    mod.modResults["com.apple.security.application-groups"] = [...groups];
    return mod;
  });
  return withInfoPlist(config, (mod) => {
    mod.modResults[SHARE_APP_GROUP_INFO_KEY] = group;
    return mod;
  });
};

const withShareExtensionTarget: ConfigPlugin = (config) => {
  const bundleIdentifier = bundleIdentifierOf(config);
  const teamId = config.ios?.appleTeamId;
  return withXcodeProject(config, (mod) => {
    const project = mod.modResults;
    if (project.pbxTargetByName(SHARE_EXTENSION_TARGET)) return mod;

    const moduleRoot = join(mod.modRequest.projectRoot, "modules", "octant-share");
    const folder = join(mod.modRequest.platformProjectRoot, SHARE_EXTENSION_TARGET);
    mkdirSync(folder, { recursive: true });
    const sources: string[] = [];
    for (const source of EXTENSION_SOURCES) {
      const name = source.slice(source.lastIndexOf("/") + 1);
      copyFileSync(join(moduleRoot, source), join(folder, name));
      sources.push(name);
    }
    const infoPlist = readFileSync(
      join(moduleRoot, "share-extension", "Info.plist"),
      "utf8",
    ).replace("__APP_GROUP__", shareAppGroup(bundleIdentifier));
    writeFileSync(join(folder, "Info.plist"), infoPlist);
    const entitlementsName = `${SHARE_EXTENSION_TARGET}.entitlements`;
    writeFileSync(join(folder, entitlementsName), shareExtensionEntitlements(bundleIdentifier));

    const group = project.addPbxGroup(
      [...sources, "Info.plist", entitlementsName],
      SHARE_EXTENSION_TARGET,
      SHARE_EXTENSION_TARGET,
    );
    const mainGroup = project.getFirstProject().firstProject.mainGroup;
    project.addToPbxGroup(group.uuid, mainGroup);

    const target = project.addTarget(
      SHARE_EXTENSION_TARGET,
      "app_extension",
      SHARE_EXTENSION_TARGET,
      shareExtensionBundleIdentifier(bundleIdentifier),
    );
    const objects = project.hash.project.objects;
    objects.PBXTargetDependency ??= {};
    objects.PBXContainerItemProxy ??= {};
    project.addTargetDependency(project.getFirstTarget().uuid, [target.uuid]);
    project.addBuildPhase(sources, "PBXSourcesBuildPhase", "Sources", target.uuid);
    project.addBuildPhase([], "PBXResourcesBuildPhase", "Resources", target.uuid);
    project.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", target.uuid);

    const allSettings = Object.values(
      project.pbxXCBuildConfigurationSection() as Record<string, unknown>,
    ).flatMap((entry) => {
      const settings = (entry as { buildSettings?: Record<string, string> } | null)?.buildSettings;
      return settings === undefined ? [] : [settings];
    });
    const appSettings = allSettings.find(
      (settings) => settings.PRODUCT_BUNDLE_IDENTIFIER === `"${bundleIdentifier}"`,
    );
    for (const settings of allSettings) {
      if (settings.PRODUCT_NAME !== `"${SHARE_EXTENSION_TARGET}"`) continue;
      settings.PRODUCT_BUNDLE_IDENTIFIER = `"${shareExtensionBundleIdentifier(bundleIdentifier)}"`;
      settings.INFOPLIST_FILE = `"${SHARE_EXTENSION_TARGET}/Info.plist"`;
      settings.CODE_SIGN_ENTITLEMENTS = `"${SHARE_EXTENSION_TARGET}/${entitlementsName}"`;
      settings.IPHONEOS_DEPLOYMENT_TARGET = IOS_DEPLOYMENT_TARGET;
      settings.SWIFT_VERSION = "5.0";
      settings.TARGETED_DEVICE_FAMILY = '"1,2"';
      settings.CODE_SIGN_STYLE = "Automatic";
      if (teamId !== undefined) settings.DEVELOPMENT_TEAM = teamId;
      for (const inherited of ["MARKETING_VERSION", "CURRENT_PROJECT_VERSION"] as const) {
        const value = appSettings?.[inherited];
        if (value !== undefined) settings[inherited] = value;
      }
    }
    return mod;
  });
};

const withShareExtensionCredentials: ConfigPlugin = (config) => {
  const bundleIdentifier = bundleIdentifierOf(config);
  const eas = (config.extra?.eas ?? {}) as Record<string, unknown>;
  const build = (eas.build ?? {}) as Record<string, unknown>;
  const experimental = (build.experimental ?? {}) as Record<string, unknown>;
  const ios = (experimental.ios ?? {}) as Record<string, unknown>;
  const existing = Array.isArray(ios.appExtensions) ? (ios.appExtensions as unknown[]) : [];
  const filtered = existing.filter(
    (entry) =>
      typeof entry !== "object" ||
      entry === null ||
      (entry as { targetName?: unknown }).targetName !== SHARE_EXTENSION_TARGET,
  );
  return {
    ...config,
    extra: {
      ...config.extra,
      eas: {
        ...eas,
        build: {
          ...build,
          experimental: {
            ...experimental,
            ios: {
              ...ios,
              appExtensions: [
                ...filtered,
                {
                  targetName: SHARE_EXTENSION_TARGET,
                  bundleIdentifier: shareExtensionBundleIdentifier(bundleIdentifier),
                  entitlements: {
                    "com.apple.security.application-groups": [shareAppGroup(bundleIdentifier)],
                  },
                },
              ],
            },
          },
        },
      },
    },
  };
};

const withAndroidShareIntentFilters: ConfigPlugin = (config) => {
  return withAndroidManifest(config, (mod) => {
    const application = mod.modResults.manifest.application?.[0];
    if (application === undefined) return mod;
    application.activity ??= [];
    const alreadyPresent = application.activity.some(
      (activity) => activity.$?.["android:name"] === SHARE_RECEIVER_ACTIVITY,
    );
    if (!alreadyPresent) {
      application.activity.push({
        $: {
          "android:name": SHARE_RECEIVER_ACTIVITY,
          "android:exported": "true",
          "android:noHistory": "true",
          "android:excludeFromRecents": "true",
          "android:theme": "@android:style/Theme.Translucent.NoTitleBar",
        },
        "intent-filter": [
          {
            action: [{ $: { "android:name": "android.intent.action.SEND" } }],
            category: [{ $: { "android:name": "android.intent.category.DEFAULT" } }],
            data: [{ $: { "android:mimeType": "*/*" } }],
          },
          {
            action: [{ $: { "android:name": "android.intent.action.SEND_MULTIPLE" } }],
            category: [{ $: { "android:name": "android.intent.category.DEFAULT" } }],
            data: [{ $: { "android:mimeType": "*/*" } }],
          },
        ],
      });
    }
    return mod;
  });
};

const withOctantShare: ConfigPlugin = (config) =>
  withAndroidShareIntentFilters(
    withShareExtensionCredentials(withShareExtensionTarget(withShareEntitlements(config))),
  );

export default withOctantShare;
