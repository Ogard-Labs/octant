export type NotificationPermissionStatus = "granted" | "denied" | "undetermined";

export interface MobileNotificationPermissionPort {
  readonly available: boolean;
  readonly getStatus: () => Promise<NotificationPermissionStatus>;
  readonly request: () => Promise<NotificationPermissionStatus>;
  readonly getDevicePushToken: () => Promise<string | undefined>;
  /**
   * The public half of this phone's notification key for one host, made and
   * kept in secure storage on first use. Undefined when the build has no key
   * storage for notifications.
   */
  readonly getNotificationPublicKey: (hostId: string) => Promise<string | undefined>;
  readonly platform: "ios" | "android";
}

/** Test double / Expo stub until native push credentials exist on device. */
export function createUnavailableNotificationPermissionPort(
  platform: "ios" | "android" = "ios",
): MobileNotificationPermissionPort {
  return {
    available: false,
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
    async getNotificationPublicKey() {
      return undefined;
    },
  };
}
