import { Schema } from "effect";
import { GuidString, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { AggregateId, UtcTimestamp } from "./events";

const brandedUuid = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.String.pipe(Schema.check(Schema.isGUID()), Schema.brand<B>(brand));
const BoundedText = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(255));

/**
 * Where Octant's own `web-search` sends a query: the ordered list of search
 * backends the host's person set up, and the one data policy that decides
 * which of them may receive a query (docs/design/web-search-backends.md).
 *
 * Nothing here is a secret: an entry names a credential reference, and the key
 * itself stays in the host's credential broker.
 */

export const WebSearchBackendId = brandedUuid("WebSearchBackendId");
export type WebSearchBackendId = typeof WebSearchBackendId.Type;

export const WebSearchBackendKind = Schema.Literals([
  "searxng",
  "staan",
  "mojeek",
  "linkup",
  "brave",
  "exa",
]);
export type WebSearchBackendKind = typeof WebSearchBackendKind.Type;

export const WebSearchDataPolicy = Schema.Literals(["any", "zdr-only", "eu-only", "eu-and-zdr"]);
export type WebSearchDataPolicy = typeof WebSearchDataPolicy.Type;

/** At most this many backends; a longer list only adds vendors a query might reach. */
export const MAX_WEB_SEARCH_BACKENDS = 8;

export const WebSearchBackendEntry = Schema.Struct({
  id: WebSearchBackendId,
  kind: WebSearchBackendKind,
  /** The instance or regional host, where the kind has more than one. */
  address: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2_048))),
  /**
   * Where the broker keeps this entry's API key, for a kind that takes one.
   * The host assigns it; a key is never part of the settings.
   */
  credentialRef: Schema.optional(GuidString),
  enabled: Schema.Boolean,
  /** The person's statement: "This vendor keeps no record of my queries." */
  statesZdr: Schema.Boolean,
  /** The person's statement: "This vendor processes my queries only in the EU or UK." */
  statesEuProcessing: Schema.Boolean,
});
export type WebSearchBackendEntry = typeof WebSearchBackendEntry.Type;

export const WebSearchSettings = Schema.Struct({
  policy: WebSearchDataPolicy,
  backends: Schema.Array(WebSearchBackendEntry).check(Schema.isMaxLength(MAX_WEB_SEARCH_BACKENDS)),
});
export type WebSearchSettings = typeof WebSearchSettings.Type;

/**
 * Why an entry may not receive a query under the current policy. A statement
 * its vendor does not offer counts as not made, so a stored statement the
 * offer table no longer supports stops a query rather than passing one.
 */
export const WebSearchIneligibleReason = Schema.Literals([
  "disabled",
  "zdr-not-stated",
  "eu-processing-not-stated",
]);
export type WebSearchIneligibleReason = typeof WebSearchIneligibleReason.Type;

export const WebSearchBackendState = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ready") }),
  Schema.Struct({ kind: Schema.Literal("needs-key") }),
  Schema.Struct({
    kind: Schema.Literal("not-eligible"),
    reason: WebSearchIneligibleReason,
  }),
]);
export type WebSearchBackendState = typeof WebSearchBackendState.Type;

/**
 * What Settings reads: the list as stored, or as migrated from the SearXNG
 * address Chat settings held before the list existed, with each entry's state.
 */
export const WebSearchSettingsView = Schema.Struct({
  settings: WebSearchSettings,
  source: Schema.Literals(["saved", "migrated"]),
  states: Schema.Array(Schema.Struct({ id: WebSearchBackendId, state: WebSearchBackendState })),
});
export type WebSearchSettingsView = typeof WebSearchSettingsView.Type;

export const SetWebSearchSettingsRequest = Schema.Struct({
  settings: WebSearchSettings,
});
export type SetWebSearchSettingsRequest = typeof SetWebSearchSettingsRequest.Type;

export const WebSearchSettingsRefusalCode = Schema.Literals([
  "unauthorized",
  "duplicate-entry",
  "address-required",
  "address-not-taken",
  "invalid-address",
  "statement-not-offered",
]);
export type WebSearchSettingsRefusalCode = typeof WebSearchSettingsRefusalCode.Type;

export const SetWebSearchSettingsOutcome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("saved"), view: WebSearchSettingsView }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    code: WebSearchSettingsRefusalCode,
    message: BoundedText,
  }),
]);
export type SetWebSearchSettingsOutcome = typeof SetWebSearchSettingsOutcome.Type;

/**
 * A key for one entry. An absent key deletes the stored one. The key goes to
 * the credential broker and nowhere else: not the settings, the journal, or a
 * window.
 */
export const SetWebSearchKeyRequest = Schema.Struct({
  entryId: WebSearchBackendId,
  key: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512))),
});
export type SetWebSearchKeyRequest = typeof SetWebSearchKeyRequest.Type;

export const SetWebSearchKeyOutcome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("saved"), view: WebSearchSettingsView }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    code: Schema.Literals(["unauthorized", "unknown-entry", "key-not-taken", "unavailable"]),
    message: BoundedText,
  }),
]);
export type SetWebSearchKeyOutcome = typeof SetWebSearchKeyOutcome.Type;

/**
 * Why a backend did not answer a query. Each moves the query to the next
 * eligible backend except `refused-query`, where the vendor answered with a
 * refusal of the query itself, and `not-tried`, where the call's budget ran out
 * first.
 */
export const WebSearchBackendFailure = Schema.Literals([
  "network",
  "timeout",
  "rate-limited",
  "server-error",
  "key-refused",
  "needs-key",
  "refused-query",
  "not-tried",
]);
export type WebSearchBackendFailure = typeof WebSearchBackendFailure.Type;

export const WEB_SEARCH_CALLS_AGGREGATE_TYPE = "web-search-calls";
export const WEB_SEARCH_CALL_ROUTED_EVENT_NAME = "web-search.call-routed@1";

/**
 * Where one query went: the backend that answered, if any, and each one that
 * failed or was not tried. The query itself stays with the thread's own tool
 * call; this record names only backends, for the person to read, and the
 * thread and tool call it belongs to, so it reads beside that call.
 */
export const WebSearchCallRouted = Schema.Struct({
  kind: Schema.Literal("web-search-call-routed"),
  /** The thread whose turn searched; absent only for a search no thread made. */
  threadId: Schema.optional(AggregateId),
  /** The provider's id for the tool call, as the thread's tool row carries it, when it gave one. */
  toolCallId: Schema.optional(BoundedText),
  answeredBy: Schema.optional(
    Schema.Struct({ entryId: WebSearchBackendId, backend: WebSearchBackendKind }),
  ),
  failed: Schema.Array(
    Schema.Struct({
      entryId: WebSearchBackendId,
      backend: WebSearchBackendKind,
      failure: WebSearchBackendFailure,
    }),
  ),
  routedAt: UtcTimestamp,
});
export type WebSearchCallRouted = typeof WebSearchCallRouted.Type;

export const WEB_SEARCH_SETTINGS_AGGREGATE_TYPE = "web-search-settings";
export const WEB_SEARCH_SETTINGS_EVENT_NAME = "web-search.settings-changed@1";

/** One journaled change: who made it, when, and the settings before and after. */
export const WebSearchSettingsChanged = Schema.Struct({
  kind: Schema.Literal("web-search-settings-changed"),
  previous: WebSearchSettings,
  next: WebSearchSettings,
  changedBy: Schema.Literals(["local-window", "remote-device"]),
  changedAt: UtcTimestamp,
});
export type WebSearchSettingsChanged = typeof WebSearchSettingsChanged.Type;

export const decodeWebSearchSettings = Schema.decodeUnknownSync(WebSearchSettings, {
  onExcessProperty: "error",
});
export const decodeWebSearchSettingsView = Schema.decodeUnknownSync(WebSearchSettingsView, {
  onExcessProperty: "error",
});
export const decodeSetWebSearchSettingsRequest = Schema.decodeUnknownSync(
  SetWebSearchSettingsRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeSetWebSearchSettingsOutcome = Schema.decodeUnknownSync(
  SetWebSearchSettingsOutcome,
  STRICT_DECODE_OPTIONS,
);
export const decodeWebSearchSettingsChanged = Schema.decodeUnknownSync(WebSearchSettingsChanged, {
  onExcessProperty: "error",
});
export const decodeWebSearchBackendId = Schema.decodeUnknownSync(
  WebSearchBackendId,
  STRICT_DECODE_OPTIONS,
);
export const decodeSetWebSearchKeyRequest = Schema.decodeUnknownSync(SetWebSearchKeyRequest, {
  onExcessProperty: "error",
});
export const decodeSetWebSearchKeyOutcome = Schema.decodeUnknownSync(SetWebSearchKeyOutcome, {
  onExcessProperty: "error",
});
export const decodeWebSearchCallRouted = Schema.decodeUnknownSync(WebSearchCallRouted, {
  onExcessProperty: "error",
});
