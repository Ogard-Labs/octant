import { Schema } from "effect";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

export const MachineChangeTopic = Schema.Literal(
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
);
export type MachineChangeTopic = typeof MachineChangeTopic.Type;

/**
 * The host process a frame's sequence belongs to, minted at every start.
 * Sequences restart at 1 with each process, so a cursor is only meaningful
 * with the epoch it came from: without it, a client's cursor from before a
 * restart that sat at or below the new head was accepted and the changes
 * between were missed. Optional so a client still reads an older host.
 */
export const MachineChangeEpoch = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9-]{1,64}$/));
export type MachineChangeEpoch = typeof MachineChangeEpoch.Type;

export const MachineChangeFrame = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("changed"),
    sequence: Schema.Int.pipe(Schema.positive()),
    topics: Schema.Array(MachineChangeTopic).pipe(Schema.maxItems(11)),
    epoch: Schema.optional(MachineChangeEpoch),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("snapshot-required"),
    sequence: Schema.Int.pipe(Schema.nonNegative()),
    epoch: Schema.optional(MachineChangeEpoch),
  }).annotations(strict),
);
export type MachineChangeFrame = typeof MachineChangeFrame.Type;

export const decodeMachineChangeFrame = Schema.decodeUnknownSync(MachineChangeFrame);
