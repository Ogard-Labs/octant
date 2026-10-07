import {
  ActorId,
  CorrelationId,
  EventId,
  LOCAL_HOST_ID,
  SPEND_CEILING_AGGREGATE_TYPE,
  SPEND_CEILING_EVENT_NAMES,
  SPEND_TURN_AGGREGATE_TYPE,
  decodeSpendCeilingReservationId,
  decodeUtcTimestamp,
  type SpendCeilingCommand,
  type SpendCeilingCommandResult,
  type SpendCeilingRefusal,
  type SpendCeilingRemaining,
  type SpendCeilingReservationId,
  type SpendCeilingScope,
  type SpendCeilingSnapshot,
  type SpendCeilingState,
  type SpendCeilingThreadType,
} from "@octant/contracts";
import {
  authorizeSpendCeilingRead,
  decideSpendCeilingCommand,
  evaluateSpendCeilingAdmission,
  remainingSpendCeilingTokens,
  settleSpendCeilingReservation,
  spendCeilingWindowStart,
  type PrincipalKind,
  type SpendCeilingAdmission,
  type SpendCeilingScopeFacts,
  type SpendTokenTotal,
} from "@octant/domain";
import { Schema } from "effect";
import type { AgentRunProjection } from "./agentRun/agentRunProjection";
import type { Journal } from "./persistence/journal";
import { readSpendCeiling } from "./persistence/spendCeilingProjection";
import {
  usageProjectConditionParams,
  usageProjectConditionSql,
} from "./persistence/usageProjection";
import type { SqliteConnection } from "./persistence/sqlitePort";

const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const LOCAL_ACTOR_ID = decodeActorId("00000000-0000-4000-8000-000000000001");

export interface SpendCeilingTurnRequest {
  readonly reservationId: SpendCeilingReservationId;
  readonly threadId: string;
  readonly threadType: SpendCeilingThreadType;
  readonly projectId?: string;
  readonly turnUpperBoundTokens?: number;
  readonly childSubjectIds?: ReadonlyArray<string>;
}

interface InFlightTurn {
  readonly threadType: SpendCeilingThreadType;
  readonly threadId: string;
  readonly projectId?: string;
  readonly startedAt: string;
}

interface TurnUse {
  readonly turns: number;
  readonly runTimeMs: number;
}

interface LiveReservation {
  readonly reservationId: string;
  readonly reservedTokens: number;
  readonly scopes: ReadonlyArray<{
    readonly scopeKind: "project" | "thread";
    readonly scopeId: string;
  }>;
}

export interface SpendCeilingServiceOptions {
  readonly connection: SqliteConnection;
  readonly journal: Journal;
  readonly clock: () => string;
  readonly uuid: () => string;
  readonly agentRuns?: Pick<AgentRunProjection, "parentSummary">;
  readonly threadExists?: (input: {
    readonly threadType: SpendCeilingThreadType;
    readonly threadId: string;
  }) => boolean;
  readonly projectExists?: (projectId: string) => boolean;
}

/**
 * Host-owned spend ceilings. Policy is journaled; in-flight reservations live in
 * memory so a crash releases them instead of leaking capacity. Committed token
 * spend is the existing usage projection, never imported provider history.
 * Every admitted turn is journaled when it settles, so turn and run-time
 * ceilings count work from before a ceiling was set and across restart.
 */
export class SpendCeilingService {
  readonly #connection: SqliteConnection;
  readonly #journal: Journal;
  readonly #clock: () => string;
  readonly #uuid: () => string;
  readonly #agentRuns: Pick<AgentRunProjection, "parentSummary"> | undefined;
  readonly #threadExists: SpendCeilingServiceOptions["threadExists"];
  readonly #projectExists: SpendCeilingServiceOptions["projectExists"];
  readonly #reservations = new Map<string, LiveReservation>();
  readonly #turns = new Map<string, InFlightTurn>();

  constructor(options: SpendCeilingServiceOptions) {
    this.#connection = options.connection;
    this.#journal = options.journal;
    this.#clock = options.clock;
    this.#uuid = options.uuid;
    this.#agentRuns = options.agentRuns;
    this.#threadExists = options.threadExists;
    this.#projectExists = options.projectExists;
  }

  snapshot(input: {
    readonly principalKind: PrincipalKind;
    readonly threadId?: string;
    readonly threadType?: SpendCeilingThreadType;
    readonly projectId?: string;
  }): SpendCeilingSnapshot | { readonly kind: "unauthorized" } {
    if (!authorizeSpendCeilingRead(input.principalKind)) return { kind: "unauthorized" };
    const threadScope =
      input.threadId === undefined || input.threadType === undefined
        ? undefined
        : ({
            kind: "thread" as const,
            threadType: input.threadType,
            threadId: input.threadId,
          } satisfies SpendCeilingScope);
    const projectScope =
      input.projectId === undefined
        ? undefined
        : ({
            kind: "project" as const,
            projectId: input.projectId as never,
          } satisfies SpendCeilingScope);
    const thread =
      threadScope === undefined ? undefined : readSpendCeiling(this.#connection, threadScope);
    const project =
      projectScope === undefined ? undefined : readSpendCeiling(this.#connection, projectScope);
    const childIds = input.threadId === undefined ? [] : this.#childSubjectIds(input.threadId);
    const threadFacts = thread === undefined ? undefined : this.#facts(thread, childIds);
    const projectFacts = project === undefined ? undefined : this.#facts(project, childIds);
    const threadRemaining =
      thread === undefined || threadFacts === undefined
        ? undefined
        : this.#remaining(thread, threadFacts);
    const projectRemaining =
      project === undefined || projectFacts === undefined
        ? undefined
        : this.#remaining(project, projectFacts);
    const preview = evaluateSpendCeilingAdmission({
      ...(threadFacts === undefined ? {} : { thread: threadFacts }),
      ...(projectFacts === undefined ? {} : { project: projectFacts }),
      turnUpperBoundTokens: 1,
    });
    return {
      ...(thread === undefined ? {} : { thread }),
      ...(project === undefined ? {} : { project }),
      ...(threadRemaining === undefined ? {} : { threadRemaining }),
      ...(projectRemaining === undefined ? {} : { projectRemaining }),
      ...(preview.status === "refused" && preview.refusal.kind !== "missing-turn-bound"
        ? { refusal: preview.refusal }
        : {}),
    };
  }

  execute(principalKind: PrincipalKind, command: SpendCeilingCommand): SpendCeilingCommandResult {
    const current = readSpendCeiling(this.#connection, command.scope);
    const aggregateVersion = this.#aggregateVersion(command.scope);
    const decision = decideSpendCeilingCommand({
      principalKind,
      command,
      ...(current === undefined ? {} : { current }),
      aggregateVersion,
      scopeExists: this.#scopeExists(command.scope),
      now: decodeUtcTimestamp(this.#clock()),
      actor: { kind: "local-user", actorId: LOCAL_ACTOR_ID },
    });
    if (decision.status === "refused") {
      return { kind: "refused", refusal: decision.refusal };
    }
    if (decision.status === "cleared") {
      this.#append(command.scope, aggregateVersion, SPEND_CEILING_EVENT_NAMES.cleared, {
        scope: command.scope,
        clearedAt: decodeUtcTimestamp(this.#clock()),
      });
      return { kind: "cleared", scope: command.scope };
    }
    const eventName =
      command.kind === "raise-spend-ceiling"
        ? SPEND_CEILING_EVENT_NAMES.raised
        : SPEND_CEILING_EVENT_NAMES.set;
    const previous = {
      ...(decision.previousTokenBudget === undefined
        ? {}
        : { previousTokenBudget: decision.previousTokenBudget }),
      ...(decision.previousTurnBudget === undefined
        ? {}
        : { previousTurnBudget: decision.previousTurnBudget }),
      ...(decision.previousRunTimeBudgetSeconds === undefined
        ? {}
        : { previousRunTimeBudgetSeconds: decision.previousRunTimeBudgetSeconds }),
      ...(decision.previousCostBudgetUsdCents === undefined
        ? {}
        : { previousCostBudgetUsdCents: decision.previousCostBudgetUsdCents }),
    };
    this.#append(command.scope, aggregateVersion, eventName, {
      ceiling: decision.next,
      ...previous,
    });
    return command.kind === "raise-spend-ceiling"
      ? { kind: "raised", ceiling: decision.next, ...previous }
      : { kind: "set", ceiling: decision.next };
  }

  admit(request: SpendCeilingTurnRequest): SpendCeilingAdmission {
    const admission = this.#admit(request);
    if (admission.status === "admitted") {
      this.#turns.set(String(request.reservationId), {
        threadType: request.threadType,
        threadId: request.threadId,
        ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
        startedAt: this.#clock(),
      });
    }
    return admission;
  }

  settle(input: {
    readonly reservationId: SpendCeilingReservationId;
    readonly observedTokens?: number;
  }): void {
    this.#recordTurn(input.reservationId);
    const live = this.#reservations.get(String(input.reservationId));
    if (live === undefined) return;
    const settlement = settleSpendCeilingReservation({
      reservedTokens: live.reservedTokens,
      ...(input.observedTokens === undefined ? {} : { observedTokens: input.observedTokens }),
    });
    if (settlement.kind === "overrun") {
      for (const scope of live.scopes) {
        this.#recordOverrun(scope, settlement.reservedTokens, settlement.observedTokens);
      }
    }
    this.#reservations.delete(String(input.reservationId));
  }

  release(reservationId: SpendCeilingReservationId): void {
    this.settle({ reservationId });
  }

  #admit(request: SpendCeilingTurnRequest): SpendCeilingAdmission {
    const threadScope: SpendCeilingScope = {
      kind: "thread",
      threadType: request.threadType,
      threadId: request.threadId,
    };
    const projectScope =
      request.projectId === undefined
        ? undefined
        : ({
            kind: "project" as const,
            projectId: request.projectId as never,
          } satisfies SpendCeilingScope);
    const thread = readSpendCeiling(this.#connection, threadScope);
    const project =
      projectScope === undefined ? undefined : readSpendCeiling(this.#connection, projectScope);
    if (thread === undefined && project === undefined) {
      return { status: "admitted", reservedTokens: 0, reservations: [] };
    }
    const childIds = [
      ...this.#childSubjectIds(request.threadId),
      ...(request.childSubjectIds ?? []),
    ];
    const threadFacts = thread === undefined ? undefined : this.#facts(thread, childIds);
    const projectFacts = project === undefined ? undefined : this.#facts(project, childIds);
    const admission = evaluateSpendCeilingAdmission({
      ...(threadFacts === undefined ? {} : { thread: threadFacts }),
      ...(projectFacts === undefined ? {} : { project: projectFacts }),
      ...(request.turnUpperBoundTokens === undefined
        ? {}
        : { turnUpperBoundTokens: request.turnUpperBoundTokens }),
    });
    if (admission.status !== "admitted" || admission.reservedTokens === 0) return admission;
    this.#reservations.set(String(request.reservationId), {
      reservationId: String(request.reservationId),
      reservedTokens: admission.reservedTokens,
      scopes: admission.reservations.map((reservation) => ({
        scopeKind: reservation.scopeKind,
        scopeId: reservation.scopeId,
      })),
    });
    return admission;
  }

  #remaining(ceiling: SpendCeilingState, facts: SpendCeilingScopeFacts): SpendCeilingRemaining {
    const { tokenBudget, turnBudget, runTimeBudgetSeconds, costBudgetUsdCents } = ceiling.policy;
    const tokens =
      tokenBudget === undefined || facts.committed.status !== "known"
        ? {}
        : {
            ceilingTokens: tokenBudget,
            committedTokens: facts.committed.tokens,
            reservedTokens: facts.reservedTokens,
            remainingTokens: remainingSpendCeilingTokens({
              tokenBudget,
              committedTokens: facts.committed.tokens,
              reservedTokens: facts.reservedTokens,
            }),
          };
    const turns =
      turnBudget === undefined || facts.usedTurns === undefined
        ? {}
        : {
            ceilingTurns: turnBudget,
            usedTurns: facts.usedTurns,
            remainingTurns: Math.max(0, turnBudget - facts.usedTurns),
          };
    const usedSeconds =
      facts.usedRunTimeMs === undefined ? undefined : Math.floor(facts.usedRunTimeMs / 1_000);
    const runTime =
      runTimeBudgetSeconds === undefined || usedSeconds === undefined
        ? {}
        : {
            ceilingRunTimeSeconds: runTimeBudgetSeconds,
            usedRunTimeSeconds: usedSeconds,
            remainingRunTimeSeconds: Math.max(0, runTimeBudgetSeconds - usedSeconds),
          };
    // A money budget whose window cannot be priced keeps its ceiling in the
    // reading without a used or remaining figure, so "cannot be measured" is
    // stated rather than the dimension silently missing.
    const money =
      costBudgetUsdCents === undefined
        ? {}
        : facts.usedCostUsdCents === undefined
          ? { ceilingUsdCents: costBudgetUsdCents }
          : {
              ceilingUsdCents: costBudgetUsdCents,
              usedUsdCents: facts.usedCostUsdCents,
              remainingUsdCents: Math.max(0, costBudgetUsdCents - facts.usedCostUsdCents),
            };
    return {
      ...tokens,
      ...turns,
      ...runTime,
      ...money,
      window: ceiling.window,
      ...(ceiling.overrun === undefined ? {} : { overrun: ceiling.overrun }),
      version: ceiling.version,
    };
  }

  #facts(ceiling: SpendCeilingState, childIds: ReadonlyArray<string>): SpendCeilingScopeFacts {
    const now = decodeUtcTimestamp(this.#clock());
    const from = spendCeilingWindowStart(ceiling.window, now);
    const committed: SpendTokenTotal =
      ceiling.policy.tokenBudget === undefined
        ? { status: "known", tokens: 0 }
        : this.#committedSpend(ceiling.scope, childIds, from);
    const needsTurns =
      ceiling.policy.turnBudget !== undefined || ceiling.policy.runTimeBudgetSeconds !== undefined;
    const used = needsTurns ? this.#turnUse(ceiling.scope, from, now) : undefined;
    const cost =
      ceiling.policy.costBudgetUsdCents === undefined
        ? undefined
        : this.#costUse(ceiling.scope, childIds, from);
    return {
      scopeKind: ceiling.scope.kind,
      scopeId:
        ceiling.scope.kind === "project"
          ? String(ceiling.scope.projectId)
          : String(ceiling.scope.threadId),
      policy: ceiling.policy,
      committed,
      reservedTokens: this.#reservedFor(ceiling.scope),
      ...(ceiling.overrun === undefined ? {} : { overrun: ceiling.overrun }),
      ...(used === undefined ? {} : { usedTurns: used.turns, usedRunTimeMs: used.runTimeMs }),
      ...(cost === undefined ? {} : { usedCostUsdCents: cost }),
    };
  }

  /**
   * Settled US-dollar spend in the window, in whole cents. Undefined when any
   * in-window record is unpriced or the sum cannot be measured: a monetary
   * ceiling then refuses rather than counting unpriced usage as free.
   */
  #costUse(
    scope: SpendCeilingScope,
    childIds: ReadonlyArray<string>,
    from: string | undefined,
  ): number | undefined {
    const subjects = ledgerSubjects(scope, childIds);
    if (subjects.length === 0 && scope.kind !== "project") return undefined;
    const conditions: Array<string> = [];
    const params: Array<string | number> = [];
    if (subjects.length > 0) {
      const subjectTerms = subjects.map(() => "(subject_type = ? AND subject_id = ?)");
      conditions.push(`(${subjectTerms.join(" OR ")})`);
      for (const subject of subjects) params.push(subject.type, subject.id);
    }
    if (scope.kind === "project") {
      conditions.push(usageProjectConditionSql(1));
      params.push(...usageProjectConditionParams([String(scope.projectId)]));
    }
    if (conditions.length === 0) return undefined;
    const clauses = [`(${conditions.join(" OR ")})`];
    if (from !== undefined) {
      clauses.push("observed_at >= ?");
      params.push(from);
    }
    let row: { readonly unpriced: number; readonly micros: number } | undefined;
    try {
      row = this.#connection
        .prepare(
          `SELECT
            COALESCE(SUM(CASE WHEN cost_usd_micros IS NULL THEN 1 ELSE 0 END), 0) AS unpriced,
            COALESCE(SUM(cost_usd_micros), 0) AS micros
          FROM usage_record_projection
          WHERE ${clauses.join(" AND ")}`,
        )
        .get(...params) as { readonly unpriced: number; readonly micros: number } | undefined;
    } catch {
      return undefined;
    }
    if (row === undefined || row.unpriced > 0) return undefined;
    if (!Number.isSafeInteger(row.micros) || row.micros < 0) return undefined;
    // Whole cents: a partial cent of estimated spend still counts against the
    // ceiling once it reaches one cent.
    return Math.floor(row.micros / 10_000);
  }

  /**
   * Settled turns in the window plus every in-flight turn, whose elapsed time
   * so far counts so concurrent turns cannot each start against the same
   * remaining run time.
   */
  #turnUse(scope: SpendCeilingScope, from: string | undefined, now: string): TurnUse | undefined {
    const column = scope.kind === "project" ? "project_id" : "thread_id";
    const id = scope.kind === "project" ? String(scope.projectId) : String(scope.threadId);
    let row: { readonly turns: number; readonly run_time_ms: number } | undefined;
    try {
      row = this.#connection
        .prepare(
          `SELECT COUNT(*) AS turns, COALESCE(SUM(run_time_ms), 0) AS run_time_ms
          FROM spend_turn_projection
          WHERE ${column} = ?${from === undefined ? "" : " AND settled_at >= ?"}`,
        )
        .get(...(from === undefined ? [id] : [id, from])) as
        | { readonly turns: number; readonly run_time_ms: number }
        | undefined;
    } catch {
      return undefined;
    }
    if (row === undefined) return undefined;
    let turns = row.turns;
    let runTimeMs = row.run_time_ms;
    const nowMs = Date.parse(now);
    for (const turn of this.#turns.values()) {
      const matches = scope.kind === "project" ? turn.projectId === id : turn.threadId === id;
      if (!matches) continue;
      turns += 1;
      runTimeMs += Math.max(0, nowMs - Date.parse(turn.startedAt));
    }
    if (!Number.isSafeInteger(turns) || !Number.isSafeInteger(runTimeMs)) return undefined;
    return { turns, runTimeMs };
  }

  #recordTurn(reservationId: SpendCeilingReservationId): void {
    const turn = this.#turns.get(String(reservationId));
    if (turn === undefined) return;
    this.#turns.delete(String(reservationId));
    const settledAt = decodeUtcTimestamp(this.#clock());
    this.#appendTo(
      SPEND_TURN_AGGREGATE_TYPE,
      String(reservationId),
      0,
      SPEND_CEILING_EVENT_NAMES.turnRecorded,
      {
        reservationId,
        threadType: turn.threadType,
        threadId: turn.threadId,
        ...(turn.projectId === undefined ? {} : { projectId: turn.projectId }),
        startedAt: decodeUtcTimestamp(turn.startedAt),
        settledAt,
        runTimeMs: Math.max(0, Date.parse(settledAt) - Date.parse(turn.startedAt)),
      },
    );
  }

  #committedSpend(
    scope: SpendCeilingScope,
    childIds: ReadonlyArray<string>,
    from: string | undefined,
  ): SpendTokenTotal {
    const subjects = ledgerSubjects(scope, childIds);
    return sumUsageTokens(this.#connection, {
      subjects,
      ...(scope.kind === "project" ? { projectId: String(scope.projectId) } : {}),
      ...(from === undefined ? {} : { from }),
    });
  }

  #childSubjectIds(parentThreadId: string): ReadonlyArray<string> {
    if (this.#agentRuns === undefined) return [];
    try {
      return this.#agentRuns
        .parentSummary(parentThreadId as never)
        .map((entry) => String(entry.runId));
    } catch {
      return [];
    }
  }

  #reservedFor(scope: SpendCeilingScope): number {
    const id = scope.kind === "project" ? String(scope.projectId) : String(scope.threadId);
    let total = 0;
    for (const live of this.#reservations.values()) {
      if (live.scopes.some((item) => item.scopeKind === scope.kind && item.scopeId === id)) {
        total += live.reservedTokens;
      }
    }
    return total;
  }

  #scopeExists(scope: SpendCeilingScope): boolean {
    if (scope.kind === "project") {
      return this.#projectExists?.(String(scope.projectId)) ?? true;
    }
    return (
      this.#threadExists?.({ threadType: scope.threadType, threadId: String(scope.threadId) }) ??
      true
    );
  }

  #recordOverrun(
    scope: { readonly scopeKind: "project" | "thread"; readonly scopeId: string },
    reservedTokens: number,
    observedTokens: number,
  ): void {
    const current =
      scope.scopeKind === "project"
        ? readSpendCeiling(this.#connection, {
            kind: "project",
            projectId: scope.scopeId as never,
          })
        : (readSpendCeiling(this.#connection, {
            kind: "thread",
            threadType: "chat-thread",
            threadId: scope.scopeId,
          }) ??
          readSpendCeiling(this.#connection, {
            kind: "thread",
            threadType: "work-thread",
            threadId: scope.scopeId,
          }) ??
          readSpendCeiling(this.#connection, {
            kind: "thread",
            threadType: "code-thread",
            threadId: scope.scopeId,
          }));
    if (current === undefined || current.overrun !== undefined) return;
    this.#append(current.scope, current.version, SPEND_CEILING_EVENT_NAMES.overrunRecorded, {
      scope: current.scope,
      reservedTokens,
      observedTokens,
      recordedAt: decodeUtcTimestamp(this.#clock()),
    });
  }

  #aggregateVersion(scope: SpendCeilingScope): number {
    const row = this.#connection
      .prepare(
        "SELECT aggregate_version FROM aggregate_heads WHERE aggregate_type = ? AND aggregate_id = ?",
      )
      .get(SPEND_CEILING_AGGREGATE_TYPE, spendCeilingAggregateId(scope)) as
      | { readonly aggregate_version: number }
      | undefined;
    return row?.aggregate_version ?? 0;
  }

  #append(
    scope: SpendCeilingScope,
    expectedVersion: number,
    eventName: string,
    payload: unknown,
  ): void {
    this.#appendTo(
      SPEND_CEILING_AGGREGATE_TYPE,
      spendCeilingAggregateId(scope),
      expectedVersion,
      eventName,
      payload,
    );
  }

  #appendTo(
    aggregateType: string,
    aggregateId: string,
    expectedVersion: number,
    eventName: string,
    payload: unknown,
  ): void {
    this.#journal.append({
      aggregate: { aggregateType, aggregateId },
      expectedVersion,
      events: [
        {
          eventId: decodeEventId(this.#uuid()),
          eventName,
          eventVersion: 1,
          hostId: LOCAL_HOST_ID,
          correlationId: decodeCorrelationId(this.#uuid()),
          actor: { kind: "local-user" as const, actorId: LOCAL_ACTOR_ID },
          occurredAt: decodeUtcTimestamp(this.#clock()),
          payload,
        },
      ],
    });
  }
}

/**
 * The usage subjects a thread ceiling counts by identity: the thread and its
 * child runs. A Project ceiling names none, because the Project predicate
 * already places every thread of the Project and every child run whose parent
 * belongs to it, including children of threads other than the one admitting.
 */
function ledgerSubjects(
  scope: SpendCeilingScope,
  childIds: ReadonlyArray<string>,
): Array<{ readonly type: string; readonly id: string }> {
  if (scope.kind === "project") return [];
  return [
    { type: scope.threadType, id: String(scope.threadId) },
    ...childIds.map((id) => ({ type: "agent-run", id })),
  ];
}

function sumUsageTokens(
  connection: SqliteConnection,
  input: {
    readonly subjects: ReadonlyArray<{ readonly type: string; readonly id: string }>;
    readonly projectId?: string;
    readonly from?: string;
  },
): SpendTokenTotal {
  const conditions: Array<string> = [];
  const params: Array<string | number> = [];
  if (input.subjects.length > 0) {
    const subjectTerms = input.subjects.map(() => "(subject_type = ? AND subject_id = ?)");
    conditions.push(`(${subjectTerms.join(" OR ")})`);
    for (const subject of input.subjects) {
      params.push(subject.type, subject.id);
    }
  }
  if (input.projectId !== undefined) {
    conditions.push(usageProjectConditionSql(1));
    params.push(...usageProjectConditionParams([input.projectId]));
  }
  if (conditions.length === 0) return { status: "known", tokens: 0 };
  const scopeWhere = conditions.join(" OR ");
  const clauses = [`(${scopeWhere})`];
  if (input.from !== undefined) {
    clauses.push("observed_at >= ?");
    params.push(input.from);
  }
  const where = clauses.join(" AND ");
  const row = connection
    .prepare(
      `SELECT
        COALESCE(SUM(CASE WHEN quality = 'unavailable' THEN 1 ELSE 0 END), 0) AS unavailable_count,
        COALESCE(SUM(input_tokens + output_tokens + COALESCE(reasoning_tokens, 0)), 0) AS tokens
      FROM usage_record_projection
      WHERE ${where}`,
    )
    .get(...params) as { readonly unavailable_count: number; readonly tokens: number } | undefined;
  if (row === undefined) return { status: "known", tokens: 0 };
  if (row.unavailable_count > 0) return { status: "unavailable" };
  if (!Number.isSafeInteger(row.tokens) || row.tokens < 0) return { status: "unknowable" };
  return { status: "known", tokens: row.tokens };
}

export function formatSpendCeilingRefusal(refusal: SpendCeilingRefusal): string {
  return refusal.message;
}

export { decodeSpendCeilingReservationId };

function spendCeilingAggregateId(scope: SpendCeilingScope): string {
  return scope.kind === "project" ? String(scope.projectId) : String(scope.threadId);
}
