import { CommandCredentialJournalRecord } from "./commandCredentials";
import { GuidString, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
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
import { BrowserCredentialJournalRecord } from "./browserCredentialUse";
import { UtcTimestamp } from "./events";
import { ProviderInstanceId } from "./providers";
import { WindowId } from "./shell";

/** The closed list of tools Octant can link. A new tool is a new literal here. */
export const SecretStoreKind = Schema.Literal("onepassword");
export type SecretStoreKind = typeof SecretStoreKind.Type;

const isControlCharacter = (code: number): boolean => code < 0x20 || code === 0x7f;

/** An item address in a linked store, for example `op://Private/OpenAI/credential`. */
export const SecretStoreItemReference = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
  Schema.makeFilter(
    (value) => [...value].every((character) => !isControlCharacter(character.charCodeAt(0))),
    { message: "A reference has no control characters." },
  ),
);
export type SecretStoreItemReference = typeof SecretStoreItemReference.Type;

export const MAX_SECRET_STORE_BROWSE_ENTRIES = 1_000;

const StoreItemId = Schema.String.check(Schema.isPattern(/^[a-z0-9]{26}$/i));

/** One step into a linked store: its vaults, a vault's items, an item's fields. */
export const SecretStoreBrowseStep = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("vaults") }),
  Schema.Struct({ kind: Schema.Literal("items"), vaultId: StoreItemId }),
  Schema.Struct({ kind: Schema.Literal("fields"), vaultId: StoreItemId, itemId: StoreItemId }),
]);
export type SecretStoreBrowseStep = typeof SecretStoreBrowseStep.Type;

/** A name, and for a field its address. Never anything a field holds. */
export const SecretStoreBrowseEntry = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  reference: Schema.optional(SecretStoreItemReference),
});
export type SecretStoreBrowseEntry = typeof SecretStoreBrowseEntry.Type;

export const SecretStoreBrowseResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("listed"),
    entries: Schema.Array(SecretStoreBrowseEntry).check(
      Schema.isMaxLength(MAX_SECRET_STORE_BROWSE_ENTRIES),
    ),
    /** More were there than are listed. */
    truncated: Schema.Boolean,
  }),
  Schema.Struct({
    status: Schema.Literals(["locked", "missing", "unavailable", "not-linked", "changed"]),
  }),
]);
export type SecretStoreBrowseResult = typeof SecretStoreBrowseResult.Type;

export const decodeSecretStoreBrowseStep = Schema.decodeUnknownSync(
  SecretStoreBrowseStep,
  STRICT_DECODE_OPTIONS,
);
export const decodeSecretStoreBrowseResult = Schema.decodeUnknownSync(
  SecretStoreBrowseResult,
  STRICT_DECODE_OPTIONS,
);

/** Whether the tool is installed and the store is open to it right now. */
export const SecretStoreToolState = Schema.Literals([
  "ready",
  "locked",
  "not-installed",
  "unavailable",
]);
export type SecretStoreToolState = typeof SecretStoreToolState.Type;

export const SecretStoreSummary = Schema.Struct({
  kind: SecretStoreKind,
  label: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
  linked: Schema.Boolean,
  linkedAt: Schema.optional(UtcTimestamp),
  tool: SecretStoreToolState,
});
export type SecretStoreSummary = typeof SecretStoreSummary.Type;

export const SecretStoresView = Schema.Struct({
  kind: Schema.Literal("secret-stores-view"),
  /** False on a host with no credential broker, which cannot link a store. */
  brokerAvailable: Schema.Boolean,
  stores: Schema.Array(SecretStoreSummary).check(Schema.isMaxLength(16)),
});
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
});
export type AwsCliKeyReference = typeof AwsCliKeyReference.Type;

/** Exact selected identity and OAuth scopes; IAM may authorize several Projects. */
export const GoogleCliAccountIdentity = Schema.Struct({
  serviceAccountEmail: Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(256),
    Schema.isPattern(/^[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.gserviceaccount\.com$/),
  ),
  scopes: Schema.Array(
    Schema.String.check(
      Schema.isMaxLength(256),
      Schema.isPattern(/^https:\/\/www\.googleapis\.com\/auth\/[a-zA-Z0-9._/-]+$/),
    ),
  ).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(16),
    Schema.makeFilter((scopes) => new Set(scopes).size === scopes.length),
  ),
});
export const GoogleCliAccountReference = Schema.Struct({
  ...StoreAndReference,
  reference: SecretStoreItemReference.check(Schema.isPattern(/^op:\/\//)),
  ...GoogleCliAccountIdentity.fields,
});
export type GoogleCliAccountReference = typeof GoogleCliAccountReference.Type;
export const decodeGoogleCliAccountReference = Schema.decodeUnknownSync(
  GoogleCliAccountReference,
  STRICT_DECODE_OPTIONS,
);
export const decodeGoogleCliAccountIdentity = Schema.decodeUnknownSync(
  GoogleCliAccountIdentity,
  STRICT_DECODE_OPTIONS,
);

export const SecretStoresCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("point-google-cli-account"),
    confirmed: Schema.Literal(true),
    ...GoogleCliAccountReference.fields,
  }),
  Schema.Struct({ kind: Schema.Literal("clear-google-cli-account") }),
  Schema.Struct({ kind: Schema.Literal("read-google-cli-account") }),
  Schema.Struct({ kind: Schema.Literal("link-store"), store: SecretStoreKind }),
  Schema.Struct({ kind: Schema.Literal("unlink-store"), store: SecretStoreKind }),
  Schema.Struct({ kind: Schema.Literal("check-reference"), ...StoreAndReference }),
  Schema.Struct({
    kind: Schema.Literal("point-provider-key"),
    instanceId: ProviderInstanceId,
    ...StoreAndReference,
  }),
  Schema.Struct({
    kind: Schema.Literal("clear-provider-key-reference"),
    instanceId: ProviderInstanceId,
  }),
  Schema.Struct({
    kind: Schema.Literal("read-provider-key-reference"),
    instanceId: ProviderInstanceId,
  }),
  Schema.Struct({
    kind: Schema.Literal("point-aws-cli-key"),
    ...AwsCliKeyReference.fields,
  }),
  Schema.Struct({ kind: Schema.Literal("clear-aws-cli-key") }),
  Schema.Struct({ kind: Schema.Literal("read-aws-cli-key") }),
]);
export type SecretStoresCommand = typeof SecretStoresCommand.Type;

export const SecretStoreCheckOutcome = Schema.Literals([
  "found",
  "locked",
  "missing",
  "unavailable",
  "not-linked",
  "invalid-reference",
]);
export type SecretStoreCheckOutcome = typeof SecretStoreCheckOutcome.Type;

export const SecretStoreRefusalReason = Schema.Literals([
  "malformed",
  "credential-refused",
  "selection-changed",
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
]);
export type SecretStoreRefusalReason = typeof SecretStoreRefusalReason.Type;

const Message = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512));

/** The plain words for each refusal, so every surface says the same thing. */
export const SECRET_STORE_REFUSAL_MESSAGES: Readonly<Record<SecretStoreRefusalReason, string>> = {
  malformed: "That request was not understood.",
  "credential-refused":
    "The linked item is not a usable key for the selected service account. Check the item, account and scopes.",
  "selection-changed":
    "The selected account changed while it was being checked. Read the current account before trying again.",
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

export const SecretStoresResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("secret-stores-google-cli-account"),
    reference: Schema.NullOr(GoogleCliAccountReference),
    sessionExpiresAt: Schema.optional(UtcTimestamp),
  }),
  SecretStoresView,
  Schema.Struct({
    kind: Schema.Literal("secret-stores-checked"),
    store: SecretStoreKind,
    outcome: SecretStoreCheckOutcome,
  }),
  Schema.Struct({
    kind: Schema.Literal("secret-stores-provider-reference"),
    instanceId: ProviderInstanceId,
    /** The item this provider's key comes from, or null when it has none. */
    reference: Schema.NullOr(Schema.Struct(StoreAndReference)),
  }),
  Schema.Struct({
    kind: Schema.Literal("secret-stores-aws-cli-key"),
    /** The items the AWS command line's key pair comes from, or null when it has none. */
    reference: Schema.NullOr(AwsCliKeyReference),
  }),
  Schema.Struct({
    kind: Schema.Literal("secret-stores-refused"),
    reason: SecretStoreRefusalReason,
    message: Message,
  }),
]);
export type SecretStoresResult = typeof SecretStoresResult.Type;

export const SECRET_STORE_EVENT_NAME = "secret-store.recorded@1";
export const SECRET_STORE_AGGREGATE_TYPE = "secret-store";

const CredentialTarget = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("google-cli-account"),
    ...GoogleCliAccountIdentity.fields,
  }),
  Schema.Struct({
    kind: Schema.Literal("provider-key"),
    instanceId: ProviderInstanceId,
  }),
  Schema.Struct({
    kind: Schema.Literal("connector-secret"),
    secretId: GuidString,
  }),
  Schema.Struct({
    kind: Schema.Literal("aws-cli-key"),
    part: Schema.Literals(["access-key-id", "secret-access-key"]),
  }),
]);

/**
 * What the journal keeps: a store linked or unlinked, and each change to a
 * credential's reference. A reference names an item; the value it resolves to
 * is never an input to any of these records.
 */
export const SecretStoreJournalRecord = Schema.Union([
  BrowserCredentialJournalRecord,
  CommandCredentialJournalRecord,
  Schema.Struct({
    name: Schema.Literal("secret-store.linked"),
    store: SecretStoreKind,
    windowId: WindowId,
  }),
  Schema.Struct({
    name: Schema.Literal("secret-store.unlinked"),
    store: SecretStoreKind,
    windowId: WindowId,
  }),
  Schema.Struct({
    /** Person-confirmed intent; an unavailable broker reply does not prove a change committed. */
    name: Schema.Literal("credential-reference.requested"),
    target: Schema.Struct({
      kind: Schema.Literal("google-cli-account"),
      ...GoogleCliAccountIdentity.fields,
    }),
    ...StoreAndReference,
    replaced: Schema.Boolean,
    windowId: WindowId,
  }),
  Schema.Struct({
    name: Schema.Literal("credential-reference.set"),
    target: CredentialTarget,
    ...StoreAndReference,
    /** True when it replaced an earlier reference for the same credential. */
    replaced: Schema.Boolean,
    windowId: Schema.optional(WindowId),
  }),
  Schema.Struct({
    name: Schema.Literal("credential-reference.cleared"),
    target: CredentialTarget,
    ...StoreAndReference,
    windowId: Schema.optional(WindowId),
  }),
]);
export type SecretStoreJournalRecord = typeof SecretStoreJournalRecord.Type;

export const decodeSecretStoresView = Schema.decodeUnknownSync(
  SecretStoresView,
  STRICT_DECODE_OPTIONS,
);
export const decodeSecretStoresCommand = Schema.decodeUnknownSync(
  SecretStoresCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeSecretStoresResult = Schema.decodeUnknownSync(
  SecretStoresResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeSecretStoreJournalRecord = Schema.decodeUnknownSync(
  SecretStoreJournalRecord,
  STRICT_DECODE_OPTIONS,
);
