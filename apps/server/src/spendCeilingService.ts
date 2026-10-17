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
  type ProviderInstance,
  type ProviderInstanceId,
  type ProviderObservedState,
  type SpendCeilingCommand,
  type SpendCeilingCommandResult,
  type SpendCeilingNotMeasuredProvider,
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
  providerUsageIsNotMeasured,
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
  /**
   * False for spend that is not a turn of its own, such as a requested context
   * compaction: its tokens count against the ceilings, but it uses up no turn
   * and no run time.
   */
  readonly countsAsTurn?: boolean;
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
  /**
   * The provider a ledger row names, when its unreported turns are not
   * measured: the instance if it exists and its runtime declares it never
   * reports usage, otherwise undefined and its unreported turns keep refusing
   * as unknown spend. Absent, every provider counts.
   */
  readonly notMeasuredProvider?: (
    providerInstanceId: string,
  ) => SpendCeilingNotMeasuredProvider | undefined;
}

/**
 * Whether a ledger row's provider is left out of token and money ceilings,
 * decided by provider, not by row: by the instance's runtime usage capability
 * as the host observes it now, for old rows too. A removed or disabled
 * instance, or one with no observation yet, counts, so its unreported turns
 * keep refusing. Disabling a provider with a live session leaves its last
 * observation in place, so the enabled flag is checked here rather than
 * trusted to have cleared it.
 */
export function notMeasuredProvider(
  host: {
    readonly readProviderInstances: () => ReadonlyArray<ProviderInstance>;
    readonly observedState: (instanceId: ProviderInstanceId) => ProviderObservedState | undefined;
  },
  providerInstanceId: string,
): SpendCeilingNotMeasuredProvider | undefined {
  const instance = host
    .readProviderInstances()
    .find((candidate) => String(candidate.id) === providerInstanceId);
  if (instance === undefined || !instance.enabled) return undefined;
  return providerUsageIsNotMeasured(host.observedState(instance.id)?.capabilities.usage)
    ? { providerInstanceId: instance.id, displayName: instance.displayName }
    : undefined;
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
  readonly #notMeasuredProvider: (
    providerInstanceId: string,
  ) => SpendCeilingNotMeasuredProvider | undefined;
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
    this.#notMeasuredProvider = options.notMeasuredProvider ?? (() => undefined);
  }

  snapshot(input: {
    readonly principalKind: PrincipalKind;
    readonly threadId?: string;
    readonly threadType?: SpendCeilingThreadType;
    readonly projectId?: string;
    /**
     * The spend this caller would reserve. Absent, the preview only asks
     * whether a single token would pass, which a compaction must not use: a
     * ceiling that can cover one token and not the summary would look open.
     */
    readonly turnUpperBoundTokens?: number;
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
        : this.#remaining(thread, threadFacts, childIds);
    const projectRemaining =
      project === undefined || projectFacts === undefined
        ? undefined
        : this.#remaining(project, projectFacts, childIds);
    const preview = evaluateSpendCeilingAdmission({
      ...(threadFacts === undefined ? {} : { thread: threadFacts }),
      ...(projectFacts === undefined ? {} : { project: projectFacts }),
      turnUpperBoundTokens: input.turnUpperBoundTokens ?? 1,
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
    if (admission.status === "admitted" && request.countsAsTurn !== false) {
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

  /**
   * Drops a reservation whose work never started. Settling would record the
   * admitted turn, which counts against turn and run-time ceilings, so a turn
   * that was refused before it began (a provider with no free slot, tried again
   * every few seconds) would use up the budget without running.
   */
  abandon(input: { readonly reservationId: SpendCeilingReservationId }): void {
    this.#turns.delete(String(input.reservationId));
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

  #remaining(
    ceiling: SpendCeilingState,
    facts: SpendCeilingScopeFacts,
    childIds: ReadonlyArray<string>,
  ): SpendCeilingRemaining {
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
    const notMeasured =
      tokenBudget === undefined && costBudgetUsdCents === undefined
        ? []
        : this.#notMeasuredProviders(ceiling, childIds);
    return {
      ...tokens,
      ...turns,
      ...runTime,
      ...money,
      ...(notMeasured.length === 0 ? {} : { notMeasuredProviders: notMeasured }),
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
    const where = ledgerWhere({
      subjects: ledgerSubjects(scope, childIds),
      ...(scope.kind === "project" ? { projectId: String(scope.projectId) } : {}),
      ...(from === undefined ? {} : { from }),
    });
    if (where === undefined) return undefined;
    let rows: ReadonlyArray<CostByProvider>;
    try {
      // Per provider, so the unreported turns of a provider that never
      // reports usage can be left out while a reported row with no price,
      // from any provider, still makes the money ceiling refuse.
      rows = this.#connection
        .prepare(
          `SELECT
            provider_instance_id,
            COALESCE(SUM(CASE WHEN cost_usd_micros IS NULL AND quality = 'unavailable' THEN 1 ELSE 0 END), 0) AS unreported,
            COALESCE(SUM(CASE WHEN cost_usd_micros IS NULL AND quality <> 'unavailable' THEN 1 ELSE 0 END), 0) AS unpriced,
            COALESCE(SUM(cost_usd_micros), 0) AS micros
          FROM usage_record_projection
          WHERE ${where.sql}
          GROUP BY provider_instance_id`,
        )
        .all(...where.params) as ReadonlyArray<CostByProvider>;
    } catch {
      return undefined;
    }
    let micros = 0;
    for (const row of rows) {
      if (row.unpriced > 0) return undefined;
      if (row.unreported > 0 && this.#notMeasuredProvider(row.provider_instance_id) === undefined) {
        return undefined;
      }
      micros += row.micros;
    }
    if (!Number.isSafeInteger(micros) || micros < 0) return undefined;
    // Whole cents: a partial cent of estimated spend still counts against the
    // ceiling once it reaches one cent.
    return Math.floor(micros / 10_000);
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
    return sumUsageTokens(
      this.#connection,
      {
        subjects,
        ...(scope.kind === "project" ? { projectId: String(scope.projectId) } : {}),
        ...(from === undefined ? {} : { from }),
      },
      (providerInstanceId) => this.#notMeasuredProvider(providerInstanceId) !== undefined,
    );
  }

  /**
   * The providers whose unreported turns this reading leaves out, named so a
   * surface can say the ceiling does not cover them. A provider whose usage
   * counts is never listed, even when it has unreported turns: those refuse.
   */
  #notMeasuredProviders(
    ceiling: SpendCeilingState,
    childIds: ReadonlyArray<string>,
  ): ReadonlyArray<SpendCeilingNotMeasuredProvider> {
    const from = spendCeilingWindowStart(ceiling.window, decodeUtcTimestamp(this.#clock()));
    const where = ledgerWhere({
      subjects: ledgerSubjects(ceiling.scope, childIds),
      ...(ceiling.scope.kind === "project" ? { projectId: String(ceiling.scope.projectId) } : {}),
      ...(from === undefined ? {} : { from }),
    });
    if (where === undefined) return [];
    let rows: ReadonlyArray<{ readonly provider_instance_id: string }>;
    try {
      rows = this.#connection
        .prepare(
          `SELECT DISTINCT provider_instance_id
          FROM usage_record_projection
          WHERE ${where.sql} AND quality = 'unavailable'
          ORDER BY provider_instance_id`,
        )
        .all(...where.params) as ReadonlyArray<{ readonly provider_instance_id: string }>;
    } catch {
      return [];
    }
    return rows.flatMap((row) => this.#notMeasuredProvider(row.provider_instance_id) ?? []);
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
 * child runs. A Project ceiling names none: the Project predicate places every
 * thread of the Project and every child run by its parent thread's current
 * Project, as the Usage dashboard does. The Project a run's route named at
 * delegation does not count, so a thread moved to another Project takes its
 * children's spend with it instead of charging both Projects.
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

interface CostByProvider {
  readonly provider_instance_id: string;
  readonly unreported: number;
  readonly unpriced: number;
  readonly micros: number;
}

/**
 * The ledger rows a ceiling counts: its subjects by identity, or the
 * Project's rows by the Project predicate, inside the window.
 */
function ledgerWhere(input: {
  readonly subjects: ReadonlyArray<{ readonly type: string; readonly id: string }>;
  readonly projectId?: string;
  readonly from?: string;
}): { readonly sql: string; readonly params: ReadonlyArray<string | number> } | undefined {
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
  if (conditions.length === 0) return undefined;
  const clauses = [`(${conditions.join(" OR ")})`];
  if (input.from !== undefined) {
    clauses.push("observed_at >= ?");
    params.push(input.from);
  }
  return { sql: clauses.join(" AND "), params };
}

function sumUsageTokens(
  connection: SqliteConnection,
  input: {
    readonly subjects: ReadonlyArray<{ readonly type: string; readonly id: string }>;
    readonly projectId?: string;
    readonly from?: string;
  },
  notMeasured: (providerInstanceId: string) => boolean,
): SpendTokenTotal {
  const where = ledgerWhere(input);
  if (where === undefined) return { status: "known", tokens: 0 };
  // Per provider: an unreported turn refuses as unknown spend unless its
  // provider never reports usage, whose turns the ceiling does not measure.
  const rows = connection
    .prepare(
      `SELECT
        provider_instance_id,
        COALESCE(SUM(CASE WHEN quality = 'unavailable' THEN 1 ELSE 0 END), 0) AS unavailable_count,
        COALESCE(SUM(input_tokens + output_tokens + COALESCE(reasoning_tokens, 0)), 0) AS tokens
      FROM usage_record_projection
      WHERE ${where.sql}
      GROUP BY provider_instance_id`,
    )
    .all(...where.params) as ReadonlyArray<{
    readonly provider_instance_id: string;
    readonly unavailable_count: number;
    readonly tokens: number;
  }>;
  let tokens = 0;
  for (const row of rows) {
    if (row.unavailable_count > 0 && !notMeasured(row.provider_instance_id)) {
      return { status: "unavailable" };
    }
    tokens += row.tokens;
  }
  if (!Number.isSafeInteger(tokens) || tokens < 0) return { status: "unknowable" };
  return { status: "known", tokens };
}

export function formatSpendCeilingRefusal(refusal: SpendCeilingRefusal): string {
  return refusal.message;
}

export { decodeSpendCeilingReservationId };

function spendCeilingAggregateId(scope: SpendCeilingScope): string {
  return scope.kind === "project" ? String(scope.projectId) : String(scope.threadId);
}
