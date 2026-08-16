export type NotificationPermissionStatus = "granted" | "denied" | "undetermined";

export interface MobileNotificationPermissionPort {
  readonly getStatus: () => Promise<NotificationPermissionStatus>;
  readonly request: () => Promise<NotificationPermissionStatus>;
  readonly getDevicePushToken: () => Promise<string | undefined>;
  readonly platform: "ios" | "android";
}

/** Test double / Expo stub until native push credentials exist on device. */
export function createUnavailableNotificationPermissionPort(
  platform: "ios" | "android" = "ios",
): MobileNotificationPermissionPort {
  return {
    platform,
    async getStatus() {
      return "undetermined";
    },
    async request() {
      return "denied";
    },
    async getDevicePushToken() {
      return undefined;
    },
  };
}
