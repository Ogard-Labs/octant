import {
  decodeMentionableThreadId,
  decodeProjectId,
  decodeUtcTimestamp,
  type OctantMode,
  type ProviderInstanceId,
  type ProviderModelId,
  type TurnUsage,
} from "@octant/contracts";
import {
  PERSON_MEMORY_ENTRY_MAX_CHARACTERS,
  PERSON_MEMORY_SUMMARY_MAX_CHARACTERS,
  PERSON_MEMORY_TITLE_MAX_CHARACTERS,
  type PersonMemoryModelChoice,
  type PersonMemorySource,
} from "@octant/contracts/person-memory";
import {
  parsePersonMemoryDistillation,
  PERSON_MEMORY_DISTILL_INSTRUCTIONS,
  personMemoryDistillationAllowed,
  personMemoryDistillPrompt,
} from "@octant/domain/person-memory-policy";
import { redactPrivateKeys, redactSecretShaped } from "@octant/domain/secret-shaped-text-policy";
import type { PersonMemoryStore } from "./personMemoryStore";

/** Once an hour is often enough to learn from threads a person put away. */
export const PERSON_MEMORY_SWEEP_INTERVAL_MS = 60 * 60 * 1_000;
/**
 * The first pass waits a few minutes after start, so a host that starts and
 * stops at once (an update, a test) never spends a model call on the way.
 */
export const PERSON_MEMORY_FIRST_SWEEP_DELAY_MS = 5 * 60 * 1_000;
/** Model calls one pass may make, so a busy day never turns into a burst of calls. */
export const PERSON_MEMORY_MAX_DISTILLATIONS_PER_PASS = 10;
/**
 * Threads one pass may read in full, whether the read ends in a call or is
 * settled without one (nothing new to record, or a model that is not allowed),
 * so a long list of them still ends the pass.
 */
export const PERSON_MEMORY_MAX_THREAD_READS_PER_PASS = 50;
/** A thread still open is learned from only after the person has been quiet this long. */
export const PERSON_MEMORY_OPEN_THREAD_IDLE_MS = 30 * 60 * 1_000;
/** A thread still open is learned from at most once in this long. */
export const PERSON_MEMORY_OPEN_THREAD_INTERVAL_MS = 6 * 60 * 60 * 1_000;
/**
 * A thread whose model was refused (an account that is off, a Project's rule,
 * a spend ceiling) is read again after this long even if nothing visible has
 * changed, which is how a lifted rule or ceiling is noticed: one pass later.
 */
export const PERSON_MEMORY_REFUSED_RETRY_MS = PERSON_MEMORY_SWEEP_INTERVAL_MS;
const DISTILL_TIMEOUT_MS = 60_000;

/** One message the person wrote in a thread. */
export interface PersonMessage {
  /** The turn the message started, which is the id learning stops at. */
  readonly id: string;
  /** When the turn began. */
  readonly at: string;
  readonly text: string;
  /** The host marked it typed by the person; one older than the marks is not. */
  readonly typed: boolean;
}

/** One mode's threads, finished and open, as the sweep needs to see them. */
export interface PersonMemoryThreadSource {
  readonly mode: OctantMode;
  readonly threads: () => ReadonlyArray<{
    readonly id: string;
    readonly completedAt?: string | undefined;
  }>;
  /**
   * What is cheap to know about a thread without reading it: asked first, so a
   * thread with nothing to learn is never read. `undefined` when it is gone.
   */
  readonly peek: (threadId: string) => PersonMemoryThreadActivity | undefined;
  /**
   * The one thread's facts as they are now, without listing the mode again;
   * `undefined` when it is gone. Read right before a distillation is stored,
   * since a pass can run long after it listed the threads.
   */
  readonly current?: (threadId: string) =>
    | {
        readonly title: string;
        readonly projectId?: string | undefined;
        readonly providerInstanceId: ProviderInstanceId;
      }
    | undefined;
  /** The thread's facts and what the person wrote in it, oldest first; `undefined` when gone. */
  readonly read: (threadId: string) =>
    | {
        readonly title: string;
        readonly projectId?: string | undefined;
        readonly providerInstanceId: ProviderInstanceId;
        readonly modelId: ProviderModelId;
        /** Only the messages that count as the person's own words (see the store). */
        readonly personMessages: ReadonlyArray<PersonMessage>;
      }
    | undefined;
}

/** A thread's cheap facts, from its journal and projections alone. */
export interface PersonMemoryThreadActivity {
  /** When the person last wrote to the thread, a message that counts or not. */
  readonly lastMessageAt?: string | undefined;
  /**
   * The thread's newest event of any kind, which includes when its last turn
   * ended. A thread is quiet from here, not from when the last message began.
   */
  readonly lastActivityAt?: string | undefined;
  /** A turn is running or waiting in the thread. */
  readonly running: boolean;
}

export type PersonMemoryModelAnswer =
  | { readonly status: "answered"; readonly text: string; readonly usage?: TurnUsage }
  /** The call ran and spent, but its reply cannot be used (it read outside content). */
  | { readonly status: "withheld"; readonly usage?: TurnUsage }
  | { readonly status: "unavailable" };

/**
 * The one door to the distillation model call. Kept a port so a test runs it
 * with a fake and so `personMemoryDistillationAllowed` is asked in one place.
 */
export interface PersonMemoryModelPort {
  /** The model for a thread on this provider: Settings' choice, else that provider's smallest. */
  readonly resolve: (input: {
    readonly chosen: PersonMemoryModelChoice | undefined;
    readonly thread: {
      readonly providerInstanceId: ProviderInstanceId;
      readonly modelId: ProviderModelId;
    };
  }) => { readonly model: PersonMemoryModelChoice; readonly driverKind: string } | undefined;
  /**
   * Whether the thread's Project lets this model see its conversation: the rule
   * a turn passes before it sends. Absent, every model is allowed.
   */
  readonly projectAllows?: (input: {
    readonly projectId: string | undefined;
    readonly model: PersonMemoryModelChoice;
  }) => boolean;
  /**
   * Asks the thread's and its Project's spend ceilings for the call before it
   * is made, as a Shield review does. A refusal makes no call and the thread
   * waits for a later pass. Absent, no ceiling is asked.
   */
  readonly admit?: (input: {
    readonly mode: OctantMode;
    readonly threadId: string;
    readonly projectId: string | undefined;
    readonly model: PersonMemoryModelChoice;
    /**
     * The most what the call sends can come to, in tokens: one for every byte,
     * which no tokenizer exceeds. What the model may write back is the port's
     * to add, since only it knows the model and the call cannot be capped.
     */
    readonly inputUpperBoundTokens: number;
  }) => PersonMemorySpend;
  readonly complete: (input: {
    readonly model: PersonMemoryModelChoice;
    readonly instructions: string;
    readonly prompt: string;
    readonly timeoutMs: number;
  }) => Promise<PersonMemoryModelAnswer>;
  readonly recordUsage: (input: {
    readonly threadId: string;
    readonly model: PersonMemoryModelChoice;
    readonly usage?: TurnUsage | undefined;
  }) => void;
}

export type PersonMemorySpend =
  | { readonly status: "admitted"; readonly settle: (usage?: TurnUsage) => void }
  | { readonly status: "refused" };

export interface PersonMemorySweepOptions {
  readonly store: PersonMemoryStore;
  readonly sources: ReadonlyArray<PersonMemoryThreadSource>;
  readonly model: PersonMemoryModelPort;
  /** Whether text names a path the secret guard protects; such an entry is not kept. */
  readonly namesProtectedPath: (text: string) => boolean;
  readonly intervalMs?: number;
  /** The time now as an ISO string; a test sets it. */
  readonly clock?: () => string;
}

export type PersonMemoryDistillOutcome =
  | "remembered"
  | "nothing-written"
  | "unavailable"
  | "not-allowed"
  | "skipped";

/**
 * What a read leaves behind: nothing, a mark that the thread had nothing to
 * learn (read again when it changes), or a mark that the model was refused
 * (read again when it changes, or after an hour, because a ceiling or a
 * Project's rule may lift).
 */
type Settle = "no" | "idle" | "refused";

/** Secret-shaped text and private-key blocks, replaced before a model sees them and before storage. */
export function redactForPersonMemory(text: string): string {
  // A key block goes first and whole: a label's value ends with its line, which
  // would take the block's opening marker and leave its body.
  return redactSecretShaped(redactPrivateKeys(text).replaceAll(LABELLED_CREDENTIAL, "[redacted]"));
}

/**
 * A credential given after its label (`password:`, `"token": …`, `DB_PASSWORD=`,
 * `the passphrase is`, `secret - `): the whole value goes, up to its closing
 * quote when it is quoted and else to the end of the line, so a value of several
 * words is not left in part (a value on the next line counts). The label may end
 * a longer name and be marked up or quoted. The shared secret shapes name only
 * some labels and take one word.
 */
const LABELLED_CREDENTIAL = new RegExp(
  [
    /(?:password|passwd|passphrase|pwd|secret|credential|api[_ -]?key|token)s?/,
    /["'`*_]{0,3}(?:[ \t]*[:=\uff1a][*_]{0,2}|[ \t]+(?:is|are)\b|[ \t]+[-\u2013\u2014](?=[ \t]))/,
    /[ \t]*(?:\n[ \t]*)?/,
    /(?:"(?:\\.|[^"\\\n])*(?:"|$)|'(?:\\.|[^'\\\n])*(?:'|$)|`(?:\\.|[^`\\\n])*(?:`|$)|[^\n]*)/,
  ]
    .map((part) => part.source)
    .join(""),
  "gim",
);

/**
 * Learns from threads in two ways. A thread the person put away is learned
 * from once after memory began, and again only from what they wrote after it.
 * A thread still open is learned from when no turn runs in it, the person has
 * been quiet for 30 minutes, they typed something since the last time, and the
 * last time was over 6 hours ago. Both draw on one budget per pass, finished
 * threads first. Passes never overlap and a failing thread is its own: the next
 * pass tries it again.
 */
export class PersonMemorySweep {
  readonly #options: PersonMemorySweepOptions;
  readonly #intervalMs: number;
  readonly #clock: () => string;
  /**
   * What an open thread looked like the last time it was read and had nothing
   * to learn, so the next pass does not read it again until it changes. Kept
   * in memory: a restart reads each thread once more.
   */
  readonly #settled = new Map<string, { readonly key: string; readonly retryAt?: number }>();
  /** Where each phase (finished threads, open threads) stopped, so the next pass starts there. */
  readonly #resume: [string | undefined, string | undefined] = [undefined, undefined];
  #calls = 0;
  #reads = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;

  constructor(options: PersonMemorySweepOptions) {
    this.#options = options;
    this.#intervalMs = Math.max(options.intervalMs ?? PERSON_MEMORY_SWEEP_INTERVAL_MS, 1_000);
    this.#clock = options.clock ?? (() => new Date().toISOString());
  }

  start(): void {
    if (this.#stopped || this.#timer !== undefined) return;
    this.#schedule(Math.min(PERSON_MEMORY_FIRST_SWEEP_DELAY_MS, this.#intervalMs));
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** One pass over every mode's threads. Exposed so a test can drive it. */
  async pass(): Promise<
    ReadonlyArray<{
      readonly mode: OctantMode;
      readonly threadId: string;
      readonly outcome: PersonMemoryDistillOutcome;
    }>
  > {
    const { store } = this.#options;
    const results: Array<{
      mode: OctantMode;
      threadId: string;
      outcome: PersonMemoryDistillOutcome;
    }> = [];
    if (!store.settings().enabled) return results;
    const since = store.since();
    const callsBefore = this.#calls;
    const readsBefore = this.#reads;
    // Each mode's threads are listed once: a source may rebuild its lookups on every call.
    const listed = this.#options.sources.map((source) => ({ source, threads: source.threads() }));
    const phases = [false, true].map((open) =>
      listed.flatMap(({ source, threads }) => threads.map((thread) => ({ source, thread, open }))),
    );
    // A thread that is gone takes its settled mark with it.
    const live = new Set(
      phases.flatMap((candidates) =>
        candidates.map(({ source, thread }) => threadKey(source.mode, thread.id)),
      ),
    );
    for (const key of this.#settled.keys()) if (!live.has(key)) this.#settled.delete(key);
    for (const [phase, candidates] of phases.entries()) {
      // Start where the last pass stopped, so threads behind a long run of
      // others are reached in turn.
      const resumeAt = candidates.findIndex(
        ({ source, thread }) => threadKey(source.mode, thread.id) === this.#resume[phase],
      );
      this.#resume[phase] = undefined;
      const ordered =
        resumeAt <= 0
          ? candidates
          : [...candidates.slice(resumeAt), ...candidates.slice(0, resumeAt)];
      for (const { source, thread, open } of ordered) {
        if (
          this.#stopped ||
          this.#calls - callsBefore >= PERSON_MEMORY_MAX_DISTILLATIONS_PER_PASS ||
          this.#reads - readsBefore >= PERSON_MEMORY_MAX_THREAD_READS_PER_PASS
        ) {
          if (!this.#stopped) this.#resume[phase] = threadKey(source.mode, thread.id);
          return results;
        }
        // A thread the person put away keeps its lifecycle and gains a
        // completion time; reopening it clears that time again.
        const finished = thread.completedAt !== undefined;
        if (finished === open) continue;
        if (thread.completedAt !== undefined && thread.completedAt < since) continue;
        if (!isMentionable(thread.id)) continue;
        const ref = { mode: source.mode, threadId: decodeMentionableThreadId(thread.id) };
        if (store.leavesNoTrace(ref)) continue;
        // A thread put away that was learned from at or after it ended has
        // nothing newer to read, unless its last message came after the one
        // learned from: a reply stored after the thread ended may have read it
        // before the person's last words. One reopened and put away again does.
        const learnedBefore = store.learnedThrough(ref);
        if (
          thread.completedAt !== undefined &&
          learnedBefore !== undefined &&
          learnedBefore.learnedAt >= thread.completedAt &&
          (source.peek(thread.id)?.lastMessageAt ?? "") <= learnedBefore.at
        ) {
          continue;
        }
        let settledKey: string;
        if (open) {
          // An open thread was learned from lately: not before the interval is over.
          if (
            learnedBefore !== undefined &&
            Date.parse(learnedBefore.learnedAt) + PERSON_MEMORY_OPEN_THREAD_INTERVAL_MS >
              Date.parse(this.#clock())
          ) {
            continue;
          }
          // Cheap facts first: most open threads have nothing to learn, most passes.
          const check = this.#openThreadCheck(source, thread.id, ref, learnedBefore, since);
          if (check.skip) continue;
          settledKey = check.key;
        } else {
          settledKey = this.#settledKey(
            `${thread.completedAt ?? ""}|${learnedBefore?.learnedAt ?? ""}|${since}`,
          );
        }
        if (this.#isSettled(threadKey(source.mode, thread.id), settledKey)) continue;
        let outcome: PersonMemoryDistillOutcome;
        let settle: Settle = "no";
        try {
          ({ outcome, settle } = await this.#distill(source, thread.id, thread.completedAt, since));
        } catch {
          outcome = "unavailable";
        }
        if (settle === "idle") {
          this.#settled.set(threadKey(source.mode, thread.id), { key: settledKey });
        } else if (settle === "refused") {
          this.#settled.set(threadKey(source.mode, thread.id), {
            key: settledKey,
            retryAt: Date.parse(this.#clock()) + PERSON_MEMORY_REFUSED_RETRY_MS,
          });
        }
        // An open thread that is not ready to be read, and a thread learned
        // from already with nothing newer, are no news: most are, most passes.
        if (!(outcome === "skipped" && (open || learnedBefore !== undefined))) {
          results.push({ mode: source.mode, threadId: thread.id, outcome });
        }
      }
    }
    return results;
  }

  /**
   * What a settled thread looked like: the facts that matter to it plus the
   * settings, so a change of the account, the chosen model or the Projects kept
   * out reads the thread again.
   */
  #settledKey(facts: string): string {
    return `${facts}|${JSON.stringify(this.#options.store.settings())}`;
  }

  /** Whether a thread was settled as it looks now, and its time-based retry is not due. */
  #isSettled(threadKeyValue: string, key: string): boolean {
    const settled = this.#settled.get(threadKeyValue);
    if (settled === undefined || settled.key !== key) return false;
    return settled.retryAt === undefined || Date.parse(this.#clock()) < settled.retryAt;
  }

  /**
   * Whether an open thread can be passed over from its cheap facts: a turn is
   * running, it was never typed in since memory began or since what was learned,
   * the person or its last turn was active lately, or it looks as it did when it
   * was last read and had nothing to learn.
   */
  #openThreadCheck(
    source: PersonMemoryThreadSource,
    threadId: string,
    ref: {
      readonly mode: OctantMode;
      readonly threadId: ReturnType<typeof decodeMentionableThreadId>;
    },
    learned: { readonly at: string } | undefined,
    since: string,
  ): { readonly skip: true } | { readonly skip: false; readonly key: string } {
    const { store } = this.#options;
    const activity = source.peek(threadId);
    if (activity === undefined || activity.running) return { skip: true };
    const last = activity.lastMessageAt;
    if (last === undefined || last < since || (learned !== undefined && last <= learned.at)) {
      return { skip: true };
    }
    const marks = store.typedTurnIds(ref).size;
    if (marks === 0 || this.#quietFor(activity) < PERSON_MEMORY_OPEN_THREAD_IDLE_MS) {
      return { skip: true };
    }
    return { skip: false, key: this.#settledKey(`${last}|${String(marks)}|${since}`) };
  }

  /** How long the thread has been still, from its last activity (a message or the end of a turn). */
  #quietFor(activity: PersonMemoryThreadActivity): number {
    const at = [activity.lastMessageAt, activity.lastActivityAt]
      .flatMap((value) => (value === undefined ? [] : [Date.parse(value)]))
      .filter((value) => !Number.isNaN(value));
    if (at.length === 0) return -Infinity;
    return Date.parse(this.#clock()) - Math.max(...at);
  }

  /**
   * Distills one thread with at most one model call, from the messages the
   * person wrote after what was learned before. `endedAt` is set for a thread
   * put away and absent for one still open.
   */
  async distill(
    source: PersonMemoryThreadSource,
    threadId: string,
    endedAt: string | undefined,
    since?: string,
  ): Promise<PersonMemoryDistillOutcome> {
    return (await this.#distill(source, threadId, endedAt, since)).outcome;
  }

  async #distill(
    source: PersonMemoryThreadSource,
    threadId: string,
    endedAt: string | undefined,
    since?: string,
  ): Promise<{ readonly outcome: PersonMemoryDistillOutcome; readonly settle: Settle }> {
    const { store, model } = this.#options;
    this.#reads += 1;
    const erasuresBefore = store.erasures({ mode: source.mode, threadId });
    const facts = source.read(threadId);
    if (facts === undefined) return { outcome: "skipped", settle: "no" };
    if (!store.threadTakesPart({ mode: source.mode, threadId, projectId: facts.projectId })) {
      return { outcome: "skipped", settle: "refused" };
    }
    const open = endedAt === undefined;
    const learned = store.learnedThrough({ mode: source.mode, threadId });
    // A thread still open is learned from only while it is quiet, and only
    // from what the person typed after memory began.
    if (open) {
      const activity = source.peek(threadId);
      if (activity === undefined || activity.running) return { outcome: "skipped", settle: "no" };
      if (this.#quietFor(activity) < PERSON_MEMORY_OPEN_THREAD_IDLE_MS) {
        return { outcome: "skipped", settle: "no" };
      }
    }
    // Nothing said before memory began, or before it was last let back in
    // (Allow memory, a Project let back, Forget everything), is read, whether
    // the thread is still open or was put away.
    const candidates = facts.personMessages
      .filter((message) => (learned === undefined ? true : message.at > learned.at))
      .filter((message) => since === undefined || message.at >= since)
      .filter((message) => !open || message.typed);
    const messages = candidates
      .map((message) => ({ ...message, text: redactForPersonMemory(message.text).trim() }))
      .filter((message) => message.text.length > 0);
    const last = candidates.at(-1);
    if (messages.length === 0 || last === undefined) {
      // Nothing new the person wrote. A thread never learned from is recorded
      // as put away without a call; one learned from before, or one still
      // open, has nothing to record.
      if (open || learned !== undefined || endedAt === undefined) {
        return { outcome: "skipped", settle: "idle" };
      }
      return store.remember({
        source: memorySourceOf(source.mode, threadId, facts, endedAt, this.#options),
        summary: "",
        entries: [],
      }) === "remembered"
        ? { outcome: "nothing-written", settle: "no" }
        : { outcome: "skipped", settle: "idle" };
    }
    const memorySource = memorySourceOf(
      source.mode,
      threadId,
      facts,
      endedAt ?? last.at,
      this.#options,
    );
    const resolved = model.resolve({
      chosen: store.settings().distillModel,
      thread: { providerInstanceId: facts.providerInstanceId, modelId: facts.modelId },
    });
    if (resolved === undefined) return { outcome: "unavailable", settle: "refused" };
    if (!personMemoryDistillationAllowed(resolved.driverKind)) {
      return { outcome: "not-allowed", settle: "refused" };
    }
    // The Project's provider rule and the spend ceilings, both settled before
    // anything is sent, as a turn and a Shield review settle theirs.
    if (model.projectAllows?.({ projectId: facts.projectId, model: resolved.model }) === false) {
      return { outcome: "not-allowed", settle: "refused" };
    }
    const prompt = personMemoryDistillPrompt({
      title: memorySource.title,
      personMessages: messages.map((message) => message.text),
      knownEntries: store.knownEntries(),
    });
    const spend = model.admit?.({
      mode: source.mode,
      threadId,
      projectId: facts.projectId,
      model: resolved.model,
      inputUpperBoundTokens:
        Buffer.byteLength(PERSON_MEMORY_DISTILL_INSTRUCTIONS) + Buffer.byteLength(prompt),
    }) ?? { status: "admitted" as const, settle: () => undefined };
    if (spend.status === "refused") return { outcome: "not-allowed", settle: "refused" };
    this.#calls += 1;
    let answer: PersonMemoryModelAnswer;
    try {
      answer = await model.complete({
        model: resolved.model,
        instructions: PERSON_MEMORY_DISTILL_INSTRUCTIONS,
        prompt,
        timeoutMs: DISTILL_TIMEOUT_MS,
      });
    } catch (error) {
      spend.settle();
      throw error;
    }
    try {
      if (answer.status !== "unavailable") {
        model.recordUsage({ threadId, model: resolved.model, usage: answer.usage });
      }
    } finally {
      spend.settle(answer.status === "unavailable" ? undefined : answer.usage);
    }
    if (answer.status !== "answered") return { outcome: "unavailable", settle: "no" };
    // The thread may have moved into a Project kept out, been set to leave no
    // trace, or been deleted while the call ran; what it learned is stored
    // under the thread as it is now, or not at all.
    const now = source.current?.(threadId);
    if (source.current !== undefined && now === undefined)
      return { outcome: "skipped", settle: "no" };
    const storing = now === undefined ? facts : { ...facts, ...now };
    if (!store.threadTakesPart({ mode: source.mode, threadId, projectId: storing.projectId })) {
      return { outcome: "skipped", settle: "no" };
    }
    const distilled = parsePersonMemoryDistillation(answer.text);
    // An unreadable reply still spent its one call; the messages are marked
    // learned with no entries rather than asked about again on every pass.
    const summary =
      distilled.status === "parsed"
        ? keepable(
            distilled.summary,
            PERSON_MEMORY_SUMMARY_MAX_CHARACTERS,
            this.#options.namesProtectedPath,
          )
        : "";
    const entries =
      distilled.status === "parsed"
        ? distilled.entries.flatMap((entry) => {
            const content = keepable(
              entry.content,
              PERSON_MEMORY_ENTRY_MAX_CHARACTERS,
              this.#options.namesProtectedPath,
            );
            return content.length === 0 ? [] : [{ kind: entry.kind, content }];
          })
        : [];
    return {
      outcome:
        store.remember({
          source: memorySourceOf(source.mode, threadId, storing, endedAt ?? last.at, this.#options),
          summary,
          entries,
          lastMessage: { id: last.id, at: decodeUtcTimestamp(last.at) },
          erasuresBefore,
        }) === "remembered"
          ? "remembered"
          : "skipped",
      settle: "no",
    };
  }

  #schedule(delayMs: number): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.pass()
        .then(
          () => undefined,
          () => undefined,
        )
        .finally(() => this.#schedule(this.#intervalMs));
    }, delayMs);
  }
}

function memorySourceOf(
  mode: OctantMode,
  threadId: string,
  facts: {
    readonly title: string;
    readonly projectId?: string | undefined;
    readonly providerInstanceId: ProviderInstanceId;
  },
  endedAt: string,
  options: { readonly namesProtectedPath: (text: string) => boolean },
): PersonMemorySource {
  return {
    mode,
    threadId: decodeMentionableThreadId(threadId),
    title: keptTitle(facts.title, options.namesProtectedPath),
    ...(facts.projectId === undefined ? {} : { projectId: decodeProjectId(facts.projectId) }),
    providerInstanceId: facts.providerInstanceId,
    endedAt: decodeUtcTimestamp(endedAt),
  };
}

/** The title as memory keeps it: redacted, and not kept at all when it names a protected path. */
export function keptTitle(title: string, namesProtectedPath: (text: string) => boolean): string {
  return (
    keepable(title, PERSON_MEMORY_TITLE_MAX_CHARACTERS, namesProtectedPath) || "Untitled thread"
  );
}

/** Redacted text, or empty when it still names a protected path. */
function keepable(
  text: string,
  max: number,
  namesProtectedPath: (text: string) => boolean,
): string {
  const redacted = redactForPersonMemory(text).trim();
  return namesProtectedPath(redacted) ? "" : clip(redacted, max);
}

function threadKey(mode: OctantMode, threadId: string): string {
  return `${mode}:${threadId}`;
}

function isMentionable(threadId: string): boolean {
  try {
    decodeMentionableThreadId(threadId);
    return true;
  } catch {
    return false;
  }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
