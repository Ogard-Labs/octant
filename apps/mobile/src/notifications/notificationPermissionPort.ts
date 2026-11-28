export type NotificationPermissionStatus = "granted" | "denied" | "undetermined";

export interface MobileNotificationPermissionPort {
  /**
   * Whether this build and device can receive push at all. False on the
   * Simulator, in an iOS build made without the push capability, on an Android
   * build with no push project, and on the web, where the phone offers no
   * enablement.
   */
  readonly available: boolean;
  readonly getStatus: () => Promise<NotificationPermissionStatus>;
  readonly request: () => Promise<NotificationPermissionStatus>;
  /** The platform token, or undefined when the system gave none. */
  readonly getDevicePushToken: () => Promise<string | undefined>;
  /**
   * Clears a computer from this phone's forgotten-host list when the person
   * turns notifications on for it again.
   */
  readonly allowHost?: (hostId: string) => Promise<void>;
  /**
   * Removes the notifications this phone shows for one computer and marks it
   * forgotten so late alerts from it are hidden or dropped. Runs when the
   * computer is removed, revoked, signed out of, or notifications are turned
   * off.
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
    async allowHost() {},
    async forgetHost() {},
  };
}
