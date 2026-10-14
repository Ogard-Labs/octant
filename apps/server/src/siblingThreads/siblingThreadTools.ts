import {
  AggregateVersion,
  CorrelationId,
  EventActor,
  EventId,
  EventName,
  SIBLING_THREAD_EVENT_NAMES,
  SIBLING_THREAD_OBSERVATION_AGGREGATE,
  SIBLING_THREADS_TOOL_DEFINITION,
  SIBLING_THREADS_TOOL_NAME,
  UtcTimestamp,
  decodeCodeThreadId,
  decodeSiblingThreadObserved,
  decodeSiblingThreadsToolInput,
  decodeSiblingThreadsToolResult,
  type CodeThreadId,
  type ProjectId,
  type SiblingThreadRefuseReason,
  type SiblingThreadState,
  type SiblingThreadsToolInput,
  type SiblingThreadsToolResult,
  type ThreadMentionTranscriptEntry,
} from "@octant/contracts";
import {
  SIBLING_THREAD_UNREACHABLE,
  boundThreadMentionTranscript,
  decideProfileToolConstraint,
  decideSiblingThreadCall,
  decideSiblingThreadTarget,
  listSiblingThreads,
  parseSiblingThreadReference,
  siblingThreadActionIngestsContent,
  siblingThreadReference,
  siblingThreadWaitMs,
  type SiblingThreadCaller,
  type SiblingThreadFacts,
} from "@octant/domain";
import { Schema } from "effect";
import { frameExternalContentForModel } from "../context/externalContentFraming";
import type {
  ExternalContentIngestionResult,
  RecordExternalContentIngestionInput,
} from "../context/externalContentIngestionStore";
import { readAggregateVersion } from "../persistence/chatProjection";
import type { Journal } from "../persistence/journal";
import { ConcurrencyConflict } from "../persistence/journalErrors";
import type { SqliteConnection } from "../persistence/sqlitePort";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";

const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

const MAX_APPEND_ATTEMPTS = 3;
/** How often `wait` looks again; the child-run `wait` polls at the same pace. */
const WAIT_POLL_MS = 250;
/** `SiblingThreadTitle` and a transcript entry's text bounds in the contract. */
const MAX_TITLE_CHARACTERS = 400;
const MAX_ENTRY_CHARACTERS = 4_000;
/** The source label the reader's mark names; it says which channel, never which thread. */
const SOURCE_LABEL = "sibling-thread";

/**
 * One Code thread as the host holds it now. A child run, a deleted thread, and
 * a thread of another mode's directory never resolve here, so the policy never
 * sees them and their ids refuse like unknown ones.
 */
export interface SiblingThreadSnapshot extends SiblingThreadFacts {
  readonly title: string;
  readonly state: SiblingThreadState;
  readonly stateChangedAt: string;
}

/**
 * Where the host reads the facts the actions decide on, at the moment of each
 * call. `readTranscript` is the `#thread` mention read for the calling turn,
 * so `read` shows exactly what a mention of the same thread would; it answers
 * `undefined` wherever that read refuses.
 */
export interface SiblingThreadSource {
  thread(threadId: CodeThreadId): SiblingThreadSnapshot | undefined;
  projectThreads(projectId: ProjectId): ReadonlyArray<SiblingThreadSnapshot>;
  readTranscript(
    threadId: CodeThreadId,
  ): Promise<ReadonlyArray<ThreadMentionTranscriptEntry> | undefined>;
}

/**
 * What one call returns: the contract answer, and the text the provider reads.
 * A `listed` or `read` answer reaches the provider only inside the shared
 * external-data frame, because every title and transcript line in it is text
 * another person or agent wrote.
 */
export interface SiblingThreadOutcome {
  readonly answer: SiblingThreadsToolResult;
  readonly providerResult: unknown;
}

export interface SiblingThreadsServiceOptions {
  readonly journal: Pick<Journal, "append">;
  readonly connection: SqliteConnection;
  readonly uuid: () => string;
  readonly clock: () => string;
  readonly actor: unknown;
  readonly recordExternalContentIngestion: (
    input: RecordExternalContentIngestionInput,
  ) => ExternalContentIngestionResult;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const CALLER_REFUSAL = "This thread cannot see other threads.";
const CANCELLED = "The turn was cancelled.";
const UNMARKED =
  "The host could not record that this thread read outside content, so it returned nothing.";
const UNJOURNALED = "The host could not journal this call, so it returned nothing.";

/**
 * The host side of the sibling-threads tool: `list`, `read`, and `wait` over
 * the caller's own Project.
 *
 * Every call re-reads the caller and its targets from the host, so a thread
 * completed, archived, deleted, or moved since `list` refuses in the one
 * sentence every unreachable reference shares. Nothing here writes to a
 * target: the only appends are the reader's own outside-content mark and its
 * own observation record, which is why the tool is safe to offer in Plan.
 * `list` and `read` mark the reader before their answer exists for the
 * provider, every time, and a call the host cannot mark or journal returns
 * `unavailable` and nothing else.
 */
export class SiblingThreadsService {
  readonly #journal: Pick<Journal, "append">;
  readonly #connection: SqliteConnection;
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #actor: ReturnType<typeof decodeActor>;
  readonly #recordExternalContentIngestion: SiblingThreadsServiceOptions["recordExternalContentIngestion"];
  readonly #now: () => number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: SiblingThreadsServiceOptions) {
    this.#journal = options.journal;
    this.#connection = options.connection;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    this.#actor = decodeActor(options.actor);
    this.#recordExternalContentIngestion = options.recordExternalContentIngestion;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? sleepUnlessAborted;
  }

  async answer(input: {
    readonly callerThreadId: CodeThreadId;
    readonly source: SiblingThreadSource;
    readonly call: SiblingThreadsToolInput;
    readonly signal?: AbortSignal;
  }): Promise<SiblingThreadOutcome> {
    const callerThread = input.source.thread(input.callerThreadId);
    if (callerThread === undefined) return refused("policy", CALLER_REFUSAL);
    const caller: SiblingThreadCaller = {
      threadId: callerThread.threadId,
      projectId: callerThread.projectId,
      mode: callerThread.mode,
    };
    switch (input.call.action) {
      case "list":
        return this.#list(caller, input.source);
      case "read":
        return await this.#read(caller, input.source, input.call.reference);
      case "wait":
        return await this.#wait(
          caller,
          input.source,
          input.call.reference,
          input.call.timeoutMs,
          input.signal,
        );
    }
  }

  #list(caller: SiblingThreadCaller, source: SiblingThreadSource): SiblingThreadOutcome {
    const projectId = caller.projectId;
    const listed = listSiblingThreads(
      caller,
      projectId === undefined ? [] : source.projectThreads(projectId),
    );
    const answer = decodeSiblingThreadsToolResult({
      status: "listed",
      // A listed thread shares the caller's Project, so the caller's id is its own.
      threads:
        projectId === undefined
          ? []
          : listed.threads.map((thread) => ({
              reference: siblingThreadReference({ threadId: thread.threadId, projectId }),
              title: boundedTitle(thread.title),
              state: thread.state,
              stateChangedAt: thread.stateChangedAt,
            })),
      truncated: listed.truncated,
    });
    return this.#deliverIngested(caller, "list", answer);
  }

  async #read(
    caller: SiblingThreadCaller,
    source: SiblingThreadSource,
    reference: string,
  ): Promise<SiblingThreadOutcome> {
    const admitted = this.#resolve(caller, source, reference);
    if (admitted === undefined) return refused("unauthorized", SIBLING_THREAD_UNREACHABLE);
    const entries = await source.readTranscript(admitted.threadId);
    // The mention read answers nothing where an Open would refuse, and the
    // thread may have closed or moved while it ran, so both refuse alike.
    const target = this.#resolve(caller, source, reference);
    if (entries === undefined || target === undefined) {
      return refused("unauthorized", SIBLING_THREAD_UNREACHABLE);
    }
    const window = boundThreadMentionTranscript(
      entries.map((entry) => ({ ...entry, text: bounded(entry.text, MAX_ENTRY_CHARACTERS) })),
    );
    const answer = decodeSiblingThreadsToolResult({
      status: "read",
      reference: referenceOf(target),
      title: boundedTitle(target.title),
      state: target.state,
      transcript: window.transcript,
      truncated: window.truncated,
    });
    const outcome = this.#deliverIngested(caller, "read", answer);
    if (outcome.answer.status === "refused") return outcome;
    return await this.#journaled(caller, target, "read", outcome);
  }

  async #wait(
    caller: SiblingThreadCaller,
    source: SiblingThreadSource,
    reference: string,
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<SiblingThreadOutcome> {
    const deadline = this.#now() + siblingThreadWaitMs(timeoutMs);
    for (;;) {
      if (signal?.aborted === true) return refused("policy", CANCELLED);
      // Re-decided on every look: a thread that closes or moves while the
      // caller waits on it stops being one this thread may watch.
      const target = this.#resolve(caller, source, reference);
      if (target === undefined) return refused("unauthorized", SIBLING_THREAD_UNREACHABLE);
      const remaining = deadline - this.#now();
      if (target.state !== "working" || remaining <= 0) {
        // A closed set of states carries no text another thread wrote, so
        // `wait` leaves the reader unmarked.
        const answer = decodeSiblingThreadsToolResult({
          status: "waited",
          reference: referenceOf(target),
          state: target.state,
        });
        return await this.#journaled(caller, target, "wait", { answer, providerResult: answer });
      }
      await this.#sleep(Math.min(WAIT_POLL_MS, remaining), signal);
    }
  }

  #resolve(
    caller: SiblingThreadCaller,
    source: SiblingThreadSource,
    reference: string,
  ): SiblingThreadSnapshot | undefined {
    const named = parseSiblingThreadReference(reference);
    const target = named === undefined ? undefined : source.thread(named.threadId);
    const decision = decideSiblingThreadTarget({ caller, reference, target });
    return decision.status === "admitted" ? target : undefined;
  }

  /**
   * Marks the reader, then frames the answer for the provider. The mark comes
   * first so nothing a provider could read is untracked; one that cannot be
   * recorded withholds the answer.
   */
  #deliverIngested(
    caller: SiblingThreadCaller,
    action: "list" | "read",
    answer: SiblingThreadsToolResult,
  ): SiblingThreadOutcome {
    if (siblingThreadActionIngestsContent(action)) {
      // A fresh reference per call journals a mark for every list and read,
      // whether or not the reader was already marked.
      const marked = this.#recordExternalContentIngestion({
        threadId: String(caller.threadId),
        provenance: { origin: "external-content", sourceLabel: SOURCE_LABEL },
        contentReference: `${SOURCE_LABEL}-${this.#uuid()}`,
        correlationId: this.#uuid(),
        authorized: true,
      });
      if (marked.kind !== "recorded" && marked.kind !== "already-recorded") {
        return refused("unavailable", UNMARKED);
      }
    }
    const framed = frameExternalContentForModel({
      origin: "external-content",
      sourceLabel: SOURCE_LABEL,
      body: JSON.stringify(answer),
      section: "tool-results",
    });
    return { answer, providerResult: framed.text };
  }

  /** Journals an answered `read` or `wait` on the reader's stream, or withholds the answer. */
  async #journaled(
    caller: SiblingThreadCaller,
    target: SiblingThreadSnapshot,
    action: "read" | "wait",
    outcome: SiblingThreadOutcome,
  ): Promise<SiblingThreadOutcome> {
    const readerId = String(caller.threadId);
    try {
      const payload = decodeSiblingThreadObserved({
        kind: "sibling-observed",
        threadId: readerId,
        targetThreadId: String(target.threadId),
        action,
        correlationId: this.#uuid(),
        returnedBytes: byteLength(outcome.providerResult),
        occurredAt: this.#clock(),
      });
      this.#append(readerId, payload);
    } catch {
      return refused("unavailable", UNJOURNALED);
    }
    return outcome;
  }

  #append(readerId: string, payload: unknown): void {
    const eventName = decodeEventName(SIBLING_THREAD_EVENT_NAMES.observed);
    for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
      const expectedVersion = decodeAggregateVersion(
        readAggregateVersion(this.#connection, SIBLING_THREAD_OBSERVATION_AGGREGATE, readerId),
      );
      try {
        this.#journal.append({
          aggregate: { aggregateType: SIBLING_THREAD_OBSERVATION_AGGREGATE, aggregateId: readerId },
          expectedVersion,
          events: [
            {
              eventId: decodeEventId(this.#uuid()),
              eventName,
              eventVersion: 1,
              correlationId: decodeCorrelationId(this.#uuid()),
              actor: this.#actor,
              occurredAt: decodeTimestamp(this.#clock()),
              payload,
            },
          ],
        });
        return;
      } catch (error) {
        if (error instanceof ConcurrencyConflict) continue;
        throw error;
      }
    }
    throw new Error("The observation could not be journaled after repeated conflicts.");
  }
}

/**
 * The sibling-threads tool for one Code turn.
 *
 * It is offered in Plan, since no action changes anything outside the
 * caller's own context, and omitted from a profile whose allowlist leaves it
 * out; that allowlist is read again on every call, like messaging's. The
 * per-turn bounds count every `read` and `wait` whose input decodes, refused
 * or not, so probing references spends the same budget as reading them.
 */
export function createSiblingThreadTools(input: {
  readonly service: Pick<SiblingThreadsService, "answer">;
  readonly source: SiblingThreadSource;
  readonly callerThreadId: string;
  /** The caller thread's snapshotted profile allowlist; empty permits every tool. */
  readonly toolConstraints: ReadonlyArray<string>;
  readonly profileDisplayName: string;
}): AppManagedToolSet {
  const callerThreadId = decodeCodeThreadId(input.callerThreadId);
  let readsThisTurn = 0;
  let waitsThisTurn = 0;
  const profileRefusal = (): string | undefined => {
    const profile = decideProfileToolConstraint({
      toolId: SIBLING_THREADS_TOOL_NAME,
      toolConstraints: input.toolConstraints,
      profileDisplayName: input.profileDisplayName,
    });
    return profile.status === "refused" ? profile.reason : undefined;
  };
  const answered = (outcome: SiblingThreadOutcome) => ({
    result: outcome.providerResult,
    isError: outcome.answer.status === "refused",
  });
  return {
    // A tool this turn could only be refused is omitted, not advertised.
    definitions: profileRefusal() === undefined ? [SIBLING_THREADS_TOOL_DEFINITION] : [],
    execute: async ({ inputJson, signal }) => {
      if (signal?.aborted === true) return answered(refused("policy", CANCELLED));
      const profile = profileRefusal();
      if (profile !== undefined) return answered(refused("policy", profile));
      let call: SiblingThreadsToolInput;
      try {
        call = decodeSiblingThreadsToolInput(JSON.parse(inputJson));
      } catch {
        return answered(refused("policy", "The tool input is invalid."));
      }
      if (call.action !== "list") {
        const bound = decideSiblingThreadCall({
          action: call.action,
          readsThisTurn,
          waitsThisTurn,
        });
        if (bound.status === "refused") return answered(refused(bound.reason, bound.message));
        if (call.action === "read") readsThisTurn += 1;
        else waitsThisTurn += 1;
      }
      try {
        return answered(
          await input.service.answer({
            callerThreadId,
            source: input.source,
            call,
            ...(signal === undefined ? {} : { signal }),
          }),
        );
      } catch {
        // A host fact that does not fit the contract is the host's failure,
        // and it is answered as one rather than thrown at the provider.
        return answered(refused("unavailable", "The host could not answer this call."));
      }
    },
  };
}

function refused(reason: SiblingThreadRefuseReason, message: string): SiblingThreadOutcome {
  const answer = decodeSiblingThreadsToolResult({ status: "refused", reason, message });
  return { answer, providerResult: answer };
}

function referenceOf(target: SiblingThreadSnapshot) {
  // Only an admitted target reaches here, and admission requires a Project.
  if (target.projectId === undefined) throw new Error("An admitted sibling has a Project.");
  return siblingThreadReference({ threadId: target.threadId, projectId: target.projectId });
}

/**
 * A title is a sidebar row a person or an agent wrote. It is cut to the
 * contract's bound here, so a long one shortens the answer instead of making
 * it fail to decode.
 */
function boundedTitle(title: string): string {
  const trimmed = title.replace(/\s+/g, " ").trim();
  return trimmed.length === 0 ? "Untitled" : bounded(trimmed, MAX_TITLE_CHARACTERS);
}

function bounded(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function byteLength(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return new TextEncoder().encode(text).length;
}

function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
