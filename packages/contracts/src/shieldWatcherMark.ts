import { Schema } from "effect";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * What Octant Shield's Watcher found in outside content as it entered a
 * thread. Each label is a kind, never the text that earned it, so the Judge
 * can be told about it without reading what the agent read.
 *
 * - `agent-instructions`: instructions aimed at the agent that reads it.
 * - `hidden-text`: invisible characters, or instructions hidden from view.
 * - `encoded-text`: readable text hidden behind an encoding.
 * - `exfiltration-request`: asks for secrets to be sent somewhere.
 * - `fake-authority`: claims to speak for the system, an administrator, or the person.
 * - `secret-path-read`: the call read a path the secret guard protects.
 * - `secret-env-print`: a shell call printed an environment variable whose
 *   name says it holds a secret.
 */
export const ShieldWatcherLabel = Schema.Literal(
  "agent-instructions",
  "hidden-text",
  "encoded-text",
  "exfiltration-request",
  "fake-authority",
  "secret-path-read",
  "secret-env-print",
);
export type ShieldWatcherLabel = typeof ShieldWatcherLabel.Type;

export const SHIELD_WATCHER_LABELS: ReadonlyArray<ShieldWatcherLabel> = ShieldWatcherLabel.literals;

/**
 * The mark on a tool row whose result brought outside content into the
 * thread, with what the Watcher found in it, if anything. `recordedOnly` is
 * set at Full access, where the mark is a quiet tag and never asks or blocks.
 */
export const ToolOutsideContentMark = Schema.Struct({
  labels: Schema.Array(ShieldWatcherLabel).pipe(Schema.maxItems(SHIELD_WATCHER_LABELS.length)),
  recordedOnly: Schema.optional(Schema.Literal(true)),
}).annotations(strict);
export type ToolOutsideContentMark = typeof ToolOutsideContentMark.Type;
