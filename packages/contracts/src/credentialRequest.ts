import { Schema } from "effect";

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
export const CredentialRequestCard = Schema.Struct({
  id: Schema.UUID,
  threadId: Schema.String,
  label: Schema.String,
  reason: Schema.String,
  consumer: Schema.String,
  destination: Schema.String,
  actionLabel: Schema.String,
  state: CredentialRequestState,
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
    action: Schema.Literal("allow"),
    secret: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4096)),
  }).annotations(strict),
);
export type CredentialRequestAnswer = typeof CredentialRequestAnswer.Type;

export const REQUEST_CREDENTIAL_TOOL = {
  name: "request_credential",
  description:
    "Ask the person for a credential in Octant's private card and perform the named supported operation once. Never ask for a token in chat. No credential value or readable file is returned. Only the listed integration operations are supported; shell commands and administrator passwords are unsupported.",
  inputSchema: {
    type: "object",
    properties: { operation: { type: "string", enum: [] as ReadonlyArray<string> } },
    required: ["operation"],
    additionalProperties: false,
  },
} as const;
