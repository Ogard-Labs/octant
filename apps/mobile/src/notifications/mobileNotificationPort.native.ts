import { requireOptionalNativeModule } from "expo";
import { PermissionsAndroid, Platform } from "react-native";
import type { MobileNotificationPermissionPort } from "./notificationPermissionPort";
import {
  createNativeNotificationPermissionPort,
  type OctantPushNativeModule,
} from "./octantPushModule";

const native = requireOptionalNativeModule<OctantPushNativeModule>("OctantPush");

/** Android 13 added a run-time notification permission; earlier releases have none to ask. */
async function requestAndroidRuntimePermission(): Promise<boolean> {
  if (typeof Platform.Version !== "number" || Platform.Version < 33) return true;
  const answer = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
  );
  return answer === PermissionsAndroid.RESULTS.GRANTED;
}

/**
 * The phone's notification port: the in-tree native module, which reports
 * itself unsupported on the Simulator, on an iPhone older than iOS 17, and on
 * an Android build with no push project. A build without the module (Expo Go)
 * gets the unavailable port.
 */
export const mobileNotificationPort: MobileNotificationPermissionPort =
  createNativeNotificationPermissionPort(native, {
    platform: Platform.OS === "android" ? "android" : "ios",
    ...(Platform.OS === "android"
      ? { requestRuntimePermission: requestAndroidRuntimePermission }
      : {}),
  });
