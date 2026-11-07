import { Schema } from "effect";
import { SecretStoreKind, SecretStoreItemReference } from "./secretStores";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
export const CredentialRequestState = Schema.Literal(
  "pending",
  "using",
  "used",
  "declined",
  "cancelled",
  "expired",
  "failed",
);
export const CredentialRequestFailure = Schema.Literal(
  "locked",
  "missing",
  "unavailable",
  "not-linked",
  "invalid-reference",
  "changed",
);
export type CredentialRequestFailure = typeof CredentialRequestFailure.Type;
export const CredentialRequestReference = Schema.Struct({
  store: SecretStoreKind,
  reference: SecretStoreItemReference,
}).annotations(strict);
export type CredentialRequestReference = typeof CredentialRequestReference.Type;
/** Broker-to-host only. Never a renderer response, tool result or journal record. */
export const CredentialRequestResolution = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("read"),
    value: Schema.String.pipe(Schema.maxLength(4096)),
  }).annotations(strict),
  Schema.Struct({ status: CredentialRequestFailure }).annotations(strict),
);
export type CredentialRequestResolution = typeof CredentialRequestResolution.Type;
export const CredentialRequestCard = Schema.Struct({
  id: Schema.UUID,
  threadId: Schema.String,
  label: Schema.String,
  reason: Schema.String,
  consumer: Schema.String,
  destination: Schema.String,
  actionLabel: Schema.String,
  state: CredentialRequestState,
  failure: Schema.optional(CredentialRequestFailure),
}).annotations(strict);
export type CredentialRequestCard = typeof CredentialRequestCard.Type;
export const CredentialRequestView = Schema.Struct({
  requests: Schema.Array(CredentialRequestCard).pipe(Schema.maxItems(8)),
}).annotations(strict);
export type CredentialRequestView = typeof CredentialRequestView.Type;

/** Private submission only. This schema must never be used as a journal event. */
export const CredentialRequestAnswer = Schema.Union(
  Schema.Struct({ id: Schema.UUID, action: Schema.Literal("decline") }).annotations(strict),
  Schema.Struct({
    id: Schema.UUID,
    action: Schema.Literal("allow-linked"),
    ...CredentialRequestReference.fields,
  }).annotations(strict),
  Schema.Struct({
    id: Schema.UUID,
    action: Schema.Literal("allow"),
    secret: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4096)),
  }).annotations(strict),
);
export type CredentialRequestAnswer = typeof CredentialRequestAnswer.Type;

export const CREDENTIAL_TOOL_OPERATIONS = ["help", "list", "request", "run-saved"] as const;
export type CredentialToolOperation = (typeof CREDENTIAL_TOOL_OPERATIONS)[number];

/**
 * The one agent-facing credential tool. Each operation keeps the authority of
 * the surface behind it: `request` opens a one-use card for a registered
 * integration operation, and `run-saved` asks the person to approve one run of
 * a command they saved in Settings. The host narrows `operation` to what this
 * caller can use when the turn's tools are composed.
 */
export const OCTANT_CREDENTIAL_TOOL = {
  name: "octant_credential",
  description:
    "Use a credential the person holds without ever seeing it. request opens Octant's private card so the person can authorize one registered integration operation; run-saved asks the person to approve one run of a command they saved in Settings. Call list first: it returns names and descriptions only. No credential value or readable file is ever returned, and you cannot approve a request yourself. Never ask for a token in chat. This is not a general command runner: use the terminal or shell for ordinary commands; arbitrary commands, URLs and administrator passwords are unsupported. Plan refuses. Call operation help for full usage.",
  inputSchema: {
    type: "object",
    properties: {
      operation: { type: "string", enum: CREDENTIAL_TOOL_OPERATIONS as ReadonlyArray<string> },
      id: { type: "string", description: "For request and run-saved: an id that list returned." },
    },
    required: ["operation"],
    additionalProperties: false,
  },
} as const;
