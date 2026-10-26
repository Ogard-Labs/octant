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
// RFC 6749 §3.3 scope-token: printable ASCII without space, quote, or backslash.
const Scope = Schema.String.pipe(Schema.pattern(/^[\x21\x23-\x5B\x5D-\x7E]{1,256}$/));

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
 * exchange and every later refresh must use. The directory dialect signs in
 * to an organization's own tenant: the broker builds every authority URL from
 * its closed issuer host and the tenant, so the descriptor names no URL.
 */
export const HostOAuthDialect = Schema.Literal(
  "openrouter-pkce",
  "chatgpt-plan-siwc",
  "mcp-authorization",
  "directory-oidc",
);
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

/** A directory tenant or application id: a lowercase GUID, never a multi-tenant alias. */
const DIRECTORY_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DirectoryGuid = Schema.String.pipe(Schema.pattern(DIRECTORY_GUID));

/** An https origin and nothing after it: the endpoint a directory grant is signed in for. */
const HttpsOrigin = Schema.String.pipe(
  Schema.filter((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.origin === value;
    } catch {
      return false;
    }
  }),
);

export const HostOAuthDescriptor = Schema.Struct({
  descriptorId: DescriptorId,
  /** Absent only for a dialect that sends no `client_id`. */
  clientId: Schema.optional(ClientId),
  /** A vendor wire dialect. Absent means the standard OAuth runner path. */
  dialect: Schema.optional(HostOAuthDialect),
  flow: HostOAuthFlow,
  authorizationEndpoint: Schema.optional(Endpoint),
  /** Absent only for the directory dialect, whose authority the broker builds. */
  tokenEndpoint: Schema.optional(Endpoint),
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
  /**
   * MCP authorization dialect only: the canonical address of the MCP server
   * the token is for, sent as `resource` on authorize, exchange and refresh.
   */
  resource: Schema.optional(Endpoint),
  /**
   * MCP authorization dialect only: the loopback port the callback listens
   * on, chosen before the flow so the client registration could name it.
   */
  redirectPort: Schema.optional(Schema.Int.pipe(Schema.between(1024, 65535))),
  /** Directory dialect only: the organization's tenant. */
  tenantId: Schema.optional(DirectoryGuid),
  /** Directory dialect only: the one resource the driver kind's endpoint accepts. */
  audience: Schema.optional(Endpoint),
  /** Directory dialect only: the origin of the endpoint the grant is signed in for. */
  endpointOrigin: Schema.optional(HttpsOrigin),
})
  .pipe(
    Schema.filter(
      (descriptor) => {
        // The directory dialect speaks standard device authorization against
        // the tenant's own authority; every other dialect's wire shape is
        // not OAuth's, so none pairs with a device code.
        if (
          descriptor.dialect !== undefined &&
          descriptor.dialect !== "directory-oidc" &&
          descriptor.flow !== "authorization-code-pkce"
        ) {
          return false;
        }
        // The directory dialect names its tenant, the organization's own
        // public client, the audience, and the endpoint, and nothing the
        // broker builds itself: no URL and no scope.
        if (descriptor.dialect === "directory-oidc") {
          return (
            descriptor.clientId !== undefined &&
            DIRECTORY_GUID.test(descriptor.clientId) &&
            descriptor.tenantId !== undefined &&
            descriptor.audience !== undefined &&
            descriptor.endpointOrigin !== undefined &&
            descriptor.scopes.length === 0 &&
            descriptor.authorizationEndpoint === undefined &&
            descriptor.tokenEndpoint === undefined &&
            descriptor.deviceAuthorizationEndpoint === undefined &&
            descriptor.resource === undefined &&
            descriptor.redirectPort === undefined &&
            descriptor.extAgentHostId === undefined &&
            descriptor.agentNameHint === undefined
          );
        }
        if (
          descriptor.tokenEndpoint === undefined ||
          descriptor.tenantId !== undefined ||
          descriptor.audience !== undefined ||
          descriptor.endpointOrigin !== undefined
        ) {
          return false;
        }
        // The MCP authorization dialect registers its client before the flow,
        // so it names a client id; a server may grant without any scope.
        if (descriptor.dialect === "mcp-authorization") {
          return descriptor.clientId !== undefined && descriptor.resource !== undefined;
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
          "a standard flow requires a client ID and at least one scope; only the directory dialect pairs with a device-code grant; the ChatGPT plan dialect requires at least one scope; only the directory dialect omits the token endpoint, and it names its tenant, client, audience, and endpoint and no URL or scope",
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

/**
 * `interaction-required` (directory dialect): the organization wants the
 * person present again, for multi-factor or a consent prompt. The broker keeps
 * that grant, since a later refresh can pass once the person has met the
 * prompt elsewhere; a new sign-in replaces it with a new grant.
 */
export const HostOAuthSignInAgainReason = Schema.Literal(
  "revoked",
  "expired",
  "refresh-reused",
  "interaction-required",
);
export type HostOAuthSignInAgainReason = typeof HostOAuthSignInAgainReason.Type;

const AttemptId = Schema.UUID;
/** The broker's own label pattern; the directory may name a person with an apostrophe. */
const SignedInAccountLabel = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9 .@_'-]{0,127}$/),
);
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
    /**
     * Directory dialect only: the account the identity token named, when it
     * named one in plain text. A display label, never a token or a claim set.
     */
    accountLabel: Schema.optional(SignedInAccountLabel),
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
