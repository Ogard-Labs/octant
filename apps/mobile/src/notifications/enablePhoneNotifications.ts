import {
  registerMobilePushToken,
  requestMobilePushCapability,
  type MobilePushCapabilityResult,
  type MobileRemoteTransport,
} from "@octant/client-runtime";
import { REMOTE_PUSH_GATEWAY_DEFAULT_URL } from "@octant/contracts/remote-push-notifications";
import type { MobileNotificationPermissionPort } from "./notificationPermissionPort";

/**
 * The push gateway this build delivers through. Only a gateway holding the
 * signing account's push credential can reach this app, so the address is
 * compiled in rather than read from the host.
 */
export const MOBILE_PUSH_GATEWAY_URL = REMOTE_PUSH_GATEWAY_DEFAULT_URL;

export type EnablePhoneNotificationsResult =
  | { readonly status: "registered" }
  | {
      readonly status: "refused";
      readonly reason:
        | "permission-denied"
        | "no-platform-token"
        | "no-notification-key"
        | "gateway-unreachable"
        | "gateway-refused";
    };

/**
 * Turns notifications on for one paired computer: ask the system, take the
 * platform token, trade it at the gateway for a capability bound to that
 * computer's key, and register the capability with the computer. The
 * computer never receives the platform token, and a capability it is given
 * sends nothing unless the request is signed by the key the phone paired with.
 */
export async function enablePhoneNotifications(input: {
  readonly transport: MobileRemoteTransport;
  readonly hostKeyFingerprint: string;
  readonly permission: MobileNotificationPermissionPort;
  readonly requestCapability?: (input: {
    readonly gatewayUrl: string;
    readonly platform: "ios" | "android";
    readonly token: string;
    readonly hostKeyFingerprint: string;
  }) => Promise<MobilePushCapabilityResult>;
}): Promise<EnablePhoneNotificationsResult> {
  const requestCapability = input.requestCapability ?? requestMobilePushCapability;
  if ((await input.permission.request()) !== "granted") {
    return { status: "refused", reason: "permission-denied" };
  }
  const token = await input.permission.getDevicePushToken();
  if (token === undefined || token.length === 0) {
    return { status: "refused", reason: "no-platform-token" };
  }
  const notificationPublicKey = await input.permission.getNotificationPublicKey(
    input.transport.hostId,
  );
  if (notificationPublicKey === undefined) {
    return { status: "refused", reason: "no-notification-key" };
  }
  const issued = await requestCapability({
    gatewayUrl: MOBILE_PUSH_GATEWAY_URL,
    platform: input.permission.platform,
    token,
    hostKeyFingerprint: input.hostKeyFingerprint,
  });
  if (issued.status === "unreachable") return { status: "refused", reason: "gateway-unreachable" };
  if (issued.status === "refused") return { status: "refused", reason: "gateway-refused" };
  // Thread names stay off the lock screen until the person turns them on.
  await registerMobilePushToken({
    transport: input.transport,
    platform: input.permission.platform,
    token: issued.capability,
    notificationPublicKey,
    preferences: {
      approvalNeeded: true,
      waiting: true,
      failure: true,
      completion: true,
      threadTitles: false,
    },
  });
  return { status: "registered" };
}

export const ENABLE_REFUSAL_COPY: Readonly<
  Record<Extract<EnablePhoneNotificationsResult, { status: "refused" }>["reason"], string>
> = {
  "permission-denied": "Notifications are turned off for Octant in this phone's settings.",
  "no-platform-token":
    "This phone could not get a notification address from the system. Try again later.",
  "no-notification-key": "This phone could not make a notification key for this computer.",
  "gateway-unreachable": "The notification service could not be reached. Try again later.",
  "gateway-refused": "The notification service did not accept this phone. Try again later.",
};
