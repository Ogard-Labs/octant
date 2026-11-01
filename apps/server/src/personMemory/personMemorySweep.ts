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
import { redactSecretShaped } from "../providers/providerApprovalCall";
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
const DISTILL_TIMEOUT_MS = 60_000;

/** One mode's ended threads, as the sweep needs to see them. */
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
        readonly personMessages: ReadonlyArray<string>;
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
}

export type PersonMemoryDistillOutcome =
  | "remembered"
  | "nothing-written"
  | "unavailable"
  | "not-allowed"
  | "skipped";

const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;

/** Secret-shaped text and private-key blocks, replaced before a model sees them and before storage. */
export function redactForPersonMemory(text: string): string {
  return redactSecretShaped(text.replaceAll(PRIVATE_KEY_BLOCK, "[redacted]"));
}

/**
 * Learns from threads the person put away: each completed thread, once, if it
 * ended after memory began and still takes part. Passes never overlap and a
 * failing thread is its own: the next pass tries it again.
 */
export class PersonMemorySweep {
  readonly #options: PersonMemorySweepOptions;
  readonly #intervalMs: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;

  constructor(options: PersonMemorySweepOptions) {
    this.#options = options;
    this.#intervalMs = Math.max(options.intervalMs ?? PERSON_MEMORY_SWEEP_INTERVAL_MS, 1_000);
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

  /** One pass over every mode's completed threads. Exposed so a test can drive it. */
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
    for (const source of this.#options.sources) {
      for (const thread of source.threads()) {
        if (this.#stopped || started >= PERSON_MEMORY_MAX_DISTILLATIONS_PER_PASS) return results;
        // A thread the person put away keeps its lifecycle and gains a
        // completion time; reopening it clears that time again.
        if (thread.completedAt === undefined) continue;
        if (thread.completedAt < since) continue;
        if (!isMentionable(thread.id)) continue;
        const ref = { mode: source.mode, threadId: decodeMentionableThreadId(thread.id) };
        if (store.isRemembered(ref) || store.leavesNoTrace(ref)) continue;
        let outcome: PersonMemoryDistillOutcome;
        try {
          outcome = await this.distill(source, thread.id, thread.completedAt);
        } catch {
          outcome = "unavailable";
        }
        // Only an attempt spends the pass's budget: a thread skipped before
        // any call (a Project kept out) is never remembered, and counting it
        // would let the same skipped threads use up every pass.
        if (outcome !== "skipped") started += 1;
        results.push({ mode: source.mode, threadId: thread.id, outcome });
      }
    }
    return results;
  }

  /** Distills one ended thread with at most one model call. */
  async distill(
    source: PersonMemoryThreadSource,
    threadId: string,
    endedAt: string,
  ): Promise<PersonMemoryDistillOutcome> {
    const { store, model } = this.#options;
    const facts = source.read(threadId);
    if (facts === undefined) return "skipped";
    if (!store.threadTakesPart({ mode: source.mode, threadId, projectId: facts.projectId })) {
      return "skipped";
    }
    const memorySource: PersonMemorySource = {
      mode: source.mode,
      threadId: decodeMentionableThreadId(threadId),
      title: keptTitle(facts.title, this.#options.namesProtectedPath),
      ...(facts.projectId === undefined ? {} : { projectId: decodeProjectId(facts.projectId) }),
      providerInstanceId: facts.providerInstanceId,
      endedAt: decodeUtcTimestamp(endedAt),
    };
    const messages = facts.personMessages
      .map((message) => redactForPersonMemory(message).trim())
      .filter((message) => message.length > 0);
    if (messages.length === 0) {
      // Nothing the person wrote: remembered as ended, without a call.
      store.remember({ source: memorySource, summary: "", entries: [] });
      return "nothing-written";
    }
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
        personMessages: messages,
        knownEntries: store.knownEntries(),
      }),
      timeoutMs: DISTILL_TIMEOUT_MS,
    });
    if (answer.status !== "unavailable") {
      model.recordUsage({ threadId, model: resolved.model, usage: answer.usage });
    }
    if (answer.status !== "answered") return "unavailable";
    const distilled = parsePersonMemoryDistillation(answer.text);
    // An unreadable reply still spent its one call; the thread is remembered
    // with no entries rather than asked about again on every pass.
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
    return store.remember({ source: memorySource, summary, entries }) === "remembered"
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

/** The title as memory keeps it: redacted, and not kept at all when it names a protected path. */
function keptTitle(title: string, namesProtectedPath: (text: string) => boolean): string {
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
