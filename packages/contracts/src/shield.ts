/**
 * Octant Shield: Octant's own automatic approval reviewer. At the Reviewed
 * guardrail level (Auto) a reviewer answers the approval prompts that would
 * otherwise go to the person: the provider's own, or Octant Shield. Its Judge
 * answers each prompt allow, ask, or deny; ask hands it to the person.
 *
 * Nothing here grants anything. A decision covers one call only: it is never a
 * standing rule, never a thread or Project grant, and never widens the OS
 * sandbox past the thread's level.
 */

import { Schema } from "effect";
import { UtcTimestamp } from "./events";
import { ProviderInstanceId, ProviderModelId } from "./providers";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/** Who answers a Reviewed thread's prompts. */
export const AutoReviewer = Schema.Literal("provider", "octant-shield");
export type AutoReviewer = typeof AutoReviewer.Type;

export const ShieldVerdict = Schema.Literal("allow", "ask", "deny");
export type ShieldVerdict = typeof ShieldVerdict.Type;

/**
 * The stage of the Judge that decided. Hard lines and deny rules run first,
 * then the taint limits, then the fast allow rules, then the model. `brake` is
 * Shield pausing after repeated denials, and `fail-closed` is a model that
 * answered nothing usable, so the person decides.
 */
export const ShieldStage = Schema.Literal(
  "hard-line",
  "deny-rule",
  "taint-limit",
  "fast-allow",
  "model",
  "brake",
  "fail-closed",
);
export type ShieldStage = typeof ShieldStage.Type;

/** The model that judges: a configured provider instance and one of its models. */
export const ShieldModelChoice = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
}).annotations(strict);
export type ShieldModelChoice = typeof ShieldModelChoice.Type;

export const MAX_SHIELD_REASON_LENGTH = 280;
export const MAX_SHIELD_RULE_LENGTH = 64;

/**
 * One journaled Shield decision. `reviewer` is always Octant Shield: a
 * decision Shield made is never presented as the provider's.
 */
export const ShieldDecision = Schema.Struct({
  reviewer: Schema.Literal("octant-shield"),
  verdict: ShieldVerdict,
  stage: ShieldStage,
  /** The rule that decided, for every stage but the model's. */
  rule: Schema.optional(
    Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(MAX_SHIELD_RULE_LENGTH)),
  ),
  /** One sentence: the rule's words or the model's. */
  reason: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(MAX_SHIELD_REASON_LENGTH)),
  /** The model asked, when the model stage ran or failed. */
  model: Schema.optional(ShieldModelChoice),
  latencyMs: Schema.Int.pipe(Schema.nonNegative()),
  decidedAt: UtcTimestamp,
}).annotations(strict);
export type ShieldDecision = typeof ShieldDecision.Type;

export const decodeShieldDecision = Schema.decodeUnknownSync(ShieldDecision);

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
 */
export const ShieldWatcherLabel = Schema.Literal(
  "agent-instructions",
  "hidden-text",
  "encoded-text",
  "exfiltration-request",
  "fake-authority",
  "secret-path-read",
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
