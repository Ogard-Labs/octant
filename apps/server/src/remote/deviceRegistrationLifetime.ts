import type { EventActor } from "@octant/contracts";
import {
  REMOTE_ACCESS_EVENT_NAMES,
  decodeDeviceRegistrationDeadlineChangedV1,
  type PairedDeviceLifetime,
} from "@octant/contracts/remote-access";
import { retimeDeviceRegistration } from "@octant/domain/remote-access-policy";
import type { Journal } from "../persistence/journal";
import { readDeviceRegistrations } from "../persistence/remoteAccessProjection";
import type { SqliteConnection } from "../persistence/sqlitePort";

/**
 * Moves every still-current paired device's registration deadline to its
 * pairing time plus the length the person just chose, one journaled event a
 * device, under the person who changed the setting. It reads only the journal
 * and projection, so it applies whether or not the private listener is on.
 * Returns the devices whose new deadline has already passed, which the caller
 * expires at once when a listener holds their sessions.
 */
export function retimeDeviceRegistrations(input: {
  readonly journal: Journal;
  readonly connection: SqliteConnection;
  readonly lifetime: PairedDeviceLifetime;
  readonly actor: EventActor;
  readonly now: number;
  readonly uuid: () => string;
}): { readonly retimed: number; readonly expiredNow: ReadonlyArray<string> } {
  const head = input.connection.prepare(
    "SELECT aggregate_version FROM aggregate_heads WHERE aggregate_type = ? AND aggregate_id = ?",
  );
  const changedAt = new Date(input.now).toISOString();
  const expiredNow: string[] = [];
  let retimed = 0;
  for (const device of readDeviceRegistrations(input.connection)) {
    const verdict = retimeDeviceRegistration({
      state: device.state,
      now: input.now,
      createdAt: Date.parse(device.created_at),
      expiresAt: Date.parse(device.expires_at),
      lifetime: input.lifetime,
    });
    if (verdict.kind === "unchanged") continue;
    const payload = decodeDeviceRegistrationDeadlineChangedV1({
      hostId: device.host_id,
      deviceId: device.device_id,
      credentialGeneration: device.credential_generation,
      expiresAt: new Date(verdict.expiresAt).toISOString(),
      lifetime: input.lifetime,
      changedAt,
    });
    const version = head.get("remote-device", device.device_id) as
      | { readonly aggregate_version: number }
      | undefined;
    input.journal.append({
      aggregate: { aggregateType: "remote-device", aggregateId: device.device_id },
      expectedVersion: version?.aggregate_version ?? 0,
      events: [
        {
          eventId: input.uuid(),
          eventName: REMOTE_ACCESS_EVENT_NAMES.deviceRegistrationDeadlineChanged,
          eventVersion: 1,
          correlationId: input.uuid(),
          actor: input.actor,
          occurredAt: changedAt,
          payload,
        },
      ],
    });
    retimed += 1;
    if (verdict.expiresAt <= input.now) expiredNow.push(device.device_id);
  }
  return { retimed, expiredNow };
}
