import { Schema } from "effect";
import { UtcTimestamp } from "./events";
import { HubMemberId } from "./hubAndSpokes";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * The provider accounts the hub can ask a spoke to sign in to: the sign-in a
 * provider's own app holds. Nothing here is a token, a code, or an address: a
 * request names a kind and nothing else, and the sign-in itself is the
 * provider's own flow on the spoke.
 */
export const HUB_SIGN_IN_KINDS = ["claude-subscription", "codex-subscription"] as const;
export const HubSignInKind = Schema.Literal(...HUB_SIGN_IN_KINDS);
export type HubSignInKind = typeof HubSignInKind.Type;

export const HubSignInRequestId = Schema.UUID.pipe(Schema.brand("HubSignInRequestId"));
export type HubSignInRequestId = typeof HubSignInRequestId.Type;

/** How long a request waits for a person on the spoke, and then how long a sign-in may take. */
export const HUB_SIGN_IN_LIFETIME_MS = 10 * 60_000;
/** How many requests one requester may send a spoke in an hour. */
export const HUB_SIGN_IN_HOURLY_LIMIT = 3;

/**
 * The only word the hub learns about how a request ended. A spoke that
 * refuses a request outright answers with one of the reasons below instead.
 */
export const HubSignInOutcome = Schema.Literal("signed-in", "declined", "expired", "failed");
export type HubSignInOutcome = typeof HubSignInOutcome.Type;

/** Why a request came to nothing before a person on the spoke saw it, or could act on it. */
export const HubSignInReason = Schema.Literal(
  "hub-role-off",
  "unknown-member",
  "unreachable",
  "sign-in-not-granted",
  "unknown-kind",
  "already-signed-in",
  "already-asked",
  "rate-limited",
  "expired",
  "unknown-request",
  "not-accepted-yet",
  "malformed",
  "answer-refused",
);
export type HubSignInReason = typeof HubSignInReason.Type;

/** The person on the hub asking one spoke to sign in to one provider account kind. */
export const HubSignInAsk = Schema.Struct({
  memberId: HubMemberId,
  kind: HubSignInKind,
}).annotations(strict);
export type HubSignInAsk = typeof HubSignInAsk.Type;
export const decodeHubSignInAsk = Schema.decodeUnknownSync(HubSignInAsk);

/**
 * What the hub relays to the spoke. The kind is read as text so a kind this
 * build does not know is refused as `unknown-kind` rather than as a malformed
 * body.
 */
export const HubSignInDelivery = Schema.Struct({
  requestId: HubSignInRequestId,
  kind: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64)),
}).annotations(strict);
export type HubSignInDelivery = typeof HubSignInDelivery.Type;
export const decodeHubSignInDelivery = Schema.decodeUnknownSync(HubSignInDelivery);

/** What a spoke tells the hub when a request ends: the request and the outcome word. */
export const HubSignInOutcomeReport = Schema.Struct({
  requestId: HubSignInRequestId,
  outcome: HubSignInOutcome,
}).annotations(strict);
export type HubSignInOutcomeReport = typeof HubSignInOutcomeReport.Type;
export const decodeHubSignInOutcomeReport = Schema.decodeUnknownSync(HubSignInOutcomeReport);

/** The person on a spoke accepting, declining, or checking one request. */
export const HubSignInDecisionRequest = Schema.Struct({
  requestId: HubSignInRequestId,
}).annotations(strict);
export type HubSignInDecisionRequest = typeof HubSignInDecisionRequest.Type;
export const decodeHubSignInDecisionRequest = Schema.decodeUnknownSync(HubSignInDecisionRequest);

/** How the hub's last request to one member stands: asked, ended with an outcome word, or refused. */
export const HubSignInHubEntry = Schema.Struct({
  memberId: HubMemberId,
  requestId: HubSignInRequestId,
  kind: HubSignInKind,
  askedAt: UtcTimestamp,
  result: Schema.Union(
    Schema.Literal("asked"),
    HubSignInOutcome,
    Schema.Struct({ refused: HubSignInReason }).annotations(strict),
  ),
}).annotations(strict);
export type HubSignInHubEntry = typeof HubSignInHubEntry.Type;

/**
 * A request as the spoke's own window shows it. `guidance` is the provider's
 * own sign-in command, shown once the person accepts; the sign-in itself runs
 * in a terminal on this spoke and nothing of it ever reaches the hub.
 */
export const HubSignInRequestView = Schema.Struct({
  requestId: HubSignInRequestId,
  kind: HubSignInKind,
  state: Schema.Literal("asked", "accepted"),
  receivedAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
  guidance: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512))),
}).annotations(strict);
export type HubSignInRequestView = typeof HubSignInRequestView.Type;
