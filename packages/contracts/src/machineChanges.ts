import { Schema } from "effect";
import { NonNegativeInt, PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";

export const MachineChangeTopic = Schema.Literals([
  "chat-navigation",
  "work-navigation",
  "code-navigation",
  "projects",
  "extensions",
  "computer-use",
  "image-jobs",
  "browser-captures",
  "tool-approvals",
  "thread-follow-ups",
  "thread-message-queue",
  "todos",
  "canvas-choice-answers",
  "access-activity",
  "change-notices",
]);
export type MachineChangeTopic = typeof MachineChangeTopic.Type;

/**
 * The host process a frame's sequence belongs to, minted at every start.
 * Sequences restart at 1 with each process, so a cursor is only meaningful
 * with the epoch it came from: without it, a client's cursor from before a
 * restart that sat at or below the new head was accepted and the changes
 * between were missed. Optional so a client still reads an older host.
 */
export const MachineChangeEpoch = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9-]{1,64}$/));
export type MachineChangeEpoch = typeof MachineChangeEpoch.Type;

export const MachineChangeFrame = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("changed"),
    sequence: PositiveInt,
    topics: Schema.Array(MachineChangeTopic).check(Schema.isMaxLength(15)),
    epoch: Schema.optional(MachineChangeEpoch),
  }),
  Schema.Struct({
    kind: Schema.Literal("snapshot-required"),
    sequence: NonNegativeInt,
    epoch: Schema.optional(MachineChangeEpoch),
  }),
]);
export type MachineChangeFrame = typeof MachineChangeFrame.Type;

export const decodeMachineChangeFrame = Schema.decodeUnknownSync(
  MachineChangeFrame,
  STRICT_DECODE_OPTIONS,
);
