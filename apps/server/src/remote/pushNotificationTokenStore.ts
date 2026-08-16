import type { RemotePushPlatform, RemotePushTokenReceiptV1 } from "@octant/contracts";

export interface PushTokenRecord {
  readonly hostId: string;
  readonly deviceId: string;
  readonly platform: RemotePushPlatform;
  readonly token: string;
  readonly updatedAt: string;
}

export interface PushNotificationTokenStore {
  readonly register: (input: {
    readonly hostId: string;
    readonly deviceId: string;
    readonly platform: RemotePushPlatform;
    readonly token: string;
    readonly now: string;
  }) => Pick<RemotePushTokenReceiptV1, "result">;
  readonly clear: (input: {
    readonly hostId: string;
    readonly deviceId: string;
  }) => Pick<RemotePushTokenReceiptV1, "result">;
  readonly get: (input: {
    readonly hostId: string;
    readonly deviceId: string;
  }) => PushTokenRecord | undefined;
  /** Test/inspection helper — never expose tokens over the wire. */
  readonly listDeviceIdsForHost: (hostId: string) => ReadonlyArray<string>;
  /**
   * Host-internal destination listing for delivery. Callers must never serialize
   * tokens onto notification payloads, receipts, or client responses.
   */
  readonly listDestinationsForHost: (hostId: string) => ReadonlyArray<PushTokenRecord>;
}

function keyOf(hostId: string, deviceId: string): string {
  return `${hostId}\0${deviceId}`;
}

export function createPushNotificationTokenStore(): PushNotificationTokenStore {
  const records = new Map<string, PushTokenRecord>();

  return {
    register(input) {
      const key = keyOf(input.hostId, input.deviceId);
      const existing = records.get(key);
      if (
        existing !== undefined &&
        existing.token === input.token &&
        existing.platform === input.platform
      ) {
        return { result: "already-registered" as const };
      }
      records.set(key, {
        hostId: input.hostId,
        deviceId: input.deviceId,
        platform: input.platform,
        token: input.token,
        updatedAt: input.now,
      });
      return { result: "registered" as const };
    },
    clear(input) {
      const key = keyOf(input.hostId, input.deviceId);
      if (!records.has(key)) return { result: "already-cleared" as const };
      records.delete(key);
      return { result: "cleared" as const };
    },
    get(input) {
      return records.get(keyOf(input.hostId, input.deviceId));
    },
    listDeviceIdsForHost(hostId) {
      return [...records.values()]
        .filter((record) => record.hostId === hostId)
        .map((record) => record.deviceId);
    },
    listDestinationsForHost(hostId) {
      return [...records.values()].filter((record) => record.hostId === hostId);
    },
  };
}
