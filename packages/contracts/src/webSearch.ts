import { Schema } from "effect";
import { UtcTimestamp } from "./events";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));
const BoundedText = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255));

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

export const WebSearchBackendKind = Schema.Literal(
  "searxng",
  "staan",
  "mojeek",
  "linkup",
  "brave",
  "exa",
);
export type WebSearchBackendKind = typeof WebSearchBackendKind.Type;

export const WebSearchDataPolicy = Schema.Literal("any", "zdr-only", "eu-only", "eu-and-zdr");
export type WebSearchDataPolicy = typeof WebSearchDataPolicy.Type;

/** At most this many backends; a longer list only adds vendors a query might reach. */
export const MAX_WEB_SEARCH_BACKENDS = 8;

export const WebSearchBackendEntry = Schema.Struct({
  id: WebSearchBackendId,
  kind: WebSearchBackendKind,
  /** The instance or regional host, where the kind has more than one. */
  address: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2_048))),
  /**
   * Where the broker keeps this entry's API key, for a kind that takes one.
   * The host assigns it; a key is never part of the settings.
   */
  credentialRef: Schema.optional(Schema.UUID),
  enabled: Schema.Boolean,
  /** The person's statement: "This vendor keeps no record of my queries." */
  statesZdr: Schema.Boolean,
  /** The person's statement: "This vendor processes my queries only in the EU or UK." */
  statesEuProcessing: Schema.Boolean,
}).annotations(strict);
export type WebSearchBackendEntry = typeof WebSearchBackendEntry.Type;

export const WebSearchSettings = Schema.Struct({
  policy: WebSearchDataPolicy,
  backends: Schema.Array(WebSearchBackendEntry).pipe(Schema.maxItems(MAX_WEB_SEARCH_BACKENDS)),
}).annotations(strict);
export type WebSearchSettings = typeof WebSearchSettings.Type;

/**
 * Why an entry may not receive a query under the current policy. A statement
 * its vendor does not offer counts as not made, so a stored statement the
 * offer table no longer supports stops a query rather than passing one.
 */
export const WebSearchIneligibleReason = Schema.Literal(
  "disabled",
  "zdr-not-stated",
  "eu-processing-not-stated",
);
export type WebSearchIneligibleReason = typeof WebSearchIneligibleReason.Type;

export const WebSearchBackendState = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("ready") }).annotations(strict),
  /** No key is stored, or the vendor refused the stored one. */
  Schema.Struct({ kind: Schema.Literal("needs-key") }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("not-eligible"),
    reason: WebSearchIneligibleReason,
  }).annotations(strict),
);
export type WebSearchBackendState = typeof WebSearchBackendState.Type;

/**
 * What Settings reads: the list as stored, or as migrated from the SearXNG
 * address Chat settings held before the list existed, with each entry's state.
 */
export const WebSearchSettingsView = Schema.Struct({
  settings: WebSearchSettings,
  source: Schema.Literal("saved", "migrated"),
  states: Schema.Array(
    Schema.Struct({ id: WebSearchBackendId, state: WebSearchBackendState }).annotations(strict),
  ),
}).annotations(strict);
export type WebSearchSettingsView = typeof WebSearchSettingsView.Type;

export const SetWebSearchSettingsRequest = Schema.Struct({
  settings: WebSearchSettings,
}).annotations(strict);
export type SetWebSearchSettingsRequest = typeof SetWebSearchSettingsRequest.Type;

export const WebSearchSettingsRefusalCode = Schema.Literal(
  "unauthorized",
  "duplicate-entry",
  "address-required",
  "address-not-taken",
  "invalid-address",
  "statement-not-offered",
);
export type WebSearchSettingsRefusalCode = typeof WebSearchSettingsRefusalCode.Type;

export const SetWebSearchSettingsOutcome = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("saved"), view: WebSearchSettingsView }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    code: WebSearchSettingsRefusalCode,
    message: BoundedText,
  }).annotations(strict),
);
export type SetWebSearchSettingsOutcome = typeof SetWebSearchSettingsOutcome.Type;

/**
 * A key for one entry. An absent key deletes the stored one. The key goes to
 * the credential broker and nowhere else: not the settings, the journal, or a
 * window.
 */
export const SetWebSearchKeyRequest = Schema.Struct({
  entryId: WebSearchBackendId,
  key: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512))),
}).annotations(strict);
export type SetWebSearchKeyRequest = typeof SetWebSearchKeyRequest.Type;

export const SetWebSearchKeyOutcome = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("saved"), view: WebSearchSettingsView }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    code: Schema.Literal("unauthorized", "unknown-entry", "key-not-taken", "unavailable"),
    message: BoundedText,
  }).annotations(strict),
);
export type SetWebSearchKeyOutcome = typeof SetWebSearchKeyOutcome.Type;

/**
 * Why a backend did not answer a query. Each moves the query to the next
 * eligible backend except `refused-query`, where the vendor answered with a
 * refusal of the query itself, and `not-tried`, where the call's budget ran out
 * first.
 */
export const WebSearchBackendFailure = Schema.Literal(
  "network",
  "timeout",
  "rate-limited",
  "server-error",
  "key-refused",
  "needs-key",
  "refused-query",
  "not-tried",
);
export type WebSearchBackendFailure = typeof WebSearchBackendFailure.Type;

export const WEB_SEARCH_CALLS_AGGREGATE_TYPE = "web-search-calls";
export const WEB_SEARCH_CALL_ROUTED_EVENT_NAME = "web-search.call-routed@1";

/**
 * Where one query went: the backend that answered, if any, and each one that
 * failed or was not tried. The query itself stays with the thread's own tool
 * call; this record names only backends, for the person to read.
 */
export const WebSearchCallRouted = Schema.Struct({
  kind: Schema.Literal("web-search-call-routed"),
  answeredBy: Schema.optional(
    Schema.Struct({ entryId: WebSearchBackendId, backend: WebSearchBackendKind }).annotations(
      strict,
    ),
  ),
  failed: Schema.Array(
    Schema.Struct({
      entryId: WebSearchBackendId,
      backend: WebSearchBackendKind,
      failure: WebSearchBackendFailure,
    }).annotations(strict),
  ),
  routedAt: UtcTimestamp,
}).annotations(strict);
export type WebSearchCallRouted = typeof WebSearchCallRouted.Type;

export const WEB_SEARCH_SETTINGS_AGGREGATE_TYPE = "web-search-settings";
export const WEB_SEARCH_SETTINGS_EVENT_NAME = "web-search.settings-changed@1";

/** One journaled change: who made it, when, and the settings before and after. */
export const WebSearchSettingsChanged = Schema.Struct({
  kind: Schema.Literal("web-search-settings-changed"),
  previous: WebSearchSettings,
  next: WebSearchSettings,
  changedBy: Schema.Literal("local-window", "remote-device"),
  changedAt: UtcTimestamp,
}).annotations(strict);
export type WebSearchSettingsChanged = typeof WebSearchSettingsChanged.Type;

export const decodeWebSearchSettings = Schema.decodeUnknownSync(WebSearchSettings, {
  onExcessProperty: "error",
});
export const decodeWebSearchSettingsView = Schema.decodeUnknownSync(WebSearchSettingsView, {
  onExcessProperty: "error",
});
export const decodeSetWebSearchSettingsRequest = Schema.decodeUnknownSync(
  SetWebSearchSettingsRequest,
  { onExcessProperty: "error" },
);
export const decodeSetWebSearchSettingsOutcome = Schema.decodeUnknownSync(
  SetWebSearchSettingsOutcome,
  { onExcessProperty: "error" },
);
export const decodeWebSearchSettingsChanged = Schema.decodeUnknownSync(WebSearchSettingsChanged, {
  onExcessProperty: "error",
});
export const decodeWebSearchBackendId = Schema.decodeUnknownSync(WebSearchBackendId);
export const decodeSetWebSearchKeyRequest = Schema.decodeUnknownSync(SetWebSearchKeyRequest, {
  onExcessProperty: "error",
});
export const decodeSetWebSearchKeyOutcome = Schema.decodeUnknownSync(SetWebSearchKeyOutcome, {
  onExcessProperty: "error",
});
export const decodeWebSearchCallRouted = Schema.decodeUnknownSync(WebSearchCallRouted, {
  onExcessProperty: "error",
});
