import { Schema } from "effect";
import { UtcTimestamp } from "./events";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/** Longest tool label a navigation row carries; the host truncates before this. */
export const MAX_LIVE_STEP_TOOL_LENGTH = 80;
/** Longest redacted argument a navigation row carries. */
export const MAX_LIVE_STEP_ARGUMENT_LENGTH = 160;

/**
 * What a running thread is doing right now, as far as the host can say without
 * exposing content. `tool` is the latest tool activity: its name and, when the
 * provider reported one, a single redacted, truncated line of its argument (a
 * command, a checkout-relative path). `waiting` is the turn parked on the
 * person. Neither ever carries file contents, a secret, or an absolute path.
 */
export const ThreadLiveStep = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("tool"),
    tool: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(MAX_LIVE_STEP_TOOL_LENGTH)),
    argument: Schema.optional(
      Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(MAX_LIVE_STEP_ARGUMENT_LENGTH)),
    ),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("waiting"),
    reason: Schema.Literal("approval", "user-input"),
  }).annotations(strict),
);
export type ThreadLiveStep = typeof ThreadLiveStep.Type;

/**
 * The live-turn facts a Chat, Work, or Code navigation row may carry while its
 * turn is running. Both are optional and absent together outside a live turn:
 * the host holds them in memory for the turn's lifetime, so an older host, a
 * restarted host, and an idle thread all read as "nothing to say".
 *
 * `turnStartedAt` is when the latest turn began. `liveStep` is its latest step.
 */
export const ThreadLiveTurnFields = {
  turnStartedAt: Schema.optional(UtcTimestamp),
  liveStep: Schema.optional(ThreadLiveStep),
} as const;
