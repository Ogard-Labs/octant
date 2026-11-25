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
import { redactSecretsAndPrivateKeys } from "@octant/domain/secret-shaped-text-policy";
import type { PersonMemoryStore } from "./personMemoryStore";

/** Once an hour is often enough to learn from threads a person put away. */
export const PERSON_MEMORY_SWEEP_INTERVAL_MS = 60 * 60 * 1_000;
/**
 * The first pass waits a few minutes after start, so a host that starts and
 * stops at once (an update, a test) never spends a model call on the way.
 */
export const PERSON_MEMORY_FIRST_SWEEP_DELAY_MS = 5 * 60 * 1_000;
/** Distillations one pass may start, so a busy day never turns into a burst of calls. */
export const PERSON_MEMORY_MAX_DISTILLATIONS_PER_PASS = 10;
/** A thread still open is learned from only after the person has been quiet this long. */
export const PERSON_MEMORY_OPEN_THREAD_IDLE_MS = 30 * 60 * 1_000;
/** A thread still open is learned from at most once in this long. */
export const PERSON_MEMORY_OPEN_THREAD_INTERVAL_MS = 6 * 60 * 60 * 1_000;
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
  /** The thread's facts and what the person wrote in it, oldest first; `undefined` when gone. */
  readonly read: (threadId: string) =>
    | {
        readonly title: string;
        readonly projectId?: string | undefined;
        readonly providerInstanceId: ProviderInstanceId;
        readonly modelId: ProviderModelId;
        /** Only the messages that count as the person's own words (see the store). */
        readonly personMessages: ReadonlyArray<PersonMessage>;
        /** When the person last wrote to the thread, a message that counts or not. */
        readonly lastMessageAt?: string | undefined;
        /** A turn is running or waiting in the thread. */
        readonly running: boolean;
      }
    | undefined;
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

/** Secret-shaped text and private-key blocks, replaced before a model sees them and before storage. */
export function redactForPersonMemory(text: string): string {
  return redactSecretsAndPrivateKeys(text);
}

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
    let started = 0;
    for (const open of [false, true]) {
      for (const source of this.#options.sources) {
        for (const thread of source.threads()) {
          if (this.#stopped || started >= PERSON_MEMORY_MAX_DISTILLATIONS_PER_PASS) return results;
          // A thread the person put away keeps its lifecycle and gains a
          // completion time; reopening it clears that time again.
          const finished = thread.completedAt !== undefined;
          if (finished === open) continue;
          if (thread.completedAt !== undefined && thread.completedAt < since) continue;
          if (!isMentionable(thread.id)) continue;
          const ref = { mode: source.mode, threadId: decodeMentionableThreadId(thread.id) };
          if (store.leavesNoTrace(ref)) continue;
          // A thread put away that was learned from at or after it ended has
          // nothing newer to read; one reopened and put away again does.
          const learnedBefore = store.learnedThrough(ref);
          if (
            thread.completedAt !== undefined &&
            learnedBefore !== undefined &&
            learnedBefore.learnedAt >= thread.completedAt
          ) {
            continue;
          }
          // An open thread was learned from lately: not before the interval is over.
          if (open) {
            const learned = store.learnedThrough(ref);
            if (
              learned !== undefined &&
              Date.parse(learned.learnedAt) + PERSON_MEMORY_OPEN_THREAD_INTERVAL_MS >
                Date.parse(this.#clock())
            ) {
              continue;
            }
          }
          let outcome: PersonMemoryDistillOutcome;
          try {
            outcome = await this.distill(source, thread.id, thread.completedAt, since);
          } catch {
            outcome = "unavailable";
          }
          // Only an attempt spends the pass's budget: a thread skipped before
          // any call (a Project kept out, nothing new to learn) is never
          // counted, or the same skipped threads would use up every pass.
          if (outcome !== "skipped") started += 1;
          // An open thread that is not ready to be read, and a thread learned
          // from already with nothing newer, are no news: most are, most passes.
          if (!(outcome === "skipped" && (open || learnedBefore !== undefined))) {
            results.push({ mode: source.mode, threadId: thread.id, outcome });
          }
        }
      }
    }
    return results;
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
    const { store, model } = this.#options;
    const facts = source.read(threadId);
    if (facts === undefined) return "skipped";
    if (!store.threadTakesPart({ mode: source.mode, threadId, projectId: facts.projectId })) {
      return "skipped";
    }
    const open = endedAt === undefined;
    const learned = store.learnedThrough({ mode: source.mode, threadId });
    // A thread still open is learned from only while it is quiet, and only
    // from what the person typed after memory began.
    if (open) {
      if (facts.running) return "skipped";
      const quietSince = facts.lastMessageAt === undefined ? NaN : Date.parse(facts.lastMessageAt);
      if (
        Number.isNaN(quietSince) ||
        quietSince + PERSON_MEMORY_OPEN_THREAD_IDLE_MS > Date.parse(this.#clock())
      ) {
        return "skipped";
      }
    }
    const candidates = facts.personMessages
      .filter((message) => (learned === undefined ? true : message.at > learned.at))
      .filter(
        (message) => !open || (message.typed && (since === undefined || message.at >= since)),
      );
    const messages = candidates
      .map((message) => ({ ...message, text: redactForPersonMemory(message.text).trim() }))
      .filter((message) => message.text.length > 0);
    const last = candidates.at(-1);
    if (messages.length === 0 || last === undefined) {
      // Nothing new the person wrote. A thread never learned from is recorded
      // as put away without a call; one learned from before, or one still
      // open, has nothing to record.
      if (open || learned !== undefined || endedAt === undefined) return "skipped";
      return store.remember({
        source: memorySourceOf(source.mode, threadId, facts, endedAt, this.#options),
        summary: "",
        entries: [],
      }) === "remembered"
        ? "nothing-written"
        : "skipped";
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
    if (resolved === undefined) return "unavailable";
    if (!personMemoryDistillationAllowed(resolved.driverKind)) return "not-allowed";
    const answer = await model.complete({
      model: resolved.model,
      instructions: PERSON_MEMORY_DISTILL_INSTRUCTIONS,
      prompt: personMemoryDistillPrompt({
        title: memorySource.title,
        personMessages: messages.map((message) => message.text),
        knownEntries: store.knownEntries(),
      }),
      timeoutMs: DISTILL_TIMEOUT_MS,
    });
    if (answer.status !== "unavailable") {
      model.recordUsage({ threadId, model: resolved.model, usage: answer.usage });
    }
    if (answer.status !== "answered") return "unavailable";
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
    return store.remember({
      source: memorySource,
      summary,
      entries,
      lastMessage: { id: last.id, at: decodeUtcTimestamp(last.at) },
    }) === "remembered"
      ? "remembered"
      : "skipped";
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
