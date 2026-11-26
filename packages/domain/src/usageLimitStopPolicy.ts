import type { ProviderUsageLimit } from "@octant/contracts/providers";
import type { ThreadUsageLimited, UsageResumeThreadState } from "@octant/contracts";
import { parkedStopReleased } from "./providerAccountMovePolicy";

/** A thread's latest turn, as far as a usage-limit stop cares. */
export interface UsageLimitStopCandidate {
  /** A Chat attempt's outcome, or a Work or Code turn's status. */
  readonly state: string | undefined;
  readonly limit: ProviderUsageLimit | undefined;
  readonly turnId: string | undefined;
  /** Chat only: the attempt, which is what a release and a resume name. */
  readonly attemptId?: string | undefined;
}

export interface CurrentUsageLimitStop {
  readonly limit: ProviderUsageLimit;
  /** The thread's resume record, only when it names this stop. */
  readonly resume: UsageResumeThreadState | undefined;
  /** A move to another account or model released the stop. */
  readonly released: boolean;
}

/**
 * The usage-limit stop that currently holds a thread, or `undefined`. The
 * strip above the composer and the host's navigation row both ask here, so
 * they cannot disagree: the latest turn still waits on the limit, and a
 * released stop counts only while a resume is still scheduled for it.
 *
 * Whether the reset has already passed is not decided here. It moves with the
 * reader's clock, which the row applies and the strip counts down.
 */
export function currentUsageLimitStop(
  thread: Parameters<typeof parkedStopReleased>[0] & {
    readonly usageResume?: UsageResumeThreadState | undefined;
  },
  stop: UsageLimitStopCandidate | undefined,
): CurrentUsageLimitStop | undefined {
  if (stop === undefined || stop.state !== "waiting" || stop.limit === undefined) return undefined;
  const record = thread.usageResume?.record;
  const resume =
    record !== undefined &&
    String(record.turnId) === String(stop.turnId) &&
    (stop.attemptId === undefined || String(record.attemptId) === String(stop.attemptId))
      ? thread.usageResume
      : undefined;
  const stopId = stop.attemptId ?? stop.turnId;
  const released = parkedStopReleased(thread, stopId === undefined ? undefined : String(stopId));
  if (released && resume?.status !== "scheduled") return undefined;
  return { limit: stop.limit, resume, released };
}

/**
 * What a navigation row is told about a current stop. A billing stop names no
 * reset: an account in arrears does not free up on a clock.
 */
export function limitedThreadFact(limit: ProviderUsageLimit): ThreadUsageLimited {
  return limit.kind === "billing" || limit.resetsAt === undefined
    ? {}
    : { resetsAt: limit.resetsAt };
}
