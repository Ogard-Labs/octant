// Native project changes the phone's push notifications need, applied when the
// iOS project is generated. The Android side needs none here: the module's
// own manifest declares the messaging service, and the Firebase project file
// is named in `app.config.ts` only when the build supplies it.
//
// Off unless the build asks for it. The push entitlement and the extension
// need the push capability and Keychain sharing on the app's App ID, which the
// maintainer enables with the push accounts; a build made before that would
// fail at signing. A build without push declares nothing, and the module
// reports push unavailable (`OctantPushEnabled` is absent from its Info.plist).
//
// On iOS this adds the Apple push entitlement to the app, a Keychain access
// group shared by the app and the notification service extension (so the
// extension can read the keys the app makes), and the extension target. The
// extension's sources live in the push module and are copied in, so the
// module is the one place its Swift is written.

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  withEntitlementsPlist,
  withInfoPlist,
  withXcodeProject,
  type ConfigPlugin,
} from "expo/config-plugins";

export const NOTIFICATION_SERVICE_TARGET = "OctantNotificationService";
const KEYCHAIN_GROUP_SUFFIX = "notification-keys";
const EXTENSION_BUNDLE_SUFFIX = "notification-service";
const IOS_DEPLOYMENT_TARGET = "16.4";

/** Files shared with the app's module, then the extension's own, relative to the module. */
const SHARED_SOURCES = ["ios/SealedNotification.swift", "ios/NotificationKeyVault.swift"] as const;
const EXTENSION_SOURCES = ["notification-service/NotificationService.swift"] as const;

function bundleIdentifierOf(config: { ios?: { bundleIdentifier?: string | undefined } }): string {
  const bundleIdentifier = config.ios?.bundleIdentifier;
  if (bundleIdentifier === undefined || bundleIdentifier.length === 0) {
    throw new Error("Push notifications need ios.bundleIdentifier to be set.");
  }
  return bundleIdentifier;
}

/** The Keychain group, with the team prefix filled in by Xcode at build time. */
export function keychainAccessGroup(bundleIdentifier: string): string {
  return `$(AppIdentifierPrefix)${bundleIdentifier}.${KEYCHAIN_GROUP_SUFFIX}`;
}

export function extensionBundleIdentifier(bundleIdentifier: string): string {
  return `${bundleIdentifier}.${EXTENSION_BUNDLE_SUFFIX}`;
}

/** The extension's entitlements file: the shared Keychain group and nothing else. */
export function extensionEntitlements(bundleIdentifier: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>keychain-access-groups</key>
	<array>
		<string>${keychainAccessGroup(bundleIdentifier)}</string>
	</array>
</dict>
</plist>
`;
}

/** Read by the push module: only a build made with the capability reports push supported. */
export const PUSH_ENABLED_INFO_KEY = "OctantPushEnabled";

const withPushEntitlements: ConfigPlugin = (config) => {
  const bundleIdentifier = bundleIdentifierOf(config);
  // `development` here; signing a build for distribution replaces it with
  // `production`, which is the value Apple's push service expects for it.
  config = withEntitlementsPlist(config, (mod) => {
    mod.modResults["aps-environment"] ??= "development";
    const groups = new Set<string>(
      Array.isArray(mod.modResults["keychain-access-groups"])
        ? (mod.modResults["keychain-access-groups"] as string[])
        : [],
    );
    groups.add(keychainAccessGroup(bundleIdentifier));
    mod.modResults["keychain-access-groups"] = [...groups];
    return mod;
  });
  return withInfoPlist(config, (mod) => {
    mod.modResults.OctantKeychainAccessGroup = keychainAccessGroup(bundleIdentifier);
    mod.modResults[PUSH_ENABLED_INFO_KEY] = true;
    return mod;
  });
};

const withNotificationServiceTarget: ConfigPlugin = (config) => {
  const bundleIdentifier = bundleIdentifierOf(config);
  const teamId = config.ios?.appleTeamId;
  return withXcodeProject(config, (mod) => {
    const project = mod.modResults;
    // Prebuild can run over a project it already changed.
    if (project.pbxTargetByName(NOTIFICATION_SERVICE_TARGET)) return mod;

    const moduleRoot = join(mod.modRequest.projectRoot, "modules", "octant-push");
    const folder = join(mod.modRequest.platformProjectRoot, NOTIFICATION_SERVICE_TARGET);
    mkdirSync(folder, { recursive: true });
    const sources: string[] = [];
    for (const source of [...SHARED_SOURCES, ...EXTENSION_SOURCES]) {
      const name = source.slice(source.lastIndexOf("/") + 1);
      copyFileSync(join(moduleRoot, source), join(folder, name));
      sources.push(name);
    }
    const infoPlist = readFileSync(
      join(moduleRoot, "notification-service", "Info.plist"),
      "utf8",
    ).replace("__KEYCHAIN_ACCESS_GROUP__", keychainAccessGroup(bundleIdentifier));
    writeFileSync(join(folder, "Info.plist"), infoPlist);
    const entitlementsName = `${NOTIFICATION_SERVICE_TARGET}.entitlements`;
    writeFileSync(join(folder, entitlementsName), extensionEntitlements(bundleIdentifier));

    const group = project.addPbxGroup(
      [...sources, "Info.plist", entitlementsName],
      NOTIFICATION_SERVICE_TARGET,
      NOTIFICATION_SERVICE_TARGET,
    );
    const mainGroup = project.getFirstProject().firstProject.mainGroup;
    project.addToPbxGroup(group.uuid, mainGroup);

    const target = project.addTarget(
      NOTIFICATION_SERVICE_TARGET,
      "app_extension",
      NOTIFICATION_SERVICE_TARGET,
      extensionBundleIdentifier(bundleIdentifier),
    );
    // The app embeds the extension's product, so it must be built first. A
    // generated project has no dependency sections yet, and the library adds a
    // dependency only to sections that exist.
    const objects = project.hash.project.objects;
    objects.PBXTargetDependency ??= {};
    objects.PBXContainerItemProxy ??= {};
    project.addTargetDependency(project.getFirstTarget().uuid, [target.uuid]);
    project.addBuildPhase(sources, "PBXSourcesBuildPhase", "Sources", target.uuid);
    project.addBuildPhase([], "PBXResourcesBuildPhase", "Resources", target.uuid);
    project.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", target.uuid);

    // The extension carries the app's version, which the App Store requires.
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
      if (settings.PRODUCT_NAME !== `"${NOTIFICATION_SERVICE_TARGET}"`) continue;
      settings.PRODUCT_BUNDLE_IDENTIFIER = `"${extensionBundleIdentifier(bundleIdentifier)}"`;
      settings.INFOPLIST_FILE = `"${NOTIFICATION_SERVICE_TARGET}/Info.plist"`;
      settings.CODE_SIGN_ENTITLEMENTS = `"${NOTIFICATION_SERVICE_TARGET}/${entitlementsName}"`;
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

/**
 * Tells EAS about the extension so it registers the extension's identifier and
 * signs it with the app: without this a managed build signs only the app and
 * the extension is left out of the provisioning.
 */
const withExtensionCredentials: ConfigPlugin = (config) => {
  const bundleIdentifier = bundleIdentifierOf(config);
  const eas = (config.extra?.eas ?? {}) as Record<string, unknown>;
  const build = (eas.build ?? {}) as Record<string, unknown>;
  const experimental = (build.experimental ?? {}) as Record<string, unknown>;
  const ios = (experimental.ios ?? {}) as Record<string, unknown>;
  const existing = Array.isArray(ios.appExtensions) ? (ios.appExtensions as unknown[]) : [];
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
                ...existing,
                {
                  targetName: NOTIFICATION_SERVICE_TARGET,
                  bundleIdentifier: extensionBundleIdentifier(bundleIdentifier),
                  entitlements: {
                    "keychain-access-groups": [keychainAccessGroup(bundleIdentifier)],
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

const withOctantPush: ConfigPlugin<{ readonly enabled?: boolean } | void> = (config, options) =>
  options?.enabled === true
    ? withExtensionCredentials(withNotificationServiceTarget(withPushEntitlements(config)))
    : config;

export default withOctantPush;
