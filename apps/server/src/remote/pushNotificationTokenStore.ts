// The host's push registrations.
//
// A paired device that turns notifications on registers a delivery token with
// the host. The token is a send right to that phone, so the host keeps it in
// one place only: an owner-only file under the data directory's `remote/`
// folder, beside the listener's identity key and the device inventory, outside
// the journal and every export. No route answers with it and nothing logs it.
// The journal records that a device's registration was added, changed, or
// cleared, with the device and why, never the token.
//
// A registration survives a restart. It goes when the device clears it, when
// the device's session signs out, and when the device loses its standing
// (`pushRegistrationClearReasonFor`); a registration whose device has no
// standing when the remote gateway starts is cleared then, so a revoke that
// committed just before a crash cannot leave one behind.

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import {
  REMOTE_PUSH_REGISTRATION_EVENT_NAMES,
  RemotePushPlatform,
  decodeRemotePushRegistrationClearedV1,
  decodeRemotePushRegistrationRecordedV1,
  type RemotePushRegistrationClearReason,
  type RemotePushTokenReceiptV1,
} from "@octant/contracts";
import type { Journal } from "../persistence/journal";

/** The registration file's path under the data directory; data removal names it too. */
export const PUSH_REGISTRATIONS_FILE = join("remote", "push-registrations.json");

/** Each device's registrations are one journal aggregate, keyed by the device id. */
export const PUSH_REGISTRATION_AGGREGATE = "remote-push-registration";

export interface PushTokenRecord {
  readonly hostId: string;
  readonly deviceId: string;
  readonly platform: RemotePushPlatform;
  readonly token: string;
  readonly updatedAt: string;
}

export interface PushNotificationTokenStore {
  /** Called only for an authenticated device, with its id from the principal. */
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
   * Host-internal destination listing for delivery. Callers must never serialize
   * tokens onto notification payloads, receipts, or client responses.
   */
  readonly listDestinationsForHost: (hostId: string) => ReadonlyArray<PushTokenRecord>;
}

export interface PushNotificationTokenStoreOptions {
  readonly dataDirectory: string;
  readonly journal: Pick<Journal, "append" | "aggregateVersions">;
  readonly uuid: () => string;
  /** The host's own actor, for clears the host makes rather than the device. */
  readonly hostActorId: string;
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

const StoredRegistration = Schema.Struct({
  hostId: Schema.NonEmptyTrimmedString,
  deviceId: Schema.NonEmptyTrimmedString,
  platform: RemotePushPlatform,
  token: Schema.NonEmptyString,
  updatedAt: Schema.NonEmptyTrimmedString,
}).annotations({ parseOptions: { onExcessProperty: "error" } });
const StoredRegistrations = Schema.Struct({
  registrations: Schema.Array(StoredRegistration),
}).annotations({ parseOptions: { onExcessProperty: "error" } });
const decodeStoredRegistrations = Schema.decodeUnknownSync(Schema.parseJson(StoredRegistrations));

function keyOf(hostId: string, deviceId: string): string {
  return `${hostId}\0${deviceId}`;
}

export function createPushNotificationTokenStore(
  options: PushNotificationTokenStoreOptions,
): PushNotificationTokenStore {
  const directory = join(options.dataDirectory, "remote");
  const path = join(options.dataDirectory, PUSH_REGISTRATIONS_FILE);
  const records = load(path);

  const write = (next: ReadonlyMap<string, PushTokenRecord>): void => {
    if (next.size === 0) {
      rmSync(path, { force: true });
      return;
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const staging = `${path}.${process.pid}.tmp`;
    writeFileSync(staging, JSON.stringify({ registrations: [...next.values()] }), { mode: 0o600 });
    // writeFileSync applies the mode only when it creates the file, so a
    // staging file left behind by a crashed write is narrowed here too.
    chmodSync(staging, 0o600);
    renameSync(staging, path);
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
          ? { kind: "remote-device", actorId: options.hostActorId, deviceId: record.deviceId }
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
        existing.platform === input.platform
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
        hostId: input.hostId,
        deviceId: input.deviceId,
        platform: input.platform,
        token: input.token,
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
          actor: { kind: "remote-device", actorId: options.hostActorId, deviceId: input.deviceId },
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
    listDestinationsForHost(hostId) {
      return [...records.values()].filter((record) => record.hostId === hostId);
    },
  };
}

/**
 * A file that is missing or cannot be read back exactly holds no
 * registrations: the host delivers nothing until each phone registers again,
 * and the next write replaces the file.
 */
function load(path: string): Map<string, PushTokenRecord> {
  const records = new Map<string, PushTokenRecord>();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return records;
  }
  try {
    for (const record of decodeStoredRegistrations(text).registrations) {
      records.set(keyOf(record.hostId, record.deviceId), record);
    }
  } catch {
    records.clear();
  }
  return records;
}
