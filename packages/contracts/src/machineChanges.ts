import { Schema } from "effect";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

export const MachineChangeTopic = Schema.Literal(
  "chat-navigation",
  "work-navigation",
  "code-navigation",
  "projects",
  "extensions",
  "computer-use",
  "workspace",
);
export type MachineChangeTopic = typeof MachineChangeTopic.Type;

export const MachineChangeFrame = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("changed"),
    sequence: Schema.Int.pipe(Schema.positive()),
    topics: Schema.Array(MachineChangeTopic).pipe(Schema.maxItems(7)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("snapshot-required"),
    sequence: Schema.Int.pipe(Schema.nonNegative()),
  }).annotations(strict),
);
export type MachineChangeFrame = typeof MachineChangeFrame.Type;

export const decodeMachineChangeFrame = Schema.decodeUnknownSync(MachineChangeFrame);
