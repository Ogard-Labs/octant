import {
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventActor,
  EventId,
  MAX_NATIVE_HARNESS_VIEW_ENTRIES,
  NATIVE_HARNESS_SESSION_AGGREGATE_TYPE,
  NATIVE_HARNESS_SESSION_EVENT_NAMES,
  decodeNativeHarnessQuestion,
  decodeNativeHarnessSession,
  decodeNativeHarnessSessionId,
  decodeNativeHarnessSessionView,
  decodeUtcTimestamp,
  type NativeHarnessAdvisorIntervention,
  type NativeHarnessContextReduction,
  type NativeHarnessFollowUpCreation,
  type NativeHarnessFollowUpId,
  type NativeHarnessFollowUpSet,
  type NativeHarnessQuestion,
  type NativeHarnessQuestionId,
  type NativeHarnessQuestionStatus,
  type NativeHarnessRouteDecision,
  type NativeHarnessSession,
  type NativeHarnessSessionView,
  type NativeHarnessSlotCandidate,
  type NativeHarnessSlotId,
  type NativeHarnessTurnRecord,
  type OctantMode,
  type ProjectId,
} from "@octant/contracts";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";

const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const JOURNAL_REPLAY_BATCH_SIZE = 1_000;

type JournalPort = Pick<Journal, "append" | "replay">;

export interface NativeHarnessSessionStoreOptions {
  readonly journal: JournalPort;
  readonly uuid: () => string;
  readonly actor: typeof EventActor.Type;
  readonly clock: () => string;
}

interface SessionRecord {
  session: NativeHarnessSession;
  routes: NativeHarnessRouteDecision[];
  turns: NativeHarnessTurnRecord[];
  reductions: NativeHarnessContextReduction[];
  interventions: NativeHarnessAdvisorIntervention[];
  followUps: NativeHarnessFollowUpSet | undefined;
  activated: NativeHarnessFollowUpId[];
  questions: NativeHarnessQuestion[];
  version: number;
}

/**
 * One harness session per thread, rebuilt from the journal. Every routing
 * decision, turn, context reduction, advisor intervention, and follow-up set
 * is a frame here, which is what lets the web, desktop, phone, and CLI show
 * the same truth about why a model was switched or a run was paused.
 */
export class NativeHarnessSessionStore {
  readonly #journal: JournalPort;
  readonly #uuid: () => string;
  readonly #actor: typeof EventActor.Type;
  readonly #clock: () => string;
  readonly #records = new Map<string, SessionRecord>();

  constructor(options: NativeHarnessSessionStoreOptions) {
    this.#journal = options.journal;
    this.#uuid = options.uuid;
    this.#actor = decodeActor(options.actor);
    this.#clock = options.clock;
    this.#hydrate();
  }

  read(threadId: string): NativeHarnessSessionView | undefined {
    const record = this.#records.get(threadId);
    if (record === undefined) return undefined;
    return decodeNativeHarnessSessionView({
      session: record.session,
      routes: record.routes,
      turns: record.turns,
      reductions: record.reductions,
      interventions: record.interventions,
      ...(record.followUps === undefined ? {} : { followUps: record.followUps }),
      activatedFollowUpIds: record.activated,
      questions: record.questions,
    });
  }

  /** The session for a thread, started on first use. */
  ensure(input: {
    readonly threadId: string;
    readonly mode: OctantMode;
    readonly projectId?: ProjectId | undefined;
    readonly leadSlotId: NativeHarnessSlotId;
    readonly lead: NativeHarnessSlotCandidate;
  }): NativeHarnessSession {
    const existing = this.#records.get(input.threadId);
    if (existing !== undefined) return existing.session;
    const now = this.#clock();
    const session = decodeNativeHarnessSession({
      id: decodeNativeHarnessSessionId(this.#uuid()),
      threadId: input.threadId,
      mode: input.mode,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      leadSlotId: input.leadSlotId,
      lead: input.lead,
      status: "idle",
      turnsRun: 0,
      cutovers: 0,
      startedAt: now,
      updatedAt: now,
      version: 1,
    });
    const record: SessionRecord = {
      session,
      routes: [],
      turns: [],
      reductions: [],
      interventions: [],
      followUps: undefined,
      activated: [],
      questions: [],
      version: 0,
    };
    this.#records.set(input.threadId, record);
    this.#append(record, input.threadId, NATIVE_HARNESS_SESSION_EVENT_NAMES.started, session);
    return session;
  }

  recordRouteDecision(threadId: string, decision: NativeHarnessRouteDecision): void {
    const record = this.#records.get(threadId);
    if (record === undefined) return;
    this.#append(record, threadId, NATIVE_HARNESS_SESSION_EVENT_NAMES.routeDecided, {
      sessionId: record.session.id,
      decision,
    });
    push(record.routes, decision);
  }

  recordTurn(threadId: string, turn: NativeHarnessTurnRecord): void {
    const record = this.#records.get(threadId);
    if (record === undefined) return;
    this.#append(record, threadId, NATIVE_HARNESS_SESSION_EVENT_NAMES.turnCompleted, turn);
    push(record.turns, turn);
    this.#setSession(record, {
      ...record.session,
      turnsRun: record.session.turnsRun + 1,
      status: record.session.status === "running" ? "idle" : record.session.status,
      updatedAt: decodeUtcTimestamp(this.#clock()),
    });
  }

  markRunning(threadId: string): void {
    const record = this.#records.get(threadId);
    if (record === undefined || record.session.status !== "idle") return;
    this.#setSession(record, {
      ...record.session,
      status: "running",
      updatedAt: decodeUtcTimestamp(this.#clock()),
    });
  }

  recordReduction(threadId: string, reduction: NativeHarnessContextReduction): void {
    const record = this.#records.get(threadId);
    if (record === undefined) return;
    this.#append(record, threadId, NATIVE_HARNESS_SESSION_EVENT_NAMES.contextReduced, reduction);
    push(record.reductions, reduction);
    if (reduction.kind === "cutover") {
      this.#setSession(record, {
        ...record.session,
        cutovers: record.session.cutovers + 1,
        updatedAt: decodeUtcTimestamp(this.#clock()),
      });
    }
  }

  recordIntervention(threadId: string, intervention: NativeHarnessAdvisorIntervention): void {
    const record = this.#records.get(threadId);
    if (record === undefined) return;
    this.#append(
      record,
      threadId,
      NATIVE_HARNESS_SESSION_EVENT_NAMES.advisorIntervened,
      intervention,
    );
    push(record.interventions, intervention);
    if (intervention.kind === "pause-run") {
      this.pause(threadId, "paused-by-advisor", intervention.reason);
    }
  }

  recordFollowUps(threadId: string, followUps: NativeHarnessFollowUpSet): void {
    const record = this.#records.get(threadId);
    if (record === undefined) return;
    this.#append(
      record,
      threadId,
      NATIVE_HARNESS_SESSION_EVENT_NAMES.followUpsSuggested,
      followUps,
    );
    record.followUps = followUps;
    record.activated = [];
  }

  activateFollowUp(
    threadId: string,
    suggestionId: NativeHarnessFollowUpId,
    created: NativeHarnessFollowUpCreation,
  ): "activated" | "suggestion-not-found" | "already-activated" {
    const record = this.#records.get(threadId);
    if (record === undefined) return "suggestion-not-found";
    const suggestion = record.followUps?.suggestions.find((entry) => entry.id === suggestionId);
    if (suggestion === undefined) return "suggestion-not-found";
    if (record.activated.includes(suggestionId)) return "already-activated";
    this.#append(record, threadId, NATIVE_HARNESS_SESSION_EVENT_NAMES.followUpActivated, {
      sessionId: record.session.id,
      suggestionId,
      created,
    });
    record.activated.push(suggestionId);
    return "activated";
  }

  askQuestion(threadId: string, question: NativeHarnessQuestion): void {
    const record = this.#records.get(threadId);
    if (record === undefined) return;
    this.#append(record, threadId, NATIVE_HARNESS_SESSION_EVENT_NAMES.questionAsked, question);
    push(record.questions, question);
  }

  settleQuestion(
    threadId: string,
    questionId: NativeHarnessQuestionId,
    outcome: {
      readonly status: Exclude<NativeHarnessQuestionStatus, "pending">;
      readonly answer?: string;
    },
  ): NativeHarnessQuestion | "question-not-found" | "already-settled" {
    const record = this.#records.get(threadId);
    const index = record?.questions.findIndex((entry) => entry.id === questionId) ?? -1;
    if (record === undefined || index === -1) return "question-not-found";
    const current = record.questions[index]!;
    if (current.status !== "pending") return "already-settled";
    const settledAt = decodeUtcTimestamp(this.#clock());
    const settled = decodeNativeHarnessQuestion({
      ...current,
      status: outcome.status,
      ...(outcome.status === "answered" && outcome.answer !== undefined
        ? { answer: outcome.answer }
        : {}),
      settledAt,
    });
    this.#append(record, threadId, NATIVE_HARNESS_SESSION_EVENT_NAMES.questionSettled, {
      sessionId: record.session.id,
      questionId,
      status: outcome.status,
      ...(settled.answer === undefined ? {} : { answer: settled.answer }),
      settledAt,
    });
    record.questions[index] = settled;
    return settled;
  }

  pause(
    threadId: string,
    status: "paused-by-advisor" | "paused-by-user" | "budget-limited" | "failed",
    detail: string,
  ): boolean {
    const record = this.#records.get(threadId);
    if (record === undefined) return false;
    const bounded = detail.length > 512 ? detail.slice(0, 512) : detail;
    this.#append(record, threadId, NATIVE_HARNESS_SESSION_EVENT_NAMES.paused, {
      sessionId: record.session.id,
      status,
      detail: bounded,
    });
    this.#setSession(record, {
      ...record.session,
      status,
      detail: bounded,
      updatedAt: decodeUtcTimestamp(this.#clock()),
    });
    return true;
  }

  resume(threadId: string): boolean {
    const record = this.#records.get(threadId);
    if (record === undefined) return false;
    if (record.session.status === "running" || record.session.status === "idle") return false;
    this.#append(record, threadId, NATIVE_HARNESS_SESSION_EVENT_NAMES.resumed, {
      sessionId: record.session.id,
    });
    const { detail: _detail, ...rest } = record.session;
    this.#setSession(record, {
      ...rest,
      status: "idle",
      updatedAt: decodeUtcTimestamp(this.#clock()),
    });
    return true;
  }

  #setSession(record: SessionRecord, session: NativeHarnessSession): void {
    record.session = decodeNativeHarnessSession({
      ...session,
      version: decodeAggregateVersion(session.version + 1),
    });
  }

  #append(record: SessionRecord, threadId: string, eventName: string, payload: unknown): void {
    const aggregateId = decodeAggregateId(threadId);
    this.#journal.append({
      aggregate: { aggregateType: NATIVE_HARNESS_SESSION_AGGREGATE_TYPE, aggregateId },
      expectedVersion: decodeAggregateVersion(record.version),
      events: [
        {
          eventId: decodeEventId(this.#uuid()),
          eventName,
          eventVersion: 1,
          correlationId: decodeCorrelationId(this.#uuid()),
          actor: this.#actor,
          occurredAt: this.#clock(),
          payload,
        },
      ],
    });
    record.version += 1;
  }

  #hydrate(): void {
    let afterSequence = 0;
    for (;;) {
      const batch = this.#journal.replay({
        afterSequence: afterSequence as never,
        limit: JOURNAL_REPLAY_BATCH_SIZE,
      });
      if (batch.length === 0) break;
      for (const envelope of batch) {
        afterSequence = envelope.globalSequence;
        if (envelope.aggregateType !== NATIVE_HARNESS_SESSION_AGGREGATE_TYPE) continue;
        this.#apply(String(envelope.aggregateId), envelope.eventName, envelope.payload);
      }
      if (batch.length < JOURNAL_REPLAY_BATCH_SIZE) break;
    }
  }

  #apply(threadId: string, eventName: string, payload: unknown): void {
    const names = NATIVE_HARNESS_SESSION_EVENT_NAMES;
    if (eventName === names.started) {
      const session = decodeNativeHarnessSession(payload);
      this.#records.set(threadId, {
        session,
        routes: [],
        turns: [],
        reductions: [],
        interventions: [],
        followUps: undefined,
        activated: [],
        questions: [],
        version: 1,
      });
      return;
    }
    const record = this.#records.get(threadId);
    if (record === undefined) return;
    record.version += 1;
    const body = payload as Record<string, unknown>;
    if (eventName === names.routeDecided) {
      push(record.routes, body.decision as NativeHarnessRouteDecision);
    } else if (eventName === names.turnCompleted) {
      push(record.turns, payload as NativeHarnessTurnRecord);
      record.session = { ...record.session, turnsRun: record.session.turnsRun + 1, status: "idle" };
    } else if (eventName === names.contextReduced) {
      const reduction = payload as NativeHarnessContextReduction;
      push(record.reductions, reduction);
      if (reduction.kind === "cutover") {
        record.session = { ...record.session, cutovers: record.session.cutovers + 1 };
      }
    } else if (eventName === names.advisorIntervened) {
      push(record.interventions, payload as NativeHarnessAdvisorIntervention);
    } else if (eventName === names.followUpsSuggested) {
      record.followUps = payload as NativeHarnessFollowUpSet;
      record.activated = [];
    } else if (eventName === names.followUpActivated) {
      record.activated.push(body.suggestionId as NativeHarnessFollowUpId);
    } else if (eventName === names.questionAsked) {
      push(record.questions, payload as NativeHarnessQuestion);
    } else if (eventName === names.questionSettled) {
      const index = record.questions.findIndex(
        (entry) => String(entry.id) === String(body.questionId),
      );
      const current = record.questions[index];
      if (current !== undefined) {
        record.questions[index] = {
          ...current,
          status: body.status as NativeHarnessQuestionStatus,
          ...(body.answer === undefined ? {} : { answer: body.answer as string }),
          settledAt: body.settledAt as never,
        };
      }
    } else if (eventName === names.paused) {
      record.session = {
        ...record.session,
        status: body.status as NativeHarnessSession["status"],
        detail: body.detail as string,
      };
    } else if (eventName === names.resumed) {
      const { detail: _detail, ...rest } = record.session;
      record.session = { ...rest, status: "idle" };
    }
  }
}

function push<T>(list: T[], entry: T): void {
  list.push(entry);
  if (list.length > MAX_NATIVE_HARNESS_VIEW_ENTRIES)
    list.splice(0, list.length - MAX_NATIVE_HARNESS_VIEW_ENTRIES);
}
