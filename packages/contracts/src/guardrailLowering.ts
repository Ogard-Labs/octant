/**
 * The journal records of a guardrail level change: who did it, when (the
 * envelope's actor and time), from which level, and at which scope. It
 * carries levels and ids only, no prompt text, path, or credential. Each
 * direction journals under the event that means it — a lowering, an access
 * raise into a still-gated level, or any other change.
 */

import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { ProjectId } from "./projects";
import { PermissionMode } from "./providers";

export const GUARDRAIL_LEVEL_LOWERED = "guardrail.level-lowered@1";

/** Where a level was set: for every new thread, for a Project's, or for one thread. */
export const GuardrailScope = Schema.Literals(["global", "project", "thread"]);
export type GuardrailScope = typeof GuardrailScope.Type;

/**
 * The level-change payload every guardrail-change event carries, whichever
 * direction the change went.
 */
export const GuardrailLevelChange = Schema.Struct({
  scope: GuardrailScope,
  /** Which mode's level changed: Code's or Work's. */
  surface: Schema.Literals(["code", "work"]),
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
});
export type GuardrailLevelChange = typeof GuardrailLevelChange.Type;
export const GuardrailLevelLowered = GuardrailLevelChange;
export type GuardrailLevelLowered = GuardrailLevelChange;

export const decodeGuardrailLevelLowered = Schema.decodeUnknownSync(
  GuardrailLevelChange,
  STRICT_DECODE_OPTIONS,
);
export const decodeGuardrailLevelChange = Schema.decodeUnknownSync(
  GuardrailLevelChange,
  STRICT_DECODE_OPTIONS,
);

/**
 * A change that raised the thread's access but is no lowering the domain
 * names: Plan's bound lifted into Ask first, where every act still asks the
 * person. Access notices read it; `guardrail.level-lowered@1` stays reserved
 * for `guardrailLowered` itself.
 */
export const GUARDRAIL_ACCESS_RAISED = "guardrail.access-raised@1";
export const decodeGuardrailAccessRaised = Schema.decodeUnknownSync(
  GuardrailLevelChange,
  STRICT_DECODE_OPTIONS,
);

/**
 * Every other non-identity change: a tightening such as Full access to Ask
 * first, or a sideways move between Auto and Accept edits. It is recorded so
 * the journal shows the whole level history, and it is never a notice.
 */
export const GUARDRAIL_LEVEL_CHANGED = "guardrail.level-changed@1";
