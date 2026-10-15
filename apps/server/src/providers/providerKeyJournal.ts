import { Schema } from "effect";
import {
  ActorId,
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventId,
  LOCAL_HOST_ID,
  type ProviderInstance,
  type ProviderInstanceId,
  type WindowId,
} from "@octant/contracts";
import {
  decodeProviderKeyJournalRecord,
  PROVIDER_KEY_AGGREGATE_TYPE,
  PROVIDER_KEY_EVENT_NAME,
  type ProviderKeyChangeAction,
  type ProviderKeyJournalRecord,
} from "@octant/contracts/provider-key-journal";
import { readAggregateVersion } from "../persistence/chatProjection";
import type { Journal } from "../persistence/journal";
import type { SqliteConnection } from "../persistence/sqlitePort";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";

const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);

type Requested = Extract<ProviderKeyJournalRecord, { name: "provider-key.change-requested" }>;
type Completed = Extract<ProviderKeyJournalRecord, { name: "provider-key.change-completed" }>;
type Failed = Extract<ProviderKeyJournalRecord, { name: "provider-key.change-failed" }>;

/** A request the journal holds with no outcome: the host stopped between the request and the store. */
export interface UnsettledProviderKeyChange {
  readonly requestId: string;
  readonly instanceId: ProviderInstanceId;
  readonly action: ProviderKeyChangeAction;
  readonly instanceVersion: number;
}

export interface ProviderKeyChangeRecorder {
  /** Records the outcome. Best effort: a missing outcome is settled at the next host start. */
  readonly complete: (outcome: Completed["outcome"]) => void;
  readonly fail: (reason: Failed["reason"]) => void;
}

export interface ProviderKeyJournal {
  /** Journals the request before the store is touched; throws when it cannot, so the change is refused. */
  readonly request: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly action: ProviderKeyChangeAction;
    readonly instanceVersion: number;
    readonly windowId: WindowId;
  }) => ProviderKeyChangeRecorder;
  readonly unsettled: () => ReadonlyArray<UnsettledProviderKeyChange>;
  /** Records the outcome of a request found without one. */
  readonly settle: (
    change: UnsettledProviderKeyChange,
    outcome: { readonly completed: Completed["outcome"] } | { readonly failed: Failed["reason"] },
  ) => void;
}

/**
 * Journals host-local provider key changes. The payload is the decoded record,
 * which cannot carry the key, its length, or anything derived from it.
 */
export function providerKeyJournal(options: {
  readonly journal: Journal;
  readonly connection: SqliteConnection;
  readonly uuid: () => string;
  readonly now: () => string;
}): ProviderKeyJournal {
  const append = (instanceId: ProviderInstanceId, record: ProviderKeyJournalRecord): void => {
    const decoded = decodeProviderKeyJournalRecord(record);
    options.journal.append({
      aggregate: {
        aggregateType: PROVIDER_KEY_AGGREGATE_TYPE,
        aggregateId: decodeAggregateId(String(instanceId)),
      },
      expectedVersion: readAggregateVersion(
        options.connection,
        PROVIDER_KEY_AGGREGATE_TYPE,
        String(instanceId),
      ),
      events: [
        {
          eventId: decodeEventId(options.uuid()),
          eventName: PROVIDER_KEY_EVENT_NAME,
          eventVersion: 1,
          hostId: LOCAL_HOST_ID,
          correlationId: decodeCorrelationId(options.uuid()),
          actor: { kind: "local-user", actorId: decodeActorId(OCTANT_LOCAL_ACTOR_ID) },
          occurredAt: options.now(),
          payload: decoded,
        },
      ],
    });
  };
  const bestEffort = (instanceId: ProviderInstanceId, record: ProviderKeyJournalRecord): void => {
    try {
      append(instanceId, record);
    } catch {
      // The request stays unsettled, and the next host start settles it.
    }
  };

  return {
    request: (input) => {
      const requestId = options.uuid();
      append(input.instanceId, {
        name: "provider-key.change-requested",
        requestId,
        instanceId: input.instanceId,
        action: input.action,
        instanceVersion: decodeAggregateVersion(input.instanceVersion),
        windowId: input.windowId,
      });
      const common = { requestId, instanceId: input.instanceId, action: input.action };
      return {
        complete: (outcome) =>
          bestEffort(input.instanceId, {
            name: "provider-key.change-completed",
            ...common,
            outcome,
          }),
        fail: (reason) =>
          bestEffort(input.instanceId, { name: "provider-key.change-failed", ...common, reason }),
      };
    },
    unsettled: () => {
      const rows = options.connection
        .prepare(
          `SELECT payload_json FROM event_journal WHERE event_name = ? ORDER BY global_sequence ASC`,
        )
        .all(PROVIDER_KEY_EVENT_NAME) as ReadonlyArray<{ readonly payload_json: string }>;
      const open = new Map<string, Requested>();
      for (const row of rows) {
        let record: ProviderKeyJournalRecord;
        try {
          record = decodeProviderKeyJournalRecord(JSON.parse(row.payload_json));
        } catch {
          continue;
        }
        if (record.name === "provider-key.change-requested") open.set(record.requestId, record);
        else open.delete(record.requestId);
      }
      return [...open.values()].map((request) => ({
        requestId: request.requestId,
        instanceId: request.instanceId,
        action: request.action,
        instanceVersion: request.instanceVersion,
      }));
    },
    settle: (change, outcome) => {
      const common = {
        requestId: change.requestId,
        instanceId: change.instanceId,
        action: change.action,
      };
      bestEffort(
        change.instanceId,
        "completed" in outcome
          ? { name: "provider-key.change-completed", ...common, outcome: outcome.completed }
          : { name: "provider-key.change-failed", ...common, reason: outcome.failed },
      );
    },
  };
}

/**
 * Settles every request the journal holds without an outcome. The credential
 * store and the journal cannot be updated together, so a host that stopped in
 * between may have changed the key or not. Settling is idempotent and never
 * widens anything: it only clears a key that no longer matches its instance.
 *
 * - `set`: a key stored for an instance that is gone or was reconfigured since
 *   the request is cleared; otherwise the store is left as it is.
 * - `remove`: the key is cleared.
 * - `remove-with-provider`: the key is cleared once the instance is gone. An
 *   instance that is still configured means the provider was never removed, so
 *   the key is kept and the request is recorded as abandoned.
 *
 * A store that cannot be reached leaves the request unsettled for the next start.
 */
export async function reconcileProviderKeyChanges(options: {
  readonly journal: Pick<ProviderKeyJournal, "settle">;
  readonly unsettled: ReadonlyArray<UnsettledProviderKeyChange>;
  readonly readInstances: () => ReadonlyArray<ProviderInstance>;
  readonly deleteKey: (instanceId: string) => Promise<void>;
}): Promise<void> {
  for (const change of options.unsettled) {
    const id = String(change.instanceId);
    const current = options.readInstances().find((instance) => String(instance.id) === id);
    try {
      if (change.action === "set") {
        if (current === undefined || current.version !== change.instanceVersion) {
          await options.deleteKey(id);
        }
      } else if (change.action === "remove") {
        await options.deleteKey(id);
      } else if (current !== undefined) {
        options.journal.settle(change, { failed: "abandoned" });
        continue;
      } else {
        await options.deleteKey(id);
      }
    } catch {
      continue;
    }
    options.journal.settle(change, { completed: "reconciled" });
  }
}
