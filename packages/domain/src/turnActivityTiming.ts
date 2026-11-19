import type { ThreadCallTiming } from "@octant/contracts";
import type { UtcTimestamp } from "@octant/contracts/events";

/**
 * Pure per-turn activity timing, shared by Code now and Chat/Work later.
 *
 * Every timestamp is untrusted input: provider adapters stamp `occurredAt`,
 * the journal stamps approval ask/answer frames, and either can be missing,
 * malformed, out of order, or stamped for a batch of replayed events at once.
 * The tracker therefore fails closed for timing only — a call or span whose
 * bounds cannot be trusted produces no number, never an invented one.
 */

/**
 * Whether an event's `occurredAt` names its own instant. A mapper that folds
 * stored or replayed provider output into events stamped with one batch time
 * marks them `synthesized`; such events are invisible to timing — they neither
 * bound a reasoning span nor start or end a call.
 */
export type TurnTimingProvenance = "live" | "synthesized";

const parseAt = (at: UtcTimestamp | string | undefined): number | undefined => {
  if (at === undefined) return undefined;
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : undefined;
};

interface OpenApproval {
  readonly askedAt: number;
  readonly toolCallId: string | undefined;
}

interface TrackedCall {
  readonly startedAt: number;
  readonly startedAtIso: string;
  /**
   * The call's start existed but could not be trusted — a synthesized or
   * malformed timestamp — or a wait nobody can attribute overlaps its span.
   * A later terminal event must not invent a duration.
   */
  poisoned: boolean;
}

/**
 * One call's attributed waits, merged as they close and released when the
 * call settles. `malformed` marks an interval nobody could bound; the call's
 * duration is then omitted rather than displayed whole.
 */
interface CallWaits {
  intervals: { start: number; end: number }[];
  malformed: boolean;
}

/** Inserts `[start, end)` into a sorted merged list. */
function mergeInterval(intervals: { start: number; end: number }[], start: number, end: number) {
  let lo = start;
  let hi = end;
  let i = 0;
  while (i < intervals.length) {
    const interval = intervals[i];
    if (interval === undefined) break;
    if (interval.end < lo) {
      i += 1;
      continue;
    }
    if (interval.start > hi) break;
    lo = Math.min(lo, interval.start);
    hi = Math.max(hi, interval.end);
    intervals.splice(i, 1);
  }
  intervals.splice(i, 0, { start: lo, end: hi });
}

/** Whole-millisecond sum of already-merged intervals clipped to `[lo, hi)`. */
function mergedClipSumMs(
  intervals: ReadonlyArray<{ readonly start: number; readonly end: number }>,
  lo: number,
  hi: number,
): number {
  let total = 0;
  for (const interval of intervals) {
    const start = Math.max(interval.start, lo);
    const end = Math.min(interval.end, hi);
    if (end <= start) continue;
    total += end - start;
  }
  return total;
}

/**
 * One turn's reasoning spans, tool calls, and person-facing approval waits.
 * Reasoning is a cumulative total in whole milliseconds; each `observe` call
 * returns the new total only when a span boundary changed it, so a caller can
 * journal `reasoning-time` on boundaries and replay by assignment.
 */
export interface TurnActivityTimingTracker {
  /**
   * Observes one normalized event before its content is journaled. Reasoning
   * events open a span; every other live event closes it. Returns the updated
   * cumulative `reasoningMs` when a span just closed, else `undefined`.
   */
  readonly observeEvent: (input: {
    readonly isReasoning: boolean;
    readonly occurredAt: UtcTimestamp | string | undefined;
    readonly provenance?: TurnTimingProvenance;
  }) => number | undefined;
  /** Records a call's start. Later `callEnded` returns its timing, or none. */
  readonly callStarted: (input: {
    readonly toolCallId: string;
    readonly occurredAt: UtcTimestamp | string | undefined;
    readonly provenance?: TurnTimingProvenance;
  }) => void;
  /**
   * Records a call's terminal event and computes its timing: the provider
   * timestamps minus any attributed, bounded person wait. Returns `undefined`
   * for a running call, a missing or poisoned start, an out-of-order end, or
   * a wait that cannot be attributed — never an invented number.
   */
  readonly callEnded: (input: {
    readonly toolCallId: string;
    readonly occurredAt: UtcTimestamp | string | undefined;
    readonly provenance?: TurnTimingProvenance;
  }) => ThreadCallTiming | undefined;
  /** The journaled person-facing ask; its frame timestamp is the ask time. */
  readonly approvalAsked: (input: {
    readonly approvalId: string;
    readonly occurredAt: UtcTimestamp | string;
    readonly toolCallId?: string;
  }) => void;
  /** The journaled person-facing answer; its frame timestamp is the answer time. */
  readonly approvalAnswered: (input: {
    readonly approvalId: string;
    readonly occurredAt: UtcTimestamp | string;
  }) => void;
  /**
   * An ask settled without a person answering — an automated review, an
   * expiry, an interrupt. Closes the ask so an overlapping call is not
   * poisoned by a wait nobody spent, and records no wait.
   */
  readonly approvalSettled: (input: { readonly approvalId: string }) => void;
  /**
   * Closes an open reasoning span at a terminal instant the provider did not
   * timestamp — a journaled terminal frame uses its own journal time.
   */
  readonly closeReasoningAt: (at: UtcTimestamp | string | undefined) => number | undefined;
  /** Latest cumulative reasoning total, for inspection and tests. */
  readonly reasoningMs: () => number;
}

export function createTurnActivityTiming(): TurnActivityTimingTracker {
  let reasoningOpen: number | undefined;
  let reasoningMs = 0;
  const calls = new Map<string, TrackedCall>();
  const openApprovals = new Map<string, OpenApproval>();
  // Attributed waits accumulate under the call they name — merged on close,
  // released when that call ends — never scanned across a turn's history.
  const callWaits = new Map<string, CallWaits>();
  let unattributedOpen = 0;

  const closeReasoning = (at: number): number | undefined => {
    if (reasoningOpen === undefined) return undefined;
    const opened = reasoningOpen;
    reasoningOpen = undefined;
    if (at < opened) return undefined;
    reasoningMs += at - opened;
    return reasoningMs;
  };

  /** Drops an open span whose end nobody can bound honestly. */
  const invalidateReasoning = () => {
    reasoningOpen = undefined;
  };

  const waitsFor = (toolCallId: string): CallWaits => {
    let waits = callWaits.get(toolCallId);
    if (waits === undefined) {
      waits = { intervals: [], malformed: false };
      callWaits.set(toolCallId, waits);
    }
    return waits;
  };

  return {
    observeEvent(input) {
      const synthesized = input.provenance === "synthesized";
      const at = synthesized ? undefined : parseAt(input.occurredAt);
      if (input.isReasoning) {
        if (at !== undefined) reasoningOpen ??= at;
        return undefined;
      }
      // A boundary nobody can stamp closes nothing and poisons the open
      // span: it must not ride forward into a later trustworthy event.
      if (at === undefined || (reasoningOpen !== undefined && at < reasoningOpen)) {
        invalidateReasoning();
        return undefined;
      }
      return closeReasoning(at);
    },
    callStarted(input) {
      // A repeated start keeps the call's first observed start.
      if (calls.has(input.toolCallId)) return;
      const at = parseAt(input.occurredAt);
      calls.set(input.toolCallId, {
        startedAt: at ?? Number.NaN,
        startedAtIso: at === undefined ? "" : String(input.occurredAt),
        poisoned: at === undefined || input.provenance === "synthesized" || unattributedOpen > 0,
      });
    },
    callEnded(input) {
      const call = calls.get(input.toolCallId);
      calls.delete(input.toolCallId);
      const waits = callWaits.get(input.toolCallId);
      callWaits.delete(input.toolCallId);
      const endedAt = parseAt(input.occurredAt);
      if (
        call === undefined ||
        call.poisoned ||
        waits?.malformed === true ||
        input.provenance === "synthesized" ||
        endedAt === undefined ||
        endedAt < call.startedAt
      ) {
        return undefined;
      }
      for (const [approvalId, open] of openApprovals) {
        if (open.askedAt >= endedAt) continue;
        if (open.toolCallId === input.toolCallId) {
          // The call's own ask was still open when the call ended: the wait's
          // end is unknown, so the run time cannot be trusted. The ask can
          // never bill a call that is already over, so its scope is released
          // here rather than scanned against every later call end.
          openApprovals.delete(approvalId);
          return undefined;
        }
        if (open.toolCallId === undefined) {
          // An unattributed ask still open could overlap any call it outlives.
          return undefined;
        }
      }
      const approvalWaitMs =
        waits === undefined ? 0 : mergedClipSumMs(waits.intervals, call.startedAt, endedAt);
      return {
        startedAt: call.startedAtIso as UtcTimestamp,
        endedAt: String(input.occurredAt) as UtcTimestamp,
        ...(approvalWaitMs > 0 ? { approvalWaitMs } : {}),
      };
    },
    approvalAsked(input) {
      const askedAt = parseAt(input.occurredAt);
      if (askedAt === undefined) return;
      openApprovals.set(input.approvalId, {
        askedAt,
        toolCallId: input.toolCallId,
      });
      if (input.toolCallId === undefined) unattributedOpen += 1;
    },
    approvalSettled(input) {
      const open = openApprovals.get(input.approvalId);
      if (open === undefined) return;
      openApprovals.delete(input.approvalId);
      if (open.toolCallId === undefined) unattributedOpen -= 1;
    },
    approvalAnswered(input) {
      const open = openApprovals.get(input.approvalId);
      if (open === undefined) return;
      openApprovals.delete(input.approvalId);
      if (open.toolCallId === undefined) unattributedOpen -= 1;
      const answeredAt = parseAt(input.occurredAt);
      const bounded = answeredAt !== undefined && answeredAt >= open.askedAt;
      if (open.toolCallId !== undefined) {
        const waits = waitsFor(open.toolCallId);
        if (!bounded) waits.malformed = true;
        else mergeInterval(waits.intervals, open.askedAt, answeredAt);
        return;
      }
      // A wait nobody can attribute ends here: every call it could still
      // touch — one open since before it closed — omits its duration rather
      // than absorb an unknown stretch. Calls that start later cannot
      // overlap it, and calls that already ended judged it while it waited.
      for (const call of calls.values()) {
        if (!bounded || call.startedAt < answeredAt) call.poisoned = true;
      }
    },
    closeReasoningAt(input) {
      const at = parseAt(input);
      return at === undefined ? undefined : closeReasoning(at);
    },
    reasoningMs: () => reasoningMs,
  };
}

/**
 * The renderer's read of a completed call's timing: run time with the
 * person-facing wait removed. Returns `undefined` when the bounds are
 * malformed, so a rebuilt row shows no duration rather than a wrong one.
 */
export function completedCallDurationMs(
  timing: ThreadCallTiming | undefined,
): { readonly durationMs: number; readonly waitedMs: number } | undefined {
  if (timing === undefined) return undefined;
  const start = Date.parse(timing.startedAt);
  const end = Date.parse(timing.endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  const waitedMs = timing.approvalWaitMs ?? 0;
  const durationMs = end - start - waitedMs;
  if (durationMs < 0 || !Number.isFinite(durationMs)) return undefined;
  return { durationMs, waitedMs };
}
