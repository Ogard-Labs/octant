import { Schema } from "effect";
import { UtcTimestamp } from "./events";
import { ProviderInstanceId } from "./providers";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * What the host did the last time a turn on this thread stopped on its
 * account's usage limit while the opt-in was on. `handed-off` names both
 * accounts so the thread can say where the conversation went and why;
 * `stopped` names the account it would have gone to and the reason it did
 * not, so the person sees the stop instead of a silent nothing.
 *
 * `stopId` is the limited turn (Chat attempt, Work turn, Code operation): the
 * host acts at most once per stop, so a replayed or re-read stop never moves
 * the thread a second time.
 */
export const ThreadUsageLimitHandoffOutcome = Schema.Struct({
  kind: Schema.Literal("handed-off", "stopped"),
  stopId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
  fromProviderInstanceId: ProviderInstanceId,
  toProviderInstanceId: ProviderInstanceId,
  at: UtcTimestamp,
  /** Why the handoff did not happen; present on `stopped` only. */
  detail: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512))),
}).annotations(strict);
export type ThreadUsageLimitHandoffOutcome = typeof ThreadUsageLimitHandoffOutcome.Type;

/**
 * The person's per-thread opt-in: when this thread's account hits its usage
 * limit, hand the conversation off to the one account they named, by the
 * same disclosed handoff a person's own move makes. Absent means the thread
 * waits on its account's limit, as every thread does by default.
 */
export const ThreadUsageLimitHandoff = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  last: Schema.optional(ThreadUsageLimitHandoffOutcome),
}).annotations(strict);
export type ThreadUsageLimitHandoff = typeof ThreadUsageLimitHandoff.Type;
