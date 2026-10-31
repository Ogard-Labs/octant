import {
  clearMobilePushToken,
  registerMobilePushToken,
  requestMobilePushCapability,
  type MobilePushCapabilityResult,
  type MobileRemoteTransport,
} from "@octant/client-runtime";
import { REMOTE_PUSH_GATEWAY_DEFAULT_URL } from "@octant/contracts/remote-push-notifications";
import type { MobileNotificationPermissionPort } from "./notificationPermissionPort";
import { digestPlatformToken, type PushRegistrationBook } from "./pushRegistrationBook";

/**
 * The push gateway this build delivers through. Only a gateway holding the
 * signing account's push credential can reach this app, so the address is
 * compiled in rather than read from the host.
 */
export const MOBILE_PUSH_GATEWAY_URL = REMOTE_PUSH_GATEWAY_DEFAULT_URL;

type RequestCapability = (input: {
  readonly gatewayUrl: string;
  readonly platform: "ios" | "android";
  readonly token: string;
  readonly hostKeyFingerprint: string;
}) => Promise<MobilePushCapabilityResult>;

export type EnablePhoneNotificationsResult =
  | { readonly status: "registered" }
  | {
      readonly status: "refused";
      readonly reason:
        | "unavailable"
        | "permission-denied"
        | "no-platform-token"
        | "no-device-identity"
        | "no-notification-key"
        | "gateway-unreachable"
        | "gateway-refused";
    };

/**
 * Trades a platform token for a capability bound to one computer's key,
 * registers only the capability and this phone's notification key with that
 * computer, and writes down which token the registration was made under so a
 * later rotation can tell it changed. The computer never receives the platform
 * token, and a capability sends nothing unless the request is signed by the
 * key the phone paired with.
 */
async function registerWithComputer(input: {
  readonly transport: MobileRemoteTransport;
  readonly hostKeyFingerprint: string;
  readonly deviceId: string;
  readonly permission: MobileNotificationPermissionPort;
  readonly token: string;
  readonly book: PushRegistrationBook;
  readonly requestCapability: RequestCapability;
}): Promise<EnablePhoneNotificationsResult> {
  const notificationPublicKey = await input.permission.getNotificationPublicKey(
    input.transport.hostId,
    input.deviceId,
  );
  if (notificationPublicKey === undefined) {
    return { status: "refused", reason: "no-notification-key" };
  }
  const issued = await input.requestCapability({
    gatewayUrl: MOBILE_PUSH_GATEWAY_URL,
    platform: input.permission.platform,
    token: input.token,
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
  await input.book.record({
    hostId: input.transport.hostId,
    deviceId: input.deviceId,
    hostKeyFingerprint: input.hostKeyFingerprint,
    tokenDigest: await digestPlatformToken(input.token),
  });
  return { status: "registered" };
}

/**
 * Turns notifications on for one paired computer: ask the system, take the
 * platform token, trade it at the gateway, and register the result with the
 * computer. A refusal at any step registers nothing, and a build or device
 * that cannot receive push is refused before the system is asked anything.
 */
export async function enablePhoneNotifications(input: {
  readonly transport: MobileRemoteTransport;
  readonly hostKeyFingerprint: string;
  /** The device id the computer knows this phone by. */
  readonly deviceId: string | undefined;
  readonly permission: MobileNotificationPermissionPort;
  readonly book: PushRegistrationBook;
  readonly requestCapability?: RequestCapability;
}): Promise<EnablePhoneNotificationsResult> {
  if (!input.permission.available) return { status: "refused", reason: "unavailable" };
  if (input.deviceId === undefined) return { status: "refused", reason: "no-device-identity" };
  if ((await input.permission.request()) !== "granted") {
    return { status: "refused", reason: "permission-denied" };
  }
  const token = await input.permission.getDevicePushToken();
  if (token === undefined || token.length === 0) {
    return { status: "refused", reason: "no-platform-token" };
  }
  return registerWithComputer({
    transport: input.transport,
    hostKeyFingerprint: input.hostKeyFingerprint,
    deviceId: input.deviceId,
    permission: input.permission,
    token,
    book: input.book,
    requestCapability: input.requestCapability ?? requestMobilePushCapability,
  });
}

export type PhoneNotificationRotationOutcome =
  | "unchanged"
  | "rotated"
  | "not-connected"
  | "permission-withdrawn"
  | "failed";

export interface PhoneNotificationRotationReport {
  readonly status: "nothing-registered" | "unavailable" | "no-platform-token" | "checked";
  readonly hosts: ReadonlyArray<{
    readonly hostId: string;
    readonly outcome: PhoneNotificationRotationOutcome;
  }>;
}

/**
 * Keeps every registration current. Run when the app opens or returns to the
 * foreground, it compares the platform token the system holds now with the one
 * each computer's registration was made under, and registers the new token
 * with each computer that is connected. A computer that is not connected, or a
 * gateway that cannot be reached, leaves its record as it was and is tried
 * again on the next run. When the person has since switched notifications off
 * for Octant in the system, every registration is cleared and its key forgotten,
 * because nothing could be shown.
 */
export async function rotatePhoneNotifications(input: {
  readonly book: PushRegistrationBook;
  readonly permission: MobileNotificationPermissionPort;
  readonly transportForHost: (hostId: string) => MobileRemoteTransport | undefined;
  readonly requestCapability?: RequestCapability;
}): Promise<PhoneNotificationRotationReport> {
  const records = await input.book.list();
  if (records.length === 0) return { status: "nothing-registered", hosts: [] };
  // A build that cannot tell says nothing about the registrations it did not make.
  if (!input.permission.available) return { status: "unavailable", hosts: [] };

  if ((await input.permission.getStatus()) === "denied") {
    const hosts: Array<{ hostId: string; outcome: PhoneNotificationRotationOutcome }> = [];
    for (const record of records) {
      await forgetPhoneNotificationsForHost({
        hostId: record.hostId,
        permission: input.permission,
        book: input.book,
        transport: input.transportForHost(record.hostId),
      });
      hosts.push({ hostId: record.hostId, outcome: "permission-withdrawn" });
    }
    return { status: "checked", hosts };
  }

  const token = await input.permission.getDevicePushToken();
  if (token === undefined || token.length === 0) return { status: "no-platform-token", hosts: [] };
  const digest = await digestPlatformToken(token);
  const requestCapability = input.requestCapability ?? requestMobilePushCapability;

  const hosts: Array<{ hostId: string; outcome: PhoneNotificationRotationOutcome }> = [];
  for (const record of records) {
    if (record.tokenDigest === digest) {
      hosts.push({ hostId: record.hostId, outcome: "unchanged" });
      continue;
    }
    const transport = input.transportForHost(record.hostId);
    if (transport === undefined) {
      hosts.push({ hostId: record.hostId, outcome: "not-connected" });
      continue;
    }
    try {
      const result = await registerWithComputer({
        transport,
        hostKeyFingerprint: record.hostKeyFingerprint,
        deviceId: record.deviceId,
        permission: input.permission,
        token,
        book: input.book,
        requestCapability,
      });
      hosts.push({
        hostId: record.hostId,
        outcome: result.status === "registered" ? "rotated" : "failed",
      });
    } catch {
      hosts.push({ hostId: record.hostId, outcome: "failed" });
    }
  }
  return { status: "checked", hosts };
}

/** Longest the phone waits for a computer to confirm it dropped a registration. */
const HOST_CLEAR_WAIT_MS = 3_000;

/**
 * Forgets one computer's notifications on this phone: the host is asked to drop
 * its registration, then the notifications already shown for it and the key that
 * opens them go, and the record of the registration. Used when a computer is
 * removed, this phone revokes itself, or notifications are turned off. What the
 * phone holds is removed even when the computer cannot be reached or does not
 * answer in time: a registration it keeps is then useless, because no key
 * remains that could open what it sends, and the computer drops it when
 * delivery fails or the device is revoked.
 */
export async function forgetPhoneNotificationsForHost(input: {
  readonly hostId: string;
  readonly permission: MobileNotificationPermissionPort;
  readonly book: PushRegistrationBook;
  /** The live connection to the computer, when there is one. */
  readonly transport?: MobileRemoteTransport | undefined;
  readonly waitMs?: number;
}): Promise<{ readonly clearedOnComputer: boolean; readonly keyForgotten: boolean }> {
  let clearedOnComputer = false;
  if (input.transport !== undefined) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const receipt = await Promise.race([
        clearMobilePushToken(input.transport),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), input.waitMs ?? HOST_CLEAR_WAIT_MS);
        }),
      ]);
      clearedOnComputer = receipt?.result === "cleared" || receipt?.result === "already-cleared";
    } catch {
      clearedOnComputer = false;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  let keyForgotten = true;
  try {
    await input.permission.forgetHost(input.hostId);
  } catch {
    keyForgotten = false;
  }
  await input.book.remove(input.hostId);
  return { clearedOnComputer, keyForgotten };
}

export const ENABLE_REFUSAL_COPY: Readonly<
  Record<Extract<EnablePhoneNotificationsResult, { status: "refused" }>["reason"], string>
> = {
  unavailable: "This phone can't receive notifications from Octant in this build.",
  "permission-denied": "Notifications are turned off for Octant in this phone's settings.",
  "no-platform-token":
    "This phone could not get a notification address from the system. Try again later.",
  "no-device-identity": "This phone could not find its pairing with this computer. Pair again.",
  "no-notification-key": "This phone could not make a notification key for this computer.",
  "gateway-unreachable": "The notification service could not be reached. Try again later.",
  "gateway-refused": "The notification service did not accept this phone. Try again later.",
};
