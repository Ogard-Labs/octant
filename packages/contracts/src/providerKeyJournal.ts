import { Schema } from "effect";
import { AggregateVersion } from "./events";
import { ProviderInstanceId } from "./providers";
import { WindowId } from "./shell";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * What a host-local `octant provider key` or `octant provider remove` command
 * changed in the host credential store. The store and the journal cannot be
 * updated atomically, so each change is recorded as a request before the store
 * is touched and as an outcome after.
 *
 * No record can carry key material: excess fields are rejected, and nothing
 * here is derived from the key (no length, prefix, or hash, because a hash of a
 * short key can be guessed offline).
 */
export const ProviderKeyChangeAction = Schema.Literal("set", "remove", "remove-with-provider");
export type ProviderKeyChangeAction = typeof ProviderKeyChangeAction.Type;

export const PROVIDER_KEY_EVENT_NAME = "provider-key.recorded@1";
export const PROVIDER_KEY_AGGREGATE_TYPE = "provider-key";

const RequestId = Schema.UUID;

/**
 * A key's id in its provider's pool: random, never derived from the key.
 * `default` is the one key a plain stored value holds.
 */
const ApiKeyId = Schema.String.pipe(
  Schema.pattern(/^(default|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/),
);

export const ProviderKeyJournalRecord = Schema.Union(
  Schema.Struct({
    name: Schema.Literal("provider-key.change-requested"),
    requestId: RequestId,
    instanceId: ProviderInstanceId,
    action: ProviderKeyChangeAction,
    /** The instance version the change was made against, so a restart can tell a later reconfiguration. */
    instanceVersion: AggregateVersion,
    windowId: WindowId,
    /**
     * On a `set` that stores a new secret: whether it added a key (and which,
     * so a change notice's Undo removes exactly that one) or replaced one.
     * Absent on a rename, a reorder, a change of active key, and on every
     * record written before change notices.
     */
    keyChange: Schema.optional(Schema.Literal("added", "replaced")),
    keyId: Schema.optional(ApiKeyId),
  }).annotations(strict),
  Schema.Struct({
    name: Schema.Literal("provider-key.change-completed"),
    requestId: RequestId,
    instanceId: ProviderInstanceId,
    action: ProviderKeyChangeAction,
    /**
     * `cleared-after-change`: a `set` stored the key and then cleared it because the
     * instance was removed or reconfigured meanwhile. `reconciled`: a restart
     * found the request without an outcome and settled the store.
     */
    outcome: Schema.Literal("stored", "removed", "cleared-after-change", "reconciled"),
    /**
     * The pool's key ids after the change, in stored order. Ids are random or
     * `default`, never derived from a key, so a change notice's Undo can hold
     * the pool to this list before it removes a key.
     */
    keyIds: Schema.optional(Schema.Array(ApiKeyId)),
    /**
     * A hash of the stored pool after the change, covering the key ids and
     * the active key, so the same Undo refuses an edit the journal never
     * saw. Missing on events journaled before it was recorded.
     */
    fingerprint: Schema.optional(Schema.String),
  }).annotations(strict),
  Schema.Struct({
    name: Schema.Literal("provider-key.change-failed"),
    requestId: RequestId,
    instanceId: ProviderInstanceId,
    action: ProviderKeyChangeAction,
    /** `abandoned`: a removal with its provider never reached the provider, so the key was kept. */
    reason: Schema.Literal("abandoned"),
  }).annotations(strict),
);
export type ProviderKeyJournalRecord = typeof ProviderKeyJournalRecord.Type;

export const decodeProviderKeyJournalRecord = Schema.decodeUnknownSync(ProviderKeyJournalRecord);
