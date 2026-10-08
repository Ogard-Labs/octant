import { AggregateId } from "@octant/contracts";
import {
  REPLICA_STORE_SETTINGS_CHANGED,
  ReplicaStoreSettings,
} from "@octant/contracts/replica-store-settings";
import { Schema } from "effect";
import type { EventRegistry } from "../persistence/eventRegistry";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * One host-wide settings aggregate. The version is the state machine's: a
 * change names the version it read, so two windows cannot quietly overwrite
 * each other's choice.
 */
export const REPLICA_STORE_SETTINGS_AGGREGATE_ID = Schema.decodeUnknownSync(AggregateId)(
  "00000000-0000-4000-8000-0000000000c6",
);

/**
 * The whole settings document is the frame; the last one wins on replay. The
 * document's own schema refuses any field it does not name, so a bucket's key
 * pair cannot ride along into the journal.
 */
export const ReplicaStoreSettingsChanged = Schema.Struct({
  settings: ReplicaStoreSettings,
}).annotations(strict);

export function registerReplicaStoreSettingsEvents(registry: EventRegistry): EventRegistry {
  return registry.register(REPLICA_STORE_SETTINGS_CHANGED, 1, ReplicaStoreSettingsChanged);
}
