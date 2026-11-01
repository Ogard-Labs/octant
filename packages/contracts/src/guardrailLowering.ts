/**
 * The journal record of a guardrail level being lowered: who did it, when
 * (the envelope's actor and time), from which level, and at which scope. It
 * carries levels and ids only, no prompt text, path, or credential.
 */

import { Schema } from "effect";
import { ProjectId } from "./projects";
import { PermissionMode } from "./providers";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

export const GUARDRAIL_LEVEL_LOWERED = "guardrail.level-lowered@1";

/** Where a level was set: for every new thread, for a Project's, or for one thread. */
export const GuardrailScope = Schema.Literal("global", "project", "thread");
export type GuardrailScope = typeof GuardrailScope.Type;

export const GuardrailLevelLowered = Schema.Struct({
  scope: GuardrailScope,
  /** Which mode's level changed: Code's or Work's. */
  surface: Schema.Literal("code", "work"),
  /**
   * The level before. Absent when a Project's override replaced the default
   * it followed, which only the settings behind it can name.
   */
  from: Schema.optional(PermissionMode),
  to: PermissionMode,
  /** Set for a Project's or a thread's level. */
  projectId: Schema.optional(ProjectId),
  /** Set for a thread's level. */
  threadId: Schema.optional(Schema.NonEmptyString),
}).annotations(strict);
export type GuardrailLevelLowered = typeof GuardrailLevelLowered.Type;

export const decodeGuardrailLevelLowered = Schema.decodeUnknownSync(GuardrailLevelLowered);
