/**
 * Thread secrets: a secret an agent asks the person for in a Code or Work
 * thread, kept as long as the person chooses.
 *
 * A value appears in exactly one type here, private to the host: the answer the
 * card submits. Every other type (the request, the card, the tool's result, the
 * active list, the journal record) has no field for one and refuses a field it
 * does not name. An agent can never hand Octant a value: the person enters it in
 * the card, every time (maintainer decision, 2026-11-24).
 */

import { Schema } from "effect";
import { AutomationThreadMode } from "./automation";
import { SecretStoreBrowseStep, SecretStoreItemReference, SecretStoreKind } from "./secretStores";
import { WindowId } from "./shell";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

export const MAX_THREAD_SECRET_FIELDS = 8;
export const MAX_REMEMBERED_THREAD_SECRETS = 128;
/** The newest are listed; one thread holds at most 64. */
export const MAX_THREAD_SECRETS_LISTED = 512;
/** The variable a command reads a secret from is this and the secret's name. */
export const THREAD_SECRET_ENVIRONMENT_PREFIX = "OCTANT_SECRET_";

/** Names Windows gives its devices: a file of that name is the device. */
const WINDOWS_DEVICE = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$/;

/** Becomes a file name and part of a variable name, so it holds nothing a path could use. */
export const ThreadSecretName = Schema.String.pipe(
  Schema.pattern(/^[A-Z][A-Z0-9_]{0,63}$/),
  Schema.filter((value) => !WINDOWS_DEVICE.test(value), {
    message: () => "That name is reserved by Windows.",
  }),
);
/**
 * Shorter than a secret's own name: prefix, name and field together stay within
 * the 128 characters Octant's command launches accept for a variable.
 */
export const ThreadSecretFieldName = Schema.String.pipe(Schema.pattern(/^[A-Z][A-Z0-9_]{0,47}$/));
/** A card's field: one the agent named, or the request's own name. Never a file's name alone. */
const CardFieldName = Schema.String.pipe(Schema.pattern(/^[A-Z][A-Z0-9_]{0,63}$/));
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
  "each-use",
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

/** Letters and symbols that draw nothing: Hangul fillers, the Braille blank, odd spaces. */
const BLANK = /[\u115f\u1160\u3164\uffa0\u2800\u00a0\u1680\u2000-\u200a\u202f\u205f]/u;

/**
 * One line a person can read as it is. The agent writes it and the person
 * decides by it, so it holds nothing invisible, nothing that reorders the text
 * around it, and no second line that could pass for Octant's own words.
 */
const readable = (value: string): boolean =>
  !/[\p{C}\p{Zl}\p{Zp}]/u.test(value) && !BLANK.test(value);
const readableText = { message: () => "Use one line of visible text." };
const visible = (value: string): boolean => readable(value) && /[\p{L}\p{N}]/u.test(value);
const Label = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(80),
  Schema.filter(visible, readableText),
);
const Reason = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(500),
  Schema.filter(visible, readableText),
);
const Placeholder = Schema.String.pipe(Schema.maxLength(80), Schema.filter(readable, readableText));
const Note = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(500));
const ThreadId = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128));

const uniqueNames = (fields: ReadonlyArray<{ readonly name: string }>): boolean =>
  new Set(fields.map((field) => field.name)).size === fields.length;

/** A button opens it in the browser, so only a web page, and never a sign-in inside the address. */
export const ThreadSecretSetupUrl = Schema.String.pipe(
  Schema.maxLength(2048),
  Schema.filter(
    (value) => {
      // A browser drops a tab and reads a backslash as a slash, so what the
      // person reads would not be where the button goes.
      if (!readable(value) || /[\s\\]/u.test(value)) return false;
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
  /** Asking again with the same key returns the same card and the same answer. */
  clientRequestId: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128))),
}).annotations(strict);
export type ThreadSecretRequestInput = typeof ThreadSecretRequestInput.Type;

/** Short enough that whoever approves the command sees all of it. */
export const MAX_THREAD_SECRET_COMMAND_LENGTH = 1_500;

/** The `run-with-secret` operation's input: one command, and the secrets it is given. */
export const ThreadSecretRunInput = Schema.Struct({
  operation: Schema.Literal("run-with-secret"),
  command: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(MAX_THREAD_SECRET_COMMAND_LENGTH),
    Schema.filter((value) => value.trim() !== "" && !value.includes("\u0000"), {
      message: () => "A command is text.",
    }),
  ),
  /** The names saved results gave, without the variable's prefix. */
  secrets: Schema.Array(DeliveredName).pipe(
    Schema.minItems(1),
    Schema.maxItems(MAX_THREAD_SECRET_FIELDS),
    Schema.filter((names) => new Set(names).size === names.length, {
      message: () => "Each secret is named once.",
    }),
  ),
  timeoutMs: Schema.optional(Schema.Int.pipe(Schema.between(1_000, 600_000))),
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      ({ command, secrets }) =>
        command.length + secrets.reduce((total, name) => total + name.length, 0) <=
        MAX_THREAD_SECRET_COMMAND_LENGTH,
      { message: () => "The command and its secrets' names are too long to show whole." },
    ),
  );
export type ThreadSecretRunInput = typeof ThreadSecretRunInput.Type;

/** What the agent reads of a command it ran with a secret. Its output is redacted. */
export const ThreadSecretRunResult = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("ran", "timed-out", "cancelled"),
    exitCode: Schema.optional(Schema.Int),
    output: Schema.String,
    truncated: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("refused"),
    /** A secret's own failure, or why the command was not run. */
    failure: Schema.Union(
      ThreadSecretFailure,
      Schema.Literal("plan", "not-approved", "no-shell", "server-project"),
    ),
    note: Note,
  }).annotations(strict),
);
export type ThreadSecretRunResult = typeof ThreadSecretRunResult.Type;

const saved = { status: Schema.Literal("saved"), name: ThreadSecretName } as const;
const FieldHandles = Schema.Record({ key: ThreadSecretFieldName, value: Schema.UUID });
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
    delivery: Schema.Literal("handle"),
    /** One per field, so a consumer is never handed the wrong one. */
    handles: FieldHandles,
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
    delivery: Schema.Literal("environment", "each-use"),
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
  /** As the browser will open it, so a look-alike host shows in its encoded form. */
  url: Schema.optional(
    ThreadSecretSetupUrl.pipe(Schema.filter((value) => new URL(value).href === value)),
  ),
  delivery: ThreadSecretRequestedDelivery,
  /** Always at least one: a request with no named fields has one, under its own name. */
  fields: Schema.Array(
    Schema.Struct({
      name: CardFieldName,
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
    name: CardFieldName,
    source: Schema.Literal("pasted"),
    value: ThreadSecretValue,
  }).annotations(strict),
  Schema.Struct({
    name: CardFieldName,
    source: Schema.Literal("onepassword"),
    store: SecretStoreKind,
    reference: SecretStoreItemReference,
    /** Reads the item at every use and keeps no copy. */
    freshEachUse: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    name: CardFieldName,
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

/** What one window may see of one thread: its waiting cards and its active secrets. */
export const ThreadSecretsView = Schema.Struct({
  requests: Schema.Array(ThreadSecretRequestCard).pipe(Schema.maxItems(8)),
  active: Schema.Array(ActiveThreadSecret).pipe(Schema.maxItems(64)),
}).annotations(strict);
export type ThreadSecretsView = typeof ThreadSecretsView.Type;

/** Every thread's active secrets and everything remembered, for Settings on this host. */
export const ThreadSecretsHostView = Schema.Struct({
  active: Schema.Array(
    Schema.Struct({
      ...ActiveThreadSecret.fields,
      threadTitle: Schema.optional(Schema.String),
    }).annotations(strict),
  ).pipe(Schema.maxItems(MAX_THREAD_SECRETS_LISTED)),
  remembered: Schema.Array(RememberedThreadSecret).pipe(
    Schema.maxItems(MAX_REMEMBERED_THREAD_SECRETS),
  ),
}).annotations(strict);
export type ThreadSecretsHostView = typeof ThreadSecretsHostView.Type;

/** Private submission only, like the answer it carries. */
export const ThreadSecretCommand = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("answer"),
    threadId: ThreadId,
    answer: ThreadSecretAnswer,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("revoke"),
    threadId: ThreadId,
    secretId: Schema.UUID,
  }).annotations(strict),
  /** Lists names in the linked store for one waiting card, so the person can pick an item. */
  Schema.Struct({
    kind: Schema.Literal("browse"),
    threadId: ThreadId,
    requestId: Schema.UUID,
    step: SecretStoreBrowseStep,
  }).annotations(strict),
  /** Removes a remembered secret. Threads that hold it keep it for their own time. */
  Schema.Struct({ kind: Schema.Literal("forget"), id: Schema.UUID }).annotations(strict),
);
export type ThreadSecretCommand = typeof ThreadSecretCommand.Type;

export const ThreadSecretCommandResult = Schema.Union(
  Schema.Struct({ status: Schema.Literal("accepted") }).annotations(strict),
  /** The card stays open and shows why, so the person can try again. */
  Schema.Struct({
    status: Schema.Literal("refused"),
    failure: ThreadSecretFailure,
  }).annotations(strict),
  Schema.Struct({ status: Schema.Literal("gone") }).annotations(strict),
);
export type ThreadSecretCommandResult = typeof ThreadSecretCommandResult.Type;

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
    use: Schema.Literal("command", "handle"),
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
      "delivery-failed",
    ),
  }).annotations(strict),
);
export type ThreadSecretJournalRecord = typeof ThreadSecretJournalRecord.Type;

export const THREAD_SECRET_MEMORY_EVENT_NAME = "thread-secret-memory.recorded@1";
export const THREAD_SECRET_MEMORY_AGGREGATE_TYPE = "thread-secret-memory";

/**
 * What the host remembers across threads: a name, and where its value is. A
 * value the person typed is in the system's credential store under the id; a
 * linked item is its address. No thread is named, so a thread's purge leaves
 * what the person asked to keep.
 */
export const ThreadSecretMemoryRecord = Schema.Union(
  Schema.Struct({
    name: Schema.Literal("thread-secret.remembered"),
    id: Schema.UUID,
    secretName: DeliveredName,
    source: Schema.Literal("pasted"),
  }).annotations(strict),
  Schema.Struct({
    name: Schema.Literal("thread-secret.remembered"),
    id: Schema.UUID,
    secretName: DeliveredName,
    source: Schema.Literal("onepassword"),
    store: SecretStoreKind,
    reference: SecretStoreItemReference,
  }).annotations(strict),
  Schema.Struct({
    name: Schema.Literal("thread-secret.forgotten"),
    id: Schema.UUID,
  }).annotations(strict),
);
export type ThreadSecretMemoryRecord = typeof ThreadSecretMemoryRecord.Type;

export const decodeThreadSecretMemoryRecord = Schema.decodeUnknownSync(ThreadSecretMemoryRecord);
export const decodeThreadSecretRunInput = Schema.decodeUnknownEither(ThreadSecretRunInput);
export const decodeThreadSecretRequestInput = Schema.decodeUnknownEither(ThreadSecretRequestInput);
export const decodeThreadSecretCommand = Schema.decodeUnknownEither(ThreadSecretCommand);
export const decodeThreadSecretJournalRecord = Schema.decodeUnknownSync(ThreadSecretJournalRecord);
export const decodeThreadSecretsView = Schema.decodeUnknownSync(ThreadSecretsView);
export const decodeThreadSecretsHostView = Schema.decodeUnknownSync(ThreadSecretsHostView);
export const decodeThreadSecretCommandResult = Schema.decodeUnknownSync(ThreadSecretCommandResult);
