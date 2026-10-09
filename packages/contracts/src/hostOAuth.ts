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

/**
 * A vendor wire dialect that is close to OAuth but not identical. The dialect
 * is what lets a catalog entry declare a flow the generic runner cannot
 * otherwise express. OpenRouter's key-issuing PKCE path is modeled: the
 * exchange returns a long-lived API key, so the descriptor carries no
 * `client_id` (OpenRouter does not register clients) and no scopes. The
 * ChatGPT plan dialect registers a user-defined agent on first sign-in: the
 * authorize request carries `dynamic_agent_client` plus an agent name hint and
 * a stable host id, and the callback returns the issued `client_id` the
 * exchange and every later refresh must use.
 */
export const HostOAuthDialect = Schema.Literal("openrouter-pkce", "chatgpt-plan-siwc");
export type HostOAuthDialect = typeof HostOAuthDialect.Type;

/**
 * The stable identifier of the host machine a ChatGPT plan sign-in is
 * registered for. Sent as `ext_agent_host_id` before the first sign-in and
 * kept for the life of the registration; `urn:uuid:<uuid>` is an accepted
 * form.
 */
const ExtAgentHostId = Schema.String.pipe(Schema.pattern(/^urn:[a-z0-9][a-z0-9.:-]{0,127}$/));

/**
 * The application name a ChatGPT plan sign-in registers under. Sent as
 * `agent_name_hint` on the first (registration) sign-in only.
 */
const AgentNameHint = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64));

export const HostOAuthDescriptor = Schema.Struct({
  descriptorId: DescriptorId,
  /** Absent only for a dialect that sends no `client_id`. */
  clientId: Schema.optional(ClientId),
  /** A vendor wire dialect. Absent means the standard OAuth runner path. */
  dialect: Schema.optional(HostOAuthDialect),
  flow: HostOAuthFlow,
  authorizationEndpoint: Schema.optional(Endpoint),
  tokenEndpoint: Endpoint,
  deviceAuthorizationEndpoint: Schema.optional(Endpoint),
  scopes: Schema.Array(Scope).pipe(Schema.maxItems(16)),
  termsId: TermsId,
  /**
   * ChatGPT plan dialect only: the stable host id sent as
   * `ext_agent_host_id` and persisted before the first sign-in.
   */
  extAgentHostId: Schema.optional(ExtAgentHostId),
  /** ChatGPT plan dialect only: the app name sent as `agent_name_hint` on registration. */
  agentNameHint: Schema.optional(AgentNameHint),
})
  .pipe(
    Schema.filter(
      (descriptor) => {
        if (descriptor.dialect !== undefined && descriptor.flow !== "authorization-code-pkce") {
          return false;
        }
        // A dialect entry declares its own wire shape; every other flow needs
        // a client identity and at least one scope. The ChatGPT plan dialect
        // registers its client during the first sign-in, so it declares no
        // client id but does declare scopes; the stable host id is bound by
        // the host process when a flow begins (see the runtime's descriptor
        // validation), not by the catalog entry.
        if (descriptor.dialect === "chatgpt-plan-siwc") {
          return descriptor.scopes.length >= 1;
        }
        return (
          descriptor.dialect !== undefined ||
          (descriptor.clientId !== undefined && descriptor.scopes.length >= 1)
        );
      },
      {
        description:
          "a standard flow requires a client ID and at least one scope; a dialect flow cannot pair with a device-code grant; the ChatGPT plan dialect requires at least one scope",
      },
    ),
  )
  .annotations(strict);
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
  /**
   * The only provider endpoint this sign-in may attach to. Compared by
   * canonical origin against the instance's configured base URL before a
   * flow begins and before a credential pointer is stored, so an offered
   * sign-in cannot be attached to an arbitrary endpoint.
   */
  allowedEndpoint: Endpoint,
}).annotations(strict);
export type SubscriptionOAuthOffer = typeof SubscriptionOAuthOffer.Type;

export const decodeSubscriptionOAuthOffer = Schema.decodeUnknownSync(SubscriptionOAuthOffer);
