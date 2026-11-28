import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { UtcTimestamp } from "./events";

const retryFields = {
  attempt: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 16 })),
  maxAttempts: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 16 })),
  delayMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3_600_000 })),
  reason: Schema.Literals([
    "rate-limited",
    "unavailable",
    "stream-interrupted",
    "empty-completion",
  ]),
  announcedAt: UtcTimestamp,
} as const;

/**
 * A direct endpoint failed in a way that usually passes, and the request is
 * going out again once `delayMs` has elapsed. Announced before the wait, so a
 * surface can say the turn is retrying while it is otherwise quiet. `attempt`
 * is the attempt about to start, counted from 1. The next content or tool
 * call, or the turn settling, clears it. A Chat attempt and a Code operation journal it
 * with the turn; the harness session view holds it only in memory.
 */
export const HarnessRetryNotice = Schema.Struct(retryFields).check(
  Schema.makeFilter((notice) => notice.attempt <= notice.maxAttempts),
);
export type HarnessRetryNotice = typeof HarnessRetryNotice.Type;

/** The same notice, as one operation or stream event. */
export const HarnessRetryEventFields = {
  kind: Schema.Literal("provider-retry"),
  ...retryFields,
} as const;

export const decodeHarnessRetryNotice = Schema.decodeUnknownSync(
  HarnessRetryNotice,
  STRICT_DECODE_OPTIONS,
);
