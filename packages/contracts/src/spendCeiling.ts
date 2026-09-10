import { Schema } from "effect";
import { AggregateVersion, EventActor, UtcTimestamp } from "./events";
import { ProjectId } from "./projects";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));
const PositiveInt = Schema.Int.pipe(Schema.positive());
const NonNegativeInt = Schema.Int.pipe(Schema.nonNegative());

export const SpendCeilingReservationId = brandedUuid("SpendCeilingReservationId");
export type SpendCeilingReservationId = typeof SpendCeilingReservationId.Type;

export const SpendCeilingThreadType = Schema.Literal("chat-thread", "work-thread", "code-thread");
export type SpendCeilingThreadType = typeof SpendCeilingThreadType.Type;

export const SpendCeilingScope = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("project"),
    projectId: ProjectId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("thread"),
    threadType: SpendCeilingThreadType,
    threadId: Schema.UUID,
  }).annotations(strict),
);
export type SpendCeilingScope = typeof SpendCeilingScope.Type;

/**
 * IANA time zone used for a Project calendar window. Invalid identifiers fail
 * closed so a ceiling never counts against the wrong day.
 */
export const SpendCeilingTimeZone = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(64),
  Schema.filter((value) => {
    try {
      Intl.DateTimeFormat("en-US", { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  }),
);
export type SpendCeilingTimeZone = typeof SpendCeilingTimeZone.Type;

export const SpendCeilingCalendarPeriod = Schema.Literal("day", "week", "month");
export type SpendCeilingCalendarPeriod = typeof SpendCeilingCalendarPeriod.Type;

export const SpendCeilingWindow = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("lifetime") }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("calendar"),
    period: SpendCeilingCalendarPeriod,
    timeZone: SpendCeilingTimeZone,
  }).annotations(strict),
);
export type SpendCeilingWindow = typeof SpendCeilingWindow.Type;

/**
 * Optional host token ceiling. Time, turn, and monetary fields stay off this
 * first slice: token enforcement is the only dimension that has a ledger.
 */
export const SpendCeilingPolicy = Schema.Struct({
  tokenBudget: PositiveInt,
  /**
   * Configured per-turn maximum used when a turn has no scheduler estimate.
   * Absent means the caller must supply a bound or admission refuses.
   */
  maxTokensPerTurn: Schema.optional(PositiveInt),
}).annotations(strict);
export type SpendCeilingPolicy = typeof SpendCeilingPolicy.Type;

export const SpendCeilingOverrun = Schema.Struct({
  reservedTokens: NonNegativeInt,
  observedTokens: NonNegativeInt,
  recordedAt: UtcTimestamp,
}).annotations(strict);
export type SpendCeilingOverrun = typeof SpendCeilingOverrun.Type;

export const SpendCeilingState = Schema.Struct({
  scope: SpendCeilingScope,
  window: SpendCeilingWindow,
  policy: SpendCeilingPolicy,
  version: AggregateVersion,
  setAt: UtcTimestamp,
  setBy: EventActor,
  overrun: Schema.optional(SpendCeilingOverrun),
}).annotations(strict);
export type SpendCeilingState = typeof SpendCeilingState.Type;

const SpendCeilingCommandFields = {
  scope: SpendCeilingScope,
  expectedVersion: AggregateVersion,
} as const;

export const SetSpendCeilingCommand = Schema.Struct({
  kind: Schema.Literal("set-spend-ceiling"),
  ...SpendCeilingCommandFields,
  policy: SpendCeilingPolicy,
  window: SpendCeilingWindow,
}).annotations(strict);
export type SetSpendCeilingCommand = typeof SetSpendCeilingCommand.Type;

export const RaiseSpendCeilingCommand = Schema.Struct({
  kind: Schema.Literal("raise-spend-ceiling"),
  ...SpendCeilingCommandFields,
  tokenBudget: PositiveInt,
}).annotations(strict);
export type RaiseSpendCeilingCommand = typeof RaiseSpendCeilingCommand.Type;

export const ClearSpendCeilingCommand = Schema.Struct({
  kind: Schema.Literal("clear-spend-ceiling"),
  ...SpendCeilingCommandFields,
}).annotations(strict);
export type ClearSpendCeilingCommand = typeof ClearSpendCeilingCommand.Type;

export const SpendCeilingCommand = Schema.Union(
  SetSpendCeilingCommand,
  RaiseSpendCeilingCommand,
  ClearSpendCeilingCommand,
);
export type SpendCeilingCommand = typeof SpendCeilingCommand.Type;

export const SpendCeilingSet = Schema.Struct({
  ceiling: SpendCeilingState,
}).annotations(strict);
export type SpendCeilingSet = typeof SpendCeilingSet.Type;

export const SpendCeilingRaised = Schema.Struct({
  ceiling: SpendCeilingState,
  previousTokenBudget: PositiveInt,
}).annotations(strict);
export type SpendCeilingRaised = typeof SpendCeilingRaised.Type;

export const SpendCeilingCleared = Schema.Struct({
  scope: SpendCeilingScope,
  clearedAt: UtcTimestamp,
}).annotations(strict);
export type SpendCeilingCleared = typeof SpendCeilingCleared.Type;

export const SpendCeilingOverrunRecorded = Schema.Struct({
  scope: SpendCeilingScope,
  reservedTokens: NonNegativeInt,
  observedTokens: NonNegativeInt,
  recordedAt: UtcTimestamp,
}).annotations(strict);
export type SpendCeilingOverrunRecorded = typeof SpendCeilingOverrunRecorded.Type;

export const SPEND_CEILING_AGGREGATE_TYPE = "spend-ceiling";

export const SPEND_CEILING_EVENT_NAMES = {
  set: "spend.ceiling-set@1",
  raised: "spend.ceiling-raised@1",
  cleared: "spend.ceiling-cleared@1",
  overrunRecorded: "spend.overrun-recorded@1",
} as const;

export const SpendCeilingRefusalKind = Schema.Literal(
  "exhausted",
  "unknown-spend",
  "missing-turn-bound",
  "overrun",
);
export type SpendCeilingRefusalKind = typeof SpendCeilingRefusalKind.Type;

export const SpendCeilingRecovery = Schema.Literal(
  "raise-ceiling",
  "clear-ceiling",
  "open-usage",
  "pause-work",
);
export type SpendCeilingRecovery = typeof SpendCeilingRecovery.Type;

/**
 * Hard-ceiling refuse a person can act on. Names the scope, the exhausted
 * token dimension, remaining or overrun when known, and the recovery.
 */
export const SpendCeilingRefusal = Schema.Struct({
  kind: SpendCeilingRefusalKind,
  scopeKind: Schema.Literal("project", "thread"),
  scopeId: Schema.UUID,
  dimension: Schema.Literal("tokens"),
  remainingTokens: Schema.optional(NonNegativeInt),
  overrunTokens: Schema.optional(PositiveInt),
  ceilingTokens: Schema.optional(PositiveInt),
  recovery: Schema.Array(SpendCeilingRecovery).pipe(Schema.minItems(1), Schema.maxItems(4)),
  message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1_024)),
}).annotations(strict);
export type SpendCeilingRefusal = typeof SpendCeilingRefusal.Type;

export const SpendCeilingRemaining = Schema.Struct({
  ceilingTokens: PositiveInt,
  committedTokens: NonNegativeInt,
  reservedTokens: NonNegativeInt,
  remainingTokens: NonNegativeInt,
  window: SpendCeilingWindow,
  overrun: Schema.optional(SpendCeilingOverrun),
  version: AggregateVersion,
}).annotations(strict);
export type SpendCeilingRemaining = typeof SpendCeilingRemaining.Type;

export const SpendCeilingSnapshot = Schema.Struct({
  thread: Schema.optional(SpendCeilingState),
  project: Schema.optional(SpendCeilingState),
  threadRemaining: Schema.optional(SpendCeilingRemaining),
  projectRemaining: Schema.optional(SpendCeilingRemaining),
  refusal: Schema.optional(SpendCeilingRefusal),
}).annotations(strict);
export type SpendCeilingSnapshot = typeof SpendCeilingSnapshot.Type;

export const SpendCeilingCommandRefusalKind = Schema.Literal(
  "unauthorized",
  "unknown-scope",
  "version-conflict",
  "ceiling-not-set",
  "not-a-raise",
  "invalid-window",
);
export type SpendCeilingCommandRefusalKind = typeof SpendCeilingCommandRefusalKind.Type;

export const SpendCeilingCommandRefusal = Schema.Struct({
  kind: SpendCeilingCommandRefusalKind,
  message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1_024)),
}).annotations(strict);
export type SpendCeilingCommandRefusal = typeof SpendCeilingCommandRefusal.Type;

export const SpendCeilingCommandResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("set"),
    ceiling: SpendCeilingState,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("raised"),
    ceiling: SpendCeilingState,
    previousTokenBudget: PositiveInt,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("cleared"),
    scope: SpendCeilingScope,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    refusal: SpendCeilingCommandRefusal,
  }).annotations(strict),
);
export type SpendCeilingCommandResult = typeof SpendCeilingCommandResult.Type;

export const decodeSpendCeilingThreadType = Schema.decodeUnknownSync(SpendCeilingThreadType);
export const decodeSpendCeilingReservationId = Schema.decodeUnknownSync(SpendCeilingReservationId);
export const decodeSpendCeilingScope = Schema.decodeUnknownSync(SpendCeilingScope);
export const decodeSpendCeilingWindow = Schema.decodeUnknownSync(SpendCeilingWindow);
export const decodeSpendCeilingPolicy = Schema.decodeUnknownSync(SpendCeilingPolicy);
export const decodeSpendCeilingState = Schema.decodeUnknownSync(SpendCeilingState);
export const decodeSpendCeilingCommand = Schema.decodeUnknownSync(SpendCeilingCommand);
export const decodeSpendCeilingSet = Schema.decodeUnknownSync(SpendCeilingSet);
export const decodeSpendCeilingRaised = Schema.decodeUnknownSync(SpendCeilingRaised);
export const decodeSpendCeilingCleared = Schema.decodeUnknownSync(SpendCeilingCleared);
export const decodeSpendCeilingOverrunRecorded = Schema.decodeUnknownSync(
  SpendCeilingOverrunRecorded,
);
export const decodeSpendCeilingRefusal = Schema.decodeUnknownSync(SpendCeilingRefusal);
export const decodeSpendCeilingSnapshot = Schema.decodeUnknownSync(SpendCeilingSnapshot);
export const decodeSpendCeilingCommandRefusal = Schema.decodeUnknownSync(
  SpendCeilingCommandRefusal,
);
export const decodeSpendCeilingCommandResult = Schema.decodeUnknownSync(SpendCeilingCommandResult);
