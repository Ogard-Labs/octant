import { Schema } from "effect";
import { PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { UtcTimestamp } from "./events";

/** Bounded tool name carried on a loop notice or stop record. */
export const TurnLoopNoticeToolName = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(256),
);

/** How many identical consecutive tool calls triggered the notice or stop. */
export const TurnLoopNoticeCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(2));

/**
 * A turn repeated the same tool call with the same canonical input in a row.
 * Outside Strict the turn keeps running (`turn-loop-noticed`) and shows one
 * quiet line with a Stop button; under Strict the host stops the turn
 * (`turn-loop-stopped`).
 */
export const TurnLoopNotice = Schema.Struct({
  kind: Schema.Literals(["turn-loop-noticed", "turn-loop-stopped"]),
  toolName: TurnLoopNoticeToolName,
  count: TurnLoopNoticeCount,
  occurredAt: UtcTimestamp,
});
export type TurnLoopNotice = typeof TurnLoopNotice.Type;

/**
 * A turn stayed silent past the stalled-turn limit outside Strict. The turn is
 * not stopped; the thread shows one quiet line with a Stop button.
 */
export const TurnStallNotice = Schema.Struct({
  kind: Schema.Literal("turn-stall-noticed"),
  idleMs: PositiveInt,
  occurredAt: UtcTimestamp,
});
export type TurnStallNotice = typeof TurnStallNotice.Type;

export const decodeTurnLoopNotice = Schema.decodeUnknownSync(TurnLoopNotice, STRICT_DECODE_OPTIONS);
export const decodeTurnStallNotice = Schema.decodeUnknownSync(
  TurnStallNotice,
  STRICT_DECODE_OPTIONS,
);
