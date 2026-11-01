/**
 * Linked external secret stores: Settings › Secret stores, and the record the
 * journal keeps of them.
 *
 * A person links a secret store they already use (the 1Password CLI today) and
 * points a provider API key at an item in it instead of pasting the value.
 * Octant keeps only a reference, a store name and an item address, which names
 * an item and is not a secret. The host's credential broker fetches the value
 * when it is used and hands it to the provider. No type here has a field for a
 * value, and every schema refuses a field it does not name, so a value cannot
 * be journaled, echoed to the renderer, or logged by riding along.
 */

import { Schema } from "effect";
import { UtcTimestamp } from "./events";
import { ProviderInstanceId } from "./providers";
import { WindowId } from "./shell";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/** The closed list of tools Octant can link. A new tool is a new literal here. */
export const SecretStoreKind = Schema.Literal("onepassword");
export type SecretStoreKind = typeof SecretStoreKind.Type;

const isControlCharacter = (code: number): boolean => code < 0x20 || code === 0x7f;

/** An item address in a linked store, for example `op://Private/OpenAI/credential`. */
export const SecretStoreItemReference = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(512),
  Schema.filter(
    (value) => [...value].every((character) => !isControlCharacter(character.charCodeAt(0))),
    { message: () => "A reference has no control characters." },
  ),
);
export type SecretStoreItemReference = typeof SecretStoreItemReference.Type;

/** Whether the tool is installed and the store is open to it right now. */
export const SecretStoreToolState = Schema.Literal(
  "ready",
  "locked",
  "not-installed",
  "unavailable",
);
export type SecretStoreToolState = typeof SecretStoreToolState.Type;

export const SecretStoreSummary = Schema.Struct({
  kind: SecretStoreKind,
  label: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64)),
  linked: Schema.Boolean,
  linkedAt: Schema.optional(UtcTimestamp),
  tool: SecretStoreToolState,
}).annotations(strict);
export type SecretStoreSummary = typeof SecretStoreSummary.Type;

export const SecretStoresView = Schema.Struct({
  kind: Schema.Literal("secret-stores-view"),
  /** False on a host with no credential broker, which cannot link a store. */
  brokerAvailable: Schema.Boolean,
  stores: Schema.Array(SecretStoreSummary).pipe(Schema.maxItems(16)),
}).annotations(strict);
export type SecretStoresView = typeof SecretStoresView.Type;

const StoreAndReference = {
  store: SecretStoreKind,
  reference: SecretStoreItemReference,
} as const;

/**
 * The two items that hold the person's AWS access key pair, for the AWS command
 * line in Octant's own shell. The broker reads them only to ask AWS for a
 * short-lived session and hands out that session alone.
 */
export const AwsCliKeyReference = Schema.Struct({
  store: SecretStoreKind,
  accessKeyIdReference: SecretStoreItemReference,
  secretAccessKeyReference: SecretStoreItemReference,
}).annotations(strict);
export type AwsCliKeyReference = typeof AwsCliKeyReference.Type;

export const SecretStoresCommand = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("link-store"), store: SecretStoreKind }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("unlink-store"), store: SecretStoreKind }).annotations(
    strict,
  ),
  /** Proves an item resolves right now, without returning it. */
  Schema.Struct({ kind: Schema.Literal("check-reference"), ...StoreAndReference }).annotations(
    strict,
  ),
  Schema.Struct({
    kind: Schema.Literal("point-provider-key"),
    instanceId: ProviderInstanceId,
    ...StoreAndReference,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("clear-provider-key-reference"),
    instanceId: ProviderInstanceId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("read-provider-key-reference"),
    instanceId: ProviderInstanceId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("point-aws-cli-key"),
    ...AwsCliKeyReference.fields,
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("clear-aws-cli-key") }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("read-aws-cli-key") }).annotations(strict),
);
export type SecretStoresCommand = typeof SecretStoresCommand.Type;

export const SecretStoreCheckOutcome = Schema.Literal(
  "found",
  "locked",
  "missing",
  "unavailable",
  "not-linked",
  "invalid-reference",
);
export type SecretStoreCheckOutcome = typeof SecretStoreCheckOutcome.Type;

export const SecretStoreRefusalReason = Schema.Literal(
  "malformed",
  "broker-unavailable",
  "store-locked",
  "tool-not-installed",
  "store-unavailable",
  "item-missing",
  "not-linked",
  "invalid-reference",
  "unknown-provider",
  "no-stored-key-authentication",
  "key-already-stored",
  "provider-changed",
  "journal-unavailable",
);
export type SecretStoreRefusalReason = typeof SecretStoreRefusalReason.Type;

const Message = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512));

/** The plain words for each refusal, so every surface says the same thing. */
export const SECRET_STORE_REFUSAL_MESSAGES: Readonly<Record<SecretStoreRefusalReason, string>> = {
  malformed: "That request was not understood.",
  "broker-unavailable": "This host has no credential broker, so it cannot link a secret store.",
  "store-locked": "The secret store is locked. Unlock it, then try again.",
  "tool-not-installed": "The secret store's command line tool is not installed.",
  "store-unavailable": "The secret store could not be reached.",
  "item-missing": "No item with that reference was found in the secret store.",
  "not-linked": "That secret store is not linked. Link it in Settings first.",
  "invalid-reference": "That is not a valid item reference for this secret store.",
  "unknown-provider": "No provider has that id.",
  "no-stored-key-authentication": "That provider does not use an API key or bearer token.",
  "key-already-stored":
    "That provider already has a stored key. Remove the key first, then point it at an item.",
  "provider-changed":
    "That provider was removed or reconfigured while the item was being checked, so the item was not kept.",
  "journal-unavailable": "The change could not be recorded, so nothing was changed.",
};

export const SecretStoresResult = Schema.Union(
  SecretStoresView,
  Schema.Struct({
    kind: Schema.Literal("secret-stores-checked"),
    store: SecretStoreKind,
    outcome: SecretStoreCheckOutcome,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("secret-stores-provider-reference"),
    instanceId: ProviderInstanceId,
    /** The item this provider's key comes from, or null when it has none. */
    reference: Schema.NullOr(Schema.Struct(StoreAndReference).annotations(strict)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("secret-stores-aws-cli-key"),
    /** The items the AWS command line's key pair comes from, or null when it has none. */
    reference: Schema.NullOr(AwsCliKeyReference),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("secret-stores-refused"),
    reason: SecretStoreRefusalReason,
    message: Message,
  }).annotations(strict),
);
export type SecretStoresResult = typeof SecretStoresResult.Type;

export const SECRET_STORE_EVENT_NAME = "secret-store.recorded@1";
export const SECRET_STORE_AGGREGATE_TYPE = "secret-store";

const CredentialTarget = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("provider-key"),
    instanceId: ProviderInstanceId,
  }).annotations(strict),
  /** A secret value a person gave an MCP server they added by hand. */
  Schema.Struct({
    kind: Schema.Literal("connector-secret"),
    secretId: Schema.UUID,
  }).annotations(strict),
  /** One half of the AWS command line's key pair; a change journals both halves together. */
  Schema.Struct({
    kind: Schema.Literal("aws-cli-key"),
    part: Schema.Literal("access-key-id", "secret-access-key"),
  }).annotations(strict),
);

/**
 * What the journal keeps: a store linked or unlinked, and each change to a
 * credential's reference. A reference names an item; the value it resolves to
 * is never an input to any of these records.
 */
export const SecretStoreJournalRecord = Schema.Union(
  Schema.Struct({
    name: Schema.Literal("secret-store.linked"),
    store: SecretStoreKind,
    windowId: WindowId,
  }).annotations(strict),
  Schema.Struct({
    name: Schema.Literal("secret-store.unlinked"),
    store: SecretStoreKind,
    windowId: WindowId,
  }).annotations(strict),
  Schema.Struct({
    name: Schema.Literal("credential-reference.set"),
    target: CredentialTarget,
    ...StoreAndReference,
    /** True when it replaced an earlier reference for the same credential. */
    replaced: Schema.Boolean,
    windowId: Schema.optional(WindowId),
  }).annotations(strict),
  Schema.Struct({
    name: Schema.Literal("credential-reference.cleared"),
    target: CredentialTarget,
    ...StoreAndReference,
    windowId: Schema.optional(WindowId),
  }).annotations(strict),
);
export type SecretStoreJournalRecord = typeof SecretStoreJournalRecord.Type;

export const decodeSecretStoresView = Schema.decodeUnknownSync(SecretStoresView);
export const decodeSecretStoresCommand = Schema.decodeUnknownSync(SecretStoresCommand);
export const decodeSecretStoresResult = Schema.decodeUnknownSync(SecretStoresResult);
export const decodeSecretStoreJournalRecord = Schema.decodeUnknownSync(SecretStoreJournalRecord);
