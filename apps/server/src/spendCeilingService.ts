import {
  ActorId,
  CorrelationId,
  EventId,
  LOCAL_HOST_ID,
  SPEND_CEILING_AGGREGATE_TYPE,
  SPEND_CEILING_EVENT_NAMES,
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
 * Host-owned token spend ceilings. Policy is journaled; in-flight reservations
 * live in memory so a crash releases them instead of leaking capacity. Committed
 * spend is the existing usage projection, never imported provider history.
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
    const threadRemaining = thread === undefined ? undefined : this.#remaining(thread, childIds);
    const projectRemaining = project === undefined ? undefined : this.#remaining(project, childIds);
    const threadFacts = this.#facts(thread, threadRemaining);
    const projectFacts = this.#facts(project, projectRemaining);
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
    const decision = decideSpendCeilingCommand({
      principalKind,
      command,
      ...(current === undefined ? {} : { current }),
      scopeExists: this.#scopeExists(command.scope),
      now: decodeUtcTimestamp(this.#clock()),
      actor: { kind: "local-user", actorId: LOCAL_ACTOR_ID },
    });
    if (decision.status === "refused") {
      return { kind: "refused", refusal: decision.refusal };
    }
    if (decision.status === "cleared") {
      this.#append(command.scope, current?.version ?? 0, SPEND_CEILING_EVENT_NAMES.cleared, {
        scope: command.scope,
        clearedAt: decodeUtcTimestamp(this.#clock()),
      });
      return { kind: "cleared", scope: command.scope };
    }
    const eventName =
      command.kind === "raise-spend-ceiling"
        ? SPEND_CEILING_EVENT_NAMES.raised
        : SPEND_CEILING_EVENT_NAMES.set;
    this.#append(command.scope, current?.version ?? 0, eventName, {
      ceiling: decision.next,
      ...(decision.previousTokenBudget === undefined
        ? {}
        : { previousTokenBudget: decision.previousTokenBudget }),
    });
    return command.kind === "raise-spend-ceiling"
      ? {
          kind: "raised",
          ceiling: decision.next,
          previousTokenBudget: decision.previousTokenBudget ?? decision.next.policy.tokenBudget,
        }
      : { kind: "set", ceiling: decision.next };
  }

  admit(request: SpendCeilingTurnRequest): SpendCeilingAdmission {
    return this.#admit(request);
  }

  settle(input: {
    readonly reservationId: SpendCeilingReservationId;
    readonly observedTokens?: number;
  }): void {
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
    const threadRemaining = thread === undefined ? undefined : this.#remaining(thread, childIds);
    const projectRemaining = project === undefined ? undefined : this.#remaining(project, childIds);
    const threadFacts = this.#facts(thread, threadRemaining);
    const projectFacts = this.#facts(project, projectRemaining);
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
    childIds: ReadonlyArray<string>,
  ): SpendCeilingRemaining | undefined {
    const from = spendCeilingWindowStart(ceiling.window, decodeUtcTimestamp(this.#clock()));
    const committed = this.#committedSpend(ceiling.scope, childIds, from);
    if (committed.status !== "known") return undefined;
    const reservedTokens = this.#reservedFor(ceiling.scope);
    return {
      ceilingTokens: ceiling.policy.tokenBudget,
      committedTokens: committed.tokens,
      reservedTokens,
      remainingTokens: remainingSpendCeilingTokens({
        tokenBudget: ceiling.policy.tokenBudget,
        committedTokens: committed.tokens,
        reservedTokens,
      }),
      window: ceiling.window,
      ...(ceiling.overrun === undefined ? {} : { overrun: ceiling.overrun }),
      version: ceiling.version,
    };
  }

  #facts(
    ceiling: SpendCeilingState | undefined,
    remaining: SpendCeilingRemaining | undefined,
  ): SpendCeilingScopeFacts | undefined {
    if (ceiling === undefined) return undefined;
    const committed: SpendTokenTotal =
      remaining === undefined
        ? { status: "unavailable" }
        : { status: "known", tokens: remaining.committedTokens };
    return {
      scopeKind: ceiling.scope.kind,
      scopeId:
        ceiling.scope.kind === "project"
          ? String(ceiling.scope.projectId)
          : String(ceiling.scope.threadId),
      policy: ceiling.policy,
      committed,
      reservedTokens: remaining?.reservedTokens ?? this.#reservedFor(ceiling.scope),
      ...(ceiling.overrun === undefined ? {} : { overrun: ceiling.overrun }),
    };
  }

  #committedSpend(
    scope: SpendCeilingScope,
    childIds: ReadonlyArray<string>,
    from: string | undefined,
  ): SpendTokenTotal {
    const subjects: Array<{ readonly type: string; readonly id: string }> = [];
    if (scope.kind === "thread") {
      subjects.push({ type: scope.threadType, id: String(scope.threadId) });
    }
    for (const id of childIds) subjects.push({ type: "agent-run", id });
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

  #append(
    scope: SpendCeilingScope,
    expectedVersion: number,
    eventName: string,
    payload: unknown,
  ): void {
    const aggregateId = scope.kind === "project" ? String(scope.projectId) : String(scope.threadId);
    this.#journal.append({
      aggregate: {
        aggregateType: SPEND_CEILING_AGGREGATE_TYPE,
        aggregateId,
      },
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
