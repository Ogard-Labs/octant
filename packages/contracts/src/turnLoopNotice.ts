import { Schema } from "effect";
import { UtcTimestamp } from "./events";

const strict = { parseOptions: { onExcessProperty: "error" } } as const;

/** Bounded tool name carried on a loop notice or stop record. */
export const TurnLoopNoticeToolName = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256));

/** How many identical consecutive tool calls triggered the notice or stop. */
export const TurnLoopNoticeCount = Schema.Int.pipe(Schema.greaterThanOrEqualTo(2));

/**
 * A turn repeated the same tool call with the same canonical input in a row.
 * Outside Strict the turn keeps running (`turn-loop-noticed`) and shows one
 * quiet line with a Stop button; under Strict the host stops the turn
 * (`turn-loop-stopped`).
 */
export const TurnLoopNotice = Schema.Struct({
  kind: Schema.Literal("turn-loop-noticed", "turn-loop-stopped"),
  toolName: TurnLoopNoticeToolName,
  count: TurnLoopNoticeCount,
  occurredAt: UtcTimestamp,
}).annotations(strict);
export type TurnLoopNotice = typeof TurnLoopNotice.Type;

/**
 * A turn stayed silent past the stalled-turn limit outside Strict. The turn is
 * not stopped; the thread shows one quiet line with a Stop button.
 */
export const TurnStallNotice = Schema.Struct({
  kind: Schema.Literal("turn-stall-noticed"),
  idleMs: Schema.Int.pipe(Schema.positive()),
  occurredAt: UtcTimestamp,
}).annotations(strict);
export type TurnStallNotice = typeof TurnStallNotice.Type;

export const decodeTurnLoopNotice = Schema.decodeUnknownSync(TurnLoopNotice);
export const decodeTurnStallNotice = Schema.decodeUnknownSync(TurnStallNotice);
