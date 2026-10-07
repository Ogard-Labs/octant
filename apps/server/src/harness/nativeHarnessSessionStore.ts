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
  decodeNativeHarnessSteeringCleared,
  decodeNativeHarnessSteeringDelivered,
  decodeNativeHarnessSteeringQueued,
  decodeUtcTimestamp,
  type NativeHarnessAdvisorIntervention,
  type NativeHarnessContextReduction,
  type NativeHarnessQuestion,
  type NativeHarnessQuestionId,
  type NativeHarnessQuestionStatus,
  type NativeHarnessRouteDecision,
  type NativeHarnessSession,
  type NativeHarnessSessionView,
  type NativeHarnessSlotCandidate,
  type NativeHarnessToolCall,
  MAX_NATIVE_HARNESS_TOOL_CALLS_PER_TURN,
  MAX_NATIVE_HARNESS_STEERING_NOTES,
  decodeNativeHarnessApproval,
  decodeHarnessRetryNotice,
  type HarnessRetryNotice,
  type NativeHarnessApproval,
  type NativeHarnessApprovalId,
  type NativeHarnessApprovalStatus,
  type NativeHarnessSteeringNote,
  type NativeHarnessSlotId,
  type NativeHarnessTurnRecord,
  type OctantMode,
  type ProjectId,
} from "@octant/contracts";
import { addTurnToSessionMetrics, addTurnUsage } from "@octant/domain";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";

const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const JOURNAL_REPLAY_BATCH_SIZE = 1_000;
/** Enough to catch a client's retries of its recent notes; older ids are long settled. */
const MAX_REMEMBERED_STEERING_IDS = 64;

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
  questions: NativeHarnessQuestion[];
  approvals: NativeHarnessApproval[];
  version: number;
}

/**
 * One harness session per thread, rebuilt from the journal. Every routing
 * decision, turn, context reduction, and advisor intervention is a frame
 * here, which is what lets the web, desktop, phone, and CLI show
 * the same truth about why a model was switched or a run was paused.
 */
export class NativeHarnessSessionStore {
  readonly #journal: JournalPort;
  readonly #uuid: () => string;
  readonly #actor: typeof EventActor.Type;
  readonly #clock: () => string;
  readonly #records = new Map<string, SessionRecord>();
  /** Calls of the turn running now, per thread; journaled with the turn when it ends. */
  readonly #activeTools = new Map<string, NativeHarnessToolCall[]>();
  /** The endpoint retry in progress, per thread. Not journaled; cleared by content or the turn ending. */
  readonly #retrying = new Map<string, HarnessRetryNotice>();
  /** Notes typed while the lead works, per thread, rebuilt from the journal; delivered at the next tool step. */
  readonly #steering = new Map<string, NativeHarnessSteeringNote[]>();
  /**
   * Ids of notes this thread has ever queued, newest last, so a retried queue
   * whose first attempt already landed is not queued twice — even after the
   * note was delivered or taken. Rebuilt from the queued events on replay.
   */
  readonly #steeringIds = new Map<string, string[]>();
  /**
   * Threads whose turn has started and not closed, rebuilt from the journal.
   * Status cannot carry this: a paused session keeps its pause while the
   * turn it let finish is still running.
   */
  readonly #turnsInFlight = new Set<string>();

  constructor(options: NativeHarnessSessionStoreOptions) {
    this.#journal = options.journal;
    this.#uuid = options.uuid;
    this.#actor = decodeActor(options.actor);
    this.#clock = options.clock;
    this.#hydrate();
    this.#requireRecoveryAfterRestart();
  }

  /** Whether the thread's turn is still running, paused or not. */
  turnInFlight(threadId: string): boolean {
    return this.#turnsInFlight.has(threadId);
  }

  read(threadId: string): NativeHarnessSessionView | undefined {
    const record = this.#records.get(threadId);
    if (record === undefined) return undefined;
    const retrying = this.#retrying.get(threadId);
    return decodeNativeHarnessSessionView({
      session: record.session,
      routes: record.routes,
      turns: record.turns,
      reductions: record.reductions,
      interventions: record.interventions,
      // Follow-up suggestions belong to the thread on every provider; the
      // session route joins them in from their own store.
      activatedFollowUpIds: [],
      questions: record.questions,
      approvals: record.approvals,
      steering: this.#steering.get(threadId) ?? [],
      activeTools: this.#activeTools.get(threadId) ?? [],
      ...(retrying === undefined ? {} : { retrying }),
    });
  }

  /** Remembers the retry the endpoint just announced, replacing any earlier one. */
  noteRetry(threadId: string, notice: HarnessRetryNotice): void {
    if (this.#records.get(threadId) === undefined) return;
    this.#retrying.set(threadId, decodeHarnessRetryNotice(notice));
  }

  /** Drops the retry notice. Content arriving, or the turn ending, is why. */
  clearRetry(threadId: string): void {
    this.#retrying.delete(threadId);
  }

  noteToolCall(threadId: string, call: NativeHarnessToolCall): void {
    const calls = this.#activeTools.get(threadId) ?? [];
    calls.push(call);
    if (calls.length > MAX_NATIVE_HARNESS_TOOL_CALLS_PER_TURN) calls.shift();
    this.#activeTools.set(threadId, calls);
  }

  /** The running turn's calls, handed over once so they land on exactly one record. */
  takeToolCalls(threadId: string): ReadonlyArray<NativeHarnessToolCall> {
    const calls = this.#activeTools.get(threadId) ?? [];
    this.#activeTools.delete(threadId);
    return calls;
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
      questions: [],
      approvals: [],
      version: 0,
    };
    // Journal first: a record the journal never accepted must not stay in
    // memory, or every later frame for the thread fails its version check.
    this.#append(record, input.threadId, NATIVE_HARNESS_SESSION_EVENT_NAMES.started, session);
    this.#records.set(input.threadId, record);
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
    this.#turnsInFlight.delete(threadId);
    this.#setSession(record, {
      ...record.session,
      ...sessionTotals(record.session, turn),
      turnsRun: record.session.turnsRun + 1,
      status: record.session.status === "running" ? "idle" : record.session.status,
      updatedAt: decodeUtcTimestamp(this.#clock()),
    });
  }

  markRunning(threadId: string): void {
    const record = this.#records.get(threadId);
    if (record === undefined) return;
    const now = this.#clock();
    this.#append(record, threadId, NATIVE_HARNESS_SESSION_EVENT_NAMES.turnStarted, {
      sessionId: record.session.id,
      startedAt: now,
    });
    this.#turnsInFlight.add(threadId);
    if (record.session.status !== "idle") return;
    this.#setSession(record, {
      ...record.session,
      status: "running",
      updatedAt: decodeUtcTimestamp(now),
    });
  }

  /**
   * Closes a turn that ended without a completed record — it failed, or a
   * person stopped it. A completed turn is already closed by its record.
   */
  settleTurn(threadId: string): void {
    const record = this.#records.get(threadId);
    if (record === undefined || !this.#turnsInFlight.has(threadId)) return;
    const now = this.#clock();
    this.#append(record, threadId, NATIVE_HARNESS_SESSION_EVENT_NAMES.turnSettled, {
      sessionId: record.session.id,
      outcome: "ended",
      settledAt: now,
    });
    this.#turnsInFlight.delete(threadId);
    if (record.session.status !== "running") return;
    this.#setSession(record, {
      ...record.session,
      status: "idle",
      updatedAt: decodeUtcTimestamp(now),
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

  askApproval(threadId: string, approval: NativeHarnessApproval): void {
    const record = this.#records.get(threadId);
    if (record === undefined) return;
    this.#append(record, threadId, NATIVE_HARNESS_SESSION_EVENT_NAMES.approvalAsked, approval);
    push(record.approvals, approval);
  }

  settleApproval(
    threadId: string,
    approvalId: NativeHarnessApprovalId,
    outcome: {
      readonly status: Exclude<NativeHarnessApprovalStatus, "pending">;
      readonly remembered?: boolean;
    },
  ): NativeHarnessApproval | "approval-not-found" | "already-settled" {
    const record = this.#records.get(threadId);
    const index = record?.approvals.findIndex((entry) => entry.id === approvalId) ?? -1;
    if (record === undefined || index === -1) return "approval-not-found";
    const current = record.approvals[index]!;
    if (current.status !== "pending") return "already-settled";
    const settledAt = decodeUtcTimestamp(this.#clock());
    const settled = decodeNativeHarnessApproval({
      ...current,
      status: outcome.status,
      ...(outcome.remembered === true ? { remembered: true } : {}),
      settledAt,
    });
    this.#append(record, threadId, NATIVE_HARNESS_SESSION_EVENT_NAMES.approvalSettled, {
      sessionId: record.session.id,
      approvalId,
      status: outcome.status,
      ...(outcome.remembered === true ? { remembered: true } : {}),
      settledAt,
    });
    record.approvals[index] = settled;
    return settled;
  }

  /**
   * Queues a note typed while the lead works. It is journaled before it
   * counts, so a note sent just before a restart still reaches the lead on
   * the next turn instead of vanishing with the process.
   */
  queueSteering(
    threadId: string,
    note: NativeHarnessSteeringNote,
  ): "queued" | "full" | "no-session" {
    const record = this.#records.get(threadId);
    if (record === undefined) return "no-session";
    if ((this.#steeringIds.get(threadId) ?? []).includes(String(note.id))) return "queued";
    const queued = (this.#steering.get(threadId) ?? []).filter(
      (entry) => entry.status === "queued",
    );
    if (queued.length >= MAX_NATIVE_HARNESS_STEERING_NOTES) return "full";
    this.#append(record, threadId, NATIVE_HARNESS_SESSION_EVENT_NAMES.steeringQueued, {
      sessionId: record.session.id,
      note,
    });
    this.#applySteeringQueued(threadId, note);
    return "queued";
  }

  /** Queued notes, marked delivered, for the tool step that carries them to the lead. */
  deliverSteering(threadId: string): ReadonlyArray<string> {
    const record = this.#records.get(threadId);
    const queued = (this.#steering.get(threadId) ?? []).filter(
      (entry) => entry.status === "queued",
    );
    if (record === undefined || queued.length === 0) return [];
    const noteIds = queued.map((entry) => entry.id);
    this.#append(record, threadId, NATIVE_HARNESS_SESSION_EVENT_NAMES.steeringDelivered, {
      sessionId: record.session.id,
      noteIds,
    });
    this.#applySteeringDelivered(threadId, noteIds);
    return queued.map((entry) => entry.text);
  }

  /**
   * Every queued note, removed from the queue for one caller to send as the
   * next prompt. The queue is emptied in the same step, so a second client
   * taking at the same turn end gets nothing rather than a duplicate prompt.
   */
  takeSteering(threadId: string): ReadonlyArray<NativeHarnessSteeringNote> {
    const record = this.#records.get(threadId);
    const queued = (this.#steering.get(threadId) ?? []).filter(
      (entry) => entry.status === "queued",
    );
    if (record === undefined || queued.length === 0) return [];
    const noteIds = queued.map((entry) => entry.id);
    this.#append(record, threadId, NATIVE_HARNESS_SESSION_EVENT_NAMES.steeringCleared, {
      sessionId: record.session.id,
      which: "taken",
      noteIds,
    });
    this.#applySteeringCleared(threadId, { which: "taken", noteIds });
    return queued;
  }

  clearSteering(threadId: string, which: "delivered" | "all"): void {
    const record = this.#records.get(threadId);
    const notes = this.#steering.get(threadId) ?? [];
    const dropping =
      which === "all" ? notes.length : notes.filter((entry) => entry.status === "delivered").length;
    // A turn ends with nothing delivered far more often than not; only a
    // change worth replaying is journaled.
    if (record === undefined || dropping === 0) return;
    this.#append(record, threadId, NATIVE_HARNESS_SESSION_EVENT_NAMES.steeringCleared, {
      sessionId: record.session.id,
      which,
    });
    this.#applySteeringCleared(threadId, { which });
  }

  #applySteeringQueued(threadId: string, note: NativeHarnessSteeringNote): void {
    const notes = this.#steering.get(threadId) ?? [];
    notes.push(note);
    while (notes.length > MAX_NATIVE_HARNESS_STEERING_NOTES) notes.shift();
    this.#steering.set(threadId, notes);
    const ids = this.#steeringIds.get(threadId) ?? [];
    ids.push(String(note.id));
    while (ids.length > MAX_REMEMBERED_STEERING_IDS) ids.shift();
    this.#steeringIds.set(threadId, ids);
  }

  #applySteeringDelivered(threadId: string, noteIds: ReadonlyArray<string>): void {
    const delivered = new Set(noteIds.map(String));
    const notes = this.#steering.get(threadId);
    if (notes === undefined) return;
    this.#steering.set(
      threadId,
      notes.map((entry) =>
        delivered.has(String(entry.id)) ? { ...entry, status: "delivered" as const } : entry,
      ),
    );
  }

  #applySteeringCleared(
    threadId: string,
    cleared:
      | { readonly which: "delivered" | "all" }
      | { readonly which: "taken"; readonly noteIds: ReadonlyArray<string> },
  ): void {
    const notes = this.#steering.get(threadId) ?? [];
    let remaining: ReadonlyArray<NativeHarnessSteeringNote>;
    if (cleared.which === "taken") {
      const taken = new Set(cleared.noteIds.map(String));
      remaining = notes.filter((entry) => !taken.has(String(entry.id)));
    } else if (cleared.which === "all") remaining = [];
    else remaining = notes.filter((entry) => entry.status === "queued");
    if (remaining.length === 0) this.#steering.delete(threadId);
    else this.#steering.set(threadId, [...remaining]);
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
    const trimmed = detail.trim().slice(0, 512).trim();
    const bounded = trimmed.length === 0 ? "Paused." : trimmed;
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

  /**
   * Lifts a pause or a recovery. Clearing a recovery first settles, in the
   * journal, everything the restart left open — the turn it cut off and any
   * approval or question nobody can answer now — so the next restart does not
   * raise the same recovery again. A plain pause settles nothing: an approval
   * the finishing turn is waiting on is still live.
   */
  resume(threadId: string): boolean {
    const record = this.#records.get(threadId);
    if (record === undefined) return false;
    if (record.session.status === "running" || record.session.status === "idle") return false;
    if (record.session.status === "recovery-required") {
      const now = this.#clock();
      if (this.#turnsInFlight.has(threadId)) {
        this.#append(record, threadId, NATIVE_HARNESS_SESSION_EVENT_NAMES.turnSettled, {
          sessionId: record.session.id,
          outcome: "lost-in-restart",
          settledAt: now,
        });
        this.#turnsInFlight.delete(threadId);
      }
      for (const approval of record.approvals.filter((entry) => entry.status === "pending")) {
        this.settleApproval(threadId, approval.id, { status: "expired" });
      }
      for (const question of record.questions.filter((entry) => entry.status === "pending")) {
        this.settleQuestion(threadId, question.id, { status: "expired" });
      }
    }
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

  /**
   * After a restart, a session whose turn was cut off, or whose lead was
   * waiting on an answer the restart dropped, needs a person before anything
   * runs again. Derived from the replayed journal rather than written at
   * start-up; the resume that clears it journals what it settled.
   */
  #requireRecoveryAfterRestart(): void {
    for (const [threadId, record] of this.#records) {
      // Child sessions cannot keep a pending transport request across a host
      // restart. A late answer must never be delivered to their next session.
      for (const approval of record.approvals.filter(
        (entry) => entry.source !== undefined && entry.status === "pending",
      )) {
        this.settleApproval(threadId, approval.id, { status: "expired" });
      }
      for (const question of record.questions.filter(
        (entry) => entry.source !== undefined && entry.status === "pending",
      )) {
        this.settleQuestion(threadId, question.id, { status: "expired" });
      }
      const cutOff = this.#turnsInFlight.has(threadId);
      const waiting =
        record.approvals.some((entry) => entry.status === "pending") ||
        record.questions.some((entry) => entry.status === "pending");
      if (!cutOff && !waiting) continue;
      record.session = {
        ...record.session,
        status: "recovery-required",
        detail: cutOff
          ? "Octant restarted while a turn was running. Check what it did, then resume."
          : "Octant restarted while the lead was waiting for an answer. Resume to continue without it.",
      };
    }
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
        questions: [],
        approvals: [],
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
    } else if (eventName === names.turnStarted) {
      this.#turnsInFlight.add(threadId);
    } else if (eventName === names.turnSettled) {
      this.#turnsInFlight.delete(threadId);
    } else if (eventName === names.turnCompleted) {
      const turn = payload as NativeHarnessTurnRecord;
      push(record.turns, turn);
      this.#turnsInFlight.delete(threadId);
      // The status stays what the journal last set. "Running" is never
      // journaled, so the only status a completed turn can meet here is idle
      // or one a person or the advisor chose — a pause made while the turn
      // finished must survive the restart, not be cleared by the replay.
      record.session = {
        ...record.session,
        ...sessionTotals(record.session, turn),
        turnsRun: record.session.turnsRun + 1,
      };
    } else if (eventName === names.contextReduced) {
      const reduction = payload as NativeHarnessContextReduction;
      push(record.reductions, reduction);
      if (reduction.kind === "cutover") {
        record.session = { ...record.session, cutovers: record.session.cutovers + 1 };
      }
    } else if (eventName === names.advisorIntervened) {
      push(record.interventions, payload as NativeHarnessAdvisorIntervention);
    } else if (eventName === names.approvalAsked) {
      push(record.approvals, payload as NativeHarnessApproval);
    } else if (eventName === names.approvalSettled) {
      const index = record.approvals.findIndex(
        (entry) => String(entry.id) === String(body.approvalId),
      );
      const current = record.approvals[index];
      if (current !== undefined) {
        record.approvals[index] = {
          ...current,
          status: body.status as NativeHarnessApprovalStatus,
          ...(body.remembered === true ? { remembered: true } : {}),
          settledAt: body.settledAt as NativeHarnessApproval["settledAt"],
        };
      }
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
    } else if (eventName === names.steeringQueued) {
      this.#applySteeringQueued(threadId, decodeNativeHarnessSteeringQueued(payload).note);
    } else if (eventName === names.steeringDelivered) {
      this.#applySteeringDelivered(threadId, decodeNativeHarnessSteeringDelivered(payload).noteIds);
    } else if (eventName === names.steeringCleared) {
      this.#applySteeringCleared(threadId, decodeNativeHarnessSteeringCleared(payload));
    }
  }
}

function push<T>(list: T[], entry: T): void {
  list.push(entry);
  if (list.length > MAX_NATIVE_HARNESS_VIEW_ENTRIES)
    list.splice(0, list.length - MAX_NATIVE_HARNESS_VIEW_ENTRIES);
}

/**
 * What a turn adds to the session's running totals, which outlive the bounded
 * turn list: full usage, and timing when the turn's record kept it.
 */
function sessionTotals(
  session: NativeHarnessSession,
  turn: NativeHarnessTurnRecord,
): Pick<NativeHarnessSession, "usage" | "metrics"> {
  const metrics =
    turn.metrics === undefined
      ? session.metrics
      : addTurnToSessionMetrics(session.metrics, turn.metrics);
  return {
    usage: addTurnUsage(session.usage, turn.usage),
    ...(metrics === undefined ? {} : { metrics }),
  };
}
