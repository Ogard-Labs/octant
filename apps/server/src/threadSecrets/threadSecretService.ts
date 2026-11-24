import type {
  CredentialRequestReference,
  CredentialRequestResolution,
} from "@octant/contracts/credential-request";
import type {
  ActiveThreadSecret,
  ThreadSecretAnswer,
  ThreadSecretAnswerField,
  ThreadSecretCommandResult,
  ThreadSecretDelivery,
  ThreadSecretFailure,
  ThreadSecretJournalRecord,
  ThreadSecretLifetime,
  ThreadSecretRequestCard,
  ThreadSecretRequestInput,
  ThreadSecretRequestResult,
  ThreadSecretSource,
  ThreadSecretsView,
} from "@octant/contracts/thread-secrets";
import {
  decideThreadSecretLifetime,
  resolveThreadSecretDelivery,
  resolveThreadSecretOffer,
  threadSecretDeliveries,
} from "@octant/domain/thread-secret-policy";
import { whileAwaitingToolApproval } from "../toolEffects/toolEffectLedger";
import type { PreparedThreadSecretFile, ThreadSecretFiles } from "./threadSecretFiles";
import type { ThreadSecretsJournal } from "./threadSecretsJournal";

/** Where the asking thread stands right now. Read again before every side effect. */
export interface ThreadSecretAuthority {
  readonly mode: "chat" | "work" | "code";
  readonly strict: boolean;
  /** The thread's own commands run inside a sandbox Octant holds. */
  readonly commandsConfined: boolean;
}

/** One turn of one thread, as the turn's tools were composed. */
export interface ThreadSecretCaller {
  readonly windowId: string;
  readonly threadId: string;
  /** Names the turn, so what it alone was given ends with it. */
  readonly turnId: string;
  /** Undefined once the thread, its Project, window or profile no longer admits the tool. */
  readonly authority: () => ThreadSecretAuthority | undefined;
  /** Aborts when the turn stops. */
  readonly signal: AbortSignal;
}

export interface ThreadSecretConsumer {
  readonly id: string;
  readonly label: string;
}

export type ThreadSecretRedemption =
  | { readonly status: "redeemed"; readonly label: string; readonly value: string }
  | { readonly status: "refused"; readonly failure: ThreadSecretFailure };

export interface ThreadSecretServiceOptions {
  readonly uuid: () => string;
  /** Epoch milliseconds that never step back and count a suspended host's time. */
  readonly now: () => number;
  readonly journal: ThreadSecretsJournal;
  /** Absent on a host with nowhere private to write one. */
  readonly files?: ThreadSecretFiles | undefined;
  /** Starts redacting a value everywhere; returns what stops it. */
  readonly hold: (value: string) => () => void;
  readonly readReference?:
    | ((
        reference: CredentialRequestReference,
        signal: AbortSignal,
      ) => Promise<CredentialRequestResolution>)
    | undefined;
  /** The waiting cards or the active list changed. */
  readonly onChanged?: (() => void) | undefined;
  /** A card began to wait. Names the thread and the card and nothing of its content. */
  readonly onAsked?:
    | ((ask: { readonly threadId: string; readonly askId: string }) => void)
    | undefined;
}

type Reference = CredentialRequestReference;
type JournaledCommon = Pick<
  ThreadSecretJournalRecord,
  "secretId" | "threadId" | "mode" | "secretName" | "kind"
>;

interface ActiveSecret {
  readonly id: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly mode: "work" | "code";
  readonly requestName: string;
  readonly field: string;
  readonly secretName: string;
  readonly environmentName: string;
  readonly label: string;
  readonly kind: ThreadSecretRequestInput["kind"];
  readonly source: ThreadSecretSource;
  readonly lifetime: ThreadSecretLifetime;
  readonly delivery: ThreadSecretDelivery;
  /** Set for a 1Password secret: every use but its file reads the item again. */
  readonly reference: Reference | undefined;
  readonly value: string;
  readonly path: string | undefined;
  readonly endsAt: number | undefined;
  readonly release: () => void;
}

interface PendingRequest {
  readonly caller: ThreadSecretCaller;
  readonly input: ThreadSecretRequestInput;
  readonly card: ThreadSecretRequestCard;
  readonly settle: (result: ThreadSecretRequestResult) => void;
  readonly answered: () => void;
  readonly lookup: AbortController;
  state: "pending" | "saving";
  failure: ThreadSecretFailure | undefined;
}

interface AnsweredField {
  readonly value: string;
  readonly source: ThreadSecretSource;
  readonly reference: Reference | undefined;
}

/** A request held for a person costs memory and a place in Needs you. */
const MAX_PENDING_REQUESTS = 32;
const MAX_PENDING_PER_THREAD = 8;
const MAX_ACTIVE_PER_THREAD = 64;
/** A handle the agent never uses is not kept past this many newer ones. */
const MAX_HANDLES_PER_SECRET = 8;
const MAX_RETRY_KEYS_PER_THREAD = 128;
/** Threads whose answered retry keys are kept; the longest unused leaves first. */
const MAX_RETRY_THREADS = 256;
const LOOKUP_TIMEOUT_MS = 60_000;
const SWEEP_INTERVAL_MS = 1_000;
const LIFETIME_MS: Readonly<Partial<Record<ThreadSecretLifetime, number>>> = {
  "1-hour": 60 * 60_000,
  "24-hours": 24 * 60 * 60_000,
};

const NOTES = {
  declined: "The person declined. Do not ask again, here or in chat: say what is blocked and stop.",
  cancelled:
    "The card closed before an answer. Ask again with a new clientRequestId only if you still need the secret.",
} as const;

const REFUSAL_NOTES: Readonly<Record<ThreadSecretFailure, string>> = {
  declined: NOTES.declined,
  expired: "This secret's time is up. Ask again if you still need it.",
  revoked: "The person ended this secret. Do not ask again unless they say so.",
  locked: "The person's secret store is locked.",
  missing: "The person's secret store has no such item.",
  unavailable: "Octant cannot hold a secret for this thread right now.",
  "not-linked": "No secret store is linked on this computer.",
  "invalid-reference": "That reference does not name one secret.",
  "refused-by-strict": "Strict does not allow this here.",
  "lifetime-not-offered": "That lifetime is not offered for this secret.",
  "unsupported-mode": "Chat runs no commands, so it takes no secrets.",
};

const refusal = (failure: ThreadSecretFailure): ThreadSecretRequestResult => ({
  status: "refused",
  failure,
  note: REFUSAL_NOTES[failure],
});

/**
 * The secrets a person gave a thread: the cards that ask for them, and what
 * was granted until it ends.
 *
 * A card is visible to the window whose turn raised it and waits with no
 * expiry until it is answered, its turn stops, its thread is archived, its
 * window goes or the host stops. A granted value stays in this process and,
 * where a file was granted, in that file. Nothing is usable before the journal
 * has recorded it, and nothing but a record of its end outlives it.
 */
export class ThreadSecretService {
  readonly #options: ThreadSecretServiceOptions;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #active = new Map<string, ActiveSecret>();
  /** Handle to secret id, oldest first. */
  readonly #handles = new Map<string, string>();
  readonly #consumers = new Map<string, ThreadSecretConsumer>();
  /** Retry key to its one answer, per thread. */
  readonly #answers = new Map<string, Map<string, Promise<ThreadSecretRequestResult>>>();
  readonly #lastLifetimes = new Map<string, ThreadSecretLifetime>();
  /** Files whose removal failed, tried again until they are gone. */
  readonly #leftover = new Map<string, { readonly threadId: string; readonly name: string }>();
  readonly #timer: ReturnType<typeof setInterval>;
  #closed = false;

  constructor(options: ThreadSecretServiceOptions) {
    this.#options = options;
    // An earlier host's values died with it; its files and its open records did not.
    this.#attempt(() => options.files?.sweep());
    this.#attempt(() => {
      const { open, lastLifetimes } = options.journal.history();
      for (const [name, lifetime] of lastLifetimes) this.#lastLifetimes.set(name, lifetime);
      for (const record of open)
        this.#attempt(() =>
          options.journal.record(record.threadId, [
            { name: "thread-secret.revoked", ...commonOf(record), cause: "host-stopped" },
          ]),
        );
    });
    this.#timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.#timer.unref();
  }

  /** The agent's `request-secret`. Resolves when the person answers or the wait ends. */
  request(
    caller: ThreadSecretCaller,
    input: ThreadSecretRequestInput,
    signal?: AbortSignal,
  ): Promise<ThreadSecretRequestResult> {
    this.sweep();
    const refused = this.#refusesCaller(caller, input);
    if (refused !== undefined) return Promise.resolve(refused);
    if (input.clientRequestId === undefined) return this.#ask(caller, input, signal);
    const answers =
      this.#answers.get(caller.threadId) ?? new Map<string, Promise<ThreadSecretRequestResult>>();
    this.#answers.delete(caller.threadId);
    this.#answers.set(caller.threadId, answers);
    if (this.#answers.size > MAX_RETRY_THREADS) {
      const oldest = this.#answers.keys().next().value;
      if (oldest !== undefined) this.#answers.delete(oldest);
    }
    const earlier = answers.get(input.clientRequestId);
    if (earlier !== undefined) return earlier;
    if (answers.size >= MAX_RETRY_KEYS_PER_THREAD) {
      const oldest = answers.keys().next().value;
      if (oldest !== undefined) answers.delete(oldest);
    }
    const answer = this.#ask(caller, input, signal);
    const key = input.clientRequestId;
    answers.set(key, answer);
    // A call the journal refused gave no answer to keep.
    answer.catch(() => answers.delete(key));
    return answer;
  }

  /** The person's answer to a card in their own window. */
  async answer(
    windowId: string,
    threadId: string,
    answer: ThreadSecretAnswer,
    from: { readonly paired: boolean },
  ): Promise<ThreadSecretCommandResult> {
    this.sweep();
    const pending = this.#pending.get(answer.id);
    if (
      pending === undefined ||
      pending.caller.windowId !== windowId ||
      pending.caller.threadId !== threadId ||
      pending.state !== "pending"
    )
      return { status: "gone" };
    if (answer.action === "decline") {
      pending.settle({ status: "declined", note: NOTES.declined });
      return { status: "accepted" };
    }
    // Claimed before anything is awaited, so one answer acts on a card.
    pending.state = "saving";
    pending.failure = undefined;
    this.#changed();
    const result = await this.#save(pending, answer, from).catch(
      (): ThreadSecretFailure => "unavailable",
    );
    // The turn, thread or window may have ended while an item was read.
    if (this.#pending.get(answer.id) !== pending) return { status: "gone" };
    if (typeof result === "string") {
      // The card stays open: a locked store can be unlocked, a value retyped.
      pending.state = "pending";
      pending.failure = result;
      this.#changed();
      return { status: "refused", failure: result };
    }
    pending.settle(result);
    return { status: "accepted" };
  }

  /**
   * What a window may see of a thread: the cards it raised itself, and every
   * active secret, which the person ends from whichever window they are in.
   */
  view(windowId: string, threadId: string): ThreadSecretsView {
    this.sweep();
    return {
      requests: [...this.#pending.values()]
        .filter(
          (pending) => pending.caller.windowId === windowId && pending.caller.threadId === threadId,
        )
        .map((pending) => ({
          ...pending.card,
          state: pending.state,
          ...(pending.failure === undefined ? {} : { failure: pending.failure }),
        })),
      active: this.active(threadId),
    };
  }

  active(threadId?: string): ReadonlyArray<ActiveThreadSecret> {
    const now = this.#options.now();
    return [...this.#active.values()]
      .filter((secret) => threadId === undefined || secret.threadId === threadId)
      .map((secret) => ({
        id: secret.id,
        threadId: secret.threadId,
        name: secret.secretName,
        label: secret.label,
        kind: secret.kind,
        source: secret.source,
        lifetime: secret.lifetime,
        delivery: secret.delivery,
        ...(secret.endsAt === undefined
          ? {}
          : { remainingMs: Math.max(0, Math.round(secret.endsAt - now)) }),
      }));
  }

  revoke(threadId: string, secretId: string): ThreadSecretCommandResult {
    const secret = this.#active.get(secretId);
    if (secret === undefined || secret.threadId !== threadId) return { status: "gone" };
    this.#end([secret], "person");
    return { status: "accepted" };
  }

  /**
   * Admits a host tool or a plugin's operation as a redeemer of handles. The
   * agent's shell is never one, so a handle in a command is worth nothing.
   */
  registerConsumer(consumer: ThreadSecretConsumer): () => void {
    if (this.#consumers.has(consumer.id)) throw new Error("That consumer is already registered.");
    this.#consumers.set(consumer.id, consumer);
    return () => {
      if (this.#consumers.get(consumer.id) === consumer) this.#consumers.delete(consumer.id);
    };
  }

  /** Hands a handle's value to its consumer, once. */
  async redeem(input: {
    readonly consumerId: string;
    readonly threadId: string;
    readonly handle: string;
    readonly signal: AbortSignal;
  }): Promise<ThreadSecretRedemption> {
    this.sweep();
    if (!this.#consumers.has(input.consumerId))
      return { status: "refused", failure: "unavailable" };
    const secretId = this.#handles.get(input.handle);
    const secret = secretId === undefined ? undefined : this.#active.get(secretId);
    if (secret === undefined || secret.threadId !== input.threadId)
      return { status: "refused", failure: "expired" };
    // Spent before the value is read: two redeemers never both get it.
    this.#handles.delete(input.handle);
    let value = secret.value;
    let release: (() => void) | undefined;
    if (secret.reference !== undefined) {
      const read = await this.#read(secret.reference, input.signal);
      if (typeof read !== "string") return { status: "refused", failure: read.failure };
      value = read;
      // A rotated item has a value the grant never held.
      if (value !== secret.value) release = this.#options.hold(value);
    }
    // Another handle's read may have renewed it meanwhile; only its end refuses this one.
    const current = this.#active.get(secret.id);
    if (current === undefined) {
      release?.();
      return { status: "refused", failure: "revoked" };
    }
    try {
      this.#options.journal.record(secret.threadId, [
        { name: "thread-secret.used", ...journaled(secret), use: "handle" },
      ]);
    } catch {
      release?.();
      return { status: "refused", failure: "unavailable" };
    }
    if (release !== undefined)
      this.#active.set(secret.id, { ...current, value, release: both(current.release, release) });
    const held = this.#active.get(secret.id);
    if (secret.lifetime === "this-command" && held !== undefined)
      this.#end([held], "command-ended");
    return { status: "redeemed", label: secret.label, value };
  }

  /** Ends what the turn alone was given, and the cards it left open. */
  turnEnded(threadId: string, turnId: string): void {
    for (const pending of this.#pending.values())
      if (pending.caller.threadId === threadId && pending.caller.turnId === turnId)
        this.#cancel(pending);
    this.#end(
      [...this.#active.values()].filter(
        (secret) =>
          secret.threadId === threadId &&
          secret.turnId === turnId &&
          (secret.lifetime === "this-turn" || secret.lifetime === "this-command"),
      ),
      "turn-ended",
    );
  }

  /** The thread was archived or deleted. */
  withdrawThread(threadId: string): void {
    for (const pending of this.#pending.values())
      if (pending.caller.threadId === threadId) this.#cancel(pending);
    this.#end(
      [...this.#active.values()].filter((secret) => secret.threadId === threadId),
      "thread-archived",
    );
    this.#answers.delete(threadId);
  }

  revokeWindow(windowId: string): void {
    for (const pending of this.#pending.values())
      if (pending.caller.windowId === windowId) this.#cancel(pending);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    for (const pending of this.#pending.values()) this.#cancel(pending);
    this.#end([...this.#active.values()], "host-stopped");
    this.#attempt(() => this.#options.files?.sweep());
    this.#answers.clear();
    this.#handles.clear();
  }

  /** Ends what has run out of time, and whatever could not be removed before. */
  sweep(): void {
    const now = this.#options.now();
    this.#end(
      [...this.#active.values()].filter(
        (secret) => secret.endsAt !== undefined && now >= secret.endsAt,
      ),
      "expired",
    );
    for (const pending of this.#pending.values())
      if (pending.state === "pending" && this.#authority(pending.caller) === undefined)
        this.#cancel(pending);
    for (const [key, file] of this.#leftover)
      if (this.#attempt(() => this.#options.files?.remove(file.threadId, file.name)))
        this.#leftover.delete(key);
  }

  #refusesCaller(
    caller: ThreadSecretCaller,
    input: ThreadSecretRequestInput,
  ): ThreadSecretRequestResult | undefined {
    if (this.#closed || caller.signal.aborted)
      return { status: "cancelled", note: NOTES.cancelled };
    const authority = this.#authority(caller);
    if (authority === undefined) return refusal("unavailable");
    if (authority.mode === "chat") return refusal("unsupported-mode");
    // Moving a pasted value is its own step: it must be proved to be a value
    // the person wrote before Octant hides it anywhere.
    if (input.value !== undefined) return refusal("unavailable");
    return undefined;
  }

  #ask(
    caller: ThreadSecretCaller,
    input: ThreadSecretRequestInput,
    signal: AbortSignal | undefined,
  ): Promise<ThreadSecretRequestResult> {
    const again = this.#stillGranted(caller, input);
    if (again !== undefined) return Promise.resolve(again);
    const authority = this.#authority(caller);
    if (authority === undefined) return Promise.resolve(refusal("unavailable"));
    const names = deliveriesOf(input);
    const offer = resolveThreadSecretOffer({
      ...authority,
      kind: input.kind,
      lastLifetime: this.#lastLifetimes.get(names[0]?.secretName ?? input.name),
    });
    if (offer.status !== "offered") return Promise.resolve(refusal(offer.status));
    const waiting = [...this.#pending.values()];
    if (
      waiting.length >= MAX_PENDING_REQUESTS ||
      waiting.filter((pending) => pending.caller.threadId === caller.threadId).length >=
        MAX_PENDING_PER_THREAD
    )
      return Promise.resolve(refusal("unavailable"));
    const id = this.#options.uuid();
    const card: ThreadSecretRequestCard = {
      id,
      threadId: caller.threadId,
      name: input.name,
      label: input.label,
      kind: input.kind,
      reason: input.reason,
      ...(input.url === undefined ? {} : { url: input.url }),
      delivery: input.delivery ?? "handle",
      fields:
        input.fields === undefined
          ? [
              {
                name: input.name,
                label: input.label,
                ...(input.placeholder === undefined ? {} : { placeholder: input.placeholder }),
                secret: true,
              },
            ]
          : input.fields.map((field) => ({
              name: field.name,
              label: field.label,
              ...(field.placeholder === undefined ? {} : { placeholder: field.placeholder }),
              secret: field.secret ?? true,
            })),
      lifetimes: offer.lifetimes.filter((lifetime) => lifetime !== "remember"),
      defaultLifetime: offer.defaultLifetime === "remember" ? "24-hours" : offer.defaultLifetime,
      sources: this.#options.readReference === undefined ? ["pasted"] : ["pasted", "onepassword"],
      remembered: [],
      state: "pending",
    };
    return whileAwaitingToolApproval(
      (answered) =>
        new Promise((resolve) => {
          const stop = () => this.#cancel(pending);
          let settled = false;
          const pending: PendingRequest = {
            caller,
            input,
            card,
            answered,
            lookup: new AbortController(),
            state: "pending",
            failure: undefined,
            settle: (result) => {
              if (settled) return;
              settled = true;
              caller.signal.removeEventListener("abort", stop);
              signal?.removeEventListener("abort", stop);
              pending.lookup.abort();
              this.#pending.delete(id);
              this.#changed();
              resolve(result);
            },
          };
          this.#pending.set(id, pending);
          caller.signal.addEventListener("abort", stop, { once: true });
          signal?.addEventListener("abort", stop, { once: true });
          this.#changed();
          this.#attempt(() => this.#options.onAsked?.({ threadId: caller.threadId, askId: id }));
          if (caller.signal.aborted || signal?.aborted === true) stop();
        }),
    );
  }

  /**
   * The answer to asking again for what the thread already holds: the same
   * file, or a fresh handle per field, with no new card. The person chose the
   * lifetime this stays inside. Delivery never widens: a secret granted as a
   * handle only needs a card before a command may read it.
   */
  #stillGranted(
    caller: ThreadSecretCaller,
    input: ThreadSecretRequestInput,
  ): ThreadSecretRequestResult | undefined {
    const authority = this.#authority(caller);
    if (authority === undefined) return undefined;
    const requested = input.delivery ?? "handle";
    const secrets: ActiveSecret[] = [];
    for (const { secretName, field } of deliveriesOf(input)) {
      const secret = this.#named(caller.threadId, secretName);
      if (
        secret === undefined ||
        secret.kind !== input.kind ||
        secret.field !== field ||
        secret.requestName !== input.name ||
        // One command's secret is spent on that command.
        secret.lifetime === "this-command" ||
        decideThreadSecretLifetime({ ...authority, kind: secret.kind }, secret.lifetime).status !==
          "allowed"
      )
        return undefined;
      if (requested === "file") {
        if (secret.delivery === "handle") return undefined;
        // Strict or a sandbox turned on since: its commands cannot read the file.
        if (
          secret.delivery === "file-and-environment" &&
          (authority.strict || authority.commandsConfined)
        )
          return undefined;
      }
      secrets.push(secret);
    }
    const delivery = secrets[0]?.delivery;
    if (delivery === undefined || secrets.some((secret) => secret.delivery !== delivery))
      return undefined;
    return this.#savedResult(input, secrets, requested === "handle" ? "handle" : delivery);
  }

  async #save(
    pending: PendingRequest,
    answer: Extract<ThreadSecretAnswer, { readonly action: "save" }>,
    from: { readonly paired: boolean },
  ): Promise<ThreadSecretFailure | ThreadSecretRequestResult> {
    const { card, caller, input } = pending;
    if (
      answer.fields.length !== card.fields.length ||
      card.fields.some((field) => !answer.fields.some((entry) => entry.name === field.name))
    )
      return "unavailable";
    const answered = new Map<string, AnsweredField>();
    for (const entry of answer.fields) {
      const read = await this.#answeredField(entry, from, pending.lookup.signal);
      if ("failure" in read) return read.failure;
      answered.set(entry.name, read);
    }
    if (this.#pending.get(card.id) !== pending) return "revoked";
    // Read after every await: a card drawn before Strict came on grants nothing
    // Strict refuses.
    const authority = this.#authority(caller);
    if (authority === undefined || authority.mode === "chat") return "unavailable";
    const lifetime = decideThreadSecretLifetime(
      { ...authority, kind: input.kind },
      answer.lifetime,
    );
    if (lifetime.status === "refused") return lifetime.failure;
    if (!card.lifetimes.includes(answer.lifetime)) return "lifetime-not-offered";
    // The tool call is back on record before it has any effect.
    pending.answered();
    return this.#grant(pending, answered, answer.lifetime, authority, authority.mode);
  }

  async #answeredField(
    entry: ThreadSecretAnswerField,
    from: { readonly paired: boolean },
    signal: AbortSignal,
  ): Promise<AnsweredField | { readonly failure: ThreadSecretFailure }> {
    switch (entry.source) {
      case "pasted":
        // Blank is no answer; anything else is kept exactly as typed.
        return entry.value.trim() === ""
          ? { failure: "missing" }
          : { value: entry.value, source: "pasted", reference: undefined };
      case "onepassword": {
        // The store belongs to the person at this computer.
        if (from.paired) return { failure: "not-linked" };
        if (entry.freshEachUse) return { failure: "unavailable" };
        const reference = { store: entry.store, reference: entry.reference };
        const read = await this.#read(reference, signal);
        return typeof read === "string" ? { value: read, source: "onepassword", reference } : read;
      }
      case "remembered":
        return { failure: "unavailable" };
    }
  }

  async #read(
    reference: Reference,
    signal: AbortSignal,
  ): Promise<string | { readonly failure: ThreadSecretFailure }> {
    if (this.#options.readReference === undefined) return { failure: "not-linked" };
    const read = await this.#options
      .readReference(reference, AbortSignal.any([signal, AbortSignal.timeout(LOOKUP_TIMEOUT_MS)]))
      .catch(() => ({ status: "unavailable" as const }));
    if (read.status !== "read")
      return { failure: read.status === "changed" ? "unavailable" : read.status };
    return read.value.trim() === "" || read.value.includes("\u0000")
      ? { failure: "invalid-reference" }
      : read.value;
  }

  /**
   * Grants every field or none. The values are redacted first, then written
   * under a name nothing knows, then recorded, then put in place: a journal
   * that refuses leaves nothing behind, and a file that cannot be put in place
   * is recorded as ended.
   */
  #grant(
    pending: PendingRequest,
    answered: ReadonlyMap<string, AnsweredField>,
    lifetime: ThreadSecretLifetime,
    authority: ThreadSecretAuthority,
    mode: "work" | "code",
  ): ThreadSecretFailure | ThreadSecretRequestResult {
    const { input, caller, card } = pending;
    const wanted = resolveThreadSecretDelivery({
      requested: card.delivery,
      lifetime,
      strict: authority.strict,
      commandsConfined: authority.commandsConfined,
      freshEachUse: false,
    });
    const files = wanted === "file-and-environment" ? this.#options.files : undefined;
    const delivery =
      wanted === "file-and-environment" && files === undefined ? "environment" : wanted;
    const prepared: PreparedThreadSecretFile[] = [];
    const secrets: ActiveSecret[] = [];
    const undo = () => {
      for (const file of prepared) this.#attempt(() => file.discard());
      for (const secret of secrets) secret.release();
    };
    const replaced: ActiveSecret[] = [];
    try {
      for (const { field, secretName, environmentName } of deliveriesOf(input)) {
        const value = answered.get(field);
        const shown = card.fields.find((entry) => entry.name === field);
        if (value === undefined || shown === undefined) {
          undo();
          return "unavailable";
        }
        const release = shown.secret ? this.#options.hold(value.value) : () => undefined;
        const secret: ActiveSecret = {
          id: this.#options.uuid(),
          threadId: caller.threadId,
          turnId: caller.turnId,
          mode,
          requestName: input.name,
          field,
          secretName,
          environmentName,
          label: shown.label,
          kind: input.kind,
          source: value.source,
          lifetime,
          delivery,
          reference: value.reference,
          value: value.value,
          path: undefined,
          endsAt: endOf(lifetime, this.#options.now()),
          release,
        };
        // Held from here, so a failure below still lets it go.
        secrets.push(secret);
        const file = files?.prepare(caller.threadId, secretName, value.value);
        if (file !== undefined) {
          prepared.push(file);
          secrets[secrets.length - 1] = { ...secret, path: file.path };
        }
        const earlier = this.#named(caller.threadId, secretName);
        if (earlier !== undefined) replaced.push(earlier);
      }
      const held = [...this.#active.values()].filter(
        (secret) => secret.threadId === caller.threadId,
      ).length;
      if (held - replaced.length + secrets.length > MAX_ACTIVE_PER_THREAD) {
        undo();
        return "unavailable";
      }
      this.#options.journal.record(caller.threadId, [
        ...replaced.map(
          (secret): ThreadSecretJournalRecord => ({
            name: "thread-secret.revoked",
            ...journaled(secret),
            cause: "replaced",
          }),
        ),
        ...secrets.map(
          (secret): ThreadSecretJournalRecord => ({
            name: "thread-secret.granted",
            ...journaled(secret),
            source: secret.source,
            lifetime: secret.lifetime,
            delivery: secret.delivery,
          }),
        ),
      ]);
    } catch {
      undo();
      return "unavailable";
    }
    // Recorded as replaced already; only a file the new one will not replace goes.
    for (const secret of replaced)
      this.#forget(
        secret,
        secrets.some((next) => next.path !== undefined && next.path === secret.path),
      );
    for (const secret of secrets) this.#active.set(secret.id, secret);
    try {
      for (const file of prepared) file.commit();
    } catch {
      for (const file of prepared) this.#attempt(() => file.discard());
      this.#end(secrets, "delivery-failed");
      return "unavailable";
    }
    for (const secret of secrets) {
      this.#lastLifetimes.set(secret.secretName, lifetime);
      // Its name is in use again: an earlier file's owed removal would take this one.
      if (secret.path !== undefined)
        this.#leftover.delete(`${secret.threadId}/${secret.secretName}`);
    }
    this.#changed();
    return this.#savedResult(input, secrets, delivery);
  }

  #savedResult(
    input: ThreadSecretRequestInput,
    secrets: ReadonlyArray<ActiveSecret>,
    delivery: ThreadSecretDelivery,
  ): ThreadSecretRequestResult {
    const byField = <T>(pick: (secret: ActiveSecret) => T): Readonly<Record<string, T>> =>
      Object.fromEntries(secrets.map((secret) => [secret.field, pick(secret)]));
    const [only] = secrets;
    if (only === undefined) return refusal("unavailable");
    const saved = { status: "saved", name: input.name } as const;
    const single = input.fields === undefined;
    switch (delivery) {
      case "handle":
        return single
          ? { ...saved, delivery, handle: this.#newHandle(only) }
          : { ...saved, delivery, handles: byField((secret) => this.#newHandle(secret)) };
      case "file-and-environment":
        return single
          ? { ...saved, delivery, file: only.path ?? "", env: only.environmentName }
          : {
              ...saved,
              delivery,
              files: byField((secret) => secret.path ?? ""),
              env: byField((secret) => secret.environmentName),
            };
      case "environment":
      case "op-run":
        return {
          ...saved,
          delivery,
          env: single ? only.environmentName : byField((secret) => secret.environmentName),
        };
    }
  }

  #newHandle(secret: ActiveSecret): string {
    const own = [...this.#handles].filter(([, secretId]) => secretId === secret.id);
    const [oldest] = own;
    if (own.length >= MAX_HANDLES_PER_SECRET && oldest !== undefined)
      this.#handles.delete(oldest[0]);
    const handle = this.#options.uuid();
    this.#handles.set(handle, secret.id);
    return handle;
  }

  #named(threadId: string, secretName: string): ActiveSecret | undefined {
    return [...this.#active.values()].find(
      (secret) => secret.threadId === threadId && secret.secretName === secretName,
    );
  }

  #cancel(pending: PendingRequest): void {
    pending.settle({ status: "cancelled", note: NOTES.cancelled });
  }

  /** Nothing can use an ended secret, whether or not the journal takes the record. */
  #end(
    secrets: ReadonlyArray<ActiveSecret>,
    cause:
      | "expired"
      | Extract<ThreadSecretJournalRecord, { name: "thread-secret.revoked" }>["cause"],
  ): void {
    if (secrets.length === 0) return;
    for (const secret of secrets) {
      this.#forget(secret, false);
      // A refused record leaves the grant open, and the next start ends it there.
      this.#attempt(() =>
        this.#options.journal.record(secret.threadId, [
          cause === "expired"
            ? { name: "thread-secret.expired", ...journaled(secret) }
            : { name: "thread-secret.revoked", ...journaled(secret), cause },
        ]),
      );
    }
    this.#changed();
  }

  #forget(secret: ActiveSecret, fileReplaced: boolean): void {
    this.#active.delete(secret.id);
    for (const [handle, secretId] of this.#handles)
      if (secretId === secret.id) this.#handles.delete(handle);
    const removed =
      secret.path === undefined ||
      fileReplaced ||
      this.#attempt(() => this.#options.files?.remove(secret.threadId, secret.secretName));
    if (!removed)
      this.#leftover.set(`${secret.threadId}/${secret.secretName}`, {
        threadId: secret.threadId,
        name: secret.secretName,
      });
    secret.release();
  }

  /** Anything that cannot be read admits nothing. */
  #authority(caller: ThreadSecretCaller): ThreadSecretAuthority | undefined {
    try {
      return caller.authority();
    } catch {
      return undefined;
    }
  }

  #changed(): void {
    this.#attempt(() => this.#options.onChanged?.());
  }

  #attempt(step: () => void): boolean {
    try {
      step();
      return true;
    } catch {
      return false;
    }
  }
}

function deliveriesOf(input: ThreadSecretRequestInput) {
  return threadSecretDeliveries(
    input.name,
    input.fields?.map((field) => field.name),
  );
}

function endOf(lifetime: ThreadSecretLifetime, now: number): number | undefined {
  const duration = LIFETIME_MS[lifetime];
  return duration === undefined ? undefined : now + duration;
}

function commonOf(record: ThreadSecretJournalRecord): JournaledCommon {
  const { secretId, threadId, mode, secretName, kind } = record;
  return { secretId, threadId, mode, secretName, kind };
}

function journaled(secret: ActiveSecret): JournaledCommon {
  return {
    secretId: secret.id,
    threadId: secret.threadId,
    mode: secret.mode,
    secretName: secret.secretName,
    kind: secret.kind,
  };
}

function both(first: () => void, second: () => void): () => void {
  return () => {
    first();
    second();
  };
}
