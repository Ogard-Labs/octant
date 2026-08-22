import type { CanvasThreadReferenceCard } from "@octant/contracts/canvas-cards";
import type { ShipPlan, ShipTarget, ThreadPlan } from "@octant/contracts";
import type { RightUtilityDockSurfaceId } from "./rightUtilityDockModel";

/**
 * Whether the dock may offer Plan: a current artifact, not a withdrawn or
 * empty proposal form.
 */
export function isCurrentPlanArtifact(plan: ThreadPlan | null | undefined): boolean {
  return plan != null && plan.status !== "withdrawn";
}

/**
 * Whether Delivery may appear: an enabled target, or a plan the host already
 * asked the reader to approve.
 */
export function hasActionableDelivery(input: {
  readonly targets: ReadonlyArray<Pick<ShipTarget, "enabled">>;
  readonly plan?: ShipPlan;
}): boolean {
  return input.plan !== undefined || input.targets.some((target) => target.enabled);
}

/**
 * A Canvas the dock can open in place. Unauthorized or failed cards are not
 * documents this thread can address.
 */
export function isAuthorizedCanvasDocument(
  card: Pick<CanvasThreadReferenceCard, "status">,
): boolean {
  return card.status !== "unauthorized" && card.status !== "invalid" && card.status !== "failed";
}

export interface DockToolCapabilities {
  readonly hasPlanArtifact: boolean | "unknown";
  readonly hasDelivery: boolean | "unknown";
  readonly hasCanvasDocument: boolean | "unknown";
  readonly hasAppleSimulator: boolean;
}

/**
 * Capability-gated tools stay off the launcher until the host says they exist.
 * Unknown keeps an already-open tool mounted so a loading read cannot close it.
 */
export function isDockToolLaunchable(
  surface: RightUtilityDockSurfaceId,
  capabilities: DockToolCapabilities,
): boolean {
  if (surface === "plan") return capabilities.hasPlanArtifact === true;
  if (surface === "delivery") return capabilities.hasDelivery === true;
  if (surface === "canvas") return capabilities.hasCanvasDocument === true;
  if (surface === "ios-simulator") return capabilities.hasAppleSimulator;
  return true;
}

export function isDockToolStillOpenable(
  surface: RightUtilityDockSurfaceId,
  capabilities: DockToolCapabilities,
): boolean {
  if (surface === "plan") return capabilities.hasPlanArtifact !== false;
  if (surface === "delivery") return capabilities.hasDelivery !== false;
  if (surface === "canvas") return capabilities.hasCanvasDocument !== false;
  if (surface === "ios-simulator") return capabilities.hasAppleSimulator;
  return true;
}
