import {
  DESKTOP_LEASE_AGGREGATE_TYPE,
  DESKTOP_LEASE_EVENT_NAMES,
  DESKTOP_SPEND_AGGREGATE_TYPE,
  DESKTOP_SPEND_EVENT_NAMES,
  DesktopArtifactSent,
  DesktopBilledLeaseRefused,
  DesktopSpendCapChanged,
  decodeDesktopSpendCapChanged,
  DesktopLeaseExtended,
  DesktopLeaseLeftoverCleared,
  DesktopLeaseOperated,
  DesktopLeaseRequested,
  DesktopLeaseTransitioned,
  decodeDesktopArtifactSent,
  decodeDesktopLease,
  decodeDesktopLeaseExtended,
  decodeDesktopLeaseLeftoverCleared,
  decodeDesktopLeaseOperated,
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
    .register(DESKTOP_LEASE_EVENT_NAMES.artifactSent, 1, DesktopArtifactSent)
    .register(DESKTOP_LEASE_EVENT_NAMES.operated, 1, DesktopLeaseOperated)
    .register(DESKTOP_LEASE_EVENT_NAMES.leftoverCleared, 1, DesktopLeaseLeftoverCleared)
    .register(DESKTOP_SPEND_EVENT_NAMES.capChanged, 1, DesktopSpendCapChanged)
    .register(DESKTOP_SPEND_EVENT_NAMES.billedLeaseRefused, 1, DesktopBilledLeaseRefused);
}

/** The host's spend record: the cap a person set, if any, and the aggregate's version. */
export interface DesktopSpendRecord {
  readonly version: number;
  readonly monthlyCapUsdCents?: number;
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
  readonly aggregateTypes: ReadonlyArray<string> = [
    DESKTOP_LEASE_AGGREGATE_TYPE,
    DESKTOP_SPEND_AGGREGATE_TYPE,
  ];
  readonly #records = new Map<string, DesktopLeaseRecord>();
  #spend: DesktopSpendRecord = { version: 0 };

  reset(_connection: SqliteConnection): void {
    this.#records.clear();
    this.#spend = { version: 0 };
  }

  apply(_connection: SqliteConnection, event: EventEnvelope): void {
    if (event.eventVersion !== 1) return;
    const version = Number(event.aggregateVersion);
    if (event.aggregateType === DESKTOP_SPEND_AGGREGATE_TYPE) {
      // Replaying an event twice must end in the same state.
      if (this.#spend.version >= version) return;
      if (event.eventName === DESKTOP_SPEND_EVENT_NAMES.capChanged) {
        const changed = decodeDesktopSpendCapChanged(event.payload);
        this.#spend = {
          version,
          ...(changed.monthlyCapUsdCents === undefined
            ? {}
            : { monthlyCapUsdCents: changed.monthlyCapUsdCents }),
        };
        return;
      }
      // A refusal changes no cap; only the aggregate's version moves.
      this.#spend = { ...this.#spend, version };
      return;
    }
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
          ...(requested.placementId === undefined ? {} : { placementId: requested.placementId }),
          ...(requested.machine === undefined ? {} : { machine: requested.machine }),
          ...(requested.daemon === undefined ? {} : { daemon: requested.daemon }),
          ...(requested.spend === undefined ? {} : { spend: requested.spend }),
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
        ...(transitioned.credentialRejected === undefined ? {} : { credentialRejected: true }),
        ...(transitioned.credentialMissing === undefined ? {} : { credentialMissing: true }),
        ...(transitioned.leftoverUnverified === undefined ? {} : { leftoverUnverified: true }),
        updatedAt: event.occurredAt,
      }));
      return;
    }
    if (event.eventName === DESKTOP_LEASE_EVENT_NAMES.leftoverCleared) {
      // Verified gone: the lease's own end time stays, so its spend still counts
      // from request to end.
      const cleared = decodeDesktopLeaseLeftoverCleared(event.payload);
      this.#update(cleared.leaseId, version, ({ leftoverUnverified: _, ...lease }) => lease);
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
      return;
    }
    if (event.eventName === DESKTOP_LEASE_EVENT_NAMES.operated) {
      // An input leaves the lease as it was; only the aggregate's version moves.
      const operated = decodeDesktopLeaseOperated(event.payload);
      this.#update(operated.leaseId, version, (lease) => lease);
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

  spend(): DesktopSpendRecord {
    return this.#spend;
  }
}
