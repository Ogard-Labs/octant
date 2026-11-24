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
import type { RememberedThreadSecrets } from "./rememberedThreadSecrets";
import type { PreparedThreadSecretFile, ThreadSecretFiles } from "./threadSecretFiles";
import { lifetimeKey, type ThreadSecretsJournal } from "./threadSecretsJournal";

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
  | {
      readonly status: "redeemed";
      readonly label: string;
      readonly value: string;
      /**
       * Says the consumer is finished with the value. Until then, or until the
       * turn ends, it stays redacted, though its secret may have ended.
       */
      readonly done: () => void;
    }
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
  /** Absent on a host with no credential store, which offers to remember nothing. */
  readonly remembered?: RememberedThreadSecrets | undefined;
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
  /** None when the person chose to have the item read at each use and kept nowhere. */
  readonly value: string | undefined;
  readonly path: string | undefined;
  readonly endsAt: number | undefined;
  /** Stops redacting the value that was granted; none for a value that is no secret. */
  readonly release: (() => void) | undefined;
  /** Stops redacting the latest value its item was rotated to. */
  readonly releaseRotated: (() => void) | undefined;
}

/** A redeemed value its consumer may still print. */
interface Lease {
  readonly threadId: string;
  readonly turnId: string;
  readonly release: () => void;
}

interface RetriedAnswer {
  /** What was asked. The same key with anything else is not a retry. */
  readonly asked: string;
  readonly answer: Promise<ThreadSecretRequestResult>;
  /** The secrets a saved answer names, once there is one. */
  secretIds: ReadonlyArray<string> | undefined;
  settled: boolean;
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

type EndCause =
  | "expired"
  | Extract<ThreadSecretJournalRecord, { name: "thread-secret.revoked" }>["cause"];

interface AnsweredField {
  readonly value: string;
  readonly source: ThreadSecretSource;
  readonly reference: Reference | undefined;
  readonly eachUse: boolean;
}

/** A secret about to be used, and the value it has now. */
interface Use {
  readonly secret: ActiveSecret;
  readonly value: string;
}

export type ThreadSecretLoan =
  | {
      readonly status: "lent";
      readonly environment: Readonly<Record<string, string>>;
      /**
       * Called as the command starts, and false when it must not: something
       * that admitted it ended, or its use could not be recorded.
       */
      readonly start: () => boolean;
      /** Says the command has ended, or never started, and its output has been read. */
      readonly done: () => void;
    }
  | { readonly status: "refused"; readonly failure: ThreadSecretFailure };

/** A request held for a person costs memory and a place in Needs you. */
const MAX_PENDING_REQUESTS = 256;
/** Few enough that no thread's cards can keep another thread's from opening. */
const MAX_PENDING_PER_THREAD = 2;
const MAX_ACTIVE_PER_THREAD = 64;
/** A handle the agent never uses is not kept past this many newer ones. */
const MAX_HANDLES_PER_SECRET = 8;
const MAX_REMEMBERED_SHOWN = 32;
const MAX_RETRY_KEYS_PER_THREAD = 128;
/** Threads whose answered retry keys are kept; the longest unused leaves first. */
const MAX_RETRY_THREADS = 256;
/** Each costs every redaction pass; past this the longest ended leaves. */
const MAX_ENDED_VALUES = 128;
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
 * has recorded it. An ended value is kept only to redact it, and only until the
 * host stops.
 */
export class ThreadSecretService {
  readonly #options: ThreadSecretServiceOptions;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #active = new Map<string, ActiveSecret>();
  /** Handle to secret id, oldest first. */
  readonly #handles = new Map<string, string>();
  readonly #consumers = new Map<string, ThreadSecretConsumer>();
  /** Retry key to its one answer, per thread. */
  readonly #answers = new Map<string, Map<string, RetriedAnswer>>();
  readonly #leases = new Set<Lease>();
  /** One-command secrets a command is being prepared with. */
  readonly #claimed = new Set<string>();
  /**
   * What stops redacting each ended value, oldest first. A token usually works
   * after its secret ends, and the agent may still have it in its context, so
   * the value stays redacted until the host stops (maintainer decision,
   * 2026-11-24). Only this redaction still has it.
   */
  readonly #ended: Array<() => void> = [];
  readonly #lastLifetimes = new Map<string, ThreadSecretLifetime>();
  /** Files whose removal failed, tried again until they are gone. */
  readonly #leftover = new Map<string, { readonly threadId: string; readonly name: string }>();
  readonly #timer: ReturnType<typeof setInterval>;
  #closed = false;
  /** No file is written while an earlier host's may still be there. */
  #swept = false;

  constructor(options: ThreadSecretServiceOptions) {
    this.#options = options;
    // An earlier host's values died with it; its files and its open records did not.
    this.#clearEarlierFiles();
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
    const answers = this.#answers.get(caller.threadId) ?? new Map<string, RetriedAnswer>();
    this.#answers.delete(caller.threadId);
    this.#answers.set(caller.threadId, answers);
    const key = input.clientRequestId;
    const asked = JSON.stringify(input);
    const earlier = answers.get(key);
    if (earlier !== undefined) return this.#replay(earlier, asked);
    this.#dropOldAnswers(answers);
    const answer = this.#ask(caller, input, signal);
    const kept: RetriedAnswer = { asked, answer, secretIds: undefined, settled: false };
    answers.set(key, kept);
    answer.then(
      (result) => {
        kept.settled = true;
        if (result.status !== "saved") return;
        kept.secretIds = deliveriesOf(input).map(
          ({ secretName }) => this.#named(caller.threadId, secretName)?.id ?? "",
        );
      },
      // A call the journal refused gave no answer to keep.
      () => answers.delete(key),
    );
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
    readonly caller: ThreadSecretCaller;
    readonly handle: string;
    readonly signal: AbortSignal;
  }): Promise<ThreadSecretRedemption> {
    const { caller } = input;
    this.sweep();
    const consumer = this.#consumers.get(input.consumerId);
    if (consumer === undefined) return { status: "refused", failure: "unavailable" };
    const secretId = this.#handles.get(input.handle);
    const secret = secretId === undefined ? undefined : this.#active.get(secretId);
    if (secret === undefined || secret.threadId !== caller.threadId)
      return { status: "refused", failure: "expired" };
    const before = this.#refusesUse(caller, secret, input.signal);
    if (before !== undefined) return { status: "refused", failure: before };
    // Spent before the value is read: two redeemers never both get it.
    this.#handles.delete(input.handle);
    const value = await this.#currentValue(secret, input.signal);
    if (typeof value !== "string") return { status: "refused", failure: value.failure };
    // Everything that admitted the use may have ended while the item was read.
    this.sweep();
    const current = this.#active.get(secret.id);
    if (current === undefined) return { status: "refused", failure: "revoked" };
    if (this.#consumers.get(input.consumerId) !== consumer)
      return { status: "refused", failure: "unavailable" };
    const after = this.#refusesUse(caller, current, input.signal);
    if (after !== undefined) return { status: "refused", failure: after };
    const done = this.#use(caller, [{ secret: current, value }], "handle");
    return done === undefined
      ? { status: "refused", failure: "unavailable" }
      : { status: "redeemed", label: secret.label, value, done };
  }

  /** Why the thread's commands may not be given these secrets now, before anyone is asked. */
  refusesLoan(
    caller: ThreadSecretCaller,
    names: ReadonlyArray<string>,
    signal: AbortSignal,
  ): ThreadSecretFailure | undefined {
    this.sweep();
    for (const name of names) {
      const found = this.#lendable(caller, name, signal);
      if (typeof found === "string") return found;
    }
    return undefined;
  }

  /**
   * Gives one command its secrets, as variables. Only a secret the person
   * granted to commands is lent: one granted as a handle stays a handle.
   */
  async lend(input: {
    readonly caller: ThreadSecretCaller;
    readonly names: ReadonlyArray<string>;
    readonly signal: AbortSignal;
  }): Promise<ThreadSecretLoan> {
    const { caller } = input;
    this.sweep();
    const claimed: string[] = [];
    const leases: Lease[] = [];
    let endUse: (() => void) | undefined;
    const done = () => {
      for (const id of claimed.splice(0)) this.#claimed.delete(id);
      for (const lease of leases.splice(0)) this.#endLease(lease);
      endUse?.();
    };
    const refuse = (failure: ThreadSecretFailure): ThreadSecretLoan => {
      done();
      return { status: "refused", failure };
    };
    const wanted: ActiveSecret[] = [];
    for (const name of input.names) {
      const found = this.#lendable(caller, name, input.signal);
      if (typeof found === "string") return refuse(found);
      // One command's secret goes to one command, however many are prepared at once.
      if (found.lifetime === "this-command") {
        this.#claimed.add(found.id);
        claimed.push(found.id);
      }
      wanted.push(found);
    }
    const uses: Use[] = [];
    for (const secret of wanted) {
      const value = await this.#currentValue(secret, input.signal);
      if (typeof value !== "string") return refuse(value.failure);
      uses.push({ secret, value });
    }
    this.sweep();
    for (const { secret } of uses) {
      const refused = this.#refusesLent(caller, secret, input.signal);
      if (refused !== undefined) return refuse(refused);
    }
    try {
      for (const { value } of uses) {
        const lease: Lease = {
          threadId: caller.threadId,
          turnId: caller.turnId,
          release: this.#options.hold(value),
        };
        leases.push(lease);
        this.#leases.add(lease);
      }
    } catch {
      return refuse("unavailable");
    }
    let started = false;
    return {
      status: "lent",
      environment: Object.fromEntries(
        uses.map(({ secret, value }) => [secret.environmentName, value]),
      ),
      start: () => {
        if (started || leases.length === 0) return false;
        this.sweep();
        const current: Use[] = [];
        for (const { secret, value } of uses) {
          const now = this.#active.get(secret.id);
          if (now === undefined || this.#refusesLent(caller, now, input.signal) !== undefined)
            return false;
          current.push({ secret: now, value });
        }
        endUse = this.#use(caller, current, "command");
        started = endUse !== undefined;
        return started;
      },
      done,
    };
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
    this.#endLeases((lease) => lease.threadId === threadId && lease.turnId === turnId);
  }

  /** The thread was archived or deleted. */
  withdrawThread(threadId: string): void {
    for (const pending of this.#pending.values())
      if (pending.caller.threadId === threadId) this.#cancel(pending);
    this.#end(
      [...this.#active.values()].filter((secret) => secret.threadId === threadId),
      "thread-archived",
    );
    this.#endLeases((lease) => lease.threadId === threadId);
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
    this.#endLeases(() => true);
    for (const release of this.#ended.splice(0)) this.#attempt(release);
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
    this.#clearEarlierFiles();
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
      lastLifetime: this.#lastLifetimes.get(
        lifetimeKey(input.kind, names[0]?.secretName ?? input.name),
      ),
    });
    if (offer.status !== "offered") return Promise.resolve(refusal(offer.status));
    const waiting = [...this.#pending.values()];
    if (
      waiting.length >= MAX_PENDING_REQUESTS ||
      waiting.filter((pending) => pending.caller.threadId === caller.threadId).length >=
        MAX_PENDING_PER_THREAD
    )
      return Promise.resolve(refusal("unavailable"));
    const remembers = this.#options.remembered !== undefined;
    // An account's own password is never one Octant keeps, so never one it offers.
    const remembered =
      input.kind === "account-password"
        ? []
        : (this.#options.remembered?.list(names.map(({ secretName }) => secretName)) ?? []).slice(
            -MAX_REMEMBERED_SHOWN,
          );
    const id = this.#options.uuid();
    const card: ThreadSecretRequestCard = {
      id,
      threadId: caller.threadId,
      name: input.name,
      label: input.label,
      kind: input.kind,
      reason: input.reason,
      // As the browser will open it: a look-alike host shows in its encoded form.
      ...(input.url === undefined ? {} : { url: new URL(input.url).href }),
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
              // The agent does not decide that a computer's password is shown.
              secret: input.kind === "account-password" || (field.secret ?? true),
            })),
      lifetimes: remembers
        ? offer.lifetimes
        : offer.lifetimes.filter((lifetime) => lifetime !== "remember"),
      defaultLifetime:
        offer.defaultLifetime === "remember" && !remembers ? "24-hours" : offer.defaultLifetime,
      sources: [
        "pasted",
        ...(this.#options.readReference === undefined ? [] : ["onepassword" as const]),
        ...(remembered.length === 0 ? [] : ["remembered" as const]),
      ],
      remembered,
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
        // One command's secret is spent on that command, and one turn's on that turn.
        secret.lifetime === "this-command" ||
        (secret.lifetime === "this-turn" && secret.turnId !== caller.turnId) ||
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
      const read = await this.#answeredField(pending, entry, from);
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
    if (answer.lifetime !== "remember")
      return this.#grant(pending, answered, answer.lifetime, authority, authority.mode);
    const kept = await this.#remember(pending, answered);
    if (kept === undefined) return "unavailable";
    // Kept while the thread, window or Strict could change; granted only if they did not.
    const still = this.#authority(caller);
    const decision =
      still === undefined
        ? undefined
        : decideThreadSecretLifetime({ ...still, kind: input.kind }, answer.lifetime);
    if (
      this.#pending.get(card.id) !== pending ||
      still === undefined ||
      still.mode === "chat" ||
      decision?.status !== "allowed"
    ) {
      await this.#forgetAll(kept);
      return decision?.status === "refused" ? decision.failure : "unavailable";
    }
    const result = this.#grant(pending, answered, answer.lifetime, still, still.mode);
    if (typeof result === "string") await this.#forgetAll(kept);
    else
      for (const [secretName, id] of kept)
        await this.#options.remembered?.forgetOthers(secretName, id);
    return result;
  }

  /** Every field kept, by name, or none. One that came from memory is there already. */
  async #remember(
    pending: PendingRequest,
    answered: ReadonlyMap<string, AnsweredField>,
  ): Promise<ReadonlyMap<string, string> | undefined> {
    const { remembered } = this.#options;
    if (remembered === undefined) return undefined;
    const kept = new Map<string, string>();
    for (const { field, secretName } of deliveriesOf(pending.input)) {
      const value = answered.get(field);
      if (value === undefined || value.source === "remembered") continue;
      const id = await remembered.remember(
        secretName,
        value.reference === undefined
          ? { kind: "value", value: value.value }
          : { kind: "reference", reference: value.reference },
      );
      if (id === undefined) {
        await this.#forgetAll(kept);
        return undefined;
      }
      kept.set(secretName, id);
    }
    return kept;
  }

  async #forgetAll(kept: ReadonlyMap<string, string>): Promise<void> {
    for (const id of kept.values()) await this.#options.remembered?.forget(id);
  }

  async #answeredField(
    pending: PendingRequest,
    entry: ThreadSecretAnswerField,
    from: { readonly paired: boolean },
  ): Promise<AnsweredField | { readonly failure: ThreadSecretFailure }> {
    switch (entry.source) {
      case "pasted":
        // Blank is no answer; anything else is kept exactly as typed.
        return entry.value.trim() === ""
          ? { failure: "missing" }
          : { value: entry.value, source: "pasted", reference: undefined, eachUse: false };
      case "onepassword": {
        // The store belongs to the person at this computer.
        if (from.paired) return { failure: "not-linked" };
        const reference = { store: entry.store, reference: entry.reference };
        const read = await this.#read(reference, pending.lookup.signal);
        return typeof read === "string"
          ? { value: read, source: "onepassword", reference, eachUse: entry.freshEachUse }
          : read;
      }
      case "remembered": {
        // Only one this card offered: for this name, and never an account's password.
        const secretName = deliveriesOf(pending.input).find(
          ({ field }) => field === entry.name,
        )?.secretName;
        const { remembered } = this.#options;
        if (
          remembered === undefined ||
          secretName === undefined ||
          !pending.card.remembered.some(({ id }) => id === entry.rememberedId)
        )
          return { failure: "missing" };
        const found = await remembered.resolve(entry.rememberedId, secretName);
        if (found === undefined) return { failure: "missing" };
        if (found.kind === "value")
          return { value: found.value, source: "remembered", reference: undefined, eachUse: false };
        if (from.paired) return { failure: "not-linked" };
        const read = await this.#read(found.reference, pending.lookup.signal);
        return typeof read === "string"
          ? { value: read, source: "remembered", reference: found.reference, eachUse: false }
          : read;
      }
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
      // A file is a copy. One field read at each use keeps the request from having any.
      freshEachUse: [...answered.values()].some((field) => field.eachUse),
    });
    const files =
      wanted === "file-and-environment" && this.#swept ? this.#options.files : undefined;
    const delivery =
      wanted === "file-and-environment" && files === undefined ? "environment" : wanted;
    const prepared: PreparedThreadSecretFile[] = [];
    const secrets: ActiveSecret[] = [];
    const undo = () => {
      for (const file of [...prepared].reverse()) this.#attempt(() => file.discard());
      for (const secret of secrets) this.#attempt(() => secret.release?.());
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
        // "Shown as typed" is the agent's word. It spares an email address the
        // person typed and saw; it never spares an account's own password, or
        // a stored value nobody looked at.
        const plain = !shown.secret && value.source === "pasted" && input.kind === "token";
        // Nothing of an item read at each use is kept, so nothing is there to print.
        const release = plain || value.eachUse ? undefined : this.#options.hold(value.value);
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
          value: value.eachUse ? undefined : value.value,
          path: undefined,
          endsAt: endOf(lifetime, this.#options.now()),
          release,
          releaseRotated: undefined,
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
      this.#options.journal.record(
        caller.threadId,
        secrets.map(
          (secret): ThreadSecretJournalRecord => ({
            name: "thread-secret.granted",
            ...journaled(secret),
            source: secret.source,
            lifetime: secret.lifetime,
            delivery: secret.delivery,
          }),
        ),
      );
    } catch {
      undo();
      return "unavailable";
    }
    try {
      for (const file of prepared) file.commit();
    } catch {
      // The earlier secret of this name, if any, is untouched and still the one in use.
      undo();
      this.#recordEnd(secrets, "delivery-failed");
      return "unavailable";
    }
    for (const secret of replaced)
      this.#forget(
        secret,
        secrets.some((next) => next.path !== undefined && next.path === secret.path),
      );
    for (const file of prepared) this.#attempt(() => file.settle());
    this.#recordEnd(replaced, "replaced");
    for (const secret of secrets) {
      this.#active.set(secret.id, secret);
      this.#lastLifetimes.set(lifetimeKey(secret.kind, secret.secretName), lifetime);
      // Its name is in use again: an earlier file's owed removal would take this one.
      if (secret.path !== undefined)
        this.#leftover.delete(`${secret.threadId}/${secret.secretName}`);
    }
    try {
      return this.#savedResult(input, secrets, delivery);
    } catch {
      // The agent was told of nothing, so nothing of it stays.
      for (const secret of secrets) {
        this.#forget(secret, false, "never-used");
        this.#attempt(() => secret.release?.());
      }
      this.#recordEnd(secrets, "delivery-failed");
      return "unavailable";
    } finally {
      this.#changed();
    }
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
      case "each-use":
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
  #end(secrets: ReadonlyArray<ActiveSecret>, cause: EndCause): void {
    if (secrets.length === 0) return;
    for (const secret of secrets) this.#forget(secret, false);
    this.#recordEnd(secrets, cause);
    this.#changed();
  }

  /** A refused record leaves the grant open, and the next start ends it there. */
  #recordEnd(secrets: ReadonlyArray<ActiveSecret>, cause: EndCause): void {
    for (const secret of secrets)
      this.#attempt(() =>
        this.#options.journal.record(secret.threadId, [
          cause === "expired"
            ? { name: "thread-secret.expired", ...journaled(secret) }
            : { name: "thread-secret.revoked", ...journaled(secret), cause },
        ]),
      );
  }

  #forget(secret: ActiveSecret, fileReplaced: boolean, use?: "never-used"): void {
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
    if (use === "never-used") return;
    for (const release of [secret.release, secret.releaseRotated])
      if (release !== undefined) this.#ended.push(release);
    for (const release of this.#ended.splice(0, this.#ended.length - MAX_ENDED_VALUES))
      this.#attempt(release);
  }

  #endLease(lease: Lease): void {
    if (this.#leases.delete(lease)) this.#attempt(lease.release);
  }

  #endLeases(which: (lease: Lease) => boolean): void {
    for (const lease of this.#leases) if (which(lease)) this.#endLease(lease);
  }

  #clearEarlierFiles(): void {
    this.#swept ||= this.#attempt(() => this.#options.files?.sweep());
  }

  /** Why this thread may not use a secret it holds, read as it uses it. */
  #refusesUse(
    caller: ThreadSecretCaller,
    secret: ActiveSecret,
    signal: AbortSignal,
  ): ThreadSecretFailure | undefined {
    if (signal.aborted || caller.signal.aborted) return "unavailable";
    if (secret.lifetime === "this-turn" && secret.turnId !== caller.turnId) return "expired";
    const authority = this.#authority(caller);
    if (authority === undefined) return "unavailable";
    const decision = decideThreadSecretLifetime(
      { ...authority, kind: secret.kind },
      secret.lifetime,
    );
    return decision.status === "refused" ? decision.failure : undefined;
  }

  /** An active secret this thread's commands may be given, or why not. */
  #lendable(
    caller: ThreadSecretCaller,
    name: string,
    signal: AbortSignal,
  ): ActiveSecret | ThreadSecretFailure {
    const secret = this.#named(caller.threadId, name);
    if (secret === undefined) return "expired";
    if (secret.delivery === "handle" || this.#claimed.has(secret.id)) return "unavailable";
    return this.#refusesUse(caller, secret, signal) ?? secret;
  }

  /** Why a secret already being lent may not be, read again; its own claim is no reason. */
  #refusesLent(
    caller: ThreadSecretCaller,
    secret: ActiveSecret,
    signal: AbortSignal,
  ): ThreadSecretFailure | undefined {
    return this.#active.has(secret.id) ? this.#refusesUse(caller, secret, signal) : "revoked";
  }

  /** What a secret's value is now: its item's, read again, or the one that was typed. */
  #currentValue(
    secret: ActiveSecret,
    signal: AbortSignal,
  ): Promise<string | { readonly failure: ThreadSecretFailure }> {
    return secret.reference === undefined
      ? Promise.resolve(secret.value ?? { failure: "unavailable" })
      : this.#read(secret.reference, signal);
  }

  /**
   * Records a use and starts redacting what it hands over; undefined, with
   * nothing handed over, when either cannot be done. Returns what ends it.
   */
  #use(
    caller: ThreadSecretCaller,
    uses: ReadonlyArray<Use>,
    use: "handle" | "command",
  ): (() => void) | undefined {
    const leases: Lease[] = [];
    const renewed = new Map<string, () => void>();
    try {
      for (const { secret, value } of uses) {
        leases.push({
          threadId: secret.threadId,
          turnId: caller.turnId,
          release: this.#options.hold(value),
        });
        if (value !== secret.value) renewed.set(secret.id, this.#options.hold(value));
      }
      this.#options.journal.record(
        caller.threadId,
        uses.map(({ secret }) => ({ name: "thread-secret.used", ...journaled(secret), use })),
      );
    } catch {
      for (const lease of leases) this.#attempt(lease.release);
      for (const release of renewed.values()) this.#attempt(release);
      return undefined;
    }
    const spent: ActiveSecret[] = [];
    for (const { secret, value } of uses) {
      const releaseRotated = renewed.get(secret.id);
      let held = secret;
      if (releaseRotated !== undefined) {
        // An item read at each use is redacted and otherwise kept nowhere.
        held = {
          ...secret,
          value: secret.value === undefined ? undefined : value,
          releaseRotated,
        };
        // The value before this one is the store's old one; only the granted
        // value, which the agent may have been told of, stays held beside it.
        this.#attempt(() => secret.releaseRotated?.());
        this.#active.set(secret.id, held);
      }
      if (held.lifetime === "this-command") spent.push(held);
    }
    for (const lease of leases) this.#leases.add(lease);
    this.#end(spent, "command-ended");
    return () => {
      for (const lease of leases) this.#endLease(lease);
    };
  }

  /** The first answer again, while it still says something true. */
  async #replay(earlier: RetriedAnswer, asked: string): Promise<ThreadSecretRequestResult> {
    if (earlier.asked !== asked)
      return {
        status: "refused",
        failure: "unavailable",
        note: "That clientRequestId was used for another request. Use a new one.",
      };
    const result = await earlier.answer;
    if (result.status !== "saved") return result;
    return earlier.secretIds?.every((id) => this.#active.has(id)) === true
      ? result
      : refusal("expired");
  }

  /** Makes room for one retry key. A key still waiting for its answer is never dropped. */
  #dropOldAnswers(answers: Map<string, RetriedAnswer>): void {
    const dropSettled = (kept: Map<string, RetriedAnswer>): void => {
      for (const [key, answer] of kept) {
        if (!answer.settled) continue;
        kept.delete(key);
        return;
      }
    };
    if (answers.size >= MAX_RETRY_KEYS_PER_THREAD) dropSettled(answers);
    if (this.#answers.size <= MAX_RETRY_THREADS) return;
    for (const [threadId, kept] of this.#answers) {
      if ([...kept.values()].some((answer) => !answer.settled)) continue;
      if (kept === answers) continue;
      this.#answers.delete(threadId);
      return;
    }
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
