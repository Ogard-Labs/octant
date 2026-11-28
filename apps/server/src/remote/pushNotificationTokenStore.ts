// The host's push registrations (v2).
//
// A paired device that turns notifications on registers its platform push token
// (APNs hex or FCM registration token) and its preferences directly with the
// host over its authenticated session. The token is a send right to that phone,
// so the host keeps it in one place only: an owner-only file under the data
// directory's `remote/` folder (`0600`), beside the listener's identity key and
// the device inventory, outside the journal and every export. The collapse key
// the host makes for the destination lives beside it. No route answers with
// either and nothing logs them. The journal records that a device's
// registration was added, changed, or cleared, with the device and why, never
// the token.
//
// Upgrade & version skew:
// - Legacy v1 registrations on disk (those carrying `notificationPublicKey`
//   without `version: 2`) are cleared on load and journaled as
//   `destination-gone`, so old phones turn push on again once updated.
// - A file that cannot be read back (for example after a host downgrade) holds
//   no registrations.
// - A registration survives a restart and goes when the device clears it, signs
//   out, loses its standing, or is refused by APNs/FCM as `destination-gone`.

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import {
  REMOTE_PUSH_REGISTRATION_EVENT_NAMES,
  RemotePushPlatform,
  RemotePushPreferencesV1,
  decodeRemotePushRegistrationClearedV1,
  decodeRemotePushRegistrationRecordedV1,
  type RemotePushRegistrationClearReason,
  type RemotePushTokenReceiptV1,
} from "@octant/contracts";
import type { Journal } from "../persistence/journal";
import { writeOwnerOnly } from "./selfMadeListenerCertificate";
import { HUB_ACT_WITHDRAWN_REASON } from "../remoteCredentialLifecycleService";

/** The registration file's path under the data directory; data removal names it too. */
export const PUSH_REGISTRATIONS_FILE = join("remote", "push-registrations.json");

/** Each device's registrations are one journal aggregate, keyed by the device id. */
export const PUSH_REGISTRATION_AGGREGATE = "remote-push-registration";

export interface PushTokenRecord {
  readonly version: 2;
  readonly hostId: string;
  readonly deviceId: string;
  readonly platform: RemotePushPlatform;
  readonly token: string;
  readonly preferences: RemotePushPreferencesV1;
  /** The host's own key for this destination's collapse ids, base64url. */
  readonly collapseKey: string;
  readonly updatedAt: string;
}

export interface PushNotificationTokenStore {
  /** Called only for an authenticated device, with its id from the principal. */
  readonly register: (input: {
    readonly hostId: string;
    readonly deviceId: string;
    readonly platform: RemotePushPlatform;
    readonly token: string;
    readonly preferences: RemotePushPreferencesV1;
    readonly now: string;
  }) => Pick<RemotePushTokenReceiptV1, "result">;
  readonly clear: (input: {
    readonly hostId: string;
    readonly deviceId: string;
    readonly reason: RemotePushRegistrationClearReason;
    readonly now: string;
  }) => Pick<RemotePushTokenReceiptV1, "result">;
  /** Clears every registration whose device no longer stands. Returns how many went. */
  readonly clearWithoutStanding: (input: {
    readonly hasStanding: (hostId: string, deviceId: string) => boolean;
    readonly now: string;
  }) => number;
  readonly get: (input: {
    readonly hostId: string;
    readonly deviceId: string;
  }) => PushTokenRecord | undefined;
  readonly listDeviceIdsForHost: (hostId: string) => ReadonlyArray<string>;
  /**
   * Host-internal destination listing for delivery. Every registration in this
   * data directory belongs to this host, under the listener host id the phone
   * paired with. Callers must never serialize tokens onto notification
   * payloads, receipts, or client responses.
   */
  readonly listDestinations: () => ReadonlyArray<PushTokenRecord>;
}

export interface PushNotificationTokenStoreOptions {
  readonly dataDirectory: string;
  readonly journal: Pick<Journal, "append" | "aggregateVersions">;
  readonly uuid: () => string;
  /** The host's own actor, for clears the host makes rather than the device. */
  readonly hostActorId: string;
  readonly clock?: () => string;
}

/**
 * Whether a credential change clears the device's registration, and as what.
 * A rotated key and a listener that stops (including for a restart) keep it;
 * a sign-out clears it, and every loss of standing clears it. A reason this
 * does not name clears it as a revoke, so a new way to lose standing cannot
 * leave a phone receiving notifications.
 */
export function pushRegistrationClearReasonFor(
  credentialReasonCode: string,
): RemotePushRegistrationClearReason | undefined {
  switch (credentialReasonCode) {
    case "credential-rotated":
    case "credentials-rotated-all":
    case "listener-disabled":
    case HUB_ACT_WITHDRAWN_REASON:
      return undefined;
    case "signed-out":
    case "self-revoked":
    case "pairing-abandoned":
    case "credential-expired":
      return credentialReasonCode;
    default:
      return "device-revoked";
  }
}

/**
 * Whether a registered device may be sent a notification now: its paired
 * record under the same host id is active and its credential has not passed
 * its expiry. Asked for every notification, not only when the listener starts,
 * so a revoke or expiry stops delivery even before its clear lands.
 */
export function pushDestinationStands(
  devices: ReadonlyArray<{
    readonly host_id: string;
    readonly device_id: string;
    readonly state: string;
    readonly expires_at: string;
  }>,
  destination: { readonly hostId: string; readonly deviceId: string; readonly now: string },
): boolean {
  const now = Date.parse(destination.now);
  return devices.some(
    (device) =>
      device.host_id === destination.hostId &&
      device.device_id === destination.deviceId &&
      device.state === "active" &&
      Date.parse(device.expires_at) > now,
  );
}

const StoredRegistrationV2 = Schema.Struct({
  version: Schema.Literal(2),
  hostId: Schema.NonEmptyTrimmedString,
  deviceId: Schema.NonEmptyTrimmedString,
  platform: RemotePushPlatform,
  token: Schema.NonEmptyString,
  preferences: RemotePushPreferencesV1,
  collapseKey: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{43}$/)),
  updatedAt: Schema.NonEmptyTrimmedString,
}).annotations({ parseOptions: { onExcessProperty: "error" } });

const StoredRegistrationsV2 = Schema.Struct({
  registrations: Schema.Array(StoredRegistrationV2),
}).annotations({ parseOptions: { onExcessProperty: "error" } });
const decodeStoredRegistrationsV2 = Schema.decodeUnknownSync(
  Schema.parseJson(StoredRegistrationsV2),
);

/** Legacy v1 shape on disk before direct push: cleared on load as `destination-gone`. */
const LegacyStoredRegistrationV1 = Schema.Struct({
  hostId: Schema.NonEmptyTrimmedString,
  deviceId: Schema.NonEmptyTrimmedString,
  platform: RemotePushPlatform,
  token: Schema.NonEmptyString,
  notificationPublicKey: Schema.NonEmptyTrimmedString,
  preferences: RemotePushPreferencesV1,
  collapseKey: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{43}$/)),
  updatedAt: Schema.NonEmptyTrimmedString,
}).annotations({ parseOptions: { onExcessProperty: "error" } });

const LegacyStoredRegistrationsV1 = Schema.Struct({
  version: Schema.optional(Schema.Literal(1)),
  registrations: Schema.Array(LegacyStoredRegistrationV1),
}).annotations({ parseOptions: { onExcessProperty: "error" } });
const decodeLegacyStoredRegistrationsV1 = Schema.decodeUnknownSync(
  Schema.parseJson(LegacyStoredRegistrationsV1),
);

function keyOf(hostId: string, deviceId: string): string {
  return `${hostId}\0${deviceId}`;
}

function samePreferences(left: RemotePushPreferencesV1, right: RemotePushPreferencesV1): boolean {
  return (
    left.approvalNeeded === right.approvalNeeded &&
    left.waiting === right.waiting &&
    left.failure === right.failure &&
    left.completion === right.completion &&
    left.threadTitles === right.threadTitles &&
    (left.newDevices ?? true) === (right.newDevices ?? true)
  );
}

export function createPushNotificationTokenStore(
  options: PushNotificationTokenStoreOptions,
): PushNotificationTokenStore {
  const directory = join(options.dataDirectory, "remote");
  const path = join(options.dataDirectory, PUSH_REGISTRATIONS_FILE);
  const clock = options.clock ?? (() => new Date().toISOString());

  const write = (next: ReadonlyMap<string, PushTokenRecord>): void => {
    if (next.size === 0) {
      rmSync(path, { force: true });
      return;
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // The host identity key creates the folder first, with the process
    // umask's mode; narrow it to the owner.
    chmodSync(directory, 0o700);
    // A plain write would reuse a staging file a crashed write left behind,
    // keeping its looser mode while the token lands in it, and would follow a
    // link there to another file. This one creates the staging file anew.
    writeOwnerOnly(path, JSON.stringify({ registrations: [...next.values()] }));
  };

  const append = (input: {
    readonly deviceId: string;
    readonly eventName: string;
    readonly payload: unknown;
    readonly actor: unknown;
    readonly occurredAt: string;
    readonly beforeEvents?: () => void;
  }): void => {
    const head = options.journal
      .aggregateVersions(PUSH_REGISTRATION_AGGREGATE)
      .find((aggregate) => aggregate.aggregateId === input.deviceId);
    const id = options.uuid();
    options.journal.append(
      {
        aggregate: { aggregateType: PUSH_REGISTRATION_AGGREGATE, aggregateId: input.deviceId },
        expectedVersion: head?.aggregateVersion ?? 0,
        events: [
          {
            eventId: id,
            eventName: input.eventName,
            eventVersion: 1,
            correlationId: id,
            actor: input.actor,
            occurredAt: input.occurredAt,
            payload: input.payload,
          },
        ],
      },
      input.beforeEvents === undefined ? undefined : { beforeEvents: input.beforeEvents },
    );
  };

  const hostActor = { kind: "system", actorId: options.hostActorId } as const;

  const loaded = load(path);
  const records = loaded.records;
  if (loaded.legacyV1.length > 0) {
    // Clear legacy v1 registrations as `destination-gone` on upgrade so old
    // gateway capabilities are never kept or attempted.
    write(records);
    const now = clock();
    for (const legacy of loaded.legacyV1) {
      try {
        const payload = decodeRemotePushRegistrationClearedV1({
          hostId: legacy.hostId,
          deviceId: legacy.deviceId,
          reason: "destination-gone",
          clearedAt: now,
        });
        append({
          deviceId: legacy.deviceId,
          eventName: REMOTE_PUSH_REGISTRATION_EVENT_NAMES.cleared,
          payload,
          actor: hostActor,
          occurredAt: now,
        });
      } catch {
        // Legacy file is already removed; an unjournaled clear never leaves a stale token behind.
      }
    }
  }

  /**
   * Removes first and journals after: a failed append still leaves the token
   * gone, which is the side a revoke must fail on. The failure is thrown so
   * the caller reports it.
   */
  const remove = (
    record: PushTokenRecord,
    reason: RemotePushRegistrationClearReason,
    now: string,
  ): void => {
    const payload = decodeRemotePushRegistrationClearedV1({
      hostId: record.hostId,
      deviceId: record.deviceId,
      reason,
      clearedAt: now,
    });
    const next = new Map(records);
    next.delete(keyOf(record.hostId, record.deviceId));
    write(next);
    records.delete(keyOf(record.hostId, record.deviceId));
    append({
      deviceId: record.deviceId,
      eventName: REMOTE_PUSH_REGISTRATION_EVENT_NAMES.cleared,
      payload,
      actor:
        reason === "device-cleared"
          ? { kind: "remote-device", actorId: record.deviceId, deviceId: record.deviceId }
          : hostActor,
      occurredAt: now,
    });
  };

  return {
    register(input) {
      const key = keyOf(input.hostId, input.deviceId);
      const existing = records.get(key);
      if (
        existing !== undefined &&
        existing.token === input.token &&
        existing.platform === input.platform &&
        samePreferences(existing.preferences, input.preferences)
      ) {
        return { result: "already-registered" as const };
      }
      const payload = decodeRemotePushRegistrationRecordedV1({
        hostId: input.hostId,
        deviceId: input.deviceId,
        platform: input.platform,
        change: existing === undefined ? "added" : "changed",
        recordedAt: input.now,
      });
      const record: PushTokenRecord = {
        version: 2,
        hostId: input.hostId,
        deviceId: input.deviceId,
        platform: input.platform,
        token: input.token,
        preferences: input.preferences,
        // A changed registration keeps its collapse key, so a notification
        // still replaces the one it updates on the phone.
        collapseKey: existing?.collapseKey ?? randomBytes(32).toString("base64url"),
        updatedAt: input.now,
      };
      const next = new Map(records);
      next.set(key, record);
      // The file is written inside the journal's transaction, so a write that
      // fails journals nothing. If the append fails after the write, the file
      // goes back to what it held: no token is kept that the journal does not
      // record.
      try {
        append({
          deviceId: input.deviceId,
          eventName: REMOTE_PUSH_REGISTRATION_EVENT_NAMES.recorded,
          payload,
          actor: { kind: "remote-device", actorId: input.deviceId, deviceId: input.deviceId },
          occurredAt: input.now,
          beforeEvents: () => write(next),
        });
      } catch (error) {
        write(records);
        throw error;
      }
      records.set(key, record);
      return { result: "registered" as const };
    },
    clear(input) {
      const existing = records.get(keyOf(input.hostId, input.deviceId));
      if (existing === undefined) return { result: "already-cleared" as const };
      remove(existing, input.reason, input.now);
      return { result: "cleared" as const };
    },
    clearWithoutStanding(input) {
      const stale = [...records.values()].filter(
        (record) => !input.hasStanding(record.hostId, record.deviceId),
      );
      for (const record of stale) remove(record, "device-without-standing", input.now);
      return stale.length;
    },
    get(input) {
      return records.get(keyOf(input.hostId, input.deviceId));
    },
    listDeviceIdsForHost(hostId) {
      return [...records.values()]
        .filter((record) => record.hostId === hostId)
        .map((record) => record.deviceId);
    },
    listDestinations() {
      return [...records.values()];
    },
  };
}

/**
 * A file that is missing or cannot be read back holds no registrations: the
 * host delivers nothing until each phone registers again, and the next write
 * replaces the file. A legacy v1 file returns its records under `legacyV1` so
 * startup clears and journals them as `destination-gone`.
 */
function load(path: string): {
  readonly records: Map<string, PushTokenRecord>;
  readonly legacyV1: ReadonlyArray<{ readonly hostId: string; readonly deviceId: string }>;
} {
  const records = new Map<string, PushTokenRecord>();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { records, legacyV1: [] };
  }
  try {
    for (const record of decodeStoredRegistrationsV2(text).registrations) {
      records.set(keyOf(record.hostId, record.deviceId), record);
    }
    return { records, legacyV1: [] };
  } catch {
    // Fall through to detect legacy v1 registrations.
  }
  try {
    const legacy = decodeLegacyStoredRegistrationsV1(text).registrations.map((entry) => ({
      hostId: entry.hostId,
      deviceId: entry.deviceId,
    }));
    return { records, legacyV1: legacy };
  } catch {
    records.clear();
    return { records, legacyV1: [] };
  }
}
