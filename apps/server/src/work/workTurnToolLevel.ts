import type { ProviderExecutionPolicy, WorkAccess } from "@octant/contracts";
import { workThreadAccessOf } from "@octant/domain/guardrail-policy";

export const WORK_PLAN_IMAGE_REFUSAL =
  "Plan mode cannot generate images. Leave Plan mode to generate one.";
export const WORK_PLAN_MEMORY_REFUSAL =
  "Plan mode cannot change Project memory. Leave Plan mode to make the change.";

/**
 * What a Work turn's own tool families may do at a level. Plan in Work is
 * Code's Plan: the families refuse what changes something (a Browser or
 * Computer effect, a sibling message, an image saved or generated, a Project
 * memory write) and keep what reads; each family carries the refusal itself,
 * so this only says which posture it is handed.
 */
export interface WorkTurnToolLevel {
  /** The posture the families read at each call (sibling messages, routines, helpers). */
  readonly posture: ProviderExecutionPolicy;
  /**
   * The posture handed to the families composed once for the turn (Browser,
   * Computer): Plan, or the guarded posture Work always gave them, since
   * their own asks follow the person's level and Full access separately.
   */
  readonly composed: "plan" | "approval-gated";
  /** Saving a generated image is a file edit at the level. */
  readonly imageSave: "refuse" | "ask" | "allow";
  /** Why the turn may not generate an image; absent when it may. */
  readonly imageRefusal?: string;
  /** Why the turn may not write Project memory; absent when the level and setting decide. */
  readonly memoryRefusal?: string;
}

/**
 * The level a Work turn's tools act at: the running turn's access, or with
 * no turn running, Ask first, which asks for every effect.
 */
export function workTurnToolLevel(access: WorkAccess | undefined): WorkTurnToolLevel {
  const posture = workThreadAccessOf(access ?? "ask-first").executionPolicy;
  if (posture === "plan") {
    return {
      posture,
      composed: "plan",
      imageSave: "refuse",
      imageRefusal: WORK_PLAN_IMAGE_REFUSAL,
      memoryRefusal: WORK_PLAN_MEMORY_REFUSAL,
    };
  }
  return {
    posture,
    composed: "approval-gated",
    imageSave: posture === "approval-gated" ? "ask" : "allow",
  };
}
