/**
 * The line that opens a plan a provider handed over in Plan with its own plan
 * mechanism (Claude Code's plan tool, Codex's proposed-plan item).
 *
 * The plan becomes the turn's reply text under this line. Octant's thread
 * plan is a structured proposal a person makes, and no provider has a path to
 * it, so this text is what the person reads before moving the thread out of
 * Plan, which stays read-only until they do.
 */
export const PROPOSED_PLAN_HEADING = "**Proposed plan**";

/** The reply text for a handed-over plan, or undefined for an empty one. */
export function proposedPlanText(plan: string): string | undefined {
  const trimmed = plan.trim();
  return trimmed.length === 0 ? undefined : `${PROPOSED_PLAN_HEADING}\n\n${trimmed}\n`;
}
