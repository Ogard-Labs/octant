/**
 * Thread secrets: a secret an agent asks the person for in a Code or Work
 * thread, kept as long as the person chooses.
 *
 * A value appears in exactly two types here, both private to the host: the
 * answer the card submits, and the tool input that moves a secret the person
 * already pasted into chat. Every other type (the card, the tool's result, the
 * active list, the journal record) has no field for one and refuses a field it
 * does not name.
 */

import { Schema } from "effect";
import { AutomationThreadMode } from "./automation";
import { SecretStoreItemReference, SecretStoreKind } from "./secretStores";
import { WindowId } from "./shell";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

export const MAX_THREAD_SECRET_FIELDS = 8;
/** The variable a command reads a secret from is this and the secret's name. */
export const THREAD_SECRET_ENVIRONMENT_PREFIX = "OCTANT_SECRET_";

/** Becomes a file name and part of a variable name, so it holds nothing a path could use. */
export const ThreadSecretName = Schema.String.pipe(Schema.pattern(/^[A-Z][A-Z0-9_]{0,63}$/));
/**
 * Shorter than a secret's own name: prefix, name and field together stay within
 * the 128 characters Octant's command launches accept for a variable.
 */
export const ThreadSecretFieldName = Schema.String.pipe(Schema.pattern(/^[A-Z][A-Z0-9_]{0,47}$/));
/** A secret's name, or its name and one field's. */
const DeliveredName = Schema.String.pipe(Schema.pattern(/^[A-Z][A-Z0-9_]{0,112}$/));
const EnvironmentName = Schema.String.pipe(Schema.pattern(/^OCTANT_SECRET_[A-Z][A-Z0-9_]{0,112}$/));

/** Never trimmed: spaces in a password matter. A variable cannot carry a NUL. */
const ThreadSecretValue = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(4096),
  Schema.filter((value) => !value.includes("\u0000"), {
    message: () => "A secret has no NUL character.",
  }),
);

export const ThreadSecretKind = Schema.Literal("token", "account-password");
export type ThreadSecretKind = typeof ThreadSecretKind.Type;
export const ThreadSecretSource = Schema.Literal("pasted", "onepassword", "remembered");
export type ThreadSecretSource = typeof ThreadSecretSource.Type;
export const ThreadSecretLifetime = Schema.Literal(
  "this-command",
  "this-turn",
  "1-hour",
  "24-hours",
  "until-archived",
  "remember",
);
export type ThreadSecretLifetime = typeof ThreadSecretLifetime.Type;
/** What the agent asks for. The host decides what it becomes. */
export const ThreadSecretRequestedDelivery = Schema.Literal("handle", "file");
export type ThreadSecretRequestedDelivery = typeof ThreadSecretRequestedDelivery.Type;
export const ThreadSecretDelivery = Schema.Literal(
  "handle",
  "file-and-environment",
  "environment",
  "op-run",
);
export type ThreadSecretDelivery = typeof ThreadSecretDelivery.Type;
export const ThreadSecretFailure = Schema.Literal(
  "declined",
  "expired",
  "revoked",
  "locked",
  "missing",
  "unavailable",
  "not-linked",
  "invalid-reference",
  "refused-by-strict",
  "lifetime-not-offered",
  "unsupported-mode",
);
export type ThreadSecretFailure = typeof ThreadSecretFailure.Type;

const Label = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(80));
const Reason = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(500));
const Placeholder = Schema.String.pipe(Schema.maxLength(80));
const Note = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(500));
const ThreadId = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128));

const uniqueNames = (fields: ReadonlyArray<{ readonly name: string }>): boolean =>
  new Set(fields.map((field) => field.name)).size === fields.length;

/** A button opens it in the browser, so only a web page, and never a sign-in inside the address. */
export const ThreadSecretSetupUrl = Schema.String.pipe(
  Schema.maxLength(2048),
  Schema.filter(
    (value) => {
      try {
        const url = new URL(value);
        return (
          (url.protocol === "https:" || url.protocol === "http:") &&
          url.username === "" &&
          url.password === ""
        );
      } catch {
        return false;
      }
    },
    { message: () => "A setup page is an http or https address." },
  ),
);

/** The `request-secret` operation's input, as the agent sends it. */
export const ThreadSecretRequestInput = Schema.Struct({
  operation: Schema.Literal("request-secret"),
  name: ThreadSecretName,
  label: Label,
  kind: ThreadSecretKind,
  reason: Reason,
  url: Schema.optional(ThreadSecretSetupUrl),
  placeholder: Schema.optional(Placeholder),
  fields: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: ThreadSecretFieldName,
        label: Label,
        placeholder: Schema.optional(Placeholder),
        /** False shows the typed value. Left out, the field is masked. */
        secret: Schema.optional(Schema.Boolean),
      }).annotations(strict),
    ).pipe(
      Schema.minItems(1),
      Schema.maxItems(MAX_THREAD_SECRET_FIELDS),
      Schema.filter(uniqueNames, { message: () => "Each field has its own name." }),
    ),
  ),
  delivery: Schema.optional(ThreadSecretRequestedDelivery),
  /** A secret the person already pasted in chat. It is saved with no card. */
  value: Schema.optional(ThreadSecretValue),
  /** Asking again with the same key returns the same card and the same answer. */
  clientRequestId: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128))),
})
  .annotations(strict)
  .pipe(
    Schema.filter((input) => input.value === undefined || input.fields === undefined, {
      message: () => "A pasted value is one secret and takes no fields.",
    }),
  );
export type ThreadSecretRequestInput = typeof ThreadSecretRequestInput.Type;

const saved = { status: Schema.Literal("saved"), name: ThreadSecretName } as const;
const FieldPaths = Schema.Record({ key: ThreadSecretFieldName, value: Schema.NonEmptyString });
const FieldVariables = Schema.Record({ key: ThreadSecretFieldName, value: EnvironmentName });

/** What the agent gets back: names, a handle, paths and variables. Never a value. */
export const ThreadSecretRequestResult = Schema.Union(
  Schema.Struct({
    ...saved,
    delivery: Schema.Literal("handle"),
    handle: Schema.UUID,
  }).annotations(strict),
  Schema.Struct({
    ...saved,
    delivery: Schema.Literal("file-and-environment"),
    file: Schema.NonEmptyString,
    env: EnvironmentName,
  }).annotations(strict),
  Schema.Struct({
    ...saved,
    delivery: Schema.Literal("file-and-environment"),
    files: FieldPaths,
    env: FieldVariables,
  }).annotations(strict),
  Schema.Struct({
    ...saved,
    delivery: Schema.Literal("environment", "op-run"),
    env: Schema.Union(EnvironmentName, FieldVariables),
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("declined", "cancelled"),
    note: Note,
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("refused"),
    failure: ThreadSecretFailure,
    note: Note,
  }).annotations(strict),
);
export type ThreadSecretRequestResult = typeof ThreadSecretRequestResult.Type;

export const RememberedThreadSecret = Schema.Struct({
  id: Schema.UUID,
  name: DeliveredName,
  /** Where a remembered secret's value comes from when it is used. */
  source: Schema.Literal("pasted", "onepassword"),
}).annotations(strict);
export type RememberedThreadSecret = typeof RememberedThreadSecret.Type;

export const ThreadSecretRequestCard = Schema.Struct({
  id: Schema.UUID,
  threadId: ThreadId,
  name: ThreadSecretName,
  label: Label,
  kind: ThreadSecretKind,
  reason: Reason,
  url: Schema.optional(ThreadSecretSetupUrl),
  delivery: ThreadSecretRequestedDelivery,
  /** Always at least one: a request with no named fields has one, under its own name. */
  fields: Schema.Array(
    Schema.Struct({
      name: ThreadSecretName,
      label: Label,
      placeholder: Schema.optional(Placeholder),
      secret: Schema.Boolean,
    }).annotations(strict),
  ).pipe(Schema.minItems(1), Schema.maxItems(MAX_THREAD_SECRET_FIELDS), Schema.filter(uniqueNames)),
  lifetimes: Schema.Array(ThreadSecretLifetime).pipe(Schema.minItems(1)),
  defaultLifetime: ThreadSecretLifetime,
  /** A paired phone is offered no 1Password. */
  sources: Schema.Array(ThreadSecretSource).pipe(Schema.minItems(1)),
  remembered: Schema.Array(RememberedThreadSecret).pipe(Schema.maxItems(32)),
  /** Nothing here expires: the card waits for an answer, its turn or its thread to end. */
  state: Schema.Literal("pending", "saving", "saved", "declined", "cancelled", "failed"),
  failure: Schema.optional(ThreadSecretFailure),
})
  .annotations(strict)
  .pipe(
    Schema.filter((card) => card.lifetimes.includes(card.defaultLifetime), {
      message: () => "A card starts on a lifetime it offers.",
    }),
  );
export type ThreadSecretRequestCard = typeof ThreadSecretRequestCard.Type;

export const ThreadSecretAnswerField = Schema.Union(
  Schema.Struct({
    name: ThreadSecretName,
    source: Schema.Literal("pasted"),
    value: ThreadSecretValue,
  }).annotations(strict),
  Schema.Struct({
    name: ThreadSecretName,
    source: Schema.Literal("onepassword"),
    store: SecretStoreKind,
    reference: SecretStoreItemReference,
    /** Reads the item at every use and keeps no copy. */
    freshEachUse: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    name: ThreadSecretName,
    source: Schema.Literal("remembered"),
    rememberedId: Schema.UUID,
  }).annotations(strict),
);
export type ThreadSecretAnswerField = typeof ThreadSecretAnswerField.Type;

/** Private submission only. This schema must never be used as a journal event. */
export const ThreadSecretAnswer = Schema.Union(
  Schema.Struct({ id: Schema.UUID, action: Schema.Literal("decline") }).annotations(strict),
  Schema.Struct({
    id: Schema.UUID,
    action: Schema.Literal("save"),
    lifetime: ThreadSecretLifetime,
    fields: Schema.Array(ThreadSecretAnswerField).pipe(
      Schema.minItems(1),
      Schema.maxItems(MAX_THREAD_SECRET_FIELDS),
      Schema.filter(uniqueNames, { message: () => "Each field is answered once." }),
    ),
  }).annotations(strict),
);
export type ThreadSecretAnswer = typeof ThreadSecretAnswer.Type;

/** One row of the Active secrets list. */
export const ActiveThreadSecret = Schema.Struct({
  id: Schema.UUID,
  threadId: ThreadId,
  name: DeliveredName,
  label: Label,
  kind: ThreadSecretKind,
  source: ThreadSecretSource,
  lifetime: ThreadSecretLifetime,
  delivery: ThreadSecretDelivery,
  /** Left out when the secret ends with something other than time. */
  remainingMs: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
}).annotations(strict);
export type ActiveThreadSecret = typeof ActiveThreadSecret.Type;

export const THREAD_SECRET_EVENT_NAME = "thread-secret.recorded@1";
export const THREAD_SECRET_AGGREGATE_TYPE = "thread-secret";

const journaled = {
  secretId: Schema.UUID,
  threadId: ThreadId,
  mode: AutomationThreadMode,
  secretName: DeliveredName,
  kind: ThreadSecretKind,
} as const;

/**
 * What the journal keeps of a secret: that it was granted, used, or ended.
 * Nothing here is free text, so a value cannot ride along in a label or a
 * reason.
 */
export const ThreadSecretJournalRecord = Schema.Union(
  Schema.Struct({
    name: Schema.Literal("thread-secret.granted"),
    ...journaled,
    source: ThreadSecretSource,
    lifetime: ThreadSecretLifetime,
    delivery: ThreadSecretDelivery,
    windowId: Schema.optional(WindowId),
  }).annotations(strict),
  Schema.Struct({
    name: Schema.Literal("thread-secret.used"),
    ...journaled,
    use: Schema.Literal("command", "handle", "op-run"),
  }).annotations(strict),
  Schema.Struct({ name: Schema.Literal("thread-secret.expired"), ...journaled }).annotations(
    strict,
  ),
  Schema.Struct({
    name: Schema.Literal("thread-secret.revoked"),
    ...journaled,
    cause: Schema.Literal(
      "person",
      "replaced",
      "command-ended",
      "turn-ended",
      "thread-archived",
      "host-stopped",
    ),
  }).annotations(strict),
);
export type ThreadSecretJournalRecord = typeof ThreadSecretJournalRecord.Type;

export const decodeThreadSecretRequestInput = Schema.decodeUnknownEither(ThreadSecretRequestInput);
export const decodeThreadSecretAnswer = Schema.decodeUnknownEither(ThreadSecretAnswer);
export const decodeThreadSecretJournalRecord = Schema.decodeUnknownSync(ThreadSecretJournalRecord);
