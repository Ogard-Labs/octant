import {
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventActor,
  EventId,
  EventName,
  UtcTimestamp,
  type EventActor as EventActorValue,
} from "@octant/contracts";
import {
  decodeSafeNetworksLimitsSetPayload,
  decodeSafeNetworksPlacesSetPayload,
  decodeSafeNetworksProjectOverrideClearedPayload,
  SAFE_NETWORKS_ACCOUNT_AGGREGATE_ID,
  SAFE_NETWORKS_AGGREGATE,
  SAFE_NETWORKS_EVENT_NAMES,
  SAFE_NETWORKS_LIMITS_AGGREGATE_ID,
  type SafeNetworkPlace,
  type SafeNetworkScope,
  type SafeNetworksRefusalReason,
} from "@octant/contracts/safe-networks";
import { canonicalSafeNetworkPlace } from "@octant/domain/safe-network-policy";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";

/**
 * The places a person trusts, journaled per scope and rebuilt from the
 * journal at startup. Canonical: docs/architecture.md § Octant Shield (safe
 * networks).
 *
 * The account holds a default list; a Project may hold its own, which then
 * replaces the default for that Project's runtimes. Every change is one
 * `safe-networks.places-set@1` (the whole list for that scope, in canonical
 * form) or `safe-networks.project-override-cleared@1`, journal first: a list
 * whose event cannot be appended is not in force. Only a person at a local
 * window changes what is trusted.
 */

const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

const REPLAY_BATCH = 500;

export type SafeNetworkPrincipal = "local-window" | "remote-device";

export type SafeNetworksChange =
  | { readonly kind: "changed" }
  | {
      readonly kind: "refused";
      readonly reason: SafeNetworksRefusalReason;
      readonly placeIndex?: number;
    };

export interface SafeNetworkStoreOptions {
  readonly journal: Pick<Journal, "append" | "replayAggregateType" | "aggregateVersions">;
  /** Whether a Project exists to hold an override; a deleted Project's override would apply to nothing. */
  readonly projectExists: (projectId: string) => boolean;
  readonly personActor: EventActorValue;
  readonly uuid: () => string;
  readonly clock: () => string;
}

export class SafeNetworkStore {
  readonly #options: SafeNetworkStoreOptions;
  readonly #actor: EventActorValue;
  #account: ReadonlyArray<SafeNetworkPlace> = [];
  #limitsOn = false;
  readonly #projects = new Map<string, ReadonlyArray<SafeNetworkPlace>>();
  readonly #versions = new Map<string, number>();
  readonly #listeners = new Set<() => void>();

  constructor(options: SafeNetworkStoreOptions) {
    this.#options = options;
    this.#actor = decodeActor(options.personActor);
  }

  /** Rebuilds every scope from the journal, in journal order. A record that no longer decodes changes nothing. */
  load(): void {
    this.#account = [];
    this.#limitsOn = false;
    this.#projects.clear();
    let after = 0;
    for (;;) {
      const batch = this.#options.journal.replayAggregateType({
        aggregateType: SAFE_NETWORKS_AGGREGATE,
        afterSequence: after,
        limit: REPLAY_BATCH,
      });
      for (const envelope of batch) {
        after = envelope.globalSequence;
        try {
          this.#apply(envelope.eventName, envelope.payload);
        } catch {
          // An unreadable list trusts nothing new; the scope keeps what it had.
        }
      }
      if (batch.length < REPLAY_BATCH) break;
    }
    for (const { aggregateId, aggregateVersion } of this.#options.journal.aggregateVersions(
      SAFE_NETWORKS_AGGREGATE,
    )) {
      this.#versions.set(aggregateId, aggregateVersion);
    }
  }

  /** Told after every change in force, so open proxies decide on the new places at once. */
  onChanged(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** The places in force for a Project's runtimes: its own list when it has one, else the account default. */
  placesFor(projectId: string | undefined): ReadonlyArray<SafeNetworkPlace> {
    if (projectId !== undefined) {
      const override = this.#projects.get(projectId);
      if (override !== undefined) return override;
    }
    return this.#account;
  }

  /** The Network limits switch; off until a person at a local window turns it on. */
  limitsOn(): boolean {
    return this.#limitsOn;
  }

  setLimits(input: {
    readonly enabled: boolean;
    readonly principal: SafeNetworkPrincipal;
  }): SafeNetworksChange {
    if (input.principal !== "local-window")
      return { kind: "refused", reason: "needs-local-window" };
    const payload = { enabled: input.enabled, principal: { kind: "local-window" as const } };
    if (
      !this.#append(SAFE_NETWORKS_LIMITS_AGGREGATE_ID, SAFE_NETWORKS_EVENT_NAMES.limitsSet, payload)
    ) {
      return { kind: "refused", reason: "unavailable" };
    }
    this.#apply(SAFE_NETWORKS_EVENT_NAMES.limitsSet, payload);
    this.#changed();
    return { kind: "changed" };
  }

  account(): ReadonlyArray<SafeNetworkPlace> {
    return this.#account;
  }

  /** A Project's own list, or `null` while it follows the account default. */
  projectOverride(projectId: string): ReadonlyArray<SafeNetworkPlace> | null {
    return this.#projects.get(projectId) ?? null;
  }

  set(input: {
    readonly scope: SafeNetworkScope;
    readonly places: ReadonlyArray<SafeNetworkPlace>;
    readonly principal: SafeNetworkPrincipal;
  }): SafeNetworksChange {
    if (input.principal !== "local-window")
      return { kind: "refused", reason: "needs-local-window" };
    if (
      input.scope.kind === "project" &&
      !this.#options.projectExists(String(input.scope.projectId))
    ) {
      return { kind: "refused", reason: "project-not-found" };
    }
    const canonical: SafeNetworkPlace[] = [];
    const seen = new Set<string>();
    for (const [placeIndex, place] of input.places.entries()) {
      const checked = canonicalSafeNetworkPlace(place);
      if (checked.kind === "refused")
        return { kind: "refused", reason: checked.reason, placeIndex };
      const key = JSON.stringify(checked.place);
      if (seen.has(key)) continue;
      seen.add(key);
      canonical.push(checked.place);
    }
    const aggregateId =
      input.scope.kind === "account"
        ? SAFE_NETWORKS_ACCOUNT_AGGREGATE_ID
        : String(input.scope.projectId);
    const payload = {
      scope: input.scope,
      places: canonical,
      principal: { kind: "local-window" as const },
    };
    if (!this.#append(aggregateId, SAFE_NETWORKS_EVENT_NAMES.placesSet, payload)) {
      return { kind: "refused", reason: "unavailable" };
    }
    this.#apply(SAFE_NETWORKS_EVENT_NAMES.placesSet, payload);
    this.#changed();
    return { kind: "changed" };
  }

  clearProject(input: {
    readonly projectId: string;
    readonly principal: SafeNetworkPrincipal;
  }): SafeNetworksChange {
    if (input.principal !== "local-window")
      return { kind: "refused", reason: "needs-local-window" };
    if (!this.#projects.has(input.projectId)) return { kind: "changed" };
    const payload = {
      projectId: input.projectId,
      principal: { kind: "local-window" as const },
    };
    if (!this.#append(input.projectId, SAFE_NETWORKS_EVENT_NAMES.projectOverrideCleared, payload)) {
      return { kind: "refused", reason: "unavailable" };
    }
    this.#apply(SAFE_NETWORKS_EVENT_NAMES.projectOverrideCleared, payload);
    this.#changed();
    return { kind: "changed" };
  }

  #apply(eventName: string, payload: unknown): void {
    if (eventName === SAFE_NETWORKS_EVENT_NAMES.limitsSet) {
      this.#limitsOn = decodeSafeNetworksLimitsSetPayload(payload).enabled;
      return;
    }
    if (eventName === SAFE_NETWORKS_EVENT_NAMES.placesSet) {
      const set = decodeSafeNetworksPlacesSetPayload(payload);
      if (set.scope.kind === "account") this.#account = set.places;
      else this.#projects.set(String(set.scope.projectId), set.places);
      return;
    }
    if (eventName === SAFE_NETWORKS_EVENT_NAMES.projectOverrideCleared) {
      const cleared = decodeSafeNetworksProjectOverrideClearedPayload(payload);
      this.#projects.delete(String(cleared.projectId));
    }
  }

  #append(aggregateId: string, eventName: string, payload: unknown): boolean {
    const version = this.#versions.get(aggregateId) ?? 0;
    try {
      this.#options.journal.append({
        aggregate: {
          aggregateType: SAFE_NETWORKS_AGGREGATE,
          aggregateId: decodeAggregateId(aggregateId),
        },
        expectedVersion: decodeAggregateVersion(version),
        events: [
          {
            eventId: decodeEventId(this.#options.uuid()),
            eventName: decodeEventName(eventName),
            eventVersion: 1,
            correlationId: decodeCorrelationId(this.#options.uuid()),
            actor: this.#actor,
            occurredAt: decodeTimestamp(this.#options.clock()),
            payload,
          },
        ],
      });
    } catch {
      return false;
    }
    this.#versions.set(aggregateId, version + 1);
    return true;
  }

  #changed(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // A listener's failure does not undo a change already journaled.
      }
    }
  }
}
