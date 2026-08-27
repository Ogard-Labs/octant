import { Schema } from "effect";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const safeText = (limit: number) => Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(limit));

/**
 * Lifecycle states an integration can report for its connection to an external
 * service. They are intentionally coarse: an integration plugin is the only
 * source of truth for the fine differences between "not configured" and
 * "token rejected", but the host needs enough information to surface whether the
 * user can proceed.
 */
export const IntegrationAuthenticationState = Schema.Literal(
  "ready",
  "scope-limited",
  "unauthorized",
  "external-token",
  "rate-limited",
  "unavailable",
);
export type IntegrationAuthenticationState = typeof IntegrationAuthenticationState.Type;

/**
 * A capability an integration advertises. The operation id is scoped to the
 * integration plugin; the host only checks that requested operations appear in
 * the current capability list before routing a command.
 */
export const IntegrationCapability = Schema.Struct({
  operationId: safeText(64),
  available: Schema.Boolean,
  remediation: Schema.optional(safeText(256)),
}).annotations(strict);
export type IntegrationCapability = typeof IntegrationCapability.Type;

/**
 * An account the integration is acting as. The source field lets an integration
 * distinguish a host-managed credential from a user-supplied token without
 * exposing the token itself.
 */
export const IntegrationAccount = Schema.Struct({
  login: safeText(128),
  source: safeText(128),
  scopes: Schema.Array(safeText(128)).pipe(Schema.maxItems(64)),
}).annotations(strict);
export type IntegrationAccount = typeof IntegrationAccount.Type;

/**
 * A user-visible interaction required to finish authentication, such as a device
 * flow handoff. The URI and code are generic strings so the integration plugin
 * controls the external service's protocol.
 */
export const IntegrationAuthenticationInteraction = Schema.Struct({
  kind: Schema.Literal("device-flow"),
  verificationUri: safeText(512),
  userCode: safeText(64),
}).annotations(strict);
export type IntegrationAuthenticationInteraction = typeof IntegrationAuthenticationInteraction.Type;

/**
 * A snapshot of the integration's authentication state and available operations.
 * The host renders this without knowing which external service produced it.
 */
export const IntegrationAuthenticationSnapshot = Schema.Struct({
  state: IntegrationAuthenticationState,
  account: Schema.optional(IntegrationAccount),
  capabilities: Schema.Array(IntegrationCapability).pipe(Schema.maxItems(32)),
  remediation: Schema.optional(safeText(512)),
  interaction: Schema.optional(IntegrationAuthenticationInteraction),
}).annotations(strict);
export type IntegrationAuthenticationSnapshot = typeof IntegrationAuthenticationSnapshot.Type;

/**
 * Commands the host can issue to manage the integration's authentication.
 */
export const IntegrationAuthenticationCommand = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("setup") }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("refresh") }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("logout") }).annotations(strict),
).annotations(strict);
export type IntegrationAuthenticationCommand = typeof IntegrationAuthenticationCommand.Type;

/**
 * Commands routed to an integration plugin. Authentication is common to every
 * integration; operation commands are opaque to the host and validated by the
 * plugin against its own declared capabilities.
 */
export const IntegrationCommand = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("authenticate"),
    command: IntegrationAuthenticationCommand,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("operation"),
    operationId: safeText(64),
    input: Schema.Unknown,
  }).annotations(strict),
).annotations(strict);
export type IntegrationCommand = typeof IntegrationCommand.Type;

/**
 * Result of an integration operation. The plugin is responsible for deciding
 * whether a failure is retryable; the host only surfaces the outcome.
 */
export const IntegrationExecutionResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("ok"),
    value: Schema.Unknown,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: safeText(512),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("failed"),
    reason: safeText(512),
    retryable: Schema.Boolean,
  }).annotations(strict),
).annotations(strict);
export type IntegrationExecutionResult = typeof IntegrationExecutionResult.Type;

/**
 * Result of requesting a credential from the host. The host may grant an opaque
 * reference, refuse the scope, or report that no broker is available.
 */
export const IntegrationCredentialRequestResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("granted"),
    reference: safeText(256),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: safeText(512),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    reason: safeText(512),
  }).annotations(strict),
).annotations(strict);
export type IntegrationCredentialRequestResult = typeof IntegrationCredentialRequestResult.Type;

/**
 * Observations emitted by an integration plugin. The host decodes only the
 * authentication snapshot; operation results are forwarded to the caller that
 * issued the operation command.
 */
export const IntegrationObservation = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("authentication"),
    snapshot: IntegrationAuthenticationSnapshot,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("operation"),
    operationId: safeText(64),
    result: IntegrationExecutionResult,
  }).annotations(strict),
).annotations(strict);
export type IntegrationObservation = typeof IntegrationObservation.Type;

/** Decodes an unknown value as an integration authentication snapshot. */
export const decodeIntegrationAuthenticationSnapshot = Schema.decodeUnknownSync(
  IntegrationAuthenticationSnapshot,
);

/** Decodes an unknown value as an integration authentication command. */
export const decodeIntegrationAuthenticationCommand = Schema.decodeUnknownSync(
  IntegrationAuthenticationCommand,
);

/** Decodes an unknown value as an integration command. */
export const decodeIntegrationCommand = Schema.decodeUnknownSync(IntegrationCommand);

/** Decodes an unknown value as an integration observation. */
export const decodeIntegrationObservation = Schema.decodeUnknownSync(IntegrationObservation);

/** Decodes an unknown value as an integration execution result. */
export const decodeIntegrationExecutionResult = Schema.decodeUnknownSync(
  IntegrationExecutionResult,
);

/** Decodes an unknown value as an integration credential-request result. */
export const decodeIntegrationCredentialRequestResult = Schema.decodeUnknownSync(
  IntegrationCredentialRequestResult,
);
