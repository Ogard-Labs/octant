import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";

const safeText = (limit: number) =>
  Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(limit));

/**
 * Lifecycle states an integration can report for its connection to an external
 * service. They are intentionally coarse: an integration plugin is the only
 * source of truth for the fine differences between "not configured" and
 * "token rejected", but the host needs enough information to surface whether the
 * user can proceed.
 */
export const IntegrationAuthenticationState = Schema.Literals([
  "ready",
  "scope-limited",
  "unauthorized",
  "external-token",
  "rate-limited",
  "unavailable",
]);
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
});
export type IntegrationCapability = typeof IntegrationCapability.Type;

/**
 * An account the integration is acting as. The source field lets an integration
 * distinguish a host-managed credential from a user-supplied token without
 * exposing the token itself.
 */
export const IntegrationAccount = Schema.Struct({
  login: safeText(128),
  source: safeText(128),
  scopes: Schema.Array(safeText(128)).check(Schema.isMaxLength(64)),
  displayName: Schema.optional(safeText(128)),
  workspace: Schema.optional(safeText(128)),
});
export type IntegrationAccount = typeof IntegrationAccount.Type;

/**
 * A user-visible interaction required to finish authentication. Device flow
 * carries a verification URI and user code; authorization-code + PKCE carries
 * the URL the host already prepared so the renderer can open it without seeing
 * client secrets or token material.
 */
export const IntegrationAuthenticationInteraction = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("device-flow"),
    verificationUri: safeText(512),
    userCode: safeText(64),
  }),
  Schema.Struct({
    kind: Schema.Literal("authorization-redirect"),
    authorizationUri: safeText(2048),
  }),
]);
export type IntegrationAuthenticationInteraction = typeof IntegrationAuthenticationInteraction.Type;

/**
 * A snapshot of the integration's authentication state and available operations.
 * The host renders this without knowing which external service produced it.
 */
export const IntegrationAuthenticationSnapshot = Schema.Struct({
  state: IntegrationAuthenticationState,
  account: Schema.optional(IntegrationAccount),
  capabilities: Schema.Array(IntegrationCapability).check(Schema.isMaxLength(32)),
  remediation: Schema.optional(safeText(512)),
  interaction: Schema.optional(IntegrationAuthenticationInteraction),
  personalCredentialStored: Schema.optional(Schema.Boolean),
});
export type IntegrationAuthenticationSnapshot = typeof IntegrationAuthenticationSnapshot.Type;

/**
 * Commands the host can issue to manage the integration's authentication.
 */
export const IntegrationAuthenticationCommand = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("setup") }),
  Schema.Struct({ kind: Schema.Literal("refresh") }),
  Schema.Struct({ kind: Schema.Literal("logout") }),
]);
export type IntegrationAuthenticationCommand = typeof IntegrationAuthenticationCommand.Type;

/**
 * Commands routed to an integration plugin. Authentication is common to every
 * integration; operation commands are opaque to the host and validated by the
 * plugin against its own declared capabilities.
 */
export const IntegrationCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("authenticate"),
    command: IntegrationAuthenticationCommand,
  }),
  Schema.Struct({
    kind: Schema.Literal("operation"),
    operationId: safeText(64),
    input: Schema.Unknown,
  }),
]);
export type IntegrationCommand = typeof IntegrationCommand.Type;

/**
 * Result of an integration operation. The plugin is responsible for deciding
 * whether a failure is retryable; the host only surfaces the outcome.
 */
export const IntegrationExecutionResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("ok"),
    value: Schema.Unknown,
  }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: safeText(512),
  }),
  Schema.Struct({
    kind: Schema.Literal("failed"),
    reason: safeText(512),
    retryable: Schema.Boolean,
  }),
]);
export type IntegrationExecutionResult = typeof IntegrationExecutionResult.Type;

/**
 * Result of requesting a credential from the host. The host may grant an opaque
 * reference, refuse the scope, or report that no broker is available.
 */
export const IntegrationCredentialRequestResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("granted"),
    reference: safeText(256),
    /**
     * The scopes the provider granted, when the host recorded them at connect
     * time. Absent means unknown (a personal key), never "none".
     */
    scopes: Schema.optional(Schema.Array(safeText(128)).check(Schema.isMaxLength(64))),
  }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: safeText(512),
  }),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    reason: safeText(512),
  }),
]);
export type IntegrationCredentialRequestResult = typeof IntegrationCredentialRequestResult.Type;

/**
 * Observations emitted by an integration plugin. The host decodes only the
 * authentication snapshot; operation results are forwarded to the caller that
 * issued the operation command.
 */
export const IntegrationObservation = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("authentication"),
    snapshot: IntegrationAuthenticationSnapshot,
  }),
  Schema.Struct({
    kind: Schema.Literal("operation"),
    operationId: safeText(64),
    result: IntegrationExecutionResult,
  }),
]);
export type IntegrationObservation = typeof IntegrationObservation.Type;

/** Decodes an unknown value as an integration authentication snapshot. */
export const decodeIntegrationAuthenticationSnapshot = Schema.decodeUnknownSync(
  IntegrationAuthenticationSnapshot,
  STRICT_DECODE_OPTIONS,
);

/** Decodes an unknown value as an integration authentication command. */
export const decodeIntegrationAuthenticationCommand = Schema.decodeUnknownSync(
  IntegrationAuthenticationCommand,
  STRICT_DECODE_OPTIONS,
);

/** Decodes an unknown value as an integration command. */
export const decodeIntegrationCommand = Schema.decodeUnknownSync(
  IntegrationCommand,
  STRICT_DECODE_OPTIONS,
);

/** Decodes an unknown value as an integration observation. */
export const decodeIntegrationObservation = Schema.decodeUnknownSync(
  IntegrationObservation,
  STRICT_DECODE_OPTIONS,
);

/** Decodes an unknown value as an integration execution result. */
export const decodeIntegrationExecutionResult = Schema.decodeUnknownSync(
  IntegrationExecutionResult,
  STRICT_DECODE_OPTIONS,
);

/** Decodes an unknown value as an integration credential-request result. */
export const decodeIntegrationCredentialRequestResult = Schema.decodeUnknownSync(
  IntegrationCredentialRequestResult,
  STRICT_DECODE_OPTIONS,
);
