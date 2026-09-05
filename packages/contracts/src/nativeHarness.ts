/**
 * A native-harness session: Octant's own agent loop over a direct or local
 * endpoint model.
 *
 * The session introduces no new place where work happens. It runs inside an
 * ordinary thread, journals like every other aggregate, and the server keeps
 * persistence, credentials, tools, sandbox, and capacity. What lives here is
 * the vocabulary the loop, its supervisor, and every surface share: what a
 * turn was, why it stopped, how the request was shrunk, what the advisor did,
 * and what the lead suggests doing next.
 *
 * Nothing here grants anything. An advisor intervention has no field for a
 * tool call or an edit, a follow-up suggestion creates nothing until a person
 * confirms it, and a carried note cannot cross a context cut without a
 * pointer at durable evidence.
 */

import { Schema } from "effect";
import { ContextConfidence } from "./context";
import { AggregateVersion, UtcTimestamp } from "./events";
import { ThreadGoalEvidenceRef } from "./goal";
import { OctantMode } from "./modes";
import {
  NativeHarnessJob,
  NativeHarnessRouteDecision,
  NativeHarnessSlotCandidate,
  NativeHarnessSlotId,
} from "./nativeHarnessRouting";
import { ProjectId } from "./projects";
import { ThreadPlanStepId } from "./threadPlan";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));
const NonNegativeInt = Schema.Int.pipe(Schema.nonNegative());
const PositiveInt = Schema.Int.pipe(Schema.positive());

export const NativeHarnessSessionId = brandedUuid("NativeHarnessSessionId");
export type NativeHarnessSessionId = typeof NativeHarnessSessionId.Type;
export const NativeHarnessTurnId = brandedUuid("NativeHarnessTurnId");
export type NativeHarnessTurnId = typeof NativeHarnessTurnId.Type;

// ── Tools ────────────────────────────────────────────────────────────────────

/**
 * Every tool the harness may offer a model. The nine working tools are the
 * whole mutation and search surface; the last three are harness reads that
 * let the lead pace itself, recover cut history, and ask the advisor.
 */
export const NATIVE_HARNESS_TOOL_NAMES = [
  "read",
  "grep",
  "glob",
  "bash",
  "edit",
  "write",
  "web-fetch",
  "web-search",
  "todo-write",
  "context-remaining",
  "journal-lookup",
  "second-opinion",
] as const;
export const NativeHarnessToolName = Schema.Literal(...NATIVE_HARNESS_TOOL_NAMES);
export type NativeHarnessToolName = typeof NativeHarnessToolName.Type;

/**
 * Every tool result is hard-capped, and a cap is never silent: a truncated
 * result says how much was left out and where to continue.
 */
export const NativeHarnessToolResultBounds = Schema.Struct({
  truncated: Schema.Boolean,
  returnedBytes: NonNegativeInt,
  omittedBytes: Schema.optional(PositiveInt),
  nextOffset: Schema.optional(PositiveInt),
})
  .annotations(strict)
  .pipe(
    Schema.filter((bounds) =>
      bounds.truncated
        ? bounds.omittedBytes !== undefined && bounds.nextOffset !== undefined
        : bounds.omittedBytes === undefined && bounds.nextOffset === undefined,
    ),
  );
export type NativeHarnessToolResultBounds = typeof NativeHarnessToolResultBounds.Type;

/**
 * What `context-remaining` returns. Sourced from the authoritative capacity
 * planner, never estimated by the loop, so the lead can checkpoint before a
 * cut instead of being surprised by one.
 */
export const NativeHarnessContextRemaining = Schema.Struct({
  safeInputBudgetTokens: PositiveInt,
  usedTokens: NonNegativeInt,
  remainingTokens: NonNegativeInt,
  confidence: ContextConfidence,
  source: Schema.Literal("capacity-planner"),
  measuredAt: UtcTimestamp,
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (remaining) =>
        remaining.usedTokens <= remaining.safeInputBudgetTokens &&
        remaining.remainingTokens === remaining.safeInputBudgetTokens - remaining.usedTokens,
    ),
  );
export type NativeHarnessContextRemaining = typeof NativeHarnessContextRemaining.Type;

export const MAX_NATIVE_HARNESS_JOURNAL_LOOKUP_ENTRIES = 200;
export const MAX_NATIVE_HARNESS_JOURNAL_LOOKUP_BYTES = 262_144;
const MAX_JOURNAL_LOOKUP_SELECTORS = 32;

/** A bounded read of this thread's own lossless journal, never another's. */
export const NativeHarnessJournalLookupRequest = Schema.Struct({
  selector: Schema.Union(
    Schema.Struct({
      kind: Schema.Literal("turn-range"),
      fromSequence: PositiveInt,
      toSequence: PositiveInt,
    })
      .annotations(strict)
      .pipe(Schema.filter((range) => range.fromSequence <= range.toSequence)),
    Schema.Struct({
      kind: Schema.Literal("turn-ids"),
      turnIds: Schema.Array(NativeHarnessTurnId).pipe(
        Schema.minItems(1),
        Schema.maxItems(MAX_JOURNAL_LOOKUP_SELECTORS),
      ),
    }).annotations(strict),
    Schema.Struct({
      kind: Schema.Literal("artifact-refs"),
      references: Schema.Array(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256))).pipe(
        Schema.minItems(1),
        Schema.maxItems(MAX_JOURNAL_LOOKUP_SELECTORS),
      ),
    }).annotations(strict),
  ),
  maxEntries: PositiveInt.pipe(Schema.lessThanOrEqualTo(MAX_NATIVE_HARNESS_JOURNAL_LOOKUP_ENTRIES)),
  maxBytes: PositiveInt.pipe(Schema.lessThanOrEqualTo(MAX_NATIVE_HARNESS_JOURNAL_LOOKUP_BYTES)),
}).annotations(strict);
export type NativeHarnessJournalLookupRequest = typeof NativeHarnessJournalLookupRequest.Type;

export const NativeHarnessJournalLookupEntry = Schema.Struct({
  sequence: PositiveInt,
  turnId: Schema.optional(NativeHarnessTurnId),
  role: Schema.Literal("user", "assistant", "tool"),
  text: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(8_192)),
}).annotations(strict);
export type NativeHarnessJournalLookupEntry = typeof NativeHarnessJournalLookupEntry.Type;

export const NativeHarnessJournalLookupResult = Schema.Struct({
  status: Schema.Literal("complete", "truncated", "stale", "unavailable"),
  entries: Schema.Array(NativeHarnessJournalLookupEntry).pipe(
    Schema.maxItems(MAX_NATIVE_HARNESS_JOURNAL_LOOKUP_ENTRIES),
  ),
  returnedBytes: NonNegativeInt,
})
  .annotations(strict)
  // An unavailable lookup returned nothing; saying otherwise would let a
  // partial read masquerade as an answer.
  .pipe(Schema.filter((result) => result.status !== "unavailable" || result.entries.length === 0));
export type NativeHarnessJournalLookupResult = typeof NativeHarnessJournalLookupResult.Type;

// ── Context reduction ────────────────────────────────────────────────────────

/**
 * A claim that survives a context cut. Prose like "we fixed auth" does not
 * cross the cut; a claim crosses only when it points at something durable a
 * later reader can check.
 */
export const NativeHarnessCarriedNote = Schema.Struct({
  claim: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  anchor: Schema.Union(
    Schema.Struct({ kind: Schema.Literal("plan-step"), stepId: ThreadPlanStepId }).annotations(
      strict,
    ),
    Schema.Struct({
      kind: Schema.Literal("goal-evidence"),
      evidence: ThreadGoalEvidenceRef,
    }).annotations(strict),
    Schema.Struct({
      kind: Schema.Literal("artifact"),
      artifactId: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
    }).annotations(strict),
    Schema.Struct({
      kind: Schema.Literal("file-hash"),
      path: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1_024)),
      sha256: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/)),
    }).annotations(strict),
  ),
}).annotations(strict);
export type NativeHarnessCarriedNote = typeof NativeHarnessCarriedNote.Type;

const ReductionFields = {
  turnId: NativeHarnessTurnId,
  requiredTokens: PositiveInt,
  windowTokens: PositiveInt,
  freedTokens: PositiveInt,
  reducedAt: UtcTimestamp,
} as const;

/**
 * How the assembled request was shrunk. The order is fixed — prune, then
 * cutover, then summary as last resort — and none of them touches the durable
 * journal; they change only what the next request contains.
 */
export const NativeHarnessContextReduction = Schema.Union(
  Schema.Struct({
    ...ReductionFields,
    kind: Schema.Literal("prune"),
    prunedToolResults: PositiveInt,
  }).annotations(strict),
  Schema.Struct({
    ...ReductionFields,
    kind: Schema.Literal("cutover"),
    droppedTurns: PositiveInt,
    boundary: Schema.Literal("turn", "tool-call-group"),
    /**
     * A cut drops the oldest turns of the mutable history, which invalidates
     * the provider prefix cache for everything after the cut point. That cost
     * is paid once per cut and recorded here so it is visible, not guessed.
     */
    cachePrefixInvalidated: Schema.Literal(true),
    carriedNotes: Schema.Array(NativeHarnessCarriedNote).pipe(Schema.maxItems(64)),
  }).annotations(strict),
  Schema.Struct({
    ...ReductionFields,
    kind: Schema.Literal("summary"),
    summarizedTurns: PositiveInt,
    /** Summaries run on `smol`, never on the lead's slot. */
    slotId: NativeHarnessSlotId,
    /** Where the attributed summary text is stored; it is never journaled. */
    reference: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2_048)),
  }).annotations(strict),
);
export type NativeHarnessContextReduction = typeof NativeHarnessContextReduction.Type;

// ── Turns ────────────────────────────────────────────────────────────────────

export const NativeHarnessTurnStopReason = Schema.Literal(
  "end-of-turn",
  "user-interrupt",
  "budget-ceiling",
  "repeated-failing-tool-call",
  "advisor-cancelled",
  "provider-failure",
  "context-unrecoverable",
);
export type NativeHarnessTurnStopReason = typeof NativeHarnessTurnStopReason.Type;

/** Only what the provider reported. Octant holds no price list. */
export const NativeHarnessTurnUsage = Schema.Struct({
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  reasoningTokens: Schema.optional(NonNegativeInt),
  cacheReadInputTokens: Schema.optional(NonNegativeInt),
  cacheWriteInputTokens: Schema.optional(NonNegativeInt),
  costUsd: Schema.optional(Schema.Number.pipe(Schema.nonNegative(), Schema.finite())),
}).annotations(strict);
export type NativeHarnessTurnUsage = typeof NativeHarnessTurnUsage.Type;

export const NativeHarnessTurnRecord = Schema.Struct({
  turnId: NativeHarnessTurnId,
  sessionId: NativeHarnessSessionId,
  sequence: PositiveInt,
  job: NativeHarnessJob,
  route: NativeHarnessRouteDecision,
  toolCalls: NonNegativeInt,
  stopReason: NativeHarnessTurnStopReason,
  usage: NativeHarnessTurnUsage,
  startedAt: UtcTimestamp,
  endedAt: UtcTimestamp,
})
  .annotations(strict)
  .pipe(Schema.filter((turn) => turn.endedAt >= turn.startedAt));
export type NativeHarnessTurnRecord = typeof NativeHarnessTurnRecord.Type;

// ── Advisor ──────────────────────────────────────────────────────────────────

export const NativeHarnessAdvisorInterventionId = brandedUuid("NativeHarnessAdvisorInterventionId");
export type NativeHarnessAdvisorInterventionId = typeof NativeHarnessAdvisorInterventionId.Type;

export const MAX_NATIVE_HARNESS_ADVISOR_DIGEST_LENGTH = 2_048;
const MAX_ADVISOR_DIGEST_FILES = 32;

/**
 * What the advisor sees: a compact digest of one turn, or a boundary artifact
 * the lead is about to commit to. Never a full transcript, which is what keeps
 * supervision a fraction of the lead's cost rather than a doubling of it.
 */
export const NativeHarnessAdvisorDigest = Schema.Struct({
  turnId: NativeHarnessTurnId,
  summary: Schema.NonEmptyTrimmedString.pipe(
    Schema.maxLength(MAX_NATIVE_HARNESS_ADVISOR_DIGEST_LENGTH),
  ),
  toolCalls: NonNegativeInt,
  filesTouched: Schema.Array(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1_024))).pipe(
    Schema.maxItems(MAX_ADVISOR_DIGEST_FILES),
  ),
  boundary: Schema.optional(Schema.Literal("plan-approval", "pre-commit-diff")),
}).annotations(strict);
export type NativeHarnessAdvisorDigest = typeof NativeHarnessAdvisorDigest.Type;

const InterventionFields = {
  id: NativeHarnessAdvisorInterventionId,
  sessionId: NativeHarnessSessionId,
  /** The advisor's own route; it is a model call like any other and is routed by slot. */
  route: NativeHarnessSlotCandidate,
  occurredAt: UtcTimestamp,
} as const;

/**
 * Everything the advisor can do. There is deliberately no shape here for a
 * tool call, a file edit, or an approval: supervision carries no side-effect
 * authority, and every write still traces to the lead or to one child's
 * worktree.
 */
export const NativeHarnessAdvisorIntervention = Schema.Union(
  Schema.Struct({
    ...InterventionFields,
    kind: Schema.Literal("cancel-turn"),
    turnId: NativeHarnessTurnId,
    reason: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1_024)),
  }).annotations(strict),
  Schema.Struct({
    ...InterventionFields,
    kind: Schema.Literal("redirect"),
    /** The lead must read this before its next turn. */
    instruction: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4_096)),
  }).annotations(strict),
  Schema.Struct({
    ...InterventionFields,
    kind: Schema.Literal("pause-run"),
    reason: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1_024)),
  }).annotations(strict),
  Schema.Struct({
    ...InterventionFields,
    kind: Schema.Literal("second-opinion"),
    /** The lead asked; the answer is advice the lead may ignore. */
    question: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4_096)),
    answer: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(8_192)),
  }).annotations(strict),
);
export type NativeHarnessAdvisorIntervention = typeof NativeHarnessAdvisorIntervention.Type;

// ── Follow-up suggestions ────────────────────────────────────────────────────

export const NativeHarnessFollowUpId = brandedUuid("NativeHarnessFollowUpId");
export type NativeHarnessFollowUpId = typeof NativeHarnessFollowUpId.Type;

export const MAX_NATIVE_HARNESS_FOLLOW_UPS = 3;
export const MAX_NATIVE_HARNESS_FOLLOW_UP_TITLE_LENGTH = 120;
export const MAX_NATIVE_HARNESS_FOLLOW_UP_PROMPT_LENGTH = 4_096;

export const NativeHarnessFollowUpTarget = Schema.Literal(
  "same-thread",
  "new-thread",
  "new-worktree",
);
export type NativeHarnessFollowUpTarget = typeof NativeHarnessFollowUpTarget.Type;

const FollowUpTitle = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(MAX_NATIVE_HARNESS_FOLLOW_UP_TITLE_LENGTH),
);

/** A suggestion carries no authority and creates nothing by itself. */
export const NativeHarnessFollowUpSuggestion = Schema.Struct({
  id: NativeHarnessFollowUpId,
  title: FollowUpTitle,
  /** Standalone: it must make sense to a fresh thread with no other context. */
  prompt: Schema.NonEmptyTrimmedString.pipe(
    Schema.maxLength(MAX_NATIVE_HARNESS_FOLLOW_UP_PROMPT_LENGTH),
  ),
  target: NativeHarnessFollowUpTarget,
}).annotations(strict);
export type NativeHarnessFollowUpSuggestion = typeof NativeHarnessFollowUpSuggestion.Type;

export const NativeHarnessFollowUpSet = Schema.Struct({
  turnId: NativeHarnessTurnId,
  suggestions: Schema.Array(NativeHarnessFollowUpSuggestion).pipe(
    Schema.maxItems(MAX_NATIVE_HARNESS_FOLLOW_UPS),
    Schema.filter(
      (suggestions) =>
        new Set(suggestions.map((suggestion) => suggestion.id)).size === suggestions.length,
    ),
  ),
}).annotations(strict);
export type NativeHarnessFollowUpSet = typeof NativeHarnessFollowUpSet.Type;

/**
 * Exactly what activating a suggestion would create. A worktree needs a
 * checkout, so only a Code thread can be the target of one.
 */
export const NativeHarnessFollowUpCreation = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("same-thread"),
    threadId: Schema.UUID,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("new-thread"),
    mode: OctantMode,
    projectId: Schema.optional(ProjectId),
    title: FollowUpTitle,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("new-worktree"),
    mode: Schema.Literal("code"),
    projectId: ProjectId,
    title: FollowUpTitle,
  }).annotations(strict),
);
export type NativeHarnessFollowUpCreation = typeof NativeHarnessFollowUpCreation.Type;

/** Shown before anything is created; the target and the creation must agree. */
export const NativeHarnessFollowUpPreview = Schema.Struct({
  suggestion: NativeHarnessFollowUpSuggestion,
  wouldCreate: NativeHarnessFollowUpCreation,
})
  .annotations(strict)
  .pipe(Schema.filter((preview) => preview.suggestion.target === preview.wouldCreate.kind));
export type NativeHarnessFollowUpPreview = typeof NativeHarnessFollowUpPreview.Type;

/** A person confirms; there is no shape in which this command is implicit. */
export const ActivateNativeHarnessFollowUp = Schema.Struct({
  turnId: NativeHarnessTurnId,
  suggestionId: NativeHarnessFollowUpId,
  confirmed: Schema.Literal(true),
}).annotations(strict);
export type ActivateNativeHarnessFollowUp = typeof ActivateNativeHarnessFollowUp.Type;

export const NativeHarnessFollowUpActivationResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("follow-up-activated"),
    suggestionId: NativeHarnessFollowUpId,
    created: NativeHarnessFollowUpCreation,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("follow-up-refused"),
    suggestionId: NativeHarnessFollowUpId,
    reason: Schema.Literal(
      "suggestion-not-found",
      "already-activated",
      "not-authorized",
      "target-unavailable",
    ),
    message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  }).annotations(strict),
);
export type NativeHarnessFollowUpActivationResult =
  typeof NativeHarnessFollowUpActivationResult.Type;

// ── Session ──────────────────────────────────────────────────────────────────

export const NativeHarnessSessionStatus = Schema.Literal(
  "idle",
  "running",
  "waiting-approval",
  "paused-by-advisor",
  "paused-by-user",
  "budget-limited",
  "failed",
);
export type NativeHarnessSessionStatus = typeof NativeHarnessSessionStatus.Type;

export const NativeHarnessSession = Schema.Struct({
  id: NativeHarnessSessionId,
  threadId: Schema.UUID,
  mode: OctantMode,
  projectId: Schema.optional(ProjectId),
  /** The lead's slot and the candidate it currently runs on. */
  leadSlotId: NativeHarnessSlotId,
  lead: NativeHarnessSlotCandidate,
  status: NativeHarnessSessionStatus,
  /** Why it is not running, when it is not. */
  detail: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512))),
  turnsRun: NonNegativeInt,
  cutovers: NonNegativeInt,
  startedAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
  version: AggregateVersion,
})
  .annotations(strict)
  // A session that is running or idle has nothing to explain; a paused,
  // waiting, limited, or failed one always does.
  .pipe(
    Schema.filter(
      (session) =>
        (session.status === "running" || session.status === "idle") ===
        (session.detail === undefined),
    ),
  );
export type NativeHarnessSession = typeof NativeHarnessSession.Type;

const SessionCommandFields = {
  sessionId: NativeHarnessSessionId,
  expectedVersion: AggregateVersion,
} as const;

export const NativeHarnessSessionCommand = Schema.Union(
  Schema.Struct({
    ...SessionCommandFields,
    kind: Schema.Literal("pause-native-harness-session"),
  }).annotations(strict),
  Schema.Struct({
    ...SessionCommandFields,
    kind: Schema.Literal("resume-native-harness-session"),
  }).annotations(strict),
  Schema.Struct({
    ...SessionCommandFields,
    kind: Schema.Literal("interrupt-native-harness-turn"),
    turnId: NativeHarnessTurnId,
  }).annotations(strict),
);
export type NativeHarnessSessionCommand = typeof NativeHarnessSessionCommand.Type;

export const NativeHarnessSessionCommandResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("native-harness-session"),
    session: NativeHarnessSession,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("native-harness-session-refused"),
    reason: Schema.Literal(
      "stale-version",
      "session-not-found",
      "turn-not-found",
      "not-paused",
      "not-running",
      "not-authorized",
    ),
    message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  }).annotations(strict),
);
export type NativeHarnessSessionCommandResult = typeof NativeHarnessSessionCommandResult.Type;

export const NATIVE_HARNESS_SESSION_AGGREGATE_TYPE = "native-harness-session";
export const NATIVE_HARNESS_SESSION_EVENT_NAMES = {
  started: "native-harness-session-started@1",
  turnStarted: "native-harness-turn-started@1",
  turnCompleted: "native-harness-turn-completed@1",
  routeDecided: "native-harness-route-decided@1",
  contextReduced: "native-harness-context-reduced@1",
  advisorIntervened: "native-harness-advisor-intervened@1",
  followUpsSuggested: "native-harness-follow-ups-suggested@1",
  followUpActivated: "native-harness-follow-up-activated@1",
  paused: "native-harness-session-paused@1",
  resumed: "native-harness-session-resumed@1",
} as const;

export const decodeNativeHarnessSessionId = Schema.decodeUnknownSync(NativeHarnessSessionId);
export const decodeNativeHarnessTurnId = Schema.decodeUnknownSync(NativeHarnessTurnId);
export const decodeNativeHarnessToolName = Schema.decodeUnknownSync(NativeHarnessToolName);
export const decodeNativeHarnessToolResultBounds = Schema.decodeUnknownSync(
  NativeHarnessToolResultBounds,
);
export const decodeNativeHarnessContextRemaining = Schema.decodeUnknownSync(
  NativeHarnessContextRemaining,
);
export const decodeNativeHarnessJournalLookupRequest = Schema.decodeUnknownSync(
  NativeHarnessJournalLookupRequest,
);
export const decodeNativeHarnessJournalLookupResult = Schema.decodeUnknownSync(
  NativeHarnessJournalLookupResult,
);
export const decodeNativeHarnessCarriedNote = Schema.decodeUnknownSync(NativeHarnessCarriedNote);
export const decodeNativeHarnessContextReduction = Schema.decodeUnknownSync(
  NativeHarnessContextReduction,
);
export const decodeNativeHarnessTurnRecord = Schema.decodeUnknownSync(NativeHarnessTurnRecord);
export const decodeNativeHarnessAdvisorDigest = Schema.decodeUnknownSync(
  NativeHarnessAdvisorDigest,
);
export const decodeNativeHarnessAdvisorIntervention = Schema.decodeUnknownSync(
  NativeHarnessAdvisorIntervention,
);
export const decodeNativeHarnessFollowUpSet = Schema.decodeUnknownSync(NativeHarnessFollowUpSet);
export const decodeNativeHarnessFollowUpPreview = Schema.decodeUnknownSync(
  NativeHarnessFollowUpPreview,
);
export const decodeActivateNativeHarnessFollowUp = Schema.decodeUnknownSync(
  ActivateNativeHarnessFollowUp,
);
export const decodeNativeHarnessFollowUpActivationResult = Schema.decodeUnknownSync(
  NativeHarnessFollowUpActivationResult,
);
export const decodeNativeHarnessSession = Schema.decodeUnknownSync(NativeHarnessSession);
export const decodeNativeHarnessSessionCommand = Schema.decodeUnknownSync(
  NativeHarnessSessionCommand,
);
export const decodeNativeHarnessSessionCommandResult = Schema.decodeUnknownSync(
  NativeHarnessSessionCommandResult,
);
