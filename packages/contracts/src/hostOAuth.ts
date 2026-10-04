import { Schema } from "effect";
import { UtcTimestamp } from "./events";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * Public host-driven sign-in shapes. Token material is not representable here:
 * excess fields are rejected, and no property carries an access or refresh token.
 */
const DescriptorId = Schema.String.pipe(
  Schema.pattern(/^[a-z0-9][a-z0-9-]{0,63}$/),
  Schema.brand("HostOAuthDescriptorId"),
);
const TermsId = Schema.String.pipe(
  Schema.pattern(/^[a-z0-9][a-z0-9-]{0,63}$/),
  Schema.brand("HostOAuthTermsId"),
);
const ClientId = Schema.String.pipe(Schema.pattern(/^[^\s/?#]{1,256}$/));
const Scope = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9._:-]{1,128}$/));

const Endpoint = Schema.String.pipe(
  Schema.filter((value) => {
    try {
      const url = new URL(value);
      if (url.username !== "" || url.password !== "") return false;
      if (url.protocol === "https:") return true;
      return (
        url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")
      );
    } catch {
      return false;
    }
  }),
);

export const HostOAuthFlow = Schema.Literal("authorization-code-pkce", "device-code");
export type HostOAuthFlow = typeof HostOAuthFlow.Type;

export const HostOAuthDescriptor = Schema.Struct({
  descriptorId: DescriptorId,
  clientId: ClientId,
  flow: HostOAuthFlow,
  authorizationEndpoint: Schema.optional(Endpoint),
  tokenEndpoint: Endpoint,
  deviceAuthorizationEndpoint: Schema.optional(Endpoint),
  scopes: Schema.Array(Scope).pipe(Schema.minItems(1), Schema.maxItems(16)),
  termsId: TermsId,
}).annotations(strict);
export type HostOAuthDescriptor = typeof HostOAuthDescriptor.Type;

export const HostOAuthTermsAcknowledgment = Schema.Struct({
  descriptorId: DescriptorId,
  termsId: TermsId,
  actorId: Schema.UUID,
  acknowledgedAt: UtcTimestamp,
}).annotations(strict);
export type HostOAuthTermsAcknowledgment = typeof HostOAuthTermsAcknowledgment.Type;

export const HostOAuthSignInAgainReason = Schema.Literal("revoked", "expired", "refresh-reused");
export type HostOAuthSignInAgainReason = typeof HostOAuthSignInAgainReason.Type;

const AttemptId = Schema.UUID;
const CredentialRef = Schema.UUID;

export const HostOAuthSignInState = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("awaiting-consent"),
    attemptId: AttemptId,
    descriptorId: DescriptorId,
    flow: Schema.Literal("authorization-code-pkce"),
    authorizationUrl: Endpoint,
    expiresAt: UtcTimestamp,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("awaiting-consent"),
    attemptId: AttemptId,
    descriptorId: DescriptorId,
    flow: Schema.Literal("device-code"),
    verificationUri: Endpoint,
    userCode: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9-]{1,64}$/)),
    expiresAt: UtcTimestamp,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("signed-in"),
    attemptId: AttemptId,
    descriptorId: DescriptorId,
    credentialRef: CredentialRef,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("sign-in-again"),
    credentialRef: CredentialRef,
    reason: HostOAuthSignInAgainReason,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    attemptId: Schema.optional(AttemptId),
    descriptorId: Schema.optional(DescriptorId),
    reason: Schema.Literal(
      "state-mismatch",
      "verifier-mismatch",
      "denied",
      "timeout",
      "exchange-refused",
      "unavailable",
      "terms-required",
      "invalid",
      "local-host-required",
    ),
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("unknown") }).annotations(strict),
);
export type HostOAuthSignInState = typeof HostOAuthSignInState.Type;

export const HostOAuthSignInOffer = Schema.Struct({
  oauth: Schema.Struct({
    available: Schema.Literal(true),
    termsRequired: Schema.Boolean,
  }).annotations(strict),
  apiKey: Schema.Struct({
    available: Schema.Literal(true),
  }).annotations(strict),
}).annotations(strict);
export type HostOAuthSignInOffer = typeof HostOAuthSignInOffer.Type;

export const HostOAuthJournalRecord = Schema.Union(
  Schema.Struct({
    name: Schema.Literal("host-oauth.terms-acknowledged"),
    descriptorId: DescriptorId,
    termsId: TermsId,
    actorId: Schema.UUID,
    acknowledgedAt: UtcTimestamp,
  }).annotations(strict),
  Schema.Struct({
    name: Schema.Literal("host-oauth.sign-in-started"),
    descriptorId: DescriptorId,
    attemptId: AttemptId,
    flow: HostOAuthFlow,
  }).annotations(strict),
  Schema.Struct({
    name: Schema.Literal("host-oauth.sign-in-completed"),
    descriptorId: DescriptorId,
    attemptId: AttemptId,
    credentialRef: CredentialRef,
  }).annotations(strict),
  Schema.Struct({
    name: Schema.Literal("host-oauth.sign-in-again"),
    descriptorId: DescriptorId,
    credentialRef: CredentialRef,
    reason: HostOAuthSignInAgainReason,
  }).annotations(strict),
  Schema.Struct({
    name: Schema.Literal("host-oauth.sign-in-refused"),
    descriptorId: DescriptorId,
    attemptId: Schema.optional(AttemptId),
    reason: Schema.String.pipe(Schema.pattern(/^[a-z][a-z0-9-]{0,63}$/)),
  }).annotations(strict),
  Schema.Struct({
    name: Schema.Literal("host-oauth.signed-out"),
    descriptorId: DescriptorId,
    credentialRef: CredentialRef,
  }).annotations(strict),
);
export type HostOAuthJournalRecord = typeof HostOAuthJournalRecord.Type;

export const decodeHostOAuthDescriptor = Schema.decodeUnknownSync(HostOAuthDescriptor);
export const decodeHostOAuthSignInState = Schema.decodeUnknownSync(HostOAuthSignInState);
export const decodeHostOAuthSignInOffer = Schema.decodeUnknownSync(HostOAuthSignInOffer);
export const decodeHostOAuthJournalRecord = Schema.decodeUnknownSync(HostOAuthJournalRecord);
export const decodeHostOAuthTermsAcknowledgment = Schema.decodeUnknownSync(
  HostOAuthTermsAcknowledgment,
);

const AccountLabel = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9 .@_-]{0,63}$/));

/**
 * A descriptor that offers host-driven sign-in beside an API key.
 * Vendor flows are not listed here; a later catalog entry is the only way a
 * descriptor starts offering sign-in.
 */
export const SubscriptionOAuthOffer = Schema.Struct({
  descriptor: HostOAuthDescriptor,
  accountLabel: AccountLabel,
  termsSummary: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(280)),
  driverKinds: Schema.Array(Schema.Literal("openai-compatible", "anthropic-compatible")).pipe(
    Schema.minItems(1),
    Schema.maxItems(2),
  ),
}).annotations(strict);
export type SubscriptionOAuthOffer = typeof SubscriptionOAuthOffer.Type;

export function subscriptionOAuthOffers(): readonly SubscriptionOAuthOffer[] {
  return [];
}
