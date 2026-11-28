import {
  clearMobilePushToken,
  readMobilePushStatus,
  registerMobilePushToken,
  type MobileRemoteTransport,
} from "@octant/client-runtime";
import type { MobileNotificationPermissionPort } from "./notificationPermissionPort";
import { digestPlatformToken, type PushRegistrationBook } from "./pushRegistrationBook";

export type EnablePhoneNotificationsRefusalReason =
  | "unavailable"
  | "permission-denied"
  | "no-platform-token"
  | "no-device-identity"
  | "update-host"
  | "host-push-off"
  | "host-no-credentials"
  | "host-hub-push-off"
  | "host-rejected"
  | "host-unreachable";

export type EnablePhoneNotificationsResult =
  | { readonly status: "registered" }
  /** Notifications were turned off for this computer while this was under way. */
  | { readonly status: "cancelled" }
  | {
      readonly status: "refused";
      readonly reason: EnablePhoneNotificationsRefusalReason;
    };

/**
 * Checks whether the paired computer supports direct v2 push, registers this
 * phone's platform token and preferences with it directly, and records a
 * digest of the token so later rotations can re-register automatically.
 */
async function registerWithComputer(input: {
  readonly transport: MobileRemoteTransport;
  readonly deviceId: string;
  readonly permission: MobileNotificationPermissionPort;
  readonly token: string;
  readonly book: PushRegistrationBook;
  /** True once the person has turned notifications off for this computer. */
  readonly isCancelled: () => boolean;
  /** Whether this phone hears that a new device joined or paired with the computer. */
  readonly newDevices: boolean;
  /** Whether thread and project names may appear on the lock screen. Off by default. */
  readonly threadTitles: boolean;
}): Promise<EnablePhoneNotificationsResult> {
  if (input.isCancelled()) return { status: "cancelled" };
  const hostStatus = await readMobilePushStatus(input.transport);
  if (input.isCancelled()) return { status: "cancelled" };
  if (hostStatus.status === "update-host") {
    // An older host predates direct v2 push: clear any stale registration on
    // the phone and ask the host to drop any old record too.
    await clearMobilePushToken(input.transport).catch(() => undefined);
    await input.permission.forgetHost(input.transport.hostId).catch(() => undefined);
    await input.book.remove(input.transport.hostId).catch(() => undefined);
    return { status: "refused", reason: "update-host" };
  }
  if (hostStatus.status === "rejected") {
    return { status: "refused", reason: "host-rejected" };
  }
  if (hostStatus.status === "unavailable") {
    return { status: "refused", reason: "host-unreachable" };
  }
  if (hostStatus.push.status === "unavailable") {
    if (hostStatus.push.reason === "no-credentials") {
      return { status: "refused", reason: "host-no-credentials" };
    }
    return { status: "refused", reason: "host-push-off" };
  }
  if (input.isCancelled()) return { status: "cancelled" };
  await input.permission.allowHost?.(input.transport.hostId);
  await registerMobilePushToken({
    transport: input.transport,
    platform: input.permission.platform,
    token: input.token,
    preferences: {
      approvalNeeded: true,
      waiting: true,
      failure: true,
      completion: true,
      threadTitles: input.threadTitles,
      ...(input.newDevices ? {} : { newDevices: false }),
    },
  });
  if (input.isCancelled()) return { status: "cancelled" };
  await input.book.record({
    hostId: input.transport.hostId,
    deviceId: input.deviceId,
    tokenDigest: await digestPlatformToken(input.token),
    ...(input.newDevices ? {} : { newDevices: false as const }),
    ...(input.threadTitles ? { threadTitles: true as const } : {}),
  });
  return { status: "registered" };
}

/**
 * Turns notifications on for one paired computer: ask the system, take the
 * platform token, check that the computer can send direct v2 push, and
 * register the platform token with the computer.
 */
export async function enablePhoneNotifications(input: {
  readonly transport: MobileRemoteTransport;
  /** The device id the computer knows this phone by. */
  readonly deviceId: string | undefined;
  readonly permission: MobileNotificationPermissionPort;
  readonly book: PushRegistrationBook;
  /**
   * Whether this phone hears about new devices on this computer. Absent, it
   * keeps the choice it made before, or hears of them (on by default).
   */
  readonly newDevices?: boolean;
  /**
   * Whether thread and project names may appear on the lock screen. Absent,
   * keeps the prior choice, or stays off (off by default).
   */
  readonly threadTitles?: boolean;
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
  const deviceId = input.deviceId;
  const earlier = (await input.book.list()).find(
    (entry) => entry.hostId === input.transport.hostId,
  );
  const newDevices = input.newDevices ?? earlier?.newDevices !== false;
  const threadTitles = input.threadTitles ?? earlier?.threadTitles === true;
  return input.book.lifecycle.run(input.transport.hostId, (isCancelled) =>
    registerWithComputer({
      newDevices,
      threadTitles,
      transport: input.transport,
      deviceId,
      permission: input.permission,
      token,
      book: input.book,
      isCancelled,
    }),
  );
}

export type PhoneNotificationRotationOutcome =
  | "unchanged"
  | "rotated"
  | "not-connected"
  | "permission-withdrawn"
  /** Turned off, cleared for an older host, or its record gone while running. */
  | "forgotten"
  /** The phone could not clear local notification state; the next run tries again. */
  | "cleanup-failed"
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
 * with each computer that is connected. When the person has switched
 * notifications off for Octant in the system, every registration is cleared.
 */
export async function rotatePhoneNotifications(input: {
  readonly book: PushRegistrationBook;
  readonly permission: MobileNotificationPermissionPort;
  readonly transportForHost: (hostId: string) => MobileRemoteTransport | undefined;
}): Promise<PhoneNotificationRotationReport> {
  const all = await input.book.list();
  if (all.length === 0) return { status: "nothing-registered", hosts: [] };
  const hosts: Array<{ hostId: string; outcome: PhoneNotificationRotationOutcome }> = [];

  for (const record of all.filter((entry) => entry.forgetPending === true)) {
    const forgotten = await forgetPhoneNotificationsForHost({
      hostId: record.hostId,
      permission: input.permission,
      book: input.book,
      transport: input.transportForHost(record.hostId),
    });
    hosts.push({
      hostId: record.hostId,
      outcome: forgotten.localCleared ? "forgotten" : "cleanup-failed",
    });
  }
  const records = all.filter((entry) => entry.forgetPending !== true);
  if (records.length === 0) return { status: "checked", hosts };
  if (!input.permission.available) return { status: "unavailable", hosts: [] };

  if ((await input.permission.getStatus()) === "denied") {
    for (const record of records) {
      const forgotten = await forgetPhoneNotificationsForHost({
        hostId: record.hostId,
        permission: input.permission,
        book: input.book,
        transport: input.transportForHost(record.hostId),
      });
      hosts.push({
        hostId: record.hostId,
        outcome: forgotten.localCleared ? "permission-withdrawn" : "cleanup-failed",
      });
    }
    return { status: "checked", hosts };
  }

  const token = await input.permission.getDevicePushToken();
  if (token === undefined || token.length === 0) return { status: "no-platform-token", hosts: [] };
  const digest = await digestPlatformToken(token);

  for (const snapshot of records) {
    if (snapshot.tokenDigest === digest) {
      hosts.push({ hostId: snapshot.hostId, outcome: "unchanged" });
      continue;
    }
    const outcome = await input.book.lifecycle.run(
      snapshot.hostId,
      async (isCancelled): Promise<PhoneNotificationRotationOutcome> => {
        const record = (await input.book.list()).find((entry) => entry.hostId === snapshot.hostId);
        if (record === undefined || record.forgetPending === true || isCancelled()) {
          return "forgotten";
        }
        const transport = input.transportForHost(record.hostId);
        if (transport === undefined) return "not-connected";
        try {
          const result = await registerWithComputer({
            newDevices: record.newDevices !== false,
            threadTitles: record.threadTitles === true,
            transport,
            deviceId: record.deviceId,
            permission: input.permission,
            token,
            book: input.book,
            isCancelled,
          });
          if (result.status === "registered") return "rotated";
          if (result.status === "cancelled") return "forgotten";
          if (result.reason === "update-host") return "forgotten";
          return "failed";
        } catch {
          return "failed";
        }
      },
    );
    hosts.push({ hostId: snapshot.hostId, outcome });
  }
  return { status: "checked", hosts };
}

/** Longest the phone waits for a computer to confirm it dropped a registration. */
const HOST_CLEAR_WAIT_MS = 3_000;
/** Longest forgetting waits for an enable or rotation already under way on the computer. */
const IN_FLIGHT_WAIT_MS = 5_000;

/**
 * Forgets one computer's notifications on this phone: the host is asked to drop
 * its registration, delivered notifications for it are cleared and the host is
 * marked forgotten (so late alerts are hidden on iOS and dropped on Android),
 * and the local registration record is removed.
 */
export async function forgetPhoneNotificationsForHost(input: {
  readonly hostId: string;
  readonly permission: MobileNotificationPermissionPort;
  readonly book: PushRegistrationBook;
  /** The live connection to the computer, when there is one. */
  readonly transport?: MobileRemoteTransport | undefined;
  readonly waitMs?: number;
}): Promise<{ readonly clearedOnComputer: boolean; readonly localCleared: boolean }> {
  input.book.lifecycle.cancel(input.hostId);
  return input.book.lifecycle.run(
    input.hostId,
    async () => {
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
          clearedOnComputer =
            receipt?.result === "cleared" || receipt?.result === "already-cleared";
        } catch {
          clearedOnComputer = false;
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }
      let localCleared = true;
      try {
        await input.permission.forgetHost(input.hostId);
      } catch {
        localCleared = false;
      }
      if (localCleared) {
        await input.book.remove(input.hostId);
      } else {
        const record = (await input.book.list()).find((entry) => entry.hostId === input.hostId);
        if (record !== undefined) await input.book.record({ ...record, forgetPending: true });
      }
      return { clearedOnComputer, localCleared };
    },
    IN_FLIGHT_WAIT_MS,
  );
}

export function formatEnableRefusal(
  reason: EnablePhoneNotificationsRefusalReason,
  hostLabel: string,
): string {
  switch (reason) {
    case "update-host":
      return `Update Octant on ${hostLabel} to use notifications.`;
    case "host-push-off":
      return `Turn on Phone notifications in Settings › General on ${hostLabel}.`;
    case "host-no-credentials":
      return `Add an Apple push key or Google service account in Settings › General on ${hostLabel}.`;
    case "host-hub-push-off":
      return `Turn on the push sender on ${hostLabel}'s hub, or add push credentials in Settings › General on ${hostLabel}.`;
    case "host-rejected":
      return `This phone is not allowed to register notifications with ${hostLabel}.`;
    case "host-unreachable":
      return `Could not reach ${hostLabel}. Try again when it is online.`;
    case "unavailable":
      return "This phone can't receive notifications from Octant in this build.";
    case "permission-denied":
      return "Notifications are turned off for Octant in this phone's settings.";
    case "no-platform-token":
      return "This phone could not get a notification address from the system. Try again later.";
    case "no-device-identity":
      return "This phone could not find its pairing with this computer. Pair again.";
  }
}
