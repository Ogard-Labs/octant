import {
  DESKTOP_LEASE_AGGREGATE_TYPE,
  DESKTOP_LEASE_EVENT_NAMES,
  DesktopArtifactSent,
  DesktopLeaseExtended,
  DesktopLeaseRequested,
  DesktopLeaseTransitioned,
  decodeDesktopArtifactSent,
  decodeDesktopLease,
  decodeDesktopLeaseExtended,
  decodeDesktopLeaseRequested,
  decodeDesktopLeaseTransitioned,
  type DesktopHostTag,
  type DesktopLease,
  type DesktopLeaseId,
  type EventEnvelope,
} from "@octant/contracts";
import type { EventRegistry } from "../persistence/eventRegistry";
import type { Projection } from "../persistence/projection";
import type { SqliteConnection } from "../persistence/sqlitePort";

export function registerDesktopLeaseEvents(registry: EventRegistry): EventRegistry {
  return registry
    .register(DESKTOP_LEASE_EVENT_NAMES.requested, 1, DesktopLeaseRequested)
    .register(DESKTOP_LEASE_EVENT_NAMES.transitioned, 1, DesktopLeaseTransitioned)
    .register(DESKTOP_LEASE_EVENT_NAMES.extended, 1, DesktopLeaseExtended)
    .register(DESKTOP_LEASE_EVENT_NAMES.artifactSent, 1, DesktopArtifactSent);
}

export interface DesktopLeaseRecord {
  readonly lease: DesktopLease;
  readonly hostTag: DesktopHostTag;
  /** The lease aggregate's version, which the next append expects. */
  readonly version: number;
}

/**
 * Every lease this host has journaled, rebuilt from its events. The state is
 * small and in memory, so it replays from the start of the journal on every
 * host start; restart reconciliation reads it to find leases that were never
 * verified released.
 */
export class DesktopLeaseProjection implements Projection {
  readonly name = "desktop-leases";
  readonly dependencies: ReadonlyArray<string> = [];
  readonly holdsStateInMemory = true as const;
  readonly aggregateTypes: ReadonlyArray<string> = [DESKTOP_LEASE_AGGREGATE_TYPE];
  readonly #records = new Map<string, DesktopLeaseRecord>();

  reset(_connection: SqliteConnection): void {
    this.#records.clear();
  }

  apply(_connection: SqliteConnection, event: EventEnvelope): void {
    if (event.eventVersion !== 1) return;
    const version = Number(event.aggregateVersion);
    if (event.eventName === DESKTOP_LEASE_EVENT_NAMES.requested) {
      const requested = decodeDesktopLeaseRequested(event.payload);
      if (this.#records.has(String(requested.leaseId))) return;
      this.#records.set(String(requested.leaseId), {
        hostTag: requested.hostTag,
        version,
        lease: decodeDesktopLease({
          leaseId: requested.leaseId,
          owner: requested.owner,
          providerId: requested.providerId,
          locality: requested.locality,
          billed: requested.billed,
          ...(requested.credentialRef === undefined
            ? {}
            : { credentialRef: requested.credentialRef }),
          state: "requested",
          requestedAt: event.occurredAt,
          expiresAt: requested.expiresAt,
          maximumExpiresAt: requested.maximumExpiresAt,
          idleMinutes: requested.idleMinutes,
          updatedAt: event.occurredAt,
        }),
      });
      return;
    }
    if (event.eventName === DESKTOP_LEASE_EVENT_NAMES.transitioned) {
      const transitioned = decodeDesktopLeaseTransitioned(event.payload);
      this.#update(transitioned.leaseId, version, (lease) => ({
        ...lease,
        state: transitioned.to,
        ...(transitioned.endReason === undefined ? {} : { endReason: transitioned.endReason }),
        updatedAt: event.occurredAt,
      }));
      return;
    }
    if (event.eventName === DESKTOP_LEASE_EVENT_NAMES.extended) {
      const extended = decodeDesktopLeaseExtended(event.payload);
      this.#update(extended.leaseId, version, (lease) => ({
        ...lease,
        expiresAt: extended.expiresAt,
        updatedAt: event.occurredAt,
      }));
      return;
    }
    if (event.eventName === DESKTOP_LEASE_EVENT_NAMES.artifactSent) {
      // A transfer leaves the lease as it was; only the aggregate's version moves.
      const sent = decodeDesktopArtifactSent(event.payload);
      this.#update(sent.leaseId, version, (lease) => lease);
    }
  }

  #update(
    leaseId: DesktopLeaseId,
    version: number,
    next: (lease: DesktopLease) => DesktopLease,
  ): void {
    const record = this.#records.get(String(leaseId));
    // Replaying an event twice must end in the same state.
    if (record === undefined || record.version >= version) return;
    this.#records.set(String(leaseId), { ...record, version, lease: next(record.lease) });
  }

  get(leaseId: DesktopLeaseId): DesktopLeaseRecord | undefined {
    return this.#records.get(String(leaseId));
  }

  list(): ReadonlyArray<DesktopLeaseRecord> {
    return [...this.#records.values()];
  }
}
