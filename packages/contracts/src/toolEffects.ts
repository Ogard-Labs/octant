import { Schema } from "effect";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const BoundedToolCallId = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128));
const BoundedToolName = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128));

/**
 * Whether a tool call can change anything. `read-only` is declared per tool;
 * every tool without that declaration is `side-effecting`, so a tool nobody
 * classified is treated as one that may have taken effect.
 */
export const ToolEffectClass = Schema.Literal("read-only", "side-effecting");
export type ToolEffectClass = typeof ToolEffectClass.Type;

/**
 * Who runs the call. `host` is a tool the host runs itself, recorded before
 * the tool starts. `runtime` is a provider runtime's own tool, recorded when
 * the host reads the runtime's report that it started, which is after the
 * fact.
 */
export const ToolEffectOrigin = Schema.Literal("host", "runtime");
export type ToolEffectOrigin = typeof ToolEffectOrigin.Type;

/**
 * A tool call about to take effect, journaled before it does. It names the
 * call and its tool and never carries arguments, paths, commands or results.
 * `turnId` is the turn as its mode names it: a Code operation, a Chat
 * attempt, a Work turn request, or the id an agent run's calls are kept under.
 */
export const ToolEffectIntended = Schema.Struct({
  threadId: Schema.UUID,
  turnId: Schema.UUID,
  toolCallId: BoundedToolCallId,
  toolName: BoundedToolName,
  effect: ToolEffectClass,
  origin: ToolEffectOrigin,
}).annotations(strict);
export type ToolEffectIntended = typeof ToolEffectIntended.Type;

/**
 * The call stopped before it took effect to ask a person for its approval.
 * While this is the call's last frame nothing has run: a restart that finds
 * it continues the turn, which asks again. An answered approval writes the
 * call's `ToolEffectIntended` again before the tool goes on, so a frame
 * always precedes the effect.
 */
export const ToolEffectAwaitingApproval = Schema.Struct({
  threadId: Schema.UUID,
  turnId: Schema.UUID,
  toolCallId: BoundedToolCallId,
}).annotations(strict);
export type ToolEffectAwaitingApproval = typeof ToolEffectAwaitingApproval.Type;

/**
 * The call ended and its outcome is known. `failed` covers a refused call:
 * a tool reports both as an error result. `superseded` closes a call whose
 * outcome was never written, when the agent run that made it starts again:
 * the restart that cut it off has already been read, and the same record
 * must not hold a later one.
 */
export const ToolEffectSettled = Schema.Struct({
  threadId: Schema.UUID,
  turnId: Schema.UUID,
  toolCallId: BoundedToolCallId,
  outcome: Schema.Literal("succeeded", "failed", "superseded"),
}).annotations(strict);
export type ToolEffectSettled = typeof ToolEffectSettled.Type;

/**
 * One aggregate per turn, so reading a cut-off turn's calls reads only that
 * turn. An agent run's calls are kept on one aggregate per run, apart from
 * its parent thread's turns.
 */
export const TOOL_EFFECT_AGGREGATE_TYPE = "turn-tool-effects";
export const TOOL_EFFECT_EVENT_NAMES = {
  intended: "tool-effect-intended@1",
  awaitingApproval: "tool-effect-awaiting-approval@1",
  settled: "tool-effect-settled@1",
} as const;
