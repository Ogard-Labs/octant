export type NotificationPermissionStatus = "granted" | "denied" | "undetermined";

export interface MobileNotificationPermissionPort {
  /**
   * Whether this build and device can receive push at all. False on the
   * Simulator, on an iPhone too old to open sealed content, on an Android
   * build with no push project, and on the web, where the phone offers no
   * enablement.
   */
  readonly available: boolean;
  readonly getStatus: () => Promise<NotificationPermissionStatus>;
  readonly request: () => Promise<NotificationPermissionStatus>;
  /** The platform token, or undefined when the system gave none. */
  readonly getDevicePushToken: () => Promise<string | undefined>;
  /**
   * The public half of this phone's notification key for one host, made and
   * kept in secure storage on first use. The key binds the device id this
   * phone has with that host, because the host seals to both. Undefined when
   * the build has no key storage for notifications.
   */
  readonly getNotificationPublicKey: (
    hostId: string,
    deviceId: string,
  ) => Promise<string | undefined>;
  /**
   * Removes the notifications this phone shows for one computer and forgets
   * its notification key, so nothing that computer sealed can be opened
   * again. Runs when the computer is removed, revoked, or signed out of.
   */
  readonly forgetHost: (hostId: string) => Promise<void>;
  readonly platform: "ios" | "android";
}

/** Test double and the port for every build without the native push module. */
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
    async forgetHost() {},
  };
}
