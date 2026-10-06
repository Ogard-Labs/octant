import { Schema } from "effect";
import { UtcTimestamp } from "./events";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

const retryFields = {
  attempt: Schema.Int.pipe(Schema.between(2, 16)),
  maxAttempts: Schema.Int.pipe(Schema.between(2, 16)),
  delayMs: Schema.Int.pipe(Schema.between(0, 3_600_000)),
  reason: Schema.Literal("rate-limited", "unavailable", "stream-interrupted", "empty-completion"),
  announcedAt: UtcTimestamp,
} as const;

/**
 * A direct endpoint failed in a way that usually passes, and the request is
 * going out again once `delayMs` has elapsed. Announced before the wait, so a
 * surface can say the turn is retrying while it is otherwise quiet. `attempt`
 * is the attempt about to start, counted from 1. Not journaled: the next
 * content, or the turn ending, clears it.
 */
export const HarnessRetryNotice = Schema.Struct(retryFields)
  .annotations(strict)
  .pipe(Schema.filter((notice) => notice.attempt <= notice.maxAttempts));
export type HarnessRetryNotice = typeof HarnessRetryNotice.Type;

/** The same notice, as one operation or stream event. */
export const HarnessRetryEventFields = {
  kind: Schema.Literal("provider-retry"),
  ...retryFields,
} as const;

export const decodeHarnessRetryNotice = Schema.decodeUnknownSync(HarnessRetryNotice);
