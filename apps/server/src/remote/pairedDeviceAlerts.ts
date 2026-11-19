// Alerts a host keeps when a device pairs directly with it, so every device
// connected to the host is told (maintainer decision, 2026-11-19). The alert
// holds the device's private address; the journal records only that an alert
// was raised or cleared, never the address or the device's name.

import {
  ActorId,
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventId,
  EventName,
  NewMemberAlertId,
  REMOTE_ACCESS_EVENT_NAMES,
  UtcTimestamp,
  decodeDeviceAlertChangedV1,
  type PairedDeviceAlert,
} from "@octant/contracts";
import { Schema } from "effect";
import type { HubStatePort } from "../hub/hubStateStore";
import type { Journal } from "../persistence/journal";
import type { SqliteConnection } from "../persistence/sqlitePort";

const DEVICE_ALERT_AGGREGATE = "remote-device-alerts";
/** As many as a spoke keeps for new members; the oldest go first. */
const MAX_DEVICE_ALERTS = 64;
const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeAlertId = Schema.decodeUnknownSync(NewMemberAlertId);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

export interface PairedDeviceAlertsOptions {
  readonly state: HubStatePort;
  readonly journal: Journal;
  readonly connection: SqliteConnection;
  /** This host's id: the one aggregate its device alerts are journaled in. */
  readonly hostId: () => string;
  readonly localActorId: string;
  readonly uuid: () => string;
  readonly now: () => number;
}

export interface PairedDevice {
  readonly deviceId: string;
  readonly name: string;
  readonly deviceKeyFingerprint: string;
  readonly privateAddress?: string;
}

export class PairedDeviceAlerts {
  readonly #options: PairedDeviceAlertsOptions;
  readonly #selectHead;

  constructor(options: PairedDeviceAlertsOptions) {
    this.#options = options;
    this.#selectHead = options.connection.prepare(
      `SELECT aggregate_version FROM aggregate_heads WHERE aggregate_type = ? AND aggregate_id = ?`,
    );
  }

  list(): ReadonlyArray<PairedDeviceAlert> {
    return this.#options.state.load().pairedDeviceAlerts ?? [];
  }

  raise(device: PairedDevice): PairedDeviceAlert {
    const raisedAt = decodeTimestamp(new Date(this.#options.now()).toISOString());
    const alert: PairedDeviceAlert = {
      alertId: decodeAlertId(this.#options.uuid()),
      deviceId: device.deviceId,
      name: device.name,
      deviceKeyFingerprint: device.deviceKeyFingerprint,
      raisedAt,
      ...(device.privateAddress === undefined ? {} : { privateAddress: device.privateAddress }),
    };
    const state = this.#options.state.load();
    this.#options.state.save({
      ...state,
      pairedDeviceAlerts: [...(state.pairedDeviceAlerts ?? []), alert].slice(-MAX_DEVICE_ALERTS),
    });
    this.#record("raised", alert);
    return alert;
  }

  dismiss(
    alertId: string,
  ): { readonly status: "dismissed" } | { readonly status: "refused"; readonly kind: "not-found" } {
    const alert = this.list().find((entry) => String(entry.alertId) === alertId);
    if (alert === undefined) return { status: "refused", kind: "not-found" };
    this.#clear(alert);
    return { status: "dismissed" };
  }

  /** A device that is removed takes its alert with it. */
  dropDevice(deviceId: string): void {
    for (const alert of this.list().filter((entry) => entry.deviceId === deviceId)) {
      this.#clear(alert);
    }
  }

  #clear(alert: PairedDeviceAlert): void {
    const state = this.#options.state.load();
    this.#options.state.save({
      ...state,
      pairedDeviceAlerts: (state.pairedDeviceAlerts ?? []).filter(
        (entry) => String(entry.alertId) !== String(alert.alertId),
      ),
    });
    this.#record("dismissed", alert);
  }

  #record(change: "raised" | "dismissed", alert: PairedDeviceAlert): void {
    const aggregateId = this.#options.hostId();
    const head = this.#selectHead.get(DEVICE_ALERT_AGGREGATE, aggregateId) as
      | { readonly aggregate_version: number }
      | undefined;
    const occurredAt = decodeTimestamp(new Date(this.#options.now()).toISOString());
    try {
      this.#options.journal.append({
        aggregate: {
          aggregateType: DEVICE_ALERT_AGGREGATE,
          aggregateId: decodeAggregateId(aggregateId),
        },
        expectedVersion: decodeAggregateVersion(head?.aggregate_version ?? 0),
        events: [
          {
            eventId: decodeEventId(this.#options.uuid()),
            eventName: decodeEventName(REMOTE_ACCESS_EVENT_NAMES.deviceAlertChanged),
            eventVersion: 1,
            correlationId: decodeCorrelationId(this.#options.uuid()),
            actor: { kind: "system", actorId: decodeActorId(this.#options.localActorId) },
            occurredAt,
            payload: decodeDeviceAlertChangedV1({
              change,
              alertId: String(alert.alertId),
              deviceId: alert.deviceId,
              changedAt: occurredAt,
            }),
          },
        ],
      });
    } catch {
      // The alert already changed; a journal that cannot take it is reported
      // rather than undone, as for hub membership changes.
      console.warn("Octant could not record a device alert change.");
    }
  }
}
