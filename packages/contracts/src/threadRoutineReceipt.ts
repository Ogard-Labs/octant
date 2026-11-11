import { Schema } from "effect";
import { AutomationScheduledTrigger, MAX_AUTOMATION_DISPLAY_NAME_LENGTH } from "./automation";
import { UtcTimestamp } from "./events";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const encoder = new TextEncoder();
const boundedNonEmptyText = (maximumBytes: number) =>
  Schema.NonEmptyTrimmedString.pipe(
    Schema.filter((value) => encoder.encode(value).byteLength <= maximumBytes),
  );

/**
 * The routine a thread's tool call set up, kept on that call's step so the
 * transcript can show what was created: its id, name, schedule, first run, and
 * whether it waits for the person to resume it. A routine created because the
 * person asked is paused; one they confirmed on a card runs. Kept apart from
 * `threadToolSteps` because the schedule reads the Automation contract, which
 * reads the Code contract, which reads that file.
 */
export const ThreadRoutineReceipt = Schema.Struct({
  routineId: boundedNonEmptyText(255),
  // The routine's own name limit, in characters: a byte limit would reject a
  // long non-ASCII name the routine accepted, after the routine already exists.
  name: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(MAX_AUTOMATION_DISPLAY_NAME_LENGTH)),
  trigger: AutomationScheduledTrigger,
  firstRunAt: UtcTimestamp,
  paused: Schema.Boolean,
}).annotations(strict);
export type ThreadRoutineReceipt = typeof ThreadRoutineReceipt.Type;
