// Native project changes the phone's push notifications need, applied when the
// iOS project is generated. The Android side needs none here: the module's
// own manifest declares the messaging service and permissions, and the Firebase
// project file is named in `app.config.ts` only when the build supplies it.
//
// Off unless the build asks for it. The push entitlement, App Group, and the
// keyless notification service extension need the push and App Group
// capabilities on the app's App ID; a build made before that would fail at
// signing. A build without push declares nothing, and the module reports push
// unavailable (`OctantPushEnabled` is absent from its Info.plist).
//
// On iOS this adds the Apple push entitlement to the app, a shared status App
// Group (`group.<bundleIdentifier>.status`, used for non-secret status and
// forgotten-host tracking — no Keychain group, no keys), and the keyless
// notification service extension target.

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  withEntitlementsPlist,
  withInfoPlist,
  withXcodeProject,
  type ConfigPlugin,
} from "expo/config-plugins";

export const NOTIFICATION_SERVICE_TARGET = "OctantNotificationService";
const APP_GROUP_SUFFIX = "status";
const EXTENSION_BUNDLE_SUFFIX = "notification-service";
const IOS_DEPLOYMENT_TARGET = "16.4";

/** Files shared with the app's module, then the extension's own, relative to the module. */
const SHARED_SOURCES = ["ios/DirectNotification.swift"] as const;
const EXTENSION_SOURCES = ["notification-service/NotificationService.swift"] as const;

function bundleIdentifierOf(config: { ios?: { bundleIdentifier?: string | undefined } }): string {
  const bundleIdentifier = config.ios?.bundleIdentifier;
  if (bundleIdentifier === undefined || bundleIdentifier.length === 0) {
    throw new Error("Push notifications need ios.bundleIdentifier to be set.");
  }
  return bundleIdentifier;
}

/** The shared non-secret status App Group (`group.app.octant.mobile.status`). */
export function statusAppGroup(bundleIdentifier: string): string {
  return `group.${bundleIdentifier}.${APP_GROUP_SUFFIX}`;
}

export function extensionBundleIdentifier(bundleIdentifier: string): string {
  return `${bundleIdentifier}.${EXTENSION_BUNDLE_SUFFIX}`;
}

/** The extension's entitlements file: the shared non-secret status App Group only. */
export function extensionEntitlements(bundleIdentifier: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>com.apple.security.application-groups</key>
	<array>
		<string>${statusAppGroup(bundleIdentifier)}</string>
	</array>
</dict>
</plist>
`;
}

/** Read by the push module: only a build made with the capability reports push supported. */
export const PUSH_ENABLED_INFO_KEY = "OctantPushEnabled";
export const STATUS_APP_GROUP_INFO_KEY = "OctantStatusAppGroup";

const withPushEntitlements: ConfigPlugin = (config) => {
  const bundleIdentifier = bundleIdentifierOf(config);
  const group = statusAppGroup(bundleIdentifier);
  // `development` here; signing a build for distribution replaces it with
  // `production`, which is the value Apple's push service expects for it.
  config = withEntitlementsPlist(config, (mod) => {
    mod.modResults["aps-environment"] ??= "development";
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
    mod.modResults[STATUS_APP_GROUP_INFO_KEY] = group;
    mod.modResults[PUSH_ENABLED_INFO_KEY] = true;
    return mod;
  });
};

const withNotificationServiceTarget: ConfigPlugin = (config) => {
  const bundleIdentifier = bundleIdentifierOf(config);
  const group = statusAppGroup(bundleIdentifier);
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
    ).replace("__STATUS_APP_GROUP__", group);
    writeFileSync(join(folder, "Info.plist"), infoPlist);
    const entitlementsName = `${NOTIFICATION_SERVICE_TARGET}.entitlements`;
    writeFileSync(join(folder, entitlementsName), extensionEntitlements(bundleIdentifier));

    const pbxGroup = project.addPbxGroup(
      [...sources, "Info.plist", entitlementsName],
      NOTIFICATION_SERVICE_TARGET,
      NOTIFICATION_SERVICE_TARGET,
    );
    const mainGroup = project.getFirstProject().firstProject.mainGroup;
    project.addToPbxGroup(pbxGroup.uuid, mainGroup);

    const target = project.addTarget(
      NOTIFICATION_SERVICE_TARGET,
      "app_extension",
      NOTIFICATION_SERVICE_TARGET,
      extensionBundleIdentifier(bundleIdentifier),
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
                    "com.apple.security.application-groups": [statusAppGroup(bundleIdentifier)],
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
