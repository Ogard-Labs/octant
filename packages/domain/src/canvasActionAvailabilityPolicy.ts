import {
  type CanvasActionBlock,
  type CanvasActionCommand,
  type CanvasActionDenialCode,
} from "@octant/contracts/canvas-actions";
import { type OctantMode } from "@octant/contracts/modes";
import { classifyCanvasActionCommand, type CanvasActionCapability } from "./canvasActionPolicy";

/**
 * Pure presentation-availability policy for Canvas typed actions (D3).
 *
 * The server remains the sole authority: every action is reauthorized before
 * any side effect by {@link authorizeCanvasAction}. This policy only decides how
 * an admitted action block is *surfaced* — enabled, or visibly disabled with a
 * safe reason — and guarantees the reason copy never leaks host paths, provider
 * or thread identifiers, credentials, or other provenance metadata. It invents
 * no new authority: it relays host verdicts and the contract's own capability
 * classification, failing closed to "unavailable" whenever a verdict is absent
 * or the session cannot dispatch actions (design §7 Typed actions).
 */

/** How an action is surfaced to the user before any dispatch. */
export type CanvasActionAvailabilityState = "available" | "unavailable" | "unauthorized";

export interface CanvasActionAvailability {
  readonly state: CanvasActionAvailabilityState;
  readonly capability: CanvasActionCapability;
  /** Whether running this action is approval-gated (mirrors the capability). */
  readonly requiresApproval: boolean;
  /** Safe, metadata-free copy. Present only when the action is not available. */
  readonly reason?: string;
}

export interface CanvasActionAvailabilityContext {
  /** The active workspace mode; a foreign-mode action fails closed. */
  readonly mode: OctantMode;
  /** The current session can dispatch actions (client transport is wired). */
  readonly canExecuteActions: boolean;
  /**
   * Host authorization verdict for this action. Defaults to authorized; an
   * explicit `false` surfaces the action disabled with an unauthorized reason.
   */
  readonly authorized?: boolean;
  /**
   * Host availability verdict for this action (e.g. a revoked source or an
   * offline host). Defaults to available; an explicit `false` disables it.
   */
  readonly available?: boolean;
}

/**
 * Map a server-issued denial code to safe, user-facing copy.
 *
 * The renderer never displays the raw server denial `message`, which can name a
 * command identifier or other provenance detail. Every branch here is a fixed,
 * metadata-free sentence, so an unavailable or unauthorized action reads the
 * same regardless of the underlying host, provider, thread, or Project.
 */
export function safeCanvasActionDenialReason(code: CanvasActionDenialCode): string {
  switch (code) {
    case "unauthorized":
    case "scope-mismatch":
    case "mode-mismatch":
    case "origin-thread-mismatch":
      return "You do not have access to run this action here.";
    case "revoked":
    case "unavailable":
      return "This action is no longer available.";
    case "stale-version":
      return "This canvas changed. Refresh it, then try again.";
    case "approval-required":
      return "This action needs your approval before it can run.";
    case "approval-denied":
      return "This action was declined.";
    case "cancelled":
      return "This action was cancelled.";
    case "malformed-request":
    case "unknown-command":
    case "unsupported-schema":
      return "This action is not supported.";
  }
}

/** Safe capability label for non-color differentiation (icon + this text). */
export function canvasActionEffectLabel(capability: CanvasActionCapability): string {
  return capability.effect === "mutate" ? "Changes your workspace" : "Read-only";
}

/**
 * Decide how an admitted action block is surfaced. Fails closed: a session that
 * cannot dispatch actions, an explicit unavailable verdict, or an explicit
 * unauthorized verdict all disable the control with safe copy. Read-only and
 * mutating commands alike are only ever *offered* here; the mutating and
 * approval-gated ones are still reauthorized and gated server-side on dispatch.
 */
export function evaluateCanvasActionAvailability(
  block: CanvasActionBlock,
  context: CanvasActionAvailabilityContext,
): CanvasActionAvailability {
  const capability = classifyCanvasActionCommand(block.command);
  const base = { capability, requiresApproval: capability.requiresApproval } as const;
  if (context.authorized === false) {
    return { ...base, state: "unauthorized", reason: safeCanvasActionDenialReason("unauthorized") };
  }
  if (!context.canExecuteActions || context.available === false) {
    return { ...base, state: "unavailable", reason: safeCanvasActionDenialReason("unavailable") };
  }
  return { ...base, state: "available" };
}

/** Convenience classifier re-exported for renderers that only have a command. */
export function classifyCanvasActionAvailabilityCommand(
  command: CanvasActionCommand,
): CanvasActionCapability {
  return classifyCanvasActionCommand(command);
}
