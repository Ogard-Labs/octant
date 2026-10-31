import {
  createUnavailableNotificationPermissionPort,
  type MobileNotificationPermissionPort,
} from "./notificationPermissionPort";

/**
 * The web build has no push token and no notification key, so the port stays
 * unavailable. The phone build uses the native module (`.native.ts`).
 */
export const mobileNotificationPort: MobileNotificationPermissionPort =
  createUnavailableNotificationPermissionPort();
