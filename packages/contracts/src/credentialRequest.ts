import { Schema } from "effect";
import { SecretStoreKind, SecretStoreItemReference } from "./secretStores";
import { MAX_THREAD_SECRET_COMMAND_LENGTH, MAX_THREAD_SECRET_FIELDS } from "./threadSecrets";

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

export const CREDENTIAL_TOOL_OPERATIONS = [
  "help",
  "list",
  "request",
  "run-saved",
  "request-secret",
  "run-with-secret",
] as const;
export type CredentialToolOperation = (typeof CREDENTIAL_TOOL_OPERATIONS)[number];

/**
 * The agent-facing credential tool as a caller without thread secrets sees it:
 * a plugin's own tool, and any turn whose host does not offer `request-secret`.
 * Each operation keeps the authority of the surface behind it: `request` opens
 * a one-use card for a registered integration operation, and `run-saved` asks
 * the person to approve one run of a command they saved in Settings. The host
 * narrows `operation` to what this caller can use when the turn's tools are
 * composed.
 */
export const OCTANT_CREDENTIAL_TOOL_WITHOUT_SECRETS = {
  name: "octant_credential",
  description:
    "Use a credential the person holds without ever seeing it. request opens Octant's private card so the person can authorize one registered integration operation; run-saved asks the person to approve one run of a command they saved in Settings. Call list first: it returns names and descriptions only. No credential value or readable file is ever returned, and you cannot approve a request yourself. Never ask for a token in chat. This is not a general command runner: use the terminal or shell for ordinary commands; arbitrary commands, URLs and administrator passwords are unsupported. Plan refuses. Call operation help for full usage.",
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["help", "list", "request", "run-saved"] as ReadonlyArray<string>,
      },
      id: { type: "string", description: "For request and run-saved: an id that list returned." },
    },
    required: ["operation"],
    additionalProperties: false,
  },
} as const;

/**
 * The same tool where the host offers thread secrets. The person answers a
 * private card and chooses how long the secret lasts; the result names a
 * handle, or a file and a variable, and never the value.
 */
export const OCTANT_CREDENTIAL_TOOL = {
  ...OCTANT_CREDENTIAL_TOOL_WITHOUT_SECRETS,
  description: [
    "Use a credential the person holds. You never get its value from this tool, and you cannot approve a request yourself. Never ask for a secret in chat: use request-secret. If the person pasted one in chat, do not use it: ask with request-secret and tell them to change the pasted one.",
    "request-secret opens Octant's private card for an API key, a token or an account password; the person enters it there. delivery handle (the default) returns a one-use handle only an Octant tool can redeem. Ask for delivery file when a command needs the value: it returns the variable OCTANT_SECRET_<NAME>, and a file's path too where this thread's commands run outside a sandbox. Reuse clientRequestId to retry without a second card. If the answer is declined, do not ask again: say what is blocked and stop.",
    "run-with-secret runs one command with the secrets it names as OCTANT_SECRET_<NAME> variables, under this thread's usual approvals, and returns its output with the values hidden. Use it whenever you were given a variable, and under Strict. Name variables in the command, never a value. Read a file or variable only inside the command that needs it, through standard input where you can; never print, encode, copy or send it anywhere else.",
    `For sudo, run sudo -n <cmd> first. Only if that needs a password, request kind account-password with delivery file and run sudo -S -p '' <cmd> < "$file" in your own shell. A sandbox lets nothing raise its privileges, so where you get no file, sudo does not work here: say so. It cannot fill in a system dialog: ask the person to type there themselves.`,
    "request opens a one-use card for one registered integration operation; run-saved asks the person to approve one run of a command they saved in Settings. Call list first: it returns names and descriptions only. This is not a general command runner: use the terminal or shell for ordinary commands. Plan refuses. Call operation help for full usage.",
  ].join(" "),
  inputSchema: {
    ...OCTANT_CREDENTIAL_TOOL_WITHOUT_SECRETS.inputSchema,
    properties: {
      ...OCTANT_CREDENTIAL_TOOL_WITHOUT_SECRETS.inputSchema.properties,
      operation: { type: "string", enum: CREDENTIAL_TOOL_OPERATIONS as ReadonlyArray<string> },
      name: {
        type: "string",
        pattern: "^[A-Z][A-Z0-9_]{0,63}$",
        description: "For request-secret: the secret's name, such as DEPLOY_TOKEN.",
      },
      label: {
        type: "string",
        maxLength: 80,
        description: "For request-secret: the card's title.",
      },
      kind: {
        type: "string",
        enum: ["token", "account-password"],
        description: "For request-secret: account-password is for sudo and similar commands.",
      },
      reason: {
        type: "string",
        maxLength: 500,
        description: "For request-secret: why you need it, in words the person can judge.",
      },
      url: {
        type: "string",
        description: "For request-secret: an http or https page where the person gets the secret.",
      },
      placeholder: { type: "string", maxLength: 80 },
      fields: {
        type: "array",
        minItems: 1,
        maxItems: MAX_THREAD_SECRET_FIELDS,
        description:
          "For request-secret: named fields for one card, such as an email and a password. Each becomes its own file and variable, NAME_FIELD.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,47}$" },
            label: { type: "string", maxLength: 80 },
            placeholder: { type: "string", maxLength: 80 },
            secret: { type: "boolean", description: "false shows the value as it is typed." },
          },
          required: ["name", "label"],
          additionalProperties: false,
        },
      },
      delivery: { type: "string", enum: ["handle", "file"] },
      clientRequestId: {
        type: "string",
        maxLength: 128,
        description: "For request-secret: a retry key. The same key returns the same answer.",
      },
      command: {
        type: "string",
        maxLength: MAX_THREAD_SECRET_COMMAND_LENGTH,
        description: "For run-with-secret: one shell command, naming variables and no value.",
      },
      secrets: {
        type: "array",
        minItems: 1,
        maxItems: MAX_THREAD_SECRET_FIELDS,
        items: { type: "string" },
        description:
          "For run-with-secret: the names of saved secrets, without OCTANT_SECRET_; a field is NAME_FIELD.",
      },
      timeoutMs: { type: "integer", minimum: 1000, maximum: 600000 },
    },
  },
} as const;
