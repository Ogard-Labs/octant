import type {
  MobileNotificationPermissionPort,
  NotificationPermissionStatus,
} from "./notificationPermissionPort";

/**
 * The in-tree module (`modules/octant-push`), with an Android and an iOS side.
 * Every answer crosses as `unknown` because a damaged or older module must
 * read as unavailable, never as a token or a granted permission.
 */
export interface OctantPushNativeModule {
  readonly isSupported: () => unknown;
  /** Answers `granted`, `denied`, or `undetermined`. */
  readonly permissionStatus: () => Promise<unknown>;
  /** Asks the system on iOS; on Android only reads the setting. */
  readonly requestPermission: () => Promise<unknown>;
  /** The platform token as text, or nothing when the system gave none. */
  readonly devicePushToken: () => Promise<unknown>;
  readonly notificationPublicKey: (hostId: string, deviceId: string) => Promise<unknown>;
  readonly forgetHost: (hostId: string) => Promise<unknown>;
}

const NOTIFICATION_PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
/** The same bound the host puts on a registered token (`RemotePushToken`). */
const PLATFORM_TOKEN_MAX_BYTES = 4_096;

function permissionStatus(answer: unknown): NotificationPermissionStatus | undefined {
  return answer === "granted" || answer === "denied" || answer === "undetermined"
    ? answer
    : undefined;
}

/**
 * The notification port over the native module. It fails closed: a module
 * that is missing, reports itself unsupported, throws, or answers in a shape
 * it was not built to answer gives no permission, no token, and no key. The
 * Simulator, a denied permission, and a missing token each arrive here as a
 * refusal the enable flow names, never as a registration of nothing.
 */
export function createNativeNotificationPermissionPort(
  native: OctantPushNativeModule | null,
  options: {
    readonly platform: "ios" | "android";
    /**
     * Android 13 and later ask at run time before the setting can be on; the
     * platform's own prompt runs here, then the module reads the setting.
     */
    readonly requestRuntimePermission?: () => Promise<boolean>;
  },
): MobileNotificationPermissionPort {
  const supported = (): boolean => {
    if (native === null) return false;
    try {
      return native.isSupported() === true;
    } catch {
      return false;
    }
  };
  const available = supported();

  return {
    available,
    platform: options.platform,
    async getStatus() {
      if (native === null || !available) return "undetermined";
      try {
        return permissionStatus(await native.permissionStatus()) ?? "undetermined";
      } catch {
        return "undetermined";
      }
    },
    async request() {
      if (native === null || !available) return "denied";
      try {
        if (options.requestRuntimePermission !== undefined) {
          if (!(await options.requestRuntimePermission())) return "denied";
        }
        const status = permissionStatus(await native.requestPermission());
        return status === "granted" ? "granted" : "denied";
      } catch {
        return "denied";
      }
    },
    async getDevicePushToken() {
      if (native === null || !available) return undefined;
      try {
        const token = await native.devicePushToken();
        return typeof token === "string" &&
          token.trim() === token &&
          token.length > 0 &&
          new TextEncoder().encode(token).byteLength <= PLATFORM_TOKEN_MAX_BYTES
          ? token
          : undefined;
      } catch {
        return undefined;
      }
    },
    async getNotificationPublicKey(hostId, deviceId) {
      if (native === null || !available) return undefined;
      try {
        const key = await native.notificationPublicKey(hostId, deviceId);
        return typeof key === "string" && NOTIFICATION_PUBLIC_KEY.test(key) ? key : undefined;
      } catch {
        return undefined;
      }
    },
    // Not gated on `available`: a computer removed from a build whose push
    // support went away still loses any key an earlier build made for it.
    async forgetHost(hostId) {
      if (native === null) return;
      await native.forgetHost(hostId);
    },
  };
}
